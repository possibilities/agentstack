import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { api } from "../api.js";
import { ProcStore } from "../src/store.js";
import { ProcService } from "../src/service.js";
import { scheduleRecord, systemBrainId, type ScheduleSpec } from "../src/schema.js";
import type { StatePlan, StateReceipt } from "@stack/api";

test("removed schedule redaction preserves authority and captured admissions, refuses active/Brain selections and survives retry/restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-proc-redaction-"));
  let store = new ProcStore(root), service = new ProcService(store, { STACK_STATE_DIR: root });
  const call = async <T>(name: string, input: object): Promise<T> => {
    const op = api.operations.find(op => op.name === name)!;
    return op.output.parse(await op.call({ service }, op.input.parse(input))) as T;
  };
  const plan = (ids: string[]) => call<StatePlan>("proc_history_plan", { kind: "schedule_definition", ids });
  const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
  const spec: ScheduleSpec = { label: "Retained purpose", action: { type: "process", process: { command: "/bin/echo", args: ["argv-secret"],
    cwd: "/private/secret", env: { SECRET: "env-secret" }, timeoutMs: 1000, retainOutput: true } }, firstAt: new Date(Date.now() - 1000).toISOString(), everyMs: null, enabled: true };
  try {
    const id = randomUUID(), sibling = randomUUID(), apiId = randomUUID();
    store.createSchedule(id, spec); store.createSchedule(sibling, { ...spec, enabled: false });
    store.createSchedule(apiId, { ...spec, action: { type: "api", package: "fixture", operation: "effect", input: { secret: "action-secret" } } });
    const active = await plan([id]); assert.ok(active.blockedBy.length);
    await assert.rejects(call("proc_history_clear", apply(active)), /active/);
    const admitted = store.admit(store.getSchedule(id))!;
    store.finishExecution(admitted.executionId, "unknown", { secret: "result-secret" });
    store.removeSchedule(id, 1); store.removeSchedule(apiId, 1);
    await assert.rejects(call("proc_history_clear", apply(active)), /changed/);
    store.ensureSystemSchedule(systemBrainId, { ...spec, everyMs: 300_000, action: { type: "api", package: "brain", operation: "sources_sync", input: { due: true } } });
    await assert.rejects(plan([id, systemBrainId]), /Protected Brain/);
    const stale = await plan([id]), selected = await plan([id, apiId]), input = apply(selected);
    let notices = 0; service.onSchedulesChanged = () => notices++;
    const receipt = await call<StateReceipt>("proc_history_clear", input);
    assert.equal(receipt.status, "completed"); assert.deepEqual(await call("proc_history_clear", input), receipt);
    await assert.rejects(call("proc_history_clear", apply(stale)), /changed/);
    assert.ok(notices >= 2);
    const cleared = scheduleRecord.parse(store.getSchedule(id, true));
    assert.ok(cleared.contentClearedAt); assert.match(cleared.specDigest!, /^[a-f0-9]{64}$/); assert.equal(cleared.revision, 3);
    assert.equal(cleared.label, "Retained purpose"); assert.deepEqual(cleared.authority, { kind: "operator" });
    assert.equal(cleared.action.type, "process");
    if (cleared.action.type === "process") { assert.deepEqual(cleared.action.process.args, []); assert.equal(cleared.action.process.env, undefined); assert.equal(cleared.action.process.cwd, undefined); }
    const apiSchedule = await call<{ action: { input: object } }>("proc_schedule_get", { id: apiId, includeRemoved: true });
    assert.deepEqual(apiSchedule.action.input, {});
    const listed = await call<{ schedules: Array<{ id: string; contentClearedAt?: string }> }>("proc_schedule_list", { includeRemoved: true });
    assert.ok(listed.schedules.find(row => row.id === id)!.contentClearedAt);
    assert.ok(JSON.stringify(store.getSchedule(sibling)).includes("argv-secret"), "active sibling is untouched");
    assert.ok(JSON.stringify(store.getExecution(admitted.executionId)).includes("argv-secret"), "captured execution is a separately retained copy");
    assert.equal(store.getExecution(admitted.executionId).state, "unknown");
    assert.throws(() => store.createSchedule(id, spec), /schedule_id_conflict/, "redaction never revives a removed identity");
    store.close(); store = new ProcStore(root); service = new ProcService(store, { STACK_STATE_DIR: root });
    assert.deepEqual(await call("proc_history_clear", input), receipt);
    const interrupted = await plan([apiId]), pending = apply(interrupted);
    store.maintenance.begin(pending, interrupted); store.close(); store = new ProcStore(root); service = new ProcService(store, { STACK_STATE_DIR: root });
    const revision = store.getSchedule(apiId, true).revision;
    assert.equal((await call<StateReceipt>("proc_history_clear", pending)).status, "unknown");
    assert.equal(store.getSchedule(apiId, true).revision, revision, "unknown admission cannot execute again");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
