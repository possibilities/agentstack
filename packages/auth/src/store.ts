import { closeSync, constants, mkdirSync, openSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Account = { id: string; active: boolean; removing: boolean };

function privateDatabase(path: string): void {
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
}

export class AuthStore {
  protected readonly db: DatabaseSync;

  constructor(readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const config = join(stateDir, "configuration.sqlite");
    const secrets = join(stateDir, "secrets.sqlite");
    privateDatabase(config);
    privateDatabase(secrets);
    this.db = new DatabaseSync(config);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.prepare("ATTACH DATABASE ? AS secrets").run(secrets);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA secrets.journal_mode = DELETE;
      PRAGMA secrets.secure_delete = ON;
      -- The legacy name columns now hold immutable UUIDs. Keep the columns
      -- so existing attached databases and Server records migrate in place.
      CREATE TABLE IF NOT EXISTS accounts (number INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, removing INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS account_aliases (legacy_name TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets.credentials (name TEXT PRIMARY KEY, auth_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    `);
    const secretColumns = this.db.prepare("PRAGMA secrets.table_info(credentials)").all() as Array<{ name: string }>;
    if (!secretColumns.some(({ name }) => name === "version")) this.db.exec("ALTER TABLE secrets.credentials ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    this.migrateAccountIds();
  }

  private migrateAccountIds(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "removing")) this.db.exec("ALTER TABLE accounts ADD COLUMN removing INTEGER NOT NULL DEFAULT 0");
      const hasServers = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers'").get());
      const legacy = this.db.prepare("SELECT number, name FROM accounts WHERE name GLOB 'codex-[0-9]*'").all() as Array<{ number: number; name: string }>;
      for (const { number, name } of legacy) {
        if (!/^codex-[1-9][0-9]*$/.test(name)) continue;
        const id = randomUUID();
        this.db.prepare("INSERT INTO account_aliases (legacy_name, id) VALUES (?, ?)").run(name, id);
        this.db.prepare("UPDATE accounts SET name = ? WHERE number = ?").run(id, number);
        this.db.prepare("UPDATE secrets.credentials SET name = ? WHERE name = ?").run(id, name);
        this.db.prepare("UPDATE settings SET value = ? WHERE key = 'active_account' AND value = ?").run(id, name);
        if (hasServers) this.db.prepare("UPDATE servers SET account = ? WHERE account = ?").run(id, name);
      }
      if (hasServers) {
        const orphaned = this.db.prepare("SELECT DISTINCT account FROM servers WHERE account GLOB 'codex-[0-9]*' AND account NOT IN (SELECT name FROM accounts)").all() as Array<{ account: string }>;
        for (const { account } of orphaned) {
          if (!/^codex-[1-9][0-9]*$/.test(account)) continue;
          const id = randomUUID();
          this.db.prepare("INSERT OR IGNORE INTO account_aliases (legacy_name, id) VALUES (?, ?)").run(account, id);
          const mapped = this.resolveLegacyAccount(account);
          this.db.prepare("UPDATE servers SET account = ? WHERE account = ?").run(mapped, account);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }

  resolveLegacyAccount(id: string, createOrphan = false): string {
    const found = (this.db.prepare("SELECT id FROM account_aliases WHERE legacy_name = ?").get(id) as { id: string } | undefined)?.id;
    if (found) return found;
    if (!createOrphan || !/^codex-[1-9][0-9]*$/.test(id)) return id;
    const orphanId = randomUUID();
    this.db.prepare("INSERT INTO account_aliases (legacy_name, id) VALUES (?, ?)").run(id, orphanId);
    return orphanId;
  }

  listAccounts(): Account[] {
    const active = this.activeId();
    return (this.db.prepare("SELECT name, removing FROM accounts ORDER BY number").all() as Array<{ name: string; removing: number }>).map(({ name, removing }) => ({ id: name, active: name === active, removing: Boolean(removing) }));
  }

  protected activeId(): string | null {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'active_account'").get() as { value: string } | undefined)?.value ?? null;
  }

  activeAccount(): { id: string; auth: string; version: number } {
    const id = this.activeId();
    if (!id) throw new Error("No active Codex account. Start a device sign-in through the auth API (account_login_start) first.");
    return this.accountCredentials(id);
  }

  accountCredentials(id: string): { id: string; auth: string; version: number } {
    const row = this.db.prepare("SELECT auth_json, version FROM secrets.credentials JOIN accounts ON accounts.name = secrets.credentials.name WHERE accounts.name = ? AND removing = 0").get(id) as { auth_json: string; version: number } | undefined;
    if (!row) throw new Error(`Credentials for account ${id} are unavailable; sign in again.`);
    return { id, auth: row.auth_json, version: row.version };
  }

  addAccount(auth: string): Account {
    if (!credentialInfo(auth)) throw new Error("Codex login did not provide ChatGPT credentials");
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO accounts (name) VALUES (?)").run(id);
      this.db.prepare("INSERT INTO secrets.credentials (name, auth_json) VALUES (?, ?)").run(id, auth);
      if (!this.activeId()) this.db.prepare("INSERT INTO settings (key, value) VALUES ('active_account', ?)").run(id);
      this.db.exec("COMMIT");
      return { id, active: this.activeId() === id, removing: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activate(id: string): void {
    if (!this.db.prepare("SELECT 1 FROM accounts WHERE name = ? AND removing = 0").get(id)) throw new Error(`unknown Codex account: ${id}`);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('active_account', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id);
  }

  replaceCredentials(id: string, auth: string): void {
    if (!credentialInfo(auth)) throw new Error("Codex login did not provide ChatGPT credentials");
    if (!this.db.prepare("SELECT 1 FROM accounts WHERE name = ? AND removing = 0").get(id)) throw new Error(`unknown Codex account: ${id}`);
    this.db.prepare("UPDATE secrets.credentials SET auth_json = ?, version = version + 1 WHERE name = ?").run(auth, id);
  }

  syncCredential(id: string, expectedVersion: number, candidate: string): { status: "updated" | "unchanged" | "stale" | "invalid" | "missing"; version: number | null } {
    const incoming = credentialInfo(candidate);
    if (!incoming) return { status: "invalid", version: null };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT auth_json, version FROM secrets.credentials WHERE name = ?").get(id) as { auth_json: string; version: number } | undefined;
      let outcome: { status: "updated" | "unchanged" | "stale" | "invalid" | "missing"; version: number | null };
      if (!current) outcome = { status: "missing", version: null };
      else {
        const saved = credentialInfo(current.auth_json);
        if (!saved || (saved.accountId && saved.accountId !== incoming.accountId)) outcome = { status: "invalid", version: current.version };
        else if (candidate === current.auth_json) outcome = { status: "unchanged", version: current.version };
        else if (incoming.timestamp === null) outcome = { status: "invalid", version: current.version };
        else if (current.version !== expectedVersion || saved.timestamp === null || incoming.timestamp <= saved.timestamp) outcome = { status: "stale", version: current.version };
        else {
          this.db.prepare("UPDATE secrets.credentials SET auth_json = ?, version = version + 1 WHERE name = ?").run(candidate, id);
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

  boundServerIds(id: string): string[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers'").get()) return [];
    return (this.db.prepare("SELECT id FROM servers WHERE account = ? ORDER BY id").all(id) as Array<{ id: string }>).map(({ id }) => id);
  }

  beginRemoval(id: string): void {
    if (!this.db.prepare("UPDATE accounts SET removing = 1 WHERE name = ?").run(id).changes) throw new Error(`unknown Codex account: ${id}`);
  }

  removeAccount(id: string): void {
    this.beginRemoval(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.boundServerIds(id).length) throw new Error(`account ${id} still has bound Codex Servers`);
      this.db.prepare("DELETE FROM accounts WHERE name = ?").run(id);
      this.db.prepare("DELETE FROM account_aliases WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM secrets.credentials WHERE name = ?").run(id);
      if (this.activeId() === id) {
        const next = (this.db.prepare("SELECT name FROM accounts WHERE removing = 0 ORDER BY number LIMIT 1").get() as { name: string } | undefined)?.name;
        if (next) this.db.prepare("UPDATE settings SET value = ? WHERE key = 'active_account'").run(next);
        else this.db.prepare("DELETE FROM settings WHERE key = 'active_account'").run();
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
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
