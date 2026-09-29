import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ElicitResultSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CodexMcpDefinition } from "./catalog.js";
import { CodexMcpSession } from "./session.js";
import { record } from "./rpc.js";

type Session = { owner: string; name: string; mcp: Server; transport: StreamableHTTPServerTransport; backend: CodexMcpSession; touched: number; active: number; closing?: Promise<void> };

/** Stateful routes share the listener and identity boundary with Package APIs. */
export class CodexMcpHttp {
  private sessions = new Map<string, Session>();
  private all = new Set<Session>();
  private retiring = new Set<Promise<void>>();
  private closed = false;
  private timer = setInterval(() => {
    for (const entry of this.all) if (!entry.active && Date.now() - entry.touched > 30 * 60_000) void this.remove(entry);
  }, 60_000).unref();
  constructor(private env: NodeJS.ProcessEnv) {}

  private remove(entry: Session): Promise<void> {
    if (entry.closing) return entry.closing;
    this.all.delete(entry);
    if (entry.transport.sessionId) this.sessions.delete(entry.transport.sessionId);
    // Defer close callbacks until the idempotent promise is installed.
    const closing = entry.closing = Promise.resolve().then(async () => { await Promise.all([entry.backend.close(), entry.mcp.close()]); });
    this.retiring.add(closing);
    void closing.then(() => this.retiring.delete(closing), () => this.retiring.delete(closing));
    return closing;
  }

  async handle(request: IncomingMessage, response: ServerResponse, definition: CodexMcpDefinition, owner: string, hosts: string[], checkAuthority: () => Promise<void>) {
    if (this.closed) { response.writeHead(503).end(); return; }
    const id = request.headers["mcp-session-id"];
    let entry = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (id !== undefined && (!entry || entry.owner !== owner || entry.name !== definition.name)) { response.writeHead(404).end(); return; }
    if (!entry) {
      if (request.method !== "POST") { response.writeHead(400).end("MCP initialization required"); return; }
      if (this.all.size >= 128) { response.writeHead(503).end("Codex MCP session limit reached"); return; }
      const backend = new CodexMcpSession(definition, this.env);
      const mcp = new Server({ name: definition.name, version: "0.0.0" }, { capabilities: { tools: {} }, instructions: definition.description });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID, enableDnsRebindingProtection: true,
        allowedHosts: hosts, allowedOrigins: hosts.map(host => `http://${host}`),
        onsessioninitialized: sessionId => { this.sessions.set(sessionId, created); },
      });
      const created: Session = { owner, name: definition.name, mcp, transport, backend, touched: Date.now(), active: 0 };
      entry = created;
      this.all.add(entry);
      mcp.onclose = () => { void this.remove(created); };
      mcp.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
        await checkAuthority();
        const tools = await backend.listTools(extra.signal);
        await checkAuthority();
        return { tools };
      });
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
        try {
          await checkAuthority();
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
            const result = await extra.sendRequest({ method: "elicitation/create", params: { ...payload, ...(record(upstream._meta) ? { _meta: upstream._meta } : {}) } } as Parameters<typeof extra.sendRequest>[0], ElicitResultSchema, { signal: extra.signal });
            return result;
          }, checkAuthority, params._meta);
        } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
      });
      await mcp.connect(transport);
    }
    const active = request.method === "POST" ? 1 : 0;
    entry.active += active; entry.touched = Date.now();
    const current = entry;
    response.once("close", () => { current.active -= active; current.touched = Date.now(); });
    try { await entry.transport.handleRequest(request, response); }
    finally { if (!entry.transport.sessionId) await this.remove(entry); }
  }

  async close() { this.closed = true; clearInterval(this.timer); await Promise.all([...this.all].map(entry => this.remove(entry))); await Promise.all(this.retiring); }
}
