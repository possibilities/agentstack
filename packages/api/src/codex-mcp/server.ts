import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ElicitResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mcpInvocation, type McpIdentity } from "../mcp-authority.js";
import type { CodexMcpDefinition } from "./catalog.js";
import { CodexMcpSession } from "./session.js";
import { record } from "./rpc.js";

export function codexMcpServer(definition: CodexMcpDefinition, env: NodeJS.ProcessEnv, checkAuthority: () => Promise<void>, identity: McpIdentity) {
  const backend = new CodexMcpSession(definition, env);
  const mcp = new Server({ name: definition.name, version: "0.0.0" }, { capabilities: { tools: {} }, instructions: definition.description });
  mcp.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    await checkAuthority();
    const tools = await backend.listTools(extra.signal);
    await checkAuthority();
    return { tools };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    try {
      await checkAuthority();
      mcpInvocation(identity, params._meta);
      return await backend.callTool(params.name, params.arguments ?? {}, extra.signal, async upstream => {
        const capabilities = mcp.getClientCapabilities();
        const mode = upstream.mode ?? "form";
        const openai = mode === "openai/form" || mode === "openaiForm";
        if (mode !== "url" && mode !== "form" && !openai) return { action: "cancel" };
        if (mode === "url" ? capabilities?.elicitation?.url === undefined : capabilities?.elicitation?.form === undefined) return { action: "cancel" };
        if (typeof upstream.message !== "string") return { action: "cancel" };
        const payload = mode === "url"
          ? { mode, message: upstream.message, url: upstream.url, elicitationId: upstream.elicitationId }
          : { mode: "form", message: upstream.message, requestedSchema: upstream.requestedSchema };
        if (mode === "url" ? typeof upstream.url !== "string" || typeof upstream.elicitationId !== "string" : !record(upstream.requestedSchema)) return { action: "cancel" };
        return extra.sendRequest({ method: "elicitation/create", params: { ...payload, ...(record(upstream._meta) ? { _meta: upstream._meta } : {}) } } as Parameters<typeof extra.sendRequest>[0], ElicitResultSchema, { signal: extra.signal });
      }, checkAuthority, params._meta);
    } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  });
  return { mcp, backend };
}
