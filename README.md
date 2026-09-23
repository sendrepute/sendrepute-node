# `@sendrepute/node`

Typed, server-only Node.js client for the SendRepute customer API.

> **Server prerequisite:** the API server must have database migration `0081`
> applied before this SDK is used. The package does not migrate or deploy the
> server.

## Requirements and installation

- Node.js 18.17 or newer
- A SendRepute bearer key with the scopes required by each operation
- An explicit customer API base URL

Install the published package (the Nodemailer adapter is included in this same
package, not a separate npm publication):

```sh
npm install @sendrepute/node@0.1.1
# Optional transport dependency:
npm install nodemailer
```

Build and test this standalone source checkout (Node.js and pnpm 10 required):

```sh
git clone https://github.com/sendrepute/sendrepute-node.git
cd sendrepute-node
pnpm install
pnpm validate
pnpm pack --pack-destination ./packs
```

The generated operation contract is checked by a frozen SHA-256 digest in a
standalone checkout; no private server source or workspace package is required.
These commands do not publish, deploy, or apply database migrations.
Use `https://www.sendrepute.com/api` as the hosted API base URL.

## Create a client

Keep the bearer key in the host's secret/environment store. Never embed it in
browser code, return it to a browser, or write it to logs.

```ts
import { SendReputeClient } from "@sendrepute/node";

const apiKey = process.env.SENDREPUTE_API_KEY;
const baseUrl = process.env.SENDREPUTE_API_BASE_URL;
if (!apiKey || !baseUrl) {
  throw new Error("SENDREPUTE_API_KEY and SENDREPUTE_API_BASE_URL are required");
}

const client = new SendReputeClient({
  apiKey,
  baseUrl,
  timeoutMs: 15_000,
  maxRetries: 2,
});
```

`baseUrl` is required intentionally; choose the correct environment rather
than relying on an implicit production endpoint. A custom standards-compatible
`fetch` may be supplied as `fetch` for supported server runtimes and tests.

## Typed requests

`request` accepts a generated OpenAPI `operationId`, an input object containing
`body`, `path`, and/or `query`, and optional request options:

```ts
const account = await client.request("customerGetAccount", {});
const template = await client.request(
  "customerGetVipBuilderTemplate",
  { path: { templateId: "vip-01" } },
  { signal: requestAbortSignal },
);
```

The operation determines the input and response types. See:

- [`examples/standard.ts`](./examples/standard.ts) for account, pricing,
  classification, standard MJML import, and export
- [`examples/vip.ts`](./examples/vip.ts) for VIP plans/status, native
  templates, entitlements, AI generation, and native export
- [`examples/nodemailer.ts`](./examples/nodemailer.ts) for the optional
  Nodemailer adapter

Examples export runnable functions and perform no request merely by being
imported. Invoke them deliberately from server code after supplying host
environment variables; paid functions additionally require the consent flows
described below. Tests can pass a mocked `fetch` to `SendReputeClient` for a
fully local, no-network demonstration.

## Cancellation, timeouts, and retries

Pass an `AbortSignal` when work should end with its incoming HTTP request:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8_000);
try {
  await client.request("customerGetPricingSettings", {}, {
    signal: controller.signal,
  });
} finally {
  clearTimeout(timer);
}
```

The client applies `timeoutMs` per attempt and bounded retries according to
`maxRetries`. It honors server retry guidance for retryable responses. Do not
add an idempotency header, `requestId`, or a client-generated idempotency key:
paid operations derive request identity server-side.

Classification receipts replay an identical account/content/effective-model
request for 24 hours without a second debit. A changed sender, subject, body,
or model is a new paid analysis. Other paid operations have their own
server-defined duplicate window. A retry after that window may be charged
again, so do not treat retries as an unlimited exactly-once guarantee.

## Safe error handling

The SDK rejects unsuccessful requests with `SendReputeError`. Log operational
metadata such as status, code, and request ID, but not the API key, request
headers, email body, prompt, or complete response payload.

```ts
import { SendReputeError } from "@sendrepute/node";

try {
  await client.request("customerGetAccount", {});
} catch (error) {
  if (error instanceof SendReputeError) {
    console.error("SendRepute request failed", {
      status: error.status,
      code: error.code,
      requestId: error.requestId,
    });
  } else {
    console.error("SendRepute request failed");
  }
  throw error;
}
```

The request ID is safe and useful when contacting support. User-facing code
should show a generic message and retain the request ID rather than exposing
internal details.

## Billing and explicit consent

Account/catalog reads and stateless standard builder processing do not create
AI or VIP purchases. Classification is paid. AI generation and native VIP
builder access are separately priced paid operations. Read current pricing
first, show it to the user, and submit the exact `expectedPriceMillicents` only
after explicit confirmation.

The VIP example exports purchase functions but never calls them automatically.
Do not turn those calls into startup hooks, retries from a queue without user
context, or page-load effects. Existing API keys do not gain new scopes
automatically.

## Builder exports

Standard exports support HTML, MJML, and a base64 ZIP containing MJML and
HTML. Native VIP exports support HTML and a base64 ZIP containing three HTML
CSS variants. ZIP responses have `archiveBase64`, `encoding`, `filename`,
`contentType`, and `files`; they do not have an `html` field. Decode one with
the SDK helper:

```ts
import { decodeExportBytes } from "@sendrepute/node";

const exported = await client.request("customerStandardBuilderExport", {
  body: { mjml, format: "zip", filename: "newsletter.zip" },
});
const zipBytes = decodeExportBytes(exported);
```

Do not log `archiveBase64` or the decoded content. Builder operations are
stateless: they do not save designs, upload assets, fetch remote content, or
send email.

## Nodemailer adapter

Install Nodemailer only when the optional adapter is needed:

```sh
pnpm add nodemailer @sendrepute/node
```

Import it from `@sendrepute/node/nodemailer`. The adapter audits immediately
before Nodemailer's real transport. It preserves recipients, attachments, and
the transport rather than replacing delivery.

- **Advisory mode** reports a diagnostic and allows transport delivery.
- **Blocking mode** stops the transport when the configured policy rejects the
  message.

When a message has both plain-text and HTML bodies, or additional Nodemailer
`alternatives`, every displayed `text/plain` and `text/html` body is bundled
into one bounded adapter request, rather than one request per alternative.
Normal client retry settings still apply to that request. Blocking mode rejects
raw, stream/path/URL-backed, encoded, oversized, malformed, or non-plain/HTML
alternative content, as well as unsupported top-level AMP, watch HTML, and
calendar bodies, because the adapter cannot safely approve what it did not
analyze. To keep MIME-part boundaries inert under the API's HTML normalization,
plain-text parts containing `<` or `>` and HTML parts containing comments,
raw-text/non-content elements, or visibility-suppression constructs are also
unsupported. This intentionally conservative rule prevents one part from
hiding a later part during analysis.
Advisory mode preserves delivery for unsupported content, emits an
`unsupported_content` diagnostic, and makes no partial classification request.

The adapter sends message content needed for classification—including the
rendered body—to the SendRepute API. Treat that as a privacy boundary: disclose
the processor, establish an appropriate legal basis, minimize content, and do
not use the adapter for messages whose body must not leave your server.

The included example uses Nodemailer's `streamTransport`, so it produces an
RFC 822 stream locally and sends no email. Production code must supply its own
real Nodemailer transport; the adapter never invents or silently swaps one.

## Support and security

Use GitHub issues for reproducible, non-sensitive bugs. Account support and
private vulnerability reports: support@sendrepute.com. Never include API keys,
customer messages or unredacted logs. See [SECURITY.md](SECURITY.md).
MIT licensed; see LICENSE.
