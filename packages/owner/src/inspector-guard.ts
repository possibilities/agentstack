import { Server, type IncomingMessage, type ServerResponse } from "node:http";
import { localBrowserResponse, localCookie, localOrigin, withLocalAuth } from "@agentstack/api";

// Pinned Inspector 2.7 injects its API credential in index.html. Guard every
// request BEFORE the dependency's router (including static/bootstrap responses).
// This preloader runs only in the owned Inspector process, not in its MCP tools.
const original = Server.prototype.emit;
const audienceOrigin = `http://127.0.0.1:${process.env.CLIENT_PORT ?? 6274}`;
const sessions = new Map<ServerResponse, () => void>();
const timer = setInterval(() => { for (const [response, check] of sessions) { try { check(); } catch { response.destroy(); sessions.delete(response); } } }, 250);
timer.unref();

Server.prototype.emit = function(event: string | symbol, ...args: any[]): boolean {
  if (event === "upgrade") { args[1].destroy(); return true; }
  if (event !== "request") return original.call(this, event, ...args);
  const [request, response] = args as [IncomingMessage, ServerResponse];
  const port = request.socket.localPort;
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` || !request.url?.startsWith("/") || request.url.startsWith("//")) { response.writeHead(403).end(); return true; }
  const url = new URL(request.url, `http://${host}`);
  const main = url.origin === audienceOrigin;
  if (main && url.pathname.startsWith("/connect/local")) {
    void (async () => {
      try {
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { response.writeHead(413).end(); return; } chunks.push(chunk); }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
        const result = await localBrowserResponse(new Request(url, { method: request.method, headers, ...(!["GET", "HEAD"].includes(request.method ?? "GET") ? { body: Buffer.concat(chunks) } : {}) }), process.env, "inspector");
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
      } catch { response.writeHead(401).end(); }
    })();
    return true;
  }
  try {
    localOrigin(url.origin);
    if (request.headers.origin && request.headers.origin !== audienceOrigin || !["GET", "HEAD"].includes(request.method ?? "") && request.headers.origin !== audienceOrigin) throw new Error("origin refused");
    const cookie = localCookie(request.headers.cookie, "inspector");
    const check = () => withLocalAuth(process.env, auth => auth.session(cookie, audienceOrigin, "inspector"));
    check();
    sessions.set(response, check); response.once("close", () => sessions.delete(response));
    response.setHeader("cache-control", "no-store"); response.setHeader("referrer-policy", "no-referrer");
    return original.call(this, event, ...args);
  } catch {
    if (main && request.method === "GET" && !url.pathname.startsWith("/api/")) response.writeHead(303, { location: "/connect/local", "cache-control": "no-store" }).end();
    else response.writeHead(401, { "cache-control": "no-store" }).end();
    return true;
  }
};
