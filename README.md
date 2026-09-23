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

### Offline compatibility checks

The optional peer range remains `nodemailer >=6`. The integration matrix runs
real Nodemailer 6.10.1, 7.0.13, 8.0.11, 9.1.1, and 10.0.10 (the current
lockfile version) through both the compile plugin and transport wrapper.
These are representative releases of each available major, not a claim that
every historical patch or future major has been tested. Older majors are
development-only compatibility fixtures, not recommended production versions;
use a maintained, security-patched Nodemailer release in production.

Run `pnpm --filter @sendrepute/node run build`, then
`pnpm --filter @sendrepute/node run test:nodemailer-matrix`. The same matrix
is included automatically in `pnpm run validate:sdk-node`.
After dependencies are installed, it runs offline with in-memory stream
transports and a fake classifier; socket, TLS, HTTP, and fetch access fail the
test. No SMTP server, credentials, or paid API calls are used.

### Node runtime compatibility

The core SDK minimum remains **Node 18.17.0**; it has no runtime dependencies.
This is a compatibility floor, not a recommendation to deploy end-of-life Node.
Use a maintained Node release in production. The development toolchain (pnpm 10,
TypeScript, and default Nodemailer 10 fixture) is separate from the consumer
runtime; Nodemailer 10 requires Node >=20 and does not raise the core SDK floor.
On Node 18 the adapter is exercised with Nodemailer 6–9 only. On Node >=20 the
matrix exercises all five fixture majors. Each fixture's actual `engines.node`
is checked before loading it; incompatible combinations are explicitly skipped.
The single major-version matrix remains in `test/nodemailer-matrix.test.mjs`.

`test:pack` builds and extracts the tarball into a temporary standalone consumer,
then runs the core client suite and adapter matrix through the published package
exports. Those core and Nodemailer suites remain fully network-disabled.
A separate process runs `test/native-fetch.test.mjs` using Node's real built-in
fetch against ephemeral HTTP fixtures bound to `127.0.0.1`. Its preload permits
connections only to registered fixture ports and blocks DNS, TLS, UDP, other
listeners, and external or unregistered sockets (including SMTP). It checks
chunked response parsing, deadline cancellation before headers and during the
body, caller cancellation, and redirect refusal without forwarding credentials.
Both processes use a sanitized environment with no inherited credentials or
proxy configuration; only synthetic keys are used. No package installation,
external API access, paid calls, or SMTP delivery occurs during these tests.
To test additional already-provisioned runtimes with the current build toolchain:

```sh
node lib/sendrepute-node/scripts/test-pack.mjs /path/to/node18.17.0 /path/to/node22 /path/to/node24 /path/to/node26
```

The GitHub `sdk-node.yml` workflow provisions runtimes/dependencies separately
and runs this offline check on exact 18.17.0, Node 20 (legacy coverage), and the
maintained Node 22, 24, and 26 releases as of September 2026. Weekly runs resolve
the latest patch of each major except the deliberately pinned minimum.
The ordinary `validate:sdk-node` also runs the packed tests on its current Node.

Local packed-runtime verification on September 23, 2026 passed on Node 18.17.0
and 18.20.8 (43 core/adapter checks, Nodemailer 10 explicitly skipped),
20.19.3, 22.22.0, 24.13.0, and 26.10.0 (51 core/adapter checks each).
All six runtimes also passed the 10 separate native-fetch loopback checks.
The minimum remains 18.17, rather than being raised to match the development
dependency.

The tests decode actual multipart MIME, check every plain/HTML alternative,
base64 and quoted-printable wire encodings, preserved headers/envelopes,
attachment bytes and object identity, and exactly one classification for
supported content. Source-encoded alternatives remain intentionally unsupported:
blocking rejects before classification/delivery; advisory preserves their
rendered content without billing. Wire encoding of supported strings is distinct
from an encoded source supplied via an alternative's `encoding` option.

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
hiding a later part during analysis. Every angle bracket in supported HTML
must belong to a complete, conservatively formed tag; incomplete tags, nested
angle brackets in attributes, and stray angle delimiters are rejected.
Quoted-printable escapes/soft breaks, base64 transfer-encoding headers, and
literal CSS braces are rejected in every part because the API decodes or strips
those constructs before extracting visible text.
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
