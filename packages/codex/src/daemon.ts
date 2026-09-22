import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { defaultPort } from "./paths.js";
import { Supervisor } from "./supervisor.js";
import { registerTools } from "./tools.js";

export type Daemon = {
  url: string;
  port: number;
  supervisor: Supervisor;
  close(options?: { halt?: boolean }): Promise<void>;
};

export async function startDaemon(stateDir: string, options?: { port?: number }): Promise<Daemon> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);

  const supervisor = new Supervisor({ stateDir });
  await supervisor.load();
  await supervisor.reap();

  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const http = createServer((req, res) => {
    void handle(req, res, supervisor, validateHost, validateOrigin);
  });

  const requestedPort = options?.port ?? defaultPort;
  await new Promise<void>((resolve, reject) => {
    http.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`agentstack is already listening on 127.0.0.1:${requestedPort}`));
        return;
      }
      reject(error);
    });
    http.listen(requestedPort, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  if (address === null || typeof address === "string") {
    http.close();
    throw new Error("failed to listen on 127.0.0.1");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    port: address.port,
    supervisor,
    async close(options) {
      if (options?.halt) await supervisor.halt();
      else await supervisor.stopAll();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  supervisor: Supervisor,
  validateHost: (req: IncomingMessage, res: ServerResponse) => boolean,
  validateOrigin: (req: IncomingMessage, res: ServerResponse) => boolean,
): Promise<void> {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  const server = new McpServer({ name: "agentstack", version: "0.0.0" });
  registerTools(server, supervisor);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
