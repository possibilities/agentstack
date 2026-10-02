import { NextResponse, type NextRequest } from "next/server";
import { localCookie, withLocalAuth } from "@stack/api";
import { randomBytes } from "node:crypto";
import { runtime, requireClientSession, ClientSessionError, clientSecurityHeaders, clientCsp } from "./lib/client/session";

function clientProxy(request: NextRequest) {
  const nonce = randomBytes(24).toString("base64");
  const csp = clientCsp(nonce);
  const secured = (response: NextResponse) => {
    for (const [key, value] of Object.entries(clientSecurityHeaders)) response.headers.set(key, value);
    response.headers.set("content-security-policy", csp);
    return response;
  };
  try {
    requireClientSession(request.headers, request.method, request.nextUrl.pathname + request.nextUrl.search, { exchange: true });
    const path = request.nextUrl.pathname;
    if (path === "/") return secured(NextResponse.redirect(new URL("/client", runtime.origin), 303));
    if (!(path === "/client" || path === "/client/local" || path.startsWith("/api/client/") || path.startsWith("/_next/static/")
      || path === "/connect/local" || path === "/connect/local/session" || path === "/connect/local/logout")) return secured(new NextResponse(null, { status: 404 }));
    const incoming = new Headers(request.headers);
    // Next extracts this nonce for its own inline and external scripts.
    incoming.set("content-security-policy", csp);
    return secured(NextResponse.next({ request: { headers: incoming } }));
  } catch (error) {
    const status = error instanceof ClientSessionError ? error.status : 401;
    if (status === 401 && request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate")
      return secured(NextResponse.redirect(new URL("/connect/local", runtime.origin), 303));
    return secured(new NextResponse("Client session required. Run stack-ui to reconnect.", { status }));
  }
}

/** The operator snapshot is private even before the WebSocket connects. */
export function proxy(request: NextRequest) {
  if (runtime.mode === "client") return clientProxy(request);
  const host = request.headers.get("host") ?? "";
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) {
    return new NextResponse(null, { status: 403 });
  }
  const origin = `http://${host}`;
  try {
    const incoming = request.headers;
    if ([...incoming.keys()].some(name => name.startsWith("x-stack-"))) {
      if (incoming.get("x-stack-remote-ui") !== "1") throw new Error("untrusted internal headers");
      withLocalAuth(process.env, auth => auth.verifyRemote(incoming.get("x-stack-ui-proof") ?? "", request.method,
        request.nextUrl.pathname + request.nextUrl.search, incoming.get("x-stack-ui-origin") ?? "",
        incoming.get("x-stack-ui-scope") ?? "", incoming.get("x-stack-ui-scopes") ?? ""));
    } else if (/^\/connect\/local(?:\/(?:session|ticket|logout))?$/.test(request.nextUrl.pathname)) {
      return NextResponse.next();
    } else {
      withLocalAuth(process.env, auth => auth.session(localCookie(incoming.get("cookie"), "ui"), origin, "ui"));
      if (incoming.get("origin") && incoming.get("origin") !== origin || !["GET", "HEAD"].includes(request.method) && incoming.get("origin") !== origin) throw new Error("origin refused");
    }
    const response = NextResponse.next();
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch {
    if (request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate") return NextResponse.redirect(new URL("/connect/local", origin), 303);
    return new NextResponse("Local authentication required. Run stack serve open.", { status: 401, headers: { "cache-control": "no-store" } });
  }
}
