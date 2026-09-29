import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { socketCall } from "./socket.js";
import { listPackages, mcpPort, socketPath, workspaceRoot } from "./workspace.js";
import { botInstance, parseBotMcpIdentity, parseWorkerMcpIdentity } from "./bot-mcp-identity.js";
import type { InvocationContext } from "./operation.js";
import { McpEventSubscriptions } from "./mcp-subscriptions.js";
import { z } from "zod";
import type { PackageConfig } from "./config.js";
import { socketExposure, currentWorkerCatalog } from "./exposure.js";
import { forwardTimeout } from "./forward-timeout.js";
import { LocalAuth } from "./local-auth.js";
import { codexMcpServers, codexMcpDefinition } from "./codex-mcp/catalog.js";
import { CodexMcpHttp } from "./codex-mcp/http.js";

export type ServedMcp = { port: number; urls: Record<string, string>; close(): Promise<void> };

const subscriptionTools: Tool[] = [
  { name: "events_catalog", description: "List this Package API's event topics, scope rule, and read-only operations that can supply subscription values.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "events_subscribe", description: "Subscribe this Bot thread to a topic and read-only snapshot operation. Return the first value now; later changed snapshots arrive as standalone tool output through Codex start-or-steer. Idle threads wake; working threads receive pending input at Codex's processing boundary. Stack never waits for idle or turn completion. Repeating the same request returns the existing subscription.", inputSchema: {
    type: "object", properties: { topic: { type: "string" }, scope: { type: "string" }, readOperation: { type: "string" }, readArguments: { type: "object", additionalProperties: true } },
    required: ["topic", "readOperation"], additionalProperties: false,
  } },
  { name: "events_status", description: "List this Bot thread's durable event subscriptions and submission failures. lastDeliveredAt is the last Codex admission acknowledgement, not proof of model consumption or completed work.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "events_unsubscribe", description: "Stop one exact subscription for this Bot thread.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];

const subscriptionInput = z.strictObject({ topic: z.string().min(1), scope: z.string().optional(), readOperation: z.string().min(1), readArguments: z.record(z.string(), z.unknown()).optional() });
const resultOf = (result: object) => ({ structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] });

export async function configuredMcpPackages(root: string): Promise<Array<{ name: string; description: string }>> {
  return (await listPackages(root)).filter((item) => item.config.mcp).map((item) => ({
    name: item.config.name,
    description: item.config.description,
  }));
}

export async function configuredMcpServers(root: string): Promise<Array<{ name: string; description: string }>> {
  const packages = await configuredMcpPackages(root);
  if (packages.some(pkg => codexMcpDefinition(pkg.name))) throw new Error("Package API name collides with a built-in Codex MCP server");
  return [...packages, ...codexMcpServers.map(({ name, description }) => ({ name, description }))];
}

async function verifiedBot(botId: string, instance: string, env: NodeJS.ProcessEnv): Promise<void> {
  const listed = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 2_000 }) as {
    bots: Array<{ id: string; url: string | null; state: string; recoveryIssue: string | null }>;
  };
  const bot = listed.bots.find((entry) => entry.id === botId);
  if (!bot || bot.state !== "running" || bot.recoveryIssue || !bot.url || botInstance(bot.url) !== instance)
    throw new Error("bot MCP connection is no longer bound to a running instance");
}

async function verifiedWorker(workerId: string, instance: string, env: NodeJS.ProcessEnv): Promise<void> {
  const [status, runtimes] = await Promise.all([
    socketCall(socketPath("worker", env), "tools/call", { name: "worker_status", arguments: { id: workerId } }, { timeoutMs: 2_000 }) as Promise<{
      worker: { accountId: string; phase: string; runtimeInstance: string | null };
    }>,
    socketCall(socketPath("worker", env), "tools/call", { name: "worker_runtime_list", arguments: {} }, { timeoutMs: 2_000 }) as Promise<{
      runtimes: Array<{ id: string; state: string; instance: string | null }>;
    }>,
  ]);
  if (status.worker.runtimeInstance !== instance || !["preparing", "idle", "running", "awaiting_input", "cancelling"].includes(status.worker.phase) ||
      !runtimes.runtimes.some((runtime) => runtime.id === status.worker.accountId && runtime.state === "running" && runtime.instance === instance))
    throw new Error("worker MCP connection is no longer bound to a live Worker session");
}

export async function serveMcp(options: { env?: NodeJS.ProcessEnv; root?: string; port?: number; subscriptions?: McpEventSubscriptions } = {}): Promise<ServedMcp> {
  const env = options.env ?? process.env;
  const port = options.port ?? mcpPort(env);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MCP port must be an integer from 0 to 65535");
  const root = options.root ?? workspaceRoot(import.meta.dirname);
  const packages = await configuredMcpServers(root);
  if (packages.length === 0) throw new Error("no Package APIs configure mcp");
  const auth = new LocalAuth(env);
  const codex = new CodexMcpHttp(env);

  const server = createServer(async (request, response) => {
    let target: URL;
    try { target = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { response.writeHead(400).end(); return; }
    const name = target.origin === "http://127.0.0.1" ? /^\/mcp\/([a-z][a-z0-9-]{0,31})$/.exec(target.pathname)?.[1] : undefined;
    const bridge = codexMcpDefinition(name);
    let definition: { name: string; description: string } | undefined;
    let config: PackageConfig | undefined;
    try {
      const configured = (await listPackages(root)).find((item) => item.config.name === name && item.config.mcp);
      definition = configured ? { name: configured.config.name, description: configured.config.description } : undefined;
      config = configured?.config;
    } catch (error) {
      console.error(error);
      response.writeHead(503).end();
      return;
    }
    if (!name || !bridge && (!definition || !config)) {
      response.writeHead(404).end();
      return;
    }
    if (!bridge && request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let identity: { botId: string; instance: string } | null;
    let workerIdentity: { workerId: string; instance: string } | null;
    try {
      workerIdentity = target.searchParams.has("worker") || target.searchParams.has("runtime") ? parseWorkerMcpIdentity(target, env) : null;
      identity = workerIdentity ? null : parseBotMcpIdentity(target, env);
    }
    catch { response.writeHead(403).end(); return; }
    const checkAuthority = async () => {
      if (identity) await verifiedBot(identity.botId, identity.instance, env);
      else if (workerIdentity) await verifiedWorker(workerIdentity.workerId, workerIdentity.instance, env);
      else auth.operator(request.headers.authorization);
    };
    try {
      if ((identity || workerIdentity) && request.headers.authorization) throw new Error("ambiguous identity");
      await checkAuthority();
    } catch { response.writeHead(401, { "www-authenticate": "Bearer", "cache-control": "no-store" }).end("Unauthorized"); return; }
    if (bridge) {
      const address = server.address();
      if (!address || typeof address === "string") { response.writeHead(503).end(); return; }
      const owner = identity ? `bot:${identity.botId}:${identity.instance}` : workerIdentity ? `worker:${workerIdentity.workerId}:${workerIdentity.instance}` : "operator";
      try { await codex.handle(request, response, bridge, owner, [`127.0.0.1:${address.port}`, `localhost:${address.port}`], checkAuthority); }
      catch { if (!response.headersSent) response.writeHead(500).end(); else response.end(); }
      return;
    }
    let selection: Awaited<ReturnType<typeof socketExposure>>;
    try { selection = await socketExposure(config!, "mcp", env); }
    catch (error) {
      console.error(`MCP configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
      response.writeHead(503).end();
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
    const mcp = new Server({ name, version: "0.0.0" }, { capabilities: { tools: {} }, instructions: definition!.description });
    const eventTools = (topics: string[]) => !workerIdentity && options.subscriptions && topics.length > 0 ? subscriptionTools : [];
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      await checkAuthority();
      if (workerIdentity) {
        const current = await currentWorkerCatalog(root, name, env);
        await checkAuthority();
        return { tools: current.tools.map(tool => ({ ...tool, title: tool.annotations?.title })) };
      }
      const { catalog: listed, exposure } = selection;
      const extra = eventTools(exposure.events);
      if (extra.some((tool) => listed.tools.some((item) => item.name === tool.name))) throw new Error(`${name} has an operation reserved for MCP event subscriptions`);
      return { tools: [...listed.tools.map((tool) => ({ ...tool, title: tool.annotations?.title })), ...extra] };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      try {
        await checkAuthority();
        const { catalog: listed, exposure } = selection;
        if (workerIdentity) {
          if (params.name.startsWith("events_")) throw new Error("worker MCP connections cannot subscribe Bot threads");
          if (!(await currentWorkerCatalog(root, name, env)).tools.some(tool => tool.name === params.name))
            throw new Error("operation is not selected for Worker disclosure");
        }
        const meta = (params as { _meta?: unknown })._meta;
        const ids = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
        const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
        const threadId = identifier(ids.threadId);
        if (identity && !threadId) throw new Error("bot MCP tool call is missing Codex threadId metadata");
        const invocation: InvocationContext = {
          transport: "mcp", botId: identity?.botId ?? null, instance: identity?.instance ?? null,
          threadId, sessionId: identifier(ids.sessionId),
          workerId: workerIdentity?.workerId ?? null, workerInstance: workerIdentity?.instance ?? null,
        };
        if (subscriptionTools.some((tool) => tool.name === params.name)) {
          if (!eventTools(exposure.events).length) throw new Error("event subscriptions are unavailable over mcp");
          const service = options.subscriptions!;
          let result: object;
          if (params.name === "events_catalog") result = await service.catalog(name, listed);
          else if (params.name === "events_subscribe") {
            const input = subscriptionInput.parse(params.arguments ?? {});
            if (!exposure.events.includes(input.topic) || !listed.tools.some((tool) => tool.name === input.readOperation && tool.annotations?.readOnlyHint))
              throw new Error("subscription requires a selected topic and exposed read-only operation");
            result = await service.subscribe(name, input, invocation);
          }
          else if (params.name === "events_status") result = service.status(invocation);
          else if (params.name === "events_unsubscribe") result = await service.unsubscribe(z.strictObject({ id: z.uuid() }).parse(params.arguments ?? {}).id, invocation);
          else throw new Error(`unknown event tool: ${params.name}`);
          await checkAuthority();
          return resultOf(result);
        }
        if (!exposure.operations.includes(params.name)) throw new Error(`operation ${params.name} is not available over mcp`);
        if (workerIdentity) await checkAuthority();
        const result = await socketCall(socketPath(name, env), "tools/call", {
          name: params.name,
          arguments: params.arguments ?? {},
          invocation,
          resultFormat: "mcp",
        }, { signal: extra.signal, timeoutMs: forwardTimeout(name, params.name) });
        if (workerIdentity && !(await currentWorkerCatalog(root, name, env)).tools.some(tool => tool.name === params.name))
          throw new Error("Worker disclosure policy changed during the operation; result withheld");
        await checkAuthority();
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("operation returned a non-object result");
        return result as CallToolResult;
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
  }).catch(async (error) => { await codex.close(); auth.close(); throw error; });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP server has no TCP address");
  const urls = Object.fromEntries(packages.map(({ name }) => [name, `http://127.0.0.1:${address.port}/mcp/${name}`]));
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    urls,
    close() {
      closing ??= codex.close().then(() => new Promise<void>((resolve, reject) => {
        server.close((error) => { auth.close(); error ? reject(error) : resolve(); });
      }));
      return closing;
    },
  };
}
