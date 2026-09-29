import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDir } from "./workspace.js";

export type LocalAudience = "uix" | "inspector";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const fresh = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (left: string, right: string) => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
export class LocalAuthError extends Error { constructor() { super("local authentication required"); } }
type Capability = { digest: string; kind: string; origin: string; audience: string; parent: string | null; expires: number };

/** Same-user private storage shared by the owner and its gateway/UI children.
 * Capability consumption is transactional across processes; only digests persist.
 * No public listener mints a bootstrap or exposes the operator credential. */
export class LocalAuth {
  private readonly db: DatabaseSync;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const directory = join(stateDir(env), "local-auth");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 || process.getuid && directoryStat.uid !== process.getuid()) throw new LocalAuthError();
    const path = join(directory, "authority.sqlite3");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new LocalAuthError();
    } finally { closeSync(fd); }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS authority (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL); CREATE TABLE IF NOT EXISTS capabilities (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL, audience TEXT NOT NULL, parent TEXT, expires INTEGER NOT NULL);");
      this.db.prepare("INSERT OR IGNORE INTO authority(id,secret) VALUES(1,?)").run(fresh());
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  credential(): string { return (this.db.prepare("SELECT secret FROM authority WHERE id=1").get() as { secret: string }).secret; }
  rotate(): void { this.transaction(() => { this.db.prepare("UPDATE authority SET secret=? WHERE id=1").run(fresh()); this.db.exec("DELETE FROM capabilities"); }); }
  operator(header: string | undefined | null): string {
    const value = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!value || !same(value, this.credential())) throw new LocalAuthError();
    return value;
  }
  bootstrap(origin: string, audience: LocalAudience): string {
    localOrigin(origin);
    return this.issue("bootstrap", origin, audience, null, Date.now() + 60_000);
  }
  redeem(token: string, origin: string, audience: LocalAudience): { token: string; expiresAt: number } {
    return this.transaction(() => {
      const capability = this.read(token, "bootstrap", origin, audience);
      this.db.prepare("DELETE FROM capabilities WHERE digest=?").run(capability.digest);
      const expiresAt = Date.now() + 8 * 60 * 60_000;
      return { token: this.issue("session", origin, audience, null, expiresAt), expiresAt };
    });
  }
  session(token: string, origin: string, audience: LocalAudience): Capability { return this.read(token, "session", origin, audience); }
  ticket(session: string, origin: string): string {
    return this.transaction(() => {
      const parent = this.session(session, origin, "uix");
      return this.issue("ticket", origin, "websocket", parent.digest, Math.min(parent.expires, Date.now() + 30_000));
    });
  }
  consumeTicket(token: string, origin: string): Capability {
    return this.transaction(() => {
      const ticket = this.read(token, "ticket", origin, "websocket");
      const session = this.sessionDigest(ticket.parent!, origin);
      this.db.prepare("DELETE FROM capabilities WHERE digest=?").run(ticket.digest);
      return session;
    });
  }
  sessionDigest(digest: string, origin: string): Capability {
    const value = this.db.prepare("SELECT * FROM capabilities WHERE digest=? AND kind='session' AND audience='uix' AND origin=? AND expires>?").get(digest, origin, Date.now()) as Capability | undefined;
    if (!value) throw new LocalAuthError();
    return value;
  }
  revokeSession(token: string, origin: string, audience: LocalAudience): void {
    const session = this.session(token, origin, audience);
    this.db.prepare("DELETE FROM capabilities WHERE digest=? OR parent=?").run(session.digest, session.digest);
  }
  /** Internal Access assertion, bound to the exact HTTP request and remote view. */
  signRemote(method: string, path: string, origin: string, scope: string, scopes: string): string {
    const expires = Date.now() + 30_000;
    return `${expires}.${this.remoteMac(expires, method, path, origin, scope, scopes)}`;
  }
  verifyRemote(proof: string, method: string, path: string, origin: string, scope: string, scopes: string): void {
    const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(proof);
    const expires = Number(match?.[1]);
    if (!match || expires < Date.now() || expires > Date.now() + 30_000 || !same(match[2]!, this.remoteMac(expires, method, path, origin, scope, scopes))) throw new LocalAuthError();
  }
  private remoteMac(expires: number, ...values: string[]): string { return createHmac("sha256", this.credential()).update(JSON.stringify(["access-uix-v1", expires, ...values])).digest("hex"); }
  private read(token: string, kind: string, origin: string, audience: string): Capability {
    if (!tokenPattern.test(token)) throw new LocalAuthError();
    const value = this.db.prepare("SELECT * FROM capabilities WHERE digest=? AND kind=? AND origin=? AND audience=? AND expires>?").get(hash(token), kind, origin, audience, Date.now()) as Capability | undefined;
    if (!value) throw new LocalAuthError();
    return value;
  }
  private issue(kind: string, origin: string, audience: string, parent: string | null, expires: number): string {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM capabilities WHERE expires<=?").run(Date.now());
      if ((this.db.prepare("SELECT count(*) AS n FROM capabilities").get() as { n: number }).n >= 2048) throw new Error("local session capacity reached");
      const token = fresh();
      this.db.prepare("INSERT INTO capabilities VALUES(?,?,?,?,?,?)").run(hash(token), kind, origin, audience, parent, expires);
      return token;
    });
  }
  private depth = 0;
  private transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE"); this.depth++;
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.depth--; }
  }
}

export function withLocalAuth<T>(env: NodeJS.ProcessEnv, fn: (auth: LocalAuth) => T): T {
  const auth = new LocalAuth(env); try { return fn(auth); } finally { auth.close(); }
}
export function operatorHeaders(env: NodeJS.ProcessEnv = process.env): { authorization: string } {
  return withLocalAuth(env, (auth) => ({ authorization: `Bearer ${auth.credential()}` }));
}
export function localOrigin(origin: string): URL {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.port) throw new LocalAuthError();
  return url;
}
export const localCookieName = (audience: LocalAudience) => `agentstack_local_${audience}`;
export function localCookie(header: string | null | undefined, audience: LocalAudience): string {
  const values = (header ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${localCookieName(audience)}=`));
  return values.length === 1 ? values[0]!.slice(localCookieName(audience).length + 1) : "";
}
