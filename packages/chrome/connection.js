/** AgentStack-wide connection. All refreshes run in the service worker so an
 * options page and an outbox flush cannot race rotating credentials. */
export const CONNECTION_KEY = "agentstack.connection.v1";
let queue = Promise.resolve();
const serial = run => { const next = queue.then(run, run); queue = next.catch(() => {}); return next; };
const read = async () => {
  // Chrome's default local-storage access also includes content scripts.
  await chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  return (await chrome.storage.local.get({ [CONNECTION_KEY]: {} }))[CONNECTION_KEY];
};
const write = value => chrome.storage.local.set({ [CONNECTION_KEY]: value });
const randomSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export async function verifyIdentity(server, serverId) {
  if (!serverId) throw new Error("Pair again to pin the server identity");
  const response = await fetch(`${server}/v1/access/identity`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.code ?? "server_unavailable");
  if (body.data.serverId !== serverId) throw new Error("server_identity_changed");
}
async function request(server, path, data, token, serverId) {
  if (serverId) await verifyIdentity(server, serverId);
  const response = await fetch(`${server}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", ...(serverId ? { "X-AgentStack-Server-ID": serverId } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.code ?? `HTTP ${response.status}`);
  if (serverId && body.data.serverId && body.data.serverId !== serverId) throw new Error("server_identity_changed");
  return body.data;
}
async function access(audience = "brain") {
  const state = await read();
  if (!state.refreshToken) throw new Error("Pair this client in AgentStack System → Access.");
  if (!state.serverId) throw new Error("Pair again to pin the server identity");
  await verifyIdentity(state.serverUrl, state.serverId);
  if (!state.pendingRefresh && state.tokens?.[audience]?.expiresAt > Date.now() + 30_000) return { serverUrl: state.serverUrl, serverId: state.serverId, token: state.tokens[audience].accessToken };
  // Recover an interrupted exchange FIRST, even if this caller needs another
  // audience. Persist before networking; never generate a new retry request ID.
  const pending = state.pendingRefresh ?? { requestId: crypto.randomUUID(), audience };
  await write({ ...state, pendingRefresh: pending });
  const result = await request(state.serverUrl, "/v1/access/refresh", { ...pending, refreshToken: state.refreshToken }, null, state.serverId);
  await write({ ...state, pendingRefresh: null, refreshToken: result.refreshToken, tokens: { ...state.tokens, [pending.audience]: result } });
  return pending.audience === audience ? { serverUrl: state.serverUrl, serverId: state.serverId, token: result.accessToken } : access(audience);
}
export function connectionMessage(message) {
  return serial(async () => {
    try {
    if (message.action === "state") {
      const state = await read();
      return { serverUrl: state.serverUrl, serverId: state.serverId, code: state.pairing?.code, expiresAt: state.pairing?.expiresAt,
        paired: !!state.refreshToken, observation: state.observation ?? null,
        state: state.pairing ? (state.pairing.expiresAt <= Date.now() ? "expired" : "pending") : state.refreshToken ? "paired" : "disconnected" };
    }
    if (message.action === "pair") {
      const url = new URL(message.serverUrl);
      const serverUrl = url.origin;
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use an HTTPS AgentStack origin.");
      const old = await read();
      if (old.refreshToken) throw new Error("Disconnect first. If revocation cannot be confirmed, explicitly Forget locally and revoke the old credential in System → Access.");
      // An explicit Pair while connected starts a new request. A pending Pair
      // on the same destination reuses its persisted secret and request ID.
      const pairing = old.serverUrl === serverUrl && old.pairing && old.pairing.expiresAt > Date.now() ? old.pairing : {
        requestId: crypto.randomUUID(), redemptionSecret: randomSecret(), expiresAt: Date.now() + 600_000,
      };
      await write({ ...old, serverUrl, pairing });
      const result = await request(serverUrl, "/v1/access/pair", { requestId: pairing.requestId, redemptionSecret: pairing.redemptionSecret, label: "Chrome", kind: "chrome", scopes: ["brain:share", "brain:status", "content:read"] });
      if (!result.serverId) throw new Error("Pair receipt missing server identity");
      if (old.serverUrl === serverUrl && old.serverId && old.serverId !== result.serverId) throw new Error("server_identity_changed; Forget locally before approving a replacement server");
      await write({ serverUrl, serverId: result.serverId, pairing: { ...pairing, ...result } }); return { code: result.code, expiresAt: result.expiresAt };
    }
    if (message.action === "complete") {
      const state = await read(); if (!state.pairing?.id) throw new Error("Start pairing first.");
      const result = await request(state.serverUrl, "/v1/access/redeem", { id: state.pairing.id, redemptionSecret: state.pairing.redemptionSecret }, null, state.serverId);
      await write({ serverUrl: state.serverUrl, ...result, serverId: state.serverId }); return { state: "paired" };
    }
    if (message.action === "disconnect") {
      const state = await read();
      if (state.refreshToken) { const config = await access(); await request(config.serverUrl, "/v1/access/disconnect", {}, config.token, state.serverId); }
      await write({ serverUrl: state.serverUrl, serverId: state.serverId }); return { state: "disconnected" };
    }
    if (message.action === "forget") {
      if (message.confirm !== "forget-without-revocation") throw new Error("Explicit local-forget confirmation required");
      const state = await read(); await write({ serverUrl: state.serverUrl });
      return { state: "disconnected", revoked: false };
    }
    if (message.action === "check") {
      const config = await access();
      const current = await read();
      const response = await fetch(`${config.serverUrl}/v1/access/me`, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${config.token}`, "X-AgentStack-Server-ID": current.serverId } });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error?.code ?? "server_unavailable");
      if (body.data.serverId !== current.serverId) throw new Error("server_identity_changed");
      const state = await read();
      const observation = { state: "connected", at: Date.now(), scopes: body.data.scopes };
      await write({ ...state, observation }); return observation;
    }
    if (message.action === "access") return await access(message.audience);
    throw new Error("Unknown connection action");
    } catch (error) {
    const state = await read();
    if (state.refreshToken && ["access", "check", "disconnect"].includes(message.action)) {
      const code = error.message;
      const status = /revoked/.test(code) ? "revoked" : /expired|refresh_reused|superseded/.test(code) ? "expired or re-pair required" : /identity_changed|identity_mismatch/.test(code) ? "server identity changed" : "unavailable or tailnet disconnected";
      await write({ ...state, observation: { state: status, at: Date.now(), error: code } });
    }
    throw error;
    }
  });
}
