import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { serveHttp } from "@agentstack/api";
import { AccessStore } from "../src/store.js";
import { handler } from "../src/ingress.js";

test("actual TLS propagates kernel peers and fences scoped artifact views and document cookies", async () => {
  const root = mkdtempSync(join(tmpdir(), "access-tls-"));
  const store = new AccessStore(root);
  const cert = join(root, "cert.pem"), key = join(root, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
  const backend = await serveHttp({ host: "127.0.0.1", port: 0, handle: () => new Response("<script>window.test=1</script>", { headers: { "content-type": "text/html" } }) });
  const peers: unknown[] = [];
  let permit = true;
  const ingress = await serveHttp({ host: "127.0.0.1", port: 0, tls, forceCloseConnections: true, handle: handler({ store,
    env: { AGENTSTACK_CONTENT_ARTIFACT_PORT: String(backend.port) }, origin: "artifacts",
    verify: async peer => { peers.push(peer); if (!permit) throw new Error("tailnet unavailable"); } }) });
  const strict = await serveHttp({ host: "127.0.0.1", port: 0, tls, forceCloseConnections: true, handle: handler({ store, env: {}, origin: "documents" }) });
  const documents = await serveHttp({ host: "127.0.0.1", port: 0, tls, forceCloseConnections: true, handle: handler({ store, env: { AGENTSTACK_CONTENT_PORT: String(backend.port) }, origin: "documents", verify: async () => {} }) });
  const send = (port: number, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; headers: any; body: string }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, rejectUnauthorized: false, method: body ? "POST" : "GET", headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: text }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const denied = await send(strict.port, "/v1/access/identity", { "x-forwarded-for": "100.90.0.2", "tailscale-user-login": "operator", host: "test.ts.net" });
    assert.equal(denied.status, 403);
    const redemptionSecret = randomBytes(32).toString("base64url");
    const pair = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["content:read"], redemptionSecret });
    store.approve(pair.id, pair.code, true);
    const credential = store.redeem(pair.id, redemptionSecret);
    const token = store.refresh(credential.refreshToken, randomUUID(), "content");
    const principal = store.authorize(token.accessToken, "content", "content:read");
    const path = `/a/example/v/${"a".repeat(64)}/`;
    const handoff = store.handoff(principal, path, "artifacts");
    const exchanged = await send(ingress.port, "/session", {}, { handoff: handoff.handoff });
    assert.equal(exchanged.status, 200);
    const view = JSON.parse(exchanged.body).data.path;
    assert.equal(exchanged.headers["set-cookie"], undefined);
    assert.equal((await send(ingress.port, "/session", {}, { handoff: handoff.handoff })).status, 401);
    const content = await send(ingress.port, `${view}index.html`);
    assert.equal(content.status, 200);
    assert.match(content.headers["content-security-policy"], /sandbox allow-scripts/);
    assert.ok(!content.headers["content-security-policy"].includes("allow-same-origin"));
    assert.equal(content.headers["cache-control"], "no-store");
    assert.equal((await send(ingress.port, view.replace(path, "/a/other/"))).status, 401);
    const document = store.handoff(principal, "/d/test", "documents");
    const documentSession = await send(documents.port, "/session", {}, { handoff: document.handoff });
    assert.match(documentSession.headers["set-cookie"][0], /HttpOnly; Secure; SameSite=Strict/);
    const cookie = documentSession.headers["set-cookie"][0].split(";")[0];
    assert.equal((await send(documents.port, "/d/test", { cookie })).status, 200);
    assert.equal((await send(documents.port, "/d/other", { cookie })).status, 401);
    const unused = store.handoff(principal, path, "artifacts");
    store.updateGrant(principal.grantId, 1, [], []);
    assert.equal((await send(ingress.port, view)).status, 403);
    assert.equal((await send(documents.port, "/d/test", { cookie })).status, 401);
    assert.equal((await send(ingress.port, "/session", {}, { handoff: unused.handoff })).status, 403);
    store.updateGrant(principal.grantId, 2, ["content:read"], []);
    assert.equal((await send(ingress.port, view)).status, 200);
    permit = false;
    assert.equal((await send(ingress.port, view)).status, 503);
    permit = true;
    store.revoke("credential", credential.credentialId);
    assert.equal((await send(ingress.port, view)).status, 401);
    assert.ok(peers.every((peer: any) => peer.localAddress === "127.0.0.1" && peer.remoteAddress === "127.0.0.1" && peer.remotePort > 0));
  } finally { await Promise.all([ingress.close(), strict.close(), documents.close(), backend.close()]); store.close(); rmSync(root, { recursive: true, force: true }); }
});
