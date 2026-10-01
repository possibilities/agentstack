import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { StateJournal, clearStateFiles, listStateFiles, readStateFile, snapshotStateFiles, stateHash,
  type StateApplyInput, type FileSnapshot } from "@stack/api";

export const launchId = z.string().regex(/^(codex|claude|opencode)-[A-Za-z0-9]{6}$/);
const launchLock = z.strictObject({ version: z.literal(1), pid: z.number().int().positive(), birth: z.string().min(1), state: z.enum(["preparing", "running", "exited"]) });
export async function processBirth(pid: number): Promise<string> {
  const { stdout } = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 4096 });
  const birth = stdout.trim(); if (!birth) throw new Error("launch process identity unavailable"); return birth;
}
type Prepared = { ids: string[]; snapshot: FileSnapshot };

export class RoleLaunchState {
  readonly root: string;
  readonly journal: StateJournal;
  private applying = false;
  constructor(stateDir: string) {
    this.root = join(stateDir, "roles", "inject"); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.journal = new StateJournal(join(stateDir, "roles", "maintenance.sqlite"), "roles");
  }
  close() { this.journal.close(); }
  private async inspect(id: string) {
    launchId.parse(id);
    try {
      const read = await readStateFile(this.root, { path: `${id}/launch-lock.json`, offset: 0, length: 4096 });
      if (read.nextOffset !== null) throw new Error("launch lock exceeds bound");
      const lock = launchLock.parse(JSON.parse(Buffer.from(read.data, "base64").toString("utf8")));
      try {
        process.kill(lock.pid, 0);
        if (await processBirth(lock.pid) === lock.birth) return { id, state: "live" as const, issue: "Launching process is alive" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { id, state: "unknown" as const, issue: "Launch process liveness unavailable" };
      }
      return lock.state === "exited" ? { id, state: "retained" as const, issue: null }
        : { id, state: "unknown" as const, issue: "Launch interrupted before confirming native teardown; retained for investigation" };
    } catch { return { id, state: "unknown" as const, issue: "Missing or invalid launch lock; legacy/foreign content is not adopted" }; }
  }
  async list(input: { offset: number; limit: number; revision?: string }) {
    const page = await listStateFiles(this.root, { path: ".", ...input });
    const launches = await Promise.all(page.entries.filter(entry => entry.type === "directory" && launchId.safeParse(entry.path).success).map(async entry => ({ ...await this.inspect(entry.path), modifiedAt: entry.modifiedAt })));
    return { launches, revision: page.revision, nextOffset: page.nextOffset };
  }
  private async prepare(ids: string[]) {
    ids = [...new Set(ids)].sort(); ids.forEach(id => launchId.parse(id));
    const rows = await Promise.all(ids.map(id => this.inspect(id)));
    const snapshot = await snapshotStateFiles(this.root, { paths: ids });
    return { preview: { subject: null, action: "launch_clear", revision: stateHash([rows, snapshot]), resources: ids,
      blockedBy: [...rows.filter(row => row.state !== "retained").map(row => `${row.id}: ${row.issue}`),
        ...snapshot.entries.filter(entry => entry.type === "symlink" || entry.type === "special").map(entry => `${entry.path}: symlink or special file is not clearable`)],
      retained: ["Bot and Worker materializations, current Role configuration, shims, external native history/credentials and backups remain", "Minimal maintenance receipts and any unresolved retirement quarantine remain"],
      regeneration: ["An explicitly selected later Role injection creates a new launch directory; clearing does not launch or resume a harness"] }, payload: { ids, snapshot } };
  }
  async plan(ids: string[]) { const prepared = await this.prepare(ids); return this.journal.plan(prepared.preview, prepared.payload); }
  async clear(input: StateApplyInput) {
    const prior = this.journal.existing(input); if (prior) return prior;
    if (this.applying) throw new Error("Role launch maintenance is already observing/applying; read its receipt or retry later");
    this.applying = true;
    try {
      const { plan, payload } = this.journal.getPlan(input.planId), selection = payload as Prepared;
      const current = await this.prepare(selection.ids);
      if (plan.action !== "launch_clear" || plan.revision !== current.preview.revision) throw new Error("Role launch changed; prepare again");
      if (plan.blockedBy.length || current.preview.blockedBy.length) throw new Error(current.preview.blockedBy.join("; ") || plan.blockedBy.join("; "));
      this.journal.begin(input, plan);
      try {
        const result = await clearStateFiles(this.root, { paths: selection.ids }, selection.snapshot);
        return this.journal.finish(input.requestId, result.error ? "partial" : "completed", selection.ids.map(resource => ({ resource,
          outcome: result.removed.includes(resource) ? "removed" : "unknown", detail: result.error ?? "Exact exited launch directory removed; external native history remains" })));
      } catch { return this.journal.finish(input.requestId, "unknown", selection.ids.map(resource => ({ resource, outcome: "unknown", detail: "Filesystem helper interrupted; inspect exact resources/quarantine; this request will not execute again" }))); }
    } finally { this.applying = false; }
  }
}
