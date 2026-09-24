import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { renderInstructions, type RoleSnapshot } from "./store.js";
import { mcpRecord, skillRecord, type RoleMcpServer } from "./resources.js";

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

/** Codexnk reads SYSTEM_APPEND.md, config.toml and skills/ from --capabilities. */
export async function materializeRole(stateDir: string, botId: string, snapshot: RoleSnapshot, mcpServers: Readonly<Record<string, string>>): Promise<string> {
  const rendered = renderInstructions(snapshot);
  const parent = join(stateDir, "roles", botId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "launch-"));
  try {
    if (rendered) await writeFile(join(root, "SYSTEM_APPEND.md"), rendered, { mode: 0o600 });
    const lines: string[] = [];
    for (const [name, url] of Object.entries(mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
      if (!namePattern.test(name) || !/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-z][a-z0-9-]*$/.test(url))
        throw new Error(`invalid owner MCP entry: ${name}`);
      lines.push(`[mcp_servers.${name}]`, `url = ${JSON.stringify(url)}`, "enabled = true", "");
    }
    const ownerNames = new Set(Object.keys(mcpServers).map((name) => name.toLowerCase()));
    for (const value of snapshot.mcpServers) {
      const server = mcpRecord.parse(value);
      if (ownerNames.has(server.name.toLowerCase())) throw new Error(`role MCP server ${server.name} collides with an internal Package API`);
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
