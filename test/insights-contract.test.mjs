import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { operationMetadata } from "../dist/index.js";

// The packed SDK's client tests verify its self-contained routes. This
// workspace-only check compares the generated contract with the public source.
const spec = JSON.parse(readFileSync(new URL("../../../artifacts/api-server/src/customer-api-openapi.json", import.meta.url), "utf8"));

test("SDK campaign insights operations retain bearer authentication and ai:generate scope", () => {
  const publicOperations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).filter(([, operation]) => operation.operationId)
      .map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })));
  assert.equal(Object.keys(operationMetadata).length, publicOperations.length);
  for (const [id, path] of [
    ["customerQuoteCampaignInsights", "/v1/campaign-insights/quote"],
    ["customerAnalyzeCampaignInsights", "/v1/campaign-insights/analyze"],
  ]) {
    const operation = spec.paths[path].post;
    assert.equal(operation.operationId, id);
    assert.deepEqual(operationMetadata[id], { method: "POST", path });
    assert.deepEqual(operation.security, [{ customerBearer: [] }]);
    assert.equal(operation["x-required-scope"], "ai:generate");
  }
  assert.deepEqual(spec.paths["/v1/campaign-insights/quote"].post.requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/CustomerCampaignInsightsQuoteInput" });
  assert.deepEqual(spec.paths["/v1/campaign-insights/analyze"].post.requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/CustomerCampaignInsightsAnalyzeInput" });
  const input = spec.components.schemas.CustomerCampaignInsightsAnalyzeInput;
  assert.deepEqual(input.required, ["analysisId", "expectedPriceMillicents", "consent", "metrics"]);
  assert.deepEqual(input.properties.expectedPriceMillicents.enum, [10000, 5000]);
  assert.equal(input.properties.consent.const, true);
  assert.equal(input.additionalProperties, false);
  assert.equal(spec.components.schemas.CustomerCampaignInsightsQuote.properties.retentionDays.const, 30);
});