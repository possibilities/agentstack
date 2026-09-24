import type { PackageApi } from "./operation.js";
import { packageEventTopics } from "./operation.js";
import { loadPackageApi } from "./catalog.js";
import { serveSocket, type ServedSocket, type SocketServerInfo } from "./socket.js";
import { serveWebSocket, type ServedWebSocket } from "./websocket.js";
import { assertTransport, findPackage, socketPath, workspaceRoot } from "./workspace.js";

export type ServedApi = {
  name: string;
  transport: "socket" | "websocket";
  socketPath?: string;
  websocketUrl?: string;
  publish?: (topic: string, scope?: string) => void;
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
  if (api.events && located.config.websocket?.pubsub && Object.keys(located.config.websocket.pubsub).length > 0) {
    throw new Error(`${options.name} declares both events and websocket.pubsub`);
  }
  if (api.events?.scope && located.config.websocket) {
    throw new Error(`${options.name} scoped events require a socket-only transport`);
  }
  const eventTopics = api.events ? packageEventTopics(options.name, api.events) : undefined;
  if (eventTopics && transport !== "socket" && transport !== "websocket") {
    throw new Error(`${options.name} events cannot be served over ${transport}`);
  }
  const publishTargets: Array<(topic: string, scope?: string) => void> = [];
  const publish = (topic: string, scope?: string): void => {
    for (const target of publishTargets) target(topic, scope);
  };
  let socket: ServedSocket | undefined;
  let websocket: ServedWebSocket | undefined;
  let stopEvents: (() => void) | void = undefined;
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
        events: eventTopics ? { topics: eventTopics, scope: api.events?.scope } : undefined,
      });
      if (socket.publish) publishTargets.push(socket.publish);
    }
    context = await api.createContext(env);
    contextCreated = true;
    if (api.events) {
      stopEvents = await api.events.start(context, publish);
    }
    resolveContext(context);
    if (websocketConfig) {
      websocket = await serveWebSocket({
        topics: eventTopics ?? websocketConfig.pubsub ?? {},
        origin: env.AGENTSTACK_WEBSOCKET_ORIGIN,
      });
      if (eventTopics && websocket.publish) publishTargets.push(websocket.publish);
      if (socketInfo) socketInfo.websocket = { url: websocket.url, topics: eventTopics ?? websocketConfig.pubsub ?? {} };
    }
    let closing: Promise<void> | undefined;
    return {
      name: located.config.name,
      transport,
      socketPath: socket?.path,
      websocketUrl: websocket?.url,
      publish: websocket?.publish ?? (publishTargets.length > 0 ? publish : undefined),
      close() {
        if (closing) return closing;
        closing = (async () => {
          let failure: unknown;
          for (const close of [
            () => stopEvents?.(),
            () => socket?.close(),
            () => websocket?.close(),
            () => api.closeContext(context, { halt: true }),
          ]) {
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
    try {
      await stopEvents?.();
    } catch {
    }
    rejectContext(error);
    await socket?.close().catch(() => undefined);
    await websocket?.close().catch(() => undefined);
    if (contextCreated) await api.closeContext(context, { halt: true }).catch(() => undefined);
    throw error;
  }
}
