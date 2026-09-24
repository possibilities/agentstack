import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Fragment = { id: string; categoryId: string; title: string; description: string; body: string; enabled: boolean };
export type Category = { id: string; title: string; description: string; enabled: boolean; fragments: Fragment[] };
export type RoleSnapshot = { revision: number; categories: Category[] };

export function renderInstructions(snapshot: RoleSnapshot): string {
  const bodies = snapshot.categories.flatMap((category) => category.enabled
    ? category.fragments.filter((fragment) => fragment.enabled && fragment.body.trim()).map((fragment) => fragment.body)
    : []);
  const rendered = bodies.join("\n\n");
  if (Buffer.byteLength(rendered) > 262_144) throw new Error("rendered instructions exceed 262144 bytes");
  return rendered;
}

export class RoleStore {
  private readonly db: DatabaseSync;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, "roles.sqlite");
    const legacy = join(stateDir, "capabilities.sqlite");
    if (!existsSync(path) && existsSync(legacy)) {
      try { renameSync(legacy, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !existsSync(path)) throw error;
      }
    }
    else if (existsSync(path) && existsSync(legacy)) throw new Error("both roles.sqlite and legacy capabilities.sqlite exist; inspect before continuing");
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS revision (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO revision VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, enabled INTEGER NOT NULL,
        position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fragments (
        id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL,
        position INTEGER NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  snapshot(): RoleSnapshot {
    this.db.exec("BEGIN");
    try {
      const value = this.readSnapshot();
      this.db.exec("COMMIT");
      return value;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private readSnapshot(): RoleSnapshot {
    const revision = this.revision();
    const rows = this.db.prepare("SELECT id, title, description, enabled FROM categories ORDER BY position, id").all() as Array<Omit<Category, "fragments" | "enabled"> & { enabled: number }>;
    const fragments = this.db.prepare("SELECT id, category_id, title, description, body, enabled FROM fragments ORDER BY category_id, position, id").all() as Array<{
      id: string; category_id: string; title: string; description: string; body: string; enabled: number;
    }>;
    const categories = rows.map((row): Category => ({ ...row, enabled: Boolean(row.enabled), fragments: [] }));
    const byId = new Map(categories.map((category) => [category.id, category]));
    for (const { category_id, enabled, ...fragment } of fragments) {
      byId.get(category_id)?.fragments.push({ ...fragment, categoryId: category_id, enabled: Boolean(enabled) });
    }
    return { revision, categories };
  }

  createCategory(expectedRevision: number, title: string, description = "", enabled = true): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const position = this.count("categories");
      this.db.prepare("INSERT INTO categories VALUES (?, ?, ?, ?, ?)").run(randomUUID(), title, description, Number(enabled), position);
    });
  }

  updateCategory(expectedRevision: number, id: string, fields: { title?: string; description?: string; enabled?: boolean }): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const existing = this.category(id);
      this.db.prepare("UPDATE categories SET title = ?, description = ?, enabled = ? WHERE id = ?")
        .run(fields.title ?? existing.title, fields.description ?? existing.description, Number(fields.enabled ?? existing.enabled), id);
    });
  }

  deleteCategory(expectedRevision: number, id: string): RoleSnapshot {
    return this.change(expectedRevision, () => {
      this.category(id);
      if ((this.db.prepare("SELECT COUNT(*) AS n FROM fragments WHERE category_id = ?").get(id) as { n: number }).n)
        throw new Error(`category ${id} still contains fragments; move or delete them first`);
      this.db.prepare("DELETE FROM categories WHERE id = ?").run(id);
      this.reindex("categories");
    });
  }

  reorderCategories(expectedRevision: number, ids: string[]): RoleSnapshot {
    return this.change(expectedRevision, () => this.reorder("categories", ids));
  }

  createFragment(expectedRevision: number, categoryId: string, title: string, body: string, description = "", enabled = true): RoleSnapshot {
    return this.change(expectedRevision, () => {
      this.category(categoryId);
      const position = this.count("fragments", categoryId);
      this.db.prepare("INSERT INTO fragments VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), categoryId, title, description, body, Number(enabled), position);
    });
  }

  updateFragment(expectedRevision: number, id: string, fields: { categoryId?: string; title?: string; body?: string; description?: string; enabled?: boolean }): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const existing = this.fragment(id);
      const categoryId = fields.categoryId ?? existing.categoryId;
      if (categoryId !== existing.categoryId) this.category(categoryId);
      const position = categoryId === existing.categoryId ? existing.position : this.count("fragments", categoryId);
      this.db.prepare("UPDATE fragments SET category_id = ?, title = ?, description = ?, body = ?, enabled = ?, position = ? WHERE id = ?")
        .run(categoryId, fields.title ?? existing.title, fields.description ?? existing.description, fields.body ?? existing.body,
          Number(fields.enabled ?? existing.enabled), position, id);
      if (categoryId !== existing.categoryId) this.reindex("fragments", existing.categoryId);
    });
  }

  deleteFragment(expectedRevision: number, id: string): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const existing = this.fragment(id);
      this.db.prepare("DELETE FROM fragments WHERE id = ?").run(id);
      this.reindex("fragments", existing.categoryId);
    });
  }

  reorderFragments(expectedRevision: number, categoryId: string, ids: string[]): RoleSnapshot {
    return this.change(expectedRevision, () => { this.category(categoryId); this.reorder("fragments", ids, categoryId); });
  }

  private change(expectedRevision: number, mutate: () => void): RoleSnapshot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const revision = this.revision();
      if (revision !== expectedRevision) throw new Error(`stale role revision: expected ${expectedRevision}, current ${revision}`);
      mutate();
      const snapshot = this.readSnapshot();
      renderInstructions(snapshot);
      if (JSON.stringify(snapshot).length > 750_000) throw new Error("role snapshot exceeds the socket response budget");
      this.db.prepare("UPDATE revision SET value = value + 1 WHERE singleton = 1").run();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.snapshot();
  }

  private revision(): number { return (this.db.prepare("SELECT value FROM revision WHERE singleton = 1").get() as { value: number }).value; }
  private count(table: "categories" | "fragments", categoryId?: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}${categoryId ? " WHERE category_id = ?" : ""}`).get(...(categoryId ? [categoryId] : [])) as { n: number }).n;
  }
  private category(id: string): { title: string; description: string; enabled: boolean } {
    const row = this.db.prepare("SELECT title, description, enabled FROM categories WHERE id = ?").get(id) as { title: string; description: string; enabled: number } | undefined;
    if (!row) throw new Error(`unknown category: ${id}`);
    return { ...row, enabled: Boolean(row.enabled) };
  }
  private fragment(id: string): Fragment & { position: number } {
    const row = this.db.prepare("SELECT category_id, title, description, body, enabled, position FROM fragments WHERE id = ?").get(id) as {
      category_id: string; title: string; description: string; body: string; enabled: number; position: number;
    } | undefined;
    if (!row) throw new Error(`unknown fragment: ${id}`);
    return { id, categoryId: row.category_id, title: row.title, description: row.description, body: row.body, enabled: Boolean(row.enabled), position: row.position };
  }
  private ids(table: "categories" | "fragments", categoryId?: string): string[] {
    return (this.db.prepare(`SELECT id FROM ${table}${categoryId ? " WHERE category_id = ?" : ""} ORDER BY position, id`)
      .all(...(categoryId ? [categoryId] : [])) as Array<{ id: string }>).map((row) => row.id);
  }
  private reindex(table: "categories" | "fragments", categoryId?: string): void {
    this.ids(table, categoryId).forEach((id, index) => this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(index, id));
  }
  private reorder(table: "categories" | "fragments", ids: string[], categoryId?: string): void {
    const current = this.ids(table, categoryId);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id)))
      throw new Error(`reorder must contain every ${categoryId ? "fragment in the category" : "category"} exactly once`);
    ids.forEach((id, index) => this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(index, id));
  }
}
