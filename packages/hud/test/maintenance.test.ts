import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { operation, serveApi, serveSocket, socketCall, socketPath, type StatePlan, type StateReceipt } from "@stack/api";
import { HudStore } from "../src/store.js";
import type { WorkAdmission } from "../src/client.js";
import type { Activity, WorkItem } from "../src/schema.js";

test("HUD maintenance redacts exact bodies, fences descendants/focus/revisions and preserves shared semantic Work and retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-hud-maintenance-")), env = { ...process.env, STACK_STATE_DIR: root };
  const parent = randomUUID(), child = randomUUID(), sibling = randomUUID(), workerId = randomUUID(), turnId = randomUUID();
  let associations: WorkAdmission[] = [], workerUnavailable = false, mainThreadId = "root";
  const worker = await serveSocket({ info: { name: "worker", description: "Fixture", transportDescription: "Socket", path: socketPath("worker", env) }, context: {},
    operations: [operation({ name: "worker_work_list", description: "Captured admission observations", input: z.object({ workItemId: z.string() }), output: z.any(),
      async call(_ctx, { workItemId }) { if (workerUnavailable) throw new Error("unavailable"); return { entries: associations.filter(entry => entry.context.workItemId === workItemId), nextCursor: null }; } })] });
  const bots = await serveSocket({ info: { name: "bots", description: "Fixture", transportDescription: "Socket", path: socketPath("bots", env) }, context: {},
    operations: [operation({ name: "bot_list", description: "Root identities", input: z.object({}), output: z.any(), async call() { return { bots: [{ id: "bot-1", mainThreadId }] }; } }),
      operation({ name: "chat_records", description: "Sanctioned Chat", input: z.object({}), output: z.any(), async call() { return {}; } })] });
  let hud = await serveApi({ name: "hud", transport: "socket", env });
  const call = <T>(name: string, args: object) => socketCall(hud.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  const plan = (items: string[], scope = "journal_bodies") => call<StatePlan>("hud_history_plan", { items, scope });
  const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
  try {
    await call("work_batch", { requestId: randomUUID(), changes: [
      { action: "create", id: parent, title: "Parent secret", objective: "Original secret", state: "active" },
      { action: "create", id: child, parentId: parent, title: "Child secret", objective: "Child scope", state: "planned" },
      { action: "create", id: sibling, title: "Sibling", objective: "Keep sibling" },
    ] });
    await call("work_metadata_set", { requestId: randomUUID(), id: parent, expectedRevision: 1, namespace: "coordination", value: { secret: "Current metadata" } });
    await call("work_note_add", { requestId: randomUUID(), id: parent, expectedRevision: 2, kind: "handoff", body: "Journal secret", references: [{ kind: "url", url: "https://example.com/secret" }] });
    const stale = await plan([parent]);
    await call("work_update", { requestId: randomUUID(), id: parent, expectedRevision: 3, patch: { objective: "New secret" } });
    await assert.rejects(call("hud_history_clear", apply(stale)), /HUD state changed/);
    workerUnavailable = true; const unavailable = await plan([parent]); assert.ok(unavailable.blockedBy.some(reason => reason.includes("unavailable")));
    await assert.rejects(call("hud_history_clear", apply(unavailable)), /unavailable/); workerUnavailable = false;
    associations = [{ sequence: 1, workerId, turnId, context: { workItemId: child, scopeRevision: 1, source: "explicit" }, botId: "bot-1", threadId: "root", accountId: randomUUID(),
      provider: "codex", model: null, effort: null, workerPhase: "running", turnPhase: "running", current: true, createdAt: 1, updatedAt: 1 }];
    const blocked = await plan([parent]); assert.ok(blocked.resources.some(resource => resource.includes(turnId)));
    await assert.rejects(call("hud_history_clear", apply(blocked)), /Close Worker/);
    associations[0] = { ...associations[0]!, workerPhase: "closed", turnPhase: "unknown" };
    const target = { botId: "bot-1", mainThreadId: "root", threadId: "root" };
    await call("work_focus_set", { requestId: randomUUID(), target, workItemId: parent, expectedRevision: 0 });
    const focused = await plan([parent]); await assert.rejects(call("hud_history_clear", apply(focused)), /Chat focus/);
    mainThreadId = "replacement"; // Retired-root focus remains, but no longer authorizes admission.
    const journalPlan = await plan([parent]), request = apply(journalPlan);
    const beforeTree = await call<{ snapshot: number }>("work_tree", {});
    const result = await call<StateReceipt>("hud_history_clear", request);
    assert.equal(result.status, "completed"); assert.deepEqual(await call("hud_history_clear", request), result);
    const item = await call<WorkItem>("work_get", { id: parent });
    assert.equal(item.objective, "New secret"); assert.equal(item.state, "active"); assert.equal(item.contentGeneration, 1);
    assert.equal(item.contentClearedAt, undefined);
    const activity = await call<{ entries: Activity[] }>("work_activity_list", { id: parent });
    assert.ok(activity.entries.every(entry => entry.contentClearedAt && entry.body === null && entry.references.length === 0));
    assert.ok(activity.entries.flatMap(entry => entry.changes).every(edit => edit.before === null && edit.after === null));
    await assert.rejects(call("work_tree", { offset: 1, snapshot: beforeTree.snapshot }), /snapshot_changed/);
    assert.equal((await call<WorkItem>("work_get", { id: child })).title, "Child secret");
    const children = await plan([parent], "item_and_journal"); await assert.rejects(call("hud_history_clear", apply(children)), /child/);
    const tombstone = await plan([parent, child], "item_and_journal"), clear = apply(tombstone);
    assert.equal((await call<StateReceipt>("hud_history_clear", clear)).status, "completed");
    const cleared = await call<WorkItem>("work_get", { id: parent }); assert.ok(cleared.contentClearedAt); assert.ok(cleared.contentDigest);
    assert.equal(cleared.title, "[cleared]"); assert.equal(cleared.state, "active");
    assert.equal((await call<WorkItem>("work_get", { id: child })).parentId, parent);
    assert.deepEqual((await call<{ namespaces: object }>("work_metadata_get", { id: parent })).namespaces, {});
    assert.equal((await call<WorkItem>("work_get", { id: sibling })).objective, "Keep sibling");
    assert.equal(associations[0]!.context.workItemId, child, "Worker-captured association remains independent");
    await assert.rejects(call("work_context_resolve", { workItemId: parent }), /work_content_cleared/);
    await assert.rejects(call("work_update", { requestId: randomUUID(), id: parent, expectedRevision: cleared.revision, patch: { title: "Restore" } }), /work_content_cleared/);
    await hud.close(); hud = await serveApi({ name: "hud", transport: "socket", env });
    assert.deepEqual(await call("hud_history_clear", request), result, "restart preserves receipt without re-redacting later state");
    assert.deepEqual((await call<{ receipt: StateReceipt }>("hud_state_receipt_get", { requestId: request.requestId })).receipt, result);
  } finally { await hud.close(); await bots.close(); await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("HUD interrupted maintenance admission becomes unknown after restart and cannot re-execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-hud-interrupted-"));
  let store = new HudStore(root);
  try {
    const id = randomUUID();
    store.apply(randomUUID(), [{ action: "create", id, title: "Retain", objective: "Unknown is not permission", state: "planned", summary: "", parentId: null,
      order: 0, priority: "normal", nextAction: "", attention: "none", dependencies: [], labels: [], links: [] }], { kind: "operator" });
    const deps = { revision: "observed", resources: [], blockedBy: [] }, plan = store.historyPlan({ items: [id], scope: "item_and_journal" }, deps);
    const input = { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() };
    store.maintenance.begin(input, plan); store.close(); store = new HudStore(root);
    assert.equal(store.historyClear(input, deps).status, "unknown"); assert.equal(store.get(id).title, "Retain");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
