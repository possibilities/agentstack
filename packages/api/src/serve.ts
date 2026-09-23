import type { PackageApi } from "./operation.js";
import { loadPackageApi } from "./catalog.js";
import { serveSocket, type ServedSocket, type SocketServerInfo } from "./socket.js";
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
  let socket: ServedSocket | undefined;
  let websocket: ServedWebSocket | undefined;
  let context: unknown;
  let contextCreated = false;
  let resolveContext: (value: unknown) => void = () => undefined;
  let rejectContext: (error: unknown) => void = () => undefined;
  const contextReady = new Promise<unknown>((resolve, reject) => {
    resolveContext = resolve;
    rejectContext = reject;
  });
  // Context initialization may fail before any socket request awaits it.
  void contextReady.catch(() => undefined);
  let socketInfo: SocketServerInfo | undefined;
  try {
    const websocketConfig = located.config.websocket;
    if (transport === "socket") {
      const socketTransport = located.config.socket;
      if (!socketTransport) throw new Error(`${options.name} does not configure socket`);
      socketInfo = {
        name: located.config.name,
        description: located.config.description,
        transportDescription: socketTransport.description,
        path: socketPath(located.config.name, env),
      };
      // Socket ownership must be established before a package context can
      // inspect or reap persisted processes.
      socket = await serveSocket({
        info: socketInfo,
        context: contextReady,
        operations: api.operations,
      });
    }
    context = await api.createContext(env);
    contextCreated = true;
    resolveContext(context);
    if (websocketConfig) {
      websocket = await serveWebSocket({
        topics: websocketConfig.pubsub ?? {},
        origin: env.AGENTSTACK_UI_ORIGIN,
        subscribe: api.subscribe ? (publish) => api.subscribe!(context, publish) : undefined,
      });
      if (socketInfo) socketInfo.websocket = { url: websocket.url, topics: websocketConfig.pubsub ?? {} };
    }
    let closing: Promise<void> | undefined;
    return {
      name: located.config.name,
      transport,
      socketPath: socket?.path,
      websocketUrl: websocket?.url,
      publish: websocket?.publish,
      close() {
        if (closing) return closing;
        closing = (async () => {
          let failure: unknown;
          for (const close of [() => socket?.close(), () => websocket?.close(), () => api.closeContext(context, { halt: true })]) {
            try {
              await close();
            } catch (error) {
              failure ??= error;
            }
          }
          if (failure !== undefined) throw failure;
        })();
        return closing;
      },
    };
  } catch (error) {
    rejectContext(error);
    await socket?.close().catch(() => undefined);
    await websocket?.close().catch(() => undefined);
    if (contextCreated) await api.closeContext(context, { halt: true }).catch(() => undefined);
    throw error;
  }
}
