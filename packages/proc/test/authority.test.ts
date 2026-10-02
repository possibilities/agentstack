import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { botInstance, invocationContext, McpEventSubscriptions, operation, serveSocket, socketCall, socketPath, type EventValue, type InvocationContext } from "@stack/api";
import { z } from "zod";
import { api } from "../api.js";
import { ProcService } from "../src/service.js";
import { ProcStore } from "../src/store.js";
import { brainAuthority, operator, systemBrainId, type Authority, type Schedule, type ScheduleSpec } from "../src/schema.js";

const spec = (operation = "effect"): ScheduleSpec => ({ label: null, action: { type: "api", package: "fixture", operation, input: {} },
  firstAt: new Date(Date.now() - 60_000).toISOString(), everyMs: null, enabled: true });
const processSpec = { command: process.execPath, args: ["-e", "console.log('owned-output')"], timeoutMs: 5_000, retainOutput: true };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settled(service: ProcService, id: string) {
  for (let i = 0; i < 200; i++) {
    const record = service.store.executions({ scheduleId: id, limit: 1 }).executions[0];
    if (record && record.state !== "running") return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("execution did not settle");
}

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "as-proc-auth-"));
  const env = { STACK_STATE_DIR: root };
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "packages", "fixture"), { recursive: true });
  const expose = (names: string[]) => writeFile(join(workspace, "packages", "fixture", "api.yaml"),
    `name: fixture\ndescription: Fixture.\nsocket:\n  description: Fixture.\nmcp:\n  description: Fixture.\n  operations: ${JSON.stringify(names)}\n  events: []\n`);
  await expose(["effect", "operator_only"]);
  const bots = ["a", "b"].map((id) => ({ id, state: "running", url: `unix:///fixture-${id}-launch-1`, mainThreadId: `root-${id}`, recoveryIssue: null }));
  let lineageGate: (() => Promise<void>) | undefined;
  let targetGate: (() => Promise<void>) | undefined;
  const seen: Array<InvocationContext | undefined> = [];
  let effects = 0;
  const botServer = await serveSocket({ info: { name: "bots", description: "Bots", transportDescription: "Fixture", path: socketPath("bots", env) }, context: {}, operations: [
    operation({ name: "bot_list", description: "List", input: z.object({}), output: z.any(), async call() { return { bots }; } }),
    operation({ name: "chat_thread_read", description: "Lineage", input: z.object({ botId: z.string(), threadId: z.string() }), output: z.any(),
      async call(_ctx, input) {
        await lineageGate?.();
        if (![`${input.botId}-child`, `root-${input.botId}`].includes(input.threadId)) throw new Error("outside sanctioned lineage");
        return { thread: { id: input.threadId } };
      } }),
  ] });
  const target = await serveSocket({ info: { name: "fixture", description: "Target", transportDescription: "Fixture", path: socketPath("fixture", env) }, context: {}, operations:
    ["effect", "operator_only", "socket_only"].map((name) => operation({ name, description: "Target", input: z.object({}), output: z.any(),
      async call(_ctx, _input, invocation) {
        seen.push(invocation);
        if (name === "operator_only" && (invocation?.botId || invocation?.workerId)) throw new Error("operator-only");
        effects++;
        await targetGate?.();
        return { effects };
      } })) });
  const context = { service: new ProcService(new ProcStore(join(root, "proc")), env, undefined, workspace) };
  const proc = await serveSocket({ info: { name: "proc", description: "Proc", transportDescription: "Fixture", path: socketPath("proc", env) }, context, operations: api.operations, events: api.events });
  const stopEvents = await api.events!.start(context, (topic, scope) => proc.publish!(topic, scope));
  const caller = (id = "a", threadId = `${id}-child`): InvocationContext => ({ transport: "mcp", botId: id,
    instance: botInstance(bots.find((bot) => bot.id === id)!.url), threadId, sessionId: "session" });
  const call = (name: string, args: object = {}, invocation?: InvocationContext) => socketCall(socketPath("proc", env), "tools/call", { name, arguments: args, invocation });
  const retry = (id: string) => context.service.store.db.prepare("UPDATE schedules SET retry_at=0 WHERE id=?").run(id);
  t.after(async () => { stopEvents?.(); await proc.close(); await context.service.close(); await target.close(); await botServer.close(); await rm(root, { recursive: true, force: true }); });
  return { root, env, workspace, context, bots, seen, expose, caller, call, retry, effects: () => effects,
    lineageGate: (gate?: () => Promise<void>) => { lineageGate = gate; }, targetGate: (gate?: () => Promise<void>) => { targetGate = gate; } };
}

test("Bot attribution, current MCP exposure, ownership and operator edits never promote schedule authority", async (t) => {
  const f = await fixture(t), id = randomUUID(), input = spec();
  const created = await f.call("proc_schedule_create", { id, ...input }, f.caller()) as Schedule;
  const authority = { kind: "bot", botId: "a", mainThreadId: "root-a", threadId: "a-child" };
  assert.deepEqual(created.authority, authority);
  assert.deepEqual(created.createdBy, authority);
  assert.deepEqual(created.lastEditedBy, authority);
  await assert.rejects(f.call("proc_schedule_create", { ...input, authority: operator }, f.caller()), /Unrecognized/);
  await assert.rejects(f.call("proc_schedule_create", { id, ...input }, f.caller("b")), /schedule_id_conflict/);
  await assert.rejects(f.call("proc_schedule_create", spec("socket_only"), f.caller()), /target_not_mcp_exposed/);
  await assert.rejects(f.call("proc_schedule_create", input, f.caller("a", "unrelated-root")), /bot_thread_unavailable/);
  await assert.rejects(f.call("proc_schedule_create", input, { ...f.caller(), instance: "stale" }), /bot_instance_changed/);
  await assert.rejects(f.call("proc_schedule_get", { id }, f.caller("b")), /not_owned/);
  await assert.rejects(f.call("proc_schedule_remove", { id, expectedRevision: 1 }, f.caller("b")), /not_owned/);
  assert.deepEqual(await f.call("proc_schedule_list", {}, f.caller("b")), { schedules: [] });
  await assert.rejects(f.call("proc_schedule_list", {}, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null,
    workerId: "worker", workerInstance: "runtime" }), /requires_operator_or_bot/);
  await assert.rejects(f.call("proc_schedule_update", { id, expectedRevision: 1, ...spec("socket_only") }), /target_not_mcp_exposed/);
  const updated = await f.call("proc_schedule_update", { id, expectedRevision: 1, ...input }) as Schedule;
  assert.deepEqual(updated.authority, authority);
  assert.deepEqual(updated.createdBy, authority);
  assert.deepEqual(updated.lastEditedBy, operator);
  await assert.rejects(f.call("proc_schedule_reauthorize", { id, expectedRevision: 2, ...input }), /reauthorization_refused/);
  await f.context.service.tick();
  const execution = await settled(f.context.service, id);
  assert.equal(execution.state, "completed");
  assert.deepEqual(execution.authority, authority);
  assert.deepEqual(execution.action, input.action);
  assert.deepEqual(f.seen[0], { transport: "proc", scheduleId: id, executionId: execution.id, authority,
    botId: "a", instance: f.caller().instance, threadId: "a-child", sessionId: null });
  await assert.rejects(f.call("proc_execution_get", { id: execution.id }, f.caller("b")), /not_owned/);
  await f.call("proc_schedule_remove", { id, expectedRevision: 2 }, f.caller());
  assert.equal((await f.call("proc_execution_list", { id }, f.caller()) as { executions: unknown[] }).executions.length, 1);
  await assert.rejects(f.call("proc_execution_list", { id }, f.caller("b")), /not_owned/);
  await assert.rejects(f.call("proc_schedule_create", { id, ...input }), /schedule_id_conflict/);
});

for (const initial of [true, false]) test(`opt-in Proc watches bind the originating Chat and ${initial ? "observe an initial exit" : "deliver a later exit"} without output`, { timeout: 15_000 }, async t => {
  const f = await fixture(t), requestId = randomUUID();
  const exitGate = join(f.root, "release-process");
  const watchedProcess = initial ? processSpec : { ...processSpec, args: ["-e",
    "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); console.log('owned-output'); } }, 10);", exitGate] };
  if (initial) f.lineageGate(async () => {
    // Keep preparation unchanged, but ensure the first completion read sees exit.
    if (f.context.service.store.hasRun(requestId)) assert.equal((await f.context.service.join(requestId, 5_000)).timedOut, false);
  });
  await mkdir(join(f.workspace, "packages", "proc"), { recursive: true });
  await writeFile(join(f.workspace, "packages", "proc", "api.yaml"), "name: proc\ndescription: Proc\nmcp:\n  description: Proc\n  operations: [proc_run_start, proc_run_completion]\n  events: [proc_runs_changed]\n");
  const deliveries: EventValue[] = [];
  const owner = new McpEventSubscriptions(f.env, async () => undefined, async (event, _signal, authorize, submitting) => { await authorize(); submitting?.(); deliveries.push(event); }, undefined, undefined, f.workspace);
  const capability = await serveSocket({ info: { name: "serve", description: "Capability", transportDescription: "Socket", path: socketPath("serve", f.env) }, context: {}, operations: [
    operation({ name: "serve_completion_check", description: "Verify reserved capability", input: z.strictObject({ id: z.uuid(), package: z.string(), operation: z.string(), recordId: z.uuid(), caller: invocationContext }), output: z.object({ verified: z.boolean() }),
      async call(_ctx, input) { await owner.verifyCompletion(input.id, input.package, input.operation, input.recordId, input.caller); return { verified: true }; } }),
  ] });
  try {
    const result = await owner.callAndWatch("proc", "proc_run_start", { requestId, process: watchedProcess, subscribe: true }, f.caller());
    const receipt = result.subscription as { id: string; state: string };
    assert.equal(result.id, requestId);
    assert.equal(receipt.state, initial ? "observed" : "pending");
    assert.equal(deliveries.length, 0, "initial observation must not generate a redundant wakeup");
    if (!initial) await writeFile(exitGate, "");
    await f.context.service.join(requestId, 5_000);
    const finalState = initial ? "observed" : "delivered";
    for (let n = 0; n < 300 && owner.status(f.caller(), receipt.id).completions[0]?.state !== finalState; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(owner.status(f.caller(), receipt.id).completions[0]?.state, finalState);
    assert.equal(deliveries.length, initial ? 0 : 1);
    if (!initial) assert.equal(deliveries[0]!.subscription.scope, requestId, "the exit watch stays bound to the exact run");
    const observation = (initial ? result.observation : deliveries[0]!.value) as { result: { id: string; exitCode: number } };
    assert.equal(observation.result.id, requestId);
    assert.equal(observation.result.exitCode, 0);
    assert.ok(!JSON.stringify(observation).includes("owned-output"), "output/argv must not enter the exit watch");
    await assert.rejects(f.call("proc_run_completion", { id: requestId }, f.caller("a", "root-a")), /another Chat/);
    const repeated = await owner.callAndWatch("proc", "proc_run_start", { requestId, process: watchedProcess, subscribe: true }, f.caller());
    assert.equal((repeated.subscription as { state: string }).state, finalState);
    assert.equal(deliveries.length, initial ? 0 : 1);
  } finally { await owner.close(); await capability.close(); }
});

test("stopped Bots hold admissions, then resume across Proc and Bot restarts using current instances and coalesced intervals", async (t) => {
  const f = await fixture(t), id = randomUUID();
  await f.call("proc_schedule_create", { id, ...spec(), everyMs: 60_000 }, f.caller());
  f.bots[0]!.state = "stopped";
  await f.context.service.tick();
  assert.equal(f.context.service.store.getSchedule(id).blockedReason, "bot_not_running");
  assert.equal(f.context.service.store.executions({ scheduleId: id, limit: 10 }).executions.length, 0);
  assert.ok(f.context.service.store.getSchedule(id).retryAt);
  await f.context.service.close();
  f.context.service = new ProcService(new ProcStore(join(f.root, "proc")), f.env, undefined, f.workspace);
  f.bots[0]!.state = "running";
  f.bots[0]!.url = "unix:///fixture-a-launch-2";
  await f.context.service.tick();
  assert.equal(f.effects(), 0, "bounded retry survives restart");
  f.retry(id);
  await f.context.service.tick();
  await settled(f.context.service, id);
  assert.equal(f.seen[0]?.instance, f.caller().instance);
  assert.equal(f.context.service.store.getSchedule(id).blockedReason, null);
  assert.ok(Date.parse(f.context.service.store.getSchedule(id).nextAt!) > Date.now());
  await f.context.service.tick();
  assert.equal(f.effects(), 1);
});

test("withdrawn exposure, replaced roots and removed Bots block dispatch without consuming the pending one-shot", async (t) => {
  const f = await fixture(t), id = randomUUID();
  await f.call("proc_schedule_create", { id, ...spec() }, f.caller());
  await f.expose([]);
  await f.context.service.tick();
  assert.equal(f.context.service.store.getSchedule(id).blockedReason, "target_not_mcp_exposed");
  assert.equal(f.effects(), 0);
  assert.equal(f.context.service.store.executions({ scheduleId: id, limit: 10 }).executions.length, 0);
  await f.expose(["effect"]);
  f.retry(id);
  f.bots[0]!.mainThreadId = "replacement-root";
  await f.context.service.tick();
  assert.equal(f.context.service.store.getSchedule(id).blockedReason, "bot_root_changed");
  assert.equal(f.context.service.store.getSchedule(id).retryAt, null);
  const other = randomUUID();
  await f.call("proc_schedule_create", { id: other, ...spec() }, f.caller("b"));
  f.bots.splice(1, 1);
  await f.context.service.tick();
  assert.equal(f.context.service.store.getSchedule(other).blockedReason, "bot_removed");
  assert.equal(f.context.service.store.getSchedule(other).retryAt, null);
  assert.equal(f.effects(), 0);
});

test("edits and deletion racing authorization cannot dispatch a stale definition", async (t) => {
  const f = await fixture(t), id = randomUUID(), input = spec();
  await f.call("proc_schedule_create", { id, ...input }, f.caller());
  const entered = deferred(), release = deferred();
  f.lineageGate(async () => { entered.resolve(); await release.promise; });
  const tick = f.context.service.tick();
  await entered.promise;
  await f.call("proc_schedule_update", { id, expectedRevision: 1, ...input, enabled: false });
  release.resolve();
  await tick;
  assert.equal(f.effects(), 0);
  assert.equal(f.context.service.store.executions({ scheduleId: id, limit: 10 }).executions.length, 0);
  f.lineageGate();
  await f.call("proc_schedule_update", { id, expectedRevision: 2, ...input });
  const entered2 = deferred(), release2 = deferred();
  f.lineageGate(async () => { entered2.resolve(); await release2.promise; });
  const tick2 = f.context.service.tick();
  await entered2.promise;
  await f.call("proc_schedule_remove", { id, expectedRevision: 3 });
  release2.resolve();
  await tick2;
  assert.equal(f.effects(), 0);
});

test("scheduled process output and direct idempotent runs remain bound to their creating Bot", async (t) => {
  const f = await fixture(t), id = randomUUID();
  await f.call("proc_schedule_create", { id, ...spec(), action: { type: "process", process: processSpec } }, f.caller());
  await f.context.service.tick();
  const execution = await settled(f.context.service, id);
  assert.equal(execution.state, "completed");
  const runId = execution.processId!;
  await assert.rejects(f.call("proc_run_read", { id: runId }, f.caller("b")), /not_owned/);
  await assert.rejects(f.call("proc_run_cancel", { id: runId }, f.caller("b")), /not_owned/);
  assert.deepEqual(await f.call("proc_run_list", {}, f.caller("b")), { runs: [], nextCursor: null });
  const page = await f.call("proc_run_read", { id: runId }, f.caller()) as { lines: Array<{ text: string }> };
  assert.equal(page.lines[0]?.text, "owned-output");
  const requestId = randomUUID();
  await f.call("proc_run_start", { requestId, process: processSpec }, f.caller());
  await assert.rejects(f.call("proc_run_start", { requestId, process: processSpec }, f.caller("b")), /run_id_conflict/);
});

test("targets receive Bot authority and retain their own operator-only checks", async (t) => {
  const f = await fixture(t), id = randomUUID();
  await f.call("proc_schedule_create", { id, ...spec("operator_only") }, f.caller());
  await f.context.service.tick();
  const denied = await settled(f.context.service, id);
  assert.equal(denied.state, "unknown", "unclassified downstream errors are not proof of a pre-effect refusal");
  assert.equal(f.effects(), 0);
  await f.context.service.tick();
  assert.equal(f.seen.length, 1, "no automatic replay of a dispatched one-shot");
  const operatorId = randomUUID();
  await f.call("proc_schedule_create", { id: operatorId, ...spec("operator_only") });
  await f.context.service.tick();
  assert.equal((await settled(f.context.service, operatorId)).state, "completed");
  assert.equal(f.effects(), 1);
  assert.equal(f.seen[1]?.transport, "proc");
  assert.equal(f.seen[1]?.botId, null);
});

test("shutdown drains in-flight authorization before closing the durable store", async (t) => {
  const f = await fixture(t), id = randomUUID();
  await f.call("proc_schedule_create", { id, ...spec() }, f.caller());
  const entered = deferred(), release = deferred();
  f.lineageGate(async () => { entered.resolve(); await release.promise; });
  const tick = f.context.service.tick();
  await entered.promise;
  const closing = f.context.service.close();
  release.resolve();
  await tick;
  await closing;
  f.context.service = new ProcService(new ProcStore(join(f.root, "proc")), f.env, undefined, f.workspace);
  assert.equal(f.effects(), 0);
  assert.equal(f.context.service.store.executions({ scheduleId: id, limit: 1 }).executions.length, 0);
});

test("pre-dispatch shutdown is a definite refusal, not a lost-response outcome", async (t) => {
  const f = await fixture(t), id = randomUUID();
  await f.call("proc_schedule_create", { id, ...spec() });
  f.context.service.onSchedulesChanged = () => f.context.service.prepareClose();
  await f.context.service.tick();
  assert.equal((await settled(f.context.service, id)).state, "refused");
  assert.equal(f.effects(), 0);
});

test("legacy reauthorization is explicit, operator-only, revision-fenced and validates the reviewed target", async (t) => {
  const f = await fixture(t), id = randomUUID(), input = spec();
  await f.call("proc_schedule_create", { id, ...input });
  f.context.service.store.db.prepare(`UPDATE schedules SET authority=NULL,created_by='{"kind":"legacy_unknown"}',
    next_at=NULL,blocked_reason='legacy_reauthorization_required' WHERE id=?`).run(id);
  await assert.rejects(f.call("proc_schedule_reauthorize", { id, expectedRevision: 1, ...input }, f.caller()), /not_owned/);
  await assert.rejects(f.call("proc_schedule_update", { id, expectedRevision: 1, ...input }), /legacy_reauthorization_required/);
  await assert.rejects(f.call("proc_schedule_reauthorize", { id, expectedRevision: 1, ...spec("missing") }), /target_operation_unavailable/);
  await assert.rejects(f.call("proc_schedule_reauthorize", { id, expectedRevision: 2, ...input }), /revision_conflict/);
  const result = await f.call("proc_schedule_reauthorize", { id, expectedRevision: 1, ...input }) as Schedule;
  assert.deepEqual(result.createdBy, { kind: "legacy_unknown" });
  assert.deepEqual(result.authority, operator);
  assert.equal(result.revision, 2);
  await f.context.service.tick();
  assert.equal((await settled(f.context.service, id)).state, "completed");
});

test("an admitted execution retains its captured action and authority across operator edits", async (t) => {
  const f = await fixture(t), id = randomUUID(), input = spec();
  await f.call("proc_schedule_create", { id, ...input }, f.caller());
  const entered = deferred(), release = deferred();
  f.targetGate(async () => { entered.resolve(); await release.promise; });
  await f.context.service.tick();
  await entered.promise;
  const current = f.context.service.store.executions({ scheduleId: id, limit: 1 }).executions[0]!;
  await f.call("proc_schedule_update", { id, expectedRevision: 1, ...spec("operator_only"), enabled: false });
  assert.deepEqual(f.context.service.store.getExecution(current.id).action, input.action);
  assert.deepEqual(f.context.service.store.getExecution(current.id).authority, current.authority);
  release.resolve();
  assert.equal((await settled(f.context.service, id)).state, "completed");
  assert.equal(f.effects(), 1);
});

test("v1 migration retains history, disables unattributed schedules, and requires explicit operator reauthorization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "as-proc-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "proc.sqlite"));
  db.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY,spec TEXT NOT NULL,revision INTEGER NOT NULL,system INTEGER NOT NULL DEFAULT 0,next_at INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE executions (id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL,process_id TEXT,result TEXT,error TEXT,started_at TEXT NOT NULL,finished_at TEXT,UNIQUE(schedule_id,due_at));
    CREATE TABLE runs (id TEXT PRIMARY KEY,execution_id TEXT,state TEXT NOT NULL,pid INTEGER,exit_code INTEGER,signal TEXT,error TEXT,request_hash TEXT NOT NULL,line_count INTEGER NOT NULL DEFAULT 0,output_bytes INTEGER NOT NULL DEFAULT 0,output_truncated INTEGER NOT NULL DEFAULT 0,retain_output INTEGER NOT NULL,started_at TEXT NOT NULL,finished_at TEXT);
    CREATE TABLE lines (run_id TEXT NOT NULL,seq INTEGER NOT NULL,stream TEXT NOT NULL,text TEXT NOT NULL,partial INTEGER NOT NULL,PRIMARY KEY(run_id,seq));
    PRAGMA user_version=1;`);
  const id = randomUUID(), executionId = randomUUID(), now = new Date().toISOString();
  const input = spec();
  const system = { ...input, everyMs: 300_000, action: { type: "api", package: "brain", operation: "sources_sync", input: { due: true } } };
  for (const [key, value, protectedRow] of [[id, input, 0], [systemBrainId, system, 1]] as const)
    db.prepare("INSERT INTO schedules VALUES (?,?,1,?,?,?,?)").run(key, JSON.stringify(value), protectedRow, Date.now() - 1000, now, now);
  db.prepare("INSERT INTO executions VALUES (?,?,?,'completed',NULL,?,NULL,?,?)").run(executionId, id, Date.now() - 2000, JSON.stringify({ preserved: true }), now, now);
  db.close();
  const store = new ProcStore(root);
  try {
    const migrated = store.getSchedule(id);
    assert.equal(migrated.enabled, false);
    assert.equal(migrated.nextAt, null);
    assert.equal(migrated.authority, null);
    assert.equal(migrated.blockedReason, "legacy_reauthorization_required");
    assert.deepEqual(migrated.createdBy, { kind: "legacy_unknown" });
    assert.deepEqual(store.getExecution(executionId).result, { preserved: true });
    assert.equal(store.getExecution(executionId).authority, null);
    assert.deepEqual(store.getSchedule(systemBrainId).authority, brainAuthority);
    assert.equal(store.pending().length, 1);
    assert.throws(() => store.updateSchedule(id, migrated.revision, input), /legacy_reauthorization_required/);
    const restored = store.updateSchedule(id, migrated.revision, input, operator, true);
    assert.deepEqual(restored.createdBy, { kind: "legacy_unknown" });
    assert.deepEqual(restored.lastEditedBy, operator);
    assert.deepEqual(restored.authority, operator);
    assert.equal(restored.blockedReason, null);
    assert.equal(store.pending().length, 2);
    assert.throws(() => store.updateSchedule(id, restored.revision, input, operator, true), /reauthorization_refused/);
  } finally { store.close(); }
  const reopened = new ProcStore(root);
  try { assert.deepEqual(reopened.getSchedule(id).authority, operator); assert.equal(reopened.getSchedule(id).enabled, true); }
  finally { reopened.close(); }
});

test("cross-schedule execution pages filter Bot ownership in SQL before the limit and hide unattributed history", async (t) => {
  const f = await fixture(t);
  const db = f.context.service.store.db;
  const botA: Authority = { kind: "bot", botId: "a", mainThreadId: "root-a", threadId: "a-child" };
  const botB: Authority = { kind: "bot", botId: "b", mainThreadId: "root-b", threadId: "b-child" };
  const base = Date.now() - 60_000;
  const stamp = (i: number) => new Date(base + i * 10_000).toISOString();
  // Newest first: unattributed legacy, operator, b, a, b, a.
  const authorities: Array<Authority | null> = [null, operator, botB, botA, botB, botA];
  const ids = authorities.map((_, i) => randomUUID());
  for (const [i, authority] of authorities.entries())
    db.prepare("INSERT INTO executions (id,schedule_id,due_at,state,started_at,authority) VALUES (?,?,?,'completed',?,?)")
      .run(ids[i], randomUUID(), base, stamp(authorities.length - 1 - i), authority === null ? null : JSON.stringify(authority));
  const list = (args: object, invocation?: InvocationContext) =>
    f.call("proc_execution_list", args, invocation) as Promise<{ executions: Array<{ id: string }>; nextCursor: string | null }>;
  const operatorPage = await list({ limit: 3 });
  assert.deepEqual(operatorPage.executions.map((row) => row.id), [ids[0], ids[1], ids[2]]);
  assert.ok(operatorPage.nextCursor);
  const botPage = await list({ limit: 3 }, f.caller());
  assert.deepEqual(botPage.executions.map((row) => row.id), [ids[3], ids[5]],
    "the Bot's two rows are interleaved with others; filtering after LIMIT would drop one");
  assert.equal(botPage.nextCursor, null);
  const first = await list({ limit: 1 }, f.caller());
  assert.equal(first.executions[0]!.id, ids[3]);
  const rest = await list({ limit: 1, cursor: first.nextCursor! }, f.caller());
  assert.deepEqual(rest.executions.map((row) => row.id), [ids[5]]);
  assert.equal(rest.nextCursor, null);
  await assert.rejects(list({ cursor: "junk" }, f.caller()), /invalid_cursor/);
  await assert.rejects(list({}, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null,
    workerId: "worker", workerInstance: "runtime" }), /requires_operator_or_bot/);
});

test("run pages filter Bot ownership in SQL before the limit and expose state filters, labels and paths", async (t) => {
  const f = await fixture(t);
  const store = f.context.service.store;
  const botA: Authority = { kind: "bot", botId: "a", mainThreadId: "root-a", threadId: "a-child" };
  const botB: Authority = { kind: "bot", botId: "b", mainThreadId: "root-b", threadId: "b-child" };
  const proc = { command: "/bin/echo", args: ["hi"], env: { SECRET: "s3cr3t" }, timeoutMs: 1_000, retainOutput: true };
  const base = Date.now() - 60_000;
  const stamp = (i: number) => new Date(base + i * 10_000).toISOString();
  const a1 = store.startRun(proc, null, randomUUID(), botA, "a1").record;
  const b1 = store.startRun(proc, null, randomUUID(), botB, "b1").record;
  const a2 = store.startRun(proc, null, randomUUID(), botA, "a2").record;
  const op = store.startRun(proc, null, randomUUID(), operator, "op").record;
  // Newest first: a1, b1, a2, op.
  for (const [id, i] of [[a1.id, 3], [b1.id, 2], [a2.id, 1], [op.id, 0]] as const)
    store.db.prepare("UPDATE runs SET started_at=? WHERE id=?").run(stamp(i), id);
  store.db.prepare("UPDATE runs SET state='exited' WHERE id=?").run(a2.id);
  store.db.prepare("UPDATE runs SET state='exited' WHERE id=?").run(op.id);
  const list = (args: object, invocation?: InvocationContext) =>
    f.call("proc_run_list", args, invocation) as Promise<{ runs: Array<{ id: string; label: string | null; command: string | null; state: string }>; nextCursor: string | null }>;
  const all = await list({ limit: 3 });
  assert.deepEqual(all.runs.map((row) => row.id), [a1.id, b1.id, a2.id]);
  assert.ok(all.nextCursor);
  const tail = await list({ limit: 3, cursor: all.nextCursor! });
  assert.deepEqual(tail.runs.map((row) => row.id), [op.id]);
  assert.equal(tail.nextCursor, null);
  const bot = await list({ limit: 3 }, f.caller());
  assert.deepEqual(bot.runs.map((row) => row.id), [a1.id, a2.id],
    "operator and other-Bot rows must not consume the Bot's page limit");
  assert.equal(bot.nextCursor, null);
  assert.equal(bot.runs[0]!.label, "a1");
  assert.equal(bot.runs[0]!.command, "/bin/echo");
  for (const run of bot.runs) assert.ok(!("process" in run) && !("env" in run) && !("envKeys" in run));
  const active = await list({ state: "active" });
  assert.deepEqual(active.runs.map((row) => row.id).sort(), [a1.id, b1.id].sort());
  const terminal = await list({ state: "terminal" }, f.caller());
  assert.deepEqual(terminal.runs.map((row) => row.id), [a2.id]);
});

test("proc_status scopes schedule counts to the caller's root while capacities stay shared", async (t) => {
  const f = await fixture(t);
  await f.call("proc_schedule_create", { id: randomUUID(), ...spec() }, f.caller());
  await f.call("proc_schedule_create", { id: randomUUID(), ...spec() }, f.caller("b"));
  const status = (invocation?: InvocationContext) => f.call("proc_status", {}, invocation) as Promise<{
    running: number; capacity: number; inFlightCalls: number; callCapacity: number;
    schedules: { total: number; enabled: number; held: number; blocked: number; legacy: number; removed: number };
    lastSweepAt: string | null; lastPruneAt: string | null; closing: boolean }>;
  const operatorView = await status();
  assert.equal(operatorView.schedules.total, 2);
  assert.equal(operatorView.schedules.enabled, 2);
  assert.equal(operatorView.lastSweepAt, null, "no sweep before the first tick");
  const aView = await status(f.caller());
  assert.deepEqual(aView.schedules, { total: 1, enabled: 1, held: 0, blocked: 0, legacy: 0, removed: 0 });
  assert.equal((await status(f.caller("b"))).schedules.total, 1);
  assert.equal(aView.capacity, operatorView.capacity);
  assert.equal(aView.inFlightCalls, operatorView.inFlightCalls);
  await f.context.service.tick();
  assert.ok((await status()).lastSweepAt !== null);
  await assert.rejects(status({ transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null,
    workerId: "worker", workerInstance: "runtime" }), /requires_operator_or_bot/);
});
