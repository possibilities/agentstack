import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operation, serveApi, serveSocket, socketCall, socketPath, socketSubscribe, type StatePlan, type StateReceipt } from "@stack/api";
import { z } from "zod";
import { ProcStore } from "../src/store.js";
import { ProcService } from "../src/service.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "stack-proc-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const proc = await serveApi({ name: "proc", transport: "socket", env });
  t.after(async () => { await proc.close(); await rm(root, { recursive: true, force: true }); });
  const call = (name: string, args: object = {}) => socketCall(socketPath("proc", env), "tools/call", { name, arguments: args });
  return { root, env, call };
}
async function until<T>(fn: () => Promise<T>, ready: (value: T) => boolean, timeout = 5_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (ready(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("observation timed out");
}

test("argv process emits cursor-readable lines and exit, reuses a request ID, and supports non-retention", { timeout: 15_000 }, async (t) => {
  const { env, call } = await fixture(t);
  let notices = 0;
  const subscription = await socketSubscribe(socketPath("proc", env), ["proc_output_changed", "proc_runs_changed"], () => notices++);
  t.after(() => subscription.close());
  const id = randomUUID();
  const spec = { command: process.execPath, args: ["-e", "process.stdout.write('one\\ntwo\\n');process.stderr.write('err\\n')"],
    timeoutMs: 5_000, retainOutput: true };
  assert.deepEqual(await call("proc_run_completion", { id }), { result: null });
  await assert.rejects(call("proc_run_start", { requestId: id, process: spec, subscribe: true }), /owner-coordinated/);
  assert.deepEqual(await call("proc_run_completion", { id }), { result: null }, "unsupported delivery must not admit a process");
  const started = await call("proc_run_start", { requestId: id, process: spec }) as { id: string };
  assert.equal(started.id, id);
  const joined = await socketCall(socketPath("proc", env), "tools/call", { name: "proc_run_join", arguments: { id, waitMs: 5_000 } }, { timeoutMs: 6_000 }) as { run: { state: string }; timedOut: boolean };
  assert.equal(joined.run.state, "exited");
  assert.equal(joined.timedOut, false);
  const completion = await call("proc_run_completion", { id }) as { result: Record<string, unknown> };
  assert.equal(completion.result.state, "exited"); assert.equal(completion.result.exitCode, 0);
  assert.deepEqual(Object.keys(completion.result).sort(), ["error", "exitCode", "finishedAt", "id", "signal", "startedAt", "state"], "exit projection must exclude command, output and environment");
  const { process: _process, ...detail } = await call("proc_run_get", { id }) as Record<string, unknown>;
  assert.deepEqual(await call("proc_run_start", { requestId: id, process: spec }), { ...detail, subscription: null, observation: null });
  await assert.rejects(call("proc_run_start", { requestId: id, process: { ...spec, args: ["different"] } }), /run_id_conflict/);
  const finished = await until(() => call("proc_run_get", { id }) as Promise<{ state: string; exitCode: number }>, (run) => run.state === "exited");
  assert.equal(finished.exitCode, 0);
  const page = await call("proc_run_read", { id, after: 0, limit: 10 }) as { lines: Array<{ seq: number; stream: string; text: string }>; done: boolean; gap: boolean };
  assert.deepEqual(page.lines.map(({ stream, text }) => [stream, text]).sort(), [["stderr", "err"], ["stdout", "one"], ["stdout", "two"]]);
  assert.deepEqual(page.lines.map(({ seq }) => seq), [1, 2, 3]);
  assert.equal(page.done, true);
  assert.equal(page.gap, false);
  assert.ok(notices >= 3);
  const second = randomUUID();
  await call("proc_run_start", { requestId: second, process: { ...spec, retainOutput: false } });
  await until(() => call("proc_run_get", { id: second }) as Promise<{ state: string }>, (run) => run.state === "exited");
  const lost = await call("proc_run_read", { id: second }) as { lines: unknown[]; gap: boolean };
  assert.deepEqual(lost.lines, []);
  assert.equal(lost.gap, true);
  const plan = await call("proc_history_plan", { kind: "run_output", ids: [id] }) as StatePlan;
  const clear = { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() };
  const receipt = await call("proc_history_clear", clear) as StateReceipt;
  assert.equal(receipt.status, "completed");
  assert.deepEqual(await call("proc_history_clear", clear), receipt);
  const cleared = await call("proc_run_read", { id, after: 0 }) as { lines: unknown[]; gap: boolean };
  assert.deepEqual(cleared.lines, []); assert.equal(cleared.gap, true);
  const repeated = await call("proc_run_start", { requestId: id, process: spec }) as { state: string; outputTruncated: boolean };
  assert.equal(repeated.state, "exited"); assert.equal(repeated.outputTruncated, true);
});

test("schedule calls an existing Package API, coalesces due intervals and preserves revisions and history", { timeout: 15_000 }, async (t) => {
  const { env, call } = await fixture(t);
  let effects = 0;
  const target = await serveSocket({ info: { name: "fixture", description: "fixture", transportDescription: "fixture", path: socketPath("fixture", env) },
    context: {}, operations: [operation({ name: "effect", description: "Increment", input: z.strictObject({ value: z.number() }),
      output: z.strictObject({ observed: z.number() }), async call(_ctx, input) { effects += input.value; return { observed: effects }; } })] });
  t.after(() => target.close());
  const id = randomUUID();
  const spec = { id, action: { type: "api", package: "fixture", operation: "effect", input: { value: 2 } },
    firstAt: new Date(Date.now() - 60_000).toISOString(), everyMs: 60_000, enabled: true };
  const created = await call("proc_schedule_create", spec) as { revision: number; nextAt: string };
  assert.equal(created.revision, 1);
  assert.deepEqual(await call("proc_schedule_create", spec), created);
  await assert.rejects(call("proc_schedule_create", { ...spec, everyMs: 1000 }), /schedule_id_conflict/);
  const complete = await until(() => call("proc_execution_list", { id }) as Promise<{ executions: Array<{ id: string; state: string; result: unknown }> }>,
    (page) => page.executions[0]?.state === "completed");
  assert.equal(effects, 2);
  assert.deepEqual(complete.executions[0]?.result, { observed: 2 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(effects, 2, "one old overdue tick must not cause a replay storm");
  const updated = await call("proc_schedule_update", { ...spec, expectedRevision: 1, firstAt: new Date(Date.now() + 3600_000).toISOString() }) as { revision: number };
  assert.equal(updated.revision, 2);
  await assert.rejects(call("proc_schedule_update", { ...spec, expectedRevision: 1 }), /revision_conflict/);
  assert.deepEqual(await call("proc_schedule_remove", { id, expectedRevision: 2 }), { removed: true });
  assert.equal((await call("proc_execution_list", { id }) as { executions: unknown[] }).executions.length, 1);
  await assert.rejects(call("proc_schedule_remove", { id: "00000000-0000-4000-8000-000000000001", expectedRevision: 1 }), /protected/);
  const execution = complete.executions[0]!;
  const before = await call("proc_execution_get", { id: execution.id }) as { authority: unknown };
  const plan = await call("proc_history_plan", { kind: "execution_content", ids: [execution.id] }) as StatePlan;
  await call("proc_history_clear", { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
  const after = await call("proc_execution_get", { id: execution.id }) as { state: string; authority: unknown; action: unknown; result: unknown };
  assert.equal(after.state, "completed"); assert.deepEqual(after.authority, before.authority);
  assert.equal(after.action, null); assert.equal(after.result, null); assert.equal(effects, 2);
});

test("guardian cancellation is terminal and startup preserves interrupted work as unknown", { timeout: 15_000 }, async (t) => {
  const { root, call } = await fixture(t);
  const id = randomUUID();
  await call("proc_run_start", { requestId: id, process: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 5_000 } });
  await until(() => call("proc_run_get", { id }) as Promise<{ state: string }>, (run) => run.state === "running");
  await call("proc_run_cancel", { id });
  const stopped = await until(() => call("proc_run_get", { id }) as Promise<{ state: string }>, (run) => run.state === "cancelled");
  assert.equal(stopped.state, "cancelled");
  const dir = join(root, "recovery");
  const store = new ProcStore(dir);
  const schedule = store.createSchedule(randomUUID(), { label: null, action: { type: "api", package: "brain", operation: "sources_sync", input: { due: true } },
    firstAt: new Date(Date.now() - 1000).toISOString(), everyMs: null, enabled: true });
  const recurring = store.createSchedule(randomUUID(), { label: null, action: { type: "api", package: "brain", operation: "sources_sync", input: { due: true } },
    firstAt: new Date(Date.now() - 1000).toISOString(), everyMs: 60_000, enabled: true });
  const admitted = store.due();
  assert.equal(admitted.length, 2);
  store.close();
  const recovered = new ProcStore(dir);
  try {
    assert.ok(admitted.every((item) => recovered.getExecution(item.executionId).state === "unknown"));
    assert.equal(recovered.getSchedule(schedule.id).nextAt, null);
    assert.deepEqual(recovered.due(), []);
    recovered.db.prepare("UPDATE schedules SET next_at=? WHERE id=?").run(Date.now() - 1000, recurring.id);
    const next = recovered.due();
    assert.equal(next.length, 1);
    assert.notEqual(next[0]!.executionId, admitted.find((item) => item.scheduleId === recurring.id)!.executionId);
  } finally { recovered.close(); }
});

test("the protected Brain schedule invokes due-only admission without a Brain-internal timer", { timeout: 10_000 }, async (t) => {
  const { root, env, call } = await fixture(t);
  let checked = 0;
  const brain = await serveSocket({ info: { name: "brain", description: "test brain", transportDescription: "fixture", path: socketPath("brain", env) },
    context: {}, operations: [operation({ name: "sources_sync", description: "Admit due sources", input: z.strictObject({ due: z.boolean() }),
      output: z.strictObject({ results: z.array(z.unknown()) }), async call(_ctx, { due }) { assert.equal(due, true); checked++; return { results: [] }; } })] });
  t.after(() => brain.close());
  const db = new ProcStore(join(root, "proc"));
  const systemId = "00000000-0000-4000-8000-000000000001";
  try {
    db.db.prepare("UPDATE schedules SET next_at=? WHERE id=?").run(Date.now() - 1000, systemId);
  } finally { db.close(); }
  await until(async () => (await call("proc_execution_list", { id: systemId }) as { executions: Array<{ state: string }> }).executions.length,
    (count) => count > 0);
  const complete = await until(() => call("proc_execution_list", { id: systemId }) as Promise<{ executions: Array<{ state: string; result: unknown }> }>,
    (page) => page.executions[0]?.state === "completed");
  assert.equal(checked, 1);
  assert.deepEqual(complete.executions[0]?.result, { results: [] });
  assert.equal((await call("proc_schedule_get", { id: systemId }) as { system: boolean }).system, true);
});

test("a scheduled argv process links its execution and a live follower can run without a timeout", { timeout: 10_000 }, async (t) => {
  const { call } = await fixture(t);
  const id = randomUUID();
  await call("proc_schedule_create", { id, firstAt: new Date(Date.now() - 1000).toISOString(), everyMs: null, enabled: true,
    action: { type: "process", process: { command: process.execPath,
      args: ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], timeoutMs: null } } });
  const linked = await until(() => call("proc_execution_list", { id }) as Promise<{ executions: Array<{ id: string; processId: string | null }> }>,
    (page) => !!page.executions[0]?.processId);
  const runId = linked.executions[0]!.processId!;
  const page = await until(() => call("proc_run_read", { id: runId }) as Promise<{ lines: Array<{ text: string }> }>,
    (result) => result.lines.length > 0);
  assert.equal(page.lines[0]?.text, "ready");
  await call("proc_run_cancel", { id: runId });
  const terminal = await until(() => call("proc_execution_get", { id: linked.executions[0]!.id }) as Promise<{ state: string }>,
    (result) => result.state === "failed");
  assert.equal(terminal.state, "failed");
});

test("a lost guardian marks outcome unknown and kills its guarded process group", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stack-proc-guardian-"));
  const service = new ProcService(new ProcStore(root), { ...process.env, STACK_STATE_DIR: root });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const run = service.startRun({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: null, retainOutput: true });
  const running = await until(async () => service.store.getRun(run.id), (record) => record.state === "running");
  const guard = (service as unknown as { active: Map<string, { guard: { pid: number } }> }).active.get(run.id)!.guard;
  process.kill(guard.pid, "SIGKILL");
  await until(async () => service.store.getRun(run.id), (record) => record.state === "unknown");
  await until(async () => {
    try { process.kill(-running.pid!, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }, (gone) => gone);
});

test("long Unicode lines preserve code points and bounded output reports truncation", { timeout: 15_000 }, async (t) => {
  const { call } = await fixture(t);
  const unicode = randomUUID();
  await call("proc_run_start", { requestId: unicode, process: { command: process.execPath,
    args: ["-e", "process.stdout.write('a'.repeat(4095)+'😀tail\\n')"] } });
  await until(() => call("proc_run_get", { id: unicode }) as Promise<{ state: string }>, (row) => row.state === "exited");
  const page = await call("proc_run_read", { id: unicode }) as { lines: Array<{ text: string; partial: boolean }> };
  assert.equal(page.lines.map((line) => line.text).join(""), `${"a".repeat(4095)}😀tail`);
  assert.equal(page.lines[0]?.partial, true);
  const large = randomUUID();
  await call("proc_run_start", { requestId: large, process: { command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2_200_000)+'\\n')"] } });
  const finished = await until(() => call("proc_run_get", { id: large }) as Promise<{ state: string; outputTruncated: boolean; lineCount: number }>,
    (row) => row.state === "exited", 10_000);
  assert.equal(finished.outputTruncated, true);
  assert.ok(finished.lineCount > 0 && finished.lineCount <= 10_000);
});

test("private store refuses a symlink and prunes only old terminal history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stack-proc-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(root, join(root, "alias"));
  assert.throws(() => new ProcStore(join(root, "alias")), /proc_state_directory_unsafe/);
  const store = new ProcStore(join(root, "proc"));
  try {
    assert.equal((await lstat(join(root, "proc", "proc.sqlite"))).mode & 0o077, 0);
    const old = store.startRun({ command: process.execPath, args: [], timeoutMs: 1_000, retainOutput: true }).record;
    store.line(old.id, "stdout", "historical", false);
    store.finishRun(old.id, "exited", 0, null, null);
    store.prune(Date.now() + 31 * 86_400_000);
    assert.throws(() => store.getRun(old.id), /run_not_found/);
  } finally { store.close(); }
});

test("ambiguous API dispatch is unknown and never replayed as the same one-shot", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stack-proc-unknown-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const target = await serveSocket({ info: { name: "fixture", description: "fixture", transportDescription: "fixture", path: socketPath("fixture", env) },
    context: {}, operations: [operation({ name: "effect", description: "Potentially did work", input: z.strictObject({}),
      output: z.strictObject({ ok: z.boolean() }), async call() { return { ok: true }; } })] });
  let dispatches = 0;
  const service = new ProcService(new ProcStore(join(root, "proc")), env,
    async () => { dispatches++; throw new Error("response_lost"); });
  t.after(async () => { await service.close(); await target.close(); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  service.store.createSchedule(id, { label: null, action: { type: "api", package: "fixture", operation: "effect", input: {} },
    firstAt: new Date(Date.now() - 1000).toISOString(), everyMs: null, enabled: true });
  await service.tick();
  const result = await until(async () => service.store.executions({ scheduleId: id, limit: 10 }).executions[0], (row) => row?.state === "unknown");
  assert.equal(result!.error, "call_outcome_unknown");
  await service.tick();
  assert.equal(dispatches, 1);
  assert.equal(service.store.getSchedule(id).nextAt, null);
});

test("a root that exits does not leave its TERM-ignoring descendant behind", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const { call } = await fixture(t);
  const id = randomUUID();
  const script = `require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}).unref();process.stdout.write('started\\n')`;
  await call("proc_run_start", { requestId: id, process: { command: process.execPath, args: ["-e", script] } });
  const terminal = await until(() => call("proc_run_get", { id }) as Promise<{ state: string; pid: number; exitCode: number }>,
    (row) => row.state === "exited", 6_000);
  assert.equal(terminal.exitCode, 0);
  assert.throws(() => process.kill(-terminal.pid, 0), /ESRCH/);
});
