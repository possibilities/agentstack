import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export const scopes = ["brain:share", "brain:status", "content:read", "ui:view", "ui:control"] as const;
export type Scope = typeof scopes[number];
export class AccessError extends Error {
  constructor(public code: string, public status = 401) { super(code); }
}
function fail(code = "unauthorized", status = 401): never { throw new AccessError(code, status); }
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const derive = (key: string, label: string) => createHmac("sha256", key).update(label).digest("base64url");
type Row = Record<string, any>;
type GrantRow = {
  id: string; client_id: string; network: "tailnet" | "public-cloud";
  scopes: string; operations: string; revision: number; created: number; revoked: number | null;
};
type PairingRow = {
  id: string; code: string; label: string; kind: string; scopes: string;
  created: number; expires: number; state: string;
};
export type Principal = { clientId: string; kind: string; grantId: string; credentialId: string; scopes: Scope[] };

/** Single synchronous SQLite authority. All check-and-transition operations are
 * transactions; no network work or await occurs while holding a write lock. */
export class AccessStore {
  readonly db: DatabaseSync;
  readonly serverId: string;
  changed?: () => void;
  private readonly uiListeners = new Set<() => void>();
  constructor(root: string, readonly now = () => Date.now()) {
    const directory = join(root, "access");
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const path = join(directory, "access.db");
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,label TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,revoked INTEGER);
      CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY,request TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,code TEXT UNIQUE NOT NULL,label TEXT NOT NULL,kind TEXT NOT NULL,scopes TEXT NOT NULL,secret_hash TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,client_id TEXT,grant_id TEXT,credential_id TEXT);
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),network TEXT NOT NULL,scopes TEXT NOT NULL,operations TEXT NOT NULL,created INTEGER NOT NULL,revoked INTEGER,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS instance(id INTEGER PRIMARY KEY CHECK(id=1),uuid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),grant_id TEXT NOT NULL REFERENCES grants(id),refresh_hash TEXT UNIQUE NOT NULL,generation INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER);
      CREATE TABLE IF NOT EXISTS refreshes(old_hash TEXT PRIMARY KEY,request TEXT NOT NULL,credential_id TEXT NOT NULL,generation INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,credential_id TEXT NOT NULL REFERENCES credentials(id),audience TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(client_id TEXT NOT NULL REFERENCES clients(id),job_id INTEGER NOT NULL,PRIMARY KEY(client_id,job_id));
      CREATE TABLE IF NOT EXISTS handoffs(hash TEXT PRIMARY KEY,credential_id TEXT NOT NULL REFERENCES credentials(id),path TEXT NOT NULL,origin TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,credential_id TEXT NOT NULL REFERENCES credentials(id),path TEXT NOT NULL,origin TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ui_sessions(hash TEXT PRIMARY KEY,credential_id TEXT NOT NULL REFERENCES credentials(id),expires INTEGER NOT NULL);
    `);
    const grantColumns = this.db.prepare("PRAGMA table_info(grants)").all();
    if (!grantColumns.some(column => column.name === "revision")) {
      this.db.exec("ALTER TABLE grants ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    // Preserve existing browser grants when the UI scope names change. Bump
    // affected grant revisions so old sessions cannot silently retain authority.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='uix_sessions'").get()) {
        this.db.exec("INSERT OR IGNORE INTO ui_sessions SELECT * FROM uix_sessions; DROP TABLE uix_sessions");
      }
      for (const table of ["pairings", "grants"] as const) {
        const rows = this.db.prepare(`SELECT id,scopes FROM ${table}`).all() as Array<{ id: string; scopes: string }>;
        for (const row of rows) {
          const previous = JSON.parse(row.scopes) as string[];
          const next = previous.map(scope => scope === "uix:view" ? "ui:view" : scope === "uix:control" ? "ui:control" : scope);
          if (next.every((scope, index) => scope === previous[index])) continue;
          this.db.prepare(`UPDATE ${table} SET scopes=?${table === "grants" ? ",revision=revision+1" : ""} WHERE id=?`).run(JSON.stringify([...new Set(next)]), row.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.prepare("INSERT OR IGNORE INTO instance VALUES(1,?)").run(randomUUID());
    this.serverId = this.get("SELECT uuid FROM instance WHERE id=1")!.uuid;
  }
  close() { this.db.close(); }
  private get(sql: string, ...args: (string | number)[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let value: T;
    try { this.cleanup(); value = run(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    try { this.changed?.(); } catch { /* a notification failure cannot undo a committed transition */ }
    for (const listener of this.uiListeners) { try { listener(); } catch { /* one closed socket cannot break a committed write */ } }
    return value;
  }
  private cleanup() {
    // Expired secrets cannot recover an exchange. Retain durable identities and
    // admission receipts, but bound abandoned requests and ephemeral material.
    for (const table of ["pairings", "refreshes", "tokens", "handoffs", "sessions", "ui_sessions"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(this.now());
    }
    this.db.exec("DELETE FROM audit WHERE seq < (SELECT coalesce(max(seq),0)-999 FROM audit)");
  }
  private audit(action: string, subject: string) { this.db.prepare("INSERT INTO audit(time,action,subject) VALUES(?,?,?)").run(this.now(), action, subject); }
  inventory() {
    const all = <T extends Row = Row>(sql: string) => this.db.prepare(sql).all() as T[];
    return { serverId: this.serverId, clients: all("SELECT * FROM clients ORDER BY created DESC"),
      pairings: all<PairingRow>(`SELECT id,code,label,kind,scopes,created,expires,CASE WHEN expires<=${this.now()} AND state IN ('pending','approved') THEN 'expired' ELSE state END AS state FROM pairings ORDER BY created DESC LIMIT 100`).map(row => ({ ...row, scopes: JSON.parse(row.scopes) as Scope[] })),
      grants: all<GrantRow>("SELECT * FROM grants ORDER BY created DESC").map(row => ({ ...row, scopes: JSON.parse(row.scopes) as Scope[], operations: JSON.parse(row.operations) as string[] })),
      credentials: all("SELECT id,client_id,grant_id,generation,created,expires,revoked FROM credentials ORDER BY created DESC"),
      uiSessions: all("SELECT credential_id,expires FROM ui_sessions ORDER BY expires DESC LIMIT 100"),
      audit: all("SELECT * FROM audit ORDER BY seq DESC LIMIT 100") };
  }
  pair(input: { requestId: string; label: string; kind: string; scopes: Scope[]; redemptionSecret: string }) {
    return this.transaction(() => {
      // The client generates and persists the secret before sending. This makes
      // a lost initial response recoverable without storing plaintext server-side.
      const digest = hash(JSON.stringify([input.label, input.kind, [...input.scopes].sort(), hash(input.redemptionSecret)]));
      const old = this.get("SELECT * FROM pairings WHERE request=?", input.requestId);
      if (old) { if (old.digest !== digest) fail("request_conflict", 409); return { id: old.id as string, code: old.code as string, expiresAt: old.expires as number, serverId: this.serverId }; }
      if (Number(this.get("SELECT count(*) n FROM pairings WHERE expires>? AND state='pending'", this.now())!.n) >= 100) fail("pairing_capacity", 429);
      const id = randomUUID(), code = randomBytes(8).toString("hex").toUpperCase(), expires = this.now() + 600_000;
      this.db.prepare("INSERT INTO pairings VALUES(?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL)").run(id, input.requestId, digest, code, input.label, input.kind, JSON.stringify(input.scopes), hash(input.redemptionSecret), this.now(), expires);
      this.audit("pairing_requested", id);
      return { id, code, expiresAt: expires, serverId: this.serverId };
    });
  }
  approve(id: string, code: string, allow: boolean, selected?: Scope[]) {
    return this.transaction(() => {
      const row = this.get("SELECT * FROM pairings WHERE id=?", id);
      if (!row || row.code !== code || row.expires <= this.now()) fail("pairing_expired_or_invalid", 409);
      const approved = [...new Set(selected ?? JSON.parse(row.scopes))].sort() as Scope[];
      if (approved.some(scope => !JSON.parse(row.scopes).includes(scope))) fail("scope_not_requested", 400);
      if (row.state === (allow ? "approved" : "denied")) {
        if (allow && this.get("SELECT scopes FROM grants WHERE id=?", row.grant_id)?.scopes !== JSON.stringify(approved)) fail("approval_conflict", 409);
        return { state: row.state as string };
      }
      if (row.state !== "pending") fail("pairing_not_pending", 409);
      if (allow) {
        const client = randomUUID(), grant = randomUUID();
        this.db.prepare("INSERT INTO clients VALUES(?,?,?,?,NULL)").run(client, row.label, row.kind, this.now());
        this.db.prepare("INSERT INTO grants VALUES(?,?,'tailnet',?,'[]',?,NULL,1)").run(grant, client, JSON.stringify(approved), this.now());
        this.db.prepare("UPDATE pairings SET state='approved',client_id=?,grant_id=? WHERE id=?").run(client, grant, id);
      } else this.db.prepare("UPDATE pairings SET state='denied' WHERE id=?").run(id);
      this.audit(allow ? "pairing_approved" : "pairing_denied", id);
      return { state: allow ? "approved" : "denied" };
    });
  }
  redeem(id: string, redemptionSecret: string) {
    return this.transaction(() => {
      const row = this.get("SELECT * FROM pairings WHERE id=?", id);
      if (!row || row.secret_hash !== hash(redemptionSecret) || row.expires <= this.now()) fail("pairing_expired_or_invalid");
      if (row.state === "pending") fail("approval_pending", 409);
      if (!["approved", "redeemed"].includes(row.state)) fail("pairing_denied");
      const refresh = derive(redemptionSecret, `refresh:${id}`);
      let credential = row.credential_id as string | null;
      if (!credential) {
        credential = randomUUID();
        this.db.prepare("INSERT INTO credentials VALUES(?,?,?,?,0,?,?,NULL)").run(credential, row.client_id, row.grant_id, hash(refresh), this.now(), this.now() + 30 * 86400_000);
        this.db.prepare("UPDATE pairings SET state='redeemed',credential_id=? WHERE id=?").run(credential, id);
        this.audit("pairing_redeemed", credential);
      }
      const active = this.active(credential);
      if (active.refresh_hash !== hash(refresh)) fail("redemption_already_rotated");
      return { clientId: row.client_id as string, credentialId: credential, refreshToken: refresh, expiresAt: active.expires as number, serverId: this.serverId };
    });
  }
  private active(id: string): Row {
    const row = this.get("SELECT c.*,p.kind,g.network,g.scopes FROM credentials c JOIN clients p ON p.id=c.client_id JOIN grants g ON g.id=c.grant_id WHERE c.id=? AND c.revoked IS NULL AND p.revoked IS NULL AND g.revoked IS NULL", id);
    if (!row || row.network !== "tailnet") return fail("credential_revoked");
    if (row.expires <= this.now()) return fail("credential_expired");
    return row;
  }
  refresh(refreshToken: string, requestId: string, audience: "brain" | "content" | "ui") {
    return this.transaction(() => {
      const digest = hash(refreshToken);
      const current = this.get("SELECT * FROM credentials WHERE refresh_hash=?", digest);
      const replay = this.get("SELECT * FROM refreshes WHERE old_hash=?", digest);
      let row: Row;
      if (replay) {
        if (replay.request !== `${requestId}:${audience}` || replay.expires <= this.now()) fail("refresh_reused_repair_required");
        row = this.active(replay.credential_id);
        if (row.generation !== replay.generation) fail("refresh_superseded");
      } else {
        if (!current) fail();
        row = this.active(current.id);
        const next = derive(refreshToken, `refresh:${requestId}:${audience}`);
        this.db.prepare("UPDATE credentials SET refresh_hash=?,generation=generation+1 WHERE id=?").run(hash(next), row.id);
        this.db.prepare("INSERT INTO refreshes VALUES(?,?,?,?,?)").run(digest, `${requestId}:${audience}`, row.id, row.generation + 1, this.now() + 300_000);
        this.audit("credential_refreshed", row.id);
      }
      const token = derive(refreshToken, `access:${requestId}:${audience}`);
      const old = this.get("SELECT expires FROM tokens WHERE hash=?", hash(token));
      const expiresAt = old?.expires ?? this.now() + 300_000;
      this.db.prepare("INSERT OR IGNORE INTO tokens VALUES(?,?,?,?)").run(hash(token), row.id, audience, expiresAt);
      return { accessToken: token, refreshToken: derive(refreshToken, `refresh:${requestId}:${audience}`), audience, expiresAt: expiresAt as number, credentialId: row.id as string, serverId: this.serverId };
    });
  }
  authorize(token: string, audience: "brain" | "content" | "ui", scope?: Scope): Principal {
    const record = this.get("SELECT * FROM tokens WHERE hash=?", hash(token));
    if (!record || record.expires <= this.now() || record.audience !== audience) return fail();
    const row = this.active(record.credential_id), allowed = JSON.parse(row.scopes) as Scope[];
    if (scope && !allowed.includes(scope)) return fail("insufficient_scope", 403);
    return { clientId: row.client_id, kind: row.kind, grantId: row.grant_id, credentialId: row.id, scopes: allowed };
  }
  /** A browser session is distinct from API access tokens and may only belong to a browser-kind client. */
  startUi(refreshToken: string, requestId: string) {
    const credential = this.get("SELECT id FROM credentials WHERE refresh_hash=?", hash(refreshToken))
      ?? this.get("SELECT credential_id AS id FROM refreshes WHERE old_hash=? AND request=?", hash(refreshToken), `${requestId}:ui`);
    if (!credential) fail();
    this.uiCheck(credential.id);
    const issued = this.refresh(refreshToken, requestId, "ui");
    const principal = this.authorize(issued.accessToken, "ui", "ui:view");
    if (principal.kind !== "browser") fail("browser_required", 403);
    this.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO ui_sessions VALUES(?,?,?)").run(hash(issued.accessToken), principal.credentialId, issued.expiresAt);
      this.audit("ui_session_admitted", principal.clientId);
    });
    return issued;
  }
  ui(token: string): Principal {
    const row = this.get("SELECT 1 FROM ui_sessions WHERE hash=? AND expires>?", hash(token), this.now());
    if (!row) fail();
    const principal = this.authorize(token, "ui", "ui:view");
    if (principal.kind !== "browser") fail("browser_required", 403);
    return principal;
  }
  uiExpires(token: string): number {
    this.ui(token);
    return this.get("SELECT expires FROM ui_sessions WHERE hash=?", hash(token))!.expires;
  }
  uiMutation(principal: Principal, pkg: string, operation: string) {
    this.uiCheck(principal.credentialId, "ui:control");
    this.transaction(() => this.audit("ui_mutation", `${principal.clientId}:${pkg}.${operation}`));
  }
  uiCheck(credentialId: string, scope: Scope = "ui:view") {
    const row = this.active(credentialId);
    if (row.kind !== "browser" || !JSON.parse(row.scopes).includes(scope)) fail("insufficient_scope", 403);
  }
  uiHandoff(token: string, path: string, origin: "documents" | "artifacts") {
    const principal = this.ui(token);
    this.uiCheck(principal.credentialId, "content:read");
    return this.handoff(principal, path, origin);
  }
  watchUi(listener: () => void) { this.uiListeners.add(listener); return () => this.uiListeners.delete(listener); }
  updateGrant(id: string, expectedRevision: number, selected: Scope[], operations: string[]) {
    return this.transaction(() => {
      const row = this.get("SELECT * FROM grants WHERE id=?", id);
      if (!row || row.revoked !== null) fail("grant_not_active", 409);
      if (row.revision !== expectedRevision) fail("revision_conflict", 409);
      if (row.network === "tailnet" && operations.length || row.network === "public-cloud" && selected.length) fail("wrong_grant_policy", 400);
      this.db.prepare("UPDATE grants SET scopes=?,operations=?,revision=revision+1 WHERE id=?").run(JSON.stringify([...new Set(selected)].sort()), JSON.stringify([...new Set(operations)].sort()), id);
      this.audit("grant_updated", id);
      return { id, revision: expectedRevision + 1 };
    });
  }
  /** Future ingress supplies authenticated grant identity and verified network;
   * evaluation never creates an internal Bot or Worker MCP context. */
  evaluateOperation(grantId: string, network: "tailnet" | "public-cloud", operation: string) {
    const row = this.get("SELECT g.* FROM grants g JOIN clients c ON c.id=g.client_id WHERE g.id=? AND g.revoked IS NULL AND c.revoked IS NULL", grantId);
    return { allowed: !!row && network === "public-cloud" && row.network === network && JSON.parse(row.operations).includes(operation), grantId, operation };
  }
  private contentCredential(id: string) {
    const row = this.active(id);
    if (!JSON.parse(row.scopes).includes("content:read")) fail("insufficient_scope", 403);
    return row;
  }
  revoke(kind: "client" | "grant" | "credential", id: string) {
    return this.transaction(() => {
      const table = { client: "clients", grant: "grants", credential: "credentials" }[kind];
      if (!this.get(`SELECT id FROM ${table} WHERE id=?`, id)) fail("not_found", 404);
      this.db.prepare(`UPDATE ${table} SET revoked=coalesce(revoked,?) WHERE id=?`).run(this.now(), id);
      this.audit(`${kind}_revoked`, id); return { revoked: true };
    });
  }
  receipt(client: string, job: number) { this.db.prepare("INSERT OR IGNORE INTO receipts VALUES(?,?)").run(client, job); }
  ownJobs(client: string, jobs: number[]) { return jobs.filter(job => this.get("SELECT 1 FROM receipts WHERE client_id=? AND job_id=?", client, job)); }
  handoff(principal: Principal, path: string, origin: "documents" | "artifacts") {
    return this.transaction(() => {
      this.contentCredential(principal.credentialId);
      const token = secret();
      this.db.prepare("INSERT INTO handoffs VALUES(?,?,?,?,?,0)").run(hash(token), principal.credentialId, path, origin, this.now() + 60_000);
      return { handoff: token, expiresAt: this.now() + 60_000 };
    });
  }
  exchange(token: string, origin: string) {
    return this.transaction(() => {
      const row = this.get("SELECT * FROM handoffs WHERE hash=?", hash(token));
      if (!row || row.origin !== origin || row.expires <= this.now() || row.used) fail();
      this.contentCredential(row.credential_id);
      const session = secret(), expiresAt = this.now() + 900_000;
      this.db.prepare("UPDATE handoffs SET used=1 WHERE hash=?").run(hash(token));
      this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(hash(session), row.credential_id, row.path, origin, expiresAt);
      return { session, path: row.path as string, expiresAt };
    });
  }
  session(token: string, origin: string, path: string) {
    const row = this.get("SELECT * FROM sessions WHERE hash=?", hash(token));
    if (!row || row.origin !== origin || row.expires <= this.now() || !(path === row.path || row.path.endsWith("/") && path.startsWith(row.path))) fail();
    this.contentCredential(row.credential_id);
  }
  cloudGrant(label: string, operations: string[]) {
    return this.transaction(() => {
      const client = randomUUID(), id = randomUUID();
      this.db.prepare("INSERT INTO clients VALUES(?,?,'cloud',?,NULL)").run(client, label, this.now());
      this.db.prepare("INSERT INTO grants VALUES(?,?,'public-cloud','[]',?,?,NULL,1)").run(id, client, JSON.stringify(operations), this.now());
      this.audit("cloud_grant_created", id); return { id, clientId: client, network: "public-cloud", operations, credentialIssued: false };
    });
  }
}
