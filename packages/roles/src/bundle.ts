import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { renderInstructions, type RoleSnapshot } from "./store.js";

const namePattern = /^[a-z][a-z0-9-]{0,31}$/;

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
    await writeFile(join(root, "config.toml"), lines.join("\n"), { mode: 0o600 });
    await mkdir(join(root, "skills"), { mode: 0o700 });
    return root;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function removeRole(stateDir: string, botId: string, root: string): Promise<void> {
  const parent = dirname(root);
  if (![join(stateDir, "roles", botId), join(stateDir, "capabilities", botId)].includes(parent) || !basename(root).startsWith("launch-"))
    throw new Error("refusing to remove an unrecognized role launch snapshot");
  await rm(root, { recursive: true, force: true });
}
