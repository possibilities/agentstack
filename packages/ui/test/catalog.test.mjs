import assert from "node:assert/strict";
import test from "node:test";
import { fieldsOf, findOperation, loadCatalog } from "../lib/stack/catalog.ts";

const brain = {
  name: "brain", description: "Isolated research storage", packageName: "@stack/brain",
  events: { changed: "Read research state again." }, eventScope: null,
  transports: [{ type: "websocket", description: "Research discovery", supported: true, subscriptions: true, endpoint: "ws://127.0.0.1:8744/websocket", operations: ["search"], events: ["changed"], routes: [] }],
  operations: [{ name: "search", description: "Search research", annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: { type: "object", properties: { hits: { type: "array", items: { type: "object", properties: {
      document_id: { type: "integer", description: "Research document identity." },
    } } } } },
  }],
};

test("the canvas catalog retains a newly discovered Package API's operations, schemas, events and transports", async () => {
  const reads = [];
  const catalog = await loadCatalog(async (name) => {
    reads.push(name);
    assert.equal(name, "docs_snapshot");
    return { packages: [brain] };
  });
  assert.deepEqual(reads, ["docs_snapshot"]);
  assert.deepEqual(catalog, [brain]);
  const search = findOperation(catalog, "brain", "search");
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal(fieldsOf(search.outputSchema)[0].children[0].description, "Research document identity.");
});

test("legacy catalog discovery also retains newly discovered Package APIs", async () => {
  const reads = [];
  const catalog = await loadCatalog(async (name, args) => {
    reads.push([name, args]);
    if (name === "docs_snapshot") throw new Error("older discovery API");
    if (name === "docs_list") return { packages: [{ name: "brain" }] };
    assert.equal(name, "docs_get");
    assert.deepEqual(args, { package: "brain" });
    return brain;
  });
  assert.deepEqual(reads.map(([name]) => name), ["docs_snapshot", "docs_list", "docs_get"]);
  assert.deepEqual(catalog, [brain]);
});

test("incompatible transport metadata becomes a read error rather than a render crash", async () => {
  const old = { ...brain, transports: [{ type: "websocket", endpoint: "ws://localhost:1" }] };
  await assert.rejects(loadCatalog(async (name) => name === "docs_snapshot" ? { packages: [old] }
    : name === "docs_list" ? { packages: [{ name: "brain" }] } : old), /Incompatible API catalog/);
});

test("MCP discovery requires an explicit effective Worker selection and preserves it", async () => {
  const doc = { ...brain, transports: [{ ...brain.transports[0], type: "mcp", workerOperations: ["search"] }] };
  assert.deepEqual(await loadCatalog(async () => ({ packages: [doc] })), [doc]);
  for (const value of [undefined, "all", ["unknown"]]) {
    const invalid = { ...doc, transports: [{ ...doc.transports[0], workerOperations: value }] };
    await assert.rejects(loadCatalog(async name => name === "docs_snapshot" ? { packages: [invalid] }
      : name === "docs_list" ? { packages: [{ name: "brain" }] } : invalid), /Incompatible API catalog/);
  }
});
