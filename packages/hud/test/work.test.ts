import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall, socketSubscribe } from "@stack/api";
import type { Activity, Receipt, WorkItem } from "../src/schema.js";
import type { workTree } from "../api.js";

test("shared work is atomic, revision-safe, recoverable, and keeps metadata out of human projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-hud-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  let server = await serveApi({ name: "hud", transport: "socket", env });
  const call = <T = Receipt>(name: string, args: object): Promise<T> => socketCall(server.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  const parent = randomUUID(), child = randomUUID(), dependency = randomUUID();
  const create = { requestId: randomUUID(), changes: [
    { action: "create", id: parent, title: "Ship HUD", objective: "A shared collaboration surface", state: "active", labels: ["stack"], nextAction: "Build the API" },
    { action: "create", id: child, parentId: parent, title: "Contract", objective: "A durable native API", state: "active" },
    { action: "create", id: dependency, title: "Review", objective: "Independent contract review" },
  ] };
  try {
    const receipt = await call("work_batch", create);
    assert.equal(receipt.items.length, 3);
    assert.equal((await call("work_batch", create)).duplicate, true);
    await assert.rejects(call("work_batch", { ...create, changes: create.changes.slice(0, 1) }), /work_request_conflict/);
    const observations: string[] = [];
    const subscription = await socketSubscribe(server.socketPath!, ["work_changed"], topic => observations.push(topic), { scope: parent });
    try {
      await call("work_update", { requestId: randomUUID(), id: child, expectedRevision: 1, patch: { summary: "Schema ready" } });
      assert.equal((await call<WorkItem>("work_get", { id: child })).state, "active", "a partial patch cannot apply creation defaults");
      // Use a subsequent round trip to let the payload-free notice reach its socket client.
      await call("work_get", { id: parent });
      assert.ok(observations.includes("work_changed"), "derived ancestors invalidate after a child edit");
    } finally { await subscription.close(); }

    const invalid = { requestId: randomUUID(), changes: [
      { action: "metadata", id: parent, expectedRevision: 1, namespace: "agent.routing", value: { marker: "MUST_ROLL_BACK" } },
      { action: "update", id: child, expectedRevision: 2, patch: { dependencies: [parent] } },
    ] };
    await assert.rejects(call("work_batch", invalid), /work_cycle/);
    assert.equal((await call<WorkItem>("work_get", { id: parent })).revision, 1);
    assert.deepEqual((await call<{ namespaces: object }>("work_metadata_get", { id: parent })).namespaces, {});

    const contenders = await Promise.allSettled(["Human edit", "Agent edit"].map(summary => call("work_update", {
      requestId: randomUUID(), id: child, expectedRevision: 2, patch: { summary },
    })));
    assert.equal(contenders.filter(result => result.status === "fulfilled").length, 1);
    assert.match(String((contenders.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /work_revision_conflict/);

    const metadataRequest = { requestId: randomUUID(), id: parent, expectedRevision: 1, namespace: "agent.routing",
      value: { correlation: "opaque-token", disabled: false, empty: "", unset: null, nested: { b: 2, a: 1 } } };
    await call("work_metadata_set", metadataRequest);
    assert.equal((await call<WorkItem>("work_get", { id: parent })).scopeRevision, 1);
    assert.deepEqual((await call<{ namespaces: object }>("work_metadata_get", { id: parent })).namespaces, { "agent.routing": metadataRequest.value });
    const correlated = await call<{ items: WorkItem[] }>("work_list", { correlation: { namespace: "agent.routing", key: "correlation", value: "opaque-token" } });
    assert.deepEqual(correlated.items.map(item => item.id), [parent]);
    for (const [name, args] of [["work_get", { id: parent }], ["work_list", {}], ["work_tree", {}], ["work_activity_list", {}]] as const)
      assert.ok(!JSON.stringify(await call(name, args)).includes("opaque-token"), `${name} leaked metadata`);

    const first = await call<Awaited<ReturnType<typeof workTree.call>>>("work_tree", { limit: 1 });
    assert.equal(first.rows[0]!.item.id, parent);
    assert.equal(first.rows[0]!.openDescendants, 1);
    const second = await call<Awaited<ReturnType<typeof workTree.call>>>("work_tree", { limit: 1, offset: first.nextOffset, snapshot: first.snapshot });
    assert.equal(second.rows[0]!.item.id, child);
    assert.equal(second.rows[0]!.depth, 1);
    await assert.rejects(call("work_tree", { offset: 1 }), /work_snapshot_required/);
    await call("work_update", { requestId: randomUUID(), id: child, expectedRevision: 3, patch: { dependencies: [dependency] } });
    await assert.rejects(call("work_tree", { offset: 1, snapshot: first.snapshot }), /work_snapshot_changed/);
    await assert.rejects(call("work_update", { requestId: randomUUID(), id: parent, expectedRevision: 2, patch: { state: "completed" } }), /work_not_ready/);
    await assert.rejects(call("work_update", { requestId: randomUUID(), id: child, expectedRevision: 4, patch: { state: "completed" } }), /work_not_ready/);

    await call("work_note_add", { requestId: randomUUID(), id: child, expectedRevision: 4, kind: "result", body: "Contract implemented", references: [] });
    assert.equal((await call<WorkItem>("work_get", { id: child })).state, "active", "a reported result does not complete work");
    await call("work_batch", { requestId: randomUUID(), changes: [
      { action: "update", id: parent, expectedRevision: 2, patch: { state: "completed", nextAction: "" } },
      { action: "update", id: child, expectedRevision: 5, patch: { state: "completed" } },
      { action: "update", id: dependency, expectedRevision: 1, patch: { state: "completed" } },
    ] });
    await assert.rejects(call("work_update", { requestId: randomUUID(), id: child, expectedRevision: 6, patch: { objective: "Changed objective" } }), /work_reopen_required/);
    await assert.rejects(call("work_update", { requestId: randomUUID(), id: child, expectedRevision: 6, patch: { state: "active" } }), /work_not_ready/);
    await call("work_batch", { requestId: randomUUID(), changes: [
      { action: "update", id: parent, expectedRevision: 3, patch: { state: "active" } },
      { action: "update", id: child, expectedRevision: 6, patch: { state: "active", objective: "UI-ready contract" } },
    ] });
    const changed = await call<WorkItem>("work_get", { id: child });
    assert.equal(changed.scopeRevision, 3);
    const history = await call<{ entries: Activity[] }>("work_activity_list", { id: child });
    assert.equal(history.entries.find(entry => entry.kind === "result")!.scopeRevision, 2);
    assert.deepEqual(history.entries.at(-1)!.changes.find(edit => edit.field === "objective"), { field: "objective", before: "A durable native API", after: "UI-ready contract" });
    const resources = await call<{ workers: unknown; observation: { state: string } }>("work_resources", { id: child });
    assert.equal(resources.observation.state, "unavailable");
    assert.equal(resources.workers, null, "unavailable runtime is not an empty resource inventory");

    await server.close();
    server = await serveApi({ name: "hud", transport: "socket", env });
    assert.deepEqual(await call<WorkItem>("work_get", { id: child }), changed);
    assert.equal((await call("work_metadata_set", { ...metadataRequest, value: { ...metadataRequest.value, nested: { a: 1, b: 2 } } })).duplicate, true);
    assert.equal((await call("work_batch", create)).duplicate, true, "recovery returns the original receipt after later edits");
    const added = randomUUID();
    await call("work_batch", { requestId: randomUUID(), changes: [
      { action: "create", id: added, title: "Draft", objective: "One transaction" },
      { action: "update", id: added, expectedRevision: 1, patch: { title: "Ready", parentId: parent } },
      { action: "metadata", id: added, expectedRevision: 2, namespace: "first", value: { keep: false } },
      { action: "metadata", id: added, expectedRevision: 3, namespace: "second", value: { remove: true } },
      { action: "metadata", id: added, expectedRevision: 4, namespace: "second", value: null },
    ] });
    assert.equal((await call<WorkItem>("work_get", { id: added })).revision, 5);
    assert.deepEqual((await call<{ namespaces: object }>("work_metadata_get", { id: added })).namespaces, { first: { keep: false } });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
