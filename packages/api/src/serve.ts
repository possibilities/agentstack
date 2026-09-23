import type { PackageApi } from "./operation.js";
import { loadPackageApi } from "./catalog.js";
import { serveSocket } from "./socket.js";
import { assertTransport, findPackage, socketPath, workspaceRoot } from "./workspace.js";

export type ServedApi = {
  name: string;
  transport: "socket";
  socketPath: string;
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
    return {
      name: located.config.name,
      transport: "socket",
      socketPath: served.path,
      async close() {
        await api.closeContext(context, { halt: true });
        await served.close();
      },
    };
  } catch (error) {
    await api.closeContext(context, { halt: true }).catch(() => undefined);
    throw error;
  }
}
