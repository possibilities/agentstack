import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { CompleteInput, CompleteOutput, RequestRecord, RequestState, RequestSummary } from "./schema.js";

type Run = { id: string; digest: string; input: string; started: number; finished: number | null; state: string; result: string | null; error: string | null };
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
  }
  reserve(id: string, input: CompleteInput): CompleteOutput | null {
    const json = JSON.stringify(input), digest = createHash("sha256").update(json).digest("hex");
    const prior = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as { digest: string; state: string; result: string; error: string } | undefined;
    if (prior) {
      if (prior.digest !== digest) throw new Error("infer_request_conflict");
      if (prior.state === "completed") return JSON.parse(prior.result);
      throw new Error(prior.state === "failed" ? prior.error : `infer_outcome_unknown:${id}`);
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
    this.db.prepare("INSERT INTO events(run_id,at,kind,data) VALUES(?,?,?,?)").run(id,Date.now(),kind,JSON.stringify(data));
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
    };
  }
}
