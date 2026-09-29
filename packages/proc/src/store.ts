import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { executionRecord, brainAuthority, isBrainSchedule, operator, summarizeProcess, systemBrainId,
  type Actor, type Authority, type Action, type ProcessSpec, type ProcessSummary, type ScheduleSpec, type Schedule } from "./schema.js";
import { maxOutputBytes, maxOutputLines, retentionDays } from "./limits.js";

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const parse = <T>(text: string): T => JSON.parse(text) as T;
const terminal = new Set(["exited", "failed", "cancelled", "unknown"]);
type BotOwner = Extract<Authority, { kind: "bot" }>;

// A stored spec predating labels simply has no key; compare the fixed-order
// projection so an identical rewrite stays idempotent.
const canonicalSpec = (spec: ScheduleSpec) => JSON.stringify({
  label: spec.label ?? null, action: spec.action, firstAt: spec.firstAt, everyMs: spec.everyMs, enabled: spec.enabled });
type StoredSpec = Omit<ScheduleSpec, "label"> & { label?: string | null };
const storedSpec = (text: string): ScheduleSpec => ({ label: null, ...parse<StoredSpec>(text) });

const encodeCursor = (row: { started_at: string; id: string }) =>
  Buffer.from(JSON.stringify([row.started_at, row.id])).toString("base64url");
const decodeCursor = (cursor: string): [string, string] => {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string"
      || Number.isNaN(Date.parse(value[0]))) throw new Error("shape");
    return [value[0], value[1]];
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_cursor") throw error;
    throw new Error("invalid_cursor");
  }
};
const botClause = (column: string) =>
  `json_extract(${column},'$.kind')='bot' AND json_extract(${column},'$.botId')=? AND json_extract(${column},'$.mainThreadId')=?`;

type ScheduleRow = { id: string; spec: string; revision: number; system: number; next_at: number | null; created_at: string; updated_at: string;
  created_by: string; edited_by: string; authority: string | null; blocked_reason: string | null; retry_at: number | null; removed_at: string | null };
type ExecutionRow = { id: string; schedule_id: string; due_at: number; state: "running" | "completed" | "failed" | "refused" | "unknown"; process_id: string | null;
  authority: string | null; action: string | null;
  result: string | null; error: string | null; started_at: string; finished_at: string | null };
type RunRow = { id: string; execution_id: string | null; state: "starting" | "running" | "exited" | "failed" | "cancelled" | "unknown";
  created_by: string; label: string | null; schedule_id: string | null; process: string | null;
  pid: number | null; exit_code: number | null; signal: string | null; error: string | null; line_count: number; output_bytes: number;
  output_truncated: number; retain_output: number; started_at: string; finished_at: string | null };
type ExecutionSummaryRow = { id: string; schedule_id: string; due_at: number; state: ExecutionRow["state"];
  started_at: string; finished_at: string | null; error: string | null };

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
    if (!((version === 0 && tables === 0) || ([1, 2, 3].includes(version) && tables === 4))) {
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
      CREATE INDEX IF NOT EXISTS executions_started ON executions(started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);
    `);
    if (version < 2) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`ALTER TABLE schedules ADD COLUMN created_by TEXT NOT NULL DEFAULT '{"kind":"legacy_unknown"}';
          ALTER TABLE schedules ADD COLUMN edited_by TEXT NOT NULL DEFAULT '{"kind":"legacy_unknown"}';
          ALTER TABLE schedules ADD COLUMN authority TEXT;
          ALTER TABLE schedules ADD COLUMN blocked_reason TEXT;
          ALTER TABLE schedules ADD COLUMN retry_at INTEGER;
          ALTER TABLE schedules ADD COLUMN removed_at TEXT;
          ALTER TABLE executions ADD COLUMN authority TEXT;
          ALTER TABLE executions ADD COLUMN action TEXT;
          ALTER TABLE runs ADD COLUMN created_by TEXT NOT NULL DEFAULT '{"kind":"legacy_unknown"}';`);
        // Revisions may deliberately reuse a due timestamp. Transactional admission,
        // not a timestamp uniqueness constraint, fences duplicate wake-ups.
        this.db.exec(`CREATE TABLE executions_v2 (
          id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, due_at INTEGER NOT NULL, state TEXT NOT NULL,
          process_id TEXT, result TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, authority TEXT, action TEXT
        );
        INSERT INTO executions_v2 SELECT id,schedule_id,due_at,state,process_id,result,error,started_at,finished_at,authority,action FROM executions;
        DROP TABLE executions;
        ALTER TABLE executions_v2 RENAME TO executions;
        CREATE INDEX executions_schedule ON executions(schedule_id, started_at DESC);`);
        const rows = this.db.prepare("SELECT * FROM schedules").all() as ScheduleRow[];
        for (const row of rows) {
          const spec = parse<ScheduleSpec>(row.spec);
          if (row.id === systemBrainId && row.system && isBrainSchedule(spec)) {
            const principal = JSON.stringify(brainAuthority);
            this.db.prepare("UPDATE schedules SET created_by=?,edited_by=?,authority=? WHERE id=?").run(principal, principal, principal, row.id);
          } else {
            this.db.prepare("UPDATE schedules SET spec=?,next_at=NULL,blocked_reason='legacy_reauthorization_required',revision=revision+1,updated_at=? WHERE id=?")
              .run(JSON.stringify({ ...storedSpec(row.spec), enabled: false }), iso(), row.id);
          }
        }
        this.db.exec("PRAGMA user_version=2; COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
    }
    if (version < 3) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`ALTER TABLE runs ADD COLUMN label TEXT;
          ALTER TABLE runs ADD COLUMN schedule_id TEXT;
          ALTER TABLE runs ADD COLUMN process TEXT;`);
        this.db.exec(`UPDATE runs SET schedule_id=(SELECT e.schedule_id FROM executions e WHERE e.id=runs.execution_id)
          WHERE execution_id IS NOT NULL`);
        // The persisted process summary carries envKeys only; values never land.
        const rows = this.db.prepare(`SELECT r.id AS id, e.action AS action FROM runs r JOIN executions e ON e.id=r.execution_id
          WHERE e.action IS NOT NULL`).all() as Array<{ id: string; action: string }>;
        for (const row of rows) {
          const act = parse<Action>(row.action);
          if (act.type === "process") this.db.prepare("UPDATE runs SET process=? WHERE id=?").run(JSON.stringify(summarizeProcess(act.process)), row.id);
        }
        this.db.exec("PRAGMA user_version=3; COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
    }
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

  schedule(row: ScheduleRow): Schedule {
    const spec = storedSpec(row.spec);
    return { id: row.id, ...spec, revision: row.revision, system: !!row.system,
      createdBy: parse<Actor>(row.created_by), lastEditedBy: parse<Actor>(row.edited_by), authority: row.authority ? parse<Authority>(row.authority) : null,
      blockedReason: row.blocked_reason, retryAt: row.retry_at === null ? null : iso(row.retry_at), removedAt: row.removed_at,
      nextAt: row.next_at === null ? null : iso(row.next_at), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  getSchedule(id: string, includeRemoved = false) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleRow | undefined;
    if (!row || row.removed_at && !includeRemoved) throw new Error("schedule_not_found");
    return this.schedule(row);
  }
  schedules(limit: number, owner?: BotOwner, includeRemoved = false) {
    const clauses = [includeRemoved ? "1=1" : "removed_at IS NULL"];
    const params: Array<string | number> = [];
    if (owner) { clauses.push(botClause("authority")); params.push(owner.botId, owner.mainThreadId); }
    params.push(limit);
    const rows = this.db.prepare(`SELECT * FROM schedules WHERE ${clauses.join(" AND ")}
      ORDER BY removed_at IS NOT NULL, created_at DESC LIMIT ?`).all(...params) as ScheduleRow[];
    const schedules = rows.map((row) => this.schedule(row));
    const recent = this.recentExecutions(schedules.map((schedule) => schedule.id));
    return schedules.map((schedule) => ({ ...schedule, recent: recent.get(schedule.id) ?? [] }));
  }
  /** Newest executions for the listed schedules in one query, newest first. */
  private recentExecutions(ids: string[]) {
    const recent = new Map<string, Array<{ id: string; state: ExecutionRow["state"]; dueAt: string; startedAt: string;
      finishedAt: string | null; error: string | null }>>();
    if (!ids.length) return recent;
    const rows = this.db.prepare(`SELECT id,schedule_id,state,due_at,started_at,finished_at,error FROM (
        SELECT id,schedule_id,state,due_at,started_at,finished_at,error,
          ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY started_at DESC, id DESC) AS rank
        FROM executions WHERE schedule_id IN (${ids.map(() => "?").join(",")})
      ) WHERE rank<=12 ORDER BY schedule_id,rank`).all(...ids) as ExecutionSummaryRow[];
    for (const row of rows) {
      const list = recent.get(row.schedule_id) ?? [];
      list.push({ id: row.id, state: row.state, dueAt: iso(row.due_at), startedAt: row.started_at, finishedAt: row.finished_at, error: row.error });
      recent.set(row.schedule_id, list);
    }
    return recent;
  }
  scheduleCounts(owner?: BotOwner) {
    const row = this.db.prepare(`SELECT
        count(*) FILTER (WHERE removed_at IS NULL) AS total,
        count(*) FILTER (WHERE removed_at IS NULL AND json_extract(spec,'$.enabled')=1) AS enabled,
        count(*) FILTER (WHERE removed_at IS NULL AND blocked_reason IS NOT NULL AND retry_at IS NOT NULL) AS held,
        count(*) FILTER (WHERE removed_at IS NULL AND blocked_reason IS NOT NULL AND retry_at IS NULL AND authority IS NOT NULL) AS blocked,
        count(*) FILTER (WHERE removed_at IS NULL AND authority IS NULL) AS legacy,
        count(*) FILTER (WHERE removed_at IS NOT NULL) AS removed
      FROM schedules ${owner ? `WHERE ${botClause("authority")}` : ""}`)
      .get(...(owner ? [owner.botId, owner.mainThreadId] : [])) as
      { total: number; enabled: number; held: number; blocked: number; legacy: number; removed: number };
    return row;
  }
  createSchedule(id: string, spec: ScheduleSpec, authority: Authority = operator) {
    const system = authority.kind === "system";
    const existing = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleRow | undefined;
    if (existing) {
      if (existing.removed_at || canonicalSpec(parse<ScheduleSpec>(existing.spec)) !== canonicalSpec(spec)
        || existing.authority !== JSON.stringify(authority)) throw new Error("schedule_id_conflict");
      return this.schedule(existing);
    }
    const now = iso();
    const principal = JSON.stringify(authority);
    this.db.prepare("INSERT INTO schedules (id,spec,revision,system,next_at,created_at,updated_at,created_by,edited_by,authority) VALUES (?,?,1,?,?,?,?,?,?,?)")
      .run(id, JSON.stringify(spec), system ? 1 : 0, spec.enabled ? Date.parse(spec.firstAt) : null, now, now, principal, principal, principal);
    return this.getSchedule(id);
  }
  ensureSystemSchedule(id: string, spec: ScheduleSpec) {
    const existing = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleRow | undefined;
    if (existing) {
      if (!existing.system || existing.removed_at || existing.authority !== JSON.stringify(brainAuthority) || !isBrainSchedule(parse<ScheduleSpec>(existing.spec))) throw new Error("system_schedule_conflict");
      return this.schedule(existing);
    }
    if (id !== systemBrainId || !isBrainSchedule(spec)) throw new Error("system_schedule_conflict");
    return this.createSchedule(id, spec, brainAuthority);
  }
  updateSchedule(id: string, expectedRevision: number, spec: ScheduleSpec, editor: Authority = operator, reauthorize = false) {
    const current = this.getSchedule(id);
    if (reauthorize && (current.authority !== null || editor.kind !== "operator")) throw new Error("schedule_reauthorization_refused");
    if (!reauthorize && current.authority === null) throw new Error("legacy_reauthorization_required");
    const changed = this.db.prepare("UPDATE schedules SET spec=?, revision=revision+1, next_at=?, updated_at=?,edited_by=?,authority=?,blocked_reason=NULL,retry_at=NULL WHERE id=? AND revision=? AND system=0 AND removed_at IS NULL")
      .run(JSON.stringify(spec), spec.enabled ? Date.parse(spec.firstAt) : null, iso(), JSON.stringify(editor), JSON.stringify(reauthorize ? operator : current.authority), id, expectedRevision).changes;
    if (!changed) throw new Error("schedule_revision_conflict_or_protected");
    return this.getSchedule(id);
  }
  removeSchedule(id: string, expectedRevision: number, editor: Authority = operator) {
    const changed = this.db.prepare("UPDATE schedules SET removed_at=?,next_at=NULL,revision=revision+1,edited_by=? WHERE id=? AND revision=? AND system=0 AND removed_at IS NULL")
      .run(iso(), JSON.stringify(editor), id, expectedRevision).changes;
    if (!changed) throw new Error("schedule_revision_conflict_or_protected");
    // Execution history survives deletion by stable schedule ID.
    return { removed: true as const };
  }
  pending(limit = 25): Schedule[] {
    if (limit <= 0) return [];
    const now = Date.now();
    return (this.db.prepare(`SELECT * FROM schedules s WHERE removed_at IS NULL AND authority IS NOT NULL AND next_at<=?
      AND (blocked_reason IS NULL OR retry_at<=?) AND NOT EXISTS
      (SELECT 1 FROM executions e WHERE e.schedule_id=s.id AND e.state='running') ORDER BY COALESCE(retry_at,next_at),id LIMIT ?`)
      .all(now, now, limit) as ScheduleRow[]).map((row) => this.schedule(row));
  }
  block(schedule: Schedule, reason: string, retryMs: number | null) {
    return this.db.prepare("UPDATE schedules SET blocked_reason=?,retry_at=?,updated_at=? WHERE id=? AND revision=? AND next_at=? AND removed_at IS NULL")
      .run(reason, retryMs === null ? null : Date.now() + retryMs, iso(), schedule.id, schedule.revision, Date.parse(schedule.nextAt!)).changes > 0;
  }
  admit(schedule: Schedule): { executionId: string; scheduleId: string; dueAt: number; action: Action; authority: Authority; label: string | null } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM schedules s WHERE id=? AND revision=? AND next_at=? AND removed_at IS NULL AND authority IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.schedule_id=s.id AND e.state='running')`)
        .get(schedule.id, schedule.revision, Date.parse(schedule.nextAt!)) as ScheduleRow | undefined;
      let admitted = null;
      if (row) {
        const spec = storedSpec(row.spec), authority = parse<Authority>(row.authority!);
        const dueAt = row.next_at!;
        const executionId = randomUUID();
        this.db.prepare("INSERT INTO executions (id,schedule_id,due_at,state,started_at,authority,action) VALUES (?,?,?,'running',?,?,?)")
          .run(executionId, row.id, dueAt, iso(), row.authority, JSON.stringify(spec.action));
        this.db.prepare("UPDATE schedules SET next_at=?,updated_at=?,blocked_reason=NULL,retry_at=NULL WHERE id=?")
          .run(spec.everyMs === null ? null : Date.now() + spec.everyMs, iso(), row.id);
        admitted = { executionId, scheduleId: row.id, dueAt, action: spec.action, authority, label: spec.label };
      }
      this.db.exec("COMMIT");
      return admitted;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Store-level admission helper; the service authorizes every candidate before calling admit. */
  due(limit = 25) {
    return this.pending(limit).flatMap((schedule) => { const due = this.admit(schedule); return due ? [due] : []; });
  }
  execution(row: ExecutionRow) {
    return { id: row.id, scheduleId: row.schedule_id, dueAt: iso(row.due_at), state: row.state,
      authority: row.authority ? parse<Authority>(row.authority) : null, action: row.action ? parse<Action>(row.action) : null,
      processId: row.process_id, result: executionRecord.shape.result.parse(row.result === null ? null : JSON.parse(row.result)),
      error: row.error, startedAt: row.started_at, finishedAt: row.finished_at };
  }
  getExecution(id: string) {
    const row = this.db.prepare("SELECT * FROM executions WHERE id=?").get(id) as ExecutionRow | undefined;
    if (!row) throw new Error("execution_not_found");
    return this.execution(row);
  }
  executions(query: { scheduleId?: string; since?: string; cursor?: string; limit: number }, owner?: BotOwner) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.scheduleId) { clauses.push("schedule_id=?"); params.push(query.scheduleId); }
    if (query.since) { clauses.push("started_at>=?"); params.push(new Date(query.since).toISOString()); }
    if (owner) { clauses.push(botClause("authority")); params.push(owner.botId, owner.mainThreadId); }
    if (query.cursor) {
      const [startedAt, id] = decodeCursor(query.cursor);
      clauses.push("(started_at<? OR (started_at=? AND id<?))");
      params.push(startedAt, startedAt, id);
    }
    params.push(query.limit + 1);
    const rows = this.db.prepare(`SELECT * FROM executions ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY started_at DESC, id DESC LIMIT ?`).all(...params) as ExecutionRow[];
    const page = rows.slice(0, query.limit);
    return { executions: page.map((row) => this.execution(row)),
      nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
  }
  finishExecution(id: string, state: "completed" | "failed" | "refused" | "unknown", result: unknown = null, error: string | null = null, processId: string | null = null) {
    const text = result === null ? null : JSON.stringify(result);
    const bounded = text && Buffer.byteLength(text) > 32_000 ? JSON.stringify({ truncated: true }) : text;
    this.db.prepare("UPDATE executions SET state=?, result=?, error=?, process_id=COALESCE(?,process_id), finished_at=? WHERE id=? AND state='running'")
      .run(state, bounded, error, processId, iso(), id);
  }
  attachProcess(id: string, processId: string) {
    this.db.prepare("UPDATE executions SET process_id=? WHERE id=? AND state='running'").run(processId, id);
  }
  run(row: RunRow) {
    return { id: row.id, label: row.label, command: row.process ? parse<ProcessSummary>(row.process).command : null,
      scheduleId: row.schedule_id, scheduleExecutionId: row.execution_id,
      createdBy: parse<Actor>(row.created_by), state: row.state, pid: row.pid,
      exitCode: row.exit_code, signal: row.signal, error: row.error, lineCount: row.line_count,
      outputTruncated: !!row.output_truncated, retainOutput: !!row.retain_output,
      startedAt: row.started_at, finishedAt: row.finished_at };
  }
  runDetail(row: RunRow) {
    return { ...this.run(row), process: row.process ? parse<ProcessSummary>(row.process) : null };
  }
  startRun(spec: ProcessSpec, executionId: string | null = null, requestId: string = randomUUID(), createdBy: Authority = operator, label: string | null = null) {
    const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    const existing = this.db.prepare("SELECT request_hash,execution_id,created_by,label FROM runs WHERE id=?").get(requestId) as
      { request_hash: string; execution_id: string | null; created_by: string; label: string | null } | undefined;
    if (existing) {
      if (existing.request_hash !== hash || existing.execution_id !== executionId || existing.created_by !== JSON.stringify(createdBy)
        || existing.label !== label) throw new Error("run_id_conflict");
      return { record: this.getRun(requestId), created: false };
    }
    this.db.prepare(`INSERT INTO runs (id,execution_id,state,retain_output,request_hash,started_at,created_by,label,schedule_id,process)
      VALUES (?,?,'starting',?,?,?,?,?,(SELECT schedule_id FROM executions WHERE id=?),?)`)
      .run(requestId, executionId, spec.retainOutput ? 1 : 0, hash, iso(), JSON.stringify(createdBy), label, executionId,
        JSON.stringify(summarizeProcess(spec)));
    return { record: this.getRun(requestId), created: true };
  }
  getRun(id: string) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row) throw new Error("run_not_found");
    return this.run(row);
  }
  getRunDetail(id: string) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row) throw new Error("run_not_found");
    return this.runDetail(row);
  }
  hasRun(id: string) { return !!this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(id); }
  runs(query: { state?: "active" | "terminal"; cursor?: string; limit: number }, owner?: BotOwner) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.state === "active") clauses.push("state IN ('starting','running')");
    else if (query.state === "terminal") clauses.push("state NOT IN ('starting','running')");
    if (owner) { clauses.push(botClause("created_by")); params.push(owner.botId, owner.mainThreadId); }
    if (query.cursor) {
      const [startedAt, id] = decodeCursor(query.cursor);
      clauses.push("(started_at<? OR (started_at=? AND id<?))");
      params.push(startedAt, startedAt, id);
    }
    params.push(query.limit + 1);
    const rows = this.db.prepare(`SELECT * FROM runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY started_at DESC, id DESC LIMIT ?`).all(...params) as RunRow[];
    const page = rows.slice(0, query.limit);
    return { runs: page.map((row) => this.run(row)), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
  }
  running(id: string, pid: number) {
    this.db.prepare("UPDATE runs SET state='running', pid=? WHERE id=? AND state='starting'").run(pid, id);
  }
  line(id: string, stream: "stdout" | "stderr", text: string, partial: boolean) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row || terminal.has(row.state) || row.output_truncated) return false;
    const bytes = Buffer.byteLength(text);
    if (row.output_bytes + bytes > maxOutputBytes || row.line_count >= maxOutputLines) {
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
    const cutoff = iso(now - retentionDays * 86_400_000);
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
