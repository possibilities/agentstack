import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export type Job = { id: string; operation: string; state: "running" | "completed" | "failed" | "unknown"; stage: string; createdAt: number; updatedAt: number; error: string | null };
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ClientState {
  readonly root: string;
  readonly db: DatabaseSync;
  constructor(root = process.env.STACK_CLIENT_STATE_DIR ?? join(homedir(), ".local", "share", "stack-client")) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.check(this.root, true);
    const file = join(this.root, "client.db");
    try { this.check(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,digest TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,stage TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,error TEXT);
    `);
  }
  private check(path: string, directory = false) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o077)
      || process.getuid && info.uid !== process.getuid()) throw new Error("client_state_permissions");
  }
  read<T>(key: string): { revision: number; value: T } | null {
    const row = this.db.prepare("SELECT revision,body FROM records WHERE key=?").get(key) as { revision: number; body: string } | undefined;
    return row ? { revision: row.revision, value: JSON.parse(row.body) } : null;
  }
  write(key: string, value: unknown) {
    this.db.prepare("INSERT INTO records VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET revision=revision+1,body=excluded.body").run(key, JSON.stringify(value));
  }
  transaction<T>(call: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = call(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  remove(key: string, revision?: number) {
    const result = this.db.prepare(`DELETE FROM records WHERE key=?${revision === undefined ? "" : " AND revision=?"}`).run(...(revision === undefined ? [key] : [key, revision]));
    if (!result.changes) throw new Error("revision_conflict");
  }
  records<T>(prefix: string) {
    return (this.db.prepare("SELECT key,revision,body FROM records WHERE key LIKE ? ORDER BY key").all(`${prefix}%`) as Array<{ key: string; revision: number; body: string }>).map(row => ({ key: row.key, revision: row.revision, value: JSON.parse(row.body) as T }));
  }
  admit(id: string, operation: string, input: unknown): { job: Job; duplicate: boolean } {
    const old = this.job(id);
    if (old) {
      const row = this.db.prepare("SELECT digest FROM jobs WHERE id=?").get(id)!;
      if (row.digest !== digest([operation, input])) throw new Error("request_conflict");
      return { job: old, duplicate: true };
    }
    if (this.db.prepare("SELECT 1 FROM jobs WHERE state='running'").get()) throw new Error("client_job_in_progress");
    const now = Date.now();
    this.db.prepare("INSERT INTO jobs VALUES(?,?,?,'running','admitted',?,?,NULL)").run(id, digest([operation, input]), operation, now, now);
    return { job: this.job(id)!, duplicate: false };
  }
  job(id: string): Job | null { return this.db.prepare("SELECT id,operation,state,stage,createdAt,updatedAt,error FROM jobs WHERE id=?").get(id) as Job | undefined ?? null; }
  jobs(): Job[] { return this.db.prepare("SELECT id,operation,state,stage,createdAt,updatedAt,error FROM jobs ORDER BY createdAt DESC LIMIT 50").all() as Job[]; }
  progress(id: string, stage: string, state: Job["state"] = "running", error: string | null = null) {
    this.db.prepare("UPDATE jobs SET stage=?,state=?,updatedAt=?,error=? WHERE id=?").run(stage, state, Date.now(), error, id);
  }
  interrupted() { this.db.prepare("UPDATE jobs SET state='unknown',stage='interrupted',error='host_interrupted',updatedAt=? WHERE state='running'").run(Date.now()); }
  close() { this.db.close(); }
}
