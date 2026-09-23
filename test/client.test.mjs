import assert from "node:assert/strict";
import test from "node:test";
import {
  SendReputeClient,
  SendReputeError,
  decodeExportBytes,
  operationMetadata,
} from "../dist/index.js";

const classification = {
  requestId: "request-1",
  model: "thor",
  result: {},
  billing: {},
};

test("sends typed operation requests with bearer authentication", async () => {
  let captured;
  const client = new SendReputeClient({
    apiKey: "secret-test-key",
    baseUrl: "https://api.example.test",
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json(classification);
    },
  });
  const result = await client.request("classifyCustomerEmail", {
    body: { sender: "Sender", subject: "Subject", body: "Body" },
  });
  assert.deepEqual(result, classification);
  assert.equal(captured.url.toString(), "https://api.example.test/v1/classify");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.init.headers.authorization, "Bearer secret-test-key");
  assert.equal("x-idempotency-key" in captured.init.headers, false);
});

test("encodes path and query parameters", async () => {
  let requested;
  const client = new SendReputeClient({
    apiKey: "key",
    baseUrl: "http://127.0.0.1:8787/root/",
    fetch: async (url) => {
      requested = url.toString();
      return Response.json({ ok: true });
    },
  });
  await client.request("customerGetEmailBuilderAccess", {
    path: { accessId: "slash/value" },
    query: { designId: "a b" },
  });
  assert.equal(requested, "http://127.0.0.1:8787/root/v1/email-builder/access/slash%2Fvalue?designId=a+b");
});

test("allows HTTP only for explicit loopback hosts", () => {
  for (const baseUrl of ["http://example.test", "http://0.0.0.0:3000", "ftp://localhost"]) {
    assert.throws(() => new SendReputeClient({ apiKey: "key", baseUrl }), /HTTPS/);
  }
  for (const baseUrl of ["http://localhost:3000", "http://127.0.0.1", "http://[::1]:8080"]) {
    assert.doesNotThrow(() => new SendReputeClient({ apiKey: "key", baseUrl, fetch: async () => new Response() }));
  }
});

test("refuses redirects without following or leaking bearer credentials", async () => {
  let calls = 0;
  const client = new SendReputeClient({
    apiKey: "never-leak",
    baseUrl: "https://api.example.test",
    fetch: async (_url, init) => {
      calls += 1;
      assert.equal(init.redirect, "manual");
      return new Response("", { status: 307, headers: { location: "https://attacker.test/" } });
    },
  });
  await assert.rejects(
    client.request("getCustomerApiModels"),
    (error) => error instanceof SendReputeError && error.code === "REDIRECT_REFUSED",
  );
  assert.equal(calls, 1);
});

test("sanitizes API failures while preserving safe diagnostics", async () => {
  const client = new SendReputeClient({
    apiKey: "secret",
    baseUrl: "https://api.example.test",
    maxRetries: 0,
    fetch: async () => Response.json({
      error: { code: "BAD_INPUT", message: "contains secret body contents" },
      requestId: "req-safe",
    }, { status: 400 }),
  });
  await assert.rejects(client.request("getCustomerApiModels"), (error) => {
    assert(error instanceof SendReputeError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "BAD_INPUT");
    assert.equal(error.requestId, "req-safe");
    assert.doesNotMatch(error.message, /secret body contents|secret/);
    return true;
  });
});

test("retries only exact safe operations and statuses", async () => {
  let classifyCalls = 0;
  const classify = new SendReputeClient({
    apiKey: "key",
    baseUrl: "https://api.example.test",
    maxRetries: 1,
    fetch: async () => {
      classifyCalls += 1;
      if (classifyCalls === 1) {
        return Response.json({
          error: { code: "REQUEST_IN_PROGRESS", message: "wait", retryAfterSeconds: 0 },
          requestId: "req-1",
        }, { status: 409 });
      }
      return Response.json(classification);
    },
  });
  await classify.request("classifyCustomerEmail", { body: { sender: "a", subject: "b", body: "c" } });
  assert.equal(classifyCalls, 2);

  let unsafeCalls = 0;
  const unsafe = new SendReputeClient({
    apiKey: "key",
    baseUrl: "https://api.example.test",
    maxRetries: 2,
    fetch: async () => {
      unsafeCalls += 1;
      return Response.json({ error: { code: "TEMPORARY", message: "wait" }, requestId: "req" }, { status: 503 });
    },
  });
  await assert.rejects(
    unsafe.request("customerCreatePaymentInvoice", { body: { amountCents: 1000 } }),
    (error) => error.status === 503,
  );
  assert.equal(unsafeCalls, 1);
});

test("a single total deadline bounds fetch, retries, and response body", async () => {
  const client = new SendReputeClient({
    apiKey: "key",
    baseUrl: "https://api.example.test",
    timeoutMs: 20,
    maxRetries: 2,
    fetch: async (_url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal.reason);
        }, { once: true });
      });
      return Response.json({});
    },
  });
  await assert.rejects(
    client.request("getCustomerApiModels"),
    (error) => error instanceof SendReputeError && error.code === "REQUEST_TIMEOUT",
  );
});

test("deadline cancels a stalled response body", async () => {
  let cancelled = false;
  const client = new SendReputeClient({
    apiKey: "key",
    baseUrl: "https://api.example.test",
    timeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({
      pull() {},
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    client.request("getCustomerApiModels"),
    (error) => error instanceof SendReputeError && error.code === "REQUEST_TIMEOUT",
  );
  assert.equal(cancelled, true);
});

test("caller cancellation is distinct from timeout", async () => {
  const controller = new AbortController();
  const client = new SendReputeClient({
    apiKey: "key",
    baseUrl: "https://api.example.test",
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  const pending = client.request("getCustomerApiModels", undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "REQUEST_CANCELLED");
});

test("decodes standard and VIP ZIP export bytes without Buffer return types", () => {
  const bytes = decodeExportBytes({ archiveBase64: "AAEC" });
  assert(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [0, 1, 2]);
  assert.throws(() => decodeExportBytes({ html: "<p>no archive</p>" }), /does not contain/);
  assert.throws(() => decodeExportBytes({ archiveBase64: "***" }), /invalid base64/);
});

test("generated operation metadata is exhaustive", () => {
  assert.equal(Object.keys(operationMetadata).length, 40);
  assert.deepEqual(operationMetadata.classifyCustomerEmail, { method: "POST", path: "/v1/classify" });
});