import { createRequire } from "node:module";
import { SendReputeClient } from "@sendrepute/node";
import {
  createSendReputePlugin,
  type SendReputeNodemailerDiagnostic,
} from "@sendrepute/node/nodemailer";

// Nodemailer is an optional peer dependency. Loading it this way keeps the
// core SDK dependency-free while retaining types for this standalone example.
type AuditPlugin = ReturnType<typeof createSendReputePlugin>;
type ExampleTransporter = {
  use(stage: "stream", plugin: AuditPlugin): void;
  sendMail(message: Record<string, unknown>): Promise<unknown>;
};
const nodemailer = createRequire(import.meta.url)("nodemailer") as {
  createTransport(options: {
    streamTransport: true;
    buffer: true;
    newline: "unix";
  }): ExampleTransporter;
};

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

function reportDiagnostic(diagnostic: SendReputeNodemailerDiagnostic): void {
  // Diagnostics intentionally contain no bearer key, recipients, or body.
  console.log("SendRepute mail audit", diagnostic);
}

export async function renderAuditedMessageWithoutSending(options: {
  mode: "advisory" | "blocking";
  signal?: AbortSignal;
}) {
  // streamTransport is a real Nodemailer transport that renders the complete
  // RFC 822 message locally. It performs no network delivery.
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });

  transporter.use(
    "stream",
    createSendReputePlugin({
      client,
      policy: {
        mode: options.mode,
        spamProbabilityThreshold: 0.85,
        onApiFailure: options.mode === "blocking" ? "block" : "allow",
      },
      signal: options.signal,
      onDiagnostic: reportDiagnostic,
    }),
  );

  const result = await transporter.sendMail({
    from: { name: "Example Company", address: "news@example.test" },
    to: [
      { name: "Primary Recipient", address: "primary@example.test" },
      { name: "Second Recipient", address: "second@example.test" },
    ],
    cc: "archive@example.test",
    subject: "Your requested account summary",
    text: "Here is the account summary you requested.",
    html: "<p>Here is the account summary you requested.</p>",
    attachments: [
      {
        filename: "summary.txt",
        content: "Attachment content is preserved for Nodemailer.",
        contentType: "text/plain",
      },
    ],
  });

  // Recipients, attachments, and the configured transport were preserved.
  // Do not log result.message: it contains the complete private message.
  return result;
}

// Classification sends every displayed in-memory text/HTML body together in
// one bounded adapter request (subject to the client's normal retry policy).
// Unsupported content blocks only under a
// blocking policy; advisory mode reports it and preserves delivery without a
// partial paid request. This file deliberately does not invoke the
// function automatically. Advisory mode allows delivery after diagnostics;
// blocking mode prevents transport at/above the threshold. Production code
// can replace streamTransport with its existing SMTP/provider transport.