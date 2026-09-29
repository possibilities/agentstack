import { botMcpUrl, configuredMcpPackages } from "@stack/api";

/** Resolve the server's current exposed Package APIs at each bot launch. */
export async function serverMcpUrls(root: string, port: number, botId: string, endpoint: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await configuredMcpPackages(root)).map(({ name }) => [name, botMcpUrl(`http://127.0.0.1:${port}/mcp/${name}`, botId, endpoint, env)]),
  );
}
