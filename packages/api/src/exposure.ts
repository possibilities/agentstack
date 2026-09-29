import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PackageConfig, TransportConfig } from "./config.js";
import { socketCall } from "./socket.js";
import { findPackage, socketPath } from "./workspace.js";

export type Exposure = { operations: string[]; events: string[] };
export type SocketCatalog = {
  tools: Tool[];
  events: { topics: Record<string, string>; scope?: { description: string; example: string; required: boolean } } | null;
};

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
  return { ...catalog, tools: catalog.tools.filter((tool) => exposure.operations.includes(tool.name)),
    events: catalog.events && exposure.events.length ? { ...catalog.events,
      topics: Object.fromEntries(Object.entries(catalog.events.topics).filter(([name]) => exposure.events.includes(name))),
    } : null };
}

/** A positive disclosure selection, intersected with MCP availability. Read-only
 * annotations validate intent; they never add operations to this selection. */
export function resolveWorkerExposure(config: PackageConfig,
  tools: ReadonlyArray<{ name: string; annotations?: { readOnlyHint?: boolean } }>, events: readonly string[] = []): Exposure {
  const mcp = resolveExposure(config, "mcp", tools.map(tool => tool.name), events);
  const selected = select(config.mcp!.workerOperations, tools.map(tool => tool.name), `${config.name} mcp workerOperations`);
  for (const name of selected) if (tools.find(tool => tool.name === name)?.annotations?.readOnlyHint !== true)
    throw new Error(`${config.name} mcp workerOperations selects non-read-only operation: ${name}`);
  return { operations: selected.filter(name => mcp.operations.includes(name)), events: [] };
}

/** The live socket is authoritative; gateways never import or instantiate a Package API. */
export async function socketExposure(config: PackageConfig, transport: "mcp" | "websocket", env: NodeJS.ProcessEnv) {
  const catalog = await readSocketCatalog(config.name, env);
  const exposure = resolveExposure(config, transport, catalog.tools.map((tool) => tool.name), Object.keys(catalog.events?.topics ?? {}));
  const workerExposure = transport === "mcp" ? resolveWorkerExposure(config, catalog.tools, Object.keys(catalog.events?.topics ?? {})) : undefined;
  return { exposure, workerExposure, catalog: exposeCatalog(catalog, exposure) };
}

export async function currentMcpCatalog(root: string, pkg: string, env: NodeJS.ProcessEnv): Promise<SocketCatalog> {
  // Unlike admitted requests/connections, durable watches need the latest policy
  // after the metadata read: a slow upstream must not retain an old selection.
  const catalog = await readSocketCatalog(pkg, env);
  const { config } = await findPackage(root, pkg);
  resolveWorkerExposure(config, catalog.tools, Object.keys(catalog.events?.topics ?? {}));
  return exposeCatalog(catalog, resolveExposure(config, "mcp", catalog.tools.map((tool) => tool.name), Object.keys(catalog.events?.topics ?? {})));
}

export async function currentWorkerCatalog(root: string, pkg: string, env: NodeJS.ProcessEnv): Promise<SocketCatalog> {
  const catalog = await readSocketCatalog(pkg, env);
  const { config } = await findPackage(root, pkg);
  return exposeCatalog(catalog, resolveWorkerExposure(config, catalog.tools, Object.keys(catalog.events?.topics ?? {})));
}

function readSocketCatalog(pkg: string, env: NodeJS.ProcessEnv): Promise<SocketCatalog> {
  return socketCall(socketPath(pkg, env), "tools/list", {}, { timeoutMs: 5_000 }) as Promise<SocketCatalog>;
}
