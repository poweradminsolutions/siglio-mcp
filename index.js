#!/usr/bin/env node
// Siglio MCP server.
//
// Lets an AI assistant send a document for signature, check on it, fetch the
// signed file and any files the signer uploaded, and cancel one. It runs on the
// user's own machine, so their API key never leaves it.
//
// Two deliberate safety positions, because these tools send legally binding
// documents to real people:
//
//   1. LIVE KEYS ARE REFUSED unless SIGLIO_ALLOW_LIVE=true is set explicitly.
//      The default blast radius of a confused model is a sandbox envelope.
//   2. Sending is IDEMPOTENT BY CONTENT. If no key is supplied we derive one
//      from the document, the signers and every option sent, so an assistant
//      that retries the same call does not put a second copy of a contract in
//      someone's inbox. Models retry. This makes that harmless.
//
// Voiding additionally requires confirm:true, so it cannot happen as a casual
// side effect of a vague instruction.
//
// Answers collected from signers are personal data. This server prints them
// for the user who owns the key and never writes them anywhere else. Social
// Security numbers are always masked to the last four digits.
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

const VERSION = '1.1.0';
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
  const headers = { Authorization: 'Bearer ' + KEY, 'User-Agent': 'siglio-mcp/' + VERSION };
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

const KEEP_A_COPY = 'Signed PDFs, uploaded files and answers are deleted 30 days after the envelope ' +
  'closes, so the sender should keep their own copy.';

// Turn an API error into something an assistant can act on rather than repeat.
// The specific reason is in error.code; error.type is the broad category
// (feature_not_enabled, for example, arrives as type authorization_error).
function explain(status, parsed, retryAfter) {
  const e = (parsed && parsed.error) || {};
  const rid = e.request_id ? ' (request_id ' + e.request_id + ')' : '';
  const msg = e.message ? ' ' + e.message : '';
  switch (e.code || e.type) {
    case 'missing_required_tag':
    case 'missing_required_signature_tag':
    case 'unsupported_signer_tag':
      return 'The PDF does not carry the signature tags the request needs' + rid + '. ' +
        'Placement comes from literal text inside the document: put ^S1 where signer one signs, ' +
        '^I1 for initials, ^D1 for a self-filling date, and ^S2 / ^I2 / ^D2 for a second signer. ' +
        'A document tagged for two signers must be sent with two, and one tagged for one with one. ' +
        'Set that tag text to WHITE so it does not print on the finished document. ' +
        'Siglio message:' + msg;
    case 'invalid_document':
    case 'unreadable_pdf':
      return 'Siglio could not use that PDF' + rid + ':' + msg +
        ' Check it opens normally and is a real PDF rather than a renamed file.';
    case 'file_too_large':
      return 'That PDF is too large for this server' + rid + '.' + msg +
        ' Compress it, or use the upload endpoint directly (see https://esigndev.com/llms-full.txt).';
    case 'feature_not_enabled':
      return 'Collecting answers from the signer (^M, ^T, ^C or ^R tags, form_fields or constraints) is an ' +
        'Enterprise feature that is not turned on for this account' + rid + '. Nothing was sent and nothing ' +
        'was billed. Tell the user to contact Siglio at https://esigndev.com/contact?topic=enterprise, or ' +
        'remove those tags and fields and send again. Do not retry as is.';
    case 'invalid_form_fields':
      return 'The form_fields do not fit the document' + rid + '.' + msg +
        ' Fix the entry the message names and send again.';
    case 'invalid_constraints':
      return 'The constraints do not fit the document' + rid + '.' + msg +
        ' Fix the entry the message names and send again.';
    case 'payment_not_configured':
      return 'This account cannot take payments yet' + rid + '. Connect a Stripe account in the Siglio ' +
        'document studio first (choose Connect Stripe), then send again. Nothing was sent.';
    case 'invalid_signer':
      return 'Siglio rejected a signer' + rid + ':' + msg + ' Check the name, email and phone.';
    case 'document_deleted':
      return 'That file was deleted after 30 days, the sender should keep their own copy' + rid + '. Siglio ' +
        'deletes signed PDFs, uploaded files and answers 30 days after the envelope closes. It cannot be recovered.';
    case 'not_found':
      return 'Siglio has no envelope or file with that id for this key' + rid + '. Envelope ids come from the ' +
        'response to send_for_signature and look like env_7mmyc.... Check the id for a typo; retrying the ' +
        'same id will not help. A sandbox key cannot see live envelopes, and the reverse.';
    case 'authentication_error':
      return 'The API key was rejected' + rid + '. Get a current key from https://esigndev.com/app.';
    case 'authorization_error':
      return 'This key is not allowed to do that' + rid + '.' + msg;
    case 'payment_required':
      return 'This account needs a card on file before it can send' + rid +
        '. Add one at https://esigndev.com/app, or use a sandbox key, which is free.';
    case 'usage_limit_reached':
      return 'This account is out of its free allowance' + rid +
        '. Add a card at https://esigndev.com/app to keep sending.';
    case 'self_imposed_cap_reached':
      return 'This account has hit the spending cap its owner set' + rid +
        '. Raise or remove it at https://esigndev.com/app.';
    case 'new_envelopes_paused':
    case 'account_paused':
      return 'Sending is paused on this account' + rid + '.' + msg;
    case 'rate_limited':
      return 'Rate limited' + rid + '. Wait ' + (retryAfter || 'a few') + ' seconds and retry with the same idempotency key.';
    case 'service_unavailable':
      return 'Siglio is temporarily unavailable' + rid + '.' + msg + ' Retrying with the same idempotency key is safe.';
    case 'invalid_request':
      return 'Siglio rejected the request' + rid + ':' + msg;
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

const dollars = (cents) => '$' + (cents / 100).toFixed(2);
const size = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

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
  const partial = env.state === 'partially_signed';
  people.forEach((s, i) => {
    // signed_at null means "no recorded time", never "unsigned" on a completed
    // envelope. On partially_signed, signer one has signed and signer two has
    // not, whatever the timestamps say.
    const signed = !!s.signed_at || done || (partial && i === 0);
    const status = s.signed_at ? 'signed ' + s.signed_at
      : signed ? (done ? 'signed, time not recorded' : 'signed, time not yet recorded')
      : 'not yet signed';
    lines.push('Signer ' + (i + 1) + ': ' + s.name +
      [s.email, s.phone].filter(Boolean).map((x) => ' <' + x + '>').join('') +
      (s.delivery ? ' via ' + s.delivery : '') + ', ' + status);
    if (s.signing_url) lines.push('  link: ' + s.signing_url);
  });
  if (!people.length && env.signing_url) lines.push('Signing link: ' + env.signing_url);

  const p = env.payment;
  if (p) {
    lines.push('Payment: ' + dollars(p.amount) + (p.description ? ' for ' + p.description : '') +
      ', ' + (p.when === 'before' ? 'before signing' : 'after signing') + ', ' + p.status +
      (p.paid_at ? ' on ' + p.paid_at : ''));
    if (p.pay_url) lines.push('  pay link: ' + p.pay_url);
    if (p.when === 'before' && p.status === 'pending')
      lines.push('  The document is held until this is paid; the signing link is the payment page for now.');
  }

  const a = env.attachments;
  if (a) {
    lines.push('Files from the signer (' + (a.when === 'before' ? 'before signing' : 'after signing') + '): ' +
      a.status + (a.received_at ? ' on ' + a.received_at : ''));
    for (const it of a.items || []) {
      const files = it.files || [];
      lines.push('  ' + it.label + (it.required === false ? ' (optional)' : '') + ': ' +
        (files.length ? files.map((f) => f.name + ' (' + size(f.size) + ', id ' + f.id + ')').join('; ') : 'nothing yet'));
    }
    if (a.upload_url) lines.push('  upload link: ' + a.upload_url);
    if (a.when === 'before' && a.status === 'pending')
      lines.push('  The document is held until the required files are in.');
    if ((a.items || []).some((it) => (it.files || []).length))
      lines.push('  Save one with download_attachment and its id.');
  }

  const answers = describeAnswers(env);
  if (answers.length) lines.push(...answers);

  if (env.completed_at) lines.push('Completed: ' + env.completed_at);
  return lines.join('\n');
}

// One line per signer: "Answers (signer 1): Policy number: A-1234; I agree: yes".
// A choice shows its option label, not the stored value.
function describeAnswers(env) {
  const values = env.field_values;
  if (!Array.isArray(values) || !values.length) return [];
  const defs = new Map(((env.form && env.form.fields) || []).map((f) => [f.name, f]));
  const optionLabel = (name, v) => {
    const o = ((defs.get(name) || {}).options || []).find((x) => x.value === v);
    return o && o.label ? o.label : v;
  };
  const render = (fv) => {
    if (fv.deleted) return 'deleted after 30 days';
    if (fv.value === null || fv.value === undefined) return fv.submitted_at ? 'left blank' : 'not signed yet';
    if (fv.type === 'checkbox') return fv.value === true ? 'yes' : 'no';
    if (fv.type === 'checkbox_group')
      return Array.isArray(fv.value) && fv.value.length ? fv.value.map((v) => optionLabel(fv.name, v)).join(', ') : 'none';
    if (fv.type === 'select' || fv.type === 'radio') return optionLabel(fv.name, fv.value);
    // Social Security numbers never appear in full: chat transcripts are kept.
    const fmt = fv.format || (defs.get(fv.name) || {}).format;
    if (fmt === 'ssn') { const d = String(fv.value).replace(/\D/g, ''); return '***-**-' + (d.slice(-4) || '****'); }
    return String(fv.value);
  };
  const out = [];
  for (const n of [1, 2]) {
    const mine = values.filter((fv) => (fv.signer || 1) === n);
    if (mine.length)
      out.push('Answers (signer ' + n + '): ' + mine.map((fv) => (fv.label || fv.name) + ': ' + render(fv)).join('; '));
  }
  return out;
}

function stateNote(s) {
  if (s === 'created') return '  <- held: waiting for a payment or files before the document goes out.';
  if (s === 'partially_signed') return '  <- one of two signers is done. NOT finished.';
  if (s === 'completed') return '  <- every signature is in.';
  if (s === 'delivered') return '  <- sent, not opened yet.';
  if (s === 'viewed') return '  <- opened, not signed yet.';
  if (s === 'voided') return '  <- cancelled, the link no longer works.';
  if (s === 'failed') return '  <- could not be delivered.';
  return '';
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (e) => ({ content: [{ type: 'text', text: 'Failed: ' + (e && e.message ? e.message : String(e)) }], isError: true });

// --- the server ----------------------------------------------------------

const server = new McpServer({ name: 'siglio', version: VERSION });

const deliveryEnum = z.enum(['auto', 'email', 'sms', 'both']);

const signerShape = z.object({
  name: z.string().describe("The signer's full name."),
  email: z.string().optional().describe('Their email address. Give both email and phone when you have them.'),
  phone: z.string().optional().describe('Their mobile number, E.164 preferred, e.g. +18135550142.'),
  delivery: deliveryEnum.optional().describe("Overrides the envelope's delivery for this signer."),
});

const paymentShape = z.object({
  amount: z.number().int().min(50).max(99999900).describe('Whole cents. 15000 is $150.00.'),
  currency: z.enum(['usd']).optional().describe('usd only.'),
  description: z.string().max(120).optional().describe('What the payment is for, as the signer will read it.'),
  when: z.enum(['before', 'after']).optional().describe(
    'after (the default): the payment link goes out when the document is signed. before: the document is held ' +
    'and the signing link goes out once the payment lands.'),
});

const attachmentsShape = z.object({
  when: z.enum(['before', 'after']).describe(
    'No default, ask the user. before: the document is held until the files are in. after: the upload link ' +
    'goes out once it is signed.'),
  items: z.array(z.object({
    label: z.string().max(60).describe('What to upload, as the signer reads it: "Photo ID", "Proof of insurance".'),
    required: z.boolean().optional().describe('Defaults to true.'),
  })).min(1).max(5),
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
    'On Enterprise accounts the PDF can also ask the signer questions before they sign: ^M1 (required text), ' +
    '^T1 (optional text), ^C1 (a checkbox), ^R1_G1 (one option of pick-one group 1). Each may carry a name, ' +
    'and boxes a value: ^M1:policy_number, ^C1:coverage=liability, ^R1_G1:plan=monthly. form_fields sets ' +
    'labels, types, options, formats and show/require rules; constraints sets rules across fields. Accounts ' +
    'without the feature are refused with feature_not_enabled and nothing is sent.\n\n' +
    'Optional extras: payment asks the signer to pay (a deposit, an invoice) through the sender\'s connected ' +
    'Stripe account; attachments asks the signer to upload files (a photo ID, a W-9).\n\n' +
    'When the last signer signs, every signer is sent the signed PDF automatically. ' + KEEP_A_COPY + '\n\n' +
    'Calling twice with the same document, signers and options returns the first envelope rather than sending ' +
    'a second copy, so a retry is safe.',
  inputSchema: {
    document_path: z.string().describe('Full path to the tagged PDF on this machine.'),
    signers: z.array(signerShape).min(1).max(2)
      .describe('One or two signers. With two, signing is sequential: the second is not notified until the first finishes.'),
    delivery: deliveryEnum.default('auto')
      .describe('auto (the default) sends by email and text together when both are known, which is what Siglio ' +
        'is for, and otherwise by whichever one the signer has. email, sms and both are strict.'),
    document_name: z.string().optional().describe('What the signer sees it called. Defaults to the filename.'),
    payment: paymentShape.optional().describe('Ask the signer for a payment. Needs Stripe connected in the document studio.'),
    attachments: attachmentsShape.optional().describe('Ask the signer to upload 1 to 5 files.'),
    form_fields: z.array(z.object({ name: z.string() }).passthrough()).max(100).optional()
      .describe('Enterprise. One entry per ^M / ^T / ^C / ^R field to label or configure: { name, signer?, type?, ' +
        'label?, required?, format?, max_length?, width?, options?, show_if?, required_if? }. Passed to Siglio as is.'),
    constraints: z.array(z.object({ type: z.string() }).passthrough()).max(50).optional()
      .describe('Enterprise. Rules across fields: { type: exactly_one | at_least | at_most | one_of, fields, n? } ' +
        'or { type: requires, field, when }. Passed to Siglio as is.'),
    idempotency_key: z.string().optional().describe('Rarely needed. One is derived from the document, signers and options if omitted.'),
  },
}, async ({ document_path, signers, delivery, document_name, payment, attachments, form_fields, constraints, idempotency_key }) => {
  try {
    const pdf = loadPdf(document_path);
    const name = document_name || pdf.name;
    // email, sms and both are strict, so catch a missing address before spending a call.
    // auto is resolved by Siglio, which answers 400 when a signer has neither.
    for (const s of signers) {
      const d = s.delivery || delivery;
      if ((d === 'sms' || d === 'both') && !s.phone) throw new Error(s.name + ' is set to receive a text but has no phone number.');
      if ((d === 'email' || d === 'both') && !s.email) throw new Error(s.name + ' is set to receive an email but has no address.');
    }
    const extras = {};
    if (payment) extras.payment = payment;
    if (attachments) extras.attachments = attachments;
    if (form_fields) extras.form_fields = form_fields;
    if (constraints) extras.constraints = constraints;

    const key = idempotency_key || 'mcp-' + createHash('sha256')
      .update(pdf.base64 + '|' + name + '|' + delivery + '|' + JSON.stringify(signers) + '|' + JSON.stringify(extras))
      .digest('hex').slice(0, 32);

    const body = { document_name: name, document_base64: pdf.base64, delivery, ...extras };
    if (signers.length === 1) body.signer = signers[0]; else body.signers = signers;

    const env = await api('POST', '/v1/envelopes', { body, idempotencyKey: key });
    return text('Sent.\n\n' + describe(env) +
      '\n\nCheck on it later with check_envelope and this id: ' + env.id +
      '\nWhen the last signer signs, every signer is sent the signed PDF automatically.' +
      (IS_LIVE ? '\n\nThis was a LIVE envelope and will be billed.' : ''));
  } catch (e) { return fail(e); }
});

server.registerTool('check_envelope', {
  title: 'Check an envelope',
  description:
    'Returns the current state of an envelope: whether it was delivered, opened, signed, or cancelled, ' +
    'when each signer signed, and any payment, uploaded files and answers. Use this to answer ' +
    '"has it been signed yet?".\n\n' +
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
    'that is still out, or only partially signed, has no signed document yet. ' + KEEP_A_COPY,
  inputSchema: {
    envelope_id: z.string().describe('The envelope id.'),
    save_path: z.string().describe('Full path to write the PDF to, e.g. C:\\Users\\me\\Documents\\signed.pdf'),
  },
}, async ({ envelope_id, save_path }) => {
  try {
    const buf = await api('GET', '/v1/envelopes/' + encodeURIComponent(envelope_id) + '/document', { raw: true });
    const out = resolve(save_path);
    writeFileSync(out, buf);
    return text('Saved the signed document to ' + out + ' (' + size(buf.length) + ').');
  } catch (e) { return fail(e); }
});

server.registerTool('download_attachment', {
  title: 'Download a file the signer uploaded',
  description:
    'Saves one file the signer uploaded (a photo ID, a W-9) to this machine. Get the file id from ' +
    'check_envelope, where each uploaded file is listed with its id (att_...). ' + KEEP_A_COPY,
  inputSchema: {
    envelope_id: z.string().describe('The envelope id.'),
    file_id: z.string().describe('The file id from check_envelope, e.g. att_0123456789abcdef.'),
    save_path: z.string().describe('Full path to write the file to, keeping its extension, e.g. C:\\Users\\me\\Documents\\id.jpg'),
  },
}, async ({ envelope_id, file_id, save_path }) => {
  try {
    const buf = await api('GET', '/v1/envelopes/' + encodeURIComponent(envelope_id) + '/attachments/' +
      encodeURIComponent(file_id), { raw: true });
    const out = resolve(save_path);
    writeFileSync(out, buf);
    return text('Saved the file to ' + out + ' (' + size(buf.length) + ').');
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
process.stderr.write('siglio-mcp ' + VERSION + ' ready (' + (IS_LIVE ? 'LIVE' : 'sandbox') + ' key, ' + API_BASE + ')\n');
