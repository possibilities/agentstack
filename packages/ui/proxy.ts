import { NextResponse, type NextRequest } from "next/server";
import { localCookie, withLocalAuth } from "@agentstack/api";

/** The operator snapshot is private even before the WebSocket connects. */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) {
    return new NextResponse(null, { status: 403 });
  }
  const origin = `http://${host}`;
  try {
    const incoming = request.headers;
    if ([...incoming.keys()].some(name => name.startsWith("x-agentstack-"))) {
      if (incoming.get("x-agentstack-remote-ui") !== "1") throw new Error("untrusted internal headers");
      withLocalAuth(process.env, auth => auth.verifyRemote(incoming.get("x-agentstack-ui-proof") ?? "", request.method,
        request.nextUrl.pathname + request.nextUrl.search, incoming.get("x-agentstack-ui-origin") ?? "",
        incoming.get("x-agentstack-ui-scope") ?? "", incoming.get("x-agentstack-ui-scopes") ?? ""));
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
    return new NextResponse("Local authentication required. Run agentstack open.", { status: 401, headers: { "cache-control": "no-store" } });
  }
}
