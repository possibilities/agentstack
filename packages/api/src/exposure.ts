import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PackageConfig, TransportConfig } from "./config.js";
import { socketCall } from "./socket.js";
import { findPackage, socketPath } from "./workspace.js";
import { loadPackageApi } from "./catalog.js";
import { packageEventTopics, type CompletionWatch } from "./operation.js";
import { publishedJsonSchema } from "./schema.js";
import type { EventSource } from "./occurrence.js";

export type Exposure = { operations: string[]; events: string[] };
export type SocketCatalog = {
  tools: Array<Tool & { completionWatch?: CompletionWatch; eventSource?: EventSource }>;
  events: { topics: Record<string, string>; scope?: { description: string; example: string; required: boolean } } | null;
};

export function declaredEventNames(topics: Record<string, string>, tools: ReadonlyArray<{ eventSource?: EventSource }>): string[] {
  const names = [...Object.keys(topics), ...tools.flatMap(tool => tool.eventSource ? [tool.eventSource.name] : [])];
  if (new Set(names).size !== names.length) throw new Error("duplicate invalidation/occurrence event name");
  return names;
}

function select(selection: TransportConfig["operations"], names: readonly string[], label: string): string[] {
  if (selection === "all") return [...names];
  const seen = new Set<string>();
  for (const name of selection) {
    if (seen.has(name)) throw new Error(`${label} selects duplicate name: ${name}`);
    if (!names.includes(name)) throw new Error(`${label} selects unknown name: ${name}`);
    seen.add(name);
  }
  return names.filter((name) => seen.has(name));
}

/** Resolve explicit selections against declarations, never against handler contexts. */
export function resolveExposure(config: PackageConfig, transport: "socket" | "mcp" | "websocket",
  operations: readonly string[], events: readonly string[]): Exposure {
  const declaration = config[transport];
  if (!declaration) throw new Error(`${config.name} does not configure ${transport}`);
  if (transport === "socket") return { operations: [...operations], events: [...events] };
  const selected = declaration as TransportConfig;
  return {
    operations: select(selected.operations, operations, `${config.name} ${transport} operations`),
    events: select(selected.events, events, `${config.name} ${transport} events`),
  };
}

export function exposeCatalog(catalog: SocketCatalog, exposure: Exposure): SocketCatalog {
  return { ...catalog, tools: catalog.tools.filter((tool) => exposure.operations.includes(tool.name)).map(tool => {
    const { eventSource, ...ordinary } = tool;
    return eventSource && exposure.events.includes(eventSource.name) ? tool : ordinary;
  }),
    events: catalog.events && exposure.events.length ? { ...catalog.events,
      topics: Object.fromEntries(Object.entries(catalog.events.topics).filter(([name]) => exposure.events.includes(name))),
    } : null };
}

/** A positive disclosure selection, intersected with MCP availability. Read-only
 * annotations validate intent; they never add operations to this selection. */
export function resolveWorkerExposure(config: PackageConfig,
   tools: ReadonlyArray<{ name: string; annotations?: { readOnlyHint?: boolean }; eventSource?: EventSource }>, events: readonly string[] = []): Exposure {
  const mcp = resolveExposure(config, "mcp", tools.map(tool => tool.name), events);
  const selected = select(config.mcp!.workerOperations, tools.map(tool => tool.name), `${config.name} mcp workerOperations`);
  for (const name of selected) if (tools.find(tool => tool.name === name)?.annotations?.readOnlyHint !== true)
    throw new Error(`${config.name} mcp workerOperations selects non-read-only operation: ${name}`);
  const sources = tools.filter(tool => tool.eventSource);
  const workerEvents = select(config.mcp!.workerEvents, sources.map(tool => tool.eventSource!.name), `${config.name} mcp workerEvents`)
    .filter(name => mcp.events.includes(name) && sources.some(tool => tool.eventSource!.name === name && mcp.operations.includes(tool.name)));
  const eventReads = sources.filter(tool => workerEvents.includes(tool.eventSource!.name));
  for (const tool of eventReads) if (tool.annotations?.readOnlyHint !== true) throw new Error("occurrence poll must be read-only");
  return { operations: [...new Set([...selected, ...eventReads.map(tool => tool.name)])].filter(name => mcp.operations.includes(name)), events: workerEvents };
}

/** External HTTP and WebSocket admission validates the live socket catalog
 * without importing declarations or creating a Package API context. */
export async function socketExposure(config: PackageConfig, transport: "mcp" | "websocket", env: NodeJS.ProcessEnv) {
  const catalog = await readSocketCatalog(config.name, env);
  const names = transport === "mcp" ? declaredEventNames(catalog.events?.topics ?? {}, catalog.tools) : Object.keys(catalog.events?.topics ?? {});
  const exposure = resolveExposure(config, transport, catalog.tools.map((tool) => tool.name), names);
  const workerExposure = transport === "mcp" ? resolveWorkerExposure(config, catalog.tools, names) : undefined;
  return { exposure, workerExposure, catalog: exposeCatalog(catalog, exposure) };
}

export async function currentMcpCatalog(root: string, pkg: string, env: NodeJS.ProcessEnv): Promise<SocketCatalog> {
  // Unlike admitted requests/connections, durable watches need the latest policy
  // after the metadata read: a slow upstream must not retain an old selection.
  const catalog = await readSocketCatalog(pkg, env);
  const { config } = await findPackage(root, pkg);
  const names = declaredEventNames(catalog.events?.topics ?? {}, catalog.tools);
  resolveWorkerExposure(config, catalog.tools, names);
  return exposeCatalog(catalog, resolveExposure(config, "mcp", catalog.tools.map((tool) => tool.name), names));
}

export async function currentWorkerCatalog(root: string, pkg: string, env: NodeJS.ProcessEnv): Promise<SocketCatalog> {
  const catalog = await readSocketCatalog(pkg, env);
  const { config } = await findPackage(root, pkg);
  return exposeCatalog(catalog, resolveWorkerExposure(config, catalog.tools, declaredEventNames(catalog.events?.topics ?? {}, catalog.tools)));
}

function readSocketCatalog(pkg: string, env: NodeJS.ProcessEnv): Promise<SocketCatalog> {
  return socketCall(socketPath(pkg, env), "tools/list", {}, { timeoutMs: 5_000 }) as Promise<SocketCatalog>;
}

/** Internal stdio uses installed declarations, without service admission or a
 * package context. HTTP, WebSocket and durable event owners retain live reads. */
export async function installedMcpCatalog(root: string, pkg: string) {
  const { config, dir } = await findPackage(root, pkg);
  const api = await loadPackageApi(dir);
  const topics = api.events ? packageEventTopics(pkg, api.events) : {};
  const catalog: SocketCatalog = {
    tools: api.operations.map(op => ({ name: op.name, description: op.description,
      inputSchema: publishedJsonSchema(op.input) as SocketCatalog["tools"][number]["inputSchema"],
      outputSchema: publishedJsonSchema(op.output) as SocketCatalog["tools"][number]["outputSchema"], annotations: op.annotations ?? {},
       ...(op.completionWatch ? { completionWatch: op.completionWatch } : {}), ...(op.eventSource ? { eventSource: op.eventSource } : {}) })),
    events: api.events ? { topics, ...(api.events.scope ? { scope: {
      description: api.events.scope.description, example: api.events.scope.example, required: api.events.scope.required ?? false,
    } } : {}) } : null,
  };
  const names = declaredEventNames(topics, catalog.tools);
  const exposure = resolveExposure(config, "mcp", catalog.tools.map(tool => tool.name), names);
  const workerExposure = resolveWorkerExposure(config, catalog.tools, names);
  return { api, catalog: exposeCatalog(catalog, exposure), workerCatalog: exposeCatalog(catalog, workerExposure), exposure };
}
