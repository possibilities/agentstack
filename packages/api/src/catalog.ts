import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageEventTopics, type PackageApi } from "./operation.js";
import { publishedJsonSchema } from "./schema.js";
import { configuredTransports } from "./config.js";
import { resolveExposure, resolveWorkerExposure } from "./exposure.js";
import { listPackages, mcpPort, socketPath, websocketPort, workspaceRoot } from "./workspace.js";

export type CatalogTransport = {
  type: string;
  description: string;
  supported: boolean;
  subscriptions: boolean;
  endpoint: string | null;
  operations: string[];
  workerOperations: string[];
  events: string[];
  routes: Array<{
    surface: string; surfaceDescription: string; kind: "json" | "static"; authentication: "bearer" | "none";
    method: string; path: string; description: string; format: string; operation: string | null;
    inputSchema: Record<string, unknown> | null; querySchema: Record<string, unknown> | null;
    outputSchema: Record<string, unknown> | null; errorSchema: Record<string, unknown> | null;
  }>;
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
  eventScope: { description: string; example: string; required: boolean } | null;
  transports: CatalogTransport[];
};

export type Catalog = {
  servers: CatalogServer[];
};

export async function loadCatalog(env: NodeJS.ProcessEnv = process.env, from = import.meta.dirname): Promise<Catalog> {
  const root = workspaceRoot(from);
  const port = mcpPort(env);
  const wsPort = websocketPort(env);
  const packages = await listPackages(root);
  const servers: CatalogServer[] = [];
  for (const item of packages) {
    const api = await loadPackageApi(item.dir);
    if (Boolean(item.config.http) !== Boolean(api.http?.length))
      throw new Error(`${item.config.name} HTTP manifest and Package API surfaces disagree`);
    const manifest = JSON.parse(await readFile(join(item.dir, "package.json"), "utf8")) as { name?: string };
    const events = api.events ? packageEventTopics(item.config.name, api.events) : {};
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
      eventScope: api.events?.scope ? {
        description: api.events.scope.description,
        example: api.events.scope.example,
        required: api.events.scope.required ?? false,
      } : null,
      transports: configuredTransports(item.config).map((transport) => {
        if (transport.type === "http") {
          if (!api.http?.length) throw new Error(`${item.config.name} configures http without declared HTTP surfaces`);
          return {
            type: "http", description: transport.description, supported: true, subscriptions: false, endpoint: null,
            operations: [], workerOperations: [], events: [], routes: api.http.flatMap((surface) => surface.routes.map((route) => ({
              surface: surface.name, surfaceDescription: surface.description, kind: surface.kind, authentication: surface.authentication,
              method: route.method, path: route.path, description: route.description, format: route.format,
              operation: route.operation?.name ?? null,
              inputSchema: route.request ? publishedJsonSchema(route.request) : null,
              querySchema: route.query ? publishedJsonSchema(route.query) : null,
              outputSchema: route.response ? publishedJsonSchema(route.response) : null,
              errorSchema: route.error ? publishedJsonSchema(route.error) : null,
            }))),
          };
        }
        const exposure = resolveExposure(item.config, transport.type, api.operations.map((op) => op.name), Object.keys(events));
        const workerOperations = transport.type === "mcp" ? resolveWorkerExposure(item.config, api.operations, Object.keys(events)).operations : [];
        const base = { type: transport.type, description: transport.description, supported: true, ...exposure, workerOperations, routes: [] };
        const subscriptions = exposure.events.length > 0;
        if (transport.type === "socket") return { ...base, subscriptions, endpoint: socketPath(item.config.name, env) };
        if (transport.type === "websocket") return { ...base, subscriptions,
          endpoint: wsPort === 0 ? null : `ws://127.0.0.1:${wsPort}/websocket` };
        return { ...base, subscriptions, endpoint: port === 0 ? null : `http://127.0.0.1:${port}/mcp/${item.config.name}` };
      }),
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
