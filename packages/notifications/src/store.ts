import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Content, Notification } from "./schema.js";

type Row = { id: string; sequence: number; revision: number; title: string; message: string; subtitle: string | null;
  source: string | null; initial_digest: string; created_at: string; updated_at: string; acknowledged_at: string | null; dismissed_at: string | null };

function fromRow(row: Row): Notification {
  return { id: row.id, sequence: row.sequence, revision: row.revision, title: row.title, message: row.message,
    subtitle: row.subtitle, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at, dismissedAt: row.dismissed_at };
}

export class NotificationStore {
  readonly db: DatabaseSync;

  constructor(stateRoot: string) {
    const dir = join(stateRoot, "notifications");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "notifications.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS notifications (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
        subtitle TEXT, source TEXT, initial_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        acknowledged_at TEXT, dismissed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notifications_dismissed_sequence ON notifications(dismissed_at, sequence);
      CREATE INDEX IF NOT EXISTS notifications_acknowledged_sequence ON notifications(acknowledged_at, sequence);`);
  }

  get(id: string): Notification {
    const row = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error("notification_not_found");
    return fromRow(row);
  }

  create(input: Content & { id?: string }): { record: Notification; created: boolean } {
    const id = input.id ?? randomUUID();
    const existing = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row | undefined;
    const initial = createHash("sha256").update(JSON.stringify([input.title, input.message, input.subtitle, input.source])).digest("hex");
    if (existing) {
      if (existing.initial_digest !== initial)
        throw new Error("notification_id_conflict");
      return { record: fromRow(existing), created: false };
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO notifications (id, revision, title, message, subtitle, source, initial_digest, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.title, input.message, input.subtitle, input.source, initial, now, now);
    return { record: this.get(id), created: true };
  }

  update(id: string, revision: number, patch: Partial<Content>): Notification {
    const current = this.get(id);
    if (current.revision !== revision) throw new Error("notification_revision_conflict");
    if (!Object.keys(patch).length) throw new Error("notification_update_empty");
    const changed = Object.entries(patch).some(([key, value]) => current[key as keyof Content] !== value);
    if (!changed) return current;
    const next = { ...current, ...patch };
    const result = this.db.prepare(`UPDATE notifications SET title = ?, message = ?, subtitle = ?, source = ?,
      revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(
      next.title, next.message, next.subtitle, next.source, new Date().toISOString(), id, revision);
    if (result.changes !== 1) throw new Error("notification_revision_conflict");
    return this.get(id);
  }

  mark(id: string, field: "acknowledged_at" | "dismissed_at"): { record: Notification; changed: boolean } {
    this.get(id);
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE notifications SET ${field} = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND ${field} IS NULL`).run(now, now, id);
    return { record: this.get(id), changed: result.changes === 1 };
  }

  dismissAll(): number {
    const now = new Date().toISOString();
    return Number(this.db.prepare(`UPDATE notifications SET dismissed_at = ?, updated_at = ?, revision = revision + 1
      WHERE dismissed_at IS NULL`).run(now, now).changes);
  }

  list(input: { before?: number; limit: number; acknowledged?: boolean; dismissed?: boolean; source?: string }): { entries: Notification[]; nextCursor: number | null } {
    const where = ["sequence < ?"];
    const params: Array<string | number> = [input.before ?? Number.MAX_SAFE_INTEGER];
    if (input.acknowledged !== undefined) where.push(`acknowledged_at IS ${input.acknowledged ? "NOT " : ""}NULL`);
    if (input.dismissed !== undefined) where.push(`dismissed_at IS ${input.dismissed ? "NOT " : ""}NULL`);
    if (input.source !== undefined) { where.push("source = ?"); params.push(input.source); }
    const rows = this.db.prepare(`SELECT * FROM notifications WHERE ${where.join(" AND ")}
      ORDER BY sequence DESC LIMIT ?`).all(...params, input.limit + 1) as Row[];
    const entries = rows.slice(0, input.limit).map(fromRow);
    return { entries, nextCursor: rows.length > input.limit ? entries.at(-1)!.sequence : null };
  }

  close(): void { this.db.close(); }
}
