import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { executionRecord, type Action, type ProcessSpec, type ScheduleSpec } from "./schema.js";

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const parse = <T>(text: string): T => JSON.parse(text) as T;
const terminal = new Set(["exited", "failed", "cancelled", "unknown"]);
const maxOutputBytes = 2_000_000;

type ScheduleRow = { id: string; spec: string; revision: number; system: number; next_at: number | null; created_at: string; updated_at: string };
type ExecutionRow = { id: string; schedule_id: string; due_at: number; state: "running" | "completed" | "failed" | "unknown"; process_id: string | null;
  result: string | null; error: string | null; started_at: string; finished_at: string | null };
type RunRow = { id: string; execution_id: string | null; state: "starting" | "running" | "exited" | "failed" | "cancelled" | "unknown";
  pid: number | null; exit_code: number | null; signal: string | null; error: string | null; line_count: number; output_bytes: number;
  output_truncated: number; retain_output: number; started_at: string; finished_at: string | null };

export class ProcStore {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid()))
      throw new Error("proc_state_directory_unsafe");
    chmodSync(dir, 0o700);
    const path = join(dir, "proc.sqlite");
    let existing;
    try { existing = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 ||
      (process.getuid && existing.uid !== process.getuid()))) throw new Error("proc_database_unsafe");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = (this.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('schedules','executions','runs','lines')").get() as { count: number }).count;
    if (!((version === 0 && tables === 0) || (version === 1 && tables === 4))) {
      this.db.close(); throw new Error("proc_schema_unsupported");
    }
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, spec TEXT NOT NULL, revision INTEGER NOT NULL, system INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, due_at INTEGER NOT NULL, state TEXT NOT NULL,
        process_id TEXT, result TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT,
        UNIQUE(schedule_id, due_at)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, execution_id TEXT, state TEXT NOT NULL, pid INTEGER, exit_code INTEGER, signal TEXT,
        error TEXT, request_hash TEXT NOT NULL, line_count INTEGER NOT NULL DEFAULT 0, output_bytes INTEGER NOT NULL DEFAULT 0,
        output_truncated INTEGER NOT NULL DEFAULT 0, retain_output INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS lines (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL, partial INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_at);
      CREATE INDEX IF NOT EXISTS executions_schedule ON executions(schedule_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);
      PRAGMA user_version=1;
    `);
    // A process exit can have been committed before its schedule receipt. Repair
    // that exact outcome first; only genuinely interrupted work becomes unknown.
    const settled = this.db.prepare(`SELECT r.id, r.execution_id, r.state, r.exit_code, r.signal, r.error
      FROM runs r JOIN executions e ON e.id=r.execution_id
      WHERE e.state='running' AND r.state IN ('exited','failed','cancelled')`).all() as RunRow[];
    for (const run of settled) {
      this.db.prepare("UPDATE executions SET state=?, process_id=?, result=?, error=?, finished_at=? WHERE id=? AND state='running'")
        .run(run.state === "exited" && run.exit_code === 0 ? "completed" : "failed", run.id,
          JSON.stringify({ exitCode: run.exit_code, signal: run.signal }), run.error, iso(), run.execution_id);
    }
    // An interrupted API call is ambiguous. Never repeat it just because the
    // scheduler lost its socket or process; later due intervals are independent.
    this.db.prepare("UPDATE executions SET state='unknown', error='service_interrupted', finished_at=? WHERE state='running'").run(iso());
    this.db.prepare("UPDATE runs SET state='unknown', error='service_interrupted', finished_at=? WHERE state IN ('starting','running')").run(iso());
  }

  close() { this.db.close(); }

  schedule(row: ScheduleRow) {
    const spec = parse<ScheduleSpec>(row.spec);
    return { id: row.id, ...spec, revision: row.revision, system: !!row.system,
      nextAt: row.next_at === null ? null : iso(row.next_at), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  getSchedule(id: string) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleRow | undefined;
    if (!row) throw new Error("schedule_not_found");
    return this.schedule(row);
  }
  schedules(limit: number) {
    return (this.db.prepare("SELECT * FROM schedules ORDER BY created_at DESC LIMIT ?").all(limit) as ScheduleRow[]).map((row) => this.schedule(row));
  }
  createSchedule(id: string, spec: ScheduleSpec, system = false) {
    const existing = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleRow | undefined;
    if (existing) {
      if (existing.spec !== JSON.stringify(spec) || !!existing.system !== system) throw new Error("schedule_id_conflict");
      return this.schedule(existing);
    }
    const now = iso();
    this.db.prepare("INSERT INTO schedules (id,spec,revision,system,next_at,created_at,updated_at) VALUES (?,?,1,?,?,?,?)")
      .run(id, JSON.stringify(spec), system ? 1 : 0, spec.enabled ? Date.parse(spec.firstAt) : null, now, now);
    return this.getSchedule(id);
  }
  ensureSystemSchedule(id: string, spec: ScheduleSpec) {
    const existing = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleRow | undefined;
    if (existing) {
      if (!existing.system) throw new Error("system_schedule_conflict");
      return this.schedule(existing);
    }
    return this.createSchedule(id, spec, true);
  }
  updateSchedule(id: string, expectedRevision: number, spec: ScheduleSpec) {
    const changed = this.db.prepare("UPDATE schedules SET spec=?, revision=revision+1, next_at=?, updated_at=? WHERE id=? AND revision=? AND system=0")
      .run(JSON.stringify(spec), spec.enabled ? Date.parse(spec.firstAt) : null, iso(), id, expectedRevision).changes;
    if (!changed) throw new Error("schedule_revision_conflict_or_protected");
    return this.getSchedule(id);
  }
  removeSchedule(id: string, expectedRevision: number) {
    const changed = this.db.prepare("DELETE FROM schedules WHERE id=? AND revision=? AND system=0").run(id, expectedRevision).changes;
    if (!changed) throw new Error("schedule_revision_conflict_or_protected");
    // Execution history survives deletion by stable schedule ID.
    return { removed: true as const };
  }
  due(limit = 25): Array<{ executionId: string; scheduleId: string; dueAt: number; action: Action }> {
    if (limit <= 0) return [];
    const now = Date.now();
    const admitted: Array<{ executionId: string; scheduleId: string; dueAt: number; action: Action }> = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT * FROM schedules s WHERE next_at <= ? AND NOT EXISTS
        (SELECT 1 FROM executions e WHERE e.schedule_id=s.id AND e.state='running')
        ORDER BY next_at, id LIMIT ?`).all(now, limit) as ScheduleRow[];
      for (const row of rows) {
        const spec = parse<ScheduleSpec>(row.spec);
        const dueAt = row.next_at!;
        const executionId = randomUUID();
        this.db.prepare("INSERT INTO executions (id,schedule_id,due_at,state,started_at) VALUES (?,?,?,'running',?)")
          .run(executionId, row.id, dueAt, iso());
        this.db.prepare("UPDATE schedules SET next_at=?, updated_at=? WHERE id=?")
          .run(spec.everyMs === null ? null : now + spec.everyMs, iso(), row.id);
        admitted.push({ executionId, scheduleId: row.id, dueAt, action: spec.action });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return admitted;
  }
  execution(row: ExecutionRow) {
    return { id: row.id, scheduleId: row.schedule_id, dueAt: iso(row.due_at), state: row.state,
      processId: row.process_id, result: executionRecord.shape.result.parse(row.result === null ? null : JSON.parse(row.result)),
      error: row.error, startedAt: row.started_at, finishedAt: row.finished_at };
  }
  getExecution(id: string) {
    const row = this.db.prepare("SELECT * FROM executions WHERE id=?").get(id) as ExecutionRow | undefined;
    if (!row) throw new Error("execution_not_found");
    return this.execution(row);
  }
  executions(scheduleId: string, limit: number) {
    return (this.db.prepare("SELECT * FROM executions WHERE schedule_id=? ORDER BY started_at DESC LIMIT ?")
      .all(scheduleId, limit) as ExecutionRow[]).map((row) => this.execution(row));
  }
  finishExecution(id: string, state: "completed" | "failed" | "unknown", result: unknown = null, error: string | null = null, processId: string | null = null) {
    const text = result === null ? null : JSON.stringify(result);
    const bounded = text && Buffer.byteLength(text) > 32_000 ? JSON.stringify({ truncated: true }) : text;
    this.db.prepare("UPDATE executions SET state=?, result=?, error=?, process_id=COALESCE(?,process_id), finished_at=? WHERE id=? AND state='running'")
      .run(state, bounded, error, processId, iso(), id);
  }
  attachProcess(id: string, processId: string) {
    this.db.prepare("UPDATE executions SET process_id=? WHERE id=? AND state='running'").run(processId, id);
  }
  run(row: RunRow) {
    return { id: row.id, scheduleExecutionId: row.execution_id, state: row.state, pid: row.pid,
      exitCode: row.exit_code, signal: row.signal, error: row.error, lineCount: row.line_count,
      outputTruncated: !!row.output_truncated, retainOutput: !!row.retain_output,
      startedAt: row.started_at, finishedAt: row.finished_at };
  }
  startRun(spec: ProcessSpec, executionId: string | null = null, requestId: string = randomUUID()) {
    const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    const existing = this.db.prepare("SELECT request_hash,execution_id FROM runs WHERE id=?").get(requestId) as
      { request_hash: string; execution_id: string | null } | undefined;
    if (existing) {
      if (existing.request_hash !== hash || existing.execution_id !== executionId) throw new Error("run_id_conflict");
      return { record: this.getRun(requestId), created: false };
    }
    this.db.prepare("INSERT INTO runs (id,execution_id,state,retain_output,request_hash,started_at) VALUES (?,?,'starting',?,?,?)")
      .run(requestId, executionId, spec.retainOutput ? 1 : 0, hash, iso());
    return { record: this.getRun(requestId), created: true };
  }
  getRun(id: string) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row) throw new Error("run_not_found");
    return this.run(row);
  }
  hasRun(id: string) { return !!this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(id); }
  runs(limit: number) {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as RunRow[]).map((row) => this.run(row));
  }
  running(id: string, pid: number) {
    this.db.prepare("UPDATE runs SET state='running', pid=? WHERE id=? AND state='starting'").run(pid, id);
  }
  line(id: string, stream: "stdout" | "stderr", text: string, partial: boolean) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row || terminal.has(row.state) || row.output_truncated) return false;
    const bytes = Buffer.byteLength(text);
    if (row.output_bytes + bytes > maxOutputBytes || row.line_count >= 10_000) {
      this.db.prepare("UPDATE runs SET output_truncated=1 WHERE id=?").run(id);
      return true;
    }
    const seq = row.line_count + 1;
    this.db.prepare("INSERT INTO lines (run_id,seq,stream,text,partial) VALUES (?,?,?,?,?)").run(id, seq, stream, text, partial ? 1 : 0);
    this.db.prepare("UPDATE runs SET line_count=?, output_bytes=output_bytes+? WHERE id=?").run(seq, bytes, id);
    return true;
  }
  markTruncated(id: string) {
    this.db.prepare("UPDATE runs SET output_truncated=1 WHERE id=? AND state IN ('starting','running')").run(id);
  }
  finishRun(id: string, state: "exited" | "failed" | "cancelled" | "unknown", exitCode: number | null, signal: string | null, error: string | null) {
    this.db.prepare("UPDATE runs SET state=?, exit_code=?, signal=?, error=?, finished_at=? WHERE id=? AND state IN ('starting','running')")
      .run(state, exitCode, signal, error, iso(), id);
    this.db.prepare("DELETE FROM lines WHERE run_id=? AND (SELECT retain_output FROM runs WHERE id=?)=0").run(id, id);
    return this.getRun(id);
  }
  read(id: string, after: number, limit: number) {
    const run = this.getRun(id);
    const lines = (this.db.prepare("SELECT seq,stream,text,partial FROM lines WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(id, after, limit) as Array<{ seq: number; stream: "stdout" | "stderr"; text: string; partial: number }>)
      .map((line) => ({ ...line, partial: !!line.partial }));
    return { run, lines, nextAfter: lines.at(-1)?.seq ?? after, done: terminal.has(run.state),
      gap: (!!lines.length && lines[0]!.seq > after + 1) || (!lines.length && run.lineCount > after && !run.retainOutput) };
  }
  /** Bounded housekeeping: history lives for 30 days, never forever by accident. */
  prune(now = Date.now()) {
    const cutoff = iso(now - 30 * 86_400_000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const oldRuns = this.db.prepare("SELECT id FROM runs WHERE finished_at < ? ORDER BY finished_at LIMIT 100")
        .all(cutoff) as Array<{ id: string }>;
      for (const { id } of oldRuns) {
        this.db.prepare("DELETE FROM lines WHERE run_id=?").run(id);
        this.db.prepare("DELETE FROM runs WHERE id=?").run(id);
      }
      this.db.prepare("DELETE FROM executions WHERE id IN (SELECT id FROM executions WHERE finished_at < ? ORDER BY finished_at LIMIT 100)")
        .run(cutoff);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
