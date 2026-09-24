import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkerPhase = "preparing" | "idle" | "running" | "awaiting_input" | "cancelling" | "closed" | "failed" | "needs_recovery";
export type TurnPhase = "queued" | "running" | "awaiting_input" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown";
export type WorkerRecord = {
  id: string; botId: string; threadId: string; accountId: string; provider: "codex" | "grok" | "devin";
  model: string; effort: string | null; repo: string; cwd: string | null; branch: string | null; baseCommit: string | null;
  sourceDirty: boolean; roleRevision: number | null; acpSessionId: string | null; phase: WorkerPhase;
  currentTurnId: string | null; issue: string | null; createdAt: number; updatedAt: number;
};
export type TurnRecord = { id: string; workerId: string; phase: TurnPhase; stopReason: string | null; issue: string | null;
  createdAt: number; updatedAt: number };
export type TranscriptEntry = { seq: number; workerId: string; turnId: string; kind: string; text: string; at: number };
export type PendingRequest = { id: string; workerId: string; turnId: string; acpRequestId: number; kind: "permission";
  title: string; options: Array<{ optionId: string; name: string; kind: string }>; state: "pending" | "responded" | "unknown" };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class WorkerLedger {
  private readonly db: DatabaseSync;

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
        source_dirty INTEGER NOT NULL DEFAULT 0, role_revision INTEGER, acp_session_id TEXT, phase TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS transcript_worker_seq ON transcript(worker_id, seq);
      CREATE TABLE IF NOT EXISTS pending_requests (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id), turn_id TEXT NOT NULL REFERENCES turns(id),
        acp_request_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        options_json TEXT NOT NULL, state TEXT NOT NULL
      );
    `);
    this.db.prepare("UPDATE workers SET phase = 'needs_recovery', issue = 'Owner restarted during a worker operation; inspect before resuming', updated_at = ? WHERE phase IN ('preparing','running','awaiting_input','cancelling')").run(Date.now());
    this.db.prepare("UPDATE turns SET phase = 'unknown', issue = 'Turn outcome is unknown after owner restart', updated_at = ? WHERE phase IN ('queued','running','awaiting_input','cancelling')").run(Date.now());
    this.db.prepare("UPDATE pending_requests SET state = 'unknown' WHERE state = 'pending'").run();
    this.db.prepare("UPDATE workers SET phase = 'needs_recovery', issue = 'Owner restarted; load the saved ACP session before sending', updated_at = ? WHERE phase = 'idle' AND acp_session_id IS NOT NULL").run(Date.now());
  }

  close(): void { this.db.close(); }

  private workerRow(row: Record<string, unknown>): WorkerRecord {
    return {
      id: row.id as string, botId: row.bot_id as string, threadId: row.thread_id as string,
      accountId: row.account_id as string, provider: row.provider as WorkerRecord["provider"],
      model: row.model as string, effort: row.effort as string | null, repo: row.repo as string,
      cwd: row.cwd as string | null, branch: row.branch as string | null, baseCommit: row.base_commit as string | null,
      sourceDirty: Boolean(row.source_dirty), roleRevision: row.role_revision as number | null,
      acpSessionId: row.acp_session_id as string | null, phase: row.phase as WorkerPhase,
      currentTurnId: row.current_turn_id as string | null, issue: row.issue as string | null,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number,
    };
  }
  worker(id: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.workerRow(row) : null;
  }
  workers(botId?: string): WorkerRecord[] {
    const rows = (botId
      ? this.db.prepare("SELECT * FROM workers WHERE bot_id = ? ORDER BY created_at DESC").all(botId)
      : this.db.prepare("SELECT * FROM workers ORDER BY created_at DESC").all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.workerRow(row));
  }

  findStart(requestId: string, input: unknown): { worker: WorkerRecord; turn: TurnRecord } | null {
    const row = this.db.prepare("SELECT id, input_digest FROM workers WHERE request_id = ?").get(requestId) as { id: string; input_digest: string } | undefined;
    if (!row) return null;
    if (row.input_digest !== digest(input)) throw new Error("requestId was reused for another worker request");
    const first = this.db.prepare("SELECT id FROM turns WHERE request_id = ?").get(requestId) as { id: string };
    return { worker: this.worker(row.id)!, turn: this.turn(first.id)! };
  }
  startByRequestId(requestId: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT id FROM workers WHERE request_id = ?").get(requestId) as { id: string } | undefined;
    return row ? this.worker(row.id) : null;
  }

  reserve(input: { requestId: string; botId: string; threadId: string; accountId: string; provider: WorkerRecord["provider"];
    model: string; effort: string | null; repo: string; baseRef: string | null; task: string }): { worker: WorkerRecord; turn: TurnRecord; duplicate: boolean } {
    const inputDigest = digest(input);
    const prior = this.db.prepare("SELECT id, input_digest FROM workers WHERE request_id = ?").get(input.requestId) as { id: string; input_digest: string } | undefined;
    if (prior) {
      if (prior.input_digest !== inputDigest) throw new Error("requestId was reused for another worker request");
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
          join(this.stateDir, "workers", "worktrees", id), `agentstack-worker-${id}`, turnId, now, now);
      this.db.prepare("INSERT INTO turns (id, worker_id, request_id, input_digest, phase, created_at, updated_at) VALUES (?,?,?,?, 'queued',?,?)")
        .run(turnId, id, input.requestId, inputDigest, now, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { worker: this.worker(id)!, turn: this.turn(turnId)!, duplicate: false };
  }

  setWorktree(id: string, claim: { repo: string; cwd: string; branch: string; baseCommit: string; sourceDirty: boolean; roleRevision: number }): WorkerRecord {
    this.db.prepare("UPDATE workers SET repo = ?, cwd = ?, branch = ?, base_commit = ?, source_dirty = ?, role_revision = ?, updated_at = ? WHERE id = ?")
      .run(claim.repo, claim.cwd, claim.branch, claim.baseCommit, Number(claim.sourceDirty), claim.roleRevision, Date.now(), id);
    return this.worker(id)!;
  }
  setSession(id: string, acpSessionId: string): WorkerRecord {
    this.db.prepare("UPDATE workers SET acp_session_id = ?, phase = 'idle', issue = NULL, updated_at = ? WHERE id = ?")
      .run(acpSessionId, Date.now(), id);
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
      this.db.prepare("UPDATE turns SET phase = 'unknown', issue = 'ACP process stopped before the turn outcome was confirmed', updated_at = ? WHERE worker_id IN (SELECT id FROM workers WHERE account_id = ?) AND phase IN ('queued','running','awaiting_input','cancelling')")
        .run(now, accountId);
      this.db.prepare("UPDATE workers SET phase = 'needs_recovery', issue = 'ACP process stopped; load the saved session before sending', updated_at = ? WHERE account_id = ? AND phase NOT IN ('closed','failed')")
        .run(now, accountId);
      this.db.prepare("UPDATE pending_requests SET state = 'unknown' WHERE worker_id IN (SELECT id FROM workers WHERE account_id = ?) AND state = 'pending'").run(accountId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  setSelection(id: string, model: string, effort: string | null): void {
    this.db.prepare("UPDATE workers SET model = ?, effort = ?, updated_at = ? WHERE id = ?").run(model, effort, Date.now(), id);
  }

  turn(id: string): TurnRecord | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, workerId: row.worker_id as string, phase: row.phase as TurnPhase,
      stopReason: row.stop_reason as string | null, issue: row.issue as string | null,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number } : null;
  }
  turns(workerId: string): TurnRecord[] {
    const rows = this.db.prepare("SELECT id FROM turns WHERE worker_id = ? ORDER BY created_at, rowid").all(workerId) as Array<{ id: string }>;
    return rows.map(({ id }) => this.turn(id)!);
  }
  findTurnRequest(workerId: string, requestId: string, message: string, model: string | null, effort: string | null): TurnRecord | null {
    const row = this.db.prepare("SELECT id, worker_id, input_digest FROM turns WHERE request_id = ?").get(requestId) as {
      id: string; worker_id: string; input_digest: string;
    } | undefined;
    if (!row) return null;
    if (row.worker_id !== workerId || row.input_digest !== digest([workerId, message, model, effort]))
      throw new Error("requestId was reused for another turn");
    return this.turn(row.id);
  }
  reserveTurn(workerId: string, requestId: string, message: string, model: string | null, effort: string | null): { turn: TurnRecord; duplicate: boolean } {
    const hash = digest([workerId, message, model, effort]);
    const prior = this.db.prepare("SELECT id, worker_id, input_digest FROM turns WHERE request_id = ?").get(requestId) as { id: string; worker_id: string; input_digest: string } | undefined;
    if (prior) {
      if (prior.worker_id !== workerId || prior.input_digest !== hash) throw new Error("requestId was reused for another turn");
      return { turn: this.turn(prior.id)!, duplicate: true };
    }
    const worker = this.worker(workerId);
    if (!worker || worker.phase !== "idle") throw new Error("worker is not idle; inspect its current turn");
    const id = randomUUID();
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO turns (id, worker_id, request_id, input_digest, phase, created_at, updated_at) VALUES (?,?,?,?, 'queued',?,?)")
        .run(id, workerId, requestId, hash, now, now);
      this.db.prepare("UPDATE workers SET current_turn_id = ?, phase = 'running', updated_at = ? WHERE id = ?").run(id, now, workerId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { turn: this.turn(id)!, duplicate: false };
  }
  setTurnPhase(id: string, phase: TurnPhase, stopReason: string | null = null, issue: string | null = null): TurnRecord {
    this.db.prepare("UPDATE turns SET phase = ?, stop_reason = ?, issue = ?, updated_at = ? WHERE id = ?")
      .run(phase, stopReason, issue, Date.now(), id);
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
    const hasMore = entries.length > limit;
    const page = entries.slice(0, limit).map(({ worker_id, turn_id, ...entry }) => ({ ...entry, workerId: worker_id, turnId: turn_id }));
    return { entries: page, nextSeq: page.at(-1)?.seq ?? afterSeq, hasMore };
  }

  addPermission(workerId: string, turnId: string, acpRequestId: number, title: string, options: PendingRequest["options"]): PendingRequest {
    const id = randomUUID();
    this.db.prepare("INSERT INTO pending_requests (id, worker_id, turn_id, acp_request_id, kind, title, options_json, state) VALUES (?,?,?,?,'permission',?,?,'pending')")
      .run(id, workerId, turnId, acpRequestId, title.slice(0, 2_000), JSON.stringify(options));
    this.setTurnPhase(turnId, "awaiting_input");
    this.setWorkerPhase(workerId, "awaiting_input");
    return this.permission(id)!;
  }
  permission(id: string): PendingRequest | null {
    const row = this.db.prepare("SELECT * FROM pending_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: row.id as string, workerId: row.worker_id as string, turnId: row.turn_id as string,
      acpRequestId: row.acp_request_id as number, kind: "permission", title: row.title as string,
      options: JSON.parse(row.options_json as string) as PendingRequest["options"], state: row.state as PendingRequest["state"] } : null;
  }
  pending(workerId: string): PendingRequest[] {
    const rows = this.db.prepare("SELECT id FROM pending_requests WHERE worker_id = ? AND state = 'pending'").all(workerId) as Array<{ id: string }>;
    return rows.map(({ id }) => this.permission(id)!);
  }
  cancelPending(workerId: string): void {
    this.db.prepare("UPDATE pending_requests SET state = 'unknown' WHERE worker_id = ? AND state = 'pending'").run(workerId);
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
      this.db.prepare("DELETE FROM transcript WHERE worker_id = ?").run(id);
      this.db.prepare("DELETE FROM turns WHERE worker_id = ?").run(id);
      this.db.prepare("DELETE FROM workers WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
