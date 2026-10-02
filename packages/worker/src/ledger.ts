import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkerHistory, type ObservedSettings } from "./history.js";
import { SettingsStore } from "@stack/settings";
import { OperationRejected, stateHash } from "@stack/api";
import type { WorkContext } from "@stack/hud/schema";
import type { WorkAdmission } from "@stack/hud/client";
import type { WorkerEventInput, WorkerEvent, WorkerEventReceipt } from "./event-inbox.js";

export type WorkerPhase = "preparing" | "idle" | "running" | "awaiting_input" | "cancelling" | "closed" | "failed" | "needs_recovery";
export type TurnPhase = "queued" | "running" | "awaiting_input" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown";
export type WorkerRecord = {
  id: string; botId: string; threadId: string; accountId: string; provider: "codex" | "devin" | "claude";
  model: string; effort: string | null; repo: string; cwd: string | null; branch: string | null; baseCommit: string | null;
  sourceDirty: boolean; roleId: string | null; roleRevision: number | null; sessionId: string | null; phase: WorkerPhase;
  runtimeInstance: string | null;
  contentClearedAt: number | null;
  currentTurnId: string | null; issue: string | null; createdAt: number; updatedAt: number;
};
export type TurnRecord = { id: string; workerId: string; phase: TurnPhase; stopReason: string | null; issue: string | null;
  contentClearedAt: number | null;
  workContext: WorkContext | null;
  requestId: string; prompt: string | null; requestedModel: string | null; requestedEffort: string | null;
  observedSettings: ObservedSettings | null; dispatchedAt: number | null; dispatchedPromptSeq: number | null;
  createdAt: number; updatedAt: number };
export type TurnSummary = Omit<TurnRecord, "prompt"> & { promptChars: number | null };
export function summarizeTurn({ prompt, ...turn }: TurnRecord): TurnSummary {
  return { ...turn, promptChars: prompt?.length ?? null };
}
export type TranscriptEntry = { seq: number; workerId: string; turnId: string; kind: string; text: string; at: number };
export type PendingRequest = { id: string; workerId: string; turnId: string; acpRequestId: number; kind: "permission";
  runtimeInstance: string | null; toolCallId: string | null; recordSeq: number | null;
  title: string; options: Array<{ optionId: string; name: string; kind: string }>; state: "pending" | "responded" | "unknown" };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class WorkerLedger {
  private readonly db: DatabaseSync;
  readonly history: WorkerHistory;
  readonly settings: SettingsStore;

  constructor(private readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, "workers.sqlite");
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
        bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, account_id TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, effort TEXT, repo TEXT NOT NULL, cwd TEXT, branch TEXT, base_commit TEXT,
        source_dirty INTEGER NOT NULL DEFAULT 0, role_revision INTEGER, acp_session_id TEXT, runtime_instance TEXT, phase TEXT NOT NULL,
        current_turn_id TEXT, issue TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id), request_id TEXT NOT NULL UNIQUE,
        input_digest TEXT NOT NULL, phase TEXT NOT NULL, stop_reason TEXT, issue TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL REFERENCES workers(id),
        turn_id TEXT NOT NULL REFERENCES turns(id), kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_worker ON turns(worker_id);
      CREATE INDEX IF NOT EXISTS transcript_worker_seq ON transcript(worker_id, seq);
      CREATE TABLE IF NOT EXISTS pending_requests (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        acp_request_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        options_json TEXT NOT NULL, state TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(workers)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "role_id")) this.db.exec("ALTER TABLE workers ADD COLUMN role_id TEXT");
    if (!columns.some((column) => column.name === "runtime_instance")) this.db.exec("ALTER TABLE workers ADD COLUMN runtime_instance TEXT");
    for (const [table, additions] of Object.entries({ workers: { content_cleared_at: "INTEGER" }, turns: { content_cleared_at: "INTEGER", prompt: "TEXT", requested_model: "TEXT", requested_effort: "TEXT",
      observed_settings_json: "TEXT", dispatched_at: "INTEGER", dispatched_prompt_seq: "INTEGER", work_context_json: "TEXT", origin_bot_id: "TEXT", origin_thread_id: "TEXT" },
    pending_requests: { runtime_instance: "TEXT", tool_call_id: "TEXT", record_seq: "INTEGER" } })) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      for (const [name, type] of Object.entries(additions)) if (!existing.some((column) => column.name === name))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    // Only the first turn has provable legacy Chat provenance. Never invent the
    // originating Chat for an old follow-up admitted by another Chat of the Bot.
    this.db.exec(`UPDATE turns SET origin_bot_id=(SELECT bot_id FROM workers WHERE workers.request_id=turns.request_id),
      origin_thread_id=(SELECT thread_id FROM workers WHERE workers.request_id=turns.request_id)
      WHERE origin_bot_id IS NULL AND request_id IN (SELECT request_id FROM workers)`);
    this.history = new WorkerHistory(this.db);
    this.db.exec("CREATE INDEX IF NOT EXISTS turns_work_item ON turns(json_extract(work_context_json,'$.workItemId'))");
    this.settings = new SettingsStore(this.db, "worker");
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_branches(worker_id TEXT PRIMARY KEY,repo TEXT NOT NULL,branch TEXT NOT NULL,base_commit TEXT NOT NULL,collected_at INTEGER);
      INSERT OR IGNORE INTO worker_branches SELECT id,repo,branch,base_commit,NULL FROM workers WHERE base_commit IS NOT NULL AND branch='stack-worker-'||id;`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_event_inbox(delivery_id TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id),digest TEXT NOT NULL,value TEXT NOT NULL);
      UPDATE worker_event_inbox SET value=json_set(value,'$.state','unknown','$.issue','Owner restarted during event dispatch/interruption; no automatic replay')
      WHERE json_extract(value,'$.state')='interrupting';`);
    for (const provider of ["codex", "devin", "claude"]) this.settings.seed(`worker-defaults:${provider}`, {}, "Native Worker selection");
    this.db.prepare("UPDATE workers SET phase = 'needs_recovery', issue = 'Owner restarted during a worker operation; inspect before resuming', updated_at = ? WHERE provider IN ('codex','devin','claude') AND phase IN ('preparing','running','awaiting_input','cancelling')").run(Date.now());
    this.db.prepare("UPDATE turns SET phase = 'unknown', issue = 'Turn outcome is unknown after owner restart', updated_at = ? WHERE worker_id IN (SELECT id FROM workers WHERE provider IN ('codex','devin','claude')) AND phase IN ('queued','running','awaiting_input','cancelling')").run(Date.now());
    this.db.prepare("UPDATE pending_requests SET state = 'unknown' WHERE worker_id IN (SELECT id FROM workers WHERE provider IN ('codex','devin','claude')) AND state = 'pending'").run();
    this.db.prepare("UPDATE workers SET phase = 'needs_recovery', issue = 'Owner restarted; load the saved session before sending', updated_at = ? WHERE provider IN ('codex','devin','claude') AND phase = 'idle' AND acp_session_id IS NOT NULL").run(Date.now());
    this.db.exec(`UPDATE worker_event_inbox SET value=json_set(value,'$.state','unknown','$.turnId',(SELECT id FROM turns WHERE request_id=delivery_id),
      '$.issue','Recorded event turn has an unknown outcome; no automatic replay')
      WHERE delivery_id IN (SELECT request_id FROM turns WHERE phase='unknown');`);
  }

  close(): void { this.db.close(); }

  event(deliveryId: string): WorkerEvent | null {
    const row = this.db.prepare("SELECT value FROM worker_event_inbox WHERE delivery_id=?").get(deliveryId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  admitEvent(input: WorkerEventInput): WorkerEventReceipt {
    const row = this.db.prepare("SELECT digest,value FROM worker_event_inbox WHERE delivery_id=?").get(input.deliveryId) as { digest: string; value: string } | undefined;
    if (row) {
      if (row.digest !== stateHash(input)) throw new OperationRejected("Event delivery ID was reused with different input");
      const { input: _, ...receipt } = JSON.parse(row.value) as WorkerEvent; return receipt;
    }
    const size = (this.db.prepare("SELECT COUNT(*) AS count FROM worker_event_inbox WHERE worker_id=?").get(input.id) as { count: number }).count;
    if (size >= 1000) throw new OperationRejected("Worker event inbox capacity reached; inspect/clear this Worker before new intake");
    const now = Date.now();
    const event: WorkerEvent = { deliveryId: input.deliveryId, workerId: input.id, sessionId: input.sessionId, state: "queued", turnId: null, issue: null, createdAt: now, updatedAt: now, input };
    this.db.prepare("INSERT INTO worker_event_inbox VALUES(?,?,?,?)").run(input.deliveryId, input.id, stateHash(input), JSON.stringify(event));
    const { input: _, ...receipt } = event; return receipt;
  }
  eventReceipts(workerId: string): WorkerEventReceipt[] {
    return (this.db.prepare("SELECT value FROM worker_event_inbox WHERE worker_id=? ORDER BY rowid DESC LIMIT 128").all(workerId) as { value: string }[])
      .map(row => { const { input: _, ...receipt } = JSON.parse(row.value) as WorkerEvent; return receipt; });
  }
  eventReceiptCount(workerId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM worker_event_inbox WHERE worker_id=?").get(workerId) as { count: number }).count;
  }
  pendingEvents(workerId: string): WorkerEvent[] {
    return (this.db.prepare("SELECT value FROM worker_event_inbox WHERE worker_id=? AND json_extract(value,'$.state') IN ('queued','interrupting') ORDER BY rowid").all(workerId) as { value: string }[]).map(row => JSON.parse(row.value));
  }
  eventBlocked(workerId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM worker_event_inbox WHERE worker_id=? AND json_extract(value,'$.state')='unknown' LIMIT 1").get(workerId);
  }
  updateEvent(id: string, state: WorkerEventReceipt["state"], turnId: string | null = null, issue: string | null = null) {
    const event = this.event(id)!;
    this.db.prepare("UPDATE worker_event_inbox SET value=? WHERE delivery_id=?").run(JSON.stringify({ ...event, state, turnId, issue, updatedAt: Date.now() }), id);
  }
  cancelEvents(workerId: string) { for (const event of this.pendingEvents(workerId)) this.updateEvent(event.deliveryId, "cancelled", event.turnId, "Worker lifecycle ended; queued input was not dispatched"); }

  private workerRow(row: Record<string, unknown>): WorkerRecord {
    return {
      id: row.id as string, botId: row.bot_id as string, threadId: row.thread_id as string,
      accountId: row.account_id as string, provider: row.provider as WorkerRecord["provider"],
      model: row.model as string, effort: row.effort as string | null, repo: row.repo as string,
      cwd: row.cwd as string | null, branch: row.branch as string | null, baseCommit: row.base_commit as string | null,
      sourceDirty: Boolean(row.source_dirty), roleId: row.role_id as string | null, roleRevision: row.role_revision as number | null,
      sessionId: row.acp_session_id as string | null, phase: row.phase as WorkerPhase,
      runtimeInstance: row.runtime_instance as string | null,
      contentClearedAt: row.content_cleared_at as number | null,
      currentTurnId: row.current_turn_id as string | null, issue: row.issue as string | null,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number,
    };
  }
  worker(id: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT * FROM workers WHERE id = ? AND provider IN ('codex','devin','claude')").get(id) as Record<string, unknown> | undefined;
    return row ? this.workerRow(row) : null;
  }
  workers(botId?: string): WorkerRecord[] {
    const rows = (botId
      ? this.db.prepare("SELECT * FROM workers WHERE bot_id = ? AND provider IN ('codex','devin','claude') ORDER BY created_at DESC").all(botId)
      : this.db.prepare("SELECT * FROM workers WHERE provider IN ('codex','devin','claude') ORDER BY created_at DESC").all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.workerRow(row));
  }

  findStart(requestId: string, input: unknown): { worker: WorkerRecord; turn: TurnRecord } | null {
    const row = this.db.prepare("SELECT id, input_digest FROM workers WHERE request_id = ?").get(requestId) as { id: string; input_digest: string } | undefined;
    if (!row) return null;
    if (row.input_digest !== digest(input)) throw new OperationRejected("requestId was reused for another worker request");
    const first = this.db.prepare("SELECT id FROM turns WHERE request_id = ?").get(requestId) as { id: string };
    return { worker: this.worker(row.id)!, turn: this.turn(first.id)! };
  }
  startByRequestId(requestId: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT id FROM workers WHERE request_id = ?").get(requestId) as { id: string } | undefined;
    return row ? this.worker(row.id) : null;
  }

  turnByRequestId(requestId: string): TurnRecord | null {
    const row = this.db.prepare("SELECT id FROM turns WHERE request_id=?").get(requestId) as { id: string } | undefined;
    return row ? this.turn(row.id) : null;
  }

  turnOrigin(requestId: string): { botId: string; threadId: string } | null {
    const row = this.db.prepare("SELECT origin_bot_id, origin_thread_id FROM turns WHERE request_id=?").get(requestId) as { origin_bot_id: string | null; origin_thread_id: string | null } | undefined;
    return row?.origin_bot_id && row.origin_thread_id ? { botId: row.origin_bot_id, threadId: row.origin_thread_id } : null;
  }

  reserve(input: { requestId: string; botId: string; threadId: string; accountId: string; provider: WorkerRecord["provider"];
    model: string; effort: string | null; repo: string; baseRef: string | null; task: string; roleId?: string; workItemId?: string | null },
    workContext: WorkContext | null = null): { worker: WorkerRecord; turn: TurnRecord; duplicate: boolean } {
    const inputDigest = digest(input);
    const prior = this.db.prepare("SELECT id, input_digest FROM workers WHERE request_id = ?").get(input.requestId) as { id: string; input_digest: string } | undefined;
    if (prior) {
      if (prior.input_digest !== inputDigest) throw new OperationRejected("requestId was reused for another worker request");
      const worker = this.worker(prior.id)!;
      const first = this.db.prepare("SELECT id FROM turns WHERE request_id = ?").get(input.requestId) as { id: string };
      return { worker, turn: this.turn(first.id)!, duplicate: true };
    }
    const id = randomUUID();
    const turnId = randomUUID();
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO workers (id, request_id, input_digest, bot_id, thread_id, account_id, provider, model, effort, repo,
        cwd, branch, phase, current_turn_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'preparing',?,?,?)`)
        .run(id, input.requestId, inputDigest, input.botId, input.threadId, input.accountId, input.provider, input.model, input.effort, input.repo,
          join(this.stateDir, "workers", "worktrees", id), `stack-worker-${id}`, turnId, now, now);
      this.db.prepare("INSERT INTO turns (id, worker_id, request_id, input_digest, phase, created_at, updated_at, prompt, requested_model, requested_effort) VALUES (?,?,?,?, 'queued',?,?,?,?,?)")
        .run(turnId, id, input.requestId, inputDigest, now, now, input.task, input.model, input.effort);
      this.db.prepare("UPDATE turns SET work_context_json=?, origin_bot_id=?, origin_thread_id=? WHERE id=?").run(workContext ? JSON.stringify(workContext) : null, input.botId, input.threadId, turnId);
      this.append(id, turnId, "user", input.task);
      this.history.append(id, null, "launch", "submitted", { repo: input.repo, baseRef: input.baseRef, roleId: input.roleId ?? null, model: input.model, effort: input.effort });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { worker: this.worker(id)!, turn: this.turn(turnId)!, duplicate: false };
  }

  setWorktree(id: string, claim: { repo: string; cwd: string; branch: string; baseCommit: string; sourceDirty: boolean; roleId: string; roleRevision: number }): WorkerRecord {
    this.db.prepare("INSERT OR IGNORE INTO worker_branches VALUES(?,?,?,?,NULL)").run(id, claim.repo, claim.branch, claim.baseCommit);
    this.db.prepare("UPDATE workers SET repo = ?, cwd = ?, branch = ?, base_commit = ?, source_dirty = ?, role_id = ?, role_revision = ?, updated_at = ? WHERE id = ?")
      .run(claim.repo, claim.cwd, claim.branch, claim.baseCommit, Number(claim.sourceDirty), claim.roleId, claim.roleRevision, Date.now(), id);
    return this.worker(id)!;
  }
  setSession(id: string, sessionId: string): WorkerRecord {
    this.db.prepare("UPDATE workers SET acp_session_id = ?, phase = 'idle', issue = NULL, updated_at = ? WHERE id = ?")
      .run(sessionId, Date.now(), id);
    return this.worker(id)!;
  }
  setRuntimeInstance(id: string, instance: string): WorkerRecord {
    this.db.prepare("UPDATE workers SET runtime_instance = ?, updated_at = ? WHERE id = ?").run(instance, Date.now(), id);
    return this.worker(id)!;
  }
  setWorkerPhase(id: string, phase: WorkerPhase, issue: string | null = null): WorkerRecord {
    this.db.prepare("UPDATE workers SET phase = ?, issue = ?, updated_at = ? WHERE id = ?").run(phase, issue, Date.now(), id);
    return this.worker(id)!;
  }
  interruptAccount(accountId: string): void {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE turns SET phase = 'unknown', issue = 'Worker runtime stopped before the turn outcome was confirmed', updated_at = ? WHERE worker_id IN (SELECT id FROM workers WHERE account_id = ?) AND phase IN ('queued','running','awaiting_input','cancelling')")
        .run(now, accountId);
      this.db.prepare("UPDATE workers SET phase = 'needs_recovery', issue = 'Worker runtime stopped; load the saved session before sending', updated_at = ? WHERE account_id = ? AND phase NOT IN ('closed','failed')")
        .run(now, accountId);
      this.db.prepare("UPDATE pending_requests SET state = 'unknown' WHERE worker_id IN (SELECT id FROM workers WHERE account_id = ?) AND state = 'pending'").run(accountId);
      this.db.prepare(`UPDATE worker_event_inbox SET value=json_set(value,'$.state','unknown','$.updatedAt',?,
        '$.issue','Runtime stopped during event dispatch/interruption; no automatic replay')
        WHERE worker_id IN (SELECT id FROM workers WHERE account_id=?) AND
        (json_extract(value,'$.state')='interrupting' OR delivery_id IN (SELECT request_id FROM turns WHERE phase='unknown'))`).run(now, accountId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setSelection(id: string, model: string, effort: string | null): void {
    this.db.prepare("UPDATE workers SET model = ?, effort = ?, updated_at = ? WHERE id = ?").run(model, effort, Date.now(), id);
  }

  turn(id: string): TurnRecord | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, workerId: row.worker_id as string, phase: row.phase as TurnPhase,
      contentClearedAt: row.content_cleared_at as number | null,
      workContext: row.work_context_json ? JSON.parse(row.work_context_json as string) as WorkContext : null,
      stopReason: row.stop_reason as string | null, issue: row.issue as string | null,
      requestId: row.request_id as string, prompt: row.prompt as string | null,
      requestedModel: row.requested_model as string | null, requestedEffort: row.requested_effort as string | null,
      observedSettings: row.observed_settings_json ? JSON.parse(row.observed_settings_json as string) as ObservedSettings : null,
      dispatchedAt: row.dispatched_at as number | null, dispatchedPromptSeq: row.dispatched_prompt_seq as number | null,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number } : null;
  }
  turnPage(workerId: string, afterId: string | undefined, limit: number) {
    const cursor = afterId ? this.db.prepare("SELECT rowid FROM turns WHERE worker_id = ? AND id = ?").get(workerId, afterId) as { rowid: number } | undefined : undefined;
    if (afterId && !cursor) throw new Error("turn cursor does not belong to this worker");
    const rows = this.db.prepare("SELECT id FROM turns WHERE worker_id = ? AND rowid > ? ORDER BY rowid LIMIT ?")
      .all(workerId, cursor?.rowid ?? 0, Math.min(limit, 50) + 1) as Array<{ id: string }>;
    const turns: TurnRecord[] = [];
    let bytes = 0;
    for (const { id } of rows.slice(0, limit)) {
      const turn = this.turn(id)!;
      const size = Buffer.byteLength(JSON.stringify(turn));
      if (turns.length && bytes + size > 200_000) break;
      bytes += size; turns.push(turn);
    }
    return { turns, nextId: turns.at(-1)?.id ?? afterId ?? null, hasMore: rows.length > turns.length };
  }
  observeTurn(id: string, settings: ObservedSettings | null): void {
    if (settings) this.db.prepare("UPDATE turns SET observed_settings_json = ? WHERE id = ?").run(JSON.stringify(settings), id);
  }
  dispatchTurn(id: string, prompt: string): void {
    const turn = this.turn(id)!;
    const seq = this.history.append(turn.workerId, id, "session/prompt", "submitted", { prompt: [{ type: "text", text: prompt }] });
    this.db.prepare("UPDATE turns SET dispatched_at = ?, dispatched_prompt_seq = ? WHERE id = ?").run(Date.now(), seq, id);
    this.observeTurn(id, this.history.settings(turn.workerId));
  }
  turns(workerId: string): TurnRecord[] {
    const rows = this.db.prepare("SELECT id FROM turns WHERE worker_id = ? ORDER BY created_at, rowid").all(workerId) as Array<{ id: string }>;
    return rows.map(({ id }) => this.turn(id)!);
  }
  findTurnRequest(workerId: string, requestId: string, message: string, model: string | null, effort: string | null, workItemId?: string | null): TurnRecord | null {
    const row = this.db.prepare("SELECT id, worker_id, input_digest FROM turns WHERE request_id = ?").get(requestId) as {
      id: string; worker_id: string; input_digest: string;
    } | undefined;
    if (!row) return null;
    if (row.worker_id !== workerId || row.input_digest !== digest([workerId, message, model, effort, ...(workItemId !== undefined ? [workItemId] : [])]))
      throw new OperationRejected("requestId was reused for another turn");
    return this.turn(row.id);
  }
  reserveTurn(workerId: string, requestId: string, message: string, model: string | null, effort: string | null,
    workItemId?: string | null, workContext: WorkContext | null = null, origin: { botId: string; threadId: string } | null = null, observedEvent = false): { turn: TurnRecord; duplicate: boolean } {
    const hash = digest([workerId, message, model, effort, ...(workItemId !== undefined ? [workItemId] : [])]);
    const prior = this.db.prepare("SELECT id, worker_id, input_digest FROM turns WHERE request_id = ?").get(requestId) as { id: string; worker_id: string; input_digest: string } | undefined;
    if (prior) {
      if (prior.worker_id !== workerId || prior.input_digest !== hash) throw new OperationRejected("requestId was reused for another turn");
      return { turn: this.turn(prior.id)!, duplicate: true };
    }
    const worker = this.worker(workerId);
    if (!worker || worker.phase !== "idle") throw new OperationRejected("worker is not idle; inspect its current turn");
    const id = randomUUID();
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO turns (id, worker_id, request_id, input_digest, phase, created_at, updated_at, prompt, requested_model, requested_effort) VALUES (?,?,?,?, 'queued',?,?,?,?,?)")
        .run(id, workerId, requestId, hash, now, now, message, model, effort);
      this.db.prepare("UPDATE turns SET work_context_json=?, origin_bot_id=?, origin_thread_id=? WHERE id=?").run(workContext ? JSON.stringify(workContext) : null, origin?.botId ?? null, origin?.threadId ?? null, id);
      this.db.prepare("UPDATE workers SET current_turn_id = ?, phase = 'running', updated_at = ? WHERE id = ?").run(id, now, workerId);
      this.append(workerId, id, observedEvent ? "event" : "user", message);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { turn: this.turn(id)!, duplicate: false };
  }
  workAdmissions(workItemId: string, after: number, limit: number, owner?: { botId?: string; workerId?: string }) {
    const where = ["w.provider IN ('codex','devin','claude')", "json_extract(t.work_context_json,'$.workItemId')=?", "t.rowid>?"];
    const params: Array<string | number> = [workItemId, after];
    if (owner?.botId) { where.push("w.bot_id=?"); params.push(owner.botId); }
    if (owner?.workerId) { where.push("w.id=?"); params.push(owner.workerId); }
    const rows = this.db.prepare(`SELECT t.rowid AS sequence,t.id FROM turns t JOIN workers w ON w.id=t.worker_id WHERE ${where.join(" AND ")} ORDER BY t.rowid LIMIT ?`)
      .all(...params, limit + 1) as Array<{ sequence: number; id: string }>;
    const entries: WorkAdmission[] = rows.slice(0, limit).map(row => {
      const turn = this.turn(row.id)!, worker = this.worker(turn.workerId)!;
      return { sequence: row.sequence, workerId: worker.id, turnId: turn.id, context: turn.workContext!, botId: worker.botId, threadId: worker.threadId,
        accountId: worker.accountId, provider: worker.provider, model: turn.requestedModel, effort: turn.requestedEffort,
        workerPhase: worker.phase, turnPhase: turn.phase, current: worker.currentTurnId === turn.id, createdAt: turn.createdAt, updatedAt: turn.updatedAt };
    });
    return { entries, nextCursor: rows.length > entries.length ? entries.at(-1)!.sequence : null };
  }
  setTurnPhase(id: string, phase: TurnPhase, stopReason: string | null = null, issue: string | null = null): TurnRecord {
    this.db.prepare("UPDATE turns SET phase = ?, stop_reason = ?, issue = ?, updated_at = ? WHERE id = ?")
      .run(phase, stopReason, issue, Date.now(), id);
    if (phase === "unknown") this.db.prepare(`UPDATE worker_event_inbox SET value=json_set(value,'$.state','unknown','$.turnId',?,
      '$.issue','Native event turn outcome unknown; inspect before any further automatic event input') WHERE delivery_id=(SELECT request_id FROM turns WHERE id=?)`).run(id, id);
    return this.turn(id)!;
  }
  completeTurn(id: string, phase: "completed" | "cancelled" | "failed" | "unknown", stopReason: string | null, issue: string | null): void {
    const turn = this.turn(id);
    if (!turn) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setTurnPhase(id, phase, stopReason, issue);
      const workerPhase: WorkerPhase = phase === "unknown" ? "needs_recovery" : "idle";
      this.setWorkerPhase(turn.workerId, workerPhase, issue);
      this.db.prepare("UPDATE pending_requests SET state = 'unknown' WHERE turn_id = ? AND state = 'pending'").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  append(workerId: string, turnId: string, kind: string, text: string): void {
    // Conversation text is a durable source for forward attention capture. The
    // diagnostic/tool budget must not silently drop human or assistant messages.
    if (kind === "user" || kind === "agent") {
      const insert = this.db.prepare("INSERT INTO transcript (worker_id, turn_id, kind, text, at) VALUES (?,?,?,?,?)");
      for (let offset = 0; offset < text.length; offset += 16_000) insert.run(workerId, turnId, kind, text.slice(offset, offset + 16_000), Date.now());
      return;
    }
    const size = this.db.prepare("SELECT COALESCE(SUM(length(text)),0) AS bytes FROM transcript WHERE turn_id = ?").get(turnId) as { bytes: number };
    if (size.bytes >= 1_000_000) return;
    const value = text.slice(0, 1_000_000 - size.bytes);
    const insert = this.db.prepare("INSERT INTO transcript (worker_id, turn_id, kind, text, at) VALUES (?,?,?,?,?)");
    for (let offset = 0; offset < value.length; offset += 16_000)
      insert.run(workerId, turnId, kind, value.slice(offset, offset + 16_000), Date.now());
    if (value.length !== text.length) insert.run(workerId, turnId, "notice", "Transcript limit reached; later chunks were not retained", Date.now());
  }
  read(workerId: string, afterSeq: number, limit: number): { entries: TranscriptEntry[]; nextSeq: number; hasMore: boolean } {
    const entries = this.db.prepare("SELECT seq, worker_id, turn_id, kind, text, at FROM transcript WHERE worker_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(workerId, afterSeq, limit + 1) as Array<{ seq: number; worker_id: string; turn_id: string; kind: string; text: string; at: number }>;
    const page: TranscriptEntry[] = [];
    let bytes = 0;
    for (const { worker_id, turn_id, ...entry } of entries.slice(0, limit)) {
      const value = { ...entry, workerId: worker_id, turnId: turn_id };
      const size = Buffer.byteLength(JSON.stringify(value));
      if (page.length && bytes + size > 200_000) break;
      bytes += size; page.push(value);
    }
    return { entries: page, nextSeq: page.at(-1)?.seq ?? afterSeq, hasMore: entries.length > page.length };
  }

  addPermission(workerId: string, turnId: string, acpRequestId: number, title: string, options: PendingRequest["options"],
    runtimeInstance: string | null = null, toolCallId: string | null = null, recordSeq: number | null = null): PendingRequest {
    const id = randomUUID();
    this.db.prepare("INSERT INTO pending_requests (id, worker_id, turn_id, acp_request_id, kind, title, options_json, state, runtime_instance, tool_call_id, record_seq) VALUES (?,?,?,?,'permission',?,?,'pending',?,?,?)")
      .run(id, workerId, turnId, acpRequestId, title.slice(0, 2_000), JSON.stringify(options), runtimeInstance, toolCallId, recordSeq);
    this.setTurnPhase(turnId, "awaiting_input");
    this.setWorkerPhase(workerId, "awaiting_input");
    return this.permission(id)!;
  }
  permission(id: string): PendingRequest | null {
    const row = this.db.prepare("SELECT * FROM pending_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, workerId: row.worker_id as string, turnId: row.turn_id as string,
      acpRequestId: row.acp_request_id as number, kind: "permission", title: row.title as string,
      runtimeInstance: row.runtime_instance as string | null, toolCallId: row.tool_call_id as string | null, recordSeq: row.record_seq as number | null,
      options: JSON.parse(row.options_json as string) as PendingRequest["options"], state: row.state as PendingRequest["state"] } : null;
  }
  pending(workerId: string): PendingRequest[] {
    const rows = this.db.prepare("SELECT id FROM pending_requests WHERE worker_id = ? AND state = 'pending'").all(workerId) as Array<{ id: string }>;
    return rows.map(({ id }) => this.permission(id)!);
  }
  cancelPending(workerId: string): void {
    this.db.prepare("UPDATE pending_requests SET state = 'unknown' WHERE worker_id = ? AND state = 'pending'").run(workerId);
  }
  branches() { return this.db.prepare("SELECT worker_id AS workerId,repo,branch,base_commit AS baseCommit,collected_at AS collectedAt FROM worker_branches ORDER BY worker_id").all() as Array<{ workerId: string; repo: string; branch: string; baseCommit: string; collectedAt: number | null }>; }
  collectBranch(id: string) { this.db.prepare("UPDATE worker_branches SET collected_at=? WHERE worker_id=?").run(Date.now(), id); }
  contentRevision(id: string) {
    return stateHash([this.worker(id), this.turns(id), this.db.prepare("SELECT * FROM transcript WHERE worker_id=? ORDER BY seq").all(id),
      this.db.prepare("SELECT * FROM worker_records WHERE worker_id=? ORDER BY seq").all(id), this.db.prepare("SELECT * FROM pending_requests WHERE worker_id=? ORDER BY id").all(id),
      this.db.prepare("SELECT * FROM worker_event_inbox WHERE worker_id=? ORDER BY delivery_id").all(id)]);
  }
  clearContent(id: string) {
    const worker = this.worker(id); if (!worker || worker.phase !== "closed") throw new Error("Worker must be closed before transcript maintenance");
    const now = Date.now();
    this.db.prepare("UPDATE transcript SET text='' WHERE worker_id=?").run(id);
    this.db.prepare("UPDATE turns SET prompt=NULL,content_cleared_at=? WHERE worker_id=?").run(now, id);
    this.db.prepare("UPDATE pending_requests SET title='',options_json='[]' WHERE worker_id=?").run(id);
    this.db.prepare("UPDATE worker_event_inbox SET value=json_set(value,'$.input.text','') WHERE worker_id=?").run(id);
    this.history.clearContent(id);
    this.db.prepare("UPDATE workers SET content_cleared_at=?,updated_at=? WHERE id=?").run(now, now, id);
  }
  resolvePermission(id: string): void {
    this.db.prepare("UPDATE pending_requests SET state = 'responded' WHERE id = ? AND state = 'pending'").run(id);
    const permission = this.permission(id)!;
    if (this.pending(permission.workerId).length === 0) {
      this.setTurnPhase(permission.turnId, "running");
      this.setWorkerPhase(permission.workerId, "running");
    }
  }
  removeWorker(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM pending_requests WHERE worker_id = ?").run(id);
      this.db.prepare("DELETE FROM worker_event_inbox WHERE worker_id = ?").run(id);
      this.history.remove(id);
      this.db.prepare("DELETE FROM transcript WHERE worker_id = ?").run(id);
      this.db.prepare("DELETE FROM turns WHERE worker_id = ?").run(id);
      this.db.prepare("DELETE FROM workers WHERE id = ?").run(id);
      this.settings.remove(`worker:${id}`);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
