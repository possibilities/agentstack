import { internalMcpLaunches, type McpStdioLaunch } from "@stack/api";

/** Resolve the server's default MCP fleet at each bot launch. */
export async function serverMcpLaunches(root: string, port: number, botId: string, endpoint: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, McpStdioLaunch>> {
  return internalMcpLaunches(root, { kind: "bot", botId, endpoint }, { ...env, STACK_MCP_PORT: String(port) });
}
