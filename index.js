#!/usr/bin/env node
// Siglio MCP server.
//
// Lets an AI assistant send a document for signature, check on it, fetch the
// signed file, and cancel one. It runs on the user's own machine, so their API
// key never leaves it.
//
// Two deliberate safety positions, because these tools send legally binding
// documents to real people:
//
//   1. LIVE KEYS ARE REFUSED unless SIGLIO_ALLOW_LIVE=true is set explicitly.
//      The default blast radius of a confused model is a sandbox envelope.
//   2. Sending is IDEMPOTENT BY CONTENT. If no key is supplied we derive one
//      from the document and the signers, so an assistant that retries the
//      same call does not put a second copy of a contract in someone's inbox.
//      Models retry. This makes that harmless instead of embarrassing.
//
// Voiding additionally requires confirm:true, so it cannot happen as a casual
// side effect of a vague instruction.
//
// Environment:
//   SIGLIO_API_KEY     required. sig_sandbox_... or sig_live_...
//   SIGLIO_ALLOW_LIVE  set to "true" to permit a live key
//   SIGLIO_API_BASE    optional, defaults to https://api.esigndev.com

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const API_BASE = process.env.SIGLIO_API_BASE || 'https://api.esigndev.com';
const KEY = (process.env.SIGLIO_API_KEY || '').trim();
const INLINE_LIMIT = 3 * 1024 * 1024;   // the API's inline document ceiling

function die(message) {
  process.stderr.write('siglio-mcp: ' + message + '\n');
  process.exit(1);
}

if (!KEY) {
  die('SIGLIO_API_KEY is not set. Get a key from https://esigndev.com/app and put it in\n' +
      'this server\'s env block. Sandbox keys start with sig_sandbox_ and are free.');
}
if (/^sig_live_/.test(KEY) && process.env.SIGLIO_ALLOW_LIVE !== 'true') {
  die('That is a LIVE key, which sends billable documents to real signers.\n' +
      'This server refuses live keys unless you also set SIGLIO_ALLOW_LIVE=true.\n' +
      'Use a sandbox key while you are building. Sandbox envelopes deliver for real\n' +
      'and cost nothing.');
}
const IS_LIVE = /^sig_live_/.test(KEY);

// --- talking to the API --------------------------------------------------

async function api(method, path, { body, idempotencyKey, raw } = {}) {
  const headers = { Authorization: 'Bearer ' + KEY, 'User-Agent': 'siglio-mcp/1.0' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error('Could not reach the Siglio API (' + (e && e.message) + '). Check the network and try again.');
  }
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (res.ok) return parsed;

  throw new Error(explain(res.status, parsed, res.headers.get('retry-after')));
}

// Turn an API error into something an assistant can act on rather than repeat.
function explain(status, parsed, retryAfter) {
  const e = (parsed && parsed.error) || {};
  const rid = e.request_id ? ' (request_id ' + e.request_id + ')' : '';
  switch (e.type) {
    case 'missing_required_tag':
      return 'The PDF does not carry the signature tags the request needs' + rid + '. ' +
        'Placement comes from literal text inside the document: put ^S1 where signer one signs, ' +
        '^I1 for initials, ^D1 for a self-filling date, and ^S2 / ^I2 / ^D2 for a second signer. ' +
        'A document tagged for two signers must be sent with two, and one tagged for one with one. ' +
        'Set that tag text to WHITE so it does not print on the finished document. ' +
        'Siglio message: ' + (e.message || '');
    case 'invalid_document':
      return 'Siglio could not use that PDF' + rid + ': ' + (e.message || '') +
        ' Check it opens normally and is a real PDF rather than a renamed file.';
    case 'authentication_error':
      return 'The API key was rejected' + rid + '. Get a current key from https://esigndev.com/app.';
    case 'payment_required':
      return 'This account needs a card on file before it can send' + rid +
        '. Add one at https://esigndev.com/app, or use a sandbox key, which is free.';
    case 'usage_limit_reached':
      return 'This account is out of its free allowance' + rid +
        '. Add a card at https://esigndev.com/app to keep sending.';
    case 'rate_limited':
      return 'Rate limited' + rid + '. Wait ' + (retryAfter || 'a few') + ' seconds and retry with the same idempotency key.';
    case 'service_unavailable':
      return 'Siglio is temporarily unavailable' + rid + '. Retrying with the same idempotency key is safe.';
    default:
      return 'Siglio returned ' + status + rid + ': ' + (e.message || JSON.stringify(parsed) || 'no detail');
  }
}

// --- helpers -------------------------------------------------------------

function loadPdf(p) {
  const full = resolve(p);
  if (!existsSync(full)) throw new Error('No file at ' + full + '. Give the full path to the PDF.');
  const st = statSync(full);
  if (!st.isFile()) throw new Error(full + ' is not a file.');
  const buf = readFileSync(full);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-')
    throw new Error(full + ' is not a PDF. Siglio signs PDFs only; convert it first.');
  if (buf.length > INLINE_LIMIT)
    throw new Error('That PDF is ' + (buf.length / 1048576).toFixed(1) + ' MB. This server sends documents ' +
      'inline, which tops out around 3 MB. Compress it, or use the upload endpoint directly ' +
      '(see https://esigndev.com/llms-full.txt).');
  return { base64: buf.toString('base64'), bytes: buf.length, name: basename(full) };
}

function describe(env) {
  const lines = [
    'Envelope ' + env.id,
    'State: ' + env.state + stateNote(env.state),
    'Document: ' + env.document_name,
    'Delivery: ' + env.delivery,
    'Environment: ' + env.environment + (env.environment === 'sandbox' ? ' (free, delivers for real)' : ' (billable)'),
  ];
  const people = env.signers || (env.signer ? [env.signer] : []);
  const done = env.state === 'completed';
  people.forEach((s, i) => {
    // On a completed envelope every signer has signed, whether or not the time
    // was recorded. signed_at null means "no recorded time", never "unsigned",
    // so never say "not yet signed" about a finished document.
    const partial = env.state === 'partially_signed';
    const status = s.signed_at ? ' — signed ' + s.signed_at
      : done ? ' — signed, time not recorded'
      : partial ? ' — signed, time not yet recorded'
      : ' — not yet signed';
    lines.push('Signer ' + (i + 1) + ': ' + s.name +
      [s.email, s.phone].filter(Boolean).map((x) => ' <' + x + '>').join('') + status);
    if (s.signing_url) lines.push('  link: ' + s.signing_url);
  });
  if (!people.length && env.signing_url) lines.push('Signing link: ' + env.signing_url);
  if (env.completed_at) lines.push('Completed: ' + env.completed_at);
  return lines.join('\n');
}

function stateNote(s) {
  if (s === 'partially_signed') return '  <- one of two signers is done. NOT finished.';
  if (s === 'completed') return '  <- every signature is in.';
  if (s === 'delivered') return '  <- sent, not opened yet.';
  if (s === 'voided') return '  <- cancelled, the link no longer works.';
  return '';
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (e) => ({ content: [{ type: 'text', text: 'Failed: ' + (e && e.message ? e.message : String(e)) }], isError: true });

// --- the server ----------------------------------------------------------

const server = new McpServer({ name: 'siglio', version: '1.0.5' });

const signerShape = z.object({
  name: z.string().describe("The signer's full name."),
  email: z.string().optional().describe('Required if this signer is reached by email.'),
  phone: z.string().optional().describe('E.164 preferred, e.g. +18135550142. Required if reached by text.'),
  delivery: z.enum(['email', 'sms', 'both']).optional().describe("Overrides the envelope's delivery for this signer."),
});

server.registerTool('send_for_signature', {
  title: 'Send a document for signature',
  description:
    'Sends a PDF to one or two people for electronic signature, by email, text message, or both at once. ' +
    'Delivery happens IMMEDIATELY and the result is a legally binding signature, so confirm the recipient and ' +
    'the document with the user before calling this.\n\n' +
    'The PDF must already contain signature tags: ^S1 where signer one signs, ^I1 for initials, ^D1 for a ' +
    'date that fills itself, and ^S2 / ^I2 / ^D2 for a second signer. Those tags must be WHITE font or they ' +
    'print on the finished document. If the document has no tags this call is rejected and nothing is sent.\n\n' +
    'Calling twice with the same document and signers returns the first envelope rather than sending a second ' +
    'copy, so a retry is safe.',
  inputSchema: {
    document_path: z.string().describe('Full path to the tagged PDF on this machine.'),
    signers: z.array(signerShape).min(1).max(2)
      .describe('One or two signers. With two, signing is sequential: the second is not notified until the first finishes.'),
    delivery: z.enum(['email', 'sms', 'both']).default('email')
      .describe('How to notify the signer. Texting is what Siglio is for and costs the same; ask the user if a text would be better.'),
    document_name: z.string().optional().describe('What the signer sees it called. Defaults to the filename.'),
    idempotency_key: z.string().optional().describe('Rarely needed. One is derived from the document and signers if omitted.'),
  },
}, async ({ document_path, signers, delivery, document_name, idempotency_key }) => {
  try {
    const pdf = loadPdf(document_path);
    const name = document_name || pdf.name;
    const needsPhone = (d) => d === 'sms' || d === 'both';
    for (const s of signers) {
      const d = s.delivery || delivery;
      if (needsPhone(d) && !s.phone) throw new Error(s.name + ' is set to receive a text but has no phone number.');
      if ((d === 'email' || d === 'both') && !s.email) throw new Error(s.name + ' is set to receive an email but has no address.');
    }
    const key = idempotency_key ||
      'mcp-' + createHash('sha256').update(pdf.base64 + '|' + name + '|' + delivery + '|' + JSON.stringify(signers)).digest('hex').slice(0, 32);

    const body = { document_name: name, document_base64: pdf.base64, delivery };
    if (signers.length === 1) body.signer = signers[0]; else body.signers = signers;

    const env = await api('POST', '/v1/envelopes', { body, idempotencyKey: key });
    return text('Sent.\n\n' + describe(env) +
      '\n\nCheck on it later with check_envelope and this id: ' + env.id +
      (IS_LIVE ? '\n\nThis was a LIVE envelope and will be billed.' : ''));
  } catch (e) { return fail(e); }
});

server.registerTool('check_envelope', {
  title: 'Check an envelope',
  description:
    'Returns the current state of an envelope: whether it was delivered, opened, signed, or cancelled, ' +
    'and when each signer signed. Use this to answer "has it been signed yet?".\n\n' +
    'Read the STATE for whether it is signed, not the signer timestamp. On a completed envelope every ' +
    'signer has signed; a missing signature time only means the time was not recorded.',
  inputSchema: { envelope_id: z.string().describe('The id returned when it was sent, e.g. env_7mmyc...') },
}, async ({ envelope_id }) => {
  try { return text(describe(await api('GET', '/v1/envelopes/' + encodeURIComponent(envelope_id)))); }
  catch (e) { return fail(e); }
});

server.registerTool('download_signed_document', {
  title: 'Download the signed PDF',
  description:
    'Saves the completed, signed PDF to this machine. Only works once every signature is in; an envelope ' +
    'that is still out, or only partially signed, has no signed document yet.',
  inputSchema: {
    envelope_id: z.string().describe('The envelope id.'),
    save_path: z.string().describe('Full path to write the PDF to, e.g. C:\\Users\\me\\Documents\\signed.pdf'),
  },
}, async ({ envelope_id, save_path }) => {
  try {
    const buf = await api('GET', '/v1/envelopes/' + encodeURIComponent(envelope_id) + '/document', { raw: true });
    const out = resolve(save_path);
    writeFileSync(out, buf);
    return text('Saved the signed document to ' + out + ' (' + (buf.length / 1024).toFixed(0) + ' KB).');
  } catch (e) { return fail(e); }
});

server.registerTool('void_envelope', {
  title: 'Cancel an envelope',
  description:
    'Cancels an envelope that has not been signed yet. The signing link stops working immediately and the ' +
    'signer sees a cancellation page. This cannot be undone, and an already-completed document cannot be ' +
    'voided. Ask the user to confirm in their own words before calling this, then pass confirm:true.',
  inputSchema: {
    envelope_id: z.string().describe('The envelope id to cancel.'),
    confirm: z.boolean().describe('Must be true. Set it only after the user has explicitly agreed to cancel this specific envelope.'),
  },
}, async ({ envelope_id, confirm }) => {
  if (confirm !== true) {
    return text('Not cancelled. void_envelope needs confirm:true, and you should only set that after the ' +
      'user has agreed to cancel this specific envelope. Ask them first.');
  }
  try {
    const env = await api('DELETE', '/v1/envelopes/' + encodeURIComponent(envelope_id));
    return text('Cancelled. The signing link no longer works.\n\n' + describe(env));
  } catch (e) { return fail(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('siglio-mcp ready (' + (IS_LIVE ? 'LIVE' : 'sandbox') + ' key, ' + API_BASE + ')\n');
