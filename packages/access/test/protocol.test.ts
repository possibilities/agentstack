import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { serveHttp, type HttpPeer } from "@agentstack/api";
import { AccessStore } from "../src/store.js";
import { handler } from "../src/ingress.js";
import { snapshotSchema } from "../src/schema.js";

const key = () => randomBytes(32).toString("base64url");
const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentstack-access-protocol-"));
  let now = Date.now();
  const store = new AccessStore(root, () => now);
  return { root, store, advance(ms: number) { now += ms; }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function pair(store: AccessStore) {
  const redemptionSecret = key();
  const request = store.pair({ requestId: randomUUID(), label: "test", kind: "chrome", scopes: ["brain:share", "content:read"], redemptionSecret });
  store.approve(request.id, request.code, true);
  return store.redeem(request.id, redemptionSecret);
}

test("identity fences admission and rotation; me and disconnect need no data scope", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const serve = handler({ store: f.store, env: {}, origin: "documents", verify: async () => {}, call: async () => { calls++; } });
    const receipt = pair(f.store);
    const token = f.store.refresh(receipt.refreshToken, randomUUID(), "brain");
    const principal = f.store.authorize(token.accessToken, "brain");
    f.store.updateGrant(principal.grantId, 1, [], []);
    const request = (path: string, identity: string | null, payload?: unknown) => new Request(`https://test${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/json", ...(identity ? { "x-agentstack-server-id": identity } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    for (const identity of [null, randomUUID()]) {
      assert.equal((await serve(request("/v1/share", identity, {}), peer)).status, 409);
      assert.equal((await serve(request("/v1/access/refresh", identity, { refreshToken: token.refreshToken, requestId: randomUUID(), audience: "brain" }), peer)).status, 409);
    }
    assert.equal(calls, 0);
    assert.equal(f.store.inventory().credentials[0]!.generation, 1);
    const me = await serve(request("/v1/access/me", f.store.serverId), peer);
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).data, { serverId: f.store.serverId, clientId: receipt.clientId, credentialId: receipt.credentialId, scopes: [] });
    const preflight = await serve(new Request("https://test/v1/access/me", { method: "OPTIONS", headers: { origin: `chrome-extension://${"a".repeat(32)}` } }), peer);
    assert.match(preflight.headers.get("access-control-allow-headers")!, /x-agentstack-server-id/);
    for (const header of ["forwarded", "x-forwarded-for", "tailscale-user-login"]) {
      const spoof = request("/v1/access/me", f.store.serverId);
      spoof.headers.set(header, "100.80.0.2");
      assert.equal((await serve(spoof, peer)).status, 403);
    }
    assert.equal((await serve(request("/v1/access/disconnect", f.store.serverId, {}), peer)).status, 200);
    assert.equal((await serve(request("/v1/access/me", f.store.serverId), peer)).status, 401);
    const snapshot = snapshotSchema.parse({ ...f.store.inventory(), ingress: null });
    assert.equal(snapshot.serverId, receipt.serverId);
    assert.deepEqual(snapshot.grants[0]!.scopes, []);
    assert.equal(snapshot.grants[0]!.revision, 2);
  } finally { f.close(); }
});

test("narrowing fences outstanding Content handoffs and established browser sessions", () => {
  const f = fixture();
  try {
    const receipt = pair(f.store);
    const token = f.store.refresh(receipt.refreshToken, randomUUID(), "content");
    const principal = f.store.authorize(token.accessToken, "content", "content:read");
    const session = f.store.exchange(f.store.handoff(principal, "/d/test", "documents").handoff, "documents");
    const pending = f.store.handoff(principal, "/d/test", "documents");
    f.store.updateGrant(principal.grantId, 1, ["brain:share"], []);
    assert.throws(() => f.store.session(session.session, "documents", "/d/test"), /insufficient_scope/);
    assert.throws(() => f.store.exchange(pending.handoff, "documents"), /insufficient_scope/);
    assert.throws(() => f.store.authorize(token.accessToken, "content", "content:read"), /insufficient_scope/);
  } finally { f.close(); }
});

test("successful transitions collect abandoned expired requests and token material", () => {
  const f = fixture();
  try {
    const receipt = pair(f.store);
    const token = f.store.refresh(receipt.refreshToken, randomUUID(), "content");
    const principal = f.store.authorize(token.accessToken, "content", "content:read");
    f.store.exchange(f.store.handoff(principal, "/d/test", "documents").handoff, "documents");
    f.advance(900_001);
    pair(f.store);
    for (const table of ["tokens", "refreshes", "handoffs", "sessions"]) {
      assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0, table);
    }
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM pairings").get()!.n, 1);
  } finally { f.close(); }
});

test("real TLS listener passes kernel peers and ignores spoofed network headers", async () => {
  const f = fixture();
  let server: Awaited<ReturnType<typeof serveHttp>> | undefined;
  try {
    const cert = join(f.root, "cert.pem"), privateKey = join(f.root, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    let observed: HttpPeer | undefined;
    let observedUrl = "";
    // The production verifier must reject this real loopback connection before
    // invoking tailscale, even if every HTTP header claims a tailnet address.
    const ingress = handler({ store: f.store, env: { AGENTSTACK_TAILSCALE_BIN: "/nonexistent-test-only" }, origin: "documents" });
    server = await serveHttp({ host: "127.0.0.1", port: 0, tls: { key: readFileSync(privateKey), cert: readFileSync(cert) }, forceCloseConnections: true,
      handle(request, actualPeer) { observed = actualPeer; observedUrl = request.url; return ingress(request, actualPeer); } });
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest({ hostname: "127.0.0.1", port: server!.port, path: "/v1/access/pair", method: "POST", rejectUnauthorized: false,
        headers: { "content-type": "application/json", "x-forwarded-for": "100.80.0.2", forwarded: "for=100.80.0.2", "x-forwarded-proto": "https" } }, response => {
        let body = "";
        response.setEncoding("utf8").on("data", chunk => { body += chunk; }).on("end", () => resolve({ status: response.statusCode!, body }));
      });
      request.on("error", reject);
      request.end("{}");
    });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error.code, "tailnet_required");
    assert.equal(observed!.remoteAddress, "127.0.0.1");
    assert.equal(observed!.localAddress, "127.0.0.1");
    assert.ok(observed!.remotePort > 0);
    assert.match(observedUrl, /^https:\/\//);
    assert.equal(f.store.inventory().pairings.length, 0);
  } finally { await server?.close(); f.close(); }
});
