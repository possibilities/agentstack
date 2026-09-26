import type { PackageApi } from "./operation.js";
import { packageEventTopics } from "./operation.js";
import { loadPackageApi } from "./catalog.js";
import { serveSocket, type ServedSocket, type SocketServerInfo } from "./socket.js";
import { assertTransport, findPackage, socketPath, workspaceRoot } from "./workspace.js";

export type ServedApi = {
  name: string;
  transport: "socket";
  socketPath?: string;
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
  const api = await loadPackageApi(located.dir);
  const eventTopics = api.events ? packageEventTopics(options.name, api.events) : undefined;
  let socket: ServedSocket | undefined;
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
    }
    context = await api.createContext(env);
    contextCreated = true;
    if (api.events) {
      stopEvents = await api.events.start(context, (topic, scope) => socket?.publish?.(topic, scope));
    }
    resolveContext(context);
    let closing: Promise<void> | undefined;
    return {
      name: located.config.name,
      transport,
      socketPath: socket?.path,
      publish: socket?.publish,
      close() {
        if (closing) return closing;
        closing = (async () => {
          let failure: unknown;
          for (const close of [
            () => stopEvents?.(),
            () => api.prepareCloseContext?.(context, { halt: true }),
            () => socket?.close(),
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
    if (contextCreated) {
      try {
        await api.prepareCloseContext?.(context, { halt: true });
      } catch {
      }
    }
    await socket?.close().catch(() => undefined);
    if (contextCreated) await api.closeContext(context, { halt: true }).catch(() => undefined);
    throw error;
  }
}
