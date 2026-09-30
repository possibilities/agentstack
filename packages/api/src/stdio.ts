import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalAuth } from "./local-auth.js";
import { configuredMcpServers } from "./mcp.js";
import { parseMcpBinding, verifyMcpIdentity, type McpIdentity } from "./mcp-authority.js";
import { packageMcpServer } from "./mcp-package.js";
import { codexMcpDefinition } from "./codex-mcp/catalog.js";
import { codexMcpServer } from "./codex-mcp/server.js";
import { currentMcpCatalog } from "./exposure.js";
import { socketCall } from "./socket.js";
import { socketPath, workspaceRoot } from "./workspace.js";
import { mcpEventCatalog, type McpEventCall } from "./mcp-events.js";

/** One protocol-only child. No listener, package context or subscription database is created. */
export async function runMcpStdio(name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = env.STACK_MCP_ROOT ?? workspaceRoot(import.meta.dirname);
  const definition = (await configuredMcpServers(root)).find(item => item.name === name);
  if (!definition) throw new Error("unknown Stack MCP server");
  let identity: McpIdentity = null;
  let auth: LocalAuth | undefined;
  const kind = env.STACK_MCP_AUTHORITY;
  if (kind === "bot" || kind === "worker") {
    identity = parseMcpBinding(env.STACK_MCP_BINDING ?? "", env);
    if (("botId" in identity ? "bot" : "worker") !== kind || env.STACK_MCP_OPERATOR) throw new Error("ambiguous managed MCP authority");
  } else if (kind === "operator" && !env.STACK_MCP_BINDING && env.STACK_MCP_OPERATOR) auth = new LocalAuth(env);
  else throw new Error("stdio MCP requires explicit launch authority");
  const checkAuthority = async () => {
    if (identity) await verifyMcpIdentity(identity, env);
    else auth!.operator(env.STACK_MCP_OPERATOR);
  };
  const events: McpEventCall = async (pkg, tool, args, invocation, signal) => {
    // Catalog is public within an authorized connection; only Bot-owned requests
    // reach the durable owner. Operators never acquire a wakeup target.
    if (tool === "events_catalog") {
      return mcpEventCatalog(await currentMcpCatalog(root, pkg, env));
    }
    if (!identity || !("botId" in identity)) throw new Error("event subscriptions require a bot-bound MCP tool call with Codex thread metadata");
    return await socketCall(socketPath("serve", env), "tools/call", { name: "serve_mcp_event", arguments: {
      binding: env.STACK_MCP_BINDING, pkg, tool, arguments: args, threadId: invocation.threadId, sessionId: invocation.sessionId,
    } }, { signal, timeoutMs: 30_000 }) as object;
  };
  const bridge = codexMcpDefinition(name);
  const native = bridge ? codexMcpServer(bridge, env, checkAuthority, identity) : undefined;
  const mcp = native?.mcp ?? packageMcpServer(name, definition.description, root, env, identity, checkAuthority, events);
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const close = () => {
    closing ??= Promise.resolve().then(async () => {
      await Promise.all([native?.backend.close(), mcp.close()]);
      auth?.close();
    }).finally(finish);
    void closing.catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
    return closing;
  };
  const shutdown = () => { void close(); };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  signals.forEach(signal => process.on(signal, shutdown));
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  process.stdout.once("error", shutdown);
  mcp.onclose = shutdown;
  try {
    await checkAuthority();
    if (closing) return;
    await mcp.connect(transport);
    if (process.stdin.readableEnded) shutdown();
    await closed;
  } finally {
    await close();
    signals.forEach(signal => process.off(signal, shutdown));
    process.stdin.off("end", shutdown); process.stdin.off("error", shutdown); process.stdout.off("error", shutdown);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: stack serve mcp <name> --stdio");
    await runMcpStdio(process.argv[2]!);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
