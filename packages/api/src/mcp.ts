import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { socketCall } from "./socket.js";
import { listPackages, mcpPort, socketPath, workspaceRoot } from "./workspace.js";

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
    const name = /^\/mcp\/([a-z][a-z0-9-]{0,31})$/.exec(request.url ?? "")?.[1];
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
