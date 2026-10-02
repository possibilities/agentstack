import { createHash } from "node:crypto";
import { localCookie, localCookieName, localOrigin, withLocalAuth, type LocalAudience } from "./local-auth.js";

export const localConnectPath = "/connect/local";
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
export type LocalBrowserOptions = { cookieName?: string; surface?: "client"; nonce?: string };
/** Public bootstrap shell has no operator data or credentials. The capability is
 * delivered in a fragment by the private CLI, erased before its one-time POST. */
export function localConnectPage(audience: LocalAudience, options: LocalBrowserOptions = {}): Response {
  if (options.nonce && !/^[A-Za-z0-9+/=_-]{16,128}$/.test(options.nonce)) throw new Error("invalid nonce");
  const destination = options.surface === "client" ? "/client" : "/";
  const command = options.surface === "client" ? "stack-ui" : `stack serve open${audience === "inspector" ? " inspector" : ""}`;
  const failure = options.surface === "client" ? `.catch(()=>document.getElementById('status').textContent='Connection failed. Run stack-ui again.')` : `.catch(e=>document.getElementById('status').textContent=e.message)`;
  const script = `function connect(){const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(token)fetch('/connect/local/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),credentials:'same-origin',cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('Link expired or already used. Run the command again.');location.replace('${destination}')})${failure}}addEventListener('hashchange',connect);connect();`;
  const digest = createHash("sha256").update(script).digest("base64");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Stack</title><h1>Connect to Stack${options.surface === "client" ? " Client" : ""}</h1><p id="status">On this machine, run <code>${command}</code> to open an authenticated session.</p><script${options.nonce ? ` nonce="${options.nonce}"` : ""}>${script}</script></html>`, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; script-src '${options.nonce ? `nonce-${options.nonce}` : `sha256-${digest}`}'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
}
export async function localBrowserResponse(request: Request, env: NodeJS.ProcessEnv, audience: LocalAudience, options: LocalBrowserOptions = {}): Promise<Response> {
  const incoming = new URL(request.url);
  // Next's route Request URL uses its internal bind hostname. Admission uses
  // the validated HTTP Host, never forwarded host/protocol headers.
  const url = new URL(`${incoming.pathname}${incoming.search}`, request.headers.has("host") ? `http://${request.headers.get("host")}` : incoming.origin);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, "content-type": "application/json" } });
  try {
    localOrigin(url.origin);
    const cookieName = localCookieName(audience, options.cookieName);
    if (url.pathname === localConnectPath && request.method === "GET" && !url.search) return localConnectPage(audience, options);
    if (request.method !== "POST") return json({ error: "method refused" }, 403);
    if (request.headers.get("origin") !== url.origin) return json({ error: "origin refused" }, 403);
    if (request.headers.get("content-type") !== "application/json") return json({ error: "JSON required" }, 403);
    if (url.search) return json({ error: "query refused" }, 403);
    if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ error: "payload too large" }, 413);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) { await reader.cancel(); return json({ error: "payload too large" }, 413); }
        chunks.push(next.value);
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const value = JSON.parse(body) as { token?: unknown };
    return withLocalAuth(env, (auth) => {
      if (url.pathname === `${localConnectPath}/session`) {
        if (typeof value.token !== "string") throw new Error("missing token");
        const session = auth.redeem(value.token, url.origin, audience);
        const response = json({ expiresAt: session.expiresAt });
        response.headers.set("set-cookie", `${cookieName}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
        return response;
      }
      const cookie = localCookie(request.headers.get("cookie"), audience, cookieName);
      auth.session(cookie, url.origin, audience);
      if (url.pathname === `${localConnectPath}/ticket` && audience === "ui") return json({ ticket: auth.ticket(cookie, url.origin) });
      if (url.pathname === `${localConnectPath}/logout`) {
        auth.revokeSession(cookie, url.origin, audience);
        const response = json({ closed: true });
        response.headers.set("set-cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return response;
      }
      return json({ error: "not found" }, 404);
    });
  } catch { return json({ error: "local authentication required" }, 401); }
}
