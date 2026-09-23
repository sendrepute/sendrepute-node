import assert from "node:assert/strict";
import test from "node:test";

import {
  SendReputeNodemailerError,
  createSendReputePlugin,
  createSendReputeTransport,
} from "../dist/nodemailer.js";

const allowPolicy = {
  mode: "advisory",
  spamProbabilityThreshold: 0.7,
  onApiFailure: "allow",
};

function response(spamProbability = 0.1) {
  return {
    requestId: "req-safe",
    model: "thor",
    result: {
      label: spamProbability >= 0.5 ? "spam" : "inbox",
      spamProbability,
      confidence: "high",
    },
  };
}

function runPlugin(plugin, mail) {
  return new Promise((resolve, reject) => {
    plugin(mail, (error) => (error ? reject(error) : resolve()));
  });
}

function send(transport, mail) {
  return new Promise((resolve, reject) => {
    transport.send(mail, (error, info) => (error ? reject(error) : resolve(info)));
  });
}

test("compile plugin classifies in-memory content without mutating mail", async () => {
  const calls = [];
  const client = {
    async request(...args) {
      calls.push(args);
      return response();
    },
  };
  const attachmentStream = {
    get pipe() {
      throw new Error("attachment stream was inspected");
    },
  };
  const mail = {
    data: {
      from: { name: "Sender Name", address: "sender@example.test" },
      to: ["one@example.test", "two@example.test"],
      subject: "Original subject",
      text: "Original body",
      attachments: [{ filename: "private.txt", content: attachmentStream }],
      envelope: { from: "bounce@example.test", to: ["one@example.test"] },
    },
    message: { identity: "original" },
  };
  const data = mail.data;
  const recipients = mail.data.to;
  const attachments = mail.data.attachments;
  const envelope = mail.data.envelope;

  await runPlugin(createSendReputePlugin({ client, policy: allowPolicy }), mail);

  assert.deepEqual(calls, [
    [
      "classifyCustomerEmail",
      {
        body: {
          sender: "Sender Name",
          subject: "Original subject",
          body: "Original body",
        },
      },
      {},
    ],
  ]);
  assert.equal(mail.data, data);
  assert.equal(mail.data.to, recipients);
  assert.equal(mail.data.attachments, attachments);
  assert.equal(mail.data.envelope, envelope);
});

test("wrapper preserves transport and mail identity", async () => {
  let received;
  const underlying = {
    name: "mock",
    version: "2",
    send(mail, callback) {
      received = mail;
      callback(null, { accepted: ["to@example.test"] });
    },
  };
  const mail = {
    data: {
      from: "Display Name <from@example.test>",
      to: "to@example.test",
      subject: "Subject",
      html: "<strong>Body</strong>",
    },
  };
  const wrapped = createSendReputeTransport(underlying, {
    client: { request: async () => response() },
    policy: allowPolicy,
  });

  assert.equal(wrapped.name, "mock");
  assert.deepEqual(await send(wrapped, mail), { accepted: ["to@example.test"] });
  assert.equal(received, mail);
});

test("advisory and blocking policies make threshold behavior explicit", async () => {
  const diagnostics = [];
  const client = { request: async () => response(0.9) };
  const mail = {
    data: { from: "Sender <s@example.test>", subject: "Subject", text: "Body" },
  };

  await runPlugin(
    createSendReputePlugin({
      client,
      policy: allowPolicy,
      onDiagnostic: (value) => diagnostics.push(value),
    }),
    mail,
  );
  assert.equal(diagnostics[0].action, "allowed");

  await assert.rejects(
    runPlugin(
      createSendReputePlugin({
        client,
        policy: {
          mode: "blocking",
          spamProbabilityThreshold: 0.9,
          onApiFailure: "allow",
        },
      }),
      mail,
    ),
    (error) =>
      error instanceof SendReputeNodemailerError && error.code === "SPAM_BLOCKED",
  );
});

test("API failure policy allows or blocks with content-safe diagnostics", async () => {
  const secret = "private body must not appear";
  const client = {
    request: async () => {
      throw new Error(`remote failure: ${secret}`);
    },
  };
  const mail = {
    data: { from: "Sender <s@example.test>", subject: "Subject", text: secret },
  };
  const diagnostics = [];

  await runPlugin(
    createSendReputePlugin({
      client,
      policy: allowPolicy,
      onDiagnostic: (value) => diagnostics.push(value),
    }),
    mail,
  );
  assert.deepEqual(diagnostics, [
    { kind: "api_failure", action: "allowed", errorName: "Error" },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private body/);

  await assert.rejects(
    runPlugin(
      createSendReputePlugin({
        client,
        policy: { ...allowPolicy, onApiFailure: "block" },
      }),
      mail,
    ),
    (error) =>
      error instanceof SendReputeNodemailerError &&
      error.code === "API_FAILURE_BLOCKED" &&
      !error.message.includes(secret),
  );
});

test("raw and stream-backed message content are rejected without reading", async () => {
  let calls = 0;
  let reads = 0;
  const stream = {
    get pipe() {
      reads += 1;
      throw new Error("must not read");
    },
  };
  const plugin = createSendReputePlugin({
    client: {
      request: async () => {
        calls += 1;
        return response();
      },
    },
    policy: allowPolicy,
  });

  await assert.rejects(
    runPlugin(plugin, {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        raw: stream,
      },
    }),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  await assert.rejects(
    runPlugin(plugin, {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        text: stream,
      },
    }),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  assert.equal(calls, 0);
  assert.equal(reads, 0);
});

test("invalid policy is rejected before a message can be sent", () => {
  assert.throws(
    () =>
      createSendReputePlugin({
        client: { request: async () => response() },
        policy: { ...allowPolicy, spamProbabilityThreshold: 1.1 },
      }),
    (error) =>
      error instanceof SendReputeNodemailerError && error.code === "INVALID_POLICY",
  );
});