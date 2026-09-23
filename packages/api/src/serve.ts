import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PackageApi } from "./operation.js";
import { loadPackageApi } from "./catalog.js";
import { serveSocket, type ServedSocket } from "./socket.js";
import { assertTransport, findPackage, socketPath, workspaceRoot } from "./workspace.js";

export const defaultDataPort = 39231;

export type ServedApi = {
  name: string;
  transport: "socket";
  socketPath: string;
  url?: string;
  port?: number;
  close(): Promise<void>;
};

export async function serveApi(options: {
  name: string;
  transport: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  root?: string;
  from?: string;
}): Promise<ServedApi> {
  const env = options.env ?? process.env;
  const root = options.root ?? workspaceRoot(options.from ?? import.meta.dirname);
  const located = await findPackage(root, options.name);
  assertTransport(options.name, located.config, options.transport);
  const socketTransport = located.config.socket;
  if (!socketTransport) throw new Error(`${options.name} does not configure socket`);
  const api = await loadPackageApi(located.dir);
  const context = await api.createContext(env);
  try {
    const served = await serveSocket({
      info: {
        name: located.config.name,
        description: located.config.description,
        transportDescription: socketTransport.description,
        path: socketPath(located.config.name, env),
      },
      context,
      operations: api.operations,
    });
    let http: HttpServer | undefined;
    try {
      if (api.uiData) {
        const port = dataPort(options.port, env);
        http = await startUiData(port, (url) => api.uiData?.(context, url) ?? Promise.resolve({}));
      }
    } catch (error) {
      await served.close();
      throw error;
    }
    return finish(located.config.name, served, http, () => api.closeContext(context, { halt: true }));
  } catch (error) {
    await api.closeContext(context, { halt: true }).catch(() => undefined);
    throw error;
  }
}

function finish(name: string, socket: ServedSocket, http: HttpServer | undefined, halt: () => Promise<void>): ServedApi {
  const address = http?.address();
  const port = address && typeof address !== "string" ? address.port : undefined;
  let closed = false;
  return {
    name,
    transport: "socket",
    socketPath: socket.path,
    port,
    url: port === undefined ? undefined : `http://127.0.0.1:${port}/ui-data`,
    async close() {
      if (closed) return;
      closed = true;
      http?.closeAllConnections();
      await halt();
      await socket.close();
      if (http) await closeHttp(http);
    },
  };
}

function dataPort(port: number | undefined, env: NodeJS.ProcessEnv): number {
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
    return port;
  }
  if (env.AGENTSTACK_PORT === undefined || env.AGENTSTACK_PORT === "") return defaultDataPort;
  const parsed = Number(env.AGENTSTACK_PORT);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid AGENTSTACK_PORT: ${env.AGENTSTACK_PORT}`);
  }
  return parsed;
}

function startUiData(port: number, data: (url: URL) => Promise<unknown>): Promise<HttpServer> {
  const http = createServer((req, res) => {
    void respond(req, res, data);
  });
  return new Promise((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") reject(new Error(`agentstack is already listening on 127.0.0.1:${port}`));
      else reject(error);
    });
    http.listen(port, "127.0.0.1", () => resolve(http));
  });
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  data: (url: URL) => Promise<unknown>,
): Promise<void> {
  const host = req.headers.host?.replace(/:\d+$/, "") ?? "";
  if (host !== "127.0.0.1" && host !== "localhost") {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/ui-data") {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = JSON.stringify(await data(url));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
  } catch {
    if (!res.headersSent) res.writeHead(500).end();
  }
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
