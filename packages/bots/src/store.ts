import { AuthStore } from "@agentstack/auth";

export type BotSettings = {
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
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
  if (typeof settings.model !== "string" || !settings.model.trim() || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(String(settings.reasoningEffort))
    || !["read-only", "workspace-write", "danger-full-access"].includes(String(settings.sandboxMode))
    || !["untrusted", "on-failure", "on-request", "never"].includes(String(settings.approvalPolicy))) throw new Error("invalid stored Bot settings");
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
};

export class StateStore extends AuthStore {
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
    // Existing installations of the first SQLite-backed release have neither column.
    const serverColumns = this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
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
    return (this.db.prepare("SELECT servers.id, pid, cwd, url, state, codex_bin, account, launched_account, auth_version, runtime_root, main_thread_id, thread_starting, role_root, role_revision, args_json, bot_settings.settings_json FROM servers LEFT JOIN secrets.server_args AS launch_args ON launch_args.id = servers.id LEFT JOIN bot_settings ON bot_settings.id = servers.id").all() as Array<{
      id: string; pid: number | null; cwd: string; url: string | null; state: StoredServer["state"]; codex_bin: string; account: string | null; launched_account: string | null; auth_version: number | null; runtime_root: string | null; main_thread_id: string | null; thread_starting: number; role_root: string | null; role_revision: number | null; args_json: string | null; settings_json: string | null;
    }>).map(({ codex_bin, launched_account, auth_version, runtime_root, main_thread_id, thread_starting, role_root, role_revision, args_json, settings_json, ...row }) => ({
      ...row, codexBin: codex_bin, launchedAccount: launched_account, authVersion: auth_version, runtimeRoot: runtime_root,
      mainThreadId: main_thread_id, threadStarting: Boolean(thread_starting), roleRoot: role_root,
      roleRevision: role_revision, args: parseArgs(args_json), settings: settings_json === null ? null : parseSettings(settings_json),
    }));
  }

  botDefaults(): BotSettings {
    const row = this.db.prepare("SELECT settings_json FROM bot_defaults WHERE id = 1").get() as { settings_json: string };
    return parseSettings(row.settings_json);
  }

  setBotDefaults(update: Partial<BotSettings>): BotSettings {
    const next = parseSettings(JSON.stringify({ ...this.botDefaults(), ...update }));
    this.db.prepare("UPDATE bot_defaults SET settings_json = ? WHERE id = 1").run(JSON.stringify(next));
    this.onDefaultsChange?.();
    return next;
  }

  saveServer(server: StoredServer): void {
    if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string")) throw new Error(`invalid launch arguments for Server ${server.id}`);
    const settings = server.settings == null ? null : parseSettings(JSON.stringify(server.settings));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO servers (id, pid, cwd, url, state, codex_bin, account, launched_account, auth_version, runtime_root, main_thread_id, thread_starting, role_root, role_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, cwd=excluded.cwd, url=excluded.url,
        state=excluded.state, codex_bin=excluded.codex_bin, account=excluded.account, launched_account=excluded.launched_account,
        auth_version=excluded.auth_version, runtime_root=excluded.runtime_root,
        main_thread_id=excluded.main_thread_id, thread_starting=excluded.thread_starting,
        role_root=excluded.role_root, role_revision=excluded.role_revision`).run(
        server.id, server.pid, server.cwd, server.url, server.state, server.codexBin, server.account, server.launchedAccount ?? null, server.authVersion ?? null, server.runtimeRoot ?? null,
        server.mainThreadId ?? null, server.threadStarting ? 1 : 0, server.roleRoot ?? null, server.roleRevision ?? null,
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

  deleteServer(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM servers WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM secrets.server_args WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM bot_settings WHERE id = ?").run(id);
      this.db.exec("DELETE FROM account_aliases WHERE id NOT IN (SELECT name FROM accounts) AND id NOT IN (SELECT account FROM servers WHERE account IS NOT NULL)");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseArgs(raw: string | null): string[] {
  if (raw === null) return []; // Server records written before arguments were persisted.
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string")) throw new Error("invalid stored Server launch arguments");
  return value;
}
