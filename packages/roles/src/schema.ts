import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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

/** A single transaction preserves legacy bytes and identities, including pre-timestamp stores. */
export function initializeRoles(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!tables.has("roles")) {
      db.exec(`
        CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL,
          revision INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE role_catalog (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
          default_role_id TEXT REFERENCES roles(id));
        INSERT INTO role_catalog VALUES (1, 0, NULL);
      `);
      const legacy = tables.has("revision");
      const roleId = randomUUID();
      if (legacy) {
        const { value } = db.prepare("SELECT value FROM revision WHERE singleton = 1").get() as { value: number };
        db.prepare("INSERT INTO roles VALUES (?, 'Default', '', ?, NULL, NULL)").run(roleId, value);
        db.prepare("UPDATE role_catalog SET revision = 1, default_role_id = ?").run(roleId);
      }
      for (const [table, definition] of Object.entries(resources)) {
        if (tables.has(table)) {
          if (table === "categories" || table === "fragments") {
            const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
            for (const column of ["created_at", "updated_at"]) if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
          }
          db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
        }
        db.exec(`CREATE TABLE ${table} (${definition}); CREATE INDEX ${table}_role ON ${table}(role_id)`);
        if (tables.has(table)) {
          const columns = (db.prepare(`PRAGMA table_info(legacy_${table})`).all() as Array<{ name: string }>).map(({ name }) => name).join(", ");
          db.prepare(`INSERT INTO ${table} (${columns}, role_id) SELECT ${columns}, ? FROM legacy_${table}`).run(roleId);
        }
      }
      // Drop children before their old category table. The new composite FK targets the new table.
      for (const table of ["fragments", "categories", "skills", "role_mcp_servers", "trusted_projects"]) {
        if (tables.has(table)) db.exec(`DROP TABLE legacy_${table}`);
      }
      if (legacy) db.exec("DROP TABLE revision");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS disabled_internal_mcp (
      role_id TEXT NOT NULL REFERENCES roles(id), name TEXT NOT NULL, PRIMARY KEY(role_id, name)
    )`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
