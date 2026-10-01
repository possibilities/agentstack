import { readFileSync } from "node:fs";
import { serveHttp, socketCall, socketPath } from "@stack/api";
import { z } from "zod";
import { AccessError, AccessStore, scopes, type Principal } from "./store.js";
import { tailnetAddress, verifier, localApi, type Peer } from "./network.js";
import { startRemoteUi } from "./remote-ui.js";
import { clientKinds } from "./policy.js";
import { approvalInput, claimInput, enrollmentRedeemInput, qrTextSchema } from "./enrollment-protocol.js";
import { enrollmentOrigin, enrollmentResponse } from "./enrollment.js";
import { connectionDescriptor, uiHandoffInput } from "./connection.js";

export const pairInput = z.strictObject({ requestId: z.uuid(), label: z.string().trim().min(1).max(100), kind: z.enum(clientKinds), scopes: z.array(z.enum(scopes)).min(1).max(scopes.length), redemptionSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const redeemInput = z.strictObject({ id: z.uuid(), redemptionSecret: pairInput.shape.redemptionSecret });
export const refreshInput = z.strictObject({ refreshToken: pairInput.shape.redemptionSecret, requestId: z.uuid(), audience: z.enum(["brain", "content", "access", "ui"]) });
export const handoffInput = z.strictObject({ path: z.string().max(512), origin: z.enum(["documents", "artifacts"]) });
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ schema_version: 1, ok: true, data }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
async function body(request: Request, limit = 1024 * 1024) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AccessError("json_required", 415);
  const reader = request.body?.getReader(); if (!reader) throw new AccessError("bad_payload", 400);
  let length = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > limit) { void reader.cancel(); throw new AccessError("payload_too_large", 413); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AccessError("bad_payload", 400); }
}
function bearer(request: Request) { return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? ""; }
export function resourcePath(path: string, origin: string) {
  // Only canonical resource identifiers, never encoded separators or arbitrary
  // paths. A bundle capability covers its immutable version, not its siblings.
  return origin === "documents" ? /^\/d\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)
    : /^\/c\/[a-f0-9-]{36}$/.test(path) || /^\/a\/[a-z0-9]+(?:-[a-z0-9]+)*\/v\/[a-f0-9]{64}\/$/.test(path);
}
export type IngressOptions = { store: AccessStore; env: NodeJS.ProcessEnv; origin: "documents" | "artifacts"; verify?: (peer: Peer) => Promise<void>;
  call?: (packageName: string, name: string, args: unknown) => Promise<any>; fetchBackend?: typeof fetch };
export function handler(options: IngressOptions) {
  const { store, env, origin } = options;
  const verify = options.verify ?? verifier(env.STACK_TAILSCALE_BIN,
    env.STACK_TAILSCALE_SOCKET ? localApi(env.STACK_TAILSCALE_SOCKET) : undefined);
  const call = options.call ?? ((pkg, name, args) => socketCall(socketPath(pkg, env), "tools/call", { name, arguments: args }));
  return async (request: Request, peer: Peer): Promise<Response> => {
    let cors: Record<string, string> = {};
    try {
      await verify(peer);
      if ([...request.headers.keys()].some(name => name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("tailscale-"))) {
        throw new AccessError("forwarded_headers_refused", 403);
      }
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin?.match(/^chrome-extension:\/\/[a-p]{32}$/)) cors = { "access-control-allow-origin": requestOrigin, vary: "origin", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-stack-server-id" };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
       const url = new URL(request.url);
       let path = url.pathname;
       // An opaque-origin sandbox cannot send SameSite cookies for its own
       // assets. A short-lived view credential covers one immutable bundle and
       // travels in the path so relative assets work without broad cookies.
       const view = origin === "artifacts" && ["GET", "HEAD"].includes(request.method)
         ? /^\/view\/([A-Za-z0-9_-]{43})(\/.*)$/.exec(path) : null;
       if (view) {
         path = view[2]!;
         store.session(view[1]!, origin, path);
       }
      // Navigations cannot set custom headers. Resource cookies and one-use
      // handoffs are bound to this store; API clients additionally pin identity.
       const bootstrap = path === "/v1/access/pair" || path === "/v1/access/identity" || path === "/v1/access/connection";
       if ((path.startsWith("/v1/") && !bootstrap || request.headers.has("authorization")) && request.headers.get("x-stack-server-id") !== store.serverId) {
        throw new AccessError("server_identity_mismatch", 409);
      }
      let response: Response;
       if (origin === "documents" && path.startsWith("/v1/access/enrollment/")) {
         const destination = enrollmentOrigin(env);
         if (request.headers.get("host") !== new URL(destination).host) throw new AccessError("enrollment_host_refused", 403);
         if (requestOrigin && !requestOrigin.match(/^chrome-extension:\/\/[a-p]{32}$/) && requestOrigin !== destination) throw new AccessError("origin_refused", 403);
         if (request.method !== "POST") throw new AccessError("method_not_allowed", 405);
         const input = await body(request, 8192);
         if (path === "/v1/access/enrollment/claim") {
           const value = claimInput.parse(input);
           response = json(enrollmentResponse(store.claimInvitation(value.inviteId, value.secret, value.request), store.now()));
         } else if (path === "/v1/access/enrollment/redeem") {
           const value = enrollmentRedeemInput.parse(input);
           response = json(store.redeemEnrollment(value.id, value.redemptionSecret, value.requestHash, value.signature));
         } else if (path === "/v1/access/enrollment/inspect") {
           const value = z.strictObject({ request: qrTextSchema }).parse(input);
           response = json(store.previewEnrollment(value.request, bearer(request)));
         } else if (path === "/v1/access/enrollment/approve") {
           const value = approvalInput.parse(input);
           response = json(enrollmentResponse(store.approveEnrollment(value.request, value.scopes, destination, bearer(request)), store.now()));
         } else if (path === "/v1/access/enrollment/cancel") {
           const value = z.strictObject({ id: z.uuid() }).parse(input);
           response = json(store.cancelEnrollment(value.id, bearer(request)));
         } else throw new AccessError("not_found", 404);
       } else if (origin === "documents" && request.method === "GET" && path === "/v1/access/connection") {
         const descriptor = connectionDescriptor(store.serverId, env);
         if (request.headers.get("host") !== new URL(descriptor.deviceOrigin).host) throw new AccessError("connection_host_refused", 403);
         response = json(descriptor);
       } else if (origin === "documents" && request.method === "POST" && path === "/v1/access/ui-handoff") {
         const descriptor = connectionDescriptor(store.serverId, env);
         if (request.headers.get("host") !== new URL(descriptor.deviceOrigin).host) throw new AccessError("connection_host_refused", 403);
         if (!descriptor.uiOrigin) throw new AccessError("ui_not_configured", 409);
         const input = uiHandoffInput.parse(await body(request, 4096));
         response = json(store.uiConnectHandoff(bearer(request), input.requestId, descriptor.uiOrigin));
       } else if (origin === "documents" && request.method === "GET" && path === "/v1/access/identity") {
         response = json({ serverId: store.serverId });
       } else if (origin === "documents" && request.method === "GET" && path === "/v1/access/me") {
        const principal = store.authorize(bearer(request), "brain");
        response = json({ serverId: store.serverId, clientId: principal.clientId, credentialId: principal.credentialId, scopes: principal.scopes });
      } else if (origin === "documents" && request.method === "POST" && path === "/v1/access/pair") {
        const input = pairInput.parse(await body(request)); response = json({ ...store.pair(input), redemptionSecret: input.redemptionSecret });
      } else if (origin === "documents" && request.method === "POST" && path === "/v1/access/redeem") {
        const input = redeemInput.parse(await body(request)); response = json(store.redeem(input.id, input.redemptionSecret));
      } else if (origin === "documents" && request.method === "POST" && path === "/v1/access/refresh") {
        const input = refreshInput.parse(await body(request)); response = json(store.refresh(input.refreshToken, input.requestId, input.audience));
      } else if (origin === "documents" && path === "/v1/access/disconnect" && request.method === "POST") {
        const principal = store.authorize(bearer(request), "brain"); response = json(store.revoke("credential", principal.credentialId));
      } else if (origin === "documents" && path === "/v1/content/handoff" && request.method === "POST") {
        const principal = store.authorize(bearer(request), "content", "content:read");
        const input = handoffInput.parse(await body(request)); if (!resourcePath(input.path, input.origin)) throw new AccessError("invalid_resource_path", 400);
        response = json(store.handoff(principal, input.path, input.origin));
      } else if (path === "/session" && request.method === "GET") {
        // Fragment never reaches a server or Referer. The one-use handoff alone
        // crosses the browser navigation; broad credentials never enter a URL.
        response = new Response(`<!doctype html><meta name="referrer" content="no-referrer"><title>Open Stack content</title><p id="status">Opening content…</p><script>const token=location.hash.slice(1);history.replaceState(null,'','/session');fetch('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handoff:token})}).then(async r=>{if(!r.ok)throw Error();location.replace((await r.json()).data.path)}).catch(()=>document.getElementById('status').textContent='Link expired or unavailable. Open it again from your paired client.');</script>`, { headers: { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'", "referrer-policy": "no-referrer" } });
      } else if (path === "/session" && request.method === "POST") {
        const input = z.strictObject({ handoff: pairInput.shape.redemptionSecret }).parse(await body(request));
         const value = store.exchange(input.handoff, origin);
         response = json({ path: origin === "artifacts" ? `/view/${value.session}${value.path}` : value.path });
         if (origin === "documents") response.headers.set("set-cookie", `access_session=${value.session}; Path=${value.path}; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
      } else if (origin === "documents" && ["/v1/share", "/v1/shares", "/v1/health"].includes(path)) {
        const scope = path === "/v1/share" ? "brain:share" : "brain:status";
        const principal = store.authorize(bearer(request), "brain", scope);
        if (path === "/v1/health" && request.method === "GET") response = json({ version: 1, ok: true });
        else if (path === "/v1/share" && request.method === "POST") {
          let data: any;
          try {
            const payload = z.record(z.string(), z.unknown()).parse(await body(request));
            if (!["android", "chrome"].includes(principal.kind)) throw new AccessError("unsupported_share_client", 403);
            payload.client = principal.kind === "android" ? "android-share" : "chrome-extension";
            data = await call("brain", "share_receive", { payload });
          }
          catch (error) {
            const code = error instanceof Error ? error.message : "";
            const statuses: Record<string, number> = { bad_payload: 400, bad_source: 400, unsupported_version: 400, idempotency_conflict: 409, payload_too_large: 413 };
            if (statuses[code]) throw new AccessError(code, statuses[code]);
            throw error;
          }
          store.receipt(principal.clientId, data.job_id); response = json(data);
        } else if (path === "/v1/shares" && request.method === "GET") {
          const raw = url.searchParams.get("job_ids") ?? "";
          if (raw && !/^\d+(,\d+)*$/.test(raw)) throw new AccessError("bad_payload", 400);
          const ids = raw ? raw.split(",").map(Number) : [];
          if (ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new AccessError("bad_payload", 400);
          response = json(await call("brain", "share_read_states", { ids: store.ownJobs(principal.clientId, ids) }));
        } else throw new AccessError("method_not_allowed", 405);
      } else if (["GET", "HEAD"].includes(request.method) && (origin === "documents" ? path === "/" || path.startsWith("/d/") : path.startsWith("/a/") || path.startsWith("/c/"))) {
         if (view) { /* The exact resource was authorized above. */ }
         else if (request.headers.has("authorization")) store.authorize(bearer(request), "content", "content:read");
        else {
          const cookies = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith("access_session=")).map(v => v.slice(15));
          if (!cookies.some(cookie => { try { store.session(cookie, origin, path); return true; } catch { return false; } })) throw new AccessError("unauthorized");
        }
        // Fixed loopback destinations, no caller-selected upstream, Host or
        // forwarding headers. Never follow backend redirects with credentials.
        const port = origin === "documents" ? env.STACK_CONTENT_PORT ?? env.STACK_WIKI_PORT ?? "8777" : env.STACK_CONTENT_ARTIFACT_PORT ?? env.STACK_WIKI_ARTIFACT_PORT ?? "8778";
        const upstream = await (options.fetchBackend ?? fetch)(`http://127.0.0.1:${port}${path}`, { method: request.method, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        const headers = new Headers(upstream.headers); headers.set("cache-control", "no-store"); headers.set("referrer-policy", "no-referrer");
         if (headers.has("location")) { const location = new URL(headers.get("location")!, `http://127.0.0.1:${port}`); if (location.origin !== `http://127.0.0.1:${port}`) throw new AccessError("cross_origin_redirect_refused", 403); headers.set("location", view ? `/view/${view[1]}${location.pathname}` : location.pathname); }
        if (origin === "artifacts") headers.set("content-security-policy", "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
        else headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        response = new Response(upstream.body, { status: upstream.status, headers });
      } else throw new AccessError("not_found", 404);
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
      return response;
    } catch (error) {
      const status = error instanceof AccessError ? error.status : error instanceof z.ZodError ? 400 : 503;
      const code = error instanceof AccessError ? error.code : error instanceof z.ZodError ? "bad_payload" : "service_unavailable";
      return new Response(JSON.stringify({ schema_version: 1, ok: false, error: { code, message: code } }), { status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" } });
    }
  };
}
export async function startIngress(store: AccessStore, env: NodeJS.ProcessEnv) {
  const host = env.STACK_ACCESS_HOST;
  if (!host) return null;
  if (!tailnetAddress(host)) throw new Error("STACK_ACCESS_HOST must be a direct Tailscale IP; proxies and wildcard binds are refused");
  if (env.STACK_ACCESS_ORIGIN) enrollmentOrigin(env);
  if (!env.STACK_ACCESS_TLS_KEY || !env.STACK_ACCESS_TLS_CERT) throw new Error("Access requires operator-provisioned TLS key and certificate paths");
  const tls = { key: readFileSync(env.STACK_ACCESS_TLS_KEY), cert: readFileSync(env.STACK_ACCESS_TLS_CERT) };
  const port = Number(env.STACK_ACCESS_PORT ?? 8943), artifactPort = Number(env.STACK_ACCESS_ARTIFACT_PORT ?? 8944), uiPort = Number(env.STACK_ACCESS_UI_PORT ?? 8945);
  if (![port, artifactPort].every(p => Number.isInteger(p) && p > 0 && p <= 65535) || port === artifactPort) throw new Error("Access ports must be distinct nonzero TCP ports");
  if (env.STACK_ACCESS_UI_PORT !== undefined && !env.STACK_ACCESS_UI_ORIGIN)
    throw new Error("STACK_ACCESS_UI_ORIGIN is required when configuring a remote UI port");
  if (env.STACK_ACCESS_UI_ORIGIN) {
    const uiOrigin = new URL(env.STACK_ACCESS_UI_ORIGIN);
    if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535 || port === uiPort || artifactPort === uiPort
      || uiOrigin.protocol !== "https:" || uiOrigin.origin !== env.STACK_ACCESS_UI_ORIGIN || Number(uiOrigin.port || 443) !== uiPort || !uiOrigin.hostname || uiOrigin.username || uiOrigin.password)
      throw new Error("STACK_ACCESS_UI_ORIGIN must be the exact HTTPS origin on a distinct STACK_ACCESS_UI_PORT");
  }
  const documents = await serveHttp({ host, port, tls, env, handle: handler({ store, env, origin: "documents" }), requestTimeout: 30_000, headersTimeout: 10_000, forceCloseConnections: true });
  try {
    const artifacts = await serveHttp({ host, port: artifactPort, tls, env, handle: handler({ store, env, origin: "artifacts" }), requestTimeout: 30_000, headersTimeout: 10_000, forceCloseConnections: true });
    try {
      const ui = env.STACK_ACCESS_UI_ORIGIN ? await startRemoteUi({ store, env, host, port: uiPort }, tls) : null;
      return { host, port, artifactPort, uiPort: ui ? uiPort : null,
        close: async () => { await Promise.all([ui?.close(), documents.close(), artifacts.close()]); } };
    } catch (error) { await artifacts.close(); throw error; }
  } catch (error) { await documents.close(); throw error; }
}
