import { closeSync, constants, mkdirSync, openSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
};

export type Account = { name: string; active: boolean };

function privateDatabase(path: string): void {
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const config = join(stateDir, "configuration.sqlite");
    const secrets = join(stateDir, "secrets.sqlite");
    privateDatabase(config);
    privateDatabase(secrets);
    this.db = new DatabaseSync(config);
    this.db.prepare("ATTACH DATABASE ? AS secrets").run(secrets);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA secrets.journal_mode = DELETE;
      PRAGMA secrets.secure_delete = ON;
      CREATE TABLE IF NOT EXISTS accounts (number INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY, pid INTEGER, cwd TEXT NOT NULL, url TEXT,
        state TEXT NOT NULL, codex_bin TEXT NOT NULL, account TEXT,
        auth_version INTEGER, runtime_root TEXT
      );
      CREATE TABLE IF NOT EXISTS secrets.credentials (name TEXT PRIMARY KEY, auth_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    `);
    // Existing installations of the first SQLite-backed release have neither column.
    const serverColumns = this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
    if (!serverColumns.some(({ name }) => name === "auth_version")) this.db.exec("ALTER TABLE servers ADD COLUMN auth_version INTEGER");
    if (!serverColumns.some(({ name }) => name === "runtime_root")) this.db.exec("ALTER TABLE servers ADD COLUMN runtime_root TEXT");
    const secretColumns = this.db.prepare("PRAGMA secrets.table_info(credentials)").all() as Array<{ name: string }>;
    if (!secretColumns.some(({ name }) => name === "version")) this.db.exec("ALTER TABLE secrets.credentials ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }

  close(): void { this.db.close(); }

  listAccounts(): Account[] {
    const active = this.activeName();
    return (this.db.prepare("SELECT name FROM accounts ORDER BY number").all() as Array<{ name: string }>).map(({ name }) => ({ name, active: name === active }));
  }

  private activeName(): string | null {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'active_account'").get() as { value: string } | undefined)?.value ?? null;
  }

  activeAccount(): { name: string; auth: string; version: number } {
    const name = this.activeName();
    if (!name) throw new Error("No active Codex account. Sign in from the Codex page first.");
    const row = this.db.prepare("SELECT auth_json, version FROM secrets.credentials WHERE name = ?").get(name) as { auth_json: string; version: number } | undefined;
    if (!row) throw new Error(`Credentials for ${name} are unavailable; sign in again.`);
    return { name, auth: row.auth_json, version: row.version };
  }

  addAccount(auth: string): Account {
    if (!credentialInfo(auth)) throw new Error("Codex login did not provide ChatGPT credentials");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("INSERT INTO accounts (name) VALUES ('pending')").run();
      const name = `codex-${result.lastInsertRowid}`;
      this.db.prepare("UPDATE accounts SET name = ? WHERE number = ?").run(name, result.lastInsertRowid);
      this.db.prepare("INSERT INTO secrets.credentials (name, auth_json) VALUES (?, ?)").run(name, auth);
      if (!this.activeName()) this.db.prepare("INSERT INTO settings (key, value) VALUES ('active_account', ?)").run(name);
      this.db.exec("COMMIT");
      return { name, active: this.activeName() === name };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activate(name: string): void {
    if (!this.db.prepare("SELECT 1 FROM accounts WHERE name = ?").get(name)) throw new Error(`unknown Codex account: ${name}`);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('active_account', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name);
  }

  replaceCredentials(name: string, auth: string): void {
    if (!credentialInfo(auth)) throw new Error("Codex login did not provide ChatGPT credentials");
    if (!this.db.prepare("SELECT 1 FROM accounts WHERE name = ?").get(name)) throw new Error(`unknown Codex account: ${name}`);
    this.db.prepare("UPDATE secrets.credentials SET auth_json = ?, version = version + 1 WHERE name = ?").run(auth, name);
  }

  syncCredential(name: string, expectedVersion: number, candidate: string): { status: "updated" | "unchanged" | "stale" | "invalid" | "missing"; version: number | null } {
    const incoming = credentialInfo(candidate);
    if (!incoming) return { status: "invalid", version: null };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT auth_json, version FROM secrets.credentials WHERE name = ?").get(name) as { auth_json: string; version: number } | undefined;
      let outcome: { status: "updated" | "unchanged" | "stale" | "invalid" | "missing"; version: number | null };
      if (!current) outcome = { status: "missing", version: null };
      else {
        const saved = credentialInfo(current.auth_json);
        if (!saved || (saved.accountId && saved.accountId !== incoming.accountId)) outcome = { status: "invalid", version: current.version };
        else if (candidate === current.auth_json) outcome = { status: "unchanged", version: current.version };
        else if (incoming.timestamp === null) outcome = { status: "invalid", version: current.version };
        else if (current.version !== expectedVersion || saved.timestamp === null || incoming.timestamp <= saved.timestamp) outcome = { status: "stale", version: current.version };
        else {
          this.db.prepare("UPDATE secrets.credentials SET auth_json = ?, version = version + 1 WHERE name = ?").run(candidate, name);
          outcome = { status: "updated", version: current.version + 1 };
        }
      }
      this.db.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeAccount(name: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("DELETE FROM accounts WHERE name = ?").run(name).changes) throw new Error(`unknown Codex account: ${name}`);
      this.db.prepare("DELETE FROM secrets.credentials WHERE name = ?").run(name);
      if (this.activeName() === name) {
        const next = (this.db.prepare("SELECT name FROM accounts ORDER BY number LIMIT 1").get() as { name: string } | undefined)?.name;
        if (next) this.db.prepare("UPDATE settings SET value = ? WHERE key = 'active_account'").run(next);
        else this.db.prepare("DELETE FROM settings WHERE key = 'active_account'").run();
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  servers(): StoredServer[] {
    return (this.db.prepare("SELECT id, pid, cwd, url, state, codex_bin, account, auth_version, runtime_root FROM servers").all() as Array<{
      id: string; pid: number | null; cwd: string; url: string | null; state: StoredServer["state"]; codex_bin: string; account: string | null; auth_version: number | null; runtime_root: string | null;
    }>).map(({ codex_bin, auth_version, runtime_root, ...row }) => ({ ...row, codexBin: codex_bin, authVersion: auth_version, runtimeRoot: runtime_root }));
  }

  saveServer(server: StoredServer): void {
    this.db.prepare(`INSERT INTO servers (id, pid, cwd, url, state, codex_bin, account, auth_version, runtime_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, cwd=excluded.cwd, url=excluded.url,
      state=excluded.state, codex_bin=excluded.codex_bin, account=excluded.account,
      auth_version=excluded.auth_version, runtime_root=excluded.runtime_root`).run(
      server.id, server.pid, server.cwd, server.url, server.state, server.codexBin, server.account, server.authVersion ?? null, server.runtimeRoot ?? null,
    );
  }

  hasServer(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM servers WHERE id = ?").get(id)); }
}

function credentialInfo(raw: string): { timestamp: number | null; accountId: string | null } | null {
  try {
    const value = JSON.parse(raw) as { last_refresh?: unknown; tokens?: { refresh_token?: unknown; access_token?: unknown; id_token?: unknown; account_id?: unknown } };
    if (typeof value.tokens?.refresh_token !== "string" || !value.tokens.refresh_token ||
        typeof value.tokens.access_token !== "string" || !value.tokens.access_token ||
        typeof value.tokens.id_token !== "string" || !value.tokens.id_token) return null;
    const stamp = value.last_refresh;
    const timestamp = typeof stamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(stamp) ? Date.parse(stamp) : NaN;
    return { timestamp: Number.isFinite(timestamp) ? timestamp : null, accountId: typeof value.tokens.account_id === "string" ? value.tokens.account_id : null };
  } catch { return null; }
}
