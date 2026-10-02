// Node-only foundation shared by the supervised ingress and Next's server-only
// session wrapper. Never import this module into a browser component.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { localCookie, localOrigin, withLocalAuth } from "@stack/api";

const mode = process.env.STACK_UI_MODE ?? "platform";
if (mode !== "client" && mode !== "platform") throw new Error("invalid_ui_mode");
const root = process.env.STACK_CLIENT_STATE_DIR;
const origin = process.env.STACK_CLIENT_UI_ORIGIN;
const ingressKey = process.env.STACK_CLIENT_UI_INGRESS_KEY;
if (mode === "client" && (!root || !isAbsolute(root) || !origin || !ingressKey || !/^[a-f0-9]{64}$/.test(ingressKey))) throw new Error("client_ui_configuration_required");
if (mode === "client") localOrigin(origin);
export const runtime = Object.freeze(mode === "client" ? {
  mode, root, origin, host: new URL(origin).host,
  cookieName: `stack_client_ui_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
} : { mode });

export const clientSecurityHeaders = Object.freeze({
  "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
});
export class ClientSessionError extends Error {
  constructor(status = 401) { super("Client session required. Run stack-ui to reconnect."); this.status = status; }
}
const internal = new Set(["x-stack-client-method", "x-stack-client-path", "x-stack-client-issued", "x-stack-client-proof"]);
export const forbiddenAuthorityHeader = name => name === "forwarded" || name.startsWith("x-forwarded-")
  || name.startsWith("x-stack-") || name.startsWith("x-middleware-") || name.startsWith("x-nextjs-")
  || name.startsWith("x-invoke-") || name === "x-matched-path" || name === "x-now-route-matches";
const signature = (incoming, method, path, issued) => createHmac("sha256", ingressKey)
  .update(JSON.stringify(["client-ingress-v1", method, path, issued, incoming.get("host"), incoming.get("origin"), incoming.get("cookie")])).digest("hex");

/** Run on raw HTTP headers, BEFORE Next adds its own forwarding headers. */
export function admitClientIngress(incoming, method, path) {
  requireClientAuthority(incoming, method);
  if ([...incoming.keys()].some(forbiddenAuthorityHeader)) throw new ClientSessionError(403);
  const issued = String(Date.now());
  return { "x-stack-client-method": method, "x-stack-client-path": path, "x-stack-client-issued": issued,
    "x-stack-client-proof": signature(incoming, method, path, issued) };
}

function requireClientAuthority(incoming, method) {
  if (runtime.mode !== "client") throw new ClientSessionError(404);
  if (incoming.get("host") !== runtime.host) throw new ClientSessionError(403);
  const supplied = incoming.get("origin");
  if (supplied !== null && supplied !== runtime.origin || !["GET", "HEAD"].includes(method) && supplied !== runtime.origin) throw new ClientSessionError(403);
}

/** The signed ingress assertion is request-bound, not browser authority. Next
 * synthesizes forwarding headers; only this authenticated ingress may supply the
 * originals. Recheck the client-root session in proxy, SSR and each handler. */
export function requireClientSession(incoming, method, path, { exchange = false } = {}) {
  const signedMethod = incoming.get("x-stack-client-method");
  const signedPath = incoming.get("x-stack-client-path");
  requireClientAuthority(incoming, method ?? signedMethod);
  const issued = incoming.get("x-stack-client-issued") ?? "";
  const proof = incoming.get("x-stack-client-proof") ?? "";
  // Next removes its RSC cache-busting query before proxy. The MAC remains bound
  // to the full raw target; compare route identity separately from that query.
  if (!signedMethod || !signedPath || method && method !== signedMethod || path && new URL(path, runtime.origin).pathname !== new URL(signedPath, runtime.origin).pathname
    || !/^\d{13}$/.test(issued) || Number(issued) > Date.now() || Date.now() - Number(issued) > 60_000 || !/^[a-f0-9]{64}$/.test(proof)) throw new ClientSessionError(403);
  const expected = signature(incoming, signedMethod, signedPath, issued);
  if (!timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) throw new ClientSessionError(403);
  // These four fields are synthesized by Next from the loopback bind. The raw
  // ingress already refused ALL caller forwarding headers, including matching ones.
  const generated = { "x-forwarded-host": runtime.host, "x-forwarded-proto": "http", "x-forwarded-port": new URL(runtime.origin).port, "x-forwarded-for": "127.0.0.1" };
  for (const [name, value] of incoming) {
    if (!forbiddenAuthorityHeader(name) || internal.has(name)) continue;
    if (generated[name] !== value) throw new ClientSessionError(403);
  }
  const url = new URL(signedPath, runtime.origin);
  if (exchange && (signedMethod === "GET" && url.pathname === "/connect/local" || signedMethod === "POST" && url.pathname === "/connect/local/session") && !url.search) return null;
  const token = localCookie(incoming.get("cookie"), "ui", runtime.cookieName);
  try {
    const session = withLocalAuth({ STACK_STATE_DIR: runtime.root }, auth => auth.session(token, runtime.origin, "ui"));
    return { expiresAt: session.expires, revalidate: () => withLocalAuth({ STACK_STATE_DIR: runtime.root }, auth => auth.session(token, runtime.origin, "ui")) };
  } catch { throw new ClientSessionError(); }
}

export function clientCsp(nonce) {
  return `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}
