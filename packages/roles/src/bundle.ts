import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname, basename, isAbsolute, relative, sep } from "node:path";
import { renderBotInstructions, type RoleSnapshot } from "./store.js";
import { mcpRecord, skillRecord, trustedProjectRecord, type RoleMcpServer, type TrustedProject } from "./resources.js";
import { mcpToolTimeoutSeconds, parseMcpBinding, mcpPort, type McpStdioLaunch } from "@stack/api";

const namePattern = /^[a-z][a-z0-9-]{0,31}$/;
const toml = (value: string) => JSON.stringify(value);
const inline = (values: Record<string, string>) => `{ ${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${toml(key)} = ${toml(value)}`).join(", ")} }`;

function mcpLines(server: RoleMcpServer): string[] {
  const definition = server.definition;
  const lines = [`[mcp_servers.${server.name}]`];
  if (definition.type === "http") {
    lines.push(`url = ${toml(definition.url)}`);
    if (definition.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${toml(definition.bearerTokenEnvVar)}`);
    if (definition.httpHeaders) lines.push(`http_headers = ${inline(definition.httpHeaders)}`);
    if (definition.envHttpHeaders) lines.push(`env_http_headers = ${inline(definition.envHttpHeaders)}`);
  } else {
    lines.push(`command = ${toml(definition.command)}`, `args = [${definition.args.map(toml).join(", ")}]`);
    if (definition.env) lines.push(`env = ${inline(definition.env)}`);
    if (definition.envVars) lines.push(`env_vars = [${definition.envVars.map(toml).join(", ")}]`);
  }
  return [...lines, "enabled = true", ""];
}

/** The owner's MCP listener as its loopback origins; a role MCP server must never address it. */
export function serverMcpOrigins(port: number): string[] {
  return ["127.0.0.1", "localhost", "[::1]"].map((host) => `http://${host}:${port}`);
}

/**
 * Why an enabled role MCP server would stop a Bot launch, or null. A disabled one never enters the
 * launch config, so it is never a conflict.
 */
export function roleMcpConflict(server: RoleMcpServer, ownerNames: ReadonlySet<string>, ownerOrigins: ReadonlySet<string>): string | null {
  if (!server.enabled) return null;
  if (ownerNames.has(server.name.toLowerCase())) return `role MCP server ${server.name} collides with an internal MCP server`;
  if (server.definition.type === "http") {
    const url = new URL(server.definition.url);
    // The configured origins fence the whole listener. Reserve its exact
    // loopback package paths too: an ephemeral or differently configured live
    // port must not let a Role reintroduce a disabled internal MCP via HTTP.
    const internalPath = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && ownerNames.has(/^\/mcp\/([^/]+)$/.exec(url.pathname)?.[1]?.toLowerCase() ?? "");
    if (ownerOrigins.has(url.origin) || internalPath) return `role MCP server ${server.name} cannot alias the internal MCP listener`;
  }
  return null;
}

/** The enabled trusted project roots that contain a canonical working directory. */
export function matchingProjects(snapshot: Pick<RoleSnapshot, "trustedProjects">, actualCwd: string): TrustedProject[] {
  return snapshot.trustedProjects.map((value) => trustedProjectRecord.parse(value)).filter((project) => {
    if (!project.enabled) return false;
    const child = relative(project.path, actualCwd);
    return !(child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child));
  });
}

/** The config.toml tables the Role itself contributes for its enabled MCP servers, exactly as a launch writes them. */
export function roleMcpConfig(snapshot: Pick<RoleSnapshot, "mcpServers">): string {
  return snapshot.mcpServers.map((value) => mcpRecord.parse(value)).filter((server) => server.enabled).flatMap(mcpLines).join("\n");
}

/** Codexnk reads SYSTEM_APPEND.md, config.toml and skills/ from --capabilities. */
export async function materializeRole(stateDir: string, botId: string, snapshot: RoleSnapshot, mcpServers: Readonly<Record<string, McpStdioLaunch>>, cwd?: string): Promise<string> {
  const rendered = renderBotInstructions(snapshot);
  const parent = join(stateDir, "roles", botId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "launch-"));
  try {
    await writeFile(join(root, "bot.md"), snapshot.botMarkdown ?? "", { mode: 0o600 });
    if (rendered) await writeFile(join(root, "SYSTEM_APPEND.md"), rendered, { mode: 0o600 });
    const lines: string[] = [];
    if (cwd) for (const project of matchingProjects(snapshot, await realpath(cwd))) lines.push(`[projects.${toml(project.path)}]`, 'trust_level = "trusted"', "");
    for (const [name, launch] of Object.entries(mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
      if (snapshot.disabledInternalMcpServers.includes(name)) continue;
      if (!namePattern.test(name) || launch.type !== "stdio" || !isAbsolute(launch.command) || launch.env.STACK_MCP_AUTHORITY !== "bot") throw new Error(`invalid owner MCP entry: ${name}`);
      const identity = parseMcpBinding(launch.env.STACK_MCP_BINDING ?? "", { STACK_STATE_DIR: stateDir });
      if (!("botId" in identity) || identity.botId !== botId) throw new Error(`owner MCP entry ${name} belongs to another bot`);
      lines.push(`[mcp_servers.${name}]`, `command = ${toml(launch.command)}`, `args = [${launch.args.map(toml).join(", ")}]`,
        `env = ${inline(launch.env)}`, "enabled = true", `tool_timeout_sec = ${mcpToolTimeoutSeconds(name)}`, "");
    }
    const ownerNames = new Set(Object.keys(mcpServers).map((name) => name.toLowerCase()));
    const ownerOrigins = new Set(Object.values(mcpServers).flatMap(launch => serverMcpOrigins(mcpPort(launch.env))));
    for (const value of snapshot.mcpServers) {
      const server = mcpRecord.parse(value);
      const conflict = roleMcpConflict(server, ownerNames, ownerOrigins);
      if (conflict) throw new Error(conflict);
      if (server.enabled) lines.push(...mcpLines(server));
    }
    await writeFile(join(root, "config.toml"), lines.join("\n"), { mode: 0o600 });
    await mkdir(join(root, "skills"), { mode: 0o700 });
    for (const value of snapshot.skills) {
      const skill = skillRecord.parse(value);
      if (!skill.enabled) continue;
      const directory = join(root, "skills", skill.name);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, "SKILL.md"), `---\nname: ${toml(skill.name)}\ndescription: ${toml(skill.description)}\n---\n\n${skill.body}\n`, { mode: 0o600 });
      for (const file of skill.files) {
        const path = join(directory, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, Buffer.from(file.contentBase64, "base64"), { mode: 0o600 });
      }
    }
    return root;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function removeRole(stateDir: string, botId: string, root: string): Promise<void> {
  const parent = dirname(root);
  if (![join(stateDir, "roles", botId), join(stateDir, "capabilities", botId)].includes(parent) || !basename(root).startsWith("launch-"))
    throw new Error("refusing to remove an unrecognized role launch snapshot");
  await rm(root, { recursive: true, force: true });
}
