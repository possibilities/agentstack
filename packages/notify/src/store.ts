import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateJournal, stateHash, type StateApplyInput } from "@stack/api";
import type { Content, Notification, Outcome } from "./schema.js";

type Row = { id: string; sequence: number; title: string; message: string; subtitle: string | null; source: string | null;
  group_key: string | null; open_url: string | null; actions: string; reply: string | null; initial_digest: string;
  created_at: string; dismissed_at: string | null; outcome: Outcome | null; response: string | null; content_cleared_at: string | null; dismissal_digest: string | null };

const schemaVersion = 2;
const table = (name: string) => `CREATE TABLE ${name} (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, message TEXT NOT NULL, subtitle TEXT, source TEXT,
  group_key TEXT, open_url TEXT, actions TEXT NOT NULL DEFAULT '[]', reply TEXT,
  initial_digest TEXT NOT NULL, created_at TEXT NOT NULL,
  dismissed_at TEXT, outcome TEXT, response TEXT
)`;
const indexes = `CREATE INDEX notifications_dismissed_sequence ON notifications(dismissed_at, sequence);
  CREATE INDEX notifications_group_open ON notifications(group_key, dismissed_at);`;

function fromRow(row: Row): Notification {
  return { id: row.id, sequence: row.sequence, title: row.title, message: row.message, subtitle: row.subtitle,
    source: row.source, group: row.group_key, open: row.open_url, actions: JSON.parse(row.actions) as string[], reply: row.reply,
    createdAt: row.created_at, dismissedAt: row.dismissed_at, outcome: row.outcome, response: row.response, contentClearedAt: row.content_cleared_at };
}

/** Plain sends hash exactly as the first schema did, so retries of a pre-migration send stay idempotent. */
function digest(input: Content): string {
  const parts: unknown[] = [input.title, input.message, input.subtitle, input.source];
  if (input.group !== null || input.open !== null || input.actions.length || input.reply !== null) parts.push(input.group, input.open, input.actions, input.reply);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export type Dismissal = { outcome: Exclude<Outcome, "replaced">; response?: string };

export class NotificationStore {
  readonly db: DatabaseSync;
  readonly maintenance: StateJournal;

  constructor(stateRoot: string) {
    const dir = join(stateRoot, "notify");
    const legacy = join(stateRoot, "notifications");
    if (existsSync(legacy)) {
      if (existsSync(dir)) throw new Error("notify_state_conflict: both notify and notifications state directories exist");
      // Move the whole directory so SQLite's WAL and journal files travel with the database.
      renameSync(legacy, dir);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "notifications.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.migrate();
    if (!(this.db.prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).some(row => row.name === "content_cleared_at"))
      this.db.exec("ALTER TABLE notifications ADD COLUMN content_cleared_at TEXT; ALTER TABLE notifications ADD COLUMN dismissal_digest TEXT");
    this.maintenance = new StateJournal(this.db, "notify");
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === schemaVersion) return;
    if (version > schemaVersion) throw new Error(`notify_schema_unsupported: version ${version}`);
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get();
    this.transaction(() => {
      if (!exists) this.db.exec(table("notifications"));
      else {
        // Version 1 kept independent acknowledgment and dismissal. Acknowledgment now means the
        // person engaged, which dismisses: it becomes an "opened" dismissal at the earlier time.
        this.db.exec(`${table("notifications_v2")};
          INSERT INTO notifications_v2 (sequence, id, title, message, subtitle, source, initial_digest, created_at, dismissed_at, outcome)
            SELECT sequence, id, title, message, subtitle, source, initial_digest, created_at,
              CASE WHEN acknowledged_at IS NULL THEN dismissed_at WHEN dismissed_at IS NULL THEN acknowledged_at ELSE MIN(acknowledged_at, dismissed_at) END,
              CASE WHEN acknowledged_at IS NOT NULL THEN 'opened' WHEN dismissed_at IS NOT NULL THEN 'closed' END
            FROM notifications;
          DROP TABLE notifications;
          ALTER TABLE notifications_v2 RENAME TO notifications;`);
      }
      this.db.exec(`${indexes} PRAGMA user_version = ${schemaVersion};`);
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private find(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row | undefined;
  }

  get(id: string): Notification {
    const row = this.find(id);
    if (!row) throw new Error("notification_not_found");
    return fromRow(row);
  }

  /** Inserts, then dismisses any other open notification in the same group as "replaced". A retried ID replaces nothing. */
  create(input: Content & { id?: string }): { record: Notification; created: boolean } {
    const id = input.id ?? randomUUID();
    const initial = digest(input);
    return this.transaction(() => {
      const existing = this.find(id);
      if (existing) {
        if (existing.initial_digest !== initial) throw new Error("notification_id_conflict");
        return { record: fromRow(existing), created: false };
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO notifications (id, title, message, subtitle, source, group_key, open_url, actions, reply, initial_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.title, input.message, input.subtitle, input.source,
        input.group, input.open, JSON.stringify(input.actions), input.reply, initial, now);
      if (input.group !== null) this.db.prepare(`UPDATE notifications SET dismissed_at = ?, outcome = 'replaced'
        WHERE group_key = ? AND dismissed_at IS NULL AND id != ?`).run(now, input.group, id);
      return { record: this.get(id), created: true };
    });
  }

  /** The first dismissal wins. Repeating it is a no-op; a different outcome or response is refused. */
  dismiss(id: string, { outcome, response }: Dismissal): { record: Notification; changed: boolean } {
    const current = this.get(id);
    const value = response ?? null;
    if (current.contentClearedAt) {
      if (this.find(id)!.dismissal_digest === stateHash([outcome, value])) return { record: current, changed: false };
      throw new Error("notification_already_dismissed");
    }
    if (outcome === "action" ? value === null || !current.actions.includes(value)
      : outcome === "replied" ? current.reply === null || value === null
      : value !== null) throw new Error(`notification_response_invalid: ${outcome === "action" ? "response must be one of the notification's actions"
        : outcome === "replied" ? "reply requires a notification that offers one and a response" : `${outcome} takes no response`}`);
    if (current.dismissedAt !== null) {
      if (current.outcome === outcome && current.response === value) return { record: current, changed: false };
      throw new Error("notification_already_dismissed");
    }
    const result = this.db.prepare(`UPDATE notifications SET dismissed_at = ?, outcome = ?, response = ?
      WHERE id = ? AND dismissed_at IS NULL`).run(new Date().toISOString(), outcome, value, id);
    if (result.changes !== 1) return this.dismiss(id, { outcome, response });
    return { record: this.get(id), changed: true };
  }

  dismissAll(group?: string): number {
    const scope = group === undefined ? "" : " AND group_key = ?";
    return Number(this.db.prepare(`UPDATE notifications SET dismissed_at = ?, outcome = 'closed' WHERE dismissed_at IS NULL${scope}`)
      .run(new Date().toISOString(), ...(group === undefined ? [] : [group])).changes);
  }

  list(input: { before?: number; limit: number; dismissed?: boolean; source?: string; group?: string }): { entries: Notification[]; nextCursor: number | null } {
    const where = ["sequence < ?"];
    const params: Array<string | number> = [input.before ?? Number.MAX_SAFE_INTEGER];
    if (input.dismissed !== undefined) where.push(`dismissed_at IS ${input.dismissed ? "NOT " : ""}NULL`);
    if (input.source !== undefined) { where.push("source = ?"); params.push(input.source); }
    if (input.group !== undefined) { where.push("group_key = ?"); params.push(input.group); }
    const rows = this.db.prepare(`SELECT * FROM notifications WHERE ${where.join(" AND ")}
      ORDER BY sequence DESC LIMIT ?`).all(...params, input.limit + 1) as Row[];
    const entries = rows.slice(0, input.limit).map(fromRow);
    return { entries, nextCursor: rows.length > input.limit ? entries.at(-1)!.sequence : null };
  }

  /** Open and total counts, overall and per source (null for notifications without one), most-used sources first. */
  counts(): { open: number; total: number; sources: Array<{ source: string | null; open: number; total: number }> } {
    const sources = (this.db.prepare(`SELECT source, SUM(dismissed_at IS NULL) AS open, COUNT(*) AS total FROM notifications
      GROUP BY source ORDER BY total DESC, source`).all() as Array<{ source: string | null; open: number; total: number }>)
      .map(({ source, open, total }) => ({ source, open: Number(open), total: Number(total) }));
    return { open: sources.reduce((sum, item) => sum + item.open, 0), total: sources.reduce((sum, item) => sum + item.total, 0), sources };
  }

  close(): void { this.db.close(); }

  private selected(ids: string[]): Row[] {
    return [...new Set(ids)].sort().map(id => { const row = this.find(id); if (!row) throw new Error(`notification_not_found:${id}`); return row; });
  }
  historyPlan(ids: string[]) {
    const rows = this.selected(ids);
    return this.maintenance.plan({ subject: null, action: "history_clear", revision: stateHash(rows), resources: rows.map(row => row.id),
      blockedBy: rows.filter(row => !row.dismissed_at).map(row => `Dismiss notification ${row.id} before clearing it`),
      retained: ["ID, sequence, creation/dismissal timestamps, outcome and content-free send/dismissal digests", "Source/group labels, prompt actions and responses are cleared together with authored bodies"],
      regeneration: ["Retrying the original send or dismissal returns the cleared record; it does not recreate content or answer a prompt"] }, { ids: rows.map(row => row.id) });
  }
  historyClear(input: StateApplyInput) {
    return this.maintenance.atomic(input, (plan, payload) => {
      const rows = this.selected((payload as { ids: string[] }).ids);
      if (plan.action !== "history_clear" || plan.revision !== stateHash(rows)) throw new Error("notification state changed; prepare a new plan");
      if (rows.some(row => !row.dismissed_at)) throw new Error("open notification cannot be cleared");
    }, payload => (payload as { ids: string[] }).ids.map(id => {
      const row = this.find(id)!;
      this.db.prepare(`UPDATE notifications SET title='',message='',subtitle=NULL,source=NULL,group_key=NULL,open_url=NULL,actions='[]',reply=NULL,response=NULL,
        content_cleared_at=COALESCE(content_cleared_at,?),dismissal_digest=COALESCE(dismissal_digest,?) WHERE id=?`).run(new Date().toISOString(), stateHash([row.outcome, row.response]), id);
      return { resource: id, outcome: "removed" as const, detail: "Authored notification, action, prompt, source/group and response payloads cleared; send and dismissal receipts retained" };
    }));
  }
}
