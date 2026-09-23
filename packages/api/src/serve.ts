import type { PackageApi } from "./operation.js";
import { loadPackageApi } from "./catalog.js";
import { serveSocket, type ServedSocket } from "./socket.js";
import { serveWebSocket, type ServedWebSocket } from "./websocket.js";
import { assertTransport, findPackage, socketPath, workspaceRoot } from "./workspace.js";

export type ServedApi = {
  name: string;
  transport: "socket" | "websocket";
  socketPath?: string;
  websocketUrl?: string;
  publish?: (topic: string) => void;
  close(): Promise<void>;
};

export async function serveApi(options: {
  name: string;
  transport: string;
  env?: NodeJS.ProcessEnv;
  root?: string;
  from?: string;
}): Promise<ServedApi> {
  const env = options.env ?? process.env;
  const root = options.root ?? workspaceRoot(options.from ?? import.meta.dirname);
  const located = await findPackage(root, options.name);
  const transport = assertTransport(options.name, located.config, options.transport);
  if (transport === "websocket" && located.config.socket) {
    throw new Error(`${options.name} websocket is served alongside its socket transport`);
  }
  const api = await loadPackageApi(located.dir);
  const context = await api.createContext(env);
  let socket: ServedSocket | undefined;
  let websocket: ServedWebSocket | undefined;
  try {
    const websocketConfig = located.config.websocket;
    if (websocketConfig) {
      websocket = await serveWebSocket({
        topics: websocketConfig.pubsub ?? {},
        origin: env.AGENTSTACK_UI_ORIGIN,
        subscribe: api.subscribe ? (publish) => api.subscribe!(context, publish) : undefined,
      });
    }
    if (transport === "socket") {
      const socketTransport = located.config.socket;
      if (!socketTransport) throw new Error(`${options.name} does not configure socket`);
      socket = await serveSocket({
        info: {
          name: located.config.name,
          description: located.config.description,
          transportDescription: socketTransport.description,
          path: socketPath(located.config.name, env),
          websocket: websocket ? { url: websocket.url, topics: websocketConfig?.pubsub ?? {} } : undefined,
        },
        context,
        operations: api.operations,
      });
    }
    let closed = false;
    return {
      name: located.config.name,
      transport,
      socketPath: socket?.path,
      websocketUrl: websocket?.url,
      publish: websocket?.publish,
      async close() {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([
          api.closeContext(context, { halt: true }),
          socket?.close(),
          websocket?.close(),
        ]);
        const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
        if (failure) throw failure.reason;
      },
    };
  } catch (error) {
    await socket?.close().catch(() => undefined);
    await websocket?.close().catch(() => undefined);
    await api.closeContext(context, { halt: true }).catch(() => undefined);
    throw error;
  }
}
