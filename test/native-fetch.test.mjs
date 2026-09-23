import assert from "node:assert/strict";
import test from "node:test";
import guard from "./loopback-network.cjs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import { once } from "node:events";
import { SendReputeClient, SendReputeError } from "../dist/index.js";

const key = "synthetic-loopback-only";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function fixture(t, handler, options = {}) {
  const server = http.createServer(handler);
  const baseUrl = await guard.listen(server);
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  // Deliberately no fetch injection: exercise the runtime's bundled Undici.
  return new SendReputeClient({ apiKey: key, baseUrl, maxRetries: 0, timeoutMs: 3000, ...options });
}
function hasCode(code) {
  return (error) => error instanceof SendReputeError && error.code === code;
}

test("native fetch guard refuses external, unregistered, SMTP, TLS, DNS and UDP access", async () => {
  for (const options of [
    { host: "203.0.113.1", port: 80 },
    { host: "example.invalid", port: 443 },
    { host: "127.0.0.1", port: 25 },
    { host: "::1", port: 25 },
    { path: "/tmp/sendrepute-forbidden.sock" },
  ]) await assert.rejects(once(net.connect(options), "connect"), /Only registered loopback/);
  assert.throws(() => tls.connect({ host: "127.0.0.1", port: 443 }), /Only registered loopback/);
  assert.throws(() => dns.lookup("example.invalid", () => {}), /Only registered loopback/);
  assert.throws(() => dgram.createSocket("udp4"), /Only registered loopback/);
  assert.throws(() => http.createServer().listen(0), /Only registered loopback/);
  await assert.rejects(fetch("http://example.invalid/"), (error) => /Only registered loopback/.test(error.cause?.message));
});

test("native fetch reads chunked JSON through the packed SDK", { timeout: 10_000 }, async (t) => {
  const started = deferred();
  const release = deferred();
  let completed = false;
  const client = await fixture(t, async (req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"models":["');
    started.resolve();
    await release.promise;
    res.end('streamed"]}');
  });
  t.after(() => release.resolve());
  const pending = client.request("getCustomerApiModels").then((value) => { completed = true; return value; });
  await started.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release.resolve();
  assert.deepEqual(await pending, { models: ["streamed"] });
});

for (const phase of ["headers", "body"]) {
  test(`native fetch deadline cancels stalled ${phase} and closes the socket`, { timeout: 10_000 }, async (t) => {
    const started = deferred();
    const closed = deferred();
    const client = await fixture(t, (_req, res) => {
      res.once("close", closed.resolve);
      if (phase === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"models":[');
      }
      started.resolve();
    }, { timeoutMs: 500 });
    const rejected = assert.rejects(client.request("getCustomerApiModels"), hasCode("REQUEST_TIMEOUT"));
    await started.promise;
    await rejected;
    await closed.promise;
  });
}

test("native fetch caller cancellation aborts a live response body", { timeout: 10_000 }, async (t) => {
  const started = deferred();
  const closed = deferred();
  const controller = new AbortController();
  const client = await fixture(t, (_req, res) => {
    res.once("close", closed.resolve);
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"models":[');
    started.resolve();
  });
  const rejected = assert.rejects(
    client.request("getCustomerApiModels", undefined, { signal: controller.signal }),
    hasCode("REQUEST_CANCELLED"),
  );
  await started.promise;
  controller.abort();
  await rejected;
  await closed.promise;
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`native fetch refuses ${status} without a second request or credential forwarding`, { timeout: 10_000 }, async (t) => {
    let targetCalls = 0;
    const target = http.createServer((_req, res) => { targetCalls++; res.end("{}"); });
    const location = await guard.listen(target);
    t.after(async () => {
      const closed = new Promise((resolve) => target.close(resolve));
      target.closeAllConnections();
      await closed;
    });
    let sourceCalls = 0;
    const client = await fixture(t, (_req, res) => {
      sourceCalls++;
      res.writeHead(status, { location });
      res.end();
    });
    await assert.rejects(client.request("getCustomerApiModels"), hasCode("REDIRECT_REFUSED"));
    assert.equal(sourceCalls, 1);
    assert.equal(targetCalls, 0);
  });
}