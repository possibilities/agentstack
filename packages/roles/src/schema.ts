import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { starterBotMarkdown } from "./bot-markdown.js";

const resources = {
  categories: `id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, enabled INTEGER NOT NULL,
    position INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER,
    role_id TEXT NOT NULL REFERENCES roles(id), UNIQUE(role_id, id)`,
  fragments: `id TEXT PRIMARY KEY, category_id TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL,
    position INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER,
    role_id TEXT NOT NULL REFERENCES roles(id), FOREIGN KEY(role_id, category_id) REFERENCES categories(role_id, id)`,
  skills: `id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, description TEXT NOT NULL,
    body TEXT NOT NULL, files_json TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id), UNIQUE(role_id, name)`,
  role_mcp_servers: `id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, description TEXT NOT NULL,
    definition_json TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id), UNIQUE(role_id, name)`,
  trusted_projects: `id TEXT PRIMARY KEY, path TEXT NOT NULL, description TEXT NOT NULL,
    enabled INTEGER NOT NULL, position INTEGER NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id), UNIQUE(role_id, path)`,
};

/** Initialize the catalog and apply additive fragment metadata upgrades. */
export function initializeRoles(db: DatabaseSync): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
  if (!tables.has("roles")) {
    if (["revision", "role_catalog", ...Object.keys(resources), "disabled_internal_mcp"].some((table) => tables.has(table)))
      throw new Error("older Roles database requires an offline replacement or conversion; no automatic migration is available");
  } else {
    const columns = new Set((db.prepare("PRAGMA table_info(role_catalog)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("worker_default_role_id") || !tables.has("disabled_internal_mcp") || Object.keys(resources).some((table) => !tables.has(table)))
      throw new Error("older Roles database requires an offline replacement or conversion; no automatic migration is available");
    const catalog = db.prepare("SELECT default_role_id, worker_default_role_id FROM role_catalog WHERE singleton = 1").get() as {
      default_role_id: string | null; worker_default_role_id: string | null;
    } | undefined;
    if (!catalog?.default_role_id || !catalog.worker_default_role_id)
      throw new Error("Roles catalog has no Bot or Worker default; inspect the store before starting Stack");
  }
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    if (!tables.has("roles")) {
      db.exec(`
        CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL,
          revision INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE role_catalog (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
          default_role_id TEXT REFERENCES roles(id), worker_default_role_id TEXT REFERENCES roles(id));
      `);
      for (const [table, definition] of Object.entries(resources))
        db.exec(`CREATE TABLE ${table} (${definition}); CREATE INDEX ${table}_role ON ${table}(role_id)`);
      db.exec(`CREATE TABLE disabled_internal_mcp (
        role_id TEXT NOT NULL REFERENCES roles(id), name TEXT NOT NULL, PRIMARY KEY(role_id, name)
      )`);
      const managerId = randomUUID();
      const workerId = randomUUID();
      const now = Date.now();
      db.prepare("INSERT INTO roles VALUES (?, 'Manager', '', 0, ?, ?)").run(managerId, now, now);
      db.prepare("INSERT INTO roles VALUES (?, 'Worker', '', 0, ?, ?)").run(workerId, now, now);
      db.prepare("INSERT INTO role_catalog VALUES (1, 1, ?, ?)").run(managerId, workerId);
    }
    const fragmentColumns = db.prepare("PRAGMA table_info(fragments)").all() as Array<{ name: string }>;
    if (!fragmentColumns.some(({ name }) => name === "conditions_json"))
      db.exec("ALTER TABLE fragments ADD COLUMN conditions_json TEXT NOT NULL DEFAULT '{}'");
    db.exec("CREATE TABLE IF NOT EXISTS role_bot_markdown (role_id TEXT PRIMARY KEY REFERENCES roles(id), body TEXT NOT NULL)");
    // Existing Roles retain their instructions; never seed over an edited personality.
    db.exec("INSERT OR IGNORE INTO role_bot_markdown SELECT id, '' FROM roles");
    if (!tables.has("roles")) db.prepare("UPDATE role_bot_markdown SET body=? WHERE role_id=(SELECT default_role_id FROM role_catalog)").run(starterBotMarkdown);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
