import { botMcpUrl, configuredMcpServers } from "@stack/api";

/** Resolve the server's default MCP fleet at each bot launch. */
export async function serverMcpUrls(root: string, port: number, botId: string, endpoint: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await configuredMcpServers(root)).map(({ name }) => [name, botMcpUrl(`http://127.0.0.1:${port}/mcp/${name}`, botId, endpoint, env)]),
  );
}
