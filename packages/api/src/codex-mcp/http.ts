import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CodexMcpDefinition } from "./catalog.js";
import { CodexMcpSession } from "./session.js";
import { codexMcpServer } from "./server.js";
import type { McpIdentity } from "../mcp-authority.js";

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

  async handle(request: IncomingMessage, response: ServerResponse, definition: CodexMcpDefinition, owner: string, hosts: string[], checkAuthority: () => Promise<void>, identity: McpIdentity) {
    if (this.closed) { response.writeHead(503).end(); return; }
    const id = request.headers["mcp-session-id"];
    let entry = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (id !== undefined && (!entry || entry.owner !== owner || entry.name !== definition.name)) { response.writeHead(404).end(); return; }
    if (!entry) {
      if (request.method !== "POST") { response.writeHead(400).end("MCP initialization required"); return; }
      if (this.all.size >= 128) { response.writeHead(503).end("Codex MCP session limit reached"); return; }
      const { backend, mcp } = codexMcpServer(definition, this.env, checkAuthority, identity);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID, enableDnsRebindingProtection: true,
        allowedHosts: hosts, allowedOrigins: hosts.map(host => `http://${host}`),
        onsessioninitialized: sessionId => { this.sessions.set(sessionId, created); },
      });
      const created: Session = { owner, name: definition.name, mcp, transport, backend, touched: Date.now(), active: 0 };
      entry = created;
      this.all.add(entry);
      mcp.onclose = () => { void this.remove(created); };
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
