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

const blockPolicy = {
  mode: "blocking",
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

test("plugin classifies benign text and malicious HTML together in one adapter request", async () => {
  const calls = [];
  const client = {
    async request(...args) {
      calls.push(args);
      const body = args[1].body.body;
      assert.match(body, /Routine account update/);
      assert.match(body, /URGENT winner wire funds/);
      assert.match(body, /content-type=text\/plain/);
      assert.match(body, /content-type=text\/html/);
      return response(0.95);
    },
  };
  const mail = {
    data: {
      from: "Sender <s@example.test>",
      subject: "Subject",
      text: "Routine account update",
      html: "<strong>URGENT winner wire funds</strong>",
    },
  };

  await assert.rejects(
    runPlugin(createSendReputePlugin({ client, policy: blockPolicy }), mail),
    (error) => error.code === "SPAM_BLOCKED",
  );
  assert.equal(calls.length, 1);
});

test("wrapper combines top-level and alternative bodies once and preserves delivery data", async () => {
  const calls = [];
  let received;
  const underlying = {
    send(mail, callback) {
      received = mail;
      callback(null, { accepted: mail.data.to });
    },
  };
  const client = {
    async request(...args) {
      calls.push(args);
      return response();
    },
  };
  const attachment = { filename: "report.txt", content: "private attachment" };
  const recipients = ["one@example.test", "two@example.test"];
  const mail = {
    data: {
      from: "Sender <s@example.test>",
      to: recipients,
      subject: "Subject",
      text: "Primary plain body",
      html: "<p>Primary HTML body</p>",
      alternatives: [
        { contentType: "text/plain; charset=utf-8", content: "Accessible plain alternative" },
        { contentType: "text/html", content: "<p>Rich HTML alternative</p>" },
      ],
      attachments: [attachment],
    },
  };

  await send(createSendReputeTransport(underlying, { client, policy: allowPolicy }), mail);

  assert.equal(calls.length, 1);
  const body = calls[0][1].body.body;
  for (const expected of [
    "Primary plain body",
    "<p>Primary HTML body</p>",
    "Accessible plain alternative",
    "<p>Rich HTML alternative</p>",
  ]) {
    assert.match(body, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(received, mail);
  assert.equal(received.data.to, recipients);
  assert.equal(received.data.attachments[0], attachment);
});

test("combined displayed content is bounded before classification", async () => {
  let calls = 0;
  const diagnostics = [];
  const mail = {
    data: {
      from: "Sender <s@example.test>",
      subject: "Subject",
      text: "a".repeat(300_000),
      html: "b".repeat(224_289),
    },
  };
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };

  await assert.rejects(
    runPlugin(createSendReputePlugin({ client, policy: blockPolicy }), mail),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  await runPlugin(
    createSendReputePlugin({
      client,
      policy: allowPolicy,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
    mail,
  );
  assert.equal(calls, 0);
  assert.deepEqual(diagnostics, [
    { kind: "unsupported_content", action: "allowed", code: "UNSUPPORTED_CONTENT" },
  ]);
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

test("unsupported content blocks blocking policy but advisory policy allows without billing", async () => {
  let calls = 0;
  let reads = 0;
  const client = {
    request: async () => {
      calls += 1;
      return response();
    },
  };
  const stream = {
    get pipe() {
      reads += 1;
      throw new Error("must not read");
    },
  };
  const blockingPlugin = createSendReputePlugin({
    client,
    policy: blockPolicy,
  });

  await assert.rejects(
    runPlugin(blockingPlugin, {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        raw: stream,
      },
    }),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  await assert.rejects(
    runPlugin(blockingPlugin, {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        text: stream,
      },
    }),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  await assert.rejects(
    runPlugin(blockingPlugin, {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        text: "Safe primary body",
        alternatives: [{ contentType: "text/html", content: stream }],
      },
    }),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );

  const diagnostics = [];
  await runPlugin(
    createSendReputePlugin({
      client,
      policy: allowPolicy,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
    {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        text: "Safe primary body",
        alternatives: [{ contentType: "text/calendar", content: "BEGIN:VCALENDAR" }],
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(reads, 0);
  assert.deepEqual(diagnostics, [
    { kind: "unsupported_content", action: "allowed", code: "UNSUPPORTED_CONTENT" },
  ]);
});

test("unsupported top-level displayed MIME fields block or advisory-skip consistently", async () => {
  for (const field of ["amp", "watchHtml", "icalEvent"]) {
    let calls = 0;
    const client = {
      async request() {
        calls += 1;
        return response();
      },
    };
    const mail = {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        text: "Benign plain text",
        [field]: field === "icalEvent" ? { content: "BEGIN:VCALENDAR" } : "<p>Displayed body</p>",
      },
    };

    await assert.rejects(
      runPlugin(createSendReputePlugin({ client, policy: blockPolicy }), mail),
      (error) => error.code === "UNSUPPORTED_CONTENT",
      `${field} must fail closed`,
    );
    const diagnostics = [];
    await runPlugin(
      createSendReputePlugin({
        client,
        policy: allowPolicy,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
      mail,
    );
    assert.equal(calls, 0);
    assert.deepEqual(diagnostics, [
      { kind: "unsupported_content", action: "allowed", code: "UNSUPPORTED_CONTENT" },
    ]);
  }
});

test("alternative raw, path, href, and encoding sources cannot hide displayed content", async () => {
  const unsupportedAlternatives = [
    { contentType: "text/html", content: "<p>Benign</p>", raw: "Content-Type: text/html" },
    { contentType: "text/html", content: "<p>Benign</p>", path: "./different.html" },
    { contentType: "text/html", content: "<p>Benign</p>", href: "https://example.test/different.html" },
    {
      contentType: "text/html",
      content: "PHN0cm9uZz5XaW5uZXI8L3N0cm9uZz4=",
      encoding: "base64",
    },
  ];
  let calls = 0;
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };

  for (const alternative of unsupportedAlternatives) {
    const mail = {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        text: "Benign plain text",
        alternatives: [alternative],
        attachments: [{ filename: "kept.txt", content: "attachment is unrelated" }],
      },
    };
    await assert.rejects(
      send(
        createSendReputeTransport(
          { send: (_mail, callback) => callback(null, { sent: true }) },
          { client, policy: blockPolicy },
        ),
        mail,
      ),
      (error) => error.code === "UNSUPPORTED_CONTENT",
    );
    await runPlugin(createSendReputePlugin({ client, policy: allowPolicy }), mail);
  }
  assert.equal(calls, 0);
});

test("empty display parts and dangerous HTML fragments are unsupported", async () => {
  const cases = [
    { text: "" },
    { html: "" },
    { text: "Benign", alternatives: [{ contentType: "text/plain", content: "" }] },
    { html: "<p>Visible</p><!-- unclosed" },
    { html: "<style>.safe { color: green }</style><p>Balanced</p>" },
    { html: "<plaintext>later MIME parts would be swallowed" },
    { html: "<p>Visible</p></script-not-real>" },
    { html: "<div style=\"display:none\">concealed</div>" },
  ];
  let calls = 0;
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };

  for (const displayed of cases) {
    const mail = {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        ...displayed,
      },
    };
    await assert.rejects(
      runPlugin(createSendReputePlugin({ client, policy: blockPolicy }), mail),
      (error) => error.code === "UNSUPPORTED_CONTENT",
    );
    await runPlugin(createSendReputePlugin({ client, policy: allowPolicy }), mail);
  }
  assert.equal(calls, 0);
});

test("ordinary HTML without normalization controls remains analyzable", async () => {
  const calls = [];
  const mail = {
    data: {
      from: "Sender <s@example.test>",
      subject: "Subject",
      html: "<p class=\"notice\"><strong>Hello</strong></p>",
    },
  };
  await runPlugin(
    createSendReputePlugin({
      client: {
        async request(...args) {
          calls.push(args);
          return response();
        },
      },
      policy: blockPolicy,
    }),
    mail,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].body.body, mail.data.html);
});

test("plugin rejects split plain-text comment delimiters before a later HTML alternative", async () => {
  let calls = 0;
  const diagnostics = [];
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };
  const mail = {
    data: {
      from: "Sender <s@example.test>",
      subject: "Subject",
      text: "Benign summary <!--",
      html: "--><strong>URGENT winner wire funds</strong>",
    },
  };

  await assert.rejects(
    runPlugin(createSendReputePlugin({ client, policy: blockPolicy }), mail),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  await runPlugin(
    createSendReputePlugin({
      client,
      policy: allowPolicy,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
    mail,
  );
  assert.equal(calls, 0);
  assert.deepEqual(diagnostics, [
    { kind: "unsupported_content", action: "allowed", code: "UNSUPPORTED_CONTENT" },
  ]);
});

test("wrapper rejects split plain-text script delimiters without invoking transport", async () => {
  let calls = 0;
  let sends = 0;
  const diagnostics = [];
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };
  const underlying = {
    send(_mail, callback) {
      sends += 1;
      callback(null, { sent: true });
    },
  };
  const mail = {
    data: {
      from: "Sender <s@example.test>",
      subject: "Subject",
      text: "Routine update <script>",
      alternatives: [
        { contentType: "text/html", content: "</script><p>URGENT winner wire funds</p>" },
      ],
    },
  };

  await assert.rejects(
    send(createSendReputeTransport(underlying, { client, policy: blockPolicy }), mail),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  assert.equal(sends, 0);

  await send(
    createSendReputeTransport(underlying, {
      client,
      policy: allowPolicy,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
    mail,
  );
  assert.equal(calls, 0);
  assert.equal(sends, 1);
  assert.deepEqual(diagnostics, [
    { kind: "unsupported_content", action: "allowed", code: "UNSUPPORTED_CONTENT" },
  ]);
});

test("plugin rejects incomplete HTML that could be completed by a later alternative", async () => {
  let calls = 0;
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };
  const mail = {
    data: {
      from: "Sender <s@example.test>",
      subject: "Subject",
      html: "<div style=\"display:none\"",
      alternatives: [
        { contentType: "text/html", content: ">URGENT winner wire funds</div>" },
      ],
    },
  };

  await assert.rejects(
    runPlugin(createSendReputePlugin({ client, policy: blockPolicy }), mail),
    (error) => error.code === "UNSUPPORTED_CONTENT",
  );
  await runPlugin(createSendReputePlugin({ client, policy: allowPolicy }), mail);
  assert.equal(calls, 0);
});

test("wrapper rejects unmatched and nested HTML angles before transport", async () => {
  const unsafeBodies = [
    {
      html: "<div",
      alternatives: [{ contentType: "text/html", content: ">malicious</div>" }],
    },
    { html: "<a title=\"literal > angle\">malicious</a>" },
    { html: "<p>malicious</p>>" },
  ];
  let calls = 0;
  let sends = 0;
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };
  const underlying = {
    send(_mail, callback) {
      sends += 1;
      callback(null, { sent: true });
    },
  };

  for (const displayed of unsafeBodies) {
    await assert.rejects(
      send(
        createSendReputeTransport(underlying, { client, policy: blockPolicy }),
        {
          data: {
            from: "Sender <s@example.test>",
            subject: "Subject",
            ...displayed,
          },
        },
      ),
      (error) => error.code === "UNSUPPORTED_CONTENT",
    );
  }
  assert.equal(calls, 0);
  assert.equal(sends, 0);
});

test("transfer encodings and CSS delimiters cannot reconstruct ignored content", async () => {
  const unsafeParts = [
    { text: "Benign =3Cscript=3E malicious =3C/script=3E" },
    { text: "Benign soft break=\nmalicious continuation" },
    {
      text: "Content-Transfer-Encoding: base64\n\nPHNjcmlwdD5tYWxpY2lvdXM8L3NjcmlwdD4=",
    },
    { text: "Benign prefix {", html: "<p>malicious later part</p>" },
    {
      text: "Benign",
      alternatives: [{ contentType: "text/html", content: "<p>malicious }</p>" }],
    },
  ];
  let calls = 0;
  const diagnostics = [];
  const client = {
    async request() {
      calls += 1;
      return response();
    },
  };

  for (const displayed of unsafeParts) {
    const mail = {
      data: {
        from: "Sender <s@example.test>",
        subject: "Subject",
        ...displayed,
      },
    };
    await assert.rejects(
      runPlugin(createSendReputePlugin({ client, policy: blockPolicy }), mail),
      (error) => error.code === "UNSUPPORTED_CONTENT",
    );
    await runPlugin(
      createSendReputePlugin({
        client,
        policy: allowPolicy,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
      mail,
    );
  }
  assert.equal(calls, 0);
  assert.equal(diagnostics.length, unsafeParts.length);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.kind === "unsupported_content"));
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