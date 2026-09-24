import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { socketCall, socketPath } from "@agentstack/api";
import { mcpRecord, type RoleSnapshot } from "@agentstack/roles";

export type AcpMcp = { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> } |
  { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> };

async function executable(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = isAbsolute(command) ? [command] : command.includes("/") ? [resolve(cwd, command)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Role MCP executable is unavailable: ${command}`);
}

export async function roleSnapshot(env: NodeJS.ProcessEnv): Promise<RoleSnapshot> {
  return socketCall(socketPath("roles", env), "tools/call", { name: "role_snapshot", arguments: {} }, { timeoutMs: 5_000 }) as Promise<RoleSnapshot>;
}

export async function sessionMcpServers(snapshot: RoleSnapshot, env: NodeJS.ProcessEnv, supportsHttp: boolean, cwd: string): Promise<AcpMcp[]> {
  const owner = await socketCall(socketPath("owner", env), "tools/call", { name: "owner_status", arguments: {} }, { timeoutMs: 5_000 }) as { mcpUrls: Record<string, string> };
  const names = new Set<string>();
  const output: AcpMcp[] = [];
  for (const [name, url] of Object.entries(owner.mcpUrls)) {
    if (!supportsHttp) throw new Error("ACP agent cannot connect to the owner's HTTP Package APIs");
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== `/mcp/${name}` || parsed.search)
      throw new Error("owner reported an invalid internal MCP URL");
    names.add(name.toLowerCase());
    output.push({ type: "http", name, url, headers: [] });
  }
  for (const value of snapshot.mcpServers) {
    const item = mcpRecord.parse(value);
    if (!item.enabled) continue;
    if (names.has(item.name.toLowerCase())) throw new Error(`Role MCP server ${item.name} collides with an internal Package API`);
    names.add(item.name.toLowerCase());
    if (item.definition.type === "stdio") {
      const values = { ...item.definition.env };
      for (const key of item.definition.envVars ?? []) {
        if (env[key] === undefined) throw new Error(`Role MCP environment variable ${key} is unavailable`);
        values[key] = env[key];
      }
      output.push({ name: item.name, command: await executable(item.definition.command, cwd, env), args: item.definition.args,
        env: Object.entries(values).map(([name, value]) => ({ name, value })) });
    } else {
      if (!supportsHttp) throw new Error("ACP agent cannot connect to an HTTP Role MCP server");
      const headers: Record<string, string> = { ...item.definition.httpHeaders };
      if (item.definition.bearerTokenEnvVar) {
        const token = env[item.definition.bearerTokenEnvVar];
        if (!token) throw new Error("Role MCP bearer token is unavailable");
        headers.Authorization = `Bearer ${token}`;
      }
      for (const [name, key] of Object.entries(item.definition.envHttpHeaders ?? {})) {
        const header = env[key];
        if (header === undefined) throw new Error(`Role MCP header environment variable ${key} is unavailable`);
        headers[name] = header;
      }
      output.push({ type: "http", name: item.name, url: item.definition.url,
        headers: Object.entries(headers).map(([name, value]) => ({ name, value })) });
    }
  }
  return output;
}
