import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageEventTopics, type PackageApi } from "./operation.js";
import { publishedJsonSchema } from "./schema.js";
import { configuredTransports } from "./config.js";
import { listPackages, socketPath, workspaceRoot } from "./workspace.js";

export type CatalogTransport = {
  type: string;
  description: string;
  supported: boolean;
  subscriptions: boolean;
  endpoint: string | null;
};

export type CatalogOperation = {
  name: string;
  title?: string;
  description: string;
  annotations: Record<string, boolean | string>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

export type CatalogServer = {
  name: string;
  description: string;
  packageName: string;
  operations: CatalogOperation[];
  events: Record<string, string>;
  transports: CatalogTransport[];
};

export type Catalog = {
  servers: CatalogServer[];
};

export async function loadCatalog(env: NodeJS.ProcessEnv = process.env, from = import.meta.dirname): Promise<Catalog> {
  const root = workspaceRoot(from);
  const packages = await listPackages(root);
  const servers: CatalogServer[] = [];
  for (const item of packages) {
    const api = await loadPackageApi(item.dir);
    const manifest = JSON.parse(await readFile(join(item.dir, "package.json"), "utf8")) as { name?: string };
    const events = api.events ? packageEventTopics(item.config.name, api.events) : (item.config.websocket?.pubsub ?? {});
    servers.push({
      name: item.config.name,
      description: item.config.description,
      packageName: manifest.name || basename(item.dir),
      operations: api.operations.map((operation) => ({
        name: operation.name,
        title: operation.annotations?.title,
        description: operation.description,
        annotations: annotationsOf(operation.annotations),
        inputSchema: publishedJsonSchema(operation.input),
        outputSchema: publishedJsonSchema(operation.output),
      })),
      events,
      transports: configuredTransports(item.config).map((transport) =>
        transport.type === "socket"
          ? {
              type: transport.type,
              description: transport.description,
              supported: true,
              subscriptions: api.events !== undefined,
              endpoint: socketPath(item.config.name, env),
            }
          : transport.type === "websocket"
            ? {
                type: transport.type,
                description: transport.description,
                supported: true,
                subscriptions: api.events !== undefined || Object.keys(item.config.websocket?.pubsub ?? {}).length > 0,
                endpoint: null,
              }
            : { type: transport.type, description: transport.description, supported: false, subscriptions: false, endpoint: null },
      ),
    });
  }
  return { servers };
}

const importRuntimeFile = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<{ api?: PackageApi<unknown> }>;

export async function loadPackageApi(dir: string): Promise<PackageApi<unknown>> {
  const entry = join(dir, "dist", "api.js");
  try {
    await stat(entry);
  } catch {
    throw new Error(`${basename(dir)} API is not built`);
  }
  const loaded = await importRuntimeFile(pathToFileURL(entry).href);
  if (!loaded.api || !Array.isArray(loaded.api.operations)) throw new Error(`${basename(dir)} does not export api`);
  return loaded.api;
}

function annotationsOf(annotations: PackageApi<unknown>["operations"][number]["annotations"]): Record<string, boolean | string> {
  if (!annotations) return {};
  const entries = Object.entries(annotations).filter((entry): entry is [string, boolean | string] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}
