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
    }
  | {
      kind: "unsupported_content";
      action: "allowed" | "blocked";
      code: "UNSUPPORTED_CONTENT";
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
  amp?: unknown;
  watchHtml?: unknown;
  icalEvent?: unknown;
  raw?: unknown;
  alternatives?: unknown;
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

const MAX_CLASSIFICATION_BODY_BYTES = 524_288;
const encoder = new TextEncoder();

type DisplayPart = {
  mediaType: "text/plain" | "text/html";
  content: string;
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

function requireDisplayContent(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new SendReputeNodemailerError(
    "UNSUPPORTED_CONTENT",
    `Nodemailer ${field} must be non-empty in-memory string content.`,
  );
}

function assertSafeDisplayFragment(
  content: string,
  mediaType: DisplayPart["mediaType"],
): void {
  if (mediaType === "text/plain" && /[<>]/u.test(content)) {
    throw new SendReputeNodemailerError(
      "UNSUPPORTED_CONTENT",
      "Plain-text display content containing markup delimiters cannot be safely bundled.",
    );
  }
  if (mediaType !== "text/html") return;

  const normalizationControl =
    /<!--|-->|<\s*\/?\s*(?:head|style|script|template|svg|xml|textarea|title|xmp|iframe|noembed|noframes|plaintext)\b/iu;
  const visibilityControl =
    /<[a-z][^>]*(?:\b(?:hidden|aria-hidden)\b|(?:display|visibility|mso-hide)\s*:\s*(?:none|hidden|all)\b|(?:font-size|max-height)\s*:\s*0(?:px|pt|em|rem|%)?\b)[^>]*>/iu;
  if (normalizationControl.test(content) || visibilityControl.test(content)) {
    throw new SendReputeNodemailerError(
      "UNSUPPORTED_CONTENT",
      "HTML display content contains constructs that cannot be safely isolated during classification.",
    );
  }
}

function displayPart(
  value: unknown,
  field: string,
  mediaType: DisplayPart["mediaType"],
): DisplayPart {
  const content = requireDisplayContent(value, field);
  assertSafeDisplayFragment(content, mediaType);
  return { mediaType, content };
}

function displayParts(message: NodemailerMessageData): DisplayPart[] {
  for (const field of ["amp", "watchHtml", "icalEvent"] as const) {
    if (message[field] !== undefined && message[field] !== null) {
      throw new SendReputeNodemailerError(
        "UNSUPPORTED_CONTENT",
        `Nodemailer ${field} displayed content is not supported for classification.`,
      );
    }
  }
  const parts: DisplayPart[] = [];
  if (message.text !== undefined && message.text !== null) {
    parts.push(displayPart(message.text, "text", "text/plain"));
  }
  if (message.html !== undefined && message.html !== null) {
    parts.push(displayPart(message.html, "html", "text/html"));
  }

  if (message.alternatives !== undefined && message.alternatives !== null) {
    if (!Array.isArray(message.alternatives)) {
      throw new SendReputeNodemailerError(
        "UNSUPPORTED_CONTENT",
        "Nodemailer alternatives must be an array of in-memory text/plain or text/html content.",
      );
    }
    for (const alternative of message.alternatives) {
      if (!alternative || typeof alternative !== "object" || Array.isArray(alternative)) {
        throw new SendReputeNodemailerError(
          "UNSUPPORTED_CONTENT",
          "Each Nodemailer alternative must be an in-memory text/plain or text/html object.",
        );
      }
      const candidate = alternative as {
        content?: unknown;
        contentType?: unknown;
        encoding?: unknown;
        raw?: unknown;
        path?: unknown;
        href?: unknown;
      };
      if (
        candidate.encoding !== undefined ||
        candidate.raw !== undefined ||
        candidate.path !== undefined ||
        candidate.href !== undefined
      ) {
        throw new SendReputeNodemailerError(
          "UNSUPPORTED_CONTENT",
          "Encoded, raw, path-backed, and URL-backed Nodemailer alternatives are not supported.",
        );
      }
      if (typeof candidate.contentType !== "string") {
        throw new SendReputeNodemailerError(
          "UNSUPPORTED_CONTENT",
          "Each Nodemailer alternative must declare text/plain or text/html contentType.",
        );
      }
      const mediaType = candidate.contentType.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "text/plain" && mediaType !== "text/html") {
        throw new SendReputeNodemailerError(
          "UNSUPPORTED_CONTENT",
          "Only text/plain and text/html Nodemailer alternatives can be analyzed.",
        );
      }
      parts.push(displayPart(candidate.content, "alternative content", mediaType));
    }
  }
  return parts;
}

function combinedBody(parts: DisplayPart[]): string {
  if (parts.length === 0) {
    throw new SendReputeNodemailerError(
      "INVALID_MESSAGE",
      "A non-empty in-memory text or HTML body is required for classification.",
    );
  }
  if (parts.length === 1) {
    const body = parts[0]!.content;
    if (encoder.encode(body).byteLength <= MAX_CLASSIFICATION_BODY_BYTES) return body;
    throw new SendReputeNodemailerError(
      "UNSUPPORTED_CONTENT",
      `Combined displayed content exceeds the ${MAX_CLASSIFICATION_BODY_BYTES}-byte classification limit.`,
    );
  }

  const chunks = ["SendRepute displayed-content bundle v1"];
  let totalBytes = encoder.encode(chunks[0]).byteLength;
  for (const [index, part] of parts.entries()) {
    const contentBytes = encoder.encode(part.content).byteLength;
    const header = `\n-- part ${index + 1}; content-type=${part.mediaType}; utf8-bytes=${contentBytes}\n`;
    totalBytes += encoder.encode(header).byteLength + contentBytes;
    if (totalBytes > MAX_CLASSIFICATION_BODY_BYTES) {
      throw new SendReputeNodemailerError(
        "UNSUPPORTED_CONTENT",
        `Combined displayed content exceeds the ${MAX_CLASSIFICATION_BODY_BYTES}-byte classification limit.`,
      );
    }
    chunks.push(header, part.content);
  }
  const footer = "\n-- end displayed-content bundle --";
  totalBytes += encoder.encode(footer).byteLength;
  if (totalBytes > MAX_CLASSIFICATION_BODY_BYTES) {
    throw new SendReputeNodemailerError(
      "UNSUPPORTED_CONTENT",
      `Combined displayed content exceeds the ${MAX_CLASSIFICATION_BODY_BYTES}-byte classification limit.`,
    );
  }
  chunks.push(footer);
  return chunks.join("");
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
  const body = combinedBody(displayParts(message));

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
  let input: ReturnType<typeof classificationInput>;
  try {
    input = classificationInput(message, options);
  } catch (error) {
    if (
      error instanceof SendReputeNodemailerError &&
      error.code === "UNSUPPORTED_CONTENT"
    ) {
      const blocked = options.policy.mode === "blocking";
      report(options, {
        kind: "unsupported_content",
        action: blocked ? "blocked" : "allowed",
        code: "UNSUPPORTED_CONTENT",
      });
      if (!blocked) return;
    }
    throw error;
  }
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