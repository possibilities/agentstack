import { localBrowserResponse } from "@stack/api";
import { runtime, requireClientSession, ClientSessionError, clientSecurityHeaders } from "@/lib/client/session";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => {
  if (runtime.mode !== "client") return localBrowserResponse(request, process.env, "ui");
  try {
    requireClientSession(request.headers, request.method, undefined, { exchange: true });
    return localBrowserResponse(request, { STACK_STATE_DIR: runtime.root, NODE_ENV: process.env.NODE_ENV }, "ui", {
      cookieName: runtime.cookieName, surface: "client",
      nonce: request.headers.get("content-security-policy")?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1],
    });
  } catch (error) {
    return new Response("Client session required. Run stack-ui to reconnect.", {
      status: error instanceof ClientSessionError ? error.status : 401, headers: clientSecurityHeaders,
    });
  }
};
export const POST = GET;
