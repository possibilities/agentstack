import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clearStateFilesSync, snapshotStateFilesSync, stateHash, type StateApplyInput, type StateJournal } from "@stack/api";

const scopeSchema = z.enum(["artifact", "bundle"]);
type Scope = z.infer<typeof scopeSchema>;
type Claim = { id: string; scope: Scope; path: string; pid: number; identity: string | null; createdAt: string; releasedAt: string | null; collectedAt: string | null };
export const publicationSelection = z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) });
const identity = (path: string) => { const stat = lstatSync(path); return stateHash([stat.dev, stat.ino, stat.mode]); };

/** Durable provenance for temporary paths. A dead writer is not permission to
 * replay its publication: maintenance removes temporary bytes only. */
export class Publications {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly roots: Record<Scope, string>) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS publication_claims(id TEXT PRIMARY KEY,scope TEXT NOT NULL,path TEXT NOT NULL,pid INTEGER NOT NULL,
        identity TEXT,createdAt TEXT NOT NULL,releasedAt TEXT,collectedAt TEXT);`);
  }
  close() { this.db.close(); }
  begin(scope: Scope) {
    const id = randomUUID(), path = scope === "artifact" ? `.publication-${id}` : id, root = this.roots[scope];
    this.db.prepare("INSERT INTO publication_claims VALUES(?,?,?,?,?,?,NULL,NULL)").run(id, scope, path, process.pid, null, new Date().toISOString());
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = join(root, path); mkdirSync(directory, { mode: 0o700 });
    this.db.prepare("UPDATE publication_claims SET identity=? WHERE id=?").run(identity(directory), id);
    return { id, directory };
  }
  release(id: string) { this.db.prepare("UPDATE publication_claims SET releasedAt=? WHERE id=? AND releasedAt IS NULL").run(new Date().toISOString(), id); }
  private claim(id: string): Claim {
    z.uuid().parse(id);
    const row = this.db.prepare("SELECT * FROM publication_claims WHERE id=?").get(id) as Claim | undefined;
    if (!row || !scopeSchema.safeParse(row.scope).success || row.path !== (row.scope === "artifact" ? `.publication-${id}` : id)) throw new Error("Exact publication claim unavailable or unsafe");
    return row;
  }
  private observe(claim: Claim) {
    const root = this.roots[claim.scope], directory = join(root, claim.path), blockedBy: string[] = [];
    if (claim.collectedAt) blockedBy.push("Publication claim already collected; same-path recreation is not adopted");
    if (claim.releasedAt) blockedBy.push("Publication claim released after cleanup; same-path recreation is not adopted");
    try { process.kill(claim.pid, 0); blockedBy.push("Publication writer PID is alive (including possible PID reuse); no implicit stop or collection"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") blockedBy.push("Publication writer liveness is unknown"); }
    if (!claim.identity || claim.identity !== identity(directory)) blockedBy.push("Temporary publication incarnation is unverified/replaced; retain recovery evidence");
    const snapshot = snapshotStateFilesSync(root, { paths: [claim.path] });
    if (snapshot.entries.some(row => row.type !== "directory" && row.type !== "file")) blockedBy.push("Symlink/special publication content cannot be collected");
    return { claim, root, snapshot, blockedBy };
  }
  list(input: { offset: number; limit: number; revision?: string }) {
    const claims = this.db.prepare("SELECT * FROM publication_claims WHERE releasedAt IS NULL AND collectedAt IS NULL ORDER BY id LIMIT 10001").all() as Claim[];
    if (claims.length > 10000) throw new Error("Unfinished publication inventory exceeds bounded inspection; refine/recover claims before listing");
    const entries = claims.flatMap(claim => {
      try { const row = this.observe(this.claim(claim.id)); return [{ id: claim.id, scope: claim.scope, path: claim.path, bytes: row.snapshot.bytes as number | null,
        createdAt: claim.createdAt, releasedAt: claim.releasedAt, blockedBy: row.blockedBy, revision: stateHash(row) }]; }
      catch { if (!exists(this.roots[claim.scope], claim.path)) return [];
        return [{ id: claim.id, scope: claim.scope, path: claim.path, bytes: null, createdAt: claim.createdAt, releasedAt: claim.releasedAt, blockedBy: ["Temporary publication observation unavailable"], revision: stateHash(claim) }]; }
    });
    const untracked = Object.entries(this.roots).flatMap(([scope, root]) => {
      try {
        const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Publication root is unsafe");
        const paths = readdirSync(root).flatMap(path => scope === "artifact" && /^[a-f0-9]{2}$/.test(path)
          && lstatSync(join(root, path)).isDirectory() && !lstatSync(join(root, path)).isSymbolicLink()
          ? readdirSync(join(root, path)).filter(name => name.includes(".staging.")).map(name => `${path}/${name}`) : [path]);
        return paths.filter(path => (scope === "bundle" || /\.staging\.|^\.publication-/.test(path)) && !claims.some(row => row.scope === scope && row.path === path)).map(path => `${scope}:${path}`);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    });
    const revision = stateHash([entries, untracked]);
    if (input.revision && revision !== input.revision) throw new Error("Publication inventory changed; restart paging");
    return { entries: entries.slice(input.offset, input.offset + input.limit), revision, nextOffset: input.offset + input.limit < entries.length ? input.offset + input.limit : null,
      retained: ["Published Artifact objects, live source blobs and all admission/receipt metadata remain", "Untracked legacy temporary paths and retirement quarantines are not adopted or deleted", `Unattributed temporary count: ${untracked.length}; showing at most 100 paths`, ...untracked.slice(0, 100).map(path => `Unattributed temporary retained: ${path}`)] };
  }
  private prepare(ids: string[]) {
    const rows = [...new Set(ids)].sort().map(id => this.observe(this.claim(id)));
    return { rows, preview: { subject: null, action: "publication_collect", revision: stateHash(rows), resources: rows.map(row => row.claim.id),
      blockedBy: rows.flatMap(row => row.blockedBy.map(text => `${row.claim.id}: ${text}`)),
      retained: ["Published Artifacts, collection blobs/items/upload references, Vault bodies/Git, backups and untracked legacy temporaries remain", "Publication claims and uncertain admission evidence remain; collection never retries or completes publishing"],
      regeneration: ["Only a later explicit publication creates a new unique claimed temporary; maintenance never republishes"] } };
  }
  plan(journal: StateJournal, ids: string[]) { const prepared = this.prepare(ids); return journal.plan(prepared.preview, { ids: prepared.rows.map(row => row.claim.id) }); }
  clear(journal: StateJournal, input: StateApplyInput) {
    const prior = journal.existing(input); if (prior) { if (prior.action !== "publication_collect") throw new Error("Receipt belongs to another Content action"); return prior; }
    const { plan, payload } = journal.getPlan(input.planId), saved = payload as { ids: string[] };
    if (plan.action !== "publication_collect") throw new Error("Plan belongs to another Content action");
    const current = this.prepare(saved.ids);
    if (current.preview.revision !== input.expectedRevision || plan.revision !== input.expectedRevision) throw new Error("Publication state changed; prepare a new plan");
    if (current.preview.blockedBy.length) throw new Error(current.preview.blockedBy.join("; "));
    journal.begin(input, plan);
    const outcomes: Array<{ resource: string; outcome: "removed" | "unknown"; detail: string }> = [];
    try {
      for (const row of current.rows) {
        // A sibling removal changes shared root metadata. Recheck the selected
        // incarnation/entries instead of blindly using the prior root snapshot.
        const fresh = this.observe(this.claim(row.claim.id));
        if (fresh.blockedBy.length || stateHash(fresh.snapshot.entries) !== stateHash(row.snapshot.entries)) throw new Error("Publication changed before retirement");
        const result = clearStateFilesSync(row.root, { paths: [row.claim.path] }, fresh.snapshot);
        if (result.removed.includes(row.claim.path)) this.db.prepare("UPDATE publication_claims SET collectedAt=? WHERE id=?").run(new Date().toISOString(), row.claim.id);
        outcomes.push({ resource: row.claim.id, outcome: result.removed.includes(row.claim.path) ? "removed" : "unknown", detail: result.error ?? "Exact dead-writer publication temporary removed; publication outcome/admission is unchanged" });
        journal.finish(input.requestId, "running", outcomes);
        if (result.error) throw new Error("Publication retirement is partial");
      }
      return journal.finish(input.requestId, "completed", outcomes);
    } catch { return journal.finish(input.requestId, outcomes.length ? "partial" : "unknown", [...outcomes, ...current.rows.filter(row => !outcomes.some(outcome => outcome.resource === row.claim.id)).map(row => ({ resource: row.claim.id, outcome: "unknown" as const, detail: "Temporary cleanup interrupted; inspect exact path/quarantine, never replay effects" }))]); }
  }
}
function exists(root: string, path: string) { try { lstatSync(join(root, path)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
