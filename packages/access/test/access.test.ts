import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { AccessStore } from "../src/store.js";
import { handler } from "../src/ingress.js";
import { verifier } from "../src/network.js";

const key = () => randomBytes(32).toString("base64url");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentstack-access-")); let now = Date.now();
  let store = new AccessStore(root, () => now);
  return { get store() { return store; }, root, advance(ms: number) { now += ms; },
    reopen() { store.close(); store = new AccessStore(root, () => now); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function pair(store: AccessStore) {
  const redemptionSecret = key();
  const input = { requestId: randomUUID(), label: "test", kind: "chrome", scopes: ["brain:share", "brain:status", "content:read"] as const, redemptionSecret };
  const request = store.pair({ ...input, scopes: [...input.scopes] });
  store.approve(request.id, request.code, true);
  const receipt = store.redeem(request.id, redemptionSecret);
  return { request, receipt, redemptionSecret };
}
test("pairing, redemption, persisted retry, refresh rotation, audience and revocation fences", () => {
  const f = fixture();
  try {
    const input = { requestId: randomUUID(), label: "phone", kind: "android", scopes: ["brain:share" as const], redemptionSecret: key() };
    const request = f.store.pair(input);
    assert.deepEqual(f.store.pair(input), request);
    assert.throws(() => f.store.pair({ ...input, label: "changed" }), /request_conflict/);
    assert.throws(() => f.store.redeem(request.id, input.redemptionSecret), /approval_pending/);
    assert.throws(() => f.store.approve(request.id, "wrong", true));
    f.store.approve(request.id, request.code, true);
    assert.throws(() => f.store.redeem(request.id, request.code));
    const receipt = f.store.redeem(request.id, input.redemptionSecret);
    f.reopen();
    assert.deepEqual(f.store.redeem(request.id, input.redemptionSecret), receipt);
    const retry = randomUUID();
    const token = f.store.refresh(receipt.refreshToken, retry, "brain");
    f.reopen();
    assert.deepEqual(f.store.refresh(receipt.refreshToken, retry, "brain"), token);
    assert.throws(() => f.store.refresh(receipt.refreshToken, randomUUID(), "brain"), /refresh_reused/);
    assert.equal(f.store.authorize(token.accessToken, "brain", "brain:share").clientId, receipt.clientId);
    assert.throws(() => f.store.authorize(token.accessToken, "content", "content:read"));
    assert.throws(() => f.store.authorize(token.accessToken, "brain", "brain:status"), /insufficient_scope/);
    f.store.revoke("credential", receipt.credentialId);
    assert.throws(() => f.store.authorize(token.accessToken, "brain", "brain:share"));
    assert.throws(() => f.store.refresh(token.refreshToken, randomUUID(), "brain"));
    assert.ok(!JSON.stringify(f.store.inventory()).includes(receipt.refreshToken));
    assert.ok(!readFileSync(join(f.root, "access", "access.db")).includes(Buffer.from(input.redemptionSecret)));
  } finally { f.close(); }
});
test("expiry, denial, independent credentials and resource-scoped one-use browser sessions", () => {
  const f = fixture();
  try {
    const first = pair(f.store), second = pair(f.store);
    const token = f.store.refresh(first.receipt.refreshToken, randomUUID(), "content");
    const principal = f.store.authorize(token.accessToken, "content", "content:read");
    const path = `/a/example/v/${"a".repeat(64)}/`;
    const handoff = f.store.handoff(principal, path, "artifacts");
    assert.throws(() => f.store.exchange(handoff.handoff, "documents"));
    const session = f.store.exchange(handoff.handoff, "artifacts");
    assert.throws(() => f.store.exchange(handoff.handoff, "artifacts"));
    f.store.session(session.session, "artifacts", `${path}index.html`);
    assert.throws(() => f.store.session(session.session, "artifacts", "/a/other/"));
    assert.throws(() => f.store.session(session.session, "documents", path));
    f.store.revoke("client", first.receipt.clientId);
    assert.throws(() => f.store.session(session.session, "artifacts", path));
    assert.ok(f.store.refresh(second.receipt.refreshToken, randomUUID(), "brain").accessToken);
    const pending = f.store.pair({ requestId: randomUUID(), label: "expire", kind: "browser", scopes: ["content:read"], redemptionSecret: key() });
    f.advance(600_001);
    assert.throws(() => f.store.approve(pending.id, pending.code, true), /expired/);
    assert.throws(() => f.store.authorize(token.accessToken, "content", "content:read"));
  } finally { f.close(); }
});
test("existing UIX grants and pairings migrate to UI scopes once", () => {
  const f = fixture();
  try {
    const redemptionSecret = key();
    const request = f.store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["ui:view", "ui:control"], redemptionSecret });
    f.store.approve(request.id, request.code, true);
    const grant = f.store.inventory().grants[0]!;
    const credential = f.store.redeem(request.id, redemptionSecret);
    f.store.db.exec("CREATE TABLE uix_sessions(hash TEXT PRIMARY KEY,credential_id TEXT NOT NULL,expires INTEGER NOT NULL)");
    f.store.db.prepare("INSERT INTO uix_sessions VALUES(?,?,?)").run("legacy-session", credential.credentialId, Date.now() + 60_000);
    f.store.db.prepare("UPDATE pairings SET scopes=? WHERE id=?").run('["uix:view","uix:control"]', request.id);
    f.store.db.prepare("UPDATE grants SET scopes=? WHERE id=?").run('["uix:view","uix:control"]', grant.id);
    f.reopen();
    assert.deepEqual(f.store.inventory().pairings[0]?.scopes, ["ui:view", "ui:control"]);
    assert.deepEqual(f.store.inventory().grants[0]?.scopes, ["ui:view", "ui:control"]);
    assert.equal(f.store.inventory().grants[0]?.revision, 2);
    assert.equal(f.store.db.prepare("SELECT credential_id FROM ui_sessions WHERE hash='legacy-session'").get()?.credential_id, credential.credentialId);
    assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='uix_sessions'").get(), undefined);
    f.reopen();
    assert.equal(f.store.inventory().grants[0]?.revision, 2);
  } finally { f.close(); }
});
test("direct peer provenance rejects proxies, spoofed addresses, stopped tailscaled and unknown peers", async () => {
  const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1234 };
  const verify = verifier("unused", async args => args[0] === "status" ? { BackendState: "Running", Self: { Online: true }, TailscaleIPs: [peer.localAddress] } : { Node: { ID: 42, Addresses: [`${peer.remoteAddress}/32`] } });
  await verify(peer);
  await assert.rejects(verify({ ...peer, remoteAddress: "127.0.0.1" }));
  await assert.rejects(verify({ ...peer, localAddress: "192.168.1.1" }));
  await assert.rejects(verify({ ...peer, remoteAddress: "100.80.0.3" }));
  await assert.rejects(verifier("unused", async () => ({ BackendState: "Stopped" }))(peer));
});

test("grant revisions extend and restrict existing tokens; public-cloud evaluation is explicit and network-bound", () => {
  const f = fixture();
  try {
    const secret = key();
    const request = f.store.pair({ requestId: randomUUID(), label: "subset", kind: "android", scopes: ["brain:share", "content:read"], redemptionSecret: secret });
    f.store.approve(request.id, request.code, true, ["brain:share"]);
    assert.throws(() => f.store.approve(request.id, request.code, true, ["content:read"]), /approval_conflict/);
    const credential = f.store.redeem(request.id, secret);
    const token = f.store.refresh(credential.refreshToken, randomUUID(), "content");
    const grant = f.store.inventory().grants[0]!;
    assert.deepEqual(grant.scopes, ["brain:share"]);
    assert.throws(() => f.store.authorize(token.accessToken, "content", "content:read"));
    f.store.updateGrant(grant.id, 1, ["brain:share", "content:read"], []);
    assert.equal(f.store.authorize(token.accessToken, "content", "content:read").kind, "android");
    assert.throws(() => f.store.updateGrant(grant.id, 1, [], []), /revision_conflict/);
    const serverId = f.store.serverId; f.reopen(); assert.equal(f.store.serverId, serverId);
    const cloud = f.store.cloudGrant("connector", ["content.document_get"]);
    assert.equal(f.store.evaluateOperation(cloud.id, "public-cloud", "content.document_get").allowed, true);
    assert.equal(f.store.evaluateOperation(cloud.id, "tailnet", "content.document_get").allowed, false);
    assert.equal(f.store.evaluateOperation(grant.id, "public-cloud", "content.document_get").allowed, false);
    assert.equal(f.store.evaluateOperation(cloud.id, "public-cloud", "content.document_delete").allowed, false);
    f.store.updateGrant(cloud.id, 1, [], []);
    assert.equal(f.store.evaluateOperation(cloud.id, "public-cloud", "content.document_get").allowed, false);
    f.store.revoke("client", cloud.clientId);
    assert.equal(f.store.evaluateOperation(cloud.id, "public-cloud", "content.document_get").allowed, false);
  } finally { f.close(); }
});

test("refresh recovery never resurrects expired access or a superseded generation", () => {
  const f = fixture();
  try {
    const client = pair(f.store);
    const id = randomUUID();
    const first = f.store.refresh(client.receipt.refreshToken, id, "brain");
    f.store.refresh(first.refreshToken, randomUUID(), "content");
    assert.throws(() => f.store.refresh(client.receipt.refreshToken, id, "brain"), /superseded/);
    f.advance(300_001);
    assert.throws(() => f.store.authorize(first.accessToken, "brain", "brain:share"));
    // Expired recovery hashes are pruned; they remain invalid, not renewable.
    assert.throws(() => f.store.refresh(client.receipt.refreshToken, id, "brain"), /unauthorized/);
  } finally { f.close(); }
});
test("server identity fences admission and credential exchange before any side effect", async () => {
  const f = fixture();
  try {
    let admissions = 0;
    const serve = handler({ store: f.store, env: {}, origin: "documents", verify: async () => {},
      call: async () => { admissions++; return { job_id: 1 }; } });
    const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1234 };
    const identity = await serve(new Request("https://test/v1/access/identity"), peer);
    assert.equal((await identity.json()).data.serverId, f.store.serverId);
    const client = pair(f.store);
    const token = f.store.refresh(client.receipt.refreshToken, randomUUID(), "brain");
    const send = (path: string, serverId: string, payload: unknown) => serve(new Request(`https://test${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/json", "x-agentstack-server-id": serverId },
      body: JSON.stringify(payload),
    }), peer);
    assert.equal((await send("/v1/share", randomUUID(), {})).status, 409);
    assert.equal((await send("/v1/access/refresh", randomUUID(), { refreshToken: token.refreshToken, requestId: randomUUID(), audience: "brain" })).status, 409);
    assert.equal(admissions, 0);
    assert.equal((await send("/v1/share", f.store.serverId, {})).status, 200);
    assert.equal(admissions, 1);
  } finally { f.close(); }
});
test("ingress checks network on every route; duplicate admissions confer independent own-job receipts", async () => {
  const f = fixture();
  try {
    let online = true, networkChecks = 0;
    const calls: any[] = [];
    const serve = handler({ store: f.store, env: {}, origin: "documents", verify: async () => { networkChecks++; if (!online) throw new Error("offline"); },
      call: async (_pkg, name, args: any) => { calls.push([name, args]); return name === "share_receive" ? { status: "duplicate", job_id: 7 } : { shares: args.ids }; } });
    const one = pair(f.store), two = pair(f.store), outsider = pair(f.store);
    const tokens = [one, two, outsider].map(p => f.store.refresh(p.receipt.refreshToken, randomUUID(), "brain").accessToken);
    const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1 };
    const req = (path: string, token: string, post = false) => new Request(`https://test${path}`, { method: post ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-agentstack-server-id": f.store.serverId }, ...(post ? { body: "{}" } : {}) });
    for (const token of tokens.slice(0, 2)) assert.equal((await serve(req("/v1/share", token!, true), peer)).status, 200);
    for (const token of tokens.slice(0, 2)) assert.deepEqual((await (await serve(req("/v1/shares?job_ids=7,8", token!), peer)).json()).data.shares, [7]);
    assert.deepEqual((await (await serve(req("/v1/shares?job_ids=7", tokens[2]!), peer)).json()).data.shares, []);
    online = false;
    assert.notEqual((await serve(req("/v1/share", tokens[0]!, true), peer)).status, 200);
    assert.notEqual((await serve(req("/v1/access/pair", "", true), peer)).status, 200);
    assert.notEqual((await serve(req("/v1/health", tokens[0]!), peer)).status, 200);
    assert.equal(networkChecks, 8);
    assert.equal(calls.filter(call => call[0] === "share_receive").length, 2);
    assert.equal(calls[0][1].payload.client, "chrome-extension");
  } finally { f.close(); }
});
