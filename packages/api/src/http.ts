import { createServer, type Server, type RequestListener } from "node:http";
import { Readable } from "node:stream";
import { createServer as createHttpsServer } from "node:https";
import { assertInstallationOpen } from "./installation-fence.js";

/** Kernel socket facts. Never constructed from forwarding headers. */
export type HttpPeer = { remoteAddress: string; remotePort: number; localAddress: string };

/** One owner-local HTTP origin. Packages supply the route policy and response,
 * while the API package owns the HTTP listener, streaming and shutdown. */
export async function serveHttp(options: {
  host: string;
  port: number;
  handle(request: Request, peer: HttpPeer): Response | Promise<Response>;
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** Optional positive route selection for read-only static origins. A package
   * still owns rendering and redirects within these selected paths. */
  routes?: readonly { path: string }[];
  onError?: (error: unknown) => Response;
  requestTimeout?: number;
  headersTimeout?: number;
  forceCloseConnections?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  if (options.env) assertInstallationOpen(options.env);
  const listener: RequestListener = async (incoming, outgoing) => {
    try {
      if (options.env) assertInstallationOpen(options.env);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = incoming.method ?? "GET";
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : options.port;
      const host = options.host.includes(":") ? `[${options.host}]` : options.host;
      // Loopback is reachable by a browser after DNS rebinding. Validate the
      // actual Host before constructing our canonical internal Request URL.
      if (["127.0.0.1", "::1", "localhost"].includes(options.host)
        && ![`${host}:${port}`, `localhost:${port}`].includes(incoming.headers.host ?? "")) {
        outgoing.writeHead(403).end();
        return;
      }
      const request = new Request(`${options.tls ? "https" : "http"}://${host}:${port}${incoming.url ?? "/"}`, {
        method, headers,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }),
      });
      const pathname = new URL(request.url).pathname;
      const response = options.routes && ["GET", "HEAD"].includes(method) && !options.routes.some(({ path }) =>
        path.endsWith("/*") ? pathname.startsWith(path.slice(0, -1)) : pathname === path)
        ? new Response(null, { status: 404 }) : await options.handle(request, {
          remoteAddress: incoming.socket.remoteAddress ?? "", remotePort: incoming.socket.remotePort ?? 0,
          localAddress: incoming.socket.localAddress ?? "",
        });
      outgoing.writeHead(response.status, responseHeaders(response));
      if (!incoming.complete) outgoing.once("finish", () => incoming.destroy());
      if (response.body && method !== "HEAD") {
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
          .on("error", () => outgoing.destroy())
          .pipe(outgoing);
      } else outgoing.end();
    } catch (error) {
      if (!outgoing.headersSent && options.onError) {
        const response = options.onError(error);
        outgoing.writeHead(response.status, responseHeaders(response));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } else if (!outgoing.headersSent) outgoing.writeHead(500).end();
      else outgoing.destroy();
    }
  };
  const server = options.tls ? createHttpsServer(options.tls, listener) : createServer(listener);
  if (options.requestTimeout !== undefined) server.requestTimeout = options.requestTimeout;
  if (options.headersTimeout !== undefined) server.headersTimeout = options.headersTimeout;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("HTTP listener has no TCP address"); }
  return {
    server, port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      if (options.forceCloseConnections) server.closeAllConnections();
    }),
  };
}

function responseHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  return headers;
}
