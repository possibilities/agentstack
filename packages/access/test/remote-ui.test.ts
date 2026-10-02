import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { AccessStore } from "../src/store.js";
import { remoteUiHandler } from "../src/remote-ui.js";

const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1234 };
const origin = "https://100.80.0.1:8945";
const secret = () => randomBytes(32).toString("base64url");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stack-remote-ui-")); let now = Date.now(), online = true, checks = 0;
  const store = new AccessStore(root, () => now);
  const serve = remoteUiHandler({ store, env: {}, host: "100.80.0.1", port: 8945,
    verify: async () => { checks++; if (!online) throw new Error("not on tailnet"); },
    fetchBackend: async () => new Response("safe page", { headers: { "content-type": "text/html", "set-cookie": "bad=1" } }) });
  const send = (path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) =>
    serve(new Request(`${origin}${path}`, { method, headers: { host: "100.80.0.1:8945", ...(method === "POST" ? { origin, "content-type": "application/json", "x-stack-server-id": store.serverId } : {}), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), peer);
  return { root, store, send, get checks() { return checks; }, set online(value: boolean) { online = value; },
    advance(ms: number) { now += ms; }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("browser pairing is locally approved, session cookies are scoped, and HTTP is origin/provenance-fenced", async () => {
  const f = fixture();
  try {
    assert.equal((await f.send("/")).status, 401);
    assert.equal((await f.send("/connect")).status, 200);
    assert.equal((await f.send("/connect/pair", "POST", {}, { origin: "https://evil.example" })).status, 403);
    const redemptionSecret = secret();
    const input = { requestId: randomUUID(), redemptionSecret, label: "Browser", kind: "browser", scopes: ["ui:view", "content:read"] };
    const pairing = (await (await f.send("/connect/pair", "POST", input)).json()).data;
    assert.equal((await f.send("/connect/redeem", "POST", { id: pairing.id, redemptionSecret })).status, 409);
    f.store.approve(pairing.id, pairing.code, true);
    const credential = (await (await f.send("/connect/redeem", "POST", { id: pairing.id, redemptionSecret })).json()).data;
    assert.equal((await f.send("/connect/session", "POST", { refreshToken: credential.refreshToken, requestId: randomUUID() }, { "x-stack-server-id": randomUUID() })).status, 409);
    const session = await f.send("/connect/session", "POST", { refreshToken: credential.refreshToken, requestId: randomUUID() });
    assert.equal(session.status, 200);
    const cookies = session.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.every(value => /Path=\/; Secure; HttpOnly; SameSite=Strict/.test(value)));
    const auth = cookies[0]!.split(";")[0]!;
    const page = await f.send("/content", "GET", undefined, { cookie: auth });
    assert.equal(page.status, 200);
    assert.equal((await f.send("/", "GET", undefined, { cookie: auth })).status, 200);
    assert.equal((await f.send("/fleet", "GET", undefined, { cookie: auth })).status, 200);
    assert.equal((await f.send("/source", "GET", undefined, { cookie: auth })).status, 200);
    assert.equal((await f.send("/source/x", "GET", undefined, { cookie: auth })).status, 404);
    assert.equal((await f.send("/fleet/x", "GET", undefined, { cookie: auth })).status, 404);
    assert.equal((await f.send("/x", "GET", undefined, { cookie: auth })).status, 404);
    assert.equal((await f.send("/x/content", "GET", undefined, { cookie: auth })).status, 404);
    assert.equal((await f.send("/hud", "GET", undefined, { cookie: auth })).status, 404);
    assert.equal(page.headers.get("set-cookie"), null);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'nonce-/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal((await f.send("/", "GET", undefined, { cookie: auth, origin: "https://evil.example" })).status, 403);
    assert.equal((await f.send("/", "GET", undefined, { cookie: auth, "x-forwarded-for": peer.remoteAddress })).status, 403);
    assert.equal((await f.send("/", "POST", {}, { cookie: auth })).status, 404);
    assert.equal((await f.send("/v1/content/handoff", "POST", { path: "/d/doc", origin: "documents" }, { cookie: auth, origin: "https://evil.example" })).status, 403);
    const handoff = (await (await f.send("/v1/content/handoff", "POST", { path: "/d/doc", origin: "documents" }, { cookie: auth })).json()).data;
    assert.ok(handoff.handoff);
    assert.throws(() => f.store.exchange(handoff.handoff, "artifacts"), /unauthorized/);
    const exchanged = f.store.exchange(handoff.handoff, "documents");
    assert.equal(exchanged.path, "/d/doc");
    f.store.session(exchanged.session, "documents", "/d/doc");
    assert.throws(() => f.store.session(exchanged.session, "documents", "/d/another"), /unauthorized/);
    assert.throws(() => f.store.exchange(handoff.handoff, "documents"), /unauthorized/);
    assert.equal((await f.send("/v1/content/handoff", "POST", { path: "/d/other%2Fdoc", origin: "documents" }, { cookie: auth })).status, 400);
    f.store.updateGrant(f.store.inventory().grants[0]!.id, 1, ["ui:view"], []);
    assert.equal((await f.send("/v1/content/handoff", "POST", { path: "/d/doc", origin: "documents" }, { cookie: auth })).status, 403);
    assert.equal((await f.send("/", "GET", undefined, { cookie: auth })).status, 200);
    f.store.revoke("credential", credential.credentialId);
    assert.equal((await f.send("/", "GET", undefined, { cookie: auth })).status, 401);
    f.online = false;
    assert.equal((await f.send("/connect")).status, 503);
    assert.ok(f.checks >= 14);
  } finally { f.close(); }
});

test("view grant cannot establish a UI session without browser kind, ui:view, or a live grant", async () => {
  const f = fixture();
  try {
    for (const [kind, scopes] of [["chrome", ["ui:view"]], ["browser", ["content:read"]]] as const) {
      const redemptionSecret = secret();
      const pair = f.store.pair({ requestId: randomUUID(), label: kind, kind, scopes: [...scopes], redemptionSecret });
      f.store.approve(pair.id, pair.code, true);
      const receipt = f.store.redeem(pair.id, redemptionSecret);
      assert.equal((await f.send("/connect/session", "POST", { refreshToken: receipt.refreshToken, requestId: randomUUID() })).status, 403);
    }
  } finally { f.close(); }
});

test("the configured certificate hostname is accepted without treating its DNS name as tailnet provenance", async () => {
  const f = fixture();
  try {
    const serve = remoteUiHandler({ store: f.store, env: { STACK_ACCESS_UI_ORIGIN: "https://machine.ts.net:8945" }, host: "100.80.0.1", port: 8945,
      verify: async actual => { assert.deepEqual(actual, peer); } });
    const good = await serve(new Request("https://100.80.0.1:8945/connect/identity", { headers: { host: "machine.ts.net:8945" } }), peer);
    assert.equal(good.status, 200);
    assert.equal((await good.json()).data.serverId, f.store.serverId);
    assert.equal((await serve(new Request("https://100.80.0.1:8945/connect/identity", { headers: { host: "evil.example:8945" } }), peer)).status, 403);
  } finally { f.close(); }
});

test("each client, grant and credential revocation independently fences a live UI HTTP cookie", async () => {
  const f = fixture();
  try {
    for (const kind of ["client", "grant", "credential"] as const) {
      const redemptionSecret = secret();
      const pairing = f.store.pair({ requestId: randomUUID(), label: kind, kind: "browser", scopes: ["ui:view"], redemptionSecret });
      f.store.approve(pairing.id, pairing.code, true);
      const credential = f.store.redeem(pairing.id, redemptionSecret);
      const issued = f.store.startUi(credential.refreshToken, randomUUID());
      const cookie = `__Host-stack_ui=${issued.accessToken}`;
      assert.equal((await f.send("/", "GET", undefined, { cookie })).status, 200);
      const grant = f.store.inventory().grants.find(row => row.client_id === credential.clientId)!;
      f.store.revoke(kind, kind === "client" ? credential.clientId : kind === "grant" ? grant.id : credential.credentialId);
      assert.equal((await f.send("/", "GET", undefined, { cookie })).status, 401);
      assert.equal((await f.send("/connect/refresh", "POST", {}, { cookie: `__Host-stack_ui_refresh=${issued.refreshToken}` })).status, 401);
    }
  } finally { f.close(); }
});
