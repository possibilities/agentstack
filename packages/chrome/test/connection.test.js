import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionMessage, CONNECTION_KEY } from "../connection.js";

test("connection persists pairing/refresh intent before sending and recovers an ambiguous rotation", async t => {
  let state = {};
  globalThis.chrome = { storage: { local: {
    async get() { return { [CONNECTION_KEY]: structuredClone(state) }; },
    async set(value) { state = structuredClone(value[CONNECTION_KEY]); },
  } } };
  let pairRequest, refreshRequest, losePair = true, loseRefresh = true, generation = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/identity")) return Response.json({ ok: true, data: { serverId: "server-one" } });
    const body = JSON.parse(options.body);
    assert.equal(options.redirect, "error");
    if (url.endsWith("/pair")) {
      assert.equal(state.pairing.redemptionSecret, body.redemptionSecret);
      pairRequest ??= body; assert.deepEqual(body, pairRequest);
      if (losePair) { losePair = false; throw new Error("pair receipt lost"); }
      return Response.json({ ok: true, data: { id: "pairing-id", code: "APPROVAL", expiresAt: Date.now() + 600_000, serverId: "server-one" } });
    }
    assert.equal(options.headers["X-Stack-Server-ID"], "server-one");
    if (url.endsWith("/redeem")) return Response.json({ ok: true, data: { refreshToken: "refresh-1", serverId: "server-one" } });
    if (url.endsWith("/refresh")) {
      assert.equal(state.pendingRefresh.requestId, body.requestId);
      if (generation === 0) { refreshRequest ??= body; assert.deepEqual(body, refreshRequest); }
      if (loseRefresh) { loseRefresh = false; throw new Error("response lost after commit"); }
      generation++;
      return Response.json({ ok: true, data: { accessToken: `access-${body.audience}`, refreshToken: `refresh-${generation + 1}`, expiresAt: Date.now() + 300_000 } });
    }
    if (url.endsWith("/disconnect")) return Response.json({ ok: true, data: { revoked: true } });
    throw new Error("unexpected request");
  });
  await assert.rejects(connectionMessage({ action: "pair", serverUrl: "https://first.example" }), /pair receipt lost/);
  await connectionMessage({ action: "pair", serverUrl: "https://first.example" });
  assert.equal(pairRequest.redemptionSecret.length, 43);
  assert.equal((await connectionMessage({ action: "state" })).code, "APPROVAL");
  await connectionMessage({ action: "complete" });
  await assert.rejects(connectionMessage({ action: "pair", serverUrl: "https://second.example" }), /Disconnect first/);
  assert.equal(state.refreshToken, "refresh-1");
  await assert.rejects(connectionMessage({ action: "access", audience: "brain" }), /response lost/);
  assert.equal(state.refreshToken, "refresh-1");
  assert.ok(state.pendingRefresh);
  assert.equal((await connectionMessage({ action: "access", audience: "brain" })).token, "access-brain");
  assert.equal(state.refreshToken, "refresh-2");
  assert.equal(state.pendingRefresh, null);
  assert.equal((await connectionMessage({ action: "access", audience: "content" })).token, "access-content");
  await connectionMessage({ action: "disconnect" });
  assert.equal((await connectionMessage({ action: "state" })).state, "disconnected");
});

test("a replacement server at the same URL receives no credential or held payload", async t => {
  let state = { serverUrl: "https://first.example", serverId: "original", refreshToken: "private-refresh" };
  globalThis.chrome = { storage: { local: { async get() { return { [CONNECTION_KEY]: structuredClone(state) }; }, async set(value) { state = value[CONNECTION_KEY]; } } } };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options }); return Response.json({ ok: true, data: { serverId: "replacement" } });
  });
  await assert.rejects(connectionMessage({ action: "access" }), /server_identity_changed/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.headers, undefined);
  assert.equal(state.refreshToken, "private-refresh");
  assert.equal(state.observation.state, "server identity changed");
  await connectionMessage({ action: "forget", confirm: "forget-without-revocation" });
  assert.equal(state.refreshToken, undefined);
});

test("connection status is authenticated and local forget never claims revocation", async t => {
  let state = { serverUrl: "https://first.example", serverId: "original", refreshToken: "refresh", tokens: { brain: { accessToken: "access", expiresAt: Date.now() + 300_000 } } };
  globalThis.chrome = { storage: { local: { async get() { return { [CONNECTION_KEY]: structuredClone(state) }; }, async set(value) { state = structuredClone(value[CONNECTION_KEY]); } } } };
  let revoked = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/identity")) return Response.json({ ok: true, data: { serverId: "original" } });
    assert.equal(options.headers["X-Stack-Server-ID"], "original");
    assert.equal(options.headers.authorization, "Bearer access");
    if (revoked) return Response.json({ ok: false, error: { code: "credential_revoked" } }, { status: 401 });
    assert.ok(url.endsWith("/me"));
    return Response.json({ ok: true, data: { serverId: "original", scopes: [] } });
  });
  assert.equal((await connectionMessage({ action: "state" })).observation, null);
  assert.equal((await connectionMessage({ action: "check" })).state, "connected");
  revoked = true;
  await assert.rejects(connectionMessage({ action: "check" }), /credential_revoked/);
  assert.equal(state.observation.state, "revoked");
  await assert.rejects(connectionMessage({ action: "disconnect" }), /credential_revoked/);
  assert.equal(state.refreshToken, "refresh");
  assert.equal((await connectionMessage({ action: "forget", confirm: "forget-without-revocation" })).revoked, false);
  assert.equal(state.refreshToken, undefined);
});
