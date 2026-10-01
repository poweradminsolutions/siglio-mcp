# siglio-mcp

Lets an AI assistant send documents for electronic signature through
[Siglio](https://esigndev.com), by email, text message, or both at once.

It runs on your own machine, so your API key never leaves it.

## Setup

Get a key from [your Siglio account](https://esigndev.com/app). Signing up takes
an email address, no card, and comes with 25 free envelopes.

**Claude Desktop:** add this to your config file:

```json
{
  "mcpServers": {
    "siglio": {
      "command": "npx",
      "args": ["-y", "siglio-mcp"],
      "env": { "SIGLIO_API_KEY": "sig_sandbox_your_key_here" }
    }
  }
}
```

Other MCP clients take the same command and environment.

## What it can do

| Tool | What it does |
|---|---|
| `send_for_signature` | Sends a PDF to one or two people, by email, text, or both. Can also ask for a payment, files, or answers |
| `check_envelope` | Whether it has been delivered, opened, signed or cancelled, plus any payment, files and answers |
| `download_signed_document` | Saves the completed PDF once every signature is in |
| `download_attachment` | Saves a file the signer uploaded, such as a photo ID |
| `void_envelope` | Cancels an unsigned envelope; the link stops working |

Then you can just ask: *"Send the NDA on my desktop to Dana at 813 555 0142 by
text."*

When the last signer signs, every signer is sent the signed PDF automatically.

## Options on a send

All optional. Leave them out and you get a plain signature request.

| Input | What it does |
|---|---|
| `delivery` | `auto` (the default) sends by email and text together when the signer has both, otherwise by whichever one they have. `email`, `sms` and `both` are strict |
| `payment` | Asks the signer to pay, in whole cents: `{ "amount": 15000, "description": "Deposit", "when": "after" }`. Paid straight into your own Stripe account, which you connect once in the document studio (choose Connect Stripe). `before` holds the document until it is paid |
| `attachments` | Asks the signer to upload 1 to 5 files from their phone: `{ "when": "before", "items": [{ "label": "Photo ID" }] }`. `before` holds the document until the files are in |
| `form_fields` | **Enterprise.** Labels, types, options, formats and show or require rules for the answer fields in your PDF |
| `constraints` | **Enterprise.** Rules across answer fields: exactly one, at least N, at most N, one of, requires |

## The one thing to know about your PDF

Siglio does not take coordinates for signature fields. Placement comes from
literal text tags inside the document itself:

```
^S1   signer one signs here        ^S2   signer two signs here
^I1   signer one initials here     ^I2   ...
^D1   a date that fills itself     ^D2   ...
```

**Set that tag text to white font** before you save the PDF. The tags are
instructions, not content, and black ones stay visible on the signed document.

If the tags are missing the send is rejected and nothing goes out, so you cannot
accidentally mail someone a document they have no way to sign.

## Collecting answers (Enterprise)

On Enterprise accounts the PDF can also ask the signer questions, which they fill
in on a short form before signing:

```
^M1   required text        ^T1      optional text
^C1   a checkbox           ^R1_G1   one option of pick-one group 1
```

Each can carry a name, and boxes a value: `^M1:policy_number`,
`^C1:coverage=liability`, `^R1_G1:plan=monthly`. `check_envelope` then shows the
answers by their labels. Social Security numbers are always shown as the last
four digits only.

On other accounts these tags are refused and nothing is sent.
[Contact Siglio](https://esigndev.com/contact?topic=enterprise) to turn it on.

## Keep your own copy

Signed PDFs, uploaded files and answers are deleted 30 days after the envelope
closes. Download what you need before then.

## Two safety decisions worth knowing

**Live keys are refused by default.** A key starting with `sig_live_` will not
run unless you also set `SIGLIO_ALLOW_LIVE=true`. Until you do that, the worst a
confused assistant can do is send a free sandbox envelope. Sandbox envelopes
deliver for real and produce real signatures; they just cost nothing.

**Sending is idempotent by content.** If an assistant retries the same document
to the same people with the same options, it gets the first envelope back
instead of putting a second copy of a contract in someone's inbox.

Cancelling additionally requires an explicit confirmation, so it cannot happen as
a side effect of a vague instruction.

## Environment

| Variable | |
|---|---|
| `SIGLIO_API_KEY` | Required |
| `SIGLIO_ALLOW_LIVE` | Set to `true` to permit a live key |
| `SIGLIO_API_BASE` | Optional, defaults to `https://api.esigndev.com` |

## More

- Full API reference: <https://esigndev.com/llms-full.txt>
- OpenAPI spec: <https://esigndev.com/openapi.json>
- Docs: <https://esigndev.com/docs>