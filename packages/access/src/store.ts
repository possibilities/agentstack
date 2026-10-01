import { DatabaseSync } from "node:sqlite";
import { StateJournal, stateHash, type StateApplyInput } from "@stack/api";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac, createPublicKey, verify, randomBytes, randomUUID } from "node:crypto";
import { type Scope } from "./policy.js";
import { approvalInput, decodeQr, encodeQr, enrollmentLifetime, inviteCreateInput, originSchema, secretSchema, redemptionMessage,
  type EnrollmentRequest, type EnrollmentReceipt, type Invitation } from "./enrollment-protocol.js";

export { scopes, type Scope } from "./policy.js";
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
  readonly maintenance: StateJournal;
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
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,secret_hash TEXT NOT NULL,origin TEXT NOT NULL,kind TEXT NOT NULL,scopes TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER,request_id TEXT);
      CREATE TABLE IF NOT EXISTS enrollments(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,commitment TEXT NOT NULL,label TEXT NOT NULL,kind TEXT NOT NULL,scopes TEXT NOT NULL,origin TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,sponsor TEXT,sponsor_revision INTEGER,invitation_id TEXT,credential_id TEXT,cancelled INTEGER,request_expires INTEGER NOT NULL,public_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS enrollment_grants(grant_id TEXT PRIMARY KEY REFERENCES grants(id),enrollment_id TEXT NOT NULL,sponsor_credential_id TEXT);
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
        this.db.exec("INSERT OR IGNORE INTO ui_sessions(hash,credential_id,expires) SELECT hash,credential_id,expires FROM uix_sessions; DROP TABLE uix_sessions");
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
    if (!this.db.prepare("PRAGMA table_info(ui_sessions)").all().some(row => row.name === "id")) this.db.exec("ALTER TABLE ui_sessions ADD COLUMN id TEXT");
    for (const row of this.db.prepare("SELECT hash FROM ui_sessions WHERE id IS NULL").all()) this.db.prepare("UPDATE ui_sessions SET id=? WHERE hash=?").run(randomUUID(), row.hash!);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ui_sessions_identity ON ui_sessions(id); CREATE TABLE IF NOT EXISTS access_history_retired(kind TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,request_id TEXT,PRIMARY KEY(kind,id))");
    this.maintenance = new StateJournal(this.db, "access");
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
    for (const table of ["pairings", "refreshes", "tokens", "handoffs", "sessions", "ui_sessions", "invitations"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(this.now());
    }
    // An invitation/sponsor may expire BEFORE the device QR. Keep the consumed
    // request ID until that QR expires, or an old QR could create a second grant.
    this.db.prepare("DELETE FROM enrollments WHERE request_expires<=?").run(this.now());
    this.db.exec("DELETE FROM audit WHERE seq < (SELECT coalesce(max(seq),0)-999 FROM audit)");
  }
  private audit(action: string, subject: string) { this.db.prepare("INSERT INTO audit(time,action,subject) VALUES(?,?,?)").run(this.now(), action, subject); }
  inventory() {
    const all = <T extends Row = Row>(sql: string) => this.db.prepare(sql).all() as T[];
    return { serverId: this.serverId, clients: all("SELECT * FROM clients ORDER BY created DESC"),
      pairings: all<PairingRow>(`SELECT id,code,label,kind,scopes,created,expires,CASE WHEN expires<=${this.now()} AND state IN ('pending','approved') THEN 'expired' ELSE state END AS state FROM pairings ORDER BY created DESC LIMIT 100`).map(row => ({ ...row, scopes: JSON.parse(row.scopes) as Scope[] })),
      grants: all<GrantRow & { enrollment_id: string | null; sponsor_credential_id: string | null }>("SELECT g.*,e.enrollment_id,e.sponsor_credential_id FROM grants g LEFT JOIN enrollment_grants e ON e.grant_id=g.id ORDER BY g.created DESC").map(row => ({ ...row, scopes: JSON.parse(row.scopes) as Scope[], operations: JSON.parse(row.operations) as string[] })),
      invitations: all("SELECT id,kind,scopes,created,expires,revoked,request_id FROM invitations ORDER BY created DESC LIMIT 100").map(row => ({ ...row, scopes: JSON.parse(row.scopes) as Scope[] })),
      enrollments: all("SELECT id,request_id,label,kind,scopes,created,expires,sponsor,invitation_id,credential_id,cancelled FROM enrollments ORDER BY created DESC LIMIT 100").map(row => ({ ...row, scopes: JSON.parse(row.scopes) as Scope[] })),
      credentials: all("SELECT id,client_id,grant_id,generation,created,expires,revoked FROM credentials ORDER BY created DESC"),
      uiSessions: all("SELECT id,credential_id,expires FROM ui_sessions ORDER BY expires DESC LIMIT 100"),
      audit: all("SELECT * FROM audit ORDER BY seq DESC LIMIT 100") };
  }
  pair(input: { requestId: string; label: string; kind: string; scopes: Scope[]; redemptionSecret: string }) {
    return this.transaction(() => {
      // The client generates and persists the secret before sending. This makes
      // a lost initial response recoverable without storing plaintext server-side.
      const digest = hash(JSON.stringify([input.label, input.kind, [...input.scopes].sort(), hash(input.redemptionSecret)]));
      if (this.get("SELECT 1 FROM access_history_retired WHERE kind='expired_pairings' AND request_id=?", input.requestId)) fail("pairing_retired", 409);
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
    const row = this.get("SELECT c.*,p.kind,g.network,g.scopes,g.revision AS grant_revision FROM credentials c JOIN clients p ON p.id=c.client_id JOIN grants g ON g.id=c.grant_id WHERE c.id=? AND c.revoked IS NULL AND p.revoked IS NULL AND g.revoked IS NULL", id);
    if (!row || row.network !== "tailnet") return fail("credential_revoked");
    if (row.expires <= this.now()) return fail("credential_expired");
    return row;
  }
  refresh(refreshToken: string, requestId: string, audience: "brain" | "content" | "ui" | "access") {
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
  authorize(token: string, audience: "brain" | "content" | "ui" | "access", scope?: Scope): Principal {
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
      this.db.prepare("INSERT OR REPLACE INTO ui_sessions(hash,credential_id,expires,id) VALUES(?,?,?,?)").run(hash(issued.accessToken), principal.credentialId, issued.expiresAt, randomUUID());
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

  private enrollmentRequest(text: string): EnrollmentRequest {
    try { const request = decodeQr(text, this.now()); if (request.type === "request") return request; }
    catch { /* Hide scanner/parser detail behind a stable protocol error. */ }
    return fail("invalid_enrollment_request", 400);
  }
  private enrollmentSponsor(token: string) {
    const principal = this.authorize(token, "access", "access:enroll");
    if (principal.kind === "browser") fail("native_client_required", 403);
    return this.active(principal.credentialId);
  }
  previewEnrollment(text: string, token?: string) {
    const request = this.enrollmentRequest(text);
    const sponsor = token === undefined ? undefined : this.enrollmentSponsor(token);
    return { request, requestHash: hash(encodeQr(request)), allowedScopes: request.scopes.filter(scope => !sponsor
      || scope !== "access:enroll" && (JSON.parse(sponsor.scopes) as Scope[]).includes(scope)) };
  }
  createInvitation(input: { requestId: string; secret: string; kind: string; scopes: Scope[]; expiresAt: number }, origin: string): Invitation {
    const parsed = inviteCreateInput.parse(input);
    originSchema.parse(origin);
    return this.transaction(() => {
      if (parsed.expiresAt <= this.now() || parsed.expiresAt > this.now() + enrollmentLifetime) fail("invitation_expired_or_clock_skew", 400);
      if (parsed.kind === "browser" && parsed.scopes.includes("access:enroll")) fail("native_client_required", 400);
      const selected = [...parsed.scopes].sort();
      const digest = hash(JSON.stringify([hash(parsed.secret), origin, parsed.kind, selected, parsed.expiresAt]));
      if (this.get("SELECT 1 FROM access_history_retired WHERE kind='expired_invitations' AND id=?", parsed.requestId)) fail("invitation_retired", 409);
      const old = this.get("SELECT * FROM invitations WHERE id=?", parsed.requestId);
      if (old) {
        if (old.digest !== digest) fail("request_conflict", 409);
        if (old.revoked !== null) fail("invitation_revoked", 409);
      } else {
        if (Number(this.get("SELECT count(*) n FROM invitations WHERE expires>? AND revoked IS NULL AND request_id IS NULL", this.now())!.n) >= 100) fail("invitation_capacity", 429);
        this.db.prepare("INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,NULL,NULL)").run(parsed.requestId, digest, hash(parsed.secret), origin, parsed.kind, JSON.stringify(selected), this.now(), parsed.expiresAt);
        this.audit("invitation_created", parsed.requestId);
      }
      return { v: 1, type: "invite", id: parsed.requestId, serverId: this.serverId, origin, secret: parsed.secret,
        kind: parsed.kind, scopes: selected, expiresAt: parsed.expiresAt };
    });
  }
  revokeInvitation(id: string) {
    return this.transaction(() => {
      if (!this.get("SELECT id FROM invitations WHERE id=?", id)) fail("not_found", 404);
      this.db.prepare("UPDATE invitations SET revoked=coalesce(revoked,?) WHERE id=?").run(this.now(), id);
      this.db.prepare("UPDATE enrollments SET cancelled=coalesce(cancelled,?) WHERE invitation_id=? AND credential_id IS NULL").run(this.now(), id);
      this.audit("invitation_revoked", id);
      return { revoked: true };
    });
  }
  approveEnrollment(text: string, selected: Scope[], origin: string, token?: string): EnrollmentReceipt {
    approvalInput.parse({ request: text, scopes: selected }); originSchema.parse(origin);
    return this.transaction(() => {
      const request = this.enrollmentRequest(text);
      const sponsor = token === undefined ? undefined : this.enrollmentSponsor(token);
      if (selected.some(scope => !request.scopes.includes(scope))) fail("scope_not_requested", 400);
      if (sponsor && selected.some(scope => scope === "access:enroll" || !JSON.parse(sponsor.scopes).includes(scope))) fail("delegation_scope_refused", 403);
      if (request.kind === "browser" && selected.includes("access:enroll")) fail("native_client_required", 400);
      return this.admitEnrollment(request, selected, origin, sponsor);
    });
  }
  claimInvitation(id: string, secret: string, text: string): EnrollmentReceipt {
    secretSchema.parse(secret);
    return this.transaction(() => {
      const invite = this.get("SELECT * FROM invitations WHERE id=?", id);
      if (!invite || invite.secret_hash !== hash(secret) || invite.revoked !== null || invite.expires <= this.now()) fail("invitation_invalid");
      const request = this.enrollmentRequest(text);
      if (invite.kind !== request.kind || request.scopes.some(scope => !JSON.parse(invite.scopes).includes(scope))) fail("invitation_policy_mismatch", 403);
      if (invite.request_id && invite.request_id !== request.id) fail("invitation_used", 409);
      const receipt = this.admitEnrollment(request, request.scopes, invite.origin, undefined, invite);
      this.db.prepare("UPDATE invitations SET request_id=? WHERE id=?").run(request.id, id);
      return receipt;
    });
  }
  private admitEnrollment(request: EnrollmentRequest, selected: Scope[], origin: string, sponsor?: Row, invitation?: Row): EnrollmentReceipt {
    const requestHash = hash(encodeQr(request)), scopes = JSON.stringify([...selected].sort());
    let row = this.get("SELECT * FROM enrollments WHERE request_id=?", request.id);
    if (row) {
      if (row.expires <= this.now()) fail("enrollment_expired", 409);
      if (row.request_hash !== requestHash || row.scopes !== scopes || row.origin !== origin
        || row.sponsor !== (sponsor?.id ?? null) || row.invitation_id !== (invitation?.id ?? null)) fail("request_conflict", 409);
      if (row.cancelled !== null) fail("enrollment_cancelled", 409);
      if (sponsor && row.sponsor_revision !== sponsor.grant_revision) fail("enrollment_authority_changed", 409);
    } else {
      if (Number(this.get("SELECT count(*) n FROM enrollments WHERE credential_id IS NULL AND cancelled IS NULL AND expires>?", this.now())!.n) >= 100
        || sponsor && Number(this.get("SELECT count(*) n FROM enrollments WHERE sponsor=? AND credential_id IS NULL AND cancelled IS NULL AND expires>?", sponsor.id, this.now())!.n) >= 10) fail("enrollment_capacity", 429);
      const id = randomUUID(), expires = Math.min(request.expiresAt, invitation?.expires ?? Infinity, sponsor?.expires ?? Infinity);
      this.db.prepare("INSERT INTO enrollments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)").run(id, request.id, requestHash, request.commitment, request.label, request.kind, scopes, origin, this.now(), expires,
        sponsor?.id ?? null, sponsor?.grant_revision ?? null, invitation?.id ?? null, request.expiresAt, request.publicKey);
      this.audit("enrollment_approved", id);
      row = this.get("SELECT * FROM enrollments WHERE id=?", id)!;
    }
    return { v: 1, type: "receipt", id: row.id, serverId: this.serverId, origin: row.origin, requestId: row.request_id,
      requestHash: row.request_hash, scopes: JSON.parse(row.scopes), expiresAt: row.expires };
  }
  cancelEnrollment(id: string, token?: string) {
    return this.transaction(() => {
      const sponsor = token === undefined ? undefined : this.enrollmentSponsor(token);
      const row = this.get("SELECT * FROM enrollments WHERE id=?", id);
      if (!row || sponsor && row.sponsor !== sponsor.id) fail("not_found", 404);
      if (row.credential_id) fail("enrollment_already_redeemed", 409);
      this.db.prepare("UPDATE enrollments SET cancelled=coalesce(cancelled,?) WHERE id=?").run(this.now(), id);
      this.audit("enrollment_cancelled", id);
      return { cancelled: true };
    });
  }
  redeemEnrollment(id: string, redemptionSecret: string, requestHash: string, signature: string) {
    secretSchema.parse(redemptionSecret);
    return this.transaction(() => {
      const row = this.get("SELECT * FROM enrollments WHERE id=?", id);
      if (!row || row.commitment !== hash(redemptionSecret) || row.request_hash !== requestHash || row.cancelled !== null || row.expires <= this.now()) fail("enrollment_invalid");
      const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(row.public_key, "base64url")]), format: "der", type: "spki" });
      if (!verify(null, redemptionMessage({ origin: row.origin, serverId: this.serverId, id, requestHash }, row.commitment), key, Buffer.from(signature, "base64url"))) fail("enrollment_proof_invalid");
      const refresh = derive(redemptionSecret, `enrollment-refresh:${this.serverId}:${id}`);
      if (!row.credential_id) {
        if (row.sponsor) {
          const sponsor = this.active(row.sponsor);
          if (sponsor.kind === "browser" || sponsor.grant_revision !== row.sponsor_revision || !JSON.parse(sponsor.scopes).includes("access:enroll")
            || JSON.parse(row.scopes).some((scope: string) => scope === "access:enroll" || !JSON.parse(sponsor.scopes).includes(scope))) fail("enrollment_authority_changed", 403);
        }
        if (row.invitation_id) {
          const invitation = this.get("SELECT * FROM invitations WHERE id=?", row.invitation_id);
          if (!invitation || invitation.revoked !== null || invitation.expires <= this.now()) fail("invitation_invalid");
        }
        const client = randomUUID(), grant = randomUUID(), credential = randomUUID();
        this.db.prepare("INSERT INTO clients VALUES(?,?,?,?,NULL)").run(client, row.label, row.kind, this.now());
        this.db.prepare("INSERT INTO grants VALUES(?,?,'tailnet',?,'[]',?,NULL,1)").run(grant, client, row.scopes, this.now());
        this.db.prepare("INSERT INTO credentials VALUES(?,?,?,?,0,?,?,NULL)").run(credential, client, grant, hash(refresh), this.now(), this.now() + 30 * 86400_000);
        this.db.prepare("INSERT INTO enrollment_grants VALUES(?,?,?)").run(grant, row.id, row.sponsor);
        this.db.prepare("UPDATE enrollments SET credential_id=? WHERE id=?").run(credential, id);
        row.credential_id = credential;
        this.audit("enrollment_redeemed", id);
      }
      const credential = this.active(row.credential_id);
      if (credential.refresh_hash !== hash(refresh)) fail("redemption_already_rotated");
      return { clientId: credential.client_id as string, credentialId: credential.id as string, refreshToken: refresh,
        expiresAt: credential.expires as number, serverId: this.serverId };
    });
  }
  private historySelection(kind: "ui_sessions" | "expired_pairings" | "expired_invitations", ids: string[]) {
    const table = { ui_sessions: "ui_sessions", expired_pairings: "pairings", expired_invitations: "invitations" }[kind];
    const rows = [...new Set(ids)].sort().map(id => { const row = this.get(`SELECT * FROM ${table} WHERE id=?`, id); if (!row) throw new Error("Access history identity missing; refresh snapshot"); return row; });
    const blockedBy = rows.filter(row => row.expires > this.now()).map(row => `${row.id}: active/unexpired authority cannot be retired; revocation is separate`);
    return { table, rows, blockedBy, revision: stateHash([this.serverId, kind, rows, blockedBy]) };
  }
  historyPlan(kind: "ui_sessions" | "expired_pairings" | "expired_invitations", ids: string[]) {
    const selection = this.historySelection(kind, ids);
    return this.maintenance.plan({ subject: null, action: `history_${kind}`, revision: selection.revision, resources: selection.rows.map(row => String(row.id)), blockedBy: selection.blockedBy,
      retained: ["Server, client, grant and credential identities, enrollment and Share admission receipts remain; revocation is never undone", "Minimal retired pairing/invitation digest markers prevent manual-retirement replay", "Audit has no manual prune operation; the existing automatic sequence bound remains", "Device credentials, outboxes, browser cookies and backups are independent copies"],
      regeneration: ["Explicit future pairing/session admissions create new identities; retiring expired metadata grants no authority"] }, { kind, ids: [...new Set(ids)].sort() });
  }
  historyClear(input: StateApplyInput) {
    const result = this.maintenance.atomic(input, (plan, payload) => {
      const { kind, ids } = payload as { kind: "ui_sessions" | "expired_pairings" | "expired_invitations"; ids: string[] };
      const current = this.historySelection(kind, ids);
      if (plan.action !== `history_${kind}` || current.revision !== plan.revision || current.blockedBy.length) throw new Error("Access history/authority changed; prepare again");
    }, payload => {
      const { kind, ids } = payload as { kind: "ui_sessions" | "expired_pairings" | "expired_invitations"; ids: string[] };
      const current = this.historySelection(kind, ids);
      for (const row of current.rows) {
        this.db.prepare("INSERT INTO access_history_retired VALUES(?,?,?,?)").run(kind, row.id, row.digest ?? stateHash([row.id, row.credential_id]), kind === "expired_pairings" ? row.request : null);
        this.db.prepare(`DELETE FROM ${current.table} WHERE id=?`).run(row.id);
      }
      this.audit("history_retired", input.requestId);
      return ids.map(resource => ({ resource, outcome: "removed", detail: "Exact expired metadata removed; durable identity, revocation and enrollment/Share replay fences retained" }));
    });
    this.changed?.(); for (const listener of this.uiListeners) { try { listener(); } catch { /* invalidation cannot undo maintenance */ } }
    return result;
  }
}
