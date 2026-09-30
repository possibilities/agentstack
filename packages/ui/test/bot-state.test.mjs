import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

// Load the pure stack modules directly without a Next build. Their
// bundler-style imports need extensions when loaded by Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { absentStore, botBlockers, botStateKey, botStateOperations, coveredBy, decodeChunk, firstPage, nextPage, purgeable, quarantined, toggleSelection, workspaceOwned } = await import("../lib/stack/bot-state.ts");

const b64 = (text) => Buffer.from(text).toString("base64");
const entry = (category, extra = {}) => ({ id: `bot:alpha:${category}`, ownerPackage: "bots", subject: { kind: "bot", id: "alpha" }, kind: "workspace", authority: "authoritative",
  location: "server", ownership: "stack", revision: "r", observedAt: "2026-09-30T00:00:00.000Z", coverage: "partial", items: null, bytes: null, sensitivity: "content",
  relationships: [], reads: [], actions: [], retention: "", regeneration: "", issues: [], ...extra });

test("each Bot action applies through its own operation with the Bot identity", async () => {
  const calls = [];
  const ops = botStateOperations(async (pkg, name, args) => { calls.push([pkg, name, args]); return name === "bot_state_receipt_get" ? { receipt: null } : {}; },
    "alpha", { kind: "upload_remove", uploadId: "u-1" });
  await ops.prepare();
  await ops.apply({ planId: "p", expectedRevision: "r", requestId: "q", botId: "alpha" });
  assert.equal(await ops.readReceipt("q"), null);
  assert.deepEqual(calls, [["bots", "bot_state_plan", { botId: "alpha", action: { kind: "upload_remove", uploadId: "u-1" } }],
    ["bots", "bot_upload_remove", { planId: "p", expectedRevision: "r", requestId: "q", botId: "alpha" }], ["bots", "bot_state_receipt_get", { requestId: "q" }]]);
});

test("recovery slots belong to one incarnation and one decision", () => {
  const reset = { kind: "session_reset", history: "retain" };
  assert.notEqual(botStateKey("inc-1", reset), botStateKey("inc-2", reset), "a reused Bot ID never recovers another incarnation's request");
  assert.notEqual(botStateKey("inc-1", { kind: "workspace_clear", selection: { all: true } }), botStateKey("inc-1", { kind: "workspace_clear", selection: { paths: ["a"] } }));
  assert.notEqual(botStateKey("inc-1", { kind: "history_clear", generation: "g1" }), botStateKey("inc-1", { kind: "history_clear", generation: "g2" }));
  assert.equal(botStateKey("inc-1", { kind: "session_reset", history: "purge" }), botStateKey("inc-1", reset), "one reset decision per incarnation, whichever history choice");
});

test("paging restarts on a changed listing and propagates other failures", async () => {
  let revision = "a";
  const read = async (offset, pinned) => {
    if (pinned && pinned !== revision) throw new Error("directory revision changed; restart paging");
    return { items: [`${revision}${offset}`], revision, nextOffset: offset === 0 ? 1 : null };
  };
  const first = await firstPage(read);
  assert.deepEqual((await nextPage(read, first)).items, ["a0", "a1"]);
  revision = "b";
  const restarted = await nextPage(read, first);
  assert.deepEqual([restarted.items, restarted.restarted], [["b0"], true]);
  await assert.rejects(nextPage(async () => { throw new Error("bots WebSocket is not connected"); }, first), /not connected/);
  assert.equal(absentStore({ revision: "absent" }), true);
});

test("file chunks decode to plain text or binary metadata, never markup", () => {
  assert.deepEqual(decodeChunk({ data: b64("hello\nworld") }), { kind: "text", text: "hello\nworld" });
  assert.deepEqual(decodeChunk({ data: b64("<script>window.x=1</script>") }), { kind: "text", text: "<script>window.x=1</script>" });
  assert.deepEqual(decodeChunk({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString("base64") }), { kind: "binary" });
  assert.deepEqual(decodeChunk({ data: Buffer.from([0xff, 0xfe, 0x41]).toString("base64") }), { kind: "binary" });
  const split = Buffer.from("é", "utf8").subarray(0, 1);
  assert.equal(decodeChunk({ data: Buffer.concat([Buffer.from("ab"), split]).toString("base64") }).kind, "text", "a chunk boundary inside a character is not binary");
});

test("selections never overlap and partial cleanup quarantine is recognized", () => {
  assert.deepEqual(toggleSelection(["dir/a", "dir/b", "keep"], "dir"), ["dir", "keep"], "selecting a directory absorbs its selected children");
  assert.deepEqual(toggleSelection(["dir", "keep"], "dir"), ["keep"]);
  assert.equal(coveredBy(["dir"], "dir/a"), "dir");
  assert.equal(coveredBy(["dir"], "directory"), null);
  assert.equal(quarantined({ path: ".stack-clear-6f1c2e0a-8f5b-4c52-9a1e-0b7c3d2e1f40" }), true);
  assert.equal(quarantined({ path: "notes/.stack-clear-x" }), false);
});

test("ownership, blockers and purgeable generations come from the owner's read", () => {
  const read = (workspace, blockedBy) => ({ incarnation: "i", generation: "g", maintenanceRequestId: null,
    entries: [entry("workspace", workspace), entry("conversation", { actions: [{ package: "bots", operation: "bot_state_plan", arguments: {}, blockedBy }] })] });
  assert.equal(workspaceOwned(read({ ownership: "stack" }, [])), true);
  assert.equal(workspaceOwned(read({ ownership: "external", location: "external" }, [])), false);
  assert.deepEqual(botBlockers(read({}, ["worker dependencies unavailable; start or repair that owner before cleanup"])), ["worker dependencies unavailable; start or repair that owner before cleanup"]);
  const generation = { generation: "g", mainThreadId: null, active: false, ownership: "stack", createdAt: "", retiredAt: "2026-09-30T00:00:00.000Z", purgedAt: null };
  assert.equal(purgeable(generation), true);
  assert.equal(purgeable({ ...generation, active: true }), false);
  assert.equal(purgeable({ ...generation, ownership: "shared" }), false, "legacy shared history is never purged wholesale");
  assert.equal(purgeable({ ...generation, purgedAt: "2026-09-30T01:00:00.000Z" }), false);
});
