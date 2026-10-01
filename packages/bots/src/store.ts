import { AuthStore } from "@stack/auth";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SettingsStore, type SettingValues } from "@stack/settings";
import { orientationState, type Orientation } from "./orientation.js";

export type BotSettings = {
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
};

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  model: "gpt-6-sol",
  reasoningEffort: "medium",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
};

function parseSettings(raw: string): BotSettings {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("invalid stored Bot settings");
  const settings = value as Record<string, unknown>;
  if (settings.model !== undefined && (typeof settings.model !== "string" || !settings.model.trim())
    || settings.reasoningEffort !== undefined && (typeof settings.reasoningEffort !== "string" || !settings.reasoningEffort)
    || settings.sandboxMode !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(String(settings.sandboxMode))
    || settings.approvalPolicy !== undefined && !["untrusted", "on-failure", "on-request", "never"].includes(String(settings.approvalPolicy))) throw new Error("invalid stored Bot settings");
  return settings as BotSettings;
}

export type StoredServer = {
  id: string;
  pid: number | null;
  cwd: string;
  url: string | null;
  state: "running" | "stopped";
  codexBin: string;
  account: string | null;
  launchedAccount: string | null;
  authVersion: number | null;
  runtimeRoot: string | null;
  mainThreadId: string | null;
  threadStarting: boolean;
  args: string[];
  settings?: BotSettings | null;
  roleRoot?: string | null;
  roleRevision?: number | null;
  roleId?: string | null;
  roleInstructionsHash?: string | null;
  orientation?: Orientation | null;
};

export class StateStore extends AuthStore {
  readonly managed: SettingsStore;
  onDefaultsChange?: () => void;
  constructor(stateDir: string) {
    super(stateDir);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY, pid INTEGER, cwd TEXT NOT NULL, url TEXT,
        state TEXT NOT NULL, codex_bin TEXT NOT NULL, account TEXT,
        auth_version INTEGER, runtime_root TEXT,
        main_thread_id TEXT, thread_starting INTEGER NOT NULL DEFAULT 0,
        role_root TEXT, role_revision INTEGER
      );
      CREATE TABLE IF NOT EXISTS secrets.server_args (id TEXT PRIMARY KEY, args_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_defaults (id INTEGER PRIMARY KEY CHECK (id = 1), settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_settings (id TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_state_identity (id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_state_fences (id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, request_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_retired_uploads (incarnation TEXT NOT NULL, upload_id TEXT NOT NULL, PRIMARY KEY(incarnation,upload_id));
      CREATE TABLE IF NOT EXISTS bot_history_generations (generation TEXT PRIMARY KEY, incarnation TEXT NOT NULL, bot_id TEXT NOT NULL,
        history_path TEXT NOT NULL, ownership TEXT NOT NULL, main_thread_id TEXT, created_at TEXT NOT NULL, retired_at TEXT, purged_at TEXT);
      CREATE TRIGGER IF NOT EXISTS servers_account_insert BEFORE INSERT ON servers
      WHEN NEW.account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM servers WHERE id = NEW.id)
        AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = NEW.account AND removing = 0)
        AND NOT EXISTS (SELECT 1 FROM account_aliases WHERE id = NEW.account AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = NEW.account))
      BEGIN SELECT RAISE(ABORT, 'Codex account is unavailable'); END;
      CREATE TRIGGER IF NOT EXISTS servers_account_rebind BEFORE UPDATE OF account ON servers
      WHEN NEW.account IS NOT OLD.account AND NEW.account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = NEW.account AND removing = 0)
      BEGIN SELECT RAISE(ABORT, 'Codex account is unavailable'); END;
    `);
    this.db.prepare("INSERT OR IGNORE INTO bot_defaults (id, settings_json) VALUES (1, ?)").run(JSON.stringify(DEFAULT_BOT_SETTINGS));
    this.managed = new SettingsStore(this.db);
    const legacyDefaults = this.db.prepare("SELECT settings_json FROM bot_defaults WHERE id=1").get() as { settings_json: string };
    this.managed.seed("bot-defaults", nativeSettings(parseSettings(legacyDefaults.settings_json)), "Stack Bot defaults");
    // Existing installations of the first SQLite-backed release have neither column.
    const serverColumns = this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
    if (!serverColumns.some(({ name }) => name === "role_id")) this.db.exec("ALTER TABLE servers ADD COLUMN role_id TEXT");
    if (!serverColumns.some(({ name }) => name === "orientation_json")) this.db.exec("ALTER TABLE servers ADD COLUMN orientation_json TEXT");
    if (!serverColumns.some(({ name }) => name === "role_instructions_hash")) this.db.exec("ALTER TABLE servers ADD COLUMN role_instructions_hash TEXT");
    if (!serverColumns.some(({ name }) => name === "auth_version")) this.db.exec("ALTER TABLE servers ADD COLUMN auth_version INTEGER");
    if (!serverColumns.some(({ name }) => name === "runtime_root")) this.db.exec("ALTER TABLE servers ADD COLUMN runtime_root TEXT");
    if (!serverColumns.some(({ name }) => name === "main_thread_id")) this.db.exec("ALTER TABLE servers ADD COLUMN main_thread_id TEXT");
    if (!serverColumns.some(({ name }) => name === "thread_starting")) this.db.exec("ALTER TABLE servers ADD COLUMN thread_starting INTEGER NOT NULL DEFAULT 0");
    const migrateRoleRoot = !serverColumns.some(({ name }) => name === "role_root");
    const migrateRoleRevision = !serverColumns.some(({ name }) => name === "role_revision");
    if (migrateRoleRoot) this.db.exec("ALTER TABLE servers ADD COLUMN role_root TEXT");
    if (migrateRoleRevision) this.db.exec("ALTER TABLE servers ADD COLUMN role_revision INTEGER");
    // Old launch roots still need to be reaped, and last-launched revisions remain visible.
    if (migrateRoleRoot && serverColumns.some(({ name }) => name === "capabilities_root")) this.db.exec("UPDATE servers SET role_root = capabilities_root WHERE role_root IS NULL");
    if (migrateRoleRevision && serverColumns.some(({ name }) => name === "capabilities_revision")) this.db.exec("UPDATE servers SET role_revision = capabilities_revision WHERE role_revision IS NULL");
    if (!serverColumns.some(({ name }) => name === "launched_account")) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
        if (!current.some(({ name }) => name === "launched_account")) {
          this.db.exec("ALTER TABLE servers ADD COLUMN launched_account TEXT");
          // Stopped Servers can retain an unreconciled credential copy from their last launch.
          this.db.exec("UPDATE servers SET launched_account = account");
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  servers(): StoredServer[] {
    return (this.db.prepare("SELECT servers.id, pid, cwd, url, state, codex_bin, account, launched_account, auth_version, runtime_root, main_thread_id, thread_starting, role_root, role_revision, role_id, role_instructions_hash, orientation_json, args_json, bot_settings.settings_json FROM servers LEFT JOIN secrets.server_args AS launch_args ON launch_args.id = servers.id LEFT JOIN bot_settings ON bot_settings.id = servers.id").all() as Array<{
      id: string; pid: number | null; cwd: string; url: string | null; state: StoredServer["state"]; codex_bin: string; account: string | null; launched_account: string | null; auth_version: number | null; runtime_root: string | null; main_thread_id: string | null; thread_starting: number; role_root: string | null; role_revision: number | null; role_id: string | null; args_json: string | null; settings_json: string | null;
      orientation_json: string | null; role_instructions_hash: string | null;
    }>).map(({ codex_bin, launched_account, auth_version, runtime_root, main_thread_id, thread_starting, role_root, role_revision, role_id, role_instructions_hash, orientation_json, args_json, settings_json, ...row }) => ({
      ...row, codexBin: codex_bin, launchedAccount: launched_account, authVersion: auth_version, runtimeRoot: runtime_root,
      mainThreadId: main_thread_id, threadStarting: Boolean(thread_starting), roleRoot: role_root,
      orientation: orientation_json === null ? null : orientationState.parse(JSON.parse(orientation_json)),
      roleInstructionsHash: role_instructions_hash,
      roleRevision: role_revision, roleId: role_id, args: parseArgs(args_json), settings: this.managed.get(`bot:${row.id}`)
        ? legacySettings(this.managed.get(`bot:${row.id}`)!.values) : settings_json === null ? null : parseSettings(settings_json),
    }));
  }

  botDefaults(): BotSettings {
    return legacySettings(this.managed.get("bot-defaults")!.values);
  }

  setBotDefaults(update: Partial<BotSettings>): BotSettings {
    parseSettings(JSON.stringify(update));
    this.managed.patch("bot-defaults", "codex-app-server", { expectedRevision: this.managed.get("bot-defaults")!.revision, requestId: randomUUID(), set: nativeSettings(update) });
    this.onDefaultsChange?.();
    return this.botDefaults();
  }

  saveServer(server: StoredServer): void {
    if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string")) throw new Error(`invalid launch arguments for Server ${server.id}`);
    const settings = server.settings == null ? null : parseSettings(JSON.stringify(server.settings));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO servers (id, pid, cwd, url, state, codex_bin, account, launched_account, auth_version, runtime_root, main_thread_id, thread_starting, role_root, role_revision, role_id, orientation_json, role_instructions_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, cwd=excluded.cwd, url=excluded.url,
        state=excluded.state, codex_bin=excluded.codex_bin, account=excluded.account, launched_account=excluded.launched_account,
        auth_version=excluded.auth_version, runtime_root=excluded.runtime_root,
        main_thread_id=excluded.main_thread_id, thread_starting=excluded.thread_starting,
        role_root=excluded.role_root, role_revision=excluded.role_revision, role_id=excluded.role_id, orientation_json=excluded.orientation_json, role_instructions_hash=excluded.role_instructions_hash`).run(
        server.id, server.pid, server.cwd, server.url, server.state, server.codexBin, server.account, server.launchedAccount ?? null, server.authVersion ?? null, server.runtimeRoot ?? null,
        server.mainThreadId ?? null, server.threadStarting ? 1 : 0, server.roleRoot ?? null, server.roleRevision ?? null, server.roleId ?? null,
        server.orientation ? JSON.stringify(orientationState.parse(server.orientation)) : null,
        server.roleInstructionsHash ?? null,
      );
      this.db.prepare("INSERT INTO secrets.server_args (id, args_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET args_json = excluded.args_json")
        .run(server.id, JSON.stringify(server.args));
      if (settings) this.db.prepare("INSERT INTO bot_settings (id, settings_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json")
        .run(server.id, JSON.stringify(settings));
      else this.db.prepare("DELETE FROM bot_settings WHERE id = ?").run(server.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasServer(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM servers WHERE id = ?").get(id)); }

  stateIdentity(id: string): { incarnation: string; generation: string } {
    let row = this.db.prepare("SELECT incarnation,generation FROM bot_state_identity WHERE id=?").get(id) as { incarnation: string; generation: string } | undefined;
    if (!row) {
      if (!this.hasServer(id)) throw new Error(`unknown bot: ${id}`);
      row = { incarnation: randomUUID(), generation: randomUUID() };
      const server = this.servers().find(server => server.id === id)!;
      const privatePath = join(this.stateDir, "history", id);
      const shared = Boolean(server.mainThreadId && !existsSync(privatePath));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO bot_state_identity VALUES(?,?,?)").run(id, row.incarnation, row.generation);
        this.db.prepare("INSERT INTO bot_history_generations VALUES(?,?,?,?,?,?,?,?,?)").run(row.generation, row.incarnation, id,
          shared ? join(this.stateDir, "history") : privatePath, shared ? "shared" : "stack", server.mainThreadId, new Date().toISOString(), null, null);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    return row;
  }

  historyGenerations(id: string): BotHistoryGeneration[] {
    const identity = this.stateIdentity(id);
    return this.db.prepare(`SELECT generation,incarnation,bot_id AS botId,history_path AS historyPath,ownership,
      main_thread_id AS mainThreadId,created_at AS createdAt,retired_at AS retiredAt,purged_at AS purgedAt
      FROM bot_history_generations WHERE incarnation=? ORDER BY created_at,generation`).all(identity.incarnation) as BotHistoryGeneration[];
  }

  historyPath(id: string): string {
    const identity = this.stateIdentity(id);
    return this.historyGenerations(id).find(row => row.generation === identity.generation)!.historyPath;
  }

  maintenanceFence(id: string): string | null {
    const identity = this.stateIdentity(id);
    const row = this.db.prepare("SELECT request_id FROM bot_state_fences WHERE id=? AND incarnation=?").get(id, identity.incarnation) as { request_id: string } | undefined;
    return row?.request_id ?? null;
  }
  fenceMaintenance(id: string, requestId: string): void {
    const identity = this.stateIdentity(id);
    this.db.prepare("INSERT INTO bot_state_fences VALUES(?,?,?)").run(id, identity.incarnation, requestId);
  }
  releaseMaintenance(id: string, requestId: string): void {
    const identity = this.stateIdentity(id);
    this.db.prepare("DELETE FROM bot_state_fences WHERE id=? AND incarnation=? AND request_id=?").run(id, identity.incarnation, requestId);
  }

  /** Root binding and history namespace change in one durable transaction, before another start. */
  resetConversation(id: string, expectedGeneration: string): { previous: string; generation: string } {
    const identity = this.stateIdentity(id);
    if (identity.generation !== expectedGeneration) throw new Error("Bot conversation generation changed");
    const generation = randomUUID(), now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const server = this.db.prepare("SELECT main_thread_id,state,orientation_json FROM servers WHERE id=?").get(id) as { main_thread_id: string | null; state: string; orientation_json: string | null };
      if (server.state !== "stopped") throw new Error("Stop the Bot before resetting its conversation");
      this.db.prepare("UPDATE bot_history_generations SET main_thread_id=?,retired_at=? WHERE generation=?").run(server.main_thread_id, now, identity.generation);
      this.db.prepare("INSERT INTO bot_history_generations VALUES(?,?,?,?,?,?,?,?,?)").run(generation, identity.incarnation, id,
        join(this.stateDir, "history-generations", identity.incarnation, generation), "stack", null, now, null, null);
      this.db.prepare("UPDATE bot_state_identity SET generation=? WHERE id=?").run(generation, id);
      const orientation = server.orientation_json ? orientationState.parse(JSON.parse(server.orientation_json)) : null;
      this.db.prepare("UPDATE servers SET main_thread_id=NULL,thread_starting=0,orientation_json=? WHERE id=?")
        .run(orientation ? JSON.stringify({ ...orientation, state: "retired", issue: "Orientation belongs to an explicitly retired conversation generation; it will not repeat.", updatedAt: Date.now() }) : null, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { previous: identity.generation, generation };
  }

  markHistoryPurged(generation: string): void {
    this.db.prepare("UPDATE bot_history_generations SET purged_at=? WHERE generation=? AND retired_at IS NOT NULL").run(new Date().toISOString(), generation);
  }
  retireUpload(id: string, uploadId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO bot_retired_uploads VALUES(?,?)").run(this.stateIdentity(id).incarnation, uploadId);
  }
  requireActiveUpload(id: string, uploadId: string): void {
    if (this.db.prepare("SELECT 1 FROM bot_retired_uploads WHERE incarnation=? AND upload_id=?").get(this.stateIdentity(id).incarnation, uploadId))
      throw new Error("upload was retired; use a new upload UUID for new content");
  }

  deleteServer(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM servers WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM secrets.server_args WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM bot_settings WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM bot_history_generations WHERE incarnation IN (SELECT incarnation FROM bot_state_identity WHERE id=?)").run(id);
      this.db.prepare("DELETE FROM bot_state_identity WHERE id=?").run(id);
      this.db.prepare("DELETE FROM bot_state_fences WHERE id=?").run(id);
      this.managed.remove(`bot:${id}`);
      this.db.exec("DELETE FROM account_aliases WHERE id NOT IN (SELECT name FROM accounts) AND id NOT IN (SELECT account FROM servers WHERE account IS NOT NULL)");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export type BotHistoryGeneration = { generation: string; incarnation: string; botId: string; historyPath: string; ownership: "stack" | "shared";
  mainThreadId: string | null; createdAt: string; retiredAt: string | null; purgedAt: string | null };

const legacyKeys = { model: "model", reasoningEffort: "model_reasoning_effort", sandboxMode: "sandbox_mode", approvalPolicy: "approval_policy" } as const;
export function nativeSettings(settings: BotSettings): SettingValues {
  return Object.fromEntries(Object.entries(legacyKeys).flatMap(([key, native]) => settings[key as keyof BotSettings] === undefined ? [] : [[native, settings[key as keyof BotSettings]!]]));
}
export function legacySettings(values: SettingValues): BotSettings {
  return Object.fromEntries(Object.entries(legacyKeys).flatMap(([key, native]) => Object.hasOwn(values, native) ? [[key, values[native]]] : [])) as BotSettings;
}

function parseArgs(raw: string | null): string[] {
  if (raw === null) return []; // Server records written before arguments were persisted.
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string")) throw new Error("invalid stored Server launch arguments");
  return value;
}
