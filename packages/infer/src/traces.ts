import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { CompleteInput, CompleteOutput } from "./schema.js";

/** Durable dispatch evidence. A request ID is never sent to the provider twice. */
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
      UPDATE runs SET state='unknown',error='infer_interrupted' WHERE state='running';`);
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
  event(id: string, kind: string, data: unknown): void {
    this.db.prepare("INSERT INTO events(run_id,at,kind,data) VALUES(?,?,?,?)").run(id,Date.now(),kind,JSON.stringify(data));
  }
  finish(id: string, result: CompleteOutput | null, error: string | null): void {
    this.db.prepare("UPDATE runs SET state=?,finished=?,result=?,error=? WHERE id=?").run(
      result ? "completed" : error?.includes("outcome_unknown") ? "unknown" : "failed", Date.now(), result ? JSON.stringify(result) : null, error, id);
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
}
