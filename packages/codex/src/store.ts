import { AuthStore } from "@agentstack/auth";

export type StoredServer = {
  id: string;
  pid: number | null;
  cwd: string;
  url: string | null;
  state: "running" | "stopped";
  codexBin: string;
  account: string | null;
  authVersion: number | null;
  runtimeRoot: string | null;
  mainThreadId: string | null;
  threadStarting: boolean;
  args: string[];
};

export class StateStore extends AuthStore {
  constructor(stateDir: string) {
    super(stateDir);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY, pid INTEGER, cwd TEXT NOT NULL, url TEXT,
        state TEXT NOT NULL, codex_bin TEXT NOT NULL, account TEXT,
        auth_version INTEGER, runtime_root TEXT,
        main_thread_id TEXT, thread_starting INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS secrets.server_args (id TEXT PRIMARY KEY, args_json TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS servers_account_insert BEFORE INSERT ON servers
      WHEN NEW.account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM servers WHERE id = NEW.id)
        AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = NEW.account AND removing = 0)
        AND NOT EXISTS (SELECT 1 FROM account_aliases WHERE id = NEW.account AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = NEW.account))
      BEGIN SELECT RAISE(ABORT, 'Codex account is unavailable'); END;
      CREATE TRIGGER IF NOT EXISTS servers_account_rebind BEFORE UPDATE OF account ON servers
      WHEN NEW.account IS NOT OLD.account AND NEW.account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE name = NEW.account AND removing = 0)
      BEGIN SELECT RAISE(ABORT, 'Codex account is unavailable'); END;
    `);
    // Existing installations of the first SQLite-backed release have neither column.
    const serverColumns = this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
    if (!serverColumns.some(({ name }) => name === "auth_version")) this.db.exec("ALTER TABLE servers ADD COLUMN auth_version INTEGER");
    if (!serverColumns.some(({ name }) => name === "runtime_root")) this.db.exec("ALTER TABLE servers ADD COLUMN runtime_root TEXT");
    if (!serverColumns.some(({ name }) => name === "main_thread_id")) this.db.exec("ALTER TABLE servers ADD COLUMN main_thread_id TEXT");
    if (!serverColumns.some(({ name }) => name === "thread_starting")) this.db.exec("ALTER TABLE servers ADD COLUMN thread_starting INTEGER NOT NULL DEFAULT 0");
  }

  servers(): StoredServer[] {
    return (this.db.prepare("SELECT servers.id, pid, cwd, url, state, codex_bin, account, auth_version, runtime_root, main_thread_id, thread_starting, args_json FROM servers LEFT JOIN secrets.server_args AS launch_args ON launch_args.id = servers.id").all() as Array<{
      id: string; pid: number | null; cwd: string; url: string | null; state: StoredServer["state"]; codex_bin: string; account: string | null; auth_version: number | null; runtime_root: string | null; main_thread_id: string | null; thread_starting: number; args_json: string | null;
    }>).map(({ codex_bin, auth_version, runtime_root, main_thread_id, thread_starting, args_json, ...row }) => ({
      ...row, codexBin: codex_bin, authVersion: auth_version, runtimeRoot: runtime_root,
      mainThreadId: main_thread_id, threadStarting: Boolean(thread_starting), args: parseArgs(args_json),
    }));
  }

  saveServer(server: StoredServer): void {
    if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string")) throw new Error(`invalid launch arguments for Server ${server.id}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO servers (id, pid, cwd, url, state, codex_bin, account, auth_version, runtime_root, main_thread_id, thread_starting) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, cwd=excluded.cwd, url=excluded.url,
        state=excluded.state, codex_bin=excluded.codex_bin, account=excluded.account,
        auth_version=excluded.auth_version, runtime_root=excluded.runtime_root,
        main_thread_id=excluded.main_thread_id, thread_starting=excluded.thread_starting`).run(
        server.id, server.pid, server.cwd, server.url, server.state, server.codexBin, server.account, server.authVersion ?? null, server.runtimeRoot ?? null,
        server.mainThreadId ?? null, server.threadStarting ? 1 : 0,
      );
      this.db.prepare("INSERT INTO secrets.server_args (id, args_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET args_json = excluded.args_json")
        .run(server.id, JSON.stringify(server.args));
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
