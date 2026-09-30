import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { StateJournal, stateHash, type StateApplyInput } from "@stack/api";
import type { CompleteInput, CompleteOutput, RequestRecord, RequestState, RequestSummary } from "./schema.js";

type Run = { id: string; digest: string; input: string; started: number; finished: number | null; state: string; result: string | null; error: string | null; content_cleared_at: string | null };
const previewChars = 160;
const preview = (text: string) => text.length > previewChars ? `${text.slice(0, previewChars - 1)}…` : text;
const digestOf = (input: CompleteInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

/**
 * The durable inference request ledger: one run per request ID with its exact
 * input, outcome and dispatch evidence. A request ID is never sent to the
 * provider twice, and a run finishes exactly once.
 */
export class InferTraces {
  private db: DatabaseSync;
  readonly maintenance: StateJournal;
  constructor(stateDir: string) {
    const dir = join(stateDir, "infer");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "traces.sqlite");
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, digest TEXT NOT NULL, input TEXT NOT NULL,
        started INTEGER NOT NULL, finished INTEGER, state TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
      UPDATE runs SET state='unknown',error='infer_interrupted',finished=${Date.now()} WHERE state='running';`);
    if (!(this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).some(row => row.name === "content_cleared_at"))
      this.db.exec("ALTER TABLE runs ADD COLUMN content_cleared_at TEXT");
    this.maintenance = new StateJournal(this.db, "infer");
  }
  reserve(id: string, input: CompleteInput): CompleteOutput | null {
    const json = JSON.stringify(input), digest = createHash("sha256").update(json).digest("hex");
    const prior = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Run | undefined;
    if (prior) {
      if (prior.digest !== digest) throw new Error("infer_request_conflict");
      if (prior.content_cleared_at) throw new Error(`infer_content_cleared:${id}`);
      if (prior.state === "completed") return JSON.parse(prior.result!);
      throw new Error(prior.state === "failed" ? prior.error ?? "infer_failed" : `infer_outcome_unknown:${id}`);
    }
    this.db.prepare("INSERT INTO runs(id,digest,input,started,state) VALUES(?,?,?,?,'running')").run(id,digest,json,Date.now());
    return null;
  }
  /** The run already recorded for this ID in any state, or null; reusing an ID for other input is refused. */
  find(id: string, input: CompleteInput): RequestRecord | null {
    const prior = this.run(id);
    if (!prior) return null;
    if (prior.digest !== digestOf(input)) throw new Error("infer_request_conflict");
    return this.record(prior);
  }
  event(id: string, kind: string, data: unknown): void {
    this.db.prepare("INSERT INTO events(run_id,at,kind,data) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM runs WHERE id=? AND content_cleared_at IS NULL)").run(id,Date.now(),kind,JSON.stringify(data),id);
  }
  /** Records the terminal outcome once; a late outcome never overwrites one already recorded, such as after a restart. */
  finish(id: string, result: CompleteOutput | null, error: string | null): void {
    this.db.prepare("UPDATE runs SET state=?,finished=?,result=?,error=? WHERE id=? AND state='running'").run(
      result ? "completed" : error?.includes("outcome_unknown") ? "unknown" : "failed", Date.now(), result ? JSON.stringify(result) : null, error, id);
  }
  get(id: string): RequestRecord | null {
    const run = this.run(id);
    return run ? this.record(run) : null;
  }
  /** Newest first by admission; `nextBefore` continues the listing. */
  list(limit: number, before?: number): { requests: RequestSummary[]; nextBefore: number | null } {
    const rows = this.db.prepare("SELECT rowid AS seq, * FROM runs WHERE rowid < ? ORDER BY rowid DESC LIMIT ?")
      .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1) as Array<Run & { seq: number }>;
    const page = rows.slice(0, limit);
    return {
      requests: page.map((row) => {
        const { instructions: _, input, text, ...fields } = this.record(row);
        return { ...fields, inputPreview: preview(input), textPreview: text === null ? null : preview(text), textChars: text?.length ?? null };
      }),
      nextBefore: rows.length > limit ? page.at(-1)!.seq : null,
    };
  }
  read(id: string, offset: number, limit: number, expectedRevision?: string) {
    const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!run) throw new Error("unknown inference trace");
    const events = this.db.prepare("SELECT seq,at,kind,data FROM events WHERE run_id=? ORDER BY seq").all(id)
      .map(({data,...row}) => ({...row,data:JSON.parse(String(data))}));
    const text = JSON.stringify({ schemaVersion: 1, run: {...run,input:JSON.parse(String(run.input)),result:run.result ? JSON.parse(String(run.result)) : null}, events });
    const revision=createHash("sha256").update(text).digest("hex");
    if(expectedRevision&&expectedRevision!==revision)throw new Error("infer_trace_changed");
    return { text:text.slice(offset,offset+limit), nextOffset:Math.min(offset+limit,text.length), totalChars:text.length, complete:run.state !== "running", revision };
  }
  close() { this.db.close(); }

  private selected(ids: string[]) {
    return [...new Set(ids)].sort().map(id => {
      const row = this.run(id); if (!row) throw new Error(`unknown inference request: ${id}`);
      const events = this.db.prepare("SELECT seq,at,kind,data FROM events WHERE run_id=? ORDER BY seq").all(id);
      return { row, revision: stateHash([row, events]) };
    });
  }
  historyPlan(ids: string[]) {
    const selected = this.selected(ids);
    return this.maintenance.plan({ subject: null, action: "content_clear", revision: stateHash(selected.map(item => item.revision)), resources: selected.map(item => item.row.id),
      blockedBy: selected.filter(item => item.row.state === "running").map(item => `Inference ${item.row.id} is still running`),
      retained: ["Request IDs and original input digests prevent redispatch", "Account, model, effort, usage, timing and terminal state remain; unknown stays unknown", "Signal inputs and upstream source copies are independently owned"],
      regeneration: ["Retrying the same ID never restores cleared content or dispatches again"] }, { ids: selected.map(item => item.row.id) });
  }
  historyClear(input: StateApplyInput) {
    return this.maintenance.atomic(input, (plan, payload) => {
      const selected = this.selected((payload as { ids: string[] }).ids);
      if (plan.action !== "content_clear" || plan.revision !== stateHash(selected.map(item => item.revision))) throw new Error("inference state changed; prepare a new plan");
      if (selected.some(item => item.row.state === "running")) throw new Error("inference still running");
    }, payload => (payload as { ids: string[] }).ids.map(id => {
      const row = this.run(id)!, saved = JSON.parse(row.input) as CompleteInput;
      const result = row.result ? JSON.parse(row.result) as CompleteOutput : null;
      this.db.prepare("UPDATE runs SET input=?,result=?,error=NULL,content_cleared_at=COALESCE(content_cleared_at,?) WHERE id=?").run(
        JSON.stringify({ ...saved, instructions: "", input: "" }), result ? JSON.stringify({ ...result, text: "" }) : null, new Date().toISOString(), id);
      this.db.prepare("DELETE FROM events WHERE run_id=?").run(id);
      return { resource: id, outcome: "removed" as const, detail: "Input/instructions, output text, errors and trace event payloads cleared; minimal dispatch receipt retained" };
    }));
  }

  private run(id: string): Run | null {
    return (this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Run | undefined) ?? null;
  }
  private record(run: Run): RequestRecord {
    const input = JSON.parse(run.input) as CompleteInput;
    const result = run.result ? JSON.parse(run.result) as CompleteOutput : null;
    return {
      requestId: run.id, accountId: input.accountId, model: input.model, effort: input.effort, maxOutputTokens: input.maxOutputTokens,
      state: run.state as RequestState, error: run.error, reportedModel: result?.reportedModel ?? null, usage: result?.usage ?? null,
      createdAt: new Date(run.started).toISOString(), finishedAt: run.finished === null ? null : new Date(run.finished).toISOString(),
      instructions: input.instructions, input: input.input, text: result?.text ?? null,
      contentClearedAt: run.content_cleared_at,
    };
  }
}
