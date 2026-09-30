import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { serveHttp, serveWebSocket, withLocalAuth, type RemoteWebSocketAdmission } from "@stack/api";
import { z } from "zod";
import { AccessError, AccessStore } from "./store.js";
import { pairInput, redeemInput, resourcePath } from "./ingress.js";
import { localApi, verifier, type Peer } from "./network.js";

const cookieName = "__Host-stack_ui";
const refreshName = "__Host-stack_ui_refresh";
const token = /^[A-Za-z0-9_-]{43}$/;
const uiPagePath = /^\/(?:$|(?:accounts|lab|system|roles|inbox|signal|content|workers|scrape|browse|brain|proc|fleet)\/?$)/;
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ schema_version: 1, ok: true, data }),
  { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cookie = (header: string | null | undefined, name: string) =>
  header?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const sessionCookie = (value: string, maxAge: number, name = cookieName) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
const remoteHeaders = (request: Request | IncomingMessage, expected: string, method: string, host: string | null | undefined, origin: string | null | undefined) => {
  const headers = request.headers;
  const keys = headers instanceof Headers ? [...headers.keys()] : Object.keys(headers);
  if (host !== new URL(expected).host || keys.some(key => key === "forwarded" || key.startsWith("x-forwarded-") || key.startsWith("tailscale-")
    || key.startsWith("x-stack-ui-") || key === "x-stack-remote-ui")) throw new AccessError("untrusted_request", 403);
  if (origin && origin !== expected || !["GET", "HEAD"].includes(method) && origin !== expected) throw new AccessError("origin_refused", 403);
};

const connectPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pair Stack browser</title><style>body{font:16px system-ui;max-width:36rem;margin:5vh auto;padding:1rem}input,button{font:inherit;padding:.6rem}input{width:95%}button{margin-top:1rem}code{font-size:1.3rem}#error{color:#a00}</style><h1>Pair this browser</h1><p>Pairing requires approval on the Stack machine. Compare the full code there. This browser saves its redemption secret before requesting approval.</p><label>Browser label <input id="label" maxlength="100" autocomplete="off" required></label><br><button id="pair">Request approval</button><p id="code"></p><button id="redeem" hidden>Approved? Connect</button><p id="error" role="alert"></p><script>
const key='stack-pairing';const error=document.getElementById('error');const code=document.getElementById('code');const redeem=document.getElementById('redeem');
const saved=()=>JSON.parse(localStorage.getItem(key)||'null');const show=s=>{code.textContent=s.code?'Compare approval code: '+s.code:'Pairing saved. Retry request to recover the code.';redeem.hidden=!s.id};
if(saved())show(saved());
async function post(path,data,serverId){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',...(serverId?{'x-stack-server-id':serverId}:{})},body:JSON.stringify(data),cache:'no-store'});const body=await r.json();if(!r.ok)throw Error(body.error?.message||'Request refused');return body.data}
async function identity(){const r=await fetch('/connect/identity',{cache:'no-store'});if(!r.ok)throw Error('Server identity unavailable');return (await r.json()).data.serverId}
document.getElementById('pair').onclick=async()=>{error.textContent='';try{let s=saved();if(!s){const bytes=crypto.getRandomValues(new Uint8Array(32));s={requestId:crypto.randomUUID(),redemptionSecret:btoa(String.fromCharCode(...bytes)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''),label:document.getElementById('label').value.trim(),kind:'browser',scopes:['ui:view','ui:control','content:read']};if(!s.label)throw Error('Enter a label');localStorage.setItem(key,JSON.stringify(s))}const serverId=await identity();if(s.serverId&&s.serverId!==serverId)throw Error('Stack server changed; do not send this secret');s.serverId=serverId;localStorage.setItem(key,JSON.stringify(s));const receipt=await post('/connect/pair',{requestId:s.requestId,label:s.label,kind:s.kind,scopes:s.scopes,redemptionSecret:s.redemptionSecret},serverId);if(receipt.serverId!==serverId)throw Error('Stack server changed');s={...s,...receipt};localStorage.setItem(key,JSON.stringify(s));show(s)}catch(e){error.textContent=e.message}};
redeem.onclick=async()=>{error.textContent='';try{let s=saved();if(!s.serverId||s.serverId!==await identity())throw Error('Stack server changed; pairing refused');if(!s.refreshToken){const receipt=await post('/connect/redeem',{id:s.id,redemptionSecret:s.redemptionSecret},s.serverId);if(receipt.serverId!==s.serverId)throw Error('Stack server changed');s={...s,refreshToken:receipt.refreshToken,sessionRequestId:crypto.randomUUID()};localStorage.setItem(key,JSON.stringify(s))}await post('/connect/session',{refreshToken:s.refreshToken,requestId:s.sessionRequestId},s.serverId);localStorage.removeItem(key);location.replace('/')}catch(e){error.textContent=e.message}};
if(!saved())post('/connect/refresh',{}).then(()=>location.replace('/')).catch(()=>{});
</script></html>`;
const inline = (tag: "script" | "style") => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(connectPage)?.[1] ?? "";
const digest = (value: string) => createHash("sha256").update(value).digest("base64");
const connectCsp = `default-src 'none'; script-src 'sha256-${digest(inline("script"))}'; style-src 'sha256-${digest(inline("style"))}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'`;
const controls: Record<string, (name: string) => boolean> = {
  bots: name => ["bot_start", "bot_stop", "bot_assign", "bot_remove", "bot_defaults_set", "bot_settings_patch", "bot_settings_apply",
    "chat_open", "chat_send", "chat_steer", "chat_interrupt", "chat_enqueue", "chat_queue_resolve", "chat_codex_queue_add", "chat_codex_queue_update",
    "chat_codex_queue_delete", "chat_codex_queue_reorder", "chat_codex_queue_start", "chat_upload_start", "chat_upload_chunk", "chat_upload_finish",
    "chat_attachment_add", "chat_attachment_remove"].includes(name),
  content: name => ["collection_create", "collection_update", "collection_delete", "item_put", "item_move", "item_delete",
    "document_update", "new", "add", "rm", "restore", "artifacts_rm", "artifacts_restore"].includes(name) || name.startsWith("blob_stage_"),
  roles: name => /^(category|fragment|skill|mcp_server|project)_(create|update|delete|reorder|move)$/.test(name),
  infer: name => ["infer_start", "infer_discover"].includes(name),
  notify: name => ["notification_dismiss", "notification_dismiss_all"].includes(name),
  signal: name => ["attention_control", "attention_defaults_set", "attention_feedback", "attention_replay"].includes(name),
  // Shared Work collaboration. Metadata stays an explicit write; none of these dispatch native execution.
  hud: name => ["work_create", "work_update", "work_batch", "work_note_add", "work_metadata_set", "work_focus_set"].includes(name),
};

// State inspection includes local filesystem/credential metadata. Read-only hints
// do not extend a remote grant to these new operator surfaces.
const localStateOperation = (name: string) => /_state_|_bot_dependencies$|_history_(plan|clear)$|^serve_subscription_|^bot_(workspace_|history_|log_|launch_|recovery_|session_reset$|upload_remove$|queue_history$)|^chat_upload_(list|read)$|^content_(blob_list|storage_)|^blob_stage_(list|abort)$|^attention_infer_requests$|^usage_observations_|^xcom_control$|^worker_workspace_|^work_focus_(list|retire)/.test(name);

export type RemoteUiOptions = { store: AccessStore; env: NodeJS.ProcessEnv; host: string; port: number;
  verify?: (peer: Peer) => Promise<void>; fetchBackend?: typeof fetch; root?: string };

export function remoteUiHandler({ store, env, host, port, verify, fetchBackend }: RemoteUiOptions) {
  const expected = env.STACK_ACCESS_UI_ORIGIN ?? `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const check = verify ?? verifier(env.STACK_TAILSCALE_BIN,
    env.STACK_TAILSCALE_SOCKET ? localApi(env.STACK_TAILSCALE_SOCKET) : undefined);
  return async (request: Request, peer: Peer): Promise<Response> => {
    try {
      await check(peer);
      remoteHeaders(request, expected, request.method, request.headers.get("host"), request.headers.get("origin"));
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/connect" && request.method === "GET") return new Response(connectPage, { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
        "content-security-policy": connectCsp } });
      if (path === "/connect/identity" && request.method === "GET") return json({ serverId: store.serverId });
      if (path === "/connect/pair" && request.method === "POST") return json(store.pair(pairInput.parse(await payload(request))));
      if (path === "/connect/redeem" && request.method === "POST") {
        if (request.headers.get("x-stack-server-id") !== store.serverId) throw new AccessError("server_identity_mismatch", 409);
        const input = redeemInput.parse(await payload(request)); return json(store.redeem(input.id, input.redemptionSecret));
      }
      if (path === "/connect/session" && request.method === "POST") {
        if (request.headers.get("x-stack-server-id") !== store.serverId) throw new AccessError("server_identity_mismatch", 409);
        const input = z.strictObject({ refreshToken: z.string().regex(token), requestId: z.uuid() }).parse(await payload(request));
        const issued = store.startUi(input.refreshToken, input.requestId);
        const response = json({ scopes: store.ui(issued.accessToken).scopes, expiresAt: issued.expiresAt });
        response.headers.append("set-cookie", sessionCookie(issued.accessToken, 300));
        response.headers.append("set-cookie", sessionCookie(issued.refreshToken, 900, refreshName));
        return response;
      }
      if (path === "/connect/refresh" && request.method === "POST") {
        const refresh = cookie(request.headers.get("cookie"), refreshName);
        if (!token.test(refresh)) throw new AccessError("unauthorized");
        // One deterministic retry ID per old cookie prevents concurrent tabs from
        // consuming distinct generations. Each successful response rotates it.
        const digest = createHash("sha256").update(refresh).digest("hex");
        const requestId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
        const issued = store.startUi(refresh, requestId);
        const response = json({ scopes: store.ui(issued.accessToken).scopes, expiresAt: issued.expiresAt });
        response.headers.append("set-cookie", sessionCookie(issued.accessToken, 300));
        response.headers.append("set-cookie", sessionCookie(issued.refreshToken, 900, refreshName));
        return response;
      }
      if (path === "/v1/content/handoff" && request.method === "POST") {
        const input = z.strictObject({ path: z.string().max(512), origin: z.enum(["documents", "artifacts"]) }).parse(await payload(request));
        if (!resourcePath(input.path, input.origin)) throw new AccessError("invalid_resource_path", 400);
        return json(store.uiHandoff(cookie(request.headers.get("cookie"), cookieName), input.path, input.origin));
      }
      if (path === "/connect/me" && request.method === "GET") {
        const principal = store.ui(cookie(request.headers.get("cookie"), cookieName));
        const name = new URL(expected).hostname;
        return json({ scopes: principal.scopes, documentOrigin: `https://${name}:${env.STACK_ACCESS_PORT ?? 8943}`,
          artifactOrigin: `https://${name}:${env.STACK_ACCESS_ARTIFACT_PORT ?? 8944}` });
      }
      if (!["GET", "HEAD"].includes(request.method) || !(uiPagePath.test(path) || path.startsWith("/_next/") || path === "/favicon.ico")) throw new AccessError("not_found", 404);
      const principal = store.ui(cookie(request.headers.get("cookie"), cookieName));
      const upstreamPort = Number(env.STACK_UI_PORT ?? 8745);
      const headers = new Headers();
      for (const name of ["accept", "accept-language", "user-agent", "rsc", "next-router-state-tree", "next-router-prefetch", "next-url"]) {
        const value = request.headers.get(name); if (value) headers.set(name, value);
      }
      headers.set("x-stack-remote-ui", "1");
      headers.set("x-stack-ui-origin", expected);
      headers.set("x-stack-ui-scope", principal.scopes.includes("ui:control") ? "control" : "view");
      headers.set("x-stack-ui-scopes", principal.scopes.join(","));
      headers.set("x-stack-ui-proof", withLocalAuth(env, auth => auth.signRemote(request.method, path + url.search, expected,
        headers.get("x-stack-ui-scope")!, headers.get("x-stack-ui-scopes")!)));
      const nonce = randomBytes(16).toString("base64");
      const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${expected.replace(/^https:/, "wss:")}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'`;
      headers.set("content-security-policy", csp);
      const upstream = await (fetchBackend ?? fetch)(`http://127.0.0.1:${upstreamPort}${path}${url.search}`, { method: request.method, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const responseHeaders = new Headers(upstream.headers);
      for (const name of ["set-cookie", "access-control-allow-origin", "x-powered-by", "content-encoding", "content-length"]) responseHeaders.delete(name);
      if (responseHeaders.has("location")) {
        const target = new URL(responseHeaders.get("location")!, `http://127.0.0.1:${upstreamPort}`);
        if (target.origin !== `http://127.0.0.1:${upstreamPort}` || !uiPagePath.test(target.pathname)) throw new AccessError("redirect_refused", 403);
        responseHeaders.set("location", `${target.pathname}${target.search}`);
      }
      responseHeaders.set("cache-control", "no-store"); responseHeaders.set("content-security-policy", csp);
      responseHeaders.set("referrer-policy", "no-referrer"); responseHeaders.set("x-content-type-options", "nosniff");
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      const status = error instanceof AccessError ? error.status : error instanceof z.ZodError ? 400 : 503;
      const code = error instanceof AccessError ? error.code : error instanceof z.ZodError ? "bad_payload" : "service_unavailable";
      return new Response(JSON.stringify({ schema_version: 1, ok: false, error: { code, message: code } }),
        { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
  };
}

async function payload(request: Request) {
  if (request.headers.get("content-type") !== "application/json") throw new AccessError("json_required", 415);
  const text = await request.text();
  if (text.length > 4096) throw new AccessError("payload_too_large", 413);
  try { return JSON.parse(text); } catch { throw new AccessError("bad_payload", 400); }
}

export async function startRemoteUi(options: RemoteUiOptions, tls: { key: Buffer; cert: Buffer }) {
  const { store, env, host, port } = options;
  const expected = env.STACK_ACCESS_UI_ORIGIN ?? `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const verify = options.verify ?? verifier(env.STACK_TAILSCALE_BIN,
    env.STACK_TAILSCALE_SOCKET ? localApi(env.STACK_TAILSCALE_SOCKET) : undefined);
  const http = await serveHttp({ host, port, tls, handle: remoteUiHandler({ ...options, verify }),
    requestTimeout: 30_000, headersTimeout: 10_000, forceCloseConnections: true });
  try {
    const websocket = await serveWebSocket({ env, root: options.root, server: http.server, authenticate: async request => {
      const peer = { remoteAddress: request.socket.remoteAddress ?? "", remotePort: request.socket.remotePort ?? 0,
        localAddress: request.socket.localAddress ?? "" };
      await verify(peer);
      remoteHeaders(request, expected, "GET", request.headers.host, request.headers.origin);
      if (request.headers.origin !== expected) throw new AccessError("origin_refused", 403);
      const access = cookie(request.headers.cookie, cookieName);
      const principal = store.ui(access);
      const scopesAtAdmission = JSON.stringify(principal.scopes);
      const expiresAt = store.uiExpires(access);
      const readOnly = new Set<string>();
      const admission: RemoteWebSocketAdmission = {
        expiresAt,
        check() {
          const current = store.ui(access);
          if (JSON.stringify(current.scopes) !== scopesAtAdmission) throw new AccessError("grant_changed");
        },
        select(pkg, exposure, catalog) {
          if (["access", "auth", "browse", "proc", "xcom"].includes(pkg)) return { operations: [], events: [] };
          const safe = new Set(catalog.tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name));
          for (const name of safe) readOnly.add(`${pkg}/${name}`);
          // share_read_states accepts arbitrary job IDs; only Access's device route
          // filters those IDs through client-bound admission receipts.
          const denied = (name: string) => localStateOperation(name) || pkg === "bots" && name.startsWith("voice_") || pkg === "brain" && name === "share_read_states" || pkg === "roles" && name.startsWith("role_shim_");
          return { operations: exposure.operations.filter(name => !denied(name) && (safe.has(name) || principal.scopes.includes("ui:control") && controls[pkg]?.(name))),
            events: exposure.events.filter(name => !(pkg === "bots" && name === "voice_changed") && !(pkg === "roles" && name === "role_shims_changed")) };
        },
        mutation(pkg, operation) {
          this.check();
          if (localStateOperation(operation) || ["access", "auth", "browse", "proc", "xcom"].includes(pkg) || pkg === "bots" && operation.startsWith("voice_") || pkg === "brain" && operation === "share_read_states" || pkg === "roles" && operation.startsWith("role_shim_")) throw new AccessError("operation_refused", 403);
          if (readOnly.has(`${pkg}/${operation}`)) return;
          // The gateway already selected the live operation, but a narrowed
          // grant must be re-evaluated before each mutating invocation.
          store.uiMutation(principal, pkg, operation);
        },
        onChange(close) { return store.watchUi(() => { try { this.check(); } catch { close(); } }); },
      };
      return admission;
    } });
    return { port, close: async () => { await websocket.close(); await http.close(); } };
  } catch (error) { await http.close(); throw error; }
}
