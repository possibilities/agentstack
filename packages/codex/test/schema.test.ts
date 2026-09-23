import assert from "node:assert/strict";
import test from "node:test";
import { publishedJsonSchema } from "@agentstack/api";
import { serverList, serverStart } from "../src/api.js";

test("published tool schemas use a single type per branch", () => {
  const schemas = [publishedJsonSchema(serverStart.output), publishedJsonSchema(serverList.output)];
  for (const schema of schemas) assertNoTypeArrays(schema);
  const view = publishedJsonSchema(serverStart.output) as {
    properties: { url: { anyOf: Array<{ type: string }> }; pid: { anyOf: Array<{ type: string }> } };
    required: string[];
  };
  assert.deepEqual(view.properties.url.anyOf, [{ type: "string" }, { type: "null" }]);
  assert.ok(view.properties.pid.anyOf.some((branch) => branch.type === "integer"));
  assert.ok(view.properties.pid.anyOf.some((branch) => branch.type === "null"));
  assert.ok(view.required.includes("url"));
  assert.ok(view.required.includes("pid"));
});

function assertNoTypeArrays(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) assertNoTypeArrays(item);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  assert.equal(Array.isArray(record.type), false);
  for (const value of Object.values(record)) assertNoTypeArrays(value);
}
