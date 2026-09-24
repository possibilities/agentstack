import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, realpathSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mcpRecord, skillRecord, trustedProjectRecord, type RoleMcpServer, type Skill, type TrustedProject } from "./resources.js";

export type Fragment = { id: string; categoryId: string; title: string; description: string; body: string; enabled: boolean };
export type Category = { id: string; title: string; description: string; enabled: boolean; fragments: Fragment[] };
export type RoleSnapshot = { revision: number; categories: Category[]; skills: Skill[]; mcpServers: RoleMcpServer[]; trustedProjects: TrustedProject[] };

function canonicalProjectRoot(path: string): string {
  if (!statSync(path).isDirectory()) throw new Error(`project root is not a directory: ${path}`);
  return realpathSync(path);
}

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
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL,
        body TEXT NOT NULL, files_json TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL,
        definition_json TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trusted_projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
        enabled INTEGER NOT NULL, position INTEGER NOT NULL
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
    const skills = (this.db.prepare("SELECT id, name, description, body, files_json, enabled FROM skills ORDER BY position, id").all() as Array<{
      id: string; name: string; description: string; body: string; files_json: string; enabled: number;
    }>).map(({ files_json, enabled, ...row }) => skillRecord.parse({ ...row, files: JSON.parse(files_json), enabled: Boolean(enabled) }));
    const mcpServers = (this.db.prepare("SELECT id, name, description, definition_json, enabled FROM role_mcp_servers ORDER BY position, id").all() as Array<{
      id: string; name: string; description: string; definition_json: string; enabled: number;
    }>).map(({ definition_json, enabled, ...row }) => mcpRecord.parse({ ...row, definition: JSON.parse(definition_json), enabled: Boolean(enabled) }));
    const trustedProjects = (this.db.prepare("SELECT id, path, description, enabled FROM trusted_projects ORDER BY position, id").all() as Array<{
      id: string; path: string; description: string; enabled: number;
    }>).map(({ enabled, ...row }) => trustedProjectRecord.parse({ ...row, enabled: Boolean(enabled) }));
    return { revision, categories, skills, mcpServers, trustedProjects };
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

  createSkill(expectedRevision: number, name: string, description: string, body: string, files: Skill["files"] = [], enabled = true): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const skill = skillRecord.parse({ id: randomUUID(), name, description, body, files, enabled });
      this.db.prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(skill.id, skill.name, skill.description, skill.body, JSON.stringify(skill.files), Number(skill.enabled), this.count("skills"));
    });
  }

  updateSkill(expectedRevision: number, id: string, fields: Partial<Omit<Skill, "id">>): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const current = this.skill(id);
      const skill = skillRecord.parse({ ...current, ...fields });
      this.db.prepare("UPDATE skills SET name = ?, description = ?, body = ?, files_json = ?, enabled = ? WHERE id = ?")
        .run(skill.name, skill.description, skill.body, JSON.stringify(skill.files), Number(skill.enabled), id);
    });
  }

  deleteSkill(expectedRevision: number, id: string): RoleSnapshot {
    return this.change(expectedRevision, () => { this.skill(id); this.db.prepare("DELETE FROM skills WHERE id = ?").run(id); this.reindex("skills"); });
  }

  reorderSkills(expectedRevision: number, ids: string[]): RoleSnapshot {
    return this.change(expectedRevision, () => this.reorder("skills", ids));
  }

  createMcpServer(expectedRevision: number, name: string, description: string, definition: RoleMcpServer["definition"], enabled = true): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const server = mcpRecord.parse({ id: randomUUID(), name, description, definition, enabled });
      this.db.prepare("INSERT INTO role_mcp_servers VALUES (?, ?, ?, ?, ?, ?)")
        .run(server.id, server.name, server.description, JSON.stringify(server.definition), Number(server.enabled), this.count("role_mcp_servers"));
    });
  }

  updateMcpServer(expectedRevision: number, id: string, fields: Partial<Omit<RoleMcpServer, "id">>): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const current = this.mcpServer(id);
      const server = mcpRecord.parse({ ...current, ...fields });
      this.db.prepare("UPDATE role_mcp_servers SET name = ?, description = ?, definition_json = ?, enabled = ? WHERE id = ?")
        .run(server.name, server.description, JSON.stringify(server.definition), Number(server.enabled), id);
    });
  }

  deleteMcpServer(expectedRevision: number, id: string): RoleSnapshot {
    return this.change(expectedRevision, () => { this.mcpServer(id); this.db.prepare("DELETE FROM role_mcp_servers WHERE id = ?").run(id); this.reindex("role_mcp_servers"); });
  }

  reorderMcpServers(expectedRevision: number, ids: string[]): RoleSnapshot {
    return this.change(expectedRevision, () => this.reorder("role_mcp_servers", ids));
  }

  createTrustedProject(expectedRevision: number, path: string, description = "", enabled = true): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const project = trustedProjectRecord.parse({ id: randomUUID(), path: canonicalProjectRoot(path), description, enabled });
      this.db.prepare("INSERT INTO trusted_projects VALUES (?, ?, ?, ?, ?)")
        .run(project.id, project.path, project.description, Number(project.enabled), this.count("trusted_projects"));
    });
  }

  updateTrustedProject(expectedRevision: number, id: string, fields: Partial<Omit<TrustedProject, "id">>): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const current = this.trustedProject(id);
      const project = trustedProjectRecord.parse({ ...current, ...fields, path: fields.path === undefined ? current.path : canonicalProjectRoot(fields.path) });
      this.db.prepare("UPDATE trusted_projects SET path = ?, description = ?, enabled = ? WHERE id = ?")
        .run(project.path, project.description, Number(project.enabled), id);
    });
  }

  deleteTrustedProject(expectedRevision: number, id: string): RoleSnapshot {
    return this.change(expectedRevision, () => { this.trustedProject(id); this.db.prepare("DELETE FROM trusted_projects WHERE id = ?").run(id); this.reindex("trusted_projects"); });
  }

  reorderTrustedProjects(expectedRevision: number, ids: string[]): RoleSnapshot {
    return this.change(expectedRevision, () => this.reorder("trusted_projects", ids));
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
  private count(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", categoryId?: string): number {
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
  private skill(id: string): Skill {
    const row = this.db.prepare("SELECT id, name, description, body, files_json, enabled FROM skills WHERE id = ?").get(id) as {
      id: string; name: string; description: string; body: string; files_json: string; enabled: number;
    } | undefined;
    if (!row) throw new Error(`unknown skill: ${id}`);
    const { files_json, enabled, ...fields } = row;
    return skillRecord.parse({ ...fields, files: JSON.parse(files_json), enabled: Boolean(enabled) });
  }
  private mcpServer(id: string): RoleMcpServer {
    const row = this.db.prepare("SELECT id, name, description, definition_json, enabled FROM role_mcp_servers WHERE id = ?").get(id) as {
      id: string; name: string; description: string; definition_json: string; enabled: number;
    } | undefined;
    if (!row) throw new Error(`unknown MCP server: ${id}`);
    const { definition_json, enabled, ...fields } = row;
    return mcpRecord.parse({ ...fields, definition: JSON.parse(definition_json), enabled: Boolean(enabled) });
  }
  private trustedProject(id: string): TrustedProject {
    const row = this.db.prepare("SELECT id, path, description, enabled FROM trusted_projects WHERE id = ?").get(id) as {
      id: string; path: string; description: string; enabled: number;
    } | undefined;
    if (!row) throw new Error(`unknown trusted project: ${id}`);
    return trustedProjectRecord.parse({ ...row, enabled: Boolean(row.enabled) });
  }
  private ids(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", categoryId?: string): string[] {
    return (this.db.prepare(`SELECT id FROM ${table}${categoryId ? " WHERE category_id = ?" : ""} ORDER BY position, id`)
      .all(...(categoryId ? [categoryId] : [])) as Array<{ id: string }>).map((row) => row.id);
  }
  private reindex(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", categoryId?: string): void {
    this.ids(table, categoryId).forEach((id, index) => this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(index, id));
  }
  private reorder(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", ids: string[], categoryId?: string): void {
    const current = this.ids(table, categoryId);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id)))
      throw new Error(`reorder must contain every ${categoryId ? "fragment in the category" : table === "skills" ? "skill" : table === "role_mcp_servers" ? "MCP server" : table === "trusted_projects" ? "trusted project" : "category"} exactly once`);
    ids.forEach((id, index) => this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(index, id));
  }
}
