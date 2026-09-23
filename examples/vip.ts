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
  timeoutMs: 20_000,
  maxRetries: 2,
});

// PAID MEMBERSHIP: call only from a confirmed server-side purchase action.
// Obtain expectedPriceMillicents from customerGetVipPlans immediately before
// presenting the confirmation; do not hard-code a catalog price.
export async function purchaseVipMembershipAfterUserConsent(input: {
  expectedPriceMillicents: number;
  signal?: AbortSignal;
}) {
  return client.request(
    "customerPurchaseVip",
    {
      body: {
        expectedPriceMillicents: input.expectedPriceMillicents,
      },
    },
    { signal: input.signal },
  );
}

// PAID: expose from an authenticated server action only. Display current
// pricing and require an explicit confirmation before calling.
export async function purchaseNativeAccessAfterUserConsent(input: {
  designId: string;
  templateId: `vip-${string}`;
  expectedPriceMillicents: number;
  signal?: AbortSignal;
}) {
  return client.request(
    "customerCreateVipEmailBuilderAccess",
    {
      body: {
        designId: input.designId,
        sourceKind: "template",
        templateId: input.templateId,
        expectedPriceMillicents: input.expectedPriceMillicents,
      },
    },
    { signal: input.signal },
  );
}

// PAID AI: this also creates a native access entitlement. Never call it on
// page load or as an unconfirmed automatic retry.
export async function generateNativeTemplateAfterUserConsent(input: {
  prompt: string;
  expectedPriceMillicents: number;
  signal?: AbortSignal;
}) {
  return client.request(
    "customerCreateVipEmailTemplate",
    {
      body: {
        prompt: input.prompt,
        expectedPriceMillicents: input.expectedPriceMillicents,
      },
    },
    { signal: input.signal },
  );
}

export async function runVipReadOnlyExample(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const [plans, status, templates] = await Promise.all([
      client.request("customerGetVipPlans", {}, { signal: controller.signal }),
      client.request("customerGetVip", {}, { signal: controller.signal }),
      client.request("customerListVipBuilderTemplates", {}, {
        signal: controller.signal,
      }),
    ]);

    console.log("VIP catalog loaded", {
      plansLoaded: Boolean(plans),
      statusLoaded: Boolean(status),
      templatesLoaded: Boolean(templates),
    });

    const accessId = process.env.SENDREPUTE_EXISTING_NATIVE_ACCESS_ID;
    if (!accessId) {
      console.log("Set SENDREPUTE_EXISTING_NATIVE_ACCESS_ID to run native export");
      return;
    }

    // Reading a built-in template does not purchase access. Native processing
    // still requires an active VIP membership and an already-owned open access.
    const template = await client.request(
      "customerGetVipBuilderTemplate",
      { path: { templateId: "vip-01" } },
      { signal: controller.signal },
    );
    const entitlement = await client.request(
      "customerGetVipEmailBuilderAccess",
      { path: { accessId } },
      { signal: controller.signal },
    );
    const imported = await client.request(
      "customerNativeBuilderImport",
      { body: { accessId, document: template.document } },
      { signal: controller.signal },
    );
    const exported = await client.request(
      "customerNativeBuilderExport",
      {
        body: {
          accessId,
          document: template.document,
          filename: "vip-welcome.zip",
          format: "zip",
        },
      },
      { signal: controller.signal },
    );
    const archiveBytes = decodeExportBytes(exported);

    console.log("Native document processed", {
      entitlementLoaded: Boolean(entitlement),
      imported: Boolean(imported),
      archiveByteLength: archiveBytes.byteLength,
    });
  } catch (error) {
    if (error instanceof SendReputeError) {
      console.error("SendRepute request failed", {
        status: error.status,
        code: error.code,
        requestId: error.requestId,
      });
    } else {
      console.error("SendRepute request failed");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Nothing is invoked at module load. A server entry point may explicitly call
// runVipReadOnlyExample; the paid functions above require separate consent.