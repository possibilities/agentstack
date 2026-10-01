import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { socketPath } from "./workspace.js";
import { currentMcpCatalog, currentWorkerCatalog, installedMcpCatalog } from "./exposure.js";
import { mcpInvocation, type McpIdentity } from "./mcp-authority.js";
import { subscriptionTools, type McpEventCall } from "./mcp-events.js";
import { socketCall, SocketCallError } from "./socket.js";
import { forwardTimeout } from "./forward-timeout.js";
import { wantsCompletion } from "./completion-watch.js";
import { executeOperation } from "./execute.js";
import { mcpPrerequisite } from "./mcp-prerequisite.js";

/** HTTP validates live catalogs. Internal stdio uses installed declarations and
 * optional owner-scoped standalone contexts, never full service contexts. */
export function packageMcpServer(name: string, description: string, root: string, env: NodeJS.ProcessEnv,
  identity: McpIdentity, checkAuthority: () => Promise<void>, events?: McpEventCall,
  stdio?: { checkCatalogAuthority(): Promise<void> }): Server {
  const mcp = new Server({ name, version: "0.0.0" }, { capabilities: { tools: {} }, instructions: description });
  const worker = identity && "workerId" in identity;
  const selection = async () => {
    if (stdio) return installedMcpCatalog(root, name);
    const catalog = await currentMcpCatalog(root, name, env);
    return { api: undefined, catalog, workerCatalog: worker ? await currentWorkerCatalog(root, name, env) : catalog,
      exposure: { operations: catalog.tools.map(tool => tool.name), events: Object.keys(catalog.events?.topics ?? {}) } };
  };
  const eventTools = (topics: string[]) => !worker && events && topics.length ? subscriptionTools : [];
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const check = stdio?.checkCatalogAuthority ?? checkAuthority;
    await check();
    const { catalog, exposure, workerCatalog } = await selection();
    const listed = worker ? workerCatalog : catalog;
    const generated = eventTools(exposure.events);
    if (generated.some(tool => listed.tools.some(item => item.name === tool.name))) throw new Error(`${name} has an operation reserved for MCP event subscriptions`);
    await check();
    return { tools: [...listed.tools.map(tool => ({ ...tool, title: tool.annotations?.title })), ...generated] };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    try {
      await checkAuthority();
      const { api, catalog, exposure, workerCatalog } = await selection();
      if (worker) {
        if (params.name.startsWith("events_")) throw new Error("worker MCP connections cannot subscribe Bot threads");
        if (!workerCatalog.tools.some(tool => tool.name === params.name)) throw new Error("operation is not selected for Worker disclosure");
      }
      const invocation = mcpInvocation(identity, params._meta);
      if (subscriptionTools.some(tool => tool.name === params.name)) {
        if (!eventTools(exposure.events).length) throw new Error("event subscriptions are unavailable over mcp");
        const result = await events!(name, params.name, params.arguments ?? {}, invocation, extra.signal);
        await checkAuthority();
        return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      if (!exposure.operations.includes(params.name)) throw new Error(`operation ${params.name} is not available over mcp`);
      const op = api?.operations.find(op => op.name === params.name);
      // Validate before either dispatch path, using the installed typed declaration.
      op?.input.parse(params.arguments ?? {});
      extra.signal.throwIfAborted();
      await checkAuthority();
      const watch = catalog.tools.find(tool => tool.name === params.name)?.completionWatch;
      if (watch && wantsCompletion(watch, params.arguments ?? {}, invocation)) {
        if (!identity || !("botId" in identity)) throw new Error("subscribe:true requires a verified Bot MCP call and sanctioned Chat; nothing was sent");
        if (!events) throw new Error("completion subscription owner is unavailable; nothing was sent");
        // Allocate the ID at ingress so a lost owner response still names a safe retry key.
        const input = { ...params.arguments, [watch.idArgument]: params.arguments?.[watch.idArgument] ?? randomUUID() };
        try {
          const result = await events(name, "operation_watch", { operation: params.name, input }, invocation, extra.signal);
          if (!(await selection()).exposure.operations.includes(params.name)) throw new Error("MCP exposure changed during the operation; result withheld");
          await checkAuthority();
          extra.signal.throwIfAborted();
          return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          const diagnostic = mcpPrerequisite(error, name, params.name, "Stack server event-subscription owner");
          throw new Error(`Completion record ${input[watch.idArgument]}. Retry only with this ID. ${diagnostic instanceof Error ? diagnostic.message : String(diagnostic)}`);
        }
      }
      let result: unknown;
      try {
        result = await socketCall(socketPath(name, env), "tools/call", {
          name: params.name, arguments: params.arguments ?? {}, invocation, resultFormat: "mcp",
        }, { signal: extra.signal, timeoutMs: forwardTimeout(name, params.name) });
      } catch (error) {
        // Managed authority remains service-bound. Never downgrade it to the
        // operator, nor substitute local reads for a live-instance check.
        if (!identity && op?.standalone && error instanceof SocketCallError && error.absent) {
          extra.signal.throwIfAborted();
          await checkAuthority();
          const ctx = await op.standalone.open(env, extra.signal);
          try { extra.signal.throwIfAborted(); result = await executeOperation(op, ctx, params.arguments ?? {}, invocation, "mcp"); }
          finally { await op.standalone.close(ctx); }
        } else throw mcpPrerequisite(error, name, params.name);
      }
      if (!(await selection()).exposure.operations.includes(params.name)) throw new Error("MCP exposure changed during the operation; result withheld");
      if (worker && !(await selection()).workerCatalog.tools.some(tool => tool.name === params.name))
        throw new Error("Worker disclosure policy changed during the operation; result withheld");
      await checkAuthority();
      extra.signal.throwIfAborted();
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("operation returned a non-object result");
      return result as CallToolResult;
    } catch (error) {
      const diagnostic = mcpPrerequisite(error, name, params.name, identity ? "live managed identity owner" : undefined);
      return { isError: true, content: [{ type: "text", text: diagnostic instanceof Error ? diagnostic.message : String(diagnostic) }] };
    }
  });
  return mcp;
}
