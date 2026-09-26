import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, type CanUseTool, type ModelInfo, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { record, type AcpRequest } from "./acp.js";
import type { WorkerBackend } from "./backend.js";
import type { AcpMcp } from "./resources.js";
import { safeValue } from "./history.js";

export const CLAUDE_SDK_VERSION = "0.3.283";
export const CLAUDE_CODE_VERSION = "2.1.283";
export type ClaudeQuery = Pick<Query, typeof Symbol.asyncIterator | "initializationResult" | "supportedModels" | "setModel" | "applyFlagSettings" | "interrupt" | "close">;
export type ClaudeQueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;

/** Keeping input open makes control requests and follow-up turns share the same native session. */
class Input implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: SDKUserMessage): void { if (this.ended) throw new Error("Claude session input is closed"); this.values.push(value); this.wake?.(); }
  close(): void { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      const value = this.values.shift();
      if (value) yield value;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

type Turn = { uuid: string; resolve: (value: unknown) => void; reject: (error: Error) => void; cancelled: boolean };
type Session = { id: string; input: Input; query: ClaudeQuery; models: ModelInfo[]; model?: string; effort?: string;
  active?: Turn; closed: boolean; pump?: Promise<void>; child?: ChildProcessWithoutNullStreams; childExit?: Promise<void>;
  seen: Set<string>; streamed: Set<string>; secrets: string[];
  streams: Map<string, { messageId: string; text: string; parent: string | null; truncated: boolean }> };
type Permission = { sessionId: string; resolve: (value: PermissionResult) => void; input: Record<string, unknown>; toolUseID: string; cleanup: () => void };

/** Native SDK adapter. The operation names are internal compatibility messages, never an ACP claim.
 * The account owns a runtime group; each session owns a separate native child. Unexpected loss
 * drains the group so the existing account-instance signed-MCP fence cannot be reused. */
export class ClaudeBackend implements WorkerBackend {
  readonly pid = null;
  readonly exited: Promise<void>;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (request: AcpRequest) => boolean;
  private exit!: () => void;
  private sessions = new Map<string, Session>();
  private permissions = new Map<number, Permission>();
  private nextRequest = 1;
  private closed = false;
  private closing?: Promise<void>;
  get pids(): number[] { return [...this.sessions.values()].flatMap((s) => s.child?.pid && s.child.exitCode === null && s.child.signalCode === null ? [s.child.pid] : []); }

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly createQuery: ClaudeQueryFactory = query) {
    this.exited = new Promise((resolve) => { this.exit = resolve; });
  }

  private update(session: Session, update: Record<string, unknown>, meta?: unknown): void {
    if (!session.closed) this.onNotification?.("session/update", this.sanitize(session, { sessionId: session.id, update,
      _meta: { backend: "claude-sdk", ...(record(meta) ? meta : {}) } }));
  }

  private sanitize(session: Session, value: unknown): unknown {
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") { let text = value; for (const secret of session.secrets) text = text.replaceAll(secret, "[private launch value]"); return text; }
      if (Array.isArray(value)) return value.map(redact);
      if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    return redact(safeValue(value));
  }

  private flushText(session: Session, stream: { messageId: string; text: string; parent: string | null; truncated: boolean }): void {
    if (stream.text) this.update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: stream.text } },
      { parentToolUseId: stream.parent, messageId: stream.messageId });
    stream.text = "";
    if (stream.truncated) { this.update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[SDK text block exceeded capture limit]" } }); stream.truncated = false; }
  }

  private config(session: Session): object {
    const selected = session.models.find((model) => model.value === session.model);
    // These are selectable options, not an assertion about the model/effort used by inference.
    return { configOptions: [{ id: "model", category: "model", type: "select", name: "Model",
      options: session.models.map((model) => ({ value: model.value, name: model.displayName })) },
    ...(selected?.supportedEffortLevels?.length ? [{ id: "effort", category: "thought_level", type: "select", name: "Effort",
      options: selected.supportedEffortLevels.map((value) => ({ value, name: value })) }] : [])],
    _meta: { backend: "claude-sdk", selection: { model: session.model ?? null, effort: session.effort ?? null }, evidence: "SDK control acknowledgement; actual settings are observed separately" } };
  }

  private canUseTool(session: Session): CanUseTool {
    return async (name, input, options) => {
      if (this.closed || session.closed || !session.active || options.signal.aborted)
        return { behavior: "deny", message: "Worker is not awaiting this tool", toolUseID: options.toolUseID };
      const id = this.nextRequest++;
      return new Promise<PermissionResult>((resolve) => {
        const abort = () => { const pending = this.permissions.get(id); if (!pending) return;
          this.permissions.delete(id); pending.cleanup(); resolve({ behavior: "deny", message: "Permission request cancelled", interrupt: true, toolUseID: options.toolUseID }); };
        this.permissions.set(id, { sessionId: session.id, resolve, input, toolUseID: options.toolUseID,
          cleanup: () => options.signal.removeEventListener("abort", abort) });
        options.signal.addEventListener("abort", abort, { once: true });
        const accepted = this.onRequest?.({ id, method: "session/request_permission", params: this.sanitize(session, { sessionId: session.id,
          toolCall: { toolCallId: options.toolUseID, title: options.title ?? name, rawInput: input },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "deny-once", name: "Deny", kind: "reject_once" }],
          _meta: { backend: "claude-sdk", requestId: options.requestId, agentId: options.agentID ?? null } }) });
        if (!accepted) abort();
      });
    };
  }

  private async open(params: Record<string, unknown>, resume: boolean): Promise<object> {
    const id = resume && typeof params.sessionId === "string" ? params.sessionId : randomUUID();
    if (this.sessions.has(id)) throw new Error("Claude session is already open");
    const input = new Input();
    const session = { id, input, models: [], closed: false, seen: new Set<string>(), streamed: new Set<string>(), secrets: [], streams: new Map() } as unknown as Session;
    const env = { ...this.env };
    // A host's interrupted-turn/remote-resume environment must never silently replay admitted work.
    for (const key of Object.keys(env)) if (/^CLAUDE_CODE_RESUME_|^CLAUDE_CODE_SESSION_/.test(key)) delete env[key];
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    for (const mcp of (Array.isArray(params.mcpServers) ? params.mcpServers : []) as AcpMcp[]) {
      mcpServers[mcp.name] = "type" in mcp ? { type: "http", url: mcp.url, headers: Object.fromEntries(mcp.headers.map((v) => [v.name, v.value])) }
        : { command: mcp.command, args: mcp.args, env: Object.fromEntries(mcp.env.map((v) => [v.name, v.value])) };
      const values = "type" in mcp ? [mcp.url, ...mcp.headers.flatMap(({ value }) => [value, value.replace(/^Bearer\s+/i, "")])]
        : [...mcp.env.map(({ value }) => value), ...mcp.args.filter((arg) => /[?=&]|token|secret|password/i.test(arg))];
      session.secrets.push(...values.filter(Boolean));
    }
    session.secrets.sort((a, b) => b.length - a.length);
    this.sessions.set(id, session);
    try {
      session.query = this.createQuery({ prompt: input, options: {
        cwd: String(params.cwd), env, ...(resume ? { resume: id } : { sessionId: id }), persistSession: true,
        settingSources: [], strictMcpConfig: true, mcpServers, permissionMode: "default", canUseTool: this.canUseTool(session),
        includePartialMessages: true, verbatimPrompts: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: typeof params.instructions === "string" ? params.instructions : "" },
        ...(typeof params.pluginPath === "string" ? { plugins: [{ type: "local" as const, path: params.pluginPath }], skills: "all" as const } : {}),
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
          session.child = child;
          session.childExit = new Promise((resolve) => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
          return child;
        },
        // Native diagnostic text may contain launch configuration; it never enters Worker history/errors.
        stderr: () => undefined,
      } });
      session.pump = this.consume(session);
      const initialized = await session.query.initializationResult();
      if (typeof params.pluginPath === "string" && initialized.plugins_applied === false) throw new Error("Claude Role plugin was not loaded");
      session.models = await session.query.supportedModels();
      if (session.closed || this.closed) throw new Error("Claude session closed during initialization");
      return { sessionId: id, ...this.config(session) };
    } catch {
      await this.closeSession(session);
      throw new Error("Claude SDK session initialization failed");
    }
  }

  private async consume(session: Session): Promise<void> {
    try {
      for await (const message of session.query) {
        if (session.closed || this.closed) break;
        this.message(session, message);
      }
    } catch { /* Only a confirmed result completes a turn. A lost stream stays unknown. */ }
    if (!session.closed && !this.closed) void this.close();
  }

  private message(session: Session, message: SDKMessage): void {
    // Never rebind a saved Worker to a new/forked native conversation.
    if ("session_id" in message && message.session_id !== session.id) { void this.close(); return; }
    if (message.type === "result") {
      const turn = session.active;
      if (!turn) return;
      if (message.user_message_uuid && message.user_message_uuid !== turn.uuid) { void this.close(); return; }
      for (const stream of session.streams.values()) this.flushText(session, stream);
      session.streams.clear();
      session.active = undefined;
      this.cancelPermissions(session.id);
      const failed = message.subtype !== "success" || message.is_error;
      turn.resolve({ stopReason: turn.cancelled ? "cancelled" : failed ? message.subtype === "success" ? "api_error" : message.subtype : message.stop_reason ?? "end_turn",
        failed: !turn.cancelled && failed, usage: message.usage,
        _meta: { backend: "claude-sdk", nativeSessionId: message.session_id, resultSubtype: message.subtype, isError: message.is_error,
          nativeStopReason: message.stop_reason, modelUsage: message.modelUsage, totalCostUsd: message.total_cost_usd,
          accounting: "modelUsage and totalCostUsd are cumulative session estimates; do not sum result frames" } });
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.update(session, { sessionUpdate: "session_info_update", sessionId: message.session_id, version: message.claude_code_version,
        tools: message.tools, mcpServers: message.mcp_servers.map(({ name, status }) => ({ name, status })), skills: message.skills });
      // Native init may omit effort. Do not manufacture observed effort from the requested option.
      this.update(session, { sessionUpdate: "config_option_update", models: { currentModelId: message.model },
        ...(message.effort === undefined ? {} : { configOptions: [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: message.effort, options: [] }] }) });
      return;
    }
    if (message.type === "stream_event") {
      const event = message.event;
      const key = message.parent_tool_use_id ?? "main";
      if (event.type === "message_start") session.streams.set(key, { messageId: event.message.id, text: "", parent: message.parent_tool_use_id, truncated: false });
      const stream = session.streams.get(key);
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (!stream) return;
        session.streamed.add(stream.messageId);
        // Keep split private URLs/tokens together before redaction. Blocks stay bounded even without newlines.
        if (!stream.truncated) {
          stream.text += event.delta.text;
          if (stream.text.length > 1_000_000) { stream.text = ""; stream.truncated = true; }
        }
      }
      if ((event.type === "content_block_stop" || event.type === "message_stop") && stream) this.flushText(session, stream);
      if (event.type === "content_block_start" && event.content_block.type === "tool_use")
        this.update(session, { sessionUpdate: "tool_call", toolCallId: event.content_block.id, title: event.content_block.name, status: "pending" },
          { parentToolUseId: message.parent_tool_use_id });
      return;
    }
    if (message.type === "assistant") {
      if (session.seen.has(message.uuid)) return;
      session.seen.add(message.uuid);
      const stream = session.streams.get(message.parent_tool_use_id ?? "main");
      if (stream && stream.messageId === message.message.id) this.flushText(session, stream);
      for (const content of message.message.content) {
        if (content.type === "text" && !session.streamed.has(message.message.id))
          this.update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: content.text } }, { parentToolUseId: message.parent_tool_use_id, messageId: message.uuid });
        if (content.type === "tool_use") this.update(session, { sessionUpdate: "tool_call", toolCallId: content.id, title: content.name,
          status: "in_progress", rawInput: content.input }, { parentToolUseId: message.parent_tool_use_id, messageId: message.uuid });
      }
      return;
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const content of message.message.content) if (content.type === "tool_result")
        this.update(session, { sessionUpdate: "tool_call_update", toolCallId: content.tool_use_id, status: content.is_error ? "failed" : "completed",
          rawOutput: content.content }, { parentToolUseId: message.parent_tool_use_id });
    }
  }

  async request(method: string, input: object, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) throw new Error("Claude runtime is closed");
    const run = this.operation(method, input as Record<string, unknown>).catch((error: unknown) => {
      // A rejected native selection can already have taken effect. Rotate the runtime fence before recovery.
      if (method === "session/set_config_option") void this.close();
      throw error;
    });
    if (!timeoutMs) return run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([run, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      void this.close(); reject(new Error("Claude control outcome is unknown"));
    }, timeoutMs); })]); } finally { if (timer) clearTimeout(timer); }
  }

  private async operation(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "session/new" || method === "session/load") return this.open(params, method === "session/load");
    const session = this.sessions.get(String(params.sessionId));
    if (!session || session.closed) throw new Error("Claude session is not open");
    if (method === "session/close") { await this.closeSession(session); return {}; }
    if (method === "session/set_config_option") {
      if (session.active) throw new Error("Claude session is busy");
      const value = String(params.value);
      if (params.configId === "model") {
        if (!session.models.some((model) => model.value === value)) throw new Error("Claude did not offer this model");
        await session.query.setModel(value); session.model = value; session.effort = undefined;
        await session.query.applyFlagSettings({ effortLevel: null });
      } else if (params.configId === "effort") {
        const choice = session.models.find((model) => model.value === session.model)?.supportedEffortLevels?.find((effort) => effort === value);
        if (!choice) throw new Error("Claude did not offer this effort");
        await session.query.applyFlagSettings({ effortLevel: choice }); session.effort = choice;
      } else throw new Error("Unsupported Claude selection");
      return this.config(session);
    }
    if (method === "session/prompt") {
      if (session.active) throw new Error("Claude session is busy");
      session.seen.clear(); session.streamed.clear(); session.streams.clear();
      const text = (params.prompt as Array<{ text: string }>).map((part) => part.text).join("\n");
      return new Promise((resolve, reject) => {
        const uuid = randomUUID();
        session.active = { uuid, resolve, reject, cancelled: false };
        session.input.push({ type: "user", session_id: session.id, uuid, parent_tool_use_id: null, message: { role: "user", content: text } });
      });
    }
    throw new Error("Unsupported Claude operation");
  }

  notify(method: string, params: object): void {
    const session = this.sessions.get(String((params as Record<string, unknown>).sessionId));
    if (method !== "session/cancel" || !session || session.closed) throw new Error("Claude session is unavailable");
    if (!session.active) return;
    session.active.cancelled = true;
    void session.query.interrupt().then((receipt) => {
      // No queued send is silently allowed to run after Stop. A queued survivor is an uncertain outcome.
      if (receipt?.still_queued.length) void this.close();
    }).catch(() => { void this.close(); });
  }

  respondRequest(id: number, result: unknown): void {
    const pending = this.permissions.get(id);
    if (!pending) throw new Error("Claude permission is no longer pending");
    const outcome = record(result) && record(result.outcome) ? result.outcome : {};
    if (outcome.outcome !== "cancelled" && (outcome.outcome !== "selected" || !["allow-once", "deny-once"].includes(String(outcome.optionId))))
      throw new Error("Claude permission option is not offered");
    this.permissions.delete(id); pending.cleanup();
    if (outcome.outcome === "cancelled") {
      const turn = this.sessions.get(pending.sessionId)?.active;
      if (turn) turn.cancelled = true;
    }
    pending.resolve(outcome.optionId === "allow-once" ? { behavior: "allow", updatedInput: pending.input, toolUseID: pending.toolUseID }
      : { behavior: "deny", message: "Worker operator denied this tool", interrupt: outcome.outcome === "cancelled", toolUseID: pending.toolUseID });
  }

  cancelPermissions(sessionId?: string): void {
    for (const [id, pending] of this.permissions) if (!sessionId || pending.sessionId === sessionId)
      this.respondRequest(id, { outcome: { outcome: "cancelled" } });
  }

  private async closeSession(session: Session): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.cancelPermissions(session.id);
    session.active?.reject(new Error("Claude stream lost before a confirmed result")); session.active = undefined;
    session.input.close(); session.query?.close();
    if (session.childExit && session.child) {
      const wait = async (ms: number) => { let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([session.childExit!.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
        finally { if (timer) clearTimeout(timer); } };
      if (!await wait(3_000)) { session.child.kill("SIGTERM"); if (!await wait(2_000)) { session.child.kill("SIGKILL");
        if (!await wait(2_000)) throw new Error("Owned Claude child did not exit"); } }
    }
    this.sessions.delete(session.id);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.exit(); // Fence the account before asynchronous child cleanup.
    this.closing = Promise.all([...this.sessions.values()].map((session) => this.closeSession(session))).then(() => undefined);
    return this.closing;
  }
}
