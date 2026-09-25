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

test("AI rewrite quote is an authenticated retry-safe free operation", async () => {
  let calls = 0;
  const requests = [];
  const client = new SendReputeClient({
    apiKey: "quote-key",
    baseUrl: "https://api.example.test",
    maxRetries: 1,
    fetch: async (url, init) => {
      calls += 1;
      requests.push({ url: url.toString(), init });
      if (calls === 1) {
        return Response.json({
          error: { code: "TEMPORARY", message: "wait" },
          requestId: "quote-request-1",
        }, { status: 503 });
      }
      return Response.json({
        mode: "single",
        uniqueTermCount: 1,
        minimumPerUniqueTermMillicents: 1000,
        minimumChargeMillicents: 1000,
        maximumChargeMillicents: 1000,
        currentBalanceMillicents: 5000,
        balanceAfterMaximumMillicents: 4000,
        vipActive: false,
      });
    },
  });
  const input = {
    body: { parentRequestId: "parent-1", mode: "single", terms: ["offer"] },
  };
  const quote = await client.request("customerQuoteAiRewrite", input);
  assert.equal(calls, 2);
  assert.equal(quote.minimumChargeMillicents, 1000);
  for (const request of requests) {
    assert.equal(request.url, "https://api.example.test/v1/rewrite/ai-quote");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers.authorization, "Bearer quote-key");
    assert.equal("x-idempotency-key" in request.init.headers, false);
    assert.deepEqual(JSON.parse(request.init.body), input.body);
  }
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

test("deadline cancels a stalled response body", async (t) => {
  // AbortSignal.timeout is unreferenced. This synthetic stream has no socket to
  // keep older Node test runners alive until the deadline fires.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
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

test("generated operation metadata is exhaustive and preserves security-sensitive routes", () => {
  assert.equal(Object.keys(operationMetadata).length, 44);
  assert.deepEqual(operationMetadata.classifyCustomerEmail, { method: "POST", path: "/v1/classify" });
  assert.deepEqual(operationMetadata.customerQuoteCampaignInsights, {
    method: "POST",
    path: "/v1/campaign-insights/quote",
  });
  assert.deepEqual(operationMetadata.customerAnalyzeCampaignInsights, {
    method: "POST",
    path: "/v1/campaign-insights/analyze",
  });
  assert.deepEqual(operationMetadata.customerCreateHostedBuilderHandoff, {
    method: "POST",
    path: "/v1/email-builder/hosted-handoffs",
  });
  assert.deepEqual(operationMetadata.customerQuoteAiRewrite, {
    method: "POST",
    path: "/v1/rewrite/ai-quote",
  });
});

test("campaign insights quote and paid analysis send only their explicit bodies without automatic retry", async () => {
  const calls = [];
  const client = new SendReputeClient({
    apiKey: "secret-test-key",
    baseUrl: "https://api.example.test",
    fetch: async (url, init) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body), authorization: init.headers.authorization });
      if (calls.length === 1) return Response.json({
        priceMillicents: 10000, currency: "USD", vip: false, retentionDays: 30,
      });
      return Response.json({ error: { code: "ANALYSIS_FAILED", message: "Try again later" } }, { status: 503 });
    },
  });
  const quote = await client.request("customerQuoteCampaignInsights", { body: {} });
  assert.equal(quote.priceMillicents, 10000);
  const body = {
    analysisId: "opaque-id-12345678",
    expectedPriceMillicents: quote.priceMillicents,
    consent: true,
    metrics: { sent: 100, delivered: 95, deliveryRate: 95 },
  };
  await assert.rejects(client.request("customerAnalyzeCampaignInsights", { body }), (error) =>
    error instanceof SendReputeError && error.code === "ANALYSIS_FAILED" && error.status === 503);
  assert.deepEqual(calls, [
    { path: "/v1/campaign-insights/quote", body: {}, authorization: "Bearer secret-test-key" },
    { path: "/v1/campaign-insights/analyze", body, authorization: "Bearer secret-test-key" },
  ]);
});
