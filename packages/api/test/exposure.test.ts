import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { resolveExposure, resolveWorkerExposure } from "../src/exposure.js";
import { serveApi } from "../src/serve.js";
import { loadCatalog } from "../src/catalog.js";

const header = "name: demo\ndescription: Demo.\nsocket:\n  description: Internal.\n";
test("operation and event selections are explicit, independent, positive and validated", () => {
  for (const transport of ["mcp", "websocket"] as const) {
    const config = (selection: string) => parseConfig(`${header}${transport}:\n  description: Selected.\n${selection}`);
    for (const selection of ["", "  operations: all\n", "  events: all\n", "  operations: '*'\n  events: all\n", "  operations: {exclude: [write]}\n  events: all\n"])
      assert.throws(() => config(selection));
    const resolve = (operations: string, events: string) => resolveExposure(config(`  operations: ${operations}\n  events: ${events}\n`), transport, ["read", "write"], ["changed", "progress"]);
    assert.deepEqual(resolve("all", "all"), { operations: ["read", "write"], events: ["changed", "progress"] });
    assert.deepEqual(resolve("[]", "[changed]"), { operations: [], events: ["changed"] });
    assert.deepEqual(resolve("[read]", "[]"), { operations: ["read"], events: [] });
    for (const [operations, events] of [["[missing]", "all"], ["all", "[missing]"], ["[read, read]", "all"], ["all", "[changed, changed]"]])
      assert.throws(() => resolve(operations!, events!), /unknown|duplicate/);
    assert.throws(() => resolveExposure(parseConfig(header), transport, [], []), /does not configure/);
  }
  assert.deepEqual(resolveExposure(parseConfig(header), "socket", ["read", "write"], ["changed"]), { operations: ["read", "write"], events: ["changed"] });
});

test("semantic selection errors fail discovery and startup before creating a context", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-selection-"));
  const dir = join(root, "packages", "demo");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: [packages/*]\n");
  await writeFile(join(dir, "package.json"), '{"name":"demo","type":"module"}');
  await writeFile(join(dir, "dist", "api.js"), `export const api = { operations: [],
    createContext() { throw new Error("context must not be created"); }, closeContext() {} };`);
  try {
    for (const selection of ["operations: [missing]\n  events: all", "operations: all\n  events: [missing]", "operations: all\n  events: []\n  workerOperations: [missing]"]) {
      await writeFile(join(dir, "api.yaml"), `${header}mcp:\n  description: Selected.\n  ${selection}\n`);
      await assert.rejects(loadCatalog({}, root), /selects unknown name/);
      await assert.rejects(serveApi({ root, name: "demo", transport: "socket", env: { STACK_STATE_DIR: root } }), /selects unknown name/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Worker selections default to deny, intersect MCP and reject wildcards, unknowns, duplicates and mutations", () => {
  const tools = [{ name: "safe", annotations: { readOnlyHint: true } }, { name: "secret", annotations: { readOnlyHint: true } }, { name: "write" }];
  const config = (selection = "", operations = "all") => parseConfig(`${header}mcp:\n  description: MCP.\n  operations: ${operations}\n  events: all\n${selection}`);
  assert.deepEqual(resolveWorkerExposure(config(), tools), { operations: [], events: [] });
  assert.deepEqual(resolveWorkerExposure(config("  workerOperations: [safe]\n"), tools), { operations: ["safe"], events: [] });
  assert.deepEqual(resolveWorkerExposure(config("  workerOperations: [safe]\n", "[secret]"), tools), { operations: [], events: [] });
  for (const selection of ["all", "'*'", "{exclude: [secret]}"]) assert.throws(() => config(`  workerOperations: ${selection}\n`));
  for (const selection of ["[missing]", "[safe, safe]", "[write]"]) assert.throws(() => resolveWorkerExposure(config(`  workerOperations: ${selection}\n`), tools), /unknown|duplicate|non-read-only/);
});
