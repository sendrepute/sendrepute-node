import {
  decodeExportBytes,
  SendReputeClient,
  SendReputeError,
} from "@sendrepute/node";

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

function reportSafely(error: unknown): void {
  if (error instanceof SendReputeError) {
    // Do not log the bearer key, email content, or complete error payload.
    console.error("SendRepute request failed", {
      status: error.status,
      code: error.code,
      requestId: error.requestId,
    });
    return;
  }
  console.error("SendRepute request failed");
}

export async function classifyAfterUserConsent(signal?: AbortSignal) {
  // Classification is a paid operation. Call this only after showing current
  // pricing and obtaining user consent.
  return client.request(
    "classifyCustomerEmail",
    {
      body: {
        sender: "Example Company",
        subject: "Your requested account summary",
        body: "Here is the account summary you requested.",
      },
    },
    { signal },
  );
}

export async function runStandardExample(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const [account, pricing] = await Promise.all([
      client.request("customerGetAccount", {}, { signal: controller.signal }),
      client.request("customerGetPricingSettings", {}, {
        signal: controller.signal,
      }),
    ]);

    console.log("Account and pricing loaded", {
      // Avoid dumping entire account or billing records.
      accountLoaded: Boolean(account),
      pricingLoaded: Boolean(pricing),
    });

    const mjml = [
      "<mjml>",
      "<mj-body>",
      '<mj-section><mj-column><mj-text>Hello!</mj-text></mj-column></mj-section>',
      "</mj-body>",
      "</mjml>",
    ].join("");

    const imported = await client.request(
      "customerStandardBuilderImport",
      { body: { mjml, filename: "welcome.html" } },
      { signal: controller.signal },
    );

    const exported = await client.request(
      "customerStandardBuilderExport",
      { body: { mjml, filename: "welcome.zip", format: "zip" } },
      { signal: controller.signal },
    );
    const archiveBytes = decodeExportBytes(exported);

    console.log("Stateless standard document processed", {
      imported: Boolean(imported),
      archiveByteLength: archiveBytes.byteLength,
    });

    // Paid classification is deliberately opt-in, not a startup side effect.
    if (process.env.RUN_PAID_CLASSIFICATION === "I_HAVE_CONFIRMED_THE_PRICE") {
      const result = await classifyAfterUserConsent(controller.signal);
      console.log("Classification completed", { completed: Boolean(result) });
    }
  } catch (error) {
    reportSafely(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
