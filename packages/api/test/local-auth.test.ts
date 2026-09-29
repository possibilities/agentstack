import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LocalAuth, localCookie } from "../src/local-auth.js";
import { localBrowserResponse } from "../src/local-browser.js";

const origin = "http://127.0.0.1:8745";
function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "as-local-auth-"));
  const env = { AGENTSTACK_STATE_DIR: root };
  const auth = new LocalAuth(env);
  t.after(() => { auth.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, env, auth };
}

test("single-use bootstrap and tickets bind exact origins/audiences and survive only the current authority generation", t => {
  const { auth, env, root } = fixture(t);
  const bootstrap = auth.bootstrap(origin, "uix");
  assert.equal(statSync(join(root, "local-auth", "authority.sqlite3")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(root, "local-auth", "authority.sqlite3")).includes(Buffer.from(bootstrap)));
  assert.throws(() => auth.redeem(bootstrap, "http://localhost:8745", "uix"));
  assert.throws(() => auth.redeem(bootstrap, origin, "inspector"));
  const session = auth.redeem(bootstrap, origin, "uix");
  const secondProcess = new LocalAuth(env);
  try {
    assert.throws(() => secondProcess.redeem(bootstrap, origin, "uix"));
    const ticket = secondProcess.ticket(session.token, origin);
    assert.throws(() => auth.consumeTicket(ticket, "http://127.0.0.1:8746"));
    const admitted = auth.consumeTicket(ticket, origin);
    assert.throws(() => secondProcess.consumeTicket(ticket, origin));
    assert.equal(secondProcess.sessionDigest(admitted.digest, origin).digest, admitted.digest);
    const credential = auth.credential();
    secondProcess.rotate();
    assert.throws(() => auth.operator(`Bearer ${credential}`));
    assert.throws(() => auth.sessionDigest(admitted.digest, origin));
    assert.throws(() => auth.session(session.token, origin, "uix"));
    assert.notEqual(auth.credential(), credential);
  } finally { secondProcess.close(); }
});

test("public browser bootstrap never issues authority without the private capability; CSRF, replay and logout are fenced", async t => {
  const { env, auth } = fixture(t);
  const request = (path: string, body: object, headers: Record<string, string> = {}) => new Request(`${origin}/connect/local${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const shell = await localBrowserResponse(new Request(`${origin}/connect/local`), env, "uix");
  assert.equal(shell.status, 200);
  assert.ok(!(await shell.text()).includes(auth.credential()));
  assert.equal(shell.headers.get("set-cookie"), null);
  assert.equal((await localBrowserResponse(request("/session", { token: "x".repeat(43) }), env, "uix")).status, 401);
  const token = auth.bootstrap(origin, "uix");
  assert.equal((await localBrowserResponse(request("/session", { token }, { origin: "http://evil.example" }), env, "uix")).status, 403);
  const connected = await localBrowserResponse(request("/session", { token }), env, "uix");
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.ok(!(await connected.text()).includes(localCookie(cookie, "uix")));
  assert.equal((await localBrowserResponse(request("/session", { token }), env, "uix")).status, 401);
  const issued = await localBrowserResponse(request("/ticket", {}, { cookie }), env, "uix");
  assert.equal(issued.status, 200);
  const ticket = (await issued.json() as { ticket: string }).ticket;
  const admitted = auth.consumeTicket(ticket, origin);
  assert.equal((await localBrowserResponse(request("/logout", {}, { cookie }), env, "uix")).status, 200);
  assert.throws(() => auth.sessionDigest(admitted.digest, origin));
});

test("Access backend assertions bind method, route and all remote authorization headers", t => {
  const { auth } = fixture(t);
  const args = ["GET", "/x/roles?focus=one", "https://tailnet.example:8945", "view", "uix:view"] as const;
  const proof = auth.signRemote(...args);
  auth.verifyRemote(proof, ...args);
  assert.throws(() => auth.verifyRemote(proof, "GET", "/x/roles?focus=two", args[2], args[3], args[4]));
  assert.throws(() => auth.verifyRemote(proof, args[0], args[1], args[2], "control", args[4]));
  auth.rotate();
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
  const bootstrap = auth.bootstrap(origin, "uix");
  const session = auth.redeem(auth.bootstrap(origin, "uix"), origin, "uix");
  const ticket = auth.ticket(session.token, origin);
  const proof = auth.signRemote("GET", "/x", "https://remote.example", "view", "uix:view");
  t.mock.timers.tick(30_001);
  assert.throws(() => auth.consumeTicket(ticket, origin));
  assert.throws(() => auth.verifyRemote(proof, "GET", "/x", "https://remote.example", "view", "uix:view"));
  t.mock.timers.tick(30_000);
  assert.throws(() => auth.redeem(bootstrap, origin, "uix"));
  auth.session(session.token, origin, "uix");
  t.mock.timers.tick(8 * 60 * 60_000);
  assert.throws(() => auth.session(session.token, origin, "uix"));
  assert.throws(() => auth.ticket(session.token, origin));
});
