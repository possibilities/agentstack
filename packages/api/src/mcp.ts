import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadPackageApi } from "./catalog.js";
import { socketCall } from "./socket.js";
import { publishedJsonSchema } from "./schema.js";
import { listPackages, mcpPort, socketPath, workspaceRoot } from "./workspace.js";

export type ServedMcp = { urls: Record<string, string>; close(): Promise<void> };

export async function serveMcp(options: { env?: NodeJS.ProcessEnv; root?: string; port?: number } = {}): Promise<ServedMcp> {
  const env = options.env ?? process.env;
  const port = options.port ?? mcpPort(env);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MCP port must be an integer from 0 to 65535");
  const root = options.root ?? workspaceRoot(import.meta.dirname);
  const packages = (await listPackages(root)).filter((item) => item.config.mcp);
  if (packages.length === 0) throw new Error("no Package APIs configure mcp");
  // Import only the operation definitions. Contexts are owned by the socket Servers.
  const definitions = new Map(await Promise.all(packages.map(async (item) => {
    const api = await loadPackageApi(item.dir);
    const tools: Tool[] = api.operations.map((operation) => ({
      name: operation.name,
      title: operation.annotations?.title,
      description: operation.description,
      inputSchema: publishedJsonSchema(operation.input) as Tool["inputSchema"],
      outputSchema: publishedJsonSchema(operation.output) as Tool["outputSchema"],
      annotations: operation.annotations,
    }));
    return [item.config.name, { description: item.config.description, tools }] as const;
  })));

  const server = createServer(async (request, response) => {
    const name = /^\/mcp\/([a-z][a-z0-9-]{0,31})$/.exec(request.url ?? "")?.[1];
    const definition = name ? definitions.get(name) : undefined;
    if (!name || !definition) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
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
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definition.tools }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      if (!definition.tools.some((tool) => tool.name === params.name)) throw new Error(`unknown operation: ${params.name}`);
      try {
        const result = await socketCall(socketPath(name, env), "tools/call", {
          name: params.name,
          arguments: params.arguments ?? {},
        }, { signal: extra.signal });
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
  const urls = Object.fromEntries([...definitions.keys()].map((name) => [name, `http://127.0.0.1:${address.port}/mcp/${name}`]));
  let closing: Promise<void> | undefined;
  return {
    urls,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      return closing;
    },
  };
}
