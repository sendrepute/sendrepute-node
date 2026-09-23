import { SendReputeError, type SendReputeClient } from "./index.js";

export type SendReputeNodemailerPolicy = {
  mode: "advisory" | "blocking";
  spamProbabilityThreshold: number;
  onApiFailure: "allow" | "block";
};

export type SendReputeNodemailerDiagnostic =
  | {
      kind: "classification";
      action: "allowed" | "blocked";
      requestId?: string;
      model?: string;
      label: "inbox" | "spam";
      spamProbability: number;
      confidence?: "low" | "medium" | "high";
    }
  | {
      kind: "api_failure";
      action: "allowed" | "blocked";
      errorName: string;
      status?: number;
      code?: string;
    };

export type SendReputeNodemailerOptions = {
  client: Pick<SendReputeClient, "request">;
  policy: SendReputeNodemailerPolicy;
  model?: "thor" | "theos" | "athena" | "odin" | "freya" | "hermes" | "ares" | "apollo";
  sender?: string | ((message: Readonly<NodemailerMessageData>) => string);
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: SendReputeNodemailerDiagnostic) => void;
};

export type NodemailerMessageData = {
  from?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  raw?: unknown;
  attachments?: unknown;
  envelope?: unknown;
};

export type NodemailerMail = {
  data: NodemailerMessageData;
};

export type NodemailerCallback<T = unknown> = (error: Error | null, result?: T) => void;

export type NodemailerTransport<T = unknown> = {
  name?: string;
  version?: string;
  send(mail: NodemailerMail, callback: NodemailerCallback<T>): unknown;
  close?: () => unknown;
  verify?: (...args: any[]) => unknown;
};

export class SendReputeNodemailerError extends Error {
  readonly code:
    | "INVALID_POLICY"
    | "INVALID_MESSAGE"
    | "UNSUPPORTED_CONTENT"
    | "SPAM_BLOCKED"
    | "API_FAILURE_BLOCKED";

  constructor(
    code: SendReputeNodemailerError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SendReputeNodemailerError";
    this.code = code;
  }
}

type Classification = {
  requestId?: string;
  model?: string;
  result: {
    label: "inbox" | "spam";
    spamProbability: number;
    confidence?: "low" | "medium" | "high";
  };
};

function validateOptions(options: SendReputeNodemailerOptions): void {
  const threshold = options.policy.spamProbabilityThreshold;
  if (
    (options.policy.mode !== "advisory" && options.policy.mode !== "blocking") ||
    (options.policy.onApiFailure !== "allow" && options.policy.onApiFailure !== "block") ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new SendReputeNodemailerError(
      "INVALID_POLICY",
      "Nodemailer policy must specify a valid mode, API failure action, and spam threshold from 0 to 1.",
    );
  }
}

function displayNameFromFrom(from: unknown): string | undefined {
  const value = Array.isArray(from) ? from[0] : from;
  if (value && typeof value === "object") {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  }
  if (typeof value !== "string") return undefined;

  const bracketIndex = value.lastIndexOf("<");
  if (bracketIndex <= 0 || !value.endsWith(">")) return undefined;
  const name = value
    .slice(0, bracketIndex)
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return name || undefined;
}

function requireStringField(
  value: unknown,
  field: "subject" | "text" | "html",
): string {
  if (typeof value === "string") {
    if (value.length > 0) return value;
    throw new SendReputeNodemailerError(
      "INVALID_MESSAGE",
      `Nodemailer message ${field} must not be empty.`,
    );
  }
  throw new SendReputeNodemailerError(
    "UNSUPPORTED_CONTENT",
    `Nodemailer message ${field} must be an in-memory string; streams, paths, and URLs are not analyzed.`,
  );
}

function classificationInput(
  message: NodemailerMessageData,
  options: SendReputeNodemailerOptions,
): { sender: string; subject: string; body: string; model?: SendReputeNodemailerOptions["model"] } {
  if (message.raw !== undefined && message.raw !== null) {
    throw new SendReputeNodemailerError(
      "UNSUPPORTED_CONTENT",
      "Raw Nodemailer messages are not supported for classification.",
    );
  }

  const sender =
    typeof options.sender === "function"
      ? options.sender(message)
      : options.sender ?? displayNameFromFrom(message.from);
  if (typeof sender !== "string" || !sender.trim()) {
    throw new SendReputeNodemailerError(
      "INVALID_MESSAGE",
      "A sender display name is required; provide a named from address or the sender option.",
    );
  }

  const subject = requireStringField(message.subject, "subject");
  let body: string;
  if (message.text !== undefined && message.text !== null) {
    body = requireStringField(message.text, "text");
  } else if (message.html !== undefined && message.html !== null) {
    body = requireStringField(message.html, "html");
  } else {
    throw new SendReputeNodemailerError(
      "INVALID_MESSAGE",
      "A non-empty in-memory text or HTML body is required for classification.",
    );
  }

  const input = { sender: sender.trim(), subject, body };
  return options.model === undefined ? input : { ...input, model: options.model };
}

function asClassification(value: unknown): Classification {
  if (!value || typeof value !== "object") throw new Error("Invalid classification response");
  const response = value as Partial<Classification>;
  const result = response.result;
  if (
    !result ||
    (result.label !== "inbox" && result.label !== "spam") ||
    typeof result.spamProbability !== "number" ||
    !Number.isFinite(result.spamProbability)
  ) {
    throw new Error("Invalid classification response");
  }
  return response as Classification;
}

function report(
  options: SendReputeNodemailerOptions,
  diagnostic: SendReputeNodemailerDiagnostic,
): void {
  try {
    options.onDiagnostic?.(diagnostic);
  } catch {
    // A diagnostics sink must never alter mail delivery.
  }
}

function apiFailureDiagnostic(
  error: unknown,
  action: "allowed" | "blocked",
): SendReputeNodemailerDiagnostic {
  const diagnostic: SendReputeNodemailerDiagnostic = {
    kind: "api_failure",
    action,
    errorName: error instanceof Error ? error.name : "Error",
  };
  if (error instanceof SendReputeError) {
    const safe = error as SendReputeError & { status?: unknown; code?: unknown };
    if (typeof safe.status === "number") diagnostic.status = safe.status;
    if (typeof safe.code === "string") diagnostic.code = safe.code;
  }
  return diagnostic;
}

async function inspect(
  message: NodemailerMessageData,
  options: SendReputeNodemailerOptions,
): Promise<void> {
  const input = classificationInput(message, options);
  let classification: Classification;
  try {
    const requestOptions = options.signal === undefined ? {} : { signal: options.signal };
    classification = asClassification(
      await options.client.request(
        "classifyCustomerEmail",
        { body: input },
        requestOptions,
      ),
    );
  } catch (error) {
    const blocked = options.policy.onApiFailure === "block";
    report(options, apiFailureDiagnostic(error, blocked ? "blocked" : "allowed"));
    if (blocked) {
      throw new SendReputeNodemailerError(
        "API_FAILURE_BLOCKED",
        "Message blocked because SendRepute classification was unavailable.",
      );
    }
    return;
  }

  const blocked =
    options.policy.mode === "blocking" &&
    classification.result.spamProbability >= options.policy.spamProbabilityThreshold;
  report(options, {
    kind: "classification",
    action: blocked ? "blocked" : "allowed",
    ...(classification.requestId === undefined ? {} : { requestId: classification.requestId }),
    ...(classification.model === undefined ? {} : { model: classification.model }),
    label: classification.result.label,
    spamProbability: classification.result.spamProbability,
    ...(classification.result.confidence === undefined
      ? {}
      : { confidence: classification.result.confidence }),
  });
  if (blocked) {
    throw new SendReputeNodemailerError(
      "SPAM_BLOCKED",
      "Message blocked by the configured SendRepute spam threshold.",
    );
  }
}

export function createSendReputePlugin(
  options: SendReputeNodemailerOptions,
): (mail: NodemailerMail, callback: NodemailerCallback<void>) => void {
  validateOptions(options);
  return (mail, callback) => {
    void inspect(mail.data, options).then(
      () => callback(null),
      (error: unknown) =>
        callback(
          error instanceof Error
            ? error
            : new SendReputeNodemailerError(
                "API_FAILURE_BLOCKED",
                "Message blocked because SendRepute classification failed.",
              ),
        ),
    );
  };
}

export function createSendReputeTransport<T>(
  transport: NodemailerTransport<T>,
  options: SendReputeNodemailerOptions,
): NodemailerTransport<T> {
  validateOptions(options);
  return {
    name: transport.name ?? "sendrepute",
    version: transport.version ?? "1",
    send(mail, callback) {
      void inspect(mail.data, options).then(
        () => {
          transport.send(mail, callback);
        },
        (error: unknown) => {
          callback(
            error instanceof Error
              ? error
              : new SendReputeNodemailerError(
                  "API_FAILURE_BLOCKED",
                  "Message blocked because SendRepute classification failed.",
                ),
          );
        },
      );
    },
    ...(transport.close === undefined ? {} : { close: transport.close.bind(transport) }),
    ...(transport.verify === undefined ? {} : { verify: transport.verify.bind(transport) }),
  };
}