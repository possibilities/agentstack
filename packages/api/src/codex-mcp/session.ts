import { randomUUID } from "node:crypto";
import { CallToolResultSchema, ToolSchema, type Tool, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CodexMcpDefinition } from "./catalog.js";
import { browserModule, codexInstallation } from "./install.js";
import { projectedProgram, projectedTools } from "./projections.js";
import { CodexRpc, record, type Elicitation } from "./rpc.js";

/** Per HTTP MCP session; serialized calls keep REPL state and approval routing coherent. */
export class CodexMcpSession {
  private rpc?: CodexRpc;
  private starting?: Promise<void>;
  private threadId?: string;
  private server: string;
  private modulePath?: string;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  constructor(private definition: CodexMcpDefinition, private env: NodeJS.ProcessEnv) { this.server = definition.server; }

  private async start(signal?: AbortSignal) {
    if (this.closed) throw new Error("Codex tools session closed; reconnect");
    this.starting ??= (async () => {
      const installation = await codexInstallation(this.env);
      if (this.closed) throw new Error("Codex tools session closed");
      if ("surface" in this.definition && this.definition.surface === "chrome") this.modulePath = await browserModule(installation.home);
      if (this.closed) throw new Error("Codex tools session closed");
      const rpc = this.rpc = new CodexRpc(installation.binary, installation.home, this.env);
      try {
        await rpc.request("initialize", { clientInfo: { name: "stack-codex-tools", version: "0.0.0" }, capabilities: { mcpServerOpenaiFormElicitation: true, extensions: { "openai/form": {}, "openai/standard-form-input": {} } } }, signal);
        rpc.notify("initialized");
        const started = await rpc.request("thread/start", { ephemeral: true, approvalPolicy: "on-request", sessionStartSource: "startup" }, signal);
        if (!record(started) || !record(started.thread) || typeof started.thread.id !== "string") throw new Error("Invalid Codex tool thread response");
        this.threadId = started.thread.id;
      } catch (error) { await rpc.close(); throw error; }
    })();
    await this.starting;
  }

  private async tools(signal?: AbortSignal): Promise<Tool[]> {
    await this.start(signal);
    const servers: Record<string, any>[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 32; page++) {
      const result = await this.rpc!.request("mcpServerStatus/list", { threadId: this.threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) }, signal);
      if (!record(result) || !Array.isArray(result.data) || !result.data.every(record)) throw new Error("Invalid Codex tool catalog");
      servers.push(...result.data);
      if (result.nextCursor == null) break;
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor) || page === 31) throw new Error("Invalid Codex tool catalog pagination");
      cursor = result.nextCursor; cursors.add(cursor);
    }
    const projected = "surface" in this.definition;
    // Both runtime generations still support the bundled trusted module imports.
    const upstream = projected
      ? servers.find((s) => s.name === "node_repl" && record(s.tools) && s.tools.js) ?? servers.find((s) => s.name === "cua_repl" && record(s.tools) && s.tools.js)
      : servers.find((s) => s.name === this.definition.server);
    if (!upstream || !record(upstream.tools) || !Object.keys(upstream.tools).length || upstream.runtimeStatus === "disabled" || upstream.runtimeStatus === "failed") {
      throw new Error(`${this.definition.name} is unavailable in the selected Codex installation. Install and enable its plugin in Codex/ChatGPT, then reconnect this MCP server. Computer History additionally needs recording enabled.`);
    }
    this.server = upstream.name;
    if ("surface" in this.definition) return projectedTools(this.definition.surface);
    return Object.entries(upstream.tools).map(([name, tool]) => ToolSchema.parse({ ...(record(tool) ? tool : {}), name }));
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex tools session closed"));
    if (this.queued >= 16) return Promise.reject(new Error("Codex tools session queue is full"));
    this.queued++;
    const result = this.tail.then(run);
    this.tail = result.catch(() => {}).finally(() => { this.queued--; });
    return result;
  }
  listTools(signal?: AbortSignal): Promise<Tool[]> { return this.serialize(() => this.tools(signal)); }
  callTool(name: string, args: unknown, signal: AbortSignal, elicit: Elicitation, checkAuthority: () => Promise<void>, meta?: Record<string, unknown>): Promise<CallToolResult> {
    return this.serialize(async () => {
      signal.throwIfAborted();
      const tools = await this.tools(signal);
      if (!tools.some((tool) => tool.name === name)) throw new Error(`Tool ${name} is not exposed by ${this.definition.name}`);
      await checkAuthority();
      const rpc = this.rpc!;
      const turnId = randomUUID();
      const projected = "surface" in this.definition;
      const arguments_ = "surface" in this.definition ? {
        code: projectedProgram(this.definition.surface, name, args, this.modulePath), title: `${this.definition.name}: ${name}`, timeout_ms: 55_000,
      } : args;
      rpc.onElicitation = async (params) => {
        if (params.threadId !== this.threadId || params.turnId != null && params.turnId !== turnId) return { action: "cancel" };
        await checkAuthority();
        const answer = await elicit(params);
        await checkAuthority();
        return answer;
      };
      try {
        const result = await rpc.request("mcpServer/tool/call", {
          threadId: this.threadId, server: this.server, tool: projected ? "js" : name, arguments: arguments_,
          _meta: { ...meta, "x-codex-turn-metadata": { session_id: this.threadId, turn_id: turnId } },
        }, signal, 300_000);
        await checkAuthority();
        // Codex serializes optional fields as null; MCP optional fields must be omitted.
        if (!record(result)) throw new Error("Invalid Codex MCP tool result");
        return CallToolResultSchema.parse(Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null)));
      } finally { rpc.onElicitation = undefined; }
    });
  }
  async close() { this.closed = true; await this.rpc?.close(); }
}
