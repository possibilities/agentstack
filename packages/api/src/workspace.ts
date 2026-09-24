import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configuredTransports, isTransportType, readConfig, type PackageConfig, type TransportType } from "./config.js";

export function mcpPort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.AGENTSTACK_MCP_PORT;
  const port = value === undefined ? 8743 : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || value === "") {
    throw new Error("AGENTSTACK_MCP_PORT must be an integer from 0 to 65535");
  }
  return port;
}

export function workspaceRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("workspace root not found");
}

export function socketPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack");
  return join(root, "sockets", `${name}.sock`);
}

export type PackageLocation = {
  dir: string;
  config: PackageConfig;
};

export async function findPackage(root: string, name: string): Promise<PackageLocation> {
  const found = await listPackages(root);
  const match = found.find((item) => item.config.name === name);
  if (!match) throw new Error(`no package API named ${name}`);
  return match;
}

export async function listPackages(root: string): Promise<PackageLocation[]> {
  const packages = join(root, "packages");
  const names = await readdir(packages, { withFileTypes: true }).catch(() => []);
  const found: PackageLocation[] = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dir = join(packages, entry.name);
    const file = join(dir, "api.yaml");
    if (!existsSync(file)) continue;
    const config = await readConfig(file);
    if (config.name !== entry.name) {
      throw new Error(`${file}: name ${config.name} does not match directory ${entry.name}`);
    }
    if (found.some((item) => item.config.name === config.name)) {
      throw new Error(`duplicate package API name: ${config.name}`);
    }
    found.push({ dir, config });
  }
  return found.sort((a, b) => a.config.name.localeCompare(b.config.name));
}

export function transportEndpoint(
  config: PackageConfig,
  type: TransportType,
  env: NodeJS.ProcessEnv,
): { type: TransportType; description: string; available: boolean; endpoint?: string } {
  const transport = configuredTransports(config).find((item) => item.type === type);
  if (!transport) throw new Error(`${config.name} does not configure ${type}`);
  if (type === "socket") {
    return { type, description: transport.description, available: true, endpoint: socketPath(config.name, env) };
  }
  if (type === "websocket") {
    return { type, description: transport.description, available: true };
  }
  const port = mcpPort(env);
  return { type, description: transport.description, available: true, endpoint: port ? `http://127.0.0.1:${port}/mcp/${config.name}` : undefined };
}

export function assertTransport(name: string, config: PackageConfig, transport: string): "socket" | "websocket" {
  if (!isTransportType(transport)) throw new Error(`unknown transport: ${transport}`);
  if (!config[transport]) throw new Error(`${name} does not configure ${transport}`);
  if (transport === "mcp") throw new Error("mcp is served together for all configured Package APIs; run agentstack mcp");
  return transport;
}
