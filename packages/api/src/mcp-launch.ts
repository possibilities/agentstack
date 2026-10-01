import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { botMcpUrl, workerMcpUrl } from "./bot-mcp-identity.js";
import { withLocalAuth } from "./local-auth.js";
import { stateDir, workspaceRoot } from "./workspace.js";
import { configuredMcpServers } from "./mcp.js";

export type McpStdioLaunch = { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
export type McpLaunchAuthority = { kind: "bot"; botId: string; endpoint: string } |
  { kind: "worker"; workerId: string; instance: string } | { kind: "operator" };

/** Private launch config only: env values contain authority and never belong in discovery. */
export async function internalMcpLaunches(root: string, authority: McpLaunchAuthority, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, McpStdioLaunch>> {
  const binding = authority.kind === "bot" ? new URL(botMcpUrl("stack://mcp", authority.botId, authority.endpoint, env)).search.slice(1)
    : authority.kind === "worker" ? new URL(workerMcpUrl("stack://mcp", authority.workerId, authority.instance, env)).search.slice(1) : "";
  const home = env.HOME ?? homedir();
  const values: Record<string, string> = {
    STACK_STATE_DIR: resolve(stateDir(env)), STACK_MCP_ROOT: resolve(root), STACK_MCP_AUTHORITY: authority.kind,
    STACK_MCP_BINDING: binding, STACK_MCP_OPERATOR: authority.kind === "operator" ? withLocalAuth(env, auth => `Bearer ${auth.credential("stdio")}`) : "",
    // Harnesses may replace HOME and PATH. Bridges still use the operator's installation.
    HOME: home, STACK_CODEX_TOOLS_HOME: env.STACK_CODEX_TOOLS_HOME ?? join(home, ".codex"),
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? join(home, ".config"),
    XDG_DATA_HOME: env.XDG_DATA_HOME ?? join(home, ".local", "share"),
    XDG_STATE_HOME: env.XDG_STATE_HOME ?? join(home, ".local", "state"),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME ?? join(home, ".cache"),
  };
  for (const key of ["PATH", "TMPDIR", "STACK_CODEX_TOOLS_BIN", "STACK_MCP_PORT", "STACK_SERVER_MCP_PORT",
    "STACK_CONTENT_HOST", "STACK_CONTENT_PORT", "STACK_CONTENT_ARTIFACT_PORT", "STACK_WIKI_PORT", "STACK_WIKI_ARTIFACT_PORT",
    "STACK_CONTENT_DOCUMENT_ORIGIN", "STACK_CONTENT_ARTIFACT_ORIGIN"])
    if (env[key] !== undefined) values[key] = env[key];
  return Object.fromEntries((await configuredMcpServers(root)).map(({ name }) => [name, {
    type: "stdio", command: process.execPath,
    args: [join(workspaceRoot(import.meta.dirname), "packages/api/dist/src/stdio-main.js"), name], env: { ...values },
  }]));
}
