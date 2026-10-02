import { chmodSync, closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { initializeRoles } from "./schema.js";
import { botMarkdown, starterBotMarkdown } from "./bot-markdown.js";
import { fragmentConditions, matchesConditions, renderContext, type FragmentConditions, type RenderContext } from "./conditions.js";
import { mcpRecord, skillRecord, trustedProjectRecord, type RoleMcpServer, type Skill, type TrustedProject } from "./resources.js";
import { canonicalMcpName } from "@stack/api";
import { capabilityHarnesses, normalizedInternalMcpHarnesses, type CapabilityHarness, type CapabilityHarnesses } from "./capabilities.js";

/** Unix milliseconds; null on records written before the store kept timestamps. */
type Stamps = { createdAt: number | null; updatedAt: number | null };
export type Fragment = { id: string; categoryId: string; title: string; description: string; body: string; enabled: boolean; conditions?: FragmentConditions } & Stamps;
export type Category = { id: string; title: string; description: string; enabled: boolean; fragments: Fragment[] } & Stamps;
export const roleName = z.string().trim().min(1).max(200).describe("Human-readable role name; unique case-insensitively.");
export const roleDescription = z.string().max(4_000);
export type Role = { id: string; name: string; description: string; revision: number } & Stamps;
export type RoleCatalog = { revision: number; defaultRoleId: string | null; workerDefaultRoleId: string | null; roles: Role[] };
export type RoleSnapshot = Role & { botMarkdown?: string; categories: Category[]; skills: Skill[]; mcpServers: RoleMcpServer[]; trustedProjects: TrustedProject[]; disabledInternalMcpServers: string[];
  internalMcpHarnesses?: Record<string, CapabilityHarness[]> };

function canonicalProjectRoot(path: string): string {
  if (!statSync(path).isDirectory()) throw new Error(`project root is not a directory: ${path}`);
  return realpathSync(path);
}

export const instructionLimitBytes = 262_144;
/** The largest role_snapshot, in JSON characters, a write may leave behind. */
export const snapshotLimitChars = 750_000;
/** Where one fragment's body sits in the rendered text, as string (UTF-16) offsets. */
export type RenderedSegment = { categoryId: string; fragmentId: string; start: number; end: number };

/** The rendered developer instructions and each contributing fragment's span; blank-line separators belong to no segment. */
export function renderSegments(snapshot: Pick<RoleSnapshot, "categories">, context: RenderContext = {}): { rendered: string; segments: RenderedSegment[] } {
  context = renderContext.parse(context);
  const segments: RenderedSegment[] = [];
  let rendered = "";
  for (const category of snapshot.categories) {
    if (!category.enabled) continue;
    for (const fragment of category.fragments) {
      if (!fragment.enabled || !fragment.body.trim() || !matchesConditions(fragment.conditions, context)) continue;
      if (rendered) rendered += "\n\n";
      segments.push({ categoryId: category.id, fragmentId: fragment.id, start: rendered.length, end: rendered.length + fragment.body.length });
      rendered += fragment.body;
    }
  }
  if (Buffer.byteLength(rendered) > instructionLimitBytes) throw new Error(`rendered instructions exceed ${instructionLimitBytes} bytes`);
  return { rendered, segments };
}

export function renderInstructions(snapshot: Pick<RoleSnapshot, "categories">, context: RenderContext = {}): string {
  return renderSegments(snapshot, context).rendered;
}

/** Bot launches append the Role's personality; Workers and injected CLIs keep their existing instructions. */
export function renderBotInstructions(snapshot: Pick<RoleSnapshot, "categories" | "botMarkdown">, context: RenderContext = {}): string {
  const instructions = renderInstructions(snapshot, context);
  const personality = snapshot.botMarkdown ?? "";
  const rendered = [instructions, personality.trim() ? `# Role personality (bot.md)\n\n${personality}` : ""].filter(Boolean).join("\n\n");
  if (Buffer.byteLength(rendered) > instructionLimitBytes) throw new Error(`rendered Bot instructions exceed ${instructionLimitBytes} bytes`);
  return rendered;
}

/** Publish a complete fresh catalog without replacing any existing filesystem entry. */
function initializeMissingStore(stateDir: string): void {
  const path = join(stateDir, "roles.sqlite");
  if (lstatSync(path, { throwIfNoEntry: false })) return;
  if (lstatSync(join(stateDir, "capabilities.sqlite"), { throwIfNoEntry: false }))
    throw new Error("roles_store_legacy\nLegacy capabilities.sqlite exists; inspect and replace or convert it offline before initializing Roles. No initialization was attempted.");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(stateDir, ".roles-init-"));
  const prepared = join(temporary, "roles.sqlite");
  let db: DatabaseSync | undefined;
  try {
    closeSync(openSync(prepared, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    db = new DatabaseSync(prepared);
    initializeRoles(db);
    db.close(); db = undefined;
    // An exclusive hard link publishes only the closed, initialized database.
    // Concurrent initializers use whichever complete catalog wins; no reader
    // can observe an empty database or a half-provisioned pair of defaults.
    try { linkSync(prepared, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    try { db?.close(); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

export class RoleStore {
  private readonly db: DatabaseSync;

  constructor(stateDir: string, options: { readOnly?: boolean; initializeIfMissing?: boolean } = {}) {
    if (options.readOnly) {
      if (options.initializeIfMissing) initializeMissingStore(stateDir);
      const path = join(stateDir, "roles.sqlite");
      if (!existsSync(path)) throw new Error("roles_store_missing\nRoles store missing; run stack roles inject or stack serve to initialize the default Roles.");
      try { this.db = new DatabaseSync(path, { readOnly: true }); }
      catch (error) { throw new Error("roles_store_unavailable\nExisting Roles store cannot be opened read-only; inspect or restore it with the Roles owner before injecting. No initialization was attempted.", { cause: error }); }
      try {
        this.db.exec("PRAGMA busy_timeout = 5000");
        // Read every shape in one snapshot. This checks the current schema
        // without initializing, migrating, chmodding or creating directories.
        transaction(this.db, false, () => {
          const catalog = this.readCatalog();
          for (const role of catalog.roles) this.role(role.id).readSnapshot();
          if (!catalog.defaultRoleId || !catalog.workerDefaultRoleId) throw new Error("missing catalog defaults");
          this.role(catalog.defaultRoleId).metadata();
          this.role(catalog.workerDefaultRoleId).metadata();
        });
      } catch (error) {
        this.db.close();
        throw new Error("roles_store_incompatible\nExisting Roles store is incompatible; inspect or upgrade it with the Roles owner before injecting. No migration was attempted.", { cause: error });
      }
      return;
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = join(stateDir, "roles.sqlite");
    const legacy = join(stateDir, "capabilities.sqlite");
    if (existsSync(legacy)) throw new Error("legacy capabilities.sqlite exists; inspect and replace or convert it offline before starting Roles");
    initializeMissingStore(stateDir);
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    try { initializeRoles(this.db); }
    catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  role(roleId: string): RoleContents { return new RoleContents(this.db, roleId); }

  catalog(): RoleCatalog { return transaction(this.db, false, () => this.readCatalog()); }

  private readCatalog(): RoleCatalog {
    return readCatalog(this.db);
  }

  /** Resolve an explicit Role or the audience's default in the same SQLite snapshot. */
  launchSnapshot(roleId?: string, audience: "bot" | "worker" = "bot"): RoleSnapshot {
    return transaction(this.db, false, () => {
      if (roleId) return this.role(roleId).readSnapshot();
      const catalog = this.readCatalog();
      const selected = audience === "worker" ? catalog.workerDefaultRoleId : catalog.defaultRoleId;
      if (!selected) throw new Error(`no ${audience} default role; provision Roles before launching`);
      return this.role(selected).readSnapshot();
    });
  }

  defaultSnapshot(): RoleSnapshot { return this.launchSnapshot(); }

  /** Injection resolves names and reads complete resources in one SQLite snapshot. */
  namedLaunchSnapshot(name: string): RoleSnapshot {
    return transaction(this.db, false, () => {
      const catalog = this.readCatalog();
      const fold = (text: string) => text.replace(/[A-Z]/g, char => char.toLowerCase());
      const selected = name === "default" ? catalog.defaultRoleId : catalog.roles.find(role => fold(role.name) === fold(name))?.id;
      if (!selected) throw new Error(name === "default" ? "no Bot default Role; run stack serve and provision Roles" : `unknown Role name: ${name}`);
      return this.role(selected).readSnapshot();
    });
  }

  createRole(expectedRevision: number, name: string, description = "", personality = starterBotMarkdown): RoleCatalog {
    return this.changeCatalog(expectedRevision, () => {
      const id = randomUUID();
      const now = Date.now();
      this.db.prepare("INSERT INTO roles VALUES (?, ?, ?, 0, ?, ?)").run(id, roleName.parse(name), roleDescription.parse(description), now, now);
      this.db.prepare("INSERT INTO role_bot_markdown VALUES (?, ?)").run(id, botMarkdown.parse(personality));
      this.db.prepare("UPDATE role_catalog SET default_role_id = ? WHERE default_role_id IS NULL").run(id);
    });
  }

  setDefault(expectedRevision: number, roleId: string): RoleCatalog {
    return this.changeCatalog(expectedRevision, () => {
      this.role(roleId).metadata();
      this.db.prepare("UPDATE role_catalog SET default_role_id = ? WHERE singleton = 1").run(roleId);
    });
  }

  setWorkerDefault(expectedRevision: number, roleId: string): RoleCatalog {
    return this.changeCatalog(expectedRevision, () => {
      this.role(roleId).metadata();
      this.db.prepare("UPDATE role_catalog SET worker_default_role_id = ? WHERE singleton = 1").run(roleId);
    });
  }

  deleteRole(expectedRevision: number, roleId: string): RoleCatalog {
    return this.changeCatalog(expectedRevision, () => {
      this.role(roleId).metadata();
      const catalog = this.readCatalog();
      if (catalog.defaultRoleId === roleId) throw new Error("cannot delete the default role; mark another role as default first");
      if (catalog.workerDefaultRoleId === roleId) throw new Error("cannot delete the Worker default role; select another Worker default first");
      for (const table of ["fragments", "categories", "skills", "role_mcp_servers", "trusted_projects", "disabled_internal_mcp", "internal_mcp_harnesses", "role_bot_markdown"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE role_id = ?`).run(roleId);
      }
      this.db.prepare("DELETE FROM roles WHERE id = ?").run(roleId);
    });
  }

  private changeCatalog(expectedRevision: number, mutate: () => void): RoleCatalog {
    return transaction(this.db, true, () => {
      const revision = this.readCatalog().revision;
      if (revision !== expectedRevision) throw new Error(`stale role catalog revision: expected ${expectedRevision}, current ${revision}`);
      mutate();
      this.db.exec("UPDATE role_catalog SET revision = revision + 1 WHERE singleton = 1");
      const result = this.readCatalog();
      if (JSON.stringify(result).length > snapshotLimitChars) throw new Error("role catalog exceeds the socket response budget");
      return result;
    });
  }
}

function readCatalog(db: DatabaseSync): RoleCatalog {
  const row = db.prepare("SELECT revision, default_role_id, worker_default_role_id FROM role_catalog WHERE singleton = 1").get() as {
    revision: number; default_role_id: string | null; worker_default_role_id: string | null;
  };
  const roles = db.prepare("SELECT id, name, description, revision, created_at AS createdAt, updated_at AS updatedAt FROM roles ORDER BY rowid").all() as Role[];
  return { revision: row.revision, defaultRoleId: row.default_role_id, workerDefaultRoleId: row.worker_default_role_id, roles };
}

function transaction<T>(db: DatabaseSync, write: boolean, action: () => T): T {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** A scoped view, sharing its owner's connection. Resource IDs never select another Role. */
export class RoleContents {
  constructor(private readonly db: DatabaseSync, readonly roleId: string) {}

  metadata(): Role {
    const role = this.db.prepare("SELECT id, name, description, revision, created_at AS createdAt, updated_at AS updatedAt FROM roles WHERE id = ?").get(this.roleId) as Role | undefined;
    if (!role) throw new Error(`unknown role: ${this.roleId}`);
    return role;
  }

  update(expectedRevision: number, fields: { name?: string; description?: string; botMarkdown?: string }): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const current = this.metadata();
      this.db.prepare("UPDATE roles SET name = ?, description = ? WHERE id = ?")
        .run(roleName.parse(fields.name ?? current.name), roleDescription.parse(fields.description ?? current.description), this.roleId);
      if (fields.botMarkdown !== undefined) this.db.prepare("UPDATE role_bot_markdown SET body=? WHERE role_id=?").run(botMarkdown.parse(fields.botMarkdown), this.roleId);
    });
  }

  setInternalMcp(expectedRevision: number, name: string, enabled?: boolean, harnesses?: CapabilityHarnesses): RoleSnapshot {
    return this.change(expectedRevision, () => {
      name = canonicalMcpName(name);
      if (enabled !== undefined) {
        if (enabled) this.db.prepare("DELETE FROM disabled_internal_mcp WHERE role_id = ? AND name = ?").run(this.roleId, name);
        else this.db.prepare("INSERT OR IGNORE INTO disabled_internal_mcp VALUES (?, ?)").run(this.roleId, name);
      }
      if (harnesses !== undefined) {
        const allowed = capabilityHarnesses.parse(harnesses);
        if (allowed === null) this.db.prepare("DELETE FROM internal_mcp_harnesses WHERE role_id=? AND name=?").run(this.roleId, name);
        else this.db.prepare("INSERT INTO internal_mcp_harnesses VALUES (?, ?, ?) ON CONFLICT(role_id,name) DO UPDATE SET harnesses_json=excluded.harnesses_json")
          .run(this.roleId, name, JSON.stringify(allowed));
      }
    });
  }

  snapshot(): RoleSnapshot {
    this.db.exec("BEGIN");
    try {
      const value = this.readSnapshot();
      this.db.exec("COMMIT");
      return value;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  readSnapshot(): RoleSnapshot {
    const role = this.metadata();
    const rows = this.db.prepare("SELECT id, title, description, enabled, created_at, updated_at FROM categories WHERE role_id = ? ORDER BY position, id").all(this.roleId) as Array<{
      id: string; title: string; description: string; enabled: number; created_at: number | null; updated_at: number | null;
    }>;
    const fragments = this.db.prepare("SELECT id, category_id, title, description, body, enabled, conditions_json, created_at, updated_at FROM fragments WHERE role_id = ? ORDER BY category_id, position, id").all(this.roleId) as Array<{
      id: string; category_id: string; title: string; description: string; body: string; enabled: number; conditions_json: string; created_at: number | null; updated_at: number | null;
    }>;
    const categories = rows.map(({ enabled, created_at, updated_at, ...row }): Category => ({
      ...row, enabled: Boolean(enabled), fragments: [], createdAt: created_at, updatedAt: updated_at,
    }));
    const byId = new Map(categories.map((category) => [category.id, category]));
    for (const { category_id, enabled, conditions_json, created_at, updated_at, ...fragment } of fragments) {
      byId.get(category_id)?.fragments.push({ ...fragment, conditions: fragmentConditions.parse(JSON.parse(conditions_json)), categoryId: category_id, enabled: Boolean(enabled), createdAt: created_at, updatedAt: updated_at });
    }
    // Injection is structurally read-only. Existing pre-filter stores are readable
    // as unrestricted until the Roles owner applies the additive schema upgrade.
    const harnessColumn = (table: string) => this.db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === "harnesses_json")
      ? "harnesses_json" : "NULL AS harnesses_json";
    const skills = (this.db.prepare(`SELECT id, name, description, body, files_json, enabled, ${harnessColumn("skills")} FROM skills WHERE role_id = ? ORDER BY position, id`).all(this.roleId) as Array<{
      id: string; name: string; description: string; body: string; files_json: string; enabled: number; harnesses_json: string | null;
    }>).map(({ files_json, harnesses_json, enabled, ...row }) => skillRecord.parse({ ...row, files: JSON.parse(files_json), enabled: Boolean(enabled), harnesses: harnesses_json === null ? null : JSON.parse(harnesses_json) }));
    const mcpServers = (this.db.prepare(`SELECT id, name, description, definition_json, enabled, ${harnessColumn("role_mcp_servers")} FROM role_mcp_servers WHERE role_id = ? ORDER BY position, id`).all(this.roleId) as Array<{
      id: string; name: string; description: string; definition_json: string; enabled: number; harnesses_json: string | null;
    }>).map(({ definition_json, harnesses_json, enabled, ...row }) => mcpRecord.parse({ ...row, definition: JSON.parse(definition_json), enabled: Boolean(enabled), harnesses: harnesses_json === null ? null : JSON.parse(harnesses_json) }));
    const trustedProjects = (this.db.prepare("SELECT id, path, description, enabled FROM trusted_projects WHERE role_id = ? ORDER BY position, id").all(this.roleId) as Array<{
      id: string; path: string; description: string; enabled: number;
    }>).map(({ enabled, ...row }) => trustedProjectRecord.parse({ ...row, enabled: Boolean(enabled) }));
    const disabledInternalMcpServers = [...new Set((this.db.prepare("SELECT name FROM disabled_internal_mcp WHERE role_id = ? ORDER BY name").all(this.roleId) as Array<{ name: string }>).map(({ name }) => canonicalMcpName(name)))].sort();
    const internalRows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='internal_mcp_harnesses'").get()
      ? this.db.prepare("SELECT name, harnesses_json FROM internal_mcp_harnesses WHERE role_id=? ORDER BY name").all(this.roleId) as Array<{ name: string; harnesses_json: string }>
      : [];
    const internalMcpHarnesses = normalizedInternalMcpHarnesses(Object.fromEntries(internalRows.map(({ name, harnesses_json }) => [name, JSON.parse(harnesses_json)])));
    const personality = this.db.prepare("SELECT body FROM role_bot_markdown WHERE role_id=?").get(this.roleId) as { body: string };
    return { ...role, botMarkdown: personality.body, categories, skills, mcpServers, trustedProjects, disabledInternalMcpServers, internalMcpHarnesses };
  }

  createCategory(expectedRevision: number, title: string, description = "", enabled = true): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const position = this.count("categories");
      const now = Date.now();
      this.db.prepare("INSERT INTO categories (id, title, description, enabled, position, created_at, updated_at, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), title, description, Number(enabled), position, now, now, this.roleId);
    });
  }

  updateCategory(expectedRevision: number, id: string, fields: { title?: string; description?: string; enabled?: boolean }): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const existing = this.category(id);
      this.db.prepare("UPDATE categories SET title = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(fields.title ?? existing.title, fields.description ?? existing.description, Number(fields.enabled ?? existing.enabled), Date.now(), id);
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

  /** Appends by default; `index` inserts at that zero-based position in the category. */
  createFragment(expectedRevision: number, categoryId: string, title: string, body: string, description = "", enabled = true, index?: number, conditions: FragmentConditions = {}): RoleSnapshot {
    return this.change(expectedRevision, () => {
      this.category(categoryId);
      const siblings = this.ids("fragments", categoryId);
      if (index !== undefined) this.insertionIndex(index, siblings.length);
      const id = randomUUID();
      const now = Date.now();
      this.db.prepare("INSERT INTO fragments (id, category_id, title, description, body, enabled, position, created_at, updated_at, role_id, conditions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, categoryId, title, description, body, Number(enabled), siblings.length, now, now, this.roleId, JSON.stringify(fragmentConditions.parse(conditions)));
      if (index !== undefined) this.place("fragments", [...siblings.slice(0, index), id, ...siblings.slice(index)]);
    });
  }

  updateFragment(expectedRevision: number, id: string, fields: { categoryId?: string; title?: string; body?: string; description?: string; enabled?: boolean; conditions?: FragmentConditions }): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const existing = this.fragment(id);
      if (fields.conditions !== undefined) this.db.prepare("UPDATE fragments SET conditions_json = ? WHERE id = ?").run(JSON.stringify(fragmentConditions.parse(fields.conditions)), id);
      const categoryId = fields.categoryId ?? existing.categoryId;
      if (categoryId !== existing.categoryId) this.category(categoryId);
      const position = categoryId === existing.categoryId ? existing.position : this.count("fragments", categoryId);
      this.db.prepare("UPDATE fragments SET category_id = ?, title = ?, description = ?, body = ?, enabled = ?, position = ?, updated_at = ? WHERE id = ?")
        .run(categoryId, fields.title ?? existing.title, fields.description ?? existing.description, fields.body ?? existing.body,
          Number(fields.enabled ?? existing.enabled), position, Date.now(), id);
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

  /** Atomically place a fragment at a zero-based index of a category, which may be its own. Changing category counts as an update. */
  moveFragment(expectedRevision: number, id: string, categoryId: string, index: number): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const existing = this.fragment(id);
      this.category(categoryId);
      const siblings = this.ids("fragments", categoryId).filter((item) => item !== id);
      this.insertionIndex(index, siblings.length);
      if (categoryId !== existing.categoryId) {
        this.db.prepare("UPDATE fragments SET category_id = ?, updated_at = ? WHERE id = ?").run(categoryId, Date.now(), id);
        this.reindex("fragments", existing.categoryId);
      }
      this.place("fragments", [...siblings.slice(0, index), id, ...siblings.slice(index)]);
    });
  }

  createSkill(expectedRevision: number, name: string, description: string, body: string, files: Skill["files"] = [], enabled = true, harnesses: CapabilityHarnesses = null): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const skill = skillRecord.parse({ id: randomUUID(), name, description, body, files, enabled, harnesses });
      this.db.prepare("INSERT INTO skills (id,name,description,body,files_json,enabled,position,role_id,harnesses_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(skill.id, skill.name, skill.description, skill.body, JSON.stringify(skill.files), Number(skill.enabled), this.count("skills"), this.roleId, skill.harnesses === null ? null : JSON.stringify(skill.harnesses));
    });
  }

  updateSkill(expectedRevision: number, id: string, fields: Partial<Omit<Skill, "id">>): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const current = this.skill(id);
      const skill = skillRecord.parse({ ...current, ...fields, harnesses: fields.harnesses === undefined ? current.harnesses : fields.harnesses });
      this.db.prepare("UPDATE skills SET name = ?, description = ?, body = ?, files_json = ?, enabled = ?, harnesses_json = ? WHERE id = ?")
        .run(skill.name, skill.description, skill.body, JSON.stringify(skill.files), Number(skill.enabled), skill.harnesses == null ? null : JSON.stringify(skill.harnesses), id);
    });
  }

  deleteSkill(expectedRevision: number, id: string): RoleSnapshot {
    return this.change(expectedRevision, () => { this.skill(id); this.db.prepare("DELETE FROM skills WHERE id = ?").run(id); this.reindex("skills"); });
  }

  reorderSkills(expectedRevision: number, ids: string[]): RoleSnapshot {
    return this.change(expectedRevision, () => this.reorder("skills", ids));
  }

  createMcpServer(expectedRevision: number, name: string, description: string, definition: RoleMcpServer["definition"], enabled = true, harnesses: CapabilityHarnesses = null): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const server = mcpRecord.parse({ id: randomUUID(), name, description, definition, enabled, harnesses });
      this.db.prepare("INSERT INTO role_mcp_servers (id,name,description,definition_json,enabled,position,role_id,harnesses_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(server.id, server.name, server.description, JSON.stringify(server.definition), Number(server.enabled), this.count("role_mcp_servers"), this.roleId, server.harnesses === null ? null : JSON.stringify(server.harnesses));
    });
  }

  updateMcpServer(expectedRevision: number, id: string, fields: Partial<Omit<RoleMcpServer, "id">>): RoleSnapshot {
    return this.change(expectedRevision, () => {
      const current = this.mcpServer(id);
      const server = mcpRecord.parse({ ...current, ...fields, harnesses: fields.harnesses === undefined ? current.harnesses : fields.harnesses });
      this.db.prepare("UPDATE role_mcp_servers SET name = ?, description = ?, definition_json = ?, enabled = ?, harnesses_json = ? WHERE id = ?")
        .run(server.name, server.description, JSON.stringify(server.definition), Number(server.enabled), server.harnesses == null ? null : JSON.stringify(server.harnesses), id);
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
      this.db.prepare("INSERT INTO trusted_projects VALUES (?, ?, ?, ?, ?, ?)")
        .run(project.id, project.path, project.description, Number(project.enabled), this.count("trusted_projects"), this.roleId);
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
    return transaction(this.db, true, () => {
      const revision = this.metadata().revision;
      if (revision !== expectedRevision) throw new Error(`stale role revision: expected ${expectedRevision}, current ${revision}`);
      mutate();
      this.db.prepare("UPDATE roles SET revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), this.roleId);
      this.db.exec("UPDATE role_catalog SET revision = revision + 1 WHERE singleton = 1");
      const snapshot = this.readSnapshot();
      // Conservative bound across every context, including mutually exclusive conditions.
      renderBotInstructions({ botMarkdown: snapshot.botMarkdown, categories: snapshot.categories.map((category) => ({ ...category, fragments: category.fragments.map((fragment) => ({ ...fragment, conditions: {} })) })) });
      if (JSON.stringify(snapshot).length > snapshotLimitChars) throw new Error("role snapshot exceeds the socket response budget");
      if (JSON.stringify(readCatalog(this.db)).length > snapshotLimitChars) throw new Error("role catalog exceeds the socket response budget");
      return snapshot;
    });
  }

  private count(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", categoryId?: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE role_id = ?${categoryId ? " AND category_id = ?" : ""}`).get(this.roleId, ...(categoryId ? [categoryId] : [])) as { n: number }).n;
  }
  private category(id: string): { title: string; description: string; enabled: boolean } {
    const row = this.db.prepare("SELECT title, description, enabled FROM categories WHERE id = ? AND role_id = ?").get(id, this.roleId) as { title: string; description: string; enabled: number } | undefined;
    if (!row) throw new Error(`unknown category: ${id}`);
    return { ...row, enabled: Boolean(row.enabled) };
  }
  private fragment(id: string): Omit<Fragment, "createdAt" | "updatedAt"> & { position: number } {
    const row = this.db.prepare("SELECT category_id, title, description, body, enabled, position FROM fragments WHERE id = ? AND role_id = ?").get(id, this.roleId) as {
      category_id: string; title: string; description: string; body: string; enabled: number; position: number;
    } | undefined;
    if (!row) throw new Error(`unknown fragment: ${id}`);
    return { id, categoryId: row.category_id, title: row.title, description: row.description, body: row.body, enabled: Boolean(row.enabled), position: row.position };
  }
  private skill(id: string): Skill {
    const row = this.db.prepare("SELECT id, name, description, body, files_json, enabled, harnesses_json FROM skills WHERE id = ? AND role_id = ?").get(id, this.roleId) as {
      id: string; name: string; description: string; body: string; files_json: string; enabled: number; harnesses_json: string | null;
    } | undefined;
    if (!row) throw new Error(`unknown skill: ${id}`);
    const { files_json, harnesses_json, enabled, ...fields } = row;
    return skillRecord.parse({ ...fields, files: JSON.parse(files_json), enabled: Boolean(enabled), harnesses: harnesses_json === null ? null : JSON.parse(harnesses_json) });
  }
  private mcpServer(id: string): RoleMcpServer {
    const row = this.db.prepare("SELECT id, name, description, definition_json, enabled, harnesses_json FROM role_mcp_servers WHERE id = ? AND role_id = ?").get(id, this.roleId) as {
      id: string; name: string; description: string; definition_json: string; enabled: number; harnesses_json: string | null;
    } | undefined;
    if (!row) throw new Error(`unknown MCP server: ${id}`);
    const { definition_json, harnesses_json, enabled, ...fields } = row;
    return mcpRecord.parse({ ...fields, definition: JSON.parse(definition_json), enabled: Boolean(enabled), harnesses: harnesses_json === null ? null : JSON.parse(harnesses_json) });
  }
  private trustedProject(id: string): TrustedProject {
    const row = this.db.prepare("SELECT id, path, description, enabled FROM trusted_projects WHERE id = ? AND role_id = ?").get(id, this.roleId) as {
      id: string; path: string; description: string; enabled: number;
    } | undefined;
    if (!row) throw new Error(`unknown trusted project: ${id}`);
    return trustedProjectRecord.parse({ ...row, enabled: Boolean(row.enabled) });
  }
  private ids(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", categoryId?: string): string[] {
    return (this.db.prepare(`SELECT id FROM ${table} WHERE role_id = ?${categoryId ? " AND category_id = ?" : ""} ORDER BY position, id`)
      .all(this.roleId, ...(categoryId ? [categoryId] : [])) as Array<{ id: string }>).map((row) => row.id);
  }
  private reindex(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", categoryId?: string): void {
    this.place(table, this.ids(table, categoryId));
  }
  private reorder(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", ids: string[], categoryId?: string): void {
    const current = this.ids(table, categoryId);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id)))
      throw new Error(`reorder must contain every ${categoryId ? "fragment in the category" : table === "skills" ? "skill" : table === "role_mcp_servers" ? "MCP server" : table === "trusted_projects" ? "trusted project" : "category"} exactly once`);
    this.place(table, ids);
  }
  private place(table: "categories" | "fragments" | "skills" | "role_mcp_servers" | "trusted_projects", ids: string[]): void {
    ids.forEach((id, index) => this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(index, id));
  }
  private insertionIndex(index: number, length: number): void {
    if (!Number.isInteger(index) || index < 0 || index > length) throw new Error(`index must be between 0 and ${length}`);
  }
}
