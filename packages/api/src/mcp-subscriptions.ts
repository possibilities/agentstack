import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { socketCall, socketSubscribe, type SocketSubscription } from "./socket.js";
import { socketPath, stateDir } from "./workspace.js";
import type { InvocationContext } from "./operation.js";

export type EventTarget = { botId: string; instance: string; threadId: string };
export type EventSubscription = EventTarget & {
  id: string; pkg: string; topic: string; scope: string | null;
  readOperation: string; readArguments: Record<string, unknown>;
  state: "connecting" | "active" | "delivering" | "error";
  lastDeliveredAt: number | null; lastError: string | null;
};
export type EventValue = { subscription: EventSubscription; reason: "changed" | "reconnected"; value: unknown; truncated: boolean };

type RecordState = EventSubscription & {
  abort: AbortController; socket?: SocketSubscription; retry?: ReturnType<typeof setTimeout>;
  pending: boolean; flushing: boolean; reconnect: boolean; lastValueHash: string | null; retryDelay: number;
};

type Catalog = {
  events: { topics: Record<string, string>; scope?: { description: string; example: string; required: boolean } } | null;
  tools: Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean }; inputSchema: unknown }>;
};

const maxValueChars = 16_000;
const maxSubscriptions = 128;
const valueHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function preventThreadFeedback(pkg: string, topic: string, scope: string | null | undefined, botId: string): void {
  if (pkg === "bots" && (topic === "threads_changed" || topic === "chats_changed") && (!scope || scope === botId)) {
    throw new Error(`subscribing a Bot thread to its own ${topic} would create a turn feedback loop; choose another Bot scope or bots_changed`);
  }
}

function targetOf(invocation: InvocationContext | undefined): EventTarget {
  if (!invocation?.botId || !invocation.instance || !invocation.threadId) throw new Error("event subscriptions require a bot-bound MCP tool call with Codex thread metadata");
  return { botId: invocation.botId, instance: invocation.instance, threadId: invocation.threadId };
}

function publicView(state: RecordState): EventSubscription {
  const { id, pkg, topic, scope, readOperation, readArguments, botId, instance, threadId, state: phase, lastDeliveredAt, lastError } = state;
  return { id, pkg, topic, scope, readOperation, readArguments, botId, instance, threadId, state: phase, lastDeliveredAt, lastError };
}

/** Durable subscriptions: invalidation notices trigger fresh reads, never replayed payloads. */
export class McpEventSubscriptions {
  private readonly records = new Map<string, RecordState>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly validate: (target: EventTarget) => Promise<void>,
    private readonly deliver: (event: EventValue, signal: AbortSignal) => Promise<void>,
    private readonly rebind?: (botId: string, threadId: string) => Promise<EventTarget | null>,
    private readonly authorizeRead?: (subscription: EventSubscription) => Promise<void>) {
    const root = stateDir(env);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, "event-subscriptions.sqlite");
    try { closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, instance TEXT NOT NULL, thread_id TEXT NOT NULL,
        pkg TEXT NOT NULL, topic TEXT NOT NULL, scope TEXT, read_operation TEXT NOT NULL,
        read_arguments_json TEXT NOT NULL, last_delivered_at INTEGER, last_error TEXT
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(subscriptions)").all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "last_value_hash")) this.db.exec("ALTER TABLE subscriptions ADD COLUMN last_value_hash TEXT");
    const rows = this.db.prepare("SELECT * FROM subscriptions").all() as Array<{
      id: string; bot_id: string; instance: string; thread_id: string; pkg: string; topic: string; scope: string | null;
      read_operation: string; read_arguments_json: string; last_delivered_at: number | null; last_error: string | null; last_value_hash: string | null;
    }>;
    for (const row of rows) {
      this.records.set(row.id, {
        id: row.id, botId: row.bot_id, instance: row.instance, threadId: row.thread_id,
        pkg: row.pkg, topic: row.topic, scope: row.scope, readOperation: row.read_operation,
        readArguments: JSON.parse(row.read_arguments_json) as Record<string, unknown>,
        state: "connecting", lastDeliveredAt: row.last_delivered_at, lastError: row.last_error,
        abort: new AbortController(), pending: false, flushing: false, reconnect: true, lastValueHash: row.last_value_hash, retryDelay: 2_000,
      });
    }
  }

  /** Called once after owner children start; each record retries until its Bot thread is loaded. */
  resume(): void {
    for (const record of this.records.values()) if (!record.socket && !record.retry) void this.reconnect(record);
  }

  async catalog(pkg: string): Promise<{ topics: Record<string, string>; scope: { description: string; example: string; required: boolean } | null; reads: Array<{ name: string; description: string; inputSchema: unknown }> }> {
    const doc = await this.definition(pkg);
    return {
      topics: doc.events?.topics ?? {}, scope: doc.events?.scope ?? null,
      reads: doc.tools.filter((tool) => tool.annotations?.readOnlyHint).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    };
  }

  async subscribe(pkg: string, input: { topic: string; scope?: string; readOperation: string; readArguments?: Record<string, unknown> }, invocation?: InvocationContext): Promise<{ subscription: EventSubscription; value: unknown }> {
    if (this.closed) throw new Error("event subscriptions are closing");
    const target = targetOf(invocation);
    await this.validate(target);
    const doc = await this.definition(pkg);
    if (!doc.events || !Object.hasOwn(doc.events.topics, input.topic)) throw new Error(`unknown ${pkg} event topic: ${input.topic}`);
    const scope = input.scope ?? (doc.events.scope?.required && pkg === "bots" ? target.botId : undefined);
    preventThreadFeedback(pkg, input.topic, scope, target.botId);
    if (doc.events.scope?.required && !scope) throw new Error(`${pkg} event ${input.topic} requires a scope`);
    if (scope !== undefined && !doc.events.scope) throw new Error(`${pkg} events do not accept a scope`);
    if (!doc.tools.some((tool) => tool.name === input.readOperation && tool.annotations?.readOnlyHint)) throw new Error(`${input.readOperation} is not a read-only ${pkg} operation`);
    const readArguments = input.readArguments ?? {};
    if (JSON.stringify(readArguments).length > 4_000) throw new Error("event read arguments exceed 4000 characters");
    const key = JSON.stringify([target.botId, target.threadId, pkg, input.topic, scope ?? null, input.readOperation, readArguments]);
    const existing = [...this.records.values()].find((record) => JSON.stringify([
      record.botId, record.threadId, record.pkg, record.topic, record.scope, record.readOperation, record.readArguments,
    ]) === key);
    if (existing && existing.instance === target.instance) return { subscription: publicView(existing), value: await this.read(existing) };
    if (existing) {
      this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(existing.id);
      this.records.delete(existing.id);
      existing.abort.abort();
      if (existing.retry) clearTimeout(existing.retry);
      await existing.socket?.close();
    }
    if (this.records.size >= maxSubscriptions) throw new Error("too many event subscriptions");
    const state: RecordState = {
      id: randomUUID(), ...target, pkg, topic: input.topic, scope: scope ?? null,
      readOperation: input.readOperation, readArguments, state: "connecting", lastDeliveredAt: null, lastError: null,
      abort: new AbortController(), pending: false, flushing: false, reconnect: false, lastValueHash: null, retryDelay: 2_000,
    };
    try {
      await this.authorizeRead?.(state);
      // Subscribe before reading, because notices are invalidations without replay.
      state.socket = await socketSubscribe(socketPath(pkg, this.env), [state.topic], () => { state.pending = true; if (this.records.has(state.id)) void this.flush(state); },
        { scope, signal: state.abort.signal });
      const value = await this.read(state);
      if (this.closed) throw new Error("event subscriptions are closing");
      state.lastValueHash = valueHash(value);
      this.db.prepare("INSERT INTO subscriptions (id, bot_id, instance, thread_id, pkg, topic, scope, read_operation, read_arguments_json, last_value_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(state.id, state.botId, state.instance, state.threadId, state.pkg, state.topic, state.scope, state.readOperation, JSON.stringify(state.readArguments), state.lastValueHash);
      state.state = "active";
      this.records.set(state.id, state);
      this.watchClosed(state);
      if (state.pending) void this.flush(state);
      return { subscription: publicView(state), value };
    } catch (error) {
      state.abort.abort();
      await state.socket?.close();
      throw error;
    }
  }

  status(invocation?: InvocationContext): { subscriptions: EventSubscription[]; lifetime: "durable" } {
    const target = targetOf(invocation);
    return { subscriptions: [...this.records.values()].filter((record) => record.botId === target.botId && record.threadId === target.threadId).map(publicView), lifetime: "durable" };
  }

  async unsubscribe(id: string, invocation?: InvocationContext): Promise<{ id: string; removed: boolean }> {
    const target = targetOf(invocation);
    const state = this.records.get(id);
    if (!state) return { id, removed: false };
    if (state.botId !== target.botId || state.threadId !== target.threadId) throw new Error("subscription belongs to another bot thread");
    this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
    this.records.delete(id);
    state.abort.abort();
    if (state.retry) clearTimeout(state.retry);
    await state.socket?.close();
    return { id, removed: true };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const states = [...this.records.values()];
    this.records.clear();
    await Promise.all(states.map(async (state) => {
      state.abort.abort();
      if (state.retry) clearTimeout(state.retry);
      await state.socket?.close();
    }));
    this.db.close();
  }

  private definition(pkg: string): Promise<Catalog> {
    return socketCall(socketPath(pkg, this.env), "tools/list", {}, { timeoutMs: 5_000 }) as Promise<Catalog>;
  }

  private read(state: RecordState): Promise<unknown> {
    return (async () => {
      preventThreadFeedback(state.pkg, state.topic, state.scope, state.botId);
      await this.authorizeRead?.(state);
      return socketCall(socketPath(state.pkg, this.env), "tools/call", { name: state.readOperation, arguments: state.readArguments }, { timeoutMs: 10_000 });
    })();
  }

  private watchClosed(state: RecordState): void {
    const current = state.socket;
    if (!current) return;
    void current.closed.then(() => {
      if (state.abort.signal.aborted || this.closed || this.records.get(state.id) !== state) return;
      state.socket = undefined;
      state.state = "connecting";
      state.retry = setTimeout(() => { state.retry = undefined; void this.reconnect(state); }, 1_000);
      state.retry.unref();
    });
  }

  private async reconnect(state: RecordState): Promise<void> {
    if (state.abort.signal.aborted || this.closed) return;
    try {
      const target = this.rebind ? await this.rebind(state.botId, state.threadId) : { botId: state.botId, threadId: state.threadId, instance: state.instance };
      if (!target) {
        this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(state.id);
        this.records.delete(state.id);
        state.abort.abort();
        return;
      }
      await this.validate(target);
      state.instance = target.instance;
      this.db.prepare("UPDATE subscriptions SET instance = ? WHERE id = ?").run(state.instance, state.id);
      preventThreadFeedback(state.pkg, state.topic, state.scope, state.botId);
      await this.authorizeRead?.(state);
      state.socket = await socketSubscribe(socketPath(state.pkg, this.env), [state.topic], () => { state.pending = true; void this.flush(state); },
        { scope: state.scope ?? undefined, signal: state.abort.signal });
      state.pending = true;
      state.reconnect = true;
      state.retryDelay = 2_000;
      state.state = "active";
      this.watchClosed(state);
      void this.flush(state);
    } catch (error) {
      if (state.abort.signal.aborted || this.closed) return;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.state = "error";
      this.db.prepare("UPDATE subscriptions SET last_error = ? WHERE id = ?").run(state.lastError, state.id);
      state.retry = setTimeout(() => { state.retry = undefined; void this.reconnect(state); }, state.retryDelay);
      state.retry.unref();
      state.retryDelay = Math.min(state.retryDelay * 2, 60_000);
    }
  }

  private async flush(state: RecordState): Promise<void> {
    if (state.flushing || !this.records.has(state.id)) return;
    state.flushing = true;
    try {
      while (state.pending && !state.abort.signal.aborted) {
        state.pending = false;
        state.state = "delivering";
        try {
          const value = await this.read(state);
          const encoded = JSON.stringify(value);
          const hash = valueHash(value);
          if (!state.reconnect && hash === state.lastValueHash) { state.state = "active"; continue; }
          const key = `${state.botId}:${state.instance}:${state.threadId}`;
          const previous = this.deliveries.get(key) ?? Promise.resolve();
          const next = previous.catch(() => undefined).then(() => this.deliver({ subscription: publicView(state), reason: state.reconnect ? "reconnected" : "changed",
            value: encoded.length <= maxValueChars ? value : { readOperation: state.readOperation, readArguments: state.readArguments, bytes: Buffer.byteLength(encoded), note: "Value exceeds turn limit; call the read operation directly." },
            truncated: encoded.length > maxValueChars }, state.abort.signal));
          this.deliveries.set(key, next);
          try { await next; }
          finally { if (this.deliveries.get(key) === next) this.deliveries.delete(key); }
          state.lastDeliveredAt = Date.now();
          state.lastValueHash = hash;
          state.lastError = null;
          state.reconnect = false;
          state.state = "active";
          if (!this.closed) this.db.prepare("UPDATE subscriptions SET last_delivered_at = ?, last_error = NULL, last_value_hash = ? WHERE id = ?").run(state.lastDeliveredAt, state.lastValueHash, state.id);
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          state.state = "error";
          if (!this.closed) this.db.prepare("UPDATE subscriptions SET last_error = ? WHERE id = ?").run(state.lastError, state.id);
        }
      }
    } finally { state.flushing = false; }
  }
}
