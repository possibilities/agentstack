import { createServer } from "node:http";
import { assertInstallationOpen } from "./installation-fence.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { listPackages, mcpPort, workspaceRoot } from "./workspace.js";
import { parseBotMcpIdentity, parseWorkerMcpIdentity } from "./bot-mcp-identity.js";
import type { McpEventSubscriptions } from "./mcp-subscriptions.js";
import { socketExposure } from "./exposure.js";
import { LocalAuth } from "./local-auth.js";
import { codexMcpServers, codexMcpDefinition } from "./codex-mcp/catalog.js";
import { CodexMcpHttp } from "./codex-mcp/http.js";
import { verifyMcpIdentity, type McpIdentity } from "./mcp-authority.js";
import { packageMcpServer } from "./mcp-package.js";
import { subscriptionService } from "./mcp-events.js";

export type ServedMcp = { port: number; urls: Record<string, string>; close(): Promise<void> };

export async function configuredMcpPackages(root: string): Promise<Array<{ name: string; description: string }>> {
  return (await listPackages(root)).filter(item => item.config.mcp).map(item => ({ name: item.config.name, description: item.config.description }));
}

/** The default MCP fleet: Package APIs, then the Codex tool bridges. */
export async function configuredMcpServers(root: string): Promise<Array<{ name: string; title: string; description: string; kind: "package" | "codex" }>> {
  const packages = await configuredMcpPackages(root);
  if (packages.some(pkg => codexMcpDefinition(pkg.name))) throw new Error("Package API name collides with a built-in Codex MCP server");
  return [...packages.map(pkg => ({ ...pkg, title: pkg.name, kind: "package" as const })),
    ...codexMcpServers.map(({ name, title, description }) => ({ name, title, description, kind: "codex" as const }))];
}

/** External HTTP ingress. Internal launches use the same handlers over stdio. */
export async function serveMcp(options: { env?: NodeJS.ProcessEnv; root?: string; port?: number; subscriptions?: McpEventSubscriptions } = {}): Promise<ServedMcp> {
  const env = options.env ?? process.env;
  assertInstallationOpen(env);
  const port = options.port ?? mcpPort(env);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MCP port must be an integer from 0 to 65535");
  const root = options.root ?? workspaceRoot(import.meta.dirname);
  const packages = await configuredMcpServers(root);
  const auth = new LocalAuth(env);
  const codex = new CodexMcpHttp(env);
  const events = options.subscriptions ? subscriptionService(options.subscriptions, root, env) : undefined;
  const server = createServer(async (request, response) => {
    let target: URL;
    try { target = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { response.writeHead(400).end(); return; }
    const name = target.origin === "http://127.0.0.1" ? /^\/mcp\/([a-z][a-z0-9-]{0,31})$/.exec(target.pathname)?.[1] : undefined;
    const bridge = codexMcpDefinition(name);
    let definition;
    try { definition = (await listPackages(root)).find(item => item.config.name === name && item.config.mcp); }
    catch (error) { console.error(error); response.writeHead(503).end(); return; }
    if (!name || !bridge && !definition) { response.writeHead(404).end(); return; }
    if (!bridge && request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    let identity: McpIdentity;
    try {
      identity = target.searchParams.has("worker") || target.searchParams.has("runtime")
        ? parseWorkerMcpIdentity(target, env) : parseBotMcpIdentity(target, env);
    } catch { response.writeHead(403).end(); return; }
    const checkAuthority = async () => {
      if (identity) await verifyMcpIdentity(identity, env);
      else auth.operator(request.headers.authorization);
    };
    try {
      if (identity && request.headers.authorization) throw new Error("ambiguous identity");
      await checkAuthority();
    } catch { response.writeHead(401, { "www-authenticate": "Bearer", "cache-control": "no-store" }).end("Unauthorized"); return; }
    const address = server.address();
    if (!address || typeof address === "string") { response.writeHead(503).end(); return; }
    const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    if (bridge) {
      const owner = identity ? "botId" in identity ? `bot:${identity.botId}:${identity.instance}` : `worker:${identity.workerId}:${identity.instance}` : "operator";
      try { await codex.handle(request, response, bridge, owner, hosts, checkAuthority, identity); }
      catch { if (!response.headersSent) response.writeHead(500).end(); else response.end(); }
      return;
    }
    try { await socketExposure(definition!.config, "mcp", env); }
    catch (error) { console.error(`MCP configuration unavailable: ${error instanceof Error ? error.message : String(error)}`); response.writeHead(503).end(); return; }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true,
      allowedHosts: hosts, allowedOrigins: hosts.map(host => `http://${host}`),
    });
    const mcp = packageMcpServer(name, definition!.config.description, root, env, identity, checkAuthority, events);
    try { await mcp.connect(transport); await transport.handleRequest(request, response); }
    catch (error) { if (!response.headersSent) response.writeHead(500).end(); console.error(error); }
    finally { await mcp.close(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  }).catch(async error => { await codex.close(); auth.close(); throw error; });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP server has no TCP address");
  const urls = Object.fromEntries(packages.map(({ name }) => [name, `http://127.0.0.1:${address.port}/mcp/${name}`]));
  let closing: Promise<void> | undefined;
  return { port: address.port, urls, close() {
    closing ??= codex.close().then(() => new Promise<void>((resolve, reject) => {
      server.close(error => { auth.close(); error ? reject(error) : resolve(); });
    }));
    return closing;
  } };
}
