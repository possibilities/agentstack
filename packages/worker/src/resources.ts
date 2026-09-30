import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { internalMcpLaunches, socketCall, socketPath, workspaceRoot } from "@stack/api";
import { mcpRecord, roleMcpConflict, type RoleSnapshot } from "@stack/roles";

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

export async function roleSnapshot(env: NodeJS.ProcessEnv, roleId?: string): Promise<RoleSnapshot> {
  return socketCall(socketPath("roles", env), "tools/call", { name: "role_launch_snapshot", arguments: roleId ? { roleId } : { audience: "worker" } }, { timeoutMs: 5_000 }) as Promise<RoleSnapshot>;
}

export async function sessionMcpServers(snapshot: RoleSnapshot, env: NodeJS.ProcessEnv, supportsHttp: boolean, cwd: string,
  worker: { id: string; instance: string }): Promise<AcpMcp[]> {
  const server = await socketCall(socketPath("serve", env), "tools/call", { name: "serve_status", arguments: {} }, { timeoutMs: 5_000 }) as { mcpUrls: Record<string, string> };
  const launches = await internalMcpLaunches(workspaceRoot(import.meta.dirname), { kind: "worker", workerId: worker.id, instance: worker.instance }, env);
  const origins = new Set(Object.values(server.mcpUrls).map(url => new URL(url).origin));
  const names = new Set<string>();
  const output: AcpMcp[] = [];
  for (const [name, launch] of Object.entries(launches)) {
    names.add(name.toLowerCase());
    if (snapshot.disabledInternalMcpServers.includes(name)) continue;
    output.push({ name, command: launch.command, args: launch.args, env: Object.entries(launch.env).map(([name, value]) => ({ name, value })) });
  }
  for (const value of snapshot.mcpServers) {
    const item = mcpRecord.parse(value);
    if (!item.enabled) continue;
    const conflict = roleMcpConflict(item, names, origins);
    if (conflict) throw new Error(conflict);
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
