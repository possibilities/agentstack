import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { socketCall } from "./socket.js";
import { listPackages, mcpPort, socketPath, workspaceRoot } from "./workspace.js";
import { botInstance, parseBotMcpIdentity } from "./bot-mcp-identity.js";
import type { InvocationContext } from "./operation.js";

export type ServedMcp = { port: number; urls: Record<string, string>; close(): Promise<void> };

export async function configuredMcpPackages(root: string): Promise<Array<{ name: string; description: string }>> {
  return (await listPackages(root)).filter((item) => item.config.mcp).map((item) => ({
    name: item.config.name,
    description: item.config.description,
  }));
}

export async function serveMcp(options: { env?: NodeJS.ProcessEnv; root?: string; port?: number } = {}): Promise<ServedMcp> {
  const env = options.env ?? process.env;
  const port = options.port ?? mcpPort(env);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MCP port must be an integer from 0 to 65535");
  const root = options.root ?? workspaceRoot(import.meta.dirname);
  const packages = await configuredMcpPackages(root);
  if (packages.length === 0) throw new Error("no Package APIs configure mcp");

  const server = createServer(async (request, response) => {
    const target = new URL(request.url ?? "/", "http://127.0.0.1");
    const name = target.origin === "http://127.0.0.1" ? /^\/mcp\/([a-z][a-z0-9-]{0,31})$/.exec(target.pathname)?.[1] : undefined;
    let definition: { name: string; description: string } | undefined;
    try {
      definition = (await configuredMcpPackages(root)).find((item) => item.name === name);
    } catch (error) {
      console.error(error);
      response.writeHead(503).end();
      return;
    }
    if (!name || !definition) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let identity: { botId: string; instance: string } | null;
    try { identity = parseBotMcpIdentity(target, env); }
    catch { response.writeHead(403).end(); return; }
    const address = server.address();
    if (!address || typeof address === "string") {
      response.writeHead(503).end();
      return;
    }
    const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
      allowedOrigins: hosts.map((host) => `http://${host}`),
    });
    const mcp = new Server({ name, version: "0.0.0" }, { capabilities: { tools: {} }, instructions: definition.description });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const listed = await socketCall(socketPath(name, env), "tools/list") as { tools: Tool[] };
      return { tools: listed.tools.map((tool) => ({ ...tool, title: tool.annotations?.title })) };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      try {
        if (identity) {
          const listed = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 2_000 }) as {
            bots: Array<{ id: string; url: string | null; state: string; recoveryIssue: string | null }>;
          };
          const bot = listed.bots.find((entry) => entry.id === identity.botId);
          if (!bot || bot.state !== "running" || bot.recoveryIssue || !bot.url || botInstance(bot.url) !== identity.instance) {
            throw new Error("bot MCP connection is no longer bound to a running instance");
          }
        }
        const meta = (params as { _meta?: unknown })._meta;
        const ids = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
        const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
        const threadId = identifier(ids.threadId);
        if (identity && !threadId) throw new Error("bot MCP tool call is missing Codex threadId metadata");
        const invocation: InvocationContext = {
          transport: "mcp", botId: identity?.botId ?? null, instance: identity?.instance ?? null,
          threadId, sessionId: identifier(ids.sessionId),
        };
        const result = await socketCall(socketPath(name, env), "tools/call", {
          name: params.name,
          arguments: params.arguments ?? {},
          invocation,
        }, { signal: extra.signal, timeoutMs: params.name === "account_remove" ? 300_000 : params.name === "voice_dial" && name === "bots" ? 75_000 : 60_000 });
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("operation returned a non-object result");
        return { structuredContent: result as Record<string, unknown>, content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end();
      console.error(error);
    } finally {
      await mcp.close();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP server has no TCP address");
  const urls = Object.fromEntries(packages.map(({ name }) => [name, `http://127.0.0.1:${address.port}/mcp/${name}`]));
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    urls,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      return closing;
    },
  };
}
