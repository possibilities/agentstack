import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LocalAuth, localCookie } from "../src/local-auth.js";
import { localBrowserResponse } from "../src/local-browser.js";

const origin = "http://127.0.0.1:8745";
function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "as-local-auth-"));
  const env = { STACK_STATE_DIR: root };
  const auth = new LocalAuth(env);
  t.after(() => { auth.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, env, auth };
}

test("single-use browser capabilities and HTTP authority rotate on startup; private stdio authority survives only until explicit revocation", t => {
  const { auth, env, root } = fixture(t);
  const bootstrap = auth.bootstrap(origin, "ui");
  assert.equal(statSync(join(root, "local-auth", "authority.sqlite3")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(root, "local-auth", "authority.sqlite3")).includes(Buffer.from(bootstrap)));
  assert.throws(() => auth.redeem(bootstrap, "http://localhost:8745", "ui"));
  assert.throws(() => auth.redeem(bootstrap, origin, "inspector"));
  const session = auth.redeem(bootstrap, origin, "ui");
  const secondProcess = new LocalAuth(env);
  try {
    assert.throws(() => secondProcess.redeem(bootstrap, origin, "ui"));
    const ticket = secondProcess.ticket(session.token, origin);
    assert.throws(() => auth.consumeTicket(ticket, "http://127.0.0.1:8746"));
    const admitted = auth.consumeTicket(ticket, origin);
    assert.throws(() => secondProcess.consumeTicket(ticket, origin));
    assert.equal(secondProcess.sessionDigest(admitted.digest, origin).digest, admitted.digest);
    const credential = auth.credential();
    const stdio = auth.credential("stdio");
    assert.equal(secondProcess.credential("stdio"), stdio, "opening another owner handle does not refresh a private launch");
    assert.notEqual(stdio, credential);
    assert.throws(() => auth.operator(`Bearer ${stdio}`));
    assert.throws(() => auth.operator(`Bearer ${credential}`, "stdio"));
    const pendingBootstrap = auth.bootstrap(origin, "ui");
    const pendingTicket = auth.ticket(session.token, origin);
    const inspector = auth.redeem(auth.bootstrap(origin, "inspector"), origin, "inspector");
    secondProcess.rotateForStartup();
    assert.throws(() => auth.operator(`Bearer ${credential}`));
    assert.throws(() => auth.sessionDigest(admitted.digest, origin));
    assert.throws(() => auth.session(session.token, origin, "ui"));
    assert.throws(() => auth.session(inspector.token, origin, "inspector"));
    assert.throws(() => auth.redeem(pendingBootstrap, origin, "ui"));
    assert.throws(() => auth.consumeTicket(pendingTicket, origin));
    assert.notEqual(auth.credential(), credential);
    assert.equal(auth.operator(`Bearer ${stdio}`, "stdio"), stdio);
    const currentHttp = auth.credential();
    const currentSession = auth.redeem(auth.bootstrap(origin, "ui"), origin, "ui");
    secondProcess.rotate();
    assert.throws(() => auth.operator(`Bearer ${stdio}`, "stdio"));
    assert.throws(() => auth.operator(`Bearer ${currentHttp}`));
    assert.throws(() => auth.session(currentSession.token, origin, "ui"));
    secondProcess.rotateForStartup();
    assert.throws(() => auth.operator(`Bearer ${stdio}`, "stdio"), "startup never restores a revoked private launch");
  } finally { secondProcess.close(); }
});

test("existing single-secret local authority upgrades in place without rotating HTTP credentials or browser capabilities", t => {
  const root = mkdtempSync(join(tmpdir(), "as-local-auth-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "local-auth");
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "authority.sqlite3");
  const legacy = new DatabaseSync(path);
  chmodSync(path, 0o600);
  const credential = "a".repeat(43), bootstrap = "b".repeat(43);
  try {
    legacy.exec("CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL); CREATE TABLE capabilities (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL, audience TEXT NOT NULL, parent TEXT, expires INTEGER NOT NULL);");
    legacy.prepare("INSERT INTO authority VALUES(1,?)").run(credential);
    legacy.prepare("INSERT INTO capabilities VALUES(?,?,?,?,?,?)").run(createHash("sha256").update(bootstrap).digest("hex"), "bootstrap", origin, "ui", null, Date.now() + 60_000);
  } finally { legacy.close(); }
  const env = { STACK_STATE_DIR: root }, auth = new LocalAuth(env);
  try {
    assert.equal(auth.operator(`Bearer ${credential}`), credential);
    const session = auth.redeem(bootstrap, origin, "ui");
    const stdio = auth.credential("stdio");
    assert.notEqual(stdio, credential);
    const reopened = new LocalAuth(env);
    try {
      assert.equal(reopened.operator(`Bearer ${stdio}`, "stdio"), stdio);
      assert.equal(reopened.session(session.token, origin, "ui").kind, "session");
    } finally { reopened.close(); }
  } finally { auth.close(); }
});

test("public browser bootstrap never issues authority without the private capability; CSRF, replay and logout are fenced", async t => {
  const { env, auth } = fixture(t);
  const request = (path: string, body: object, headers: Record<string, string> = {}) => new Request(`${origin}/connect/local${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const shell = await localBrowserResponse(new Request(`${origin}/connect/local`), env, "ui");
  assert.equal(shell.status, 200);
  assert.ok(!(await shell.text()).includes(auth.credential()));
  assert.equal(shell.headers.get("set-cookie"), null);
  assert.equal((await localBrowserResponse(request("/session", { token: "x".repeat(43) }), env, "ui")).status, 401);
  const token = auth.bootstrap(origin, "ui");
  assert.equal((await localBrowserResponse(request("/session", { token }, { origin: "http://evil.example" }), env, "ui")).status, 403);
  const connected = await localBrowserResponse(request("/session", { token }), env, "ui");
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.ok(!(await connected.text()).includes(localCookie(cookie, "ui")));
  assert.equal((await localBrowserResponse(request("/session", { token }), env, "ui")).status, 401);
  const issued = await localBrowserResponse(request("/ticket", {}, { cookie }), env, "ui");
  assert.equal(issued.status, 200);
  const ticket = (await issued.json() as { ticket: string }).ticket;
  const admitted = auth.consumeTicket(ticket, origin);
  assert.equal((await localBrowserResponse(request("/logout", {}, { cookie }), env, "ui")).status, 200);
  assert.throws(() => auth.sessionDigest(admitted.digest, origin));
});

test("Access backend assertions bind method, route and all remote authorization headers", t => {
  const { auth } = fixture(t);
  const args = ["GET", "/roles?focus=one", "https://tailnet.example:8945", "view", "ui:view"] as const;
  const proof = auth.signRemote(...args);
  auth.verifyRemote(proof, ...args);
  assert.throws(() => auth.verifyRemote(proof, "GET", "/roles?focus=two", args[2], args[3], args[4]));
  assert.throws(() => auth.verifyRemote(proof, args[0], args[1], args[2], "control", args[4]));
  auth.rotateForStartup();
  assert.throws(() => auth.verifyRemote(proof, ...args));
});

test("unsafe credential permissions fail closed", t => {
  const { root, env } = fixture(t);
  const path = join(root, "local-auth", "authority.sqlite3");
  chmodSync(path, 0o644);
  assert.throws(() => new LocalAuth(env), /authentication required/);
  chmodSync(path, 0o600);
});

test("expired bootstrap, tickets, sessions and internal assertions fail closed", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { auth } = fixture(t);
  const bootstrap = auth.bootstrap(origin, "ui");
  const session = auth.redeem(auth.bootstrap(origin, "ui"), origin, "ui");
  const ticket = auth.ticket(session.token, origin);
  const proof = auth.signRemote("GET", "/", "https://remote.example", "view", "ui:view");
  t.mock.timers.tick(30_001);
  assert.throws(() => auth.consumeTicket(ticket, origin));
  assert.throws(() => auth.verifyRemote(proof, "GET", "/", "https://remote.example", "view", "ui:view"));
  t.mock.timers.tick(30_000);
  assert.throws(() => auth.redeem(bootstrap, origin, "ui"));
  auth.session(session.token, origin, "ui");
  t.mock.timers.tick(8 * 60 * 60_000);
  assert.throws(() => auth.session(session.token, origin, "ui"));
  assert.throws(() => auth.ticket(session.token, origin));
});
