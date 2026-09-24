import { configuredMcpPackages } from "@agentstack/api";

/** Resolve the owner's current exposed Package APIs at each Server launch. */
export async function ownerMcpUrls(root: string, port: number): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await configuredMcpPackages(root)).map(({ name }) => [name, `http://127.0.0.1:${port}/mcp/${name}`]),
  );
}
