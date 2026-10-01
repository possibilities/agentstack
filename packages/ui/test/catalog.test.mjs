import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { docsSnapshot } from "@stack/api";
import { root } from "./browser-fixture.mjs";
import { fieldsOf, findOperation, loadCatalog, standaloneCapability } from "../lib/stack/catalog.ts";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { admissionWatchReference } = await import("../lib/stack/reference.ts");

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

test("standalone reference capability never infers callability from read-only hints or missing metadata", () => {
  const operation = brain.operations[0];
  const doc = { ...brain, transports: [{ ...brain.transports[0], type: "mcp" }] };
  for (const [standalone, expected] of [[true, "standalone"], [false, "service"], [undefined, "unknown"], ["true", "unknown"]]) {
    assert.equal(standaloneCapability({ ...operation, standalone }, doc), expected);
  }
  assert.equal(standaloneCapability({ ...operation, standalone: true }, brain), null, "WebSocket selection does not imply stdio exposure");
  assert.equal(standaloneCapability({ ...operation, standalone: true }, { ...doc, transports: [{ ...doc.transports[0], operations: [] }] }), null);
});

test("watch reference templates preserve exact admission/read identities and independent MCP exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode/stack-reference-"));
  try {
    // Installed declarations and actual manifest selections, without creating any owner contexts.
    const { packages } = await docsSnapshot.call({ root, env: { STACK_STATE_DIR: directory } }, {});
    const uuid = "<replace: new UUID>";
    const chatRead = { requestId: uuid, botId: "<replace: invoking botId>", threadId: "<replace: invoking threadId>" };
    for (const [pkg, name, readName, readArguments, scope] of [
      ["notify", "notification_send", "notification_get", { id: uuid }, null],
      ["browse", "browser_handoff_request", "browser_handoff_completion", chatRead, null],
      ["worker", "worker_start", "worker_turn_observation", chatRead, `request:${uuid}`],
      ["worker", "worker_send", "worker_turn_observation", chatRead, `request:${uuid}`],
      ["proc", "proc_run_start", "proc_run_completion", { id: uuid }, uuid],
      ["brain", "submit", "submission_completion", chatRead, null],
      ["brain", "sources_sync", "sources_sync_completion", chatRead, null],
    ]) {
      const doc = packages.find((doc) => doc.name === pkg);
      const operation = doc.operations.find((operation) => operation.name === name);
      const reference = admissionWatchReference(operation, doc);
      assert.deepEqual(reference.exposure, { admission: true, read: true, topic: true }, name);
      assert.equal(reference.scope, scope, name);
      assert.equal(reference.admissionExample.method, "tools/call");
      assert.equal(reference.admissionExample.params.name, name);
      assert.equal(reference.admissionExample.params.arguments[operation.completionWatch.idArgument], uuid);
      assert.ok(!Object.hasOwn(reference.admissionExample.params.arguments, "subscribe"), "omission uses the declared default, never opts in");
      assert.deepEqual(reference.readExample.params, { name: readName, arguments: readArguments }, name);
      const mcp = doc.transports.find((transport) => transport.type === "mcp");
      const changed = (selection) => ({ ...doc, transports: [{ ...mcp, ...selection }] });
      assert.deepEqual(admissionWatchReference(operation, changed({ events: [] })).exposure, { admission: true, read: true, topic: false }, "read existence never implies event exposure");
      const noRead = admissionWatchReference(operation, changed({ operations: [name] }));
      assert.equal(noRead.exposure.read, false);
      assert.equal(noRead.readExample, null);
      const noAdmission = admissionWatchReference(operation, changed({ operations: [readName] }));
      assert.equal(noAdmission.exposure.admission, false);
      assert.equal(noAdmission.admissionExample, null);
    }
    const brainDoc = packages.find((doc) => doc.name === "brain");
    const search = brainDoc.operations.find((operation) => operation.name === "search");
    assert.equal(standaloneCapability(search, brainDoc), "standalone");
    assert.equal(admissionWatchReference(search, brainDoc), null);
    const workerDoc = packages.find((doc) => doc.name === "worker");
    assert.equal(standaloneCapability(workerDoc.operations.find((operation) => operation.name === "worker_runtime_list"), workerDoc), "service", "a live read-only operation remains service-dependent");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
