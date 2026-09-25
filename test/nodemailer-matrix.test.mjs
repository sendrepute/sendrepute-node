import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { after, mock, test } from "node:test";
import { createSendReputePlugin, createSendReputeTransport } from "../dist/nodemailer.js";

const require = createRequire(process.env.SENDREPUTE_MATRIX_MANIFEST || import.meta.url);
const versions = ["nodemailer-6", "nodemailer-7", "nodemailer-8", "nodemailer-9", "nodemailer"];
const policy = {
  paidAnalysisConsent: true,
  mode: "blocking",
  spamProbabilityThreshold: 0.7,
  onApiFailure: "block",
};
const attachment = Buffer.from([0, 255, 128, 10, 13, 42]);

// This file runs in its own node:test process. Fail, rather than silently mock,
// any accidental real delivery or API access.
function noNetwork() { throw new Error("Network access is forbidden in the offline MIME matrix"); }
mock.method(net.Socket.prototype, "connect", noNetwork);
mock.method(tls, "connect", noNetwork);
mock.method(http, "request", noNetwork);
mock.method(https, "request", noNetwork);
mock.method(globalThis, "fetch", noNetwork);
after(() => mock.restoreAll());

function fixture() {
  return {
    from: { name: "Matrix Sender", address: "sender@example.test" },
    to: "Recipient <recipient@example.test>",
    cc: "copy@example.test",
    replyTo: "reply@example.test",
    envelope: { from: "bounce@example.test", to: ["recipient@example.test", "blind@example.test"] },
    subject: "Matrix subject",
    messageId: "<matrix@example.test>",
    date: new Date("2026-01-01T00:00:00Z"),
    headers: { "X-Matrix": "preserved" },
    text: "Routine plain summary café",
    html: "<p>URGENT winner wire funds café</p>",
    alternatives: [
      { contentType: "text/plain", content: "Additional plain résumé" },
      { contentType: "text/html", content: "<strong>Additional HTML résumé</strong>" },
    ],
    attachments: [{ filename: "private.bin", contentType: "application/octet-stream", content: attachment }],
  };
}

// Small independent reader for the MIME produced by these fixtures. Do not use
// Nodemailer's internals to decode its own output or mailparser's merged text:
// every individual alternative must remain visible to these assertions.
function readMime(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const split = source.indexOf("\r\n\r\n");
  assert.ok(split >= 0, "MIME headers are terminated");
  const headers = Object.fromEntries(source.slice(0, split).replace(/\r\n[ \t]+/g, " ")
    .split("\r\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
  const body = source.slice(split + 4);
  const contentType = headers["content-type"] ?? "text/plain";
  if (contentType.startsWith("multipart/")) {
    const boundary = /boundary="([^"]+)"/i.exec(contentType)?.[1];
    assert.ok(boundary, "multipart has a boundary");
    const chunks = body.split(`--${boundary}`);
    assert.ok(chunks.at(-1).startsWith("--"), "multipart has a closing boundary");
    return { headers, children: chunks.slice(1, -1).map((part) => readMime(part.replace(/^\r\n|\r\n$/g, ""))) };
  }
  const encoding = headers["content-transfer-encoding"] ?? "7bit";
  assert.ok(["7bit", "8bit", "base64", "quoted-printable"].includes(encoding));
  const decoded = encoding === "base64" ? Buffer.from(body, "base64")
    : encoding === "quoted-printable"
      ? Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1")
      : Buffer.from(body);
  return { headers, decoded };
}

function leaves(node) {
  return node.children ? node.children.flatMap(leaves) : [node];
}

function harness(nodemailer, adapter, { mode = "blocking", probability = 0.1 } = {}) {
  const calls = [];
  const diagnostics = [];
  const captured = [];
  let initial;
  let streamMail;
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" }).transporter;
  const sink = {
    name: "offline-matrix",
    version: "1",
    send(mail, callback) {
      assert.strictEqual(mail, initial.mail, "adapter preserves Mail identity");
      assert.strictEqual(mail.data, initial.data, "adapter preserves data identity");
      for (const key of ["envelope", "attachments", "alternatives", "from"]) {
        assert.strictEqual(mail.data[key], initial[key], `${key} reference preserved`);
      }
      assert.strictEqual(mail.message, streamMail, "wrapper preserves compiled MimeNode identity");
      captured.push(mail);
      stream.send(mail, callback);
    },
  };
  const options = {
    policy: { ...policy, mode },
    client: {
      async request(...args) {
        calls.push(args);
        return { result: { label: probability >= 0.7 ? "spam" : "inbox", spamProbability: probability } };
      },
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
  const transport = nodemailer.createTransport(adapter === "wrapper" ? createSendReputeTransport(sink, options) : sink);
  transport.use("compile", (mail, callback) => {
    initial = { mail, data: mail.data, ...Object.fromEntries(["envelope", "attachments", "alternatives", "from"].map((key) => [key, mail.data[key]])) };
    callback();
  });
  if (adapter === "plugin") transport.use("compile", createSendReputePlugin(options));
  transport.use("stream", (mail, callback) => { streamMail = mail.message; callback(); });
  return { transport, calls, diagnostics, captured };
}

for (const [index, name] of versions.entries()) {
  const { version, engines } = require(`${name}/package.json`);
  assert.equal(Number(version.split(".")[0]), index + 6, "each matrix slot must load its own real major");
  // Fail closed if fixtures adopt a different engine-range syntax. Check metadata
  // before loading the mailer: Nodemailer 10 cannot run on the SDK's Node 18 floor.
  assert.match(engines.node, /^>=\d+\.\d+\.\d+$/);
  const minimum = engines.node.slice(2).split(".").map(Number);
  const runtime = process.versions.node.split(".").map(Number);
  const difference = runtime.map((part, i) => part - minimum[i]).find((part) => part !== 0) ?? 0;
  if (difference < 0) {
    test(`${version}: requires Node ${engines.node}`, { skip: `runtime ${process.version}` }, () => {});
    continue;
  }
  const nodemailer = require(name);
  for (const adapter of ["plugin", "wrapper"]) {
    for (const textEncoding of ["base64", "quoted-printable"]) {
      test(`${version} ${adapter}: rendered ${textEncoding} multipart, one classification, preserved identity`, async () => {
        const h = harness(nodemailer, adapter);
        const mail = { ...fixture(), textEncoding };
        const result = await h.transport.sendMail(mail);
        assert.equal(h.captured.length, 1);
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0][0], "classifyCustomerEmail");
        assert.deepEqual(h.calls[0][2], {});
        const input = h.calls[0][1].body;
        assert.equal(input.sender, mail.from.name);
        assert.equal(input.subject, mail.subject);
        const mime = readMime(result.message);
        assert.match(mime.headers["content-type"], /^multipart\/mixed/);
        assert.match(mime.children[0].headers["content-type"], /^multipart\/alternative/);
        const parts = leaves(mime);
        const displayed = parts.filter((part) => /^text\/(plain|html)/.test(part.headers["content-type"]));
        assert.equal(displayed.length, 4);
        assert.deepEqual(displayed.map((part) => part.decoded.toString("utf8").trim()),
          [mail.text, mail.html, ...mail.alternatives.map((part) => part.content)]);
        for (const part of displayed) assert.ok(input.body.includes(part.decoded.toString("utf8").trim()));
        assert.ok(displayed.some((part) => part.headers["content-transfer-encoding"] === textEncoding));
        assert.deepEqual(parts.find((part) => part.headers["content-type"].startsWith("application/octet-stream")).decoded, attachment);
        assert.match(parts.at(-1).headers["content-disposition"], /attachment; filename=private.bin/);
        assert.ok(!input.body.includes("private.bin"), "attachments excluded from classification");
        assert.deepEqual(result.envelope, mail.envelope);
        for (const [header, expected] of Object.entries({
          from: "Matrix Sender <sender@example.test>", to: "Recipient <recipient@example.test>",
          cc: "copy@example.test", "reply-to": "reply@example.test", subject: mail.subject,
          "message-id": mail.messageId, "x-matrix": "preserved",
        })) assert.equal(mime.headers[header], expected);
        assert.equal(h.diagnostics[0].action, "allowed");
      });
    }

    test(`${version} ${adapter}: malicious HTML alternative blocks before delivery exactly once`, async () => {
      const h = harness(nodemailer, adapter, { probability: 0.99 });
      await assert.rejects(h.transport.sendMail(fixture()), { code: "SPAM_BLOCKED" });
      assert.equal(h.calls.length, 1);
      assert.ok(h.calls[0][1].body.body.includes("URGENT winner wire funds"));
      assert.equal(h.captured.length, 0);
    });

    test(`${version} ${adapter}: encoded source alternatives fail closed, advisory preserves rendered bytes`, async () => {
      const mail = fixture();
      const html = "<p>Encoded winner wire funds café</p>";
      mail.alternatives = [{ contentType: "text/html", content: Buffer.from(html).toString("base64"), encoding: "base64" }];
      const blocking = harness(nodemailer, adapter);
      await assert.rejects(blocking.transport.sendMail(mail), { code: "UNSUPPORTED_CONTENT" });
      assert.equal(blocking.calls.length, 0);
      assert.equal(blocking.captured.length, 0);
      const advisory = harness(nodemailer, adapter, { mode: "advisory" });
      const result = await advisory.transport.sendMail(mail);
      const parts = leaves(readMime(result.message));
      assert.ok(parts.some((part) => part.decoded.toString("utf8").trim() === html));
      assert.deepEqual(parts.at(-1).decoded, attachment);
      assert.equal(advisory.calls.length, 0, "unsupported content never billed");
      assert.equal(advisory.captured.length, 1);
      assert.deepEqual(advisory.diagnostics, [{ kind: "unsupported_content", action: "allowed", code: "UNSUPPORTED_CONTENT" }]);
    });
  }
}