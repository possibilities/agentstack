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
          default_role_id TEXT REFERENCES roles(id), worker_default_role_id TEXT REFERENCES roles(id));
        INSERT INTO role_catalog VALUES (1, 0, NULL, NULL);
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
    const columns = new Set((db.prepare("PRAGMA table_info(role_catalog)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("worker_default_role_id")) db.exec("ALTER TABLE role_catalog ADD COLUMN worker_default_role_id TEXT REFERENCES roles(id)");
    const catalog = db.prepare("SELECT default_role_id, worker_default_role_id FROM role_catalog WHERE singleton = 1").get() as {
      default_role_id: string | null; worker_default_role_id: string | null;
    };
    if (!catalog.worker_default_role_id) {
      const managerId = catalog.default_role_id ?? randomUUID();
      const workerId = randomUUID();
      const conflicting = db.prepare("SELECT name FROM roles WHERE name IN ('Manager', 'Worker') COLLATE NOCASE AND id != ?").all(managerId) as Array<{ name: string }>;
      if (conflicting.length) throw new Error(`cannot provision Manager and Worker Roles: existing ${conflicting.map(({ name }) => name).join(", ")} Role; resolve the name conflict before starting Stack`);
      const now = Date.now();
      if (catalog.default_role_id) {
        db.prepare("UPDATE roles SET name = 'Manager', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, managerId);
      } else {
        db.prepare("INSERT INTO roles VALUES (?, 'Manager', '', 0, ?, ?)").run(managerId, now, now);
      }
      db.prepare("INSERT INTO roles VALUES (?, 'Worker', '', 0, ?, ?)").run(workerId, now, now);
      // Resource IDs are globally unique, while names and order belong to each Role.
      for (const row of db.prepare("SELECT name, description, body, files_json, enabled, position FROM skills WHERE role_id = ? ORDER BY position").all(managerId) as Array<{
        name: string; description: string; body: string; files_json: string; enabled: number; position: number;
      }>) db.prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), row.name, row.description, row.body, row.files_json, row.enabled, row.position, workerId);
      for (const row of db.prepare("SELECT name, description, definition_json, enabled, position FROM role_mcp_servers WHERE role_id = ? ORDER BY position").all(managerId) as Array<{
        name: string; description: string; definition_json: string; enabled: number; position: number;
      }>) db.prepare("INSERT INTO role_mcp_servers VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), row.name, row.description, row.definition_json, row.enabled, row.position, workerId);
      for (const row of db.prepare("SELECT path, description, enabled, position FROM trusted_projects WHERE role_id = ? ORDER BY position").all(managerId) as Array<{
        path: string; description: string; enabled: number; position: number;
      }>) db.prepare("INSERT INTO trusted_projects VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), row.path, row.description, row.enabled, row.position, workerId);
      db.prepare("INSERT INTO disabled_internal_mcp SELECT ?, name FROM disabled_internal_mcp WHERE role_id = ?").run(workerId, managerId);
      db.prepare("UPDATE role_catalog SET default_role_id = ?, worker_default_role_id = ?, revision = revision + 1 WHERE singleton = 1").run(managerId, workerId);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
