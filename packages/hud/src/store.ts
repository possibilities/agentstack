import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateJournal, stateHash, type StateApplyInput } from "@stack/api";
import { workItem, type Actor, type Activity, type Change, type ChatTarget, type Focus, type ListInput, type Metadata, type Receipt, type WorkItem } from "./schema.js";

/** Stable JSON for request identity and exact correlation; object property order is immaterial. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const terminal = (item: WorkItem) => item.state === "completed" || item.state === "cancelled";
const decode = <T>(row: unknown): T => JSON.parse((row as { body: string }).body) as T;
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export class HudStore {
  private readonly db: DatabaseSync;
  readonly maintenance: StateJournal;
  onChange?: (ids: string[]) => void;

  constructor(root: string) {
    const dir = join(root, "hud");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "work.sqlite");
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > 1) throw new Error(`hud_schema_unsupported: ${version}`);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      this.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS work_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata (work_id TEXT NOT NULL REFERENCES work_items(id), namespace TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(work_id,namespace));
        CREATE TABLE IF NOT EXISTS activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL REFERENCES work_items(id), body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS activity_work ON activity(work_id,sequence);
        CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS focus (key TEXT PRIMARY KEY, body TEXT NOT NULL);
        PRAGMA user_version=1;
      `));
      this.maintenance = new StateJournal(this.db, "hud");
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  cursor(): number { return (this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM activity").get() as { n: number }).n; }
  has(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM work_items WHERE id=?").get(id)); }
  get(id: string): WorkItem {
    const row = this.db.prepare("SELECT body FROM work_items WHERE id=?").get(id);
    if (!row) throw new Error(`work_not_found: ${id}`);
    return decode<WorkItem>(row);
  }
  private all(): WorkItem[] { return this.db.prepare("SELECT body FROM work_items ORDER BY sequence").all().map(decode<WorkItem>); }
  private save(item: WorkItem): void { this.db.prepare("UPDATE work_items SET body=? WHERE id=?").run(JSON.stringify(item), item.id); }
  metadata(id: string, namespace?: string): Record<string, Metadata> {
    this.get(id);
    const rows = (namespace === undefined ? this.db.prepare("SELECT namespace,body FROM metadata WHERE work_id=? ORDER BY namespace").all(id)
      : this.db.prepare("SELECT namespace,body FROM metadata WHERE work_id=? AND namespace=?").all(id, namespace)) as Array<{ namespace: string; body: string }>;
    return Object.fromEntries(rows.map(row => [row.namespace, JSON.parse(row.body)]));
  }
  private prior(requestId: string, digest: string): Receipt | null {
    const row = this.db.prepare("SELECT digest,body FROM receipts WHERE request_id=?").get(requestId) as { digest: string; body: string } | undefined;
    if (!row) return null;
    if (row.digest !== digest) throw new Error("work_request_conflict: requestId already identifies different input or actor");
    return { ...decode<Receipt>(row), duplicate: true };
  }
  replay(requestId: string, changes: Change[], actor: Actor): Receipt | null { return this.prior(requestId, hash({ changes, actor })); }
  private recordReceipt(receipt: Receipt, digest: string): void {
    this.db.prepare("INSERT INTO receipts VALUES (?,?,?)").run(receipt.requestId, digest, JSON.stringify(receipt));
  }
  private append(value: Omit<Activity, "sequence">): void {
    const result = this.db.prepare("INSERT INTO activity (work_id,body) VALUES (?,?)").run(value.workItemId, "{}");
    this.db.prepare("UPDATE activity SET body=? WHERE sequence=?").run(JSON.stringify({ ...value, sequence: Number(result.lastInsertRowid) }), result.lastInsertRowid);
  }

  /** The receipt, hidden metadata, journal, hierarchy and revisions have one commit boundary. */
  apply(requestId: string, changes: Change[], actor: Actor): Receipt {
    const digest = hash({ changes, actor });
    const changed = new Set<string>();
    const receipt = this.transaction(() => {
      const prior = this.prior(requestId, digest);
      if (prior) return prior;
      const before = this.all();
      for (const input of changes) {
        const now = Date.now();
        let item: WorkItem;
        let kind: Activity["kind"];
        let fields: string[];
        let edits: Activity["changes"] = [];
        if (input.action === "create") {
          if (this.has(input.id)) throw new Error(`work_exists: ${input.id}`);
          const { action: _, ...data } = input;
          // Origin is transport-derived. It does not make the recording Bot the accountable lead.
          if (actor.kind === "bot" && !data.links.some(link => link.target.kind === "chat" && link.target.botId === actor.botId && link.target.threadId === actor.threadId)) {
            if (data.links.length >= 64) throw new Error("work_links_limit: leave room for the originating Chat");
            data.links = [...data.links, { relation: "context", target: { kind: "chat", botId: actor.botId, mainThreadId: actor.mainThreadId, threadId: actor.threadId }, label: "Originating Chat" }];
          }
          const seq = Number(this.db.prepare("INSERT INTO work_items (id,body) VALUES (?,?)").run(input.id, "{}").lastInsertRowid);
          item = workItem.parse({ ...data, sequence: seq, revision: 1, scopeRevision: 1, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now });
          kind = "created"; fields = Object.keys(data).filter(key => key !== "id");
        } else {
          item = this.get(input.id);
          if (item.revision !== input.expectedRevision) throw new Error(`work_revision_conflict: ${item.id} is revision ${item.revision}`);
          item = { ...item, revision: item.revision + 1, updatedBy: actor, updatedAt: now };
          if (input.action === "update") {
            fields = Object.keys(input.patch).filter(key => canonical(item[key as keyof WorkItem]) !== canonical(input.patch[key as keyof typeof input.patch]));
            edits = fields.map(field => ({ field, before: JSON.parse(JSON.stringify(item[field as keyof WorkItem])), after: JSON.parse(JSON.stringify(input.patch[field as keyof typeof input.patch])) }));
            const scopeChanged = fields.some(key => ["objective", "parentId", "dependencies"].includes(key));
            if (terminal(item) && scopeChanged && (!input.patch.state || ["completed", "cancelled"].includes(input.patch.state)))
              throw new Error("work_reopen_required: reopen when changing a closed objective, parent or dependencies");
            item = workItem.parse({ ...item, ...input.patch, scopeRevision: item.scopeRevision + Number(scopeChanged) });
            kind = "updated";
          } else if (input.action === "metadata") {
            if (input.value === null) this.db.prepare("DELETE FROM metadata WHERE work_id=? AND namespace=?").run(item.id, input.namespace);
            else {
              const namespaces = Object.keys(this.metadata(item.id));
              if (!namespaces.includes(input.namespace) && namespaces.length >= 32) throw new Error("work_metadata_limit: at most 32 namespaces per item");
              this.db.prepare("INSERT INTO metadata VALUES (?,?,?) ON CONFLICT(work_id,namespace) DO UPDATE SET body=excluded.body")
                .run(item.id, input.namespace, JSON.stringify(input.value));
            }
            kind = "metadata"; fields = [input.namespace];
          } else { kind = input.kind; fields = []; }
        }
        this.save(item);
        this.append({ workItemId: item.id, revision: item.revision, scopeRevision: item.scopeRevision, requestId, actor, at: now, kind, fields, changes: edits,
          body: input.action === "note" ? input.body : null, references: input.action === "note" ? input.references : [] });
        changed.add(item.id);
      }
      const after = this.all();
      this.validateGraph(after);
      // Reverse edges from both graphs include old parents after a move. Notify derived
      // readiness transitively without revising those records or depending on insertion order.
      const dependents = new Map<string, Set<string>>();
      const edge = (from: string, to: string) => {
        if (!dependents.has(from)) dependents.set(from, new Set());
        dependents.get(from)!.add(to);
      };
      for (const item of [...before, ...after]) {
        if (item.parentId) edge(item.id, item.parentId);
        for (const dependency of item.dependencies) edge(dependency, item.id);
      }
      const pending = [...changed];
      for (let i = 0; i < pending.length; i++) for (const id of dependents.get(pending[i]!) ?? [])
        if (!changed.has(id)) { changed.add(id); pending.push(id); }
      const items = [...new Set(changes.map(input => input.id))].map(id => {
        const item = this.get(id); return { id, revision: item.revision, scopeRevision: item.scopeRevision };
      });
      const result = { requestId, duplicate: false, cursor: this.cursor(), items };
      this.recordReceipt(result, digest);
      return result;
    });
    if (!receipt.duplicate) this.onChange?.([...changed]);
    return receipt;
  }

  private validateGraph(items: WorkItem[]): void {
    const map = new Map(items.map(item => [item.id, item]));
    for (const item of items) {
      if (new Set(item.dependencies).size !== item.dependencies.length) throw new Error("work_duplicate_dependency");
      for (const id of [item.parentId, ...item.dependencies].filter((id): id is string => id !== null))
        if (!map.has(id)) throw new Error(`work_reference_missing: ${id}`);
      for (const link of item.links) if (link.target.kind === "work" && !map.has(link.target.workItemId)) throw new Error("work_reference_missing");
    }
    // A parent's completion depends on its children. Check combined containment + dependency edges,
    // so a child depending on its parent cannot create a completion deadlock.
    const edges = new Map(items.map(item => [item.id, [...item.dependencies]]));
    for (const item of items) if (item.parentId) edges.get(item.parentId)!.push(item.id);
    const incoming = new Map(items.map(item => [item.id, 0]));
    for (const targets of edges.values()) for (const id of targets) incoming.set(id, incoming.get(id)! + 1);
    const ready = items.filter(item => incoming.get(item.id) === 0).map(item => item.id);
    for (let i = 0; i < ready.length; i++) for (const id of edges.get(ready[i]!)!) {
      incoming.set(id, incoming.get(id)! - 1);
      if (incoming.get(id) === 0) ready.push(id);
    }
    if (ready.length !== items.length) throw new Error("work_cycle: hierarchy and dependencies must form an acyclic completion graph");
    for (const item of items) {
      let current = item, depth = 0;
      while (current.parentId) {
        if (++depth > 128) throw new Error("work_depth_limit: nesting is limited to 128 levels");
        current = map.get(current.parentId)!;
        if (current.state === "completed" && !terminal(item)) throw new Error(`work_not_ready: ${current.id} has an unfinished descendant`);
      }
    }
    for (const item of items) if (item.state === "completed") {
      if (item.dependencies.some(id => map.get(id)!.state !== "completed"))
        throw new Error(`work_not_ready: ${item.id} has unfinished children or dependencies; reopen it in the same batch if needed`);
    }
  }

  list(input: ListInput) {
    const entries = this.all().filter(item => item.sequence > input.after
      && (input.parentId === undefined || item.parentId === input.parentId)
      && (!input.states || input.states.includes(item.state)) && (!input.attention || item.attention === input.attention)
      && (!input.query || `${item.title}\n${item.summary}\n${item.objective}\n${item.labels.join(" ")}`.toLowerCase().includes(input.query.toLowerCase()))
      && (!input.correlation || canonical(this.metadata(item.id, input.correlation.namespace)[input.correlation.namespace]?.[input.correlation.key]) === canonical(input.correlation.value)));
    const page = bounded(entries, input.limit);
    return { items: page, nextCursor: entries.length > page.length ? page.at(-1)!.sequence : null, cursor: this.cursor() };
  }
  tree(input: { rootId?: string; offset: number; limit: number; snapshot?: number }) {
    const snapshot = this.cursor();
    if (input.offset > 0 && input.snapshot === undefined) throw new Error("work_snapshot_required: pass the first page's snapshot");
    if (input.snapshot !== undefined && input.snapshot !== snapshot) throw new Error("work_snapshot_changed: restart tree pagination");
    const items = this.all(), map = new Map(items.map(item => [item.id, item]));
    if (input.rootId && !map.has(input.rootId)) throw new Error("work_not_found");
    const children = new Map<string | null, WorkItem[]>();
    for (const item of items) {
      if (!children.has(item.parentId)) children.set(item.parentId, []);
      children.get(item.parentId)!.push(item);
    }
    for (const rows of children.values()) rows.sort((a, b) => a.order - b.order || a.sequence - b.sequence);
    const rows: Array<{ item: WorkItem; depth: number; childCount: number; openDescendants: number; unmetDependencies: string[] }> = [];
    const walk = (item: WorkItem, depth: number): number => {
      const row = { item, depth, childCount: children.get(item.id)?.length ?? 0, openDescendants: 0,
        unmetDependencies: item.dependencies.filter(id => map.get(id)!.state !== "completed") };
      rows.push(row);
      for (const child of children.get(item.id) ?? []) row.openDescendants += walk(child, depth + 1);
      return row.openDescendants + Number(!terminal(item));
    };
    for (const root of input.rootId ? [map.get(input.rootId)!] : children.get(null) ?? []) walk(root, 0);
    const page = bounded(rows.slice(input.offset), input.limit);
    return { rows: page, total: rows.length, nextOffset: input.offset + page.length < rows.length ? input.offset + page.length : null, snapshot };
  }
  activity(input: { id?: string; after: number; limit: number }) {
    if (input.id) this.get(input.id);
    const rows = input.id ? this.db.prepare("SELECT body FROM activity WHERE work_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(input.id, input.after, input.limit + 1)
      : this.db.prepare("SELECT body FROM activity WHERE sequence>? ORDER BY sequence LIMIT ?").all(input.after, input.limit + 1);
    const entries = bounded(rows.map(decode<Activity>), input.limit);
    return { entries, nextCursor: entries.at(-1)?.sequence ?? input.after, hasMore: rows.length > entries.length };
  }

  focus(target: ChatTarget): Focus {
    const row = this.db.prepare("SELECT body FROM focus WHERE key=?").get(canonical(target));
    return row ? decode<Focus>(row) : { ...target, revision: 0, workItemId: null, updatedAt: null, updatedBy: null };
  }
  focusList(after: string | undefined, limit: number, botId?: string) {
    const rows = this.db.prepare("SELECT key,body FROM focus WHERE key>? AND (? IS NULL OR json_extract(body,'$.botId')=?) ORDER BY key LIMIT ?")
      .all(after ?? "", botId ?? null, botId ?? null, limit + 1) as Array<{ key: string; body: string }>;
    return { entries: rows.slice(0, limit).map(row => decode<Focus>(row)), nextCursor: rows.length > limit ? rows[limit - 1]!.key : null };
  }
  focusRetirePlan(target: ChatTarget) {
    const current = this.focus(target);
    return this.maintenance.plan({ subject: { kind: "chat", id: target.threadId }, action: "retired_focus", revision: stateHash(current),
      resources: [canonical(target)], blockedBy: [], retained: ["Shared Work items, metadata, collaboration history and captured Worker associations", "Focus action admission receipts"],
      regeneration: ["Only retired sanctioned roots may be selected. Removing a focus row is distinct from a saved-null inheritance barrier; active-root focus must use work_focus_set."] }, target);
  }
  focusRetire(input: StateApplyInput) {
    const receipt = this.maintenance.atomic(input, (plan, payload) => {
      if (plan.action !== "retired_focus" || plan.revision !== stateHash(this.focus(payload as ChatTarget))) throw new Error("Focus changed; prepare a new plan");
    }, payload => {
      this.db.prepare("DELETE FROM focus WHERE key=?").run(canonical(payload));
      return [{ resource: canonical(payload), outcome: "removed", detail: "Retired-root focus removed; shared Work and collaboration history retained" }];
    });
    this.onChange?.([]); return receipt;
  }
  focuses(id: string): { entries: Focus[]; total: number; truncated: boolean } {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM focus WHERE json_extract(body,'$.workItemId')=?").get(id) as { n: number };
    const entries = this.db.prepare("SELECT body FROM focus WHERE json_extract(body,'$.workItemId')=? ORDER BY key LIMIT 100").all(id).map(decode<Focus>);
    return { entries, total: count.n, truncated: count.n > entries.length };
  }
  setFocus(input: { requestId: string; target: ChatTarget; workItemId: string | null; expectedRevision: number }, actor: Actor): Receipt {
    const digest = hash({ action: "focus", ...input, actor });
    const changed = new Set<string>();
    const result = this.transaction(() => {
      const prior = this.prior(input.requestId, digest);
      if (prior) return prior;
      const current = this.focus(input.target);
      if (current.revision !== input.expectedRevision) throw new Error(`work_focus_conflict: current revision ${current.revision}`);
      if (input.workItemId && terminal(this.get(input.workItemId))) throw new Error("work_closed: choose open work or reopen it");
      const now = Date.now();
      const next: Focus = { ...input.target, revision: current.revision + 1, workItemId: input.workItemId, updatedAt: now, updatedBy: actor };
      this.db.prepare("INSERT INTO focus VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(canonical(input.target), JSON.stringify(next));
      for (const id of new Set([current.workItemId, input.workItemId])) if (id) {
        const item = this.get(id); changed.add(id);
        this.append({ workItemId: id, revision: item.revision, scopeRevision: item.scopeRevision, actor, at: now, requestId: input.requestId,
          kind: "focus", fields: [], changes: [], body: id === input.workItemId ? "Chat focused this work" : "Chat left this work", references: [{ kind: "chat", ...input.target }] });
      }
      const receipt = { requestId: input.requestId, duplicate: false, cursor: this.cursor(), items: [] };
      this.recordReceipt(receipt, digest);
      return receipt;
    });
    if (!result.duplicate) this.onChange?.([...changed]);
    return result;
  }
}

/** Bound serialized payloads as well as row counts. Every individual record fits under this cap. */
function bounded<T>(rows: T[], limit: number): T[] {
  const page: T[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (page.length && bytes + size > 256_000) break;
    page.push(row); bytes += size;
  }
  return page;
}
