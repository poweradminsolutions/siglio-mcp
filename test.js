// End-to-end test: a real MCP client talking to the real server, with a stub
// Siglio API standing in for production so no envelopes are spent.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const T = (n) => join(tmpdir(), n);
const err = (type, code, message) => ({ error: { type, code, message, request_id: 'req_' + code } });

const ENV_BASE = { object: 'envelope', environment: 'sandbox', created_at: '2026-10-01T20:00:00Z' };

const seen = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    let b = null; try { b = JSON.parse(body); } catch {}
    seen.push({ method: req.method, path: u.pathname, idem: req.headers['idempotency-key'], auth: req.headers.authorization, ua: req.headers['user-agent'], body: b });
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const raw = (type, s) => { res.writeHead(200, { 'Content-Type': type }); res.end(Buffer.from(s)); };

    if (req.method === 'POST' && u.pathname === '/v1/envelopes') {
      const n = b.document_name;
      if (n === 'untagged.pdf') return json(422, err('missing_required_tag', 'missing_required_tag', 'No ^S1 found.'));
      if (n === 'enterprise.pdf') return json(403, err('authorization_error', 'feature_not_enabled', 'Collecting answers before signing is an Enterprise feature.'));
      if (n === 'nostripe.pdf') return json(422, err('invalid_request', 'payment_not_configured', 'Connect Stripe first.'));
      if (n === 'badfields.pdf') return json(422, err('invalid_request', 'invalid_form_fields', 'form_fields[0] "plan" has no ^R1_G1 tag in the document.'));
      if (n === 'badrules.pdf') return json(422, err('invalid_request', 'invalid_constraints', 'constraints[1] names "x", which is not a field.'));
      if (n === 'nocontact.pdf') return json(400, err('invalid_request', 'invalid_request', 'email or phone is required.'));
      const s = b.signer || b.signers[0];
      const resolved = b.delivery === 'auto' ? (s.email && s.phone ? 'both' : s.phone ? 'sms' : 'email') : b.delivery;
      return json(201, { ...ENV_BASE, id: 'env_test1', state: b.payment?.when === 'before' ? 'created' : 'delivered',
        document_name: n, delivery: resolved,
        signer: { name: s.name, email: s.email || null, phone: s.phone || null, signed_at: null },
        signing_url: 'https://esigndev.com/s/abc', completed_at: null,
        ...(b.payment ? { payment: { amount: b.payment.amount, currency: 'usd', description: b.payment.description || null,
          when: b.payment.when || 'after', status: 'pending', paid_at: null, pay_url: 'https://esigndev.com/pay/abc' } } : {}) });
    }
    if (req.method === 'GET' && u.pathname === '/v1/envelopes/env_test1')
      return json(200, { ...ENV_BASE, id: 'env_test1', state: 'partially_signed', document_name: 'nda.pdf', delivery: 'both',
        signers: [{ name: 'Dana', email: 'd@x.com', phone: null, signed_at: null, delivery: 'email', signing_url: 'https://esigndev.com/s/a' },
                  { name: 'Sam', email: null, phone: '+18135550188', signed_at: null, delivery: 'sms', signing_url: 'https://esigndev.com/s/b' }],
        completed_at: null });
    if (req.method === 'GET' && u.pathname === '/v1/envelopes/env_full')
      return json(200, { ...ENV_BASE, id: 'env_full', state: 'completed', document_name: 'lease.pdf', delivery: 'both',
        signer: { name: 'Dana', email: 'd@x.com', phone: '+18135550142', signed_at: '2026-10-01T20:05:00Z' },
        signing_url: 'https://esigndev.com/s/a', completed_at: '2026-10-01T20:05:03Z',
        payment: { amount: 15000, currency: 'usd', description: 'Deposit', when: 'after', status: 'paid', paid_at: '2026-10-01T20:09:00Z', pay_url: 'https://esigndev.com/pay/a' },
        attachments: { when: 'before', status: 'received', received_at: '2026-10-01T20:03:00Z', upload_url: 'https://esigndev.com/up/a',
          items: [{ key: 'a', label: 'Photo ID', required: true, files: [{ id: 'att_0123456789abcdef', name: 'id.jpg', type: 'image/jpeg', size: 1258291, uploaded_at: '2026-10-01T20:02:00Z' }] },
                  { key: 'b', label: 'Proof of insurance', required: false, files: [] }] },
        form: { fields: [{ name: 'plan', signer: 1, type: 'radio', options: [{ value: 'monthly', label: 'Monthly plan' }, { value: 'annual', label: 'Annual plan' }] },
                         { name: 'ssn2', signer: 1, type: 'text', format: 'ssn' }, { name: 'extras', signer: 1, type: 'checkbox_group', options: [{ value: 'pet', label: 'Pet' }, { value: 'parking', label: 'Parking' }] }], constraints: [] },
        field_values: [
          { name: 'policy', signer: 1, label: 'Policy number', type: 'text', value: 'A-1234', submitted_at: '2026-10-01T20:05:00Z' },
          { name: 'plan', signer: 1, label: 'Plan', type: 'radio', value: 'monthly', submitted_at: '2026-10-01T20:05:00Z' },
          { name: 'agree', signer: 1, label: 'I agree', type: 'checkbox', value: true, submitted_at: '2026-10-01T20:05:00Z' },
          { name: 'extras', signer: 1, label: 'Extras', type: 'checkbox_group', value: ['pet', 'parking'], submitted_at: '2026-10-01T20:05:00Z' },
          { name: 'notes', signer: 1, label: 'Notes', type: 'text', value: null, submitted_at: '2026-10-01T20:05:00Z' },
          { name: 'old', signer: 1, label: 'Old answer', type: 'text', value: null, submitted_at: '2026-09-01T20:05:00Z', deleted: true },
          { name: 'ssn', signer: 1, label: 'SSN', type: 'text', format: 'ssn', value: '123-45-6789', submitted_at: '2026-10-01T20:05:00Z' },
          { name: 'ssn2', signer: 1, label: 'Spouse SSN', type: 'text', value: '987654321', submitted_at: '2026-10-01T20:05:00Z' },
          { name: 'co', signer: 2, label: 'Co-signer phone', type: 'text', value: null, submitted_at: null }] });
    if (req.method === 'GET' && u.pathname === '/v1/envelopes/env_test1/document') return raw('application/pdf', '%PDF-1.7\nsigned\n');
    if (req.method === 'GET' && u.pathname === '/v1/envelopes/env_old/document') return json(410, err('invalid_request', 'document_deleted', 'Deleted.'));
    if (req.method === 'GET' && u.pathname === '/v1/envelopes/env_full/attachments/att_0123456789abcdef') return raw('image/jpeg', 'JPEGBYTES');
    if (req.method === 'GET' && u.pathname === '/v1/envelopes/env_old/attachments/att_0123456789abcdef') return json(410, err('invalid_request', 'document_deleted', 'Deleted.'));
    if (req.method === 'DELETE' && u.pathname === '/v1/envelopes/env_test1')
      return json(200, { ...ENV_BASE, id: 'env_test1', state: 'voided', document_name: 'nda.pdf', delivery: 'email',
        signer: { name: 'Dana', email: 'd@x.com', phone: null, signed_at: null }, completed_at: null });
    json(404, err('invalid_request', 'not_found', 'No such envelope.'));
  });
});

const pass = [], failed = [];
const check = (name, cond, extra) => (cond ? pass : failed).push(name + (cond ? '' : '  <-- ' + (extra || '')));

stub.listen(8920, async () => {
  const doc = await PDFDocument.create(); const page = doc.addPage([612, 792]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('^S1', { x: 72, y: 400, size: 12, font: f, color: rgb(1, 1, 1) });
  const PDF = T('siglio-tagged.pdf'); writeFileSync(PDF, await doc.save());
  const TXT = T('siglio-notapdf.txt'); writeFileSync(TXT, 'hello');

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: 'node', args: ['index.js'],
    env: { ...process.env, SIGLIO_API_KEY: 'sig_sandbox_testkey', SIGLIO_API_BASE: 'http://127.0.0.1:8920' },
  }));

  const tools = (await client.listTools()).tools;
  const tool = (n) => tools.find((t) => t.name === n);
  check('5 tools exposed', tools.length === 5, 'got ' + tools.length);
  check('download_attachment is one of them', !!tool('download_attachment'));
  check('every tool has a description', tools.every((t) => (t.description || '').length > 80));
  check('send tool warns it is immediate and binding', /IMMEDIATELY/.test(tool('send_for_signature').description));
  check('send tool describes the Enterprise tags', /\^M1/.test(tool('send_for_signature').description) && /\^R1_G1/.test(tool('send_for_signature').description) && /Enterprise/.test(tool('send_for_signature').description));
  check('send tool says signers get the signed PDF', /every signer is sent the signed PDF/.test(tool('send_for_signature').description));
  check('send tool keeps sequential signing wording', /signing is sequential/.test(JSON.stringify(tool('send_for_signature').inputSchema)));
  check('void tool demands confirmation', /confirm/i.test(tool('void_envelope').description));
  check('delivery defaults to auto in the schema', tool('send_for_signature').inputSchema.properties.delivery.default === 'auto');
  check('no em dashes in any tool description or schema', !/\u2014/.test(JSON.stringify(tools)));
  check('no vendor names in any tool description or schema', !/useclientconnect|sendItByText|send it by text|SIBT/i.test(JSON.stringify(tools)));

  const call = async (n, a) => (await client.callTool({ name: n, arguments: a }));
  const txt = (r) => r.content[0].text;
  const last = () => seen.at(-1);
  const S = [{ name: 'Dana', email: 'd@x.com', phone: '+18135550142' }];

  // --- send basics ---
  let r = await call('send_for_signature', { document_path: PDF, delivery: 'both', signers: S });
  check('send succeeds', /Sent\./.test(txt(r)), txt(r).slice(0, 120));
  check('send returns the envelope id', /env_test1/.test(txt(r)));
  check('send says signers will get the signed PDF', /every signer is sent the signed PDF/.test(txt(r)));
  const idem1 = last().idem;
  check('idempotency key derived automatically', !!idem1 && idem1.startsWith('mcp-'), idem1);
  check('bearer auth sent', last().auth === 'Bearer sig_sandbox_testkey');
  check('user-agent carries the version', last().ua === 'siglio-mcp/1.1.0', last().ua);

  await call('send_for_signature', { document_path: PDF, delivery: 'both', signers: S });
  check('identical retry reuses the same idempotency key', last().idem === idem1);

  // --- delivery: auto ---
  r = await call('send_for_signature', { document_path: PDF, signers: S });
  check('omitted delivery goes out as auto', last().body.delivery === 'auto', last().body.delivery);
  check('the resolved delivery is printed, never auto', /Delivery: both/.test(txt(r)) && !/Delivery: auto/.test(txt(r)), txt(r));
  check('auto changes the idempotency key versus both', last().idem !== idem1);

  r = await call('send_for_signature', { document_path: PDF, document_name: 'nocontact.pdf', signers: [{ name: 'Dana' }] });
  check('auto with no email or phone is left to the API', last().body.signer.name === 'Dana');
  check('API message for no contact is shown', /email or phone is required/.test(txt(r)), txt(r));

  r = await call('send_for_signature', { document_path: PDF, signers: [{ name: 'Dana', phone: '+18135550142' }] });
  check('auto with phone only is not refused locally', /Sent\./.test(txt(r)), txt(r));

  r = await call('send_for_signature', { document_path: PDF, delivery: 'sms', signers: [{ name: 'Dana', email: 'd@x.com' }] });
  check('strict sms without a phone is refused locally', /no phone number/.test(txt(r)));
  r = await call('send_for_signature', { document_path: PDF, signers: [{ name: 'Dana', email: 'd@x.com', delivery: 'both' }] });
  check('strict per-signer both without a phone is refused locally', /no phone number/.test(txt(r)));

  // --- payment, attachments, form_fields, constraints: pass through and hash ---
  const pay = { amount: 15000, description: 'Deposit', when: 'before' };
  r = await call('send_for_signature', { document_path: PDF, signers: S, payment: pay });
  check('payment passes through unchanged', JSON.stringify(last().body.payment) === JSON.stringify(pay), JSON.stringify(last().body.payment));
  check('send prints the payment', /Payment: \$150\.00 for Deposit, before signing, pending/.test(txt(r)), txt(r));
  check('held envelope explained', /held: waiting for a payment or files/.test(txt(r)) && /signing link is the payment page/.test(txt(r)), txt(r));
  const idemPay = last().idem;
  await call('send_for_signature', { document_path: PDF, signers: S, payment: { ...pay, amount: 20000 } });
  check('a different payment is a different send', last().idem !== idemPay);

  const att = { when: 'before', items: [{ label: 'Photo ID' }, { label: 'W-9', required: false }] };
  await call('send_for_signature', { document_path: PDF, signers: S, attachments: att });
  check('attachments pass through unchanged', JSON.stringify(last().body.attachments) === JSON.stringify(att));
  const idemAtt = last().idem;
  await call('send_for_signature', { document_path: PDF, signers: S, attachments: { ...att, when: 'after' } });
  check('different attachments are a different send', last().idem !== idemAtt);

  const ff = [{ name: 'plan', type: 'radio', label: 'Plan', options: [{ value: 'monthly', label: 'Monthly' }], show_if: { field: 'agree', checked: true } }];
  const cons = [{ type: 'exactly_one', fields: ['a', 'b'] }, { type: 'requires', field: 'x', when: { field: 'y', not_empty: true } }];
  await call('send_for_signature', { document_path: PDF, signers: S, form_fields: ff, constraints: cons });
  check('form_fields pass through unchanged, including unknown keys', JSON.stringify(last().body.form_fields) === JSON.stringify(ff), JSON.stringify(last().body.form_fields));
  check('constraints pass through unchanged', JSON.stringify(last().body.constraints) === JSON.stringify(cons));
  const idemFF = last().idem;
  await call('send_for_signature', { document_path: PDF, signers: S, form_fields: [{ ...ff[0], label: 'Plan type' }], constraints: cons });
  check('different form_fields are a different send', last().idem !== idemFF);
  await call('send_for_signature', { document_path: PDF, signers: S, form_fields: ff, constraints: [cons[0]] });
  check('different constraints are a different send', last().idem !== idemFF);
  await call('send_for_signature', { document_path: PDF, signers: S });
  check('no extras are sent when none were given', !('payment' in last().body) && !('attachments' in last().body) && !('form_fields' in last().body) && !('constraints' in last().body));

  r = await call('send_for_signature', { document_path: PDF, signers: S, payment: { amount: 10 } });
  check('payment below 50 cents refused before sending', r.isError === true || /amount/i.test(txt(r)), txt(r));

  // --- errors ---
  r = await call('send_for_signature', { document_path: TXT, signers: [{ name: 'D', email: 'd@x.com' }] });
  check('non-PDF refused with a clear reason', /not a PDF/.test(txt(r)));
  r = await call('send_for_signature', { document_path: T('siglio-missing.pdf'), signers: [{ name: 'D', email: 'd@x.com' }] });
  check('missing file refused', /No file at/.test(txt(r)));
  r = await call('send_for_signature', { document_path: PDF, document_name: 'untagged.pdf', signers: [{ name: 'D', email: 'd@x.com' }] });
  check('tag error explains the tag system', /\^S1 where signer one signs/.test(txt(r)));
  check('tag error says WHITE', /WHITE/.test(txt(r)));
  r = await call('send_for_signature', { document_path: PDF, document_name: 'enterprise.pdf', signers: S, form_fields: ff });
  check('feature_not_enabled gives the Enterprise message', /Enterprise feature/.test(txt(r)) && /contact Siglio/.test(txt(r)) && /Do not retry/.test(txt(r)), txt(r));
  r = await call('send_for_signature', { document_path: PDF, document_name: 'nostripe.pdf', signers: S, payment: pay });
  check('payment_not_configured says Connect Stripe', /Connect Stripe/.test(txt(r)), txt(r));
  r = await call('send_for_signature', { document_path: PDF, document_name: 'badfields.pdf', signers: S, form_fields: ff });
  check('invalid_form_fields shows the message naming the field', /form_fields\[0\] "plan"/.test(txt(r)), txt(r));
  r = await call('send_for_signature', { document_path: PDF, document_name: 'badrules.pdf', signers: S, constraints: cons });
  check('invalid_constraints shows the message naming the entry', /constraints\[1\]/.test(txt(r)), txt(r));

  // --- check_envelope ---
  r = await call('check_envelope', { envelope_id: 'env_test1' });
  check('check warns partially_signed is not finished', /NOT finished/.test(txt(r)), txt(r));
  check('check lists both signers', /Dana/.test(txt(r)) && /Sam/.test(txt(r)));
  check('signer one on partially_signed is signed even with no time', /Dana <d@x\.com> via email, signed, time not yet recorded/.test(txt(r)), txt(r));
  check('signer two on partially_signed is not yet signed', /Sam <\+18135550188> via sms, not yet signed/.test(txt(r)), txt(r));

  r = await call('check_envelope', { envelope_id: 'env_full' });
  const out = txt(r);
  check('check prints the payment as dollars with status and date', /Payment: \$150\.00 for Deposit, after signing, paid on 2026-10-01T20:09:00Z/.test(out), out);
  check('check prints the pay link', /pay link: https:\/\/esigndev\.com\/pay\/a/.test(out));
  check('check prints the attachments status', /Files from the signer \(before signing\): received/.test(out), out);
  check('check prints each file with name, size and id', /Photo ID: id\.jpg \(1\.2 MB, id att_0123456789abcdef\)/.test(out), out);
  check('check prints an empty optional item', /Proof of insurance \(optional\): nothing yet/.test(out), out);
  check('check prints a text answer by label', /Policy number: A-1234/.test(out), out);
  check('check prints a radio answer by option label', /Plan: Monthly plan/.test(out), out);
  check('check prints a checkbox as yes', /I agree: yes/.test(out), out);
  check('check prints a checkbox group by option labels', /Extras: Pet, Parking/.test(out), out);
  check('blank answer after signing is left blank', /Notes: left blank/.test(out), out);
  check('deleted answer says deleted after 30 days', /Old answer: deleted after 30 days/.test(out), out);
  check('unsigned answer says not signed yet', /Answers \(signer 2\): Co-signer phone: not signed yet/.test(out), out);
  check('SSN masked to last four', /SSN: \*\*\*-\*\*-6789/.test(out), out);
  check('SSN masked when the format is only on the field definition', /Spouse SSN: \*\*\*-\*\*-4321/.test(out), out);
  const answerLines = out.split('\n').filter((l) => l.startsWith('Answers')).join('\n');
  check('no full SSN anywhere in the answers', !/123-45-6789|12345|987654321|98765/.test(answerLines), answerLines);
  check('no em dashes in check output', !/\u2014/.test(out));

  // --- void ---
  r = await call('void_envelope', { envelope_id: 'env_test1', confirm: false });
  check('void without confirm does nothing', /Not cancelled/.test(txt(r)));
  check('void without confirm made no API call', !seen.some((s) => s.method === 'DELETE'));
  r = await call('void_envelope', { envelope_id: 'env_test1', confirm: true });
  check('void with confirm works', /Cancelled/.test(txt(r)));

  // --- downloads ---
  const OUT = T('siglio-out.pdf'); if (existsSync(OUT)) unlinkSync(OUT);
  r = await call('download_signed_document', { envelope_id: 'env_test1', save_path: OUT });
  check('download writes the file', existsSync(OUT) && readFileSync(OUT).toString().includes('signed'));
  r = await call('download_signed_document', { envelope_id: 'env_old', save_path: T('siglio-old.pdf') });
  check('signed PDF after 30 days explains the deletion', r.isError === true && /deleted after 30 days, the sender should keep their own copy/.test(txt(r)), txt(r));

  const ATT = T('siglio-id.jpg'); if (existsSync(ATT)) unlinkSync(ATT);
  r = await call('download_attachment', { envelope_id: 'env_full', file_id: 'att_0123456789abcdef', save_path: ATT });
  check('download_attachment writes the file', existsSync(ATT) && readFileSync(ATT).toString() === 'JPEGBYTES', txt(r));
  check('download_attachment hits the right path', last().path === '/v1/envelopes/env_full/attachments/att_0123456789abcdef', last().path);
  r = await call('download_attachment', { envelope_id: 'env_old', file_id: 'att_0123456789abcdef', save_path: T('siglio-old.jpg') });
  check('attachment after 30 days explains the deletion', r.isError === true && /deleted after 30 days/.test(txt(r)), txt(r));

  r = await call('check_envelope', { envelope_id: 'env_nope' });
  check('unknown envelope fails cleanly', r.isError === true && /Failed/.test(txt(r)));
  check('unknown envelope says where ids come from and not to retry', /send_for_signature/.test(txt(r)) && /will not help/.test(txt(r)), txt(r));

  console.log(pass.map((p) => '  ok    ' + p).join('\n'));
  if (failed.length) { console.error('\n' + failed.map((f) => '  FAIL  ' + f).join('\n')); }
  console.log('\n' + pass.length + ' passed, ' + failed.length + ' failed');
  await client.close(); stub.close(); process.exit(failed.length ? 1 : 0);
});
