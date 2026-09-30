import { closeSync, constants, mkdirSync, openSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { WorkerAccount, WorkerProvider } from "./worker-accounts.js";

export type Account = { id: string; enabled: boolean; removing: boolean };

export class DuplicateCodexAccountError extends Error {
  constructor() {
    super("This ChatGPT login is already registered as a Codex Bot account. Choose a different login, or use Sign in again on the existing account.");
  }
}

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
      CREATE TABLE IF NOT EXISTS accounts (number INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, removing INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS account_aliases (legacy_name TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets.credentials (name TEXT PRIMARY KEY, auth_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS worker_accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('codex','devin','claude')),
        enabled INTEGER NOT NULL DEFAULT 1, ready INTEGER NOT NULL DEFAULT 0, removing INTEGER NOT NULL DEFAULT 0,
        credential_digest TEXT, identity_digest TEXT, bot_account TEXT
      );
    `);
    const secretColumns = this.db.prepare("PRAGMA secrets.table_info(credentials)").all() as Array<{ name: string }>;
    if (!secretColumns.some(({ name }) => name === "version")) this.db.exec("ALTER TABLE secrets.credentials ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    this.migrateWorkerProviders();
    if (!(this.db.prepare("PRAGMA table_info(worker_accounts)").all() as Array<{ name: string }>).some(({ name }) => name === "bot_account"))
      this.db.exec("ALTER TABLE worker_accounts ADD COLUMN bot_account TEXT");
    this.migrateAccountIds();
  }

  private migrateWorkerProviders(): void {
    const definition = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'worker_accounts'").get() as { sql: string };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Constraint-free legacy tables have already migrated. Rebuilding them
      // again would discard the identity and pairing columns added afterward.
      if (/\bCHECK\s*\(\s*provider\s+IN\s*\(/i.test(definition.sql) && !definition.sql.includes("'claude'")) {
        this.db.exec(`
          ALTER TABLE worker_accounts RENAME TO worker_accounts_legacy;
          CREATE TABLE worker_accounts (
            -- Legacy profiles remain on disk, including unsupported providers.
            id TEXT PRIMARY KEY, provider TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, ready INTEGER NOT NULL DEFAULT 0, removing INTEGER NOT NULL DEFAULT 0,
            credential_digest TEXT, identity_digest TEXT
          );
          INSERT INTO worker_accounts (rowid, id, provider, enabled, ready, removing, credential_digest)
            SELECT rowid, id, provider, enabled, ready, removing, credential_digest FROM worker_accounts_legacy;
          DROP TABLE worker_accounts_legacy;
        `);
      } else if (!(this.db.prepare("PRAGMA table_info(worker_accounts)").all() as Array<{ name: string }>).some(({ name }) => name === "identity_digest")) {
        this.db.exec("ALTER TABLE worker_accounts ADD COLUMN identity_digest TEXT");
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private migrateAccountIds(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "removing")) this.db.exec("ALTER TABLE accounts ADD COLUMN removing INTEGER NOT NULL DEFAULT 0");
      if (!columns.some(({ name }) => name === "enabled")) this.db.exec("ALTER TABLE accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
      const hasServers = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers'").get());
      const hasLaunchedAccount = hasServers && (this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>).some(({ name }) => name === "launched_account");
      const legacy = this.db.prepare("SELECT number, name FROM accounts WHERE name GLOB 'codex-[0-9]*'").all() as Array<{ number: number; name: string }>;
      for (const { number, name } of legacy) {
        if (!/^codex-[1-9][0-9]*$/.test(name)) continue;
        const id = randomUUID();
        this.db.prepare("INSERT INTO account_aliases (legacy_name, id) VALUES (?, ?)").run(name, id);
        this.db.prepare("UPDATE accounts SET name = ? WHERE number = ?").run(id, number);
        this.db.prepare("UPDATE secrets.credentials SET name = ? WHERE name = ?").run(id, name);
        if (hasServers) {
          this.db.prepare("UPDATE servers SET account = ? WHERE account = ?").run(id, name);
          if (hasLaunchedAccount) this.db.prepare("UPDATE servers SET launched_account = ? WHERE launched_account = ?").run(id, name);
        }
      }
      if (hasServers) {
        const orphaned = this.db.prepare("SELECT DISTINCT account FROM servers WHERE account GLOB 'codex-[0-9]*' AND account NOT IN (SELECT name FROM accounts)").all() as Array<{ account: string }>;
        for (const { account } of orphaned) {
          if (!/^codex-[1-9][0-9]*$/.test(account)) continue;
          const id = randomUUID();
          this.db.prepare("INSERT OR IGNORE INTO account_aliases (legacy_name, id) VALUES (?, ?)").run(account, id);
          const mapped = this.resolveLegacyAccount(account);
          this.db.prepare("UPDATE servers SET account = ? WHERE account = ?").run(mapped, account);
          if (hasLaunchedAccount) this.db.prepare("UPDATE servers SET launched_account = ? WHERE launched_account = ?").run(mapped, account);
        }
      }
      this.db.prepare("DELETE FROM settings WHERE key = 'active_account'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }

  workerAccounts(): WorkerAccount[] {
    return (this.db.prepare("SELECT id, provider, enabled, ready, removing FROM worker_accounts WHERE provider IN ('codex','devin','claude') ORDER BY rowid").all() as Array<{
      id: string; provider: WorkerProvider; enabled: number; ready: number; removing: number;
    }>).map(({ id, provider, enabled, ready, removing }) => ({ id, provider, enabled: Boolean(enabled), ready: Boolean(ready), removing: Boolean(removing) }));
  }

  /** Each Codex Bot account's paired Codex Worker account, by Worker ID. */
  workerPairs(): Map<string, string> {
    return new Map((this.db.prepare("SELECT id, bot_account FROM worker_accounts WHERE bot_account IS NOT NULL ORDER BY rowid").all() as Array<{ id: string; bot_account: string }>)
      .map(({ id, bot_account }) => [id, bot_account]));
  }

  pairedWorker(botId: string): string | undefined {
    return (this.db.prepare("SELECT id FROM worker_accounts WHERE bot_account = ?").get(botId) as { id: string } | undefined)?.id;
  }

  /** Pair an existing, unpaired Codex Worker account with a Bot account. */
  pairWorker(id: string, botId: string): void {
    if (!this.db.prepare("UPDATE worker_accounts SET bot_account = ? WHERE id = ? AND provider = 'codex' AND bot_account IS NULL AND removing = 0").run(botId, id).changes)
      throw new Error("worker account is unavailable");
  }

  /** A paired Codex Worker account starts unsigned-in; its own native sign-in makes it ready. */
  createPairedWorker(botId: string): WorkerAccount {
    const id = randomUUID();
    this.db.prepare("INSERT INTO worker_accounts (id, provider, bot_account) VALUES (?, 'codex', ?)").run(id, botId);
    return this.workerAccounts().find((item) => item.id === id)!;
  }

  prepareWorker(provider: WorkerProvider, existingId?: string): WorkerAccount {
    if (!["codex", "devin", "claude"].includes(provider)) throw new Error("unsupported Worker provider");
    if (provider === "codex" && !existingId) throw new Error("Codex Worker accounts come with Codex Bot accounts; sign in the paired Worker account instead");
    const id = existingId ?? randomUUID();
    const existing = this.workerAccounts().find((item) => item.id === id);
    if (existingId && !existing) throw new Error("unknown worker account");
    if (existing?.removing || (existing && existing.provider !== provider)) throw new Error("worker account is unavailable");
    this.db.prepare("INSERT OR IGNORE INTO worker_accounts (id, provider) VALUES (?, ?)").run(id, provider);
    if (existing?.ready) this.db.prepare("UPDATE worker_accounts SET ready = 0 WHERE id = ?").run(id);
    return this.workerAccounts().find((item) => item.id === id)!;
  }

  confirmWorker(id: string, digest: string, identity: string | null = null): WorkerAccount {
    const account = this.workerAccounts().find((item) => item.id === id);
    if (!account || account.removing) throw new Error("unknown worker account");
    const identityDigest = account.provider === "claude" && identity ? createHash("sha256").update(identity).digest("hex") : null;
    if (account.provider === "claude") {
      if (!identityDigest) throw new Error("Claude account identity is unavailable; sign in again");
      const prior = this.db.prepare("SELECT identity_digest FROM worker_accounts WHERE id = ?").get(id) as { identity_digest: string | null };
      if (prior.identity_digest && prior.identity_digest !== identityDigest) throw new Error("Claude sign-in does not match this Worker account");
      if (this.db.prepare("SELECT id FROM worker_accounts WHERE provider = 'claude' AND identity_digest = ? AND id != ?").get(identityDigest, id))
        throw new Error("this Claude identity is already bound to another worker account");
    }
    const bot = this.workerPairs().get(id);
    const botIdentity = bot ? this.botAccountIdentity(bot) : null;
    if (identity && botIdentity && identity !== botIdentity) throw new Error("Codex sign-in does not match its paired Bot account");
    const duplicate = this.db.prepare("SELECT id FROM worker_accounts WHERE provider = ? AND credential_digest = ? AND id != ?").get(account.provider, digest, id);
    if (duplicate) throw new Error("these native credentials are already bound to another worker account");
    this.db.prepare("UPDATE worker_accounts SET ready = 1, credential_digest = ?, identity_digest = ? WHERE id = ?").run(digest, identityDigest, id);
    return this.workerAccounts().find((item) => item.id === id)!;
  }

  enableWorker(id: string, enabled: boolean): WorkerAccount {
    if (!this.workerAccounts().some((account) => account.id === id)) throw new Error("unknown worker account");
    if (!this.db.prepare("UPDATE worker_accounts SET enabled = ? WHERE id = ? AND removing = 0").run(Number(enabled), id).changes)
      throw new Error("unknown worker account");
    return this.workerAccounts().find((item) => item.id === id)!;
  }

  beginWorkerRemoval(id: string): WorkerAccount {
    if (!this.workerAccounts().some((account) => account.id === id)) throw new Error("unknown worker account");
    if (!this.db.prepare("UPDATE worker_accounts SET enabled = 0, removing = 1 WHERE id = ?").run(id).changes)
      throw new Error("unknown worker account");
    return this.workerAccounts().find((item) => item.id === id)!;
  }

  finishWorkerRemoval(id: string): void { this.db.prepare("DELETE FROM worker_accounts WHERE id = ? AND removing = 1").run(id); }

  resolveLegacyAccount(id: string, createOrphan = false): string {
    const found = (this.db.prepare("SELECT id FROM account_aliases WHERE legacy_name = ?").get(id) as { id: string } | undefined)?.id;
    if (found) return found;
    if (!createOrphan || !/^codex-[1-9][0-9]*$/.test(id)) return id;
    const orphanId = randomUUID();
    this.db.prepare("INSERT INTO account_aliases (legacy_name, id) VALUES (?, ?)").run(id, orphanId);
    return orphanId;
  }

  codexAccounts(): Account[] {
    return (this.db.prepare("SELECT name, enabled, removing FROM accounts ORDER BY number").all() as Array<{ name: string; enabled: number; removing: number }>)
      .map(({ name, enabled, removing }) => ({ id: name, enabled: Boolean(enabled), removing: Boolean(removing) }));
  }

  listAccounts(): Account[] { return this.codexAccounts(); }

  accountCredentials(id: string): { id: string; auth: string; version: number } {
    const row = this.db.prepare("SELECT auth_json, version FROM secrets.credentials JOIN accounts ON accounts.name = secrets.credentials.name WHERE accounts.name = ? AND removing = 0").get(id) as { auth_json: string; version: number } | undefined;
    if (!row) throw new Error(`Credentials for account ${id} are unavailable; sign in again.`);
    return { id, auth: row.auth_json, version: row.version };
  }

  /** Native identity pairs older Codex Worker accounts and fences a paired Worker sign-in to its Bot's login; it is never published. */
  botAccountIdentity(id: string): string | null {
    try {
      const auth = JSON.parse(this.accountCredentials(id).auth) as { tokens?: { account_id?: unknown; access_token?: unknown } };
      return auth.tokens ? nativeIdentity(auth.tokens) : null;
    } catch { return null; }
  }

  /** Compare private native identities inside the same write transaction as an addition or replacement. */
  private assertUniqueIdentity(identity: string | null, exceptId?: string): void {
    if (!identity) return;
    const existing = this.db.prepare("SELECT accounts.name, auth_json FROM accounts JOIN secrets.credentials ON accounts.name = secrets.credentials.name").all() as Array<{ name: string; auth_json: string }>;
    for (const account of existing) {
      if (account.name !== exceptId && credentialInfo(account.auth_json)?.accountId === identity) throw new DuplicateCodexAccountError();
    }
  }

  addAccount(auth: string): Account {
    const info = credentialInfo(auth);
    if (!info) throw new Error("Codex login did not provide ChatGPT credentials");
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertUniqueIdentity(info.accountId);
      this.db.prepare("INSERT INTO accounts (name) VALUES (?)").run(id);
      this.db.prepare("INSERT INTO secrets.credentials (name, auth_json) VALUES (?, ?)").run(id, auth);
      this.db.prepare("INSERT INTO worker_accounts (id, provider, bot_account) VALUES (?, 'codex', ?)").run(randomUUID(), id);
      this.db.exec("COMMIT");
      return { id, enabled: true, removing: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setEnabled(id: string, enabled: boolean): Account {
    if (this.db.prepare("UPDATE accounts SET enabled = ? WHERE name = ? AND removing = 0").run(Number(enabled), id).changes)
      return this.listAccounts().find((account) => account.id === id)!;
    throw new Error(`unknown or removing Codex Bot account: ${id}`);
  }

  replaceCredentials(id: string, auth: string): void {
    const info = credentialInfo(auth);
    if (!info) throw new Error("Codex login did not provide ChatGPT credentials");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT auth_json FROM accounts JOIN secrets.credentials ON accounts.name = secrets.credentials.name WHERE accounts.name = ? AND removing = 0").get(id) as { auth_json: string } | undefined;
      if (!current) throw new Error(`unknown Codex account: ${id}`);
      // Existing duplicate records stay usable; only a switch to another
      // registered identity is refused. Re-sign-in to this identity is safe.
      if (info.accountId !== credentialInfo(current.auth_json)?.accountId) this.assertUniqueIdentity(info.accountId, id);
      this.db.prepare("UPDATE secrets.credentials SET auth_json = ?, version = version + 1 WHERE name = ?").run(auth, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
    const hasLaunchedAccount = (this.db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>).some(({ name }) => name === "launched_account");
    const sql = hasLaunchedAccount
      ? "SELECT id FROM servers WHERE account = ? OR launched_account = ? ORDER BY id"
      : "SELECT id FROM servers WHERE account = ? ORDER BY id";
    return (this.db.prepare(sql).all(...(hasLaunchedAccount ? [id, id] : [id])) as Array<{ id: string }>).map(({ id }) => id);
  }

  beginRemoval(id: string): void {
    if (!this.db.prepare("UPDATE accounts SET removing = 1 WHERE name = ?").run(id).changes) throw new Error(`unknown Codex account: ${id}`);
  }

  removeAccount(id: string): void {
    this.beginRemoval(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.boundServerIds(id).length) throw new Error(`account ${id} still has bound bots`);
      this.db.prepare("DELETE FROM accounts WHERE name = ?").run(id);
      this.db.prepare("DELETE FROM account_aliases WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM secrets.credentials WHERE name = ?").run(id);
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
    return { timestamp: Number.isFinite(timestamp) ? timestamp : null, accountId: nativeIdentity(value.tokens) };
  } catch { return null; }
}

function nativeIdentity(tokens: { account_id?: unknown; access_token?: unknown }): string | null {
  if (typeof tokens.account_id === "string" && tokens.account_id) return tokens.account_id;
  try {
    const claims = JSON.parse(Buffer.from((tokens.access_token as string).split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const identity = (claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined)?.chatgpt_account_id;
    return typeof identity === "string" && identity ? identity : null;
  } catch { return null; }
}
