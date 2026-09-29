import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { serveApi, socketCall, socketPath } from "@agentstack/api";
import { ProcStore } from "../src/store.js";
import { callCapacity, lineChunkChars, maxOutputBytes, maxOutputLines, retentionDays, runCapacity } from "../src/limits.js";
import { operator } from "../src/schema.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "agentstack-proc-reads-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root };
  const proc = await serveApi({ name: "proc", transport: "socket", env });
  t.after(async () => { await proc.close(); await rm(root, { recursive: true, force: true }); });
  const call = (name: string, args: object = {}) => socketCall(socketPath("proc", env), "tools/call", { name, arguments: args });
  const raw = () => new DatabaseSync(join(root, "proc", "proc.sqlite"));
  return { root, env, call, raw };
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
const processAction = { type: "process" as const, process: { command: process.execPath } };

test("schedule and run labels round-trip, deduplicate canonically and conflict on change", { timeout: 15_000 }, async (t) => {
  const { root, call } = await fixture(t);
  const id = randomUUID();
  const spec = { id, label: "Nightly repo backup", action: processAction,
    firstAt: new Date(Date.now() + 3_600_000).toISOString(), everyMs: null, enabled: false };
  const created = await call("proc_schedule_create", spec) as { label: string };
  assert.equal(created.label, "Nightly repo backup");
  assert.deepEqual(await call("proc_schedule_create", spec), created);
  assert.equal((await call("proc_schedule_get", { id }) as { label: string }).label, "Nightly repo backup");
  await assert.rejects(call("proc_schedule_create", { ...spec, label: "Different purpose" }), /schedule_id_conflict/);
  await assert.rejects(call("proc_schedule_create", { ...spec, label: "" }));

  // A spec stored before labels existed has no key; an identical create with
  // label null still deduplicates instead of conflicting.
  const legacy = randomUUID();
  await call("proc_schedule_create", { ...spec, id: legacy, label: null });
  const db = new DatabaseSync(join(root, "proc", "proc.sqlite"));
  try {
    const row = db.prepare("SELECT spec FROM schedules WHERE id=?").get(legacy) as { spec: string };
    const { label: _label, ...unlabeled } = JSON.parse(row.spec) as Record<string, unknown>;
    assert.ok(!("label" in unlabeled));
    db.prepare("UPDATE schedules SET spec=? WHERE id=?").run(JSON.stringify(unlabeled), legacy);
  } finally { db.close(); }
  const again = await call("proc_schedule_create", { ...spec, id: legacy, label: null }) as { id: string; label: string | null };
  assert.equal(again.id, legacy);
  assert.equal(again.label, null);

  const requestId = randomUUID();
  const run = await call("proc_run_start", { requestId, label: "One-off cleanup",
    process: { command: process.execPath, args: ["-e", ""], timeoutMs: 5_000 } }) as { id: string; label: string };
  assert.equal(run.label, "One-off cleanup");
  const detail = await until(() => call("proc_run_get", { id: run.id }) as Promise<{ state: string; label: string; command: string;
    process: { command: string; args: string[]; envKeys: string[]; timeoutMs: number | null; retainOutput: boolean } | null }>,
    (value) => value.state === "exited");
  assert.equal(detail.label, "One-off cleanup");
  assert.equal(detail.command, process.execPath);
  assert.deepEqual(detail.process, { command: process.execPath, args: ["-e", ""], cwd: null, envKeys: [], timeoutMs: 5_000, retainOutput: true });
});

test("a repeated request ID must carry the same run label, and env values never reach the runs row", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-proc-labels-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProcStore(join(root, "proc"));
  try {
    const requestId = randomUUID();
    const spec = { command: "/bin/echo", args: ["hi"], env: { SECRET_TOKEN: "s3cr3t-value" }, timeoutMs: 1_000, retainOutput: true };
    const admitted = store.startRun(spec, null, requestId, operator, "first label");
    assert.equal(admitted.record.label, "first label");
    assert.equal(admitted.record.scheduleId, null);
    assert.equal(store.startRun(spec, null, requestId, operator, "first label").created, false);
    assert.throws(() => store.startRun(spec, null, requestId, operator, "other label"), /run_id_conflict/);
    assert.throws(() => store.startRun(spec, null, requestId, operator, null), /run_id_conflict/);
    const row = store.db.prepare("SELECT * FROM runs WHERE id=?").get(requestId) as { process: string };
    assert.ok(!JSON.stringify(row).includes("s3cr3t-value"));
    assert.deepEqual(JSON.parse(row.process).envKeys, ["SECRET_TOKEN"]);
    assert.equal(JSON.parse(row.process).command, "/bin/echo");
  } finally { store.close(); }
});

test("v2 migration adds labels, links runs to schedules and stores env-free process summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-proc-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "proc.sqlite"));
  const now = new Date().toISOString();
  const scheduleId = randomUUID(), executionId = randomUUID(), runId = randomUUID(), directRunId = randomUUID();
  const principal = JSON.stringify(operator);
  db.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY,spec TEXT NOT NULL,revision INTEGER NOT NULL,system INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_by TEXT NOT NULL,edited_by TEXT NOT NULL,
      authority TEXT,blocked_reason TEXT,retry_at INTEGER,removed_at TEXT);
    CREATE TABLE executions (id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL,
      process_id TEXT,result TEXT,error TEXT,started_at TEXT NOT NULL,finished_at TEXT,authority TEXT,action TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY,execution_id TEXT,state TEXT NOT NULL,pid INTEGER,exit_code INTEGER,signal TEXT,
      error TEXT,request_hash TEXT NOT NULL,line_count INTEGER NOT NULL DEFAULT 0,output_bytes INTEGER NOT NULL DEFAULT 0,
      output_truncated INTEGER NOT NULL DEFAULT 0,retain_output INTEGER NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,created_by TEXT NOT NULL);
    CREATE TABLE lines (run_id TEXT NOT NULL,seq INTEGER NOT NULL,stream TEXT NOT NULL,text TEXT NOT NULL,partial INTEGER NOT NULL,PRIMARY KEY(run_id,seq));
    PRAGMA user_version=2;`);
  const unlabeledSpec = { action: { type: "process", process: { command: "/bin/echo", args: [], env: { SECRET_TOKEN: "s3cr3t-value" }, timeoutMs: 1_000, retainOutput: true } },
    firstAt: now, everyMs: null, enabled: true };
  db.prepare("INSERT INTO schedules (id,spec,revision,system,next_at,created_at,updated_at,created_by,edited_by,authority) VALUES (?,?,1,0,NULL,?,?,?,?,?)")
    .run(scheduleId, JSON.stringify(unlabeledSpec), now, now, principal, principal, principal);
  db.prepare(`INSERT INTO executions (id,schedule_id,due_at,state,process_id,result,error,started_at,finished_at,authority,action)
    VALUES (?,?,?,'completed',?,NULL,NULL,?,?,?,?)`)
    .run(executionId, scheduleId, Date.now() - 2_000, runId, now, now, principal, JSON.stringify(unlabeledSpec.action));
  db.prepare(`INSERT INTO runs (id,execution_id,state,request_hash,retain_output,started_at,finished_at,created_by)
    VALUES (?,?,'exited','hash',1,?,?,?)`).run(runId, executionId, now, now, principal);
  db.prepare(`INSERT INTO runs (id,execution_id,state,request_hash,retain_output,started_at,finished_at,created_by)
    VALUES (?,NULL,'exited','hash',1,?,?,?)`).run(directRunId, now, now, principal);
  db.close();
  const store = new ProcStore(root);
  try {
    assert.equal((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    assert.equal(store.getSchedule(scheduleId).label, null, "a pre-label stored spec reads as null");
    const run = store.getRun(runId);
    assert.equal(run.label, null);
    assert.equal(run.scheduleId, scheduleId, "backfilled through its execution");
    assert.equal(run.command, "/bin/echo");
    const detail = store.getRunDetail(runId);
    assert.deepEqual(detail.process, { command: "/bin/echo", args: [], cwd: null, envKeys: ["SECRET_TOKEN"], timeoutMs: 1_000, retainOutput: true });
    const raw = store.db.prepare("SELECT process FROM runs WHERE id=?").get(runId) as { process: string };
    assert.ok(!raw.process.includes("s3cr3t-value"), "environment values are never persisted");
    const direct = store.getRunDetail(directRunId);
    assert.equal(direct.scheduleId, null);
    assert.equal(direct.command, null);
    assert.equal(direct.process, null, "a pre-v3 direct run has no stored summary");
    assert.ok((store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='executions_started'").get()));
  } finally { store.close(); }
});

test("schedule lists page live rows before removed tombstones and get honors includeRemoved", { timeout: 15_000 }, async (t) => {
  const { call } = await fixture(t);
  const spec = { action: processAction, firstAt: new Date(Date.now() + 3_600_000).toISOString(), everyMs: null, enabled: false };
  const first = randomUUID(), second = randomUUID();
  await call("proc_schedule_create", { ...spec, id: first, label: "first" });
  await call("proc_schedule_create", { ...spec, id: second, label: "second" });
  await call("proc_schedule_remove", { id: first, expectedRevision: 1 });
  const live = await call("proc_schedule_list", {}) as { schedules: Array<{ id: string; removedAt: string | null }> };
  assert.ok(live.schedules.every((schedule) => schedule.removedAt === null && schedule.id !== first));
  const all = await call("proc_schedule_list", { includeRemoved: true }) as { schedules: Array<{ id: string; removedAt: string | null }> };
  const tombstone = all.schedules.find((schedule) => schedule.id === first)!;
  assert.ok(tombstone.removedAt !== null);
  const lastLive = Math.max(...all.schedules.filter((schedule) => schedule.removedAt === null).map((_, index) => index));
  const liveIndexes = all.schedules.map((schedule, index) => schedule.removedAt === null ? index : -1);
  assert.ok(all.schedules.every((schedule, index) => schedule.removedAt === null || index > Math.max(...liveIndexes)),
    "every removed schedule sorts after every live one");
  assert.ok(lastLive >= 0);
  await assert.rejects(call("proc_schedule_get", { id: first }), /schedule_not_found/);
  const got = await call("proc_schedule_get", { id: first, includeRemoved: true }) as { id: string; removedAt: string | null; label: string };
  assert.equal(got.id, first);
  assert.ok(got.removedAt !== null);
  assert.equal(got.label, "first");
});

test("schedule list embeds at most twelve recent executions, newest first", { timeout: 15_000 }, async (t) => {
  const { root, call } = await fixture(t);
  const id = randomUUID();
  await call("proc_schedule_create", { id, action: processAction, firstAt: new Date(Date.now() + 3_600_000).toISOString(), enabled: false });
  const db = new DatabaseSync(join(root, "proc", "proc.sqlite"));
  const base = Date.now() - 60_000;
  try {
    for (let i = 0; i < 14; i++)
      db.prepare("INSERT INTO executions (id,schedule_id,due_at,state,started_at,finished_at) VALUES (?,?,?,'completed',?,?)")
        .run(`00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, id, base, new Date(base + i * 1000).toISOString(), new Date(base + i * 1000).toISOString());
  } finally { db.close(); }
  const list = await call("proc_schedule_list", {}) as { schedules: Array<{ id: string; recent: Array<{ id: string; state: string; dueAt: string; startedAt: string; finishedAt: string | null; error: string | null }> }> };
  const schedule = list.schedules.find((item) => item.id === id)!;
  assert.equal(schedule.recent.length, 12);
  const starts = schedule.recent.map((item) => Date.parse(item.startedAt));
  assert.deepEqual([...starts].sort((a, b) => b - a), starts, "newest first");
  assert.equal(schedule.recent[0]!.startedAt, new Date(base + 13_000).toISOString());
  for (const item of schedule.recent)
    assert.deepEqual(Object.keys(item).sort(), ["dueAt", "error", "finishedAt", "id", "startedAt", "state"].sort());
});

test("proc_execution_list pages newest first across schedules with since and cursor", { timeout: 15_000 }, async (t) => {
  const { root, call } = await fixture(t);
  const scheduleId = randomUUID(), otherId = randomUUID();
  await call("proc_schedule_create", { id: scheduleId, action: processAction, firstAt: new Date(Date.now() + 3_600_000).toISOString(), enabled: false });
  const db = new DatabaseSync(join(root, "proc", "proc.sqlite"));
  const base = Date.now() - 60_000;
  const stamp = (i: number) => new Date(base + i * 10_000).toISOString();
  try {
    for (let i = 0; i < 5; i++)
      db.prepare("INSERT INTO executions (id,schedule_id,due_at,state,started_at) VALUES (?,?,?,'completed',?)")
        .run(`00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`, i % 2 ? otherId : scheduleId, base, stamp(i));
  } finally { db.close(); }
  // Across schedules, descending.
  const first = await call("proc_execution_list", { limit: 2 }) as { executions: Array<{ id: string; startedAt: string }>; nextCursor: string | null };
  assert.equal(first.executions.length, 2);
  assert.ok(first.executions[0]!.startedAt > first.executions[1]!.startedAt);
  assert.ok(first.nextCursor);
  const second = await call("proc_execution_list", { limit: 2, cursor: first.nextCursor! }) as typeof first;
  assert.deepEqual(second.executions.map((row) => row.id), [2, 1].map((i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`));
  const third = await call("proc_execution_list", { limit: 2, cursor: second.nextCursor! }) as typeof first;
  assert.equal(third.executions.length, 1);
  assert.equal(third.nextCursor, null);
  await assert.rejects(call("proc_execution_list", { cursor: "!!!not-a-cursor!!!" }), /invalid_cursor/);
  await assert.rejects(call("proc_execution_list", { cursor: Buffer.from(JSON.stringify(["not-a-date", "x"])).toString("base64url") }), /invalid_cursor/);
  // Scoped to one schedule, and since uses normalized ISO comparison.
  const scoped = await call("proc_execution_list", { id: scheduleId, limit: 10 }) as typeof first;
  assert.deepEqual(scoped.executions.map((row) => row.id),
    [4, 2, 0].map((i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`));
  assert.equal(scoped.nextCursor, null);
  const since = await call("proc_execution_list", { id: scheduleId, since: stamp(2).replace("Z", "+00:00") }) as typeof first;
  assert.deepEqual(since.executions.map((row) => row.id),
    [4, 2].map((i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`));
});

test("proc_run_list filters by state, pages by cursor and reports label and path only", { timeout: 15_000 }, async (t) => {
  const { root, call } = await fixture(t);
  const db = new DatabaseSync(join(root, "proc", "proc.sqlite"));
  const base = Date.now() - 60_000;
  try {
    for (let i = 0; i < 3; i++) {
      const id = `00000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`;
      db.prepare(`INSERT INTO runs (id,execution_id,state,request_hash,retain_output,started_at,created_by,label,process)
        VALUES (?,NULL,'exited','hash',1,?,?,?,?)`)
        .run(id, new Date(base + i * 10_000).toISOString(), JSON.stringify(operator), `run-${i}`,
          JSON.stringify({ command: "/bin/echo", args: [`arg-${i}`], cwd: null, envKeys: ["TOKEN"], timeoutMs: 1000, retainOutput: true }));
    }
    db.prepare("UPDATE runs SET state='running' WHERE id='00000000-0000-4000-a000-000000000002'").run();
  } finally { db.close(); }
  const all = await call("proc_run_list", {}) as { runs: Array<{ id: string; label: string; command: string; state: string }>; nextCursor: string | null };
  assert.equal(all.runs.length, 3);
  assert.equal(all.runs[0]!.label, "run-2");
  assert.equal(all.runs[0]!.command, "/bin/echo");
  for (const run of all.runs) assert.ok(!("process" in run) && !("args" in run) && !("env" in run) && !("envKeys" in run));
  const terminal = await call("proc_run_list", { state: "terminal" }) as typeof all;
  assert.equal(terminal.runs.length, 2);
  assert.ok(terminal.runs.every((run) => run.state !== "running" && run.state !== "starting"));
  const active = await call("proc_run_list", { state: "active" }) as typeof all;
  assert.deepEqual(active.runs.map((run) => run.id), ["00000000-0000-4000-a000-000000000002"]);
  const first = await call("proc_run_list", { limit: 2 }) as typeof all;
  assert.equal(first.runs.length, 2);
  assert.ok(first.nextCursor);
  const rest = await call("proc_run_list", { limit: 2, cursor: first.nextCursor! }) as typeof all;
  assert.equal(rest.runs.length, 1);
  assert.equal(rest.nextCursor, null);
  await assert.rejects(call("proc_run_list", { cursor: "bogus!!" }), /invalid_cursor/);
});

test("proc_status reports shared capacity, limits, sweep times and operator-wide schedule counts", { timeout: 15_000 }, async (t) => {
  const { root, call } = await fixture(t);
  const spec = { action: processAction, firstAt: new Date(Date.now() + 3_600_000).toISOString(), everyMs: null, enabled: false };
  const disabled = randomUUID(), held = randomUUID(), blocked = randomUUID(), legacy = randomUUID(), removed = randomUUID();
  for (const id of [disabled, held, blocked, legacy, removed])
    await call("proc_schedule_create", { ...spec, id, label: `count-${id.slice(0, 4)}` });
  await call("proc_schedule_remove", { id: removed, expectedRevision: 1 });
  const db = new DatabaseSync(join(root, "proc", "proc.sqlite"));
  try {
    // Keep the protected system schedule inert so its admission attempts never
    // race the count assertions.
    db.prepare("UPDATE schedules SET next_at=NULL,blocked_reason=NULL,retry_at=NULL WHERE system=1").run();
    db.prepare("UPDATE schedules SET blocked_reason='waiting',retry_at=? WHERE id=?").run(Date.now() + 60_000, held);
    db.prepare("UPDATE schedules SET blocked_reason='stuck',retry_at=NULL WHERE id=?").run(blocked);
    db.prepare("UPDATE schedules SET authority=NULL WHERE id=?").run(legacy);
  } finally { db.close(); }
  const status = await until(() => call("proc_status", {}) as Promise<{
    running: number; capacity: number; inFlightCalls: number; callCapacity: number;
    schedules: { total: number; enabled: number; held: number; blocked: number; legacy: number; removed: number };
    lastSweepAt: string | null; lastPruneAt: string | null; closing: boolean; retentionDays: number;
    output: { maxBytes: number; maxLines: number; lineChunkChars: number };
  }>, (value) => value.lastSweepAt !== null);
  assert.equal(status.capacity, runCapacity);
  assert.equal(status.callCapacity, callCapacity);
  assert.equal(status.retentionDays, retentionDays);
  assert.deepEqual(status.output, { maxBytes: maxOutputBytes, maxLines: maxOutputLines, lineChunkChars });
  assert.equal(status.closing, false);
  // The system Brain schedule plus five fixtures: all but the system one disabled.
  assert.deepEqual(status.schedules, { total: 5, enabled: 1, held: 1, blocked: 1, legacy: 1, removed: 1 });
  assert.ok(status.lastPruneAt !== null);
  const requestId = randomUUID();
  await call("proc_run_start", { requestId, process: { command: process.execPath, args: ["-e", "setInterval(()=>{},100)"], timeoutMs: 30_000 } });
  const busy = await until(() => call("proc_status", {}) as Promise<{ running: number }>, (value) => value.running === 1);
  assert.equal(busy.running, 1);
  await call("proc_run_cancel", { id: requestId });
});
