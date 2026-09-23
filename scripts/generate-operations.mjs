import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const specPath = path.resolve(root, "../../artifacts/api-server/src/customer-api-openapi.json");
const outputPath = path.resolve(root, "src/generated/operations.ts");
// Public releases freeze the generated customer contract. Regeneration against
// the private service is optional maintainer work, never a build dependency.
const specText = await readFile(specPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (specText === null) {
  const digest = createHash("sha256").update(await readFile(outputPath)).digest("hex");
  if (digest !== "d1ec1660a9c4d025b8a5673eb50dd236c9d77f859cd0d677855d441faacca52b") {
    throw new Error("Frozen v0.1.0 operation contract changed; review and update its checksum before release.");
  }
  console.log("Verified frozen v0.1.0 customer operation contract.");
  process.exit(0);
}
const spec = JSON.parse(specText);

function identifier(value) {
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : JSON.stringify(value);
}

function schemaType(schema) {
  if (!schema) return "unknown";
  if (schema.$ref) return schema.$ref.split("/").at(-1);
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) return variants.map(schemaType).join(" | ");
  if (schema.allOf) return schema.allOf.map(schemaType).join(" & ");
  if (schema.nullable) return `${schemaType({ ...schema, nullable: false })} | null`;
  if (schema.type === "array") return `Array<${schemaType(schema.items)}>`;
  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(
      ([name, value]) => `  ${identifier(name)}${required.has(name) ? "" : "?"}: ${schemaType(value)};`,
    );
    if (schema.additionalProperties && schema.additionalProperties !== false) {
      fields.push(`  [key: string]: ${schema.additionalProperties === true ? "unknown" : schemaType(schema.additionalProperties)};`);
    }
    return fields.length ? `{\n${fields.join("\n")}\n}` : "Record<string, unknown>";
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "string") return "string";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  return "unknown";
}

function resolveParameter(parameter) {
  if (!parameter.$ref) return parameter;
  const parts = parameter.$ref.replace(/^#\//, "").split("/");
  return parts.reduce((value, part) => value[part], spec);
}

function successType(operation) {
  const entry = Object.entries(operation.responses)
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([a], [b]) => Number(a) - Number(b))[0];
  if (!entry) return "never";
  const [, response] = entry;
  const json = response.content?.["application/json"]?.schema;
  return json ? schemaType(json) : "undefined";
}

function inputType(operation) {
  const properties = [];
  const body = operation.requestBody?.content?.["application/json"]?.schema;
  if (body) properties.push(`body${operation.requestBody.required ? "" : "?"}: ${schemaType(body)};`);
  for (const location of ["query", "path"]) {
    const parameters = (operation.parameters ?? []).map(resolveParameter).filter((item) => item.in === location);
    if (!parameters.length) continue;
    const required = location === "path" || parameters.some((item) => item.required);
    const fields = parameters.map(
      (item) => `${identifier(item.name)}${item.required ? "" : "?"}: ${schemaType(item.schema)};`,
    );
    properties.push(`${location}${required ? "" : "?"}: { ${fields.join(" ")} };`);
  }
  return properties.length ? `{ ${properties.join(" ")} }` : "Record<string, never>";
}

const operations = [];
for (const [urlPath, pathItem] of Object.entries(spec.paths)) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const operation = pathItem[method];
    if (!operation?.operationId) continue;
    operations.push({
      id: operation.operationId,
      method: method.toUpperCase(),
      path: urlPath,
      input: inputType(operation),
      response: successType(operation),
    });
  }
}
operations.sort((a, b) => a.id.localeCompare(b.id));

const schemas = Object.entries(spec.components?.schemas ?? {})
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, schema]) => `export type ${name} = ${schemaType(schema)};`)
  .join("\n\n");
const metadata = operations
  .map((operation) => `  ${operation.id}: { method: ${JSON.stringify(operation.method)}, path: ${JSON.stringify(operation.path)} },`)
  .join("\n");
const map = operations
  .map((operation) => `  ${operation.id}: {\n    input: ${operation.input};\n    response: ${operation.response};\n  };`)
  .join("\n");
const source = `/* This file is generated by scripts/generate-operations.mjs. Do not edit. */

${schemas}

export interface OperationMap {
${map}
}

export type OperationId = keyof OperationMap;
export type OperationInput<T extends OperationId> = OperationMap[T]["input"];
export type OperationResponse<T extends OperationId> = OperationMap[T]["response"];

export const operationMetadata: Readonly<Record<OperationId, {
  readonly method: string;
  readonly path: string;
}>> = {
${metadata}
};
`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== source) {
    console.error("Generated operation types are stale. Run: pnpm run generate");
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source);
}