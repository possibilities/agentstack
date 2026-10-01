import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AccessStore } from "../src/store.js";
import { handler } from "../src/ingress.js";
import { remoteUiHandler } from "../src/remote-ui.js";
import { createManualPairingIntent, inspectConnection, requestManualPairing, redeemManualPairing, refreshConnection, openRemoteUi } from "../src/connection-client.js";

const origin = "https://stack.tail.example:8943", uiOrigin = "https://stack.tail.example:8945";
const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1234 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stack-connection-"));
  let offset = 0, permitted = true;
  const store = new AccessStore(root, () => Date.now() + offset);
  const env = { STACK_ACCESS_HOST: peer.localAddress, STACK_ACCESS_ORIGIN: origin, STACK_ACCESS_UI_ORIGIN: uiOrigin };
  const verify = async () => { if (!permitted) throw new Error("tailnet unavailable"); };
  const device = handler({ store, env, origin: "documents", verify });
  const ui = remoteUiHandler({ store, env, host: peer.localAddress, port: 8945, verify, fetchBackend: async () => new Response("bench") });
  const send: typeof fetch = async (url, init) => {
    const request = new Request(url, init); request.headers.set("host", new URL(request.url).host);
    return device(request, peer);
  };
  const view = (path: string, data?: unknown, cookie?: string, origin = uiOrigin) => ui(new Request(`${uiOrigin}${path}`, {
    method: data === undefined ? "GET" : "POST", headers: { host: new URL(uiOrigin).host, origin, ...(cookie ? { cookie } : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), peer);
  return { root, store, send, view, device, advance(ms: number) { offset += ms; }, set permitted(value: boolean) { permitted = value; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

// Owning HTTP/client boundary: new desktop UI admission and independent viewer rotation.
// Existing browser/QR tests cannot detect consumption of the host's retained credential.
test("manual desktop pairing recovers lost admission and opens an independent, live-fenced WebView session", async () => {
  const f = fixture();
  try {
    const descriptor = await inspectConnection(origin, f.send);
    assert.equal(descriptor.serverId, f.store.serverId);
    assert.equal(descriptor.uiOrigin, uiOrigin);
    const intent = createManualPairingIntent("Laptop", ["ui:view", "ui:control"]);
    const lost: typeof fetch = async (url, init) => {
      const response = await f.send(url, init);
      if (new URL(String(url)).pathname === "/v1/access/pair") throw new Error("lost acknowledgement");
      return response;
    };
    await assert.rejects(requestManualPairing(descriptor, intent, lost), /lost acknowledgement/);
    const pairing = await requestManualPairing(descriptor, intent, f.send);
    assert.equal(f.store.inventory().pairings.length, 1);
    await assert.rejects(redeemManualPairing(descriptor, pairing.id, intent, f.send), /approval_pending/);
    f.store.approve(pairing.id, pairing.code, true);
    const credential = await redeemManualPairing(descriptor, pairing.id, intent, f.send);
    assert.deepEqual(await redeemManualPairing(descriptor, pairing.id, intent, f.send), credential);
    // A desktop must never be admitted through the legacy credential-cookie exchange.
    assert.throws(() => f.store.startUi(credential.refreshToken, randomUUID()), /browser_required/);
    const native = await refreshConnection(descriptor, { refreshToken: credential.refreshToken, requestId: randomUUID(), audience: "ui" }, f.send);
    const requestId = randomUUID();
    const handoff = await openRemoteUi(descriptor, native.accessToken, requestId, f.send);
    assert.deepEqual(await openRemoteUi(descriptor, native.accessToken, requestId, f.send), handoff);
    assert.ok(!handoff.url.includes(native.refreshToken));
    const secret = new URL(handoff.url).hash.slice(1);
    assert.equal((await f.view("/connect/device", { handoff: secret }, undefined, "https://other.example")).status, 403);
    const response = await f.view("/connect/device", { handoff: secret });
    assert.equal(response.status, 200);
    assert.equal((await f.view("/connect/device", { handoff: secret })).status, 401);
    const cookies = response.headers.getSetCookie().filter(value => !value.includes("Max-Age=0"));
    assert.ok(cookies.every(value => /Secure; HttpOnly; SameSite=Strict/.test(value)));
    const auth = cookies[0]!.split(";")[0]!, viewer = cookies[1]!.split(";")[0]!;
    assert.equal((await f.view("/", undefined, auth)).status, 200);
    f.advance(290_000);
    const renewed = await f.view("/connect/refresh", {}, viewer);
    assert.equal(renewed.status, 200);
    assert.deepEqual((await f.view("/connect/refresh", {}, viewer)).headers.getSetCookie(), renewed.headers.getSetCookie());
    // WebView renewal did not consume or supersede the saved native rotation.
    const later = await refreshConnection(descriptor, { refreshToken: native.refreshToken, requestId: randomUUID(), audience: "ui" }, f.send);
    assert.equal(later.credentialId, credential.credentialId);
    const currentAuth = renewed.headers.getSetCookie()[0]!.split(";")[0]!;
    const grant = f.store.inventory().grants[0]!;
    f.store.updateGrant(grant.id, grant.revision, [], []);
    assert.equal((await f.view("/", undefined, currentAuth)).status, 403);
    assert.equal((await f.view("/connect/refresh", {}, renewed.headers.getSetCookie()[1]!.split(";")[0]!)).status, 403);
    for (const file of readdirSync(join(f.root, "access"))) {
      const bytes = readFileSync(join(f.root, "access", file));
      for (const secret of [intent.redemptionSecret, credential.refreshToken, native.refreshToken, new URL(handoff.url).hash.slice(1)])
        assert.ok(!bytes.includes(Buffer.from(secret)), "server storage retains only capability digests");
    }
  } finally { f.close(); }
});

test("connection pinning and handoff expiry, origin, audience and grant revisions fail closed", async () => {
  const f = fixture();
  try {
    const descriptor = await inspectConnection(origin, f.send);
    let posts = 0;
    const observed: typeof fetch = async (url, init) => { if (init?.method === "POST") posts++; return f.send(url, init); };
    await assert.rejects(requestManualPairing({ ...descriptor, serverId: randomUUID() }, createManualPairingIntent("A", ["ui:view"]), observed), /server_connection_changed/);
    await assert.rejects(requestManualPairing({ ...descriptor, uiOrigin: "https://other.example" }, createManualPairingIntent("A", ["ui:view"]), observed), /server_connection_changed/);
    assert.equal(posts, 0, "destination replacement is rejected before sending any secret");
    const intent = createManualPairingIntent("A", ["ui:view"]), pair = await requestManualPairing(descriptor, intent, f.send);
    f.store.approve(pair.id, pair.code, true);
    const credential = await redeemManualPairing(descriptor, pair.id, intent, f.send);
    const wrong = f.store.refresh(credential.refreshToken, randomUUID(), "content");
    await assert.rejects(openRemoteUi(descriptor, wrong.accessToken, randomUUID(), f.send), /unauthorized/);
    const native = f.store.refresh(wrong.refreshToken, randomUUID(), "ui");
    const req = randomUUID(), handoff = await openRemoteUi(descriptor, native.accessToken, req, f.send);
    f.advance(60_001);
    assert.equal((await f.view("/connect/device", { handoff: new URL(handoff.url).hash.slice(1) })).status, 401);
    await assert.rejects(openRemoteUi(descriptor, native.accessToken, req, f.send), /ui_handoff_expired/);
    const pending = await openRemoteUi(descriptor, native.accessToken, randomUUID(), f.send);
    f.store.updateGrant(f.store.inventory().grants[0]!.id, 1, ["ui:view"], []);
    assert.equal((await f.view("/connect/device", { handoff: new URL(pending.url).hash.slice(1) })).status, 403);
    const raw = await f.device(new Request(`${origin}/v1/access/connection`, { headers: { host: "evil.example" } }), peer);
    assert.equal(raw.status, 403);
    f.permitted = false;
    await assert.rejects(inspectConnection(origin, f.send), /service_unavailable/);
  } finally { f.close(); }
});
