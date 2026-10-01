import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { socketCall, SocketCallError, socketSubscribe, type SocketSubscription } from "./socket.js";
import { OperationRejected } from "./execute.js";
import { socketPath, stateDir, workspaceRoot } from "./workspace.js";
import type { InvocationContext } from "./operation.js";
import { currentMcpCatalog, type SocketCatalog } from "./exposure.js";
import { forwardTimeout } from "./forward-timeout.js";
import { stateHash } from "./state.js";
import { mcpEventCatalog } from "./mcp-events.js";
import { completionWatchSchema, McpDeliveryRejected, resolveCompletionRead, wantsCompletion, type CompletionReceipt } from "./completion-watch.js";
import type { CompletionWatch } from "./operation.js";

export type EventTarget = { botId: string; instance: string; threadId: string };
export type EventSubscription = EventTarget & {
  id: string; pkg: string; topic: string; scope: string | null;
  readOperation: string; readArguments: Record<string, unknown>;
  state: "connecting" | "active" | "delivering" | "error";
  lastDeliveredAt: number | null; lastError: string | null;
  completion: { operation: string; terminalField: string; retainFields?: string[]; updateField?: string; declaration?: CompletionWatch } | null;
};
export type EventValue = { subscription: EventSubscription; reason: "changed" | "reconnected"; value: unknown; truncated: boolean };

type RecordState = EventSubscription & {
  abort: AbortController; socket?: SocketSubscription; retry?: ReturnType<typeof setTimeout>;
  pending: boolean; flushing: boolean; reconnect: boolean; lastValueHash: string | null; retryDelay: number;
  admitting?: boolean; submissionUnknown?: boolean;
};

const maxValueChars = 16_000;
const maxSubscriptions = 128;
const valueHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const turnTopics = new Set(["threads_changed", "chats_changed", "chat_live_changed", "chat_queue_changed"]);

function preventThreadFeedback(pkg: string, topic: string, scope: string | null | undefined, botId: string): void {
  if (pkg === "bots" && turnTopics.has(topic) && (!scope || scope === botId)) {
    throw new Error(`subscribing a Bot thread to its own ${topic} would create a turn feedback loop; choose another Bot scope or bots_changed`);
  }
}

function targetOf(invocation: InvocationContext | undefined): EventTarget {
  if (invocation?.transport !== "mcp" || invocation.workerId || invocation.workerInstance || !invocation.botId || !invocation.instance || !invocation.threadId) throw new Error("event subscriptions require a bot-bound MCP tool call with Codex thread metadata");
  return { botId: invocation.botId, instance: invocation.instance, threadId: invocation.threadId };
}

function publicView(state: RecordState): EventSubscription {
  const { id, pkg, topic, scope, readOperation, readArguments, botId, instance, threadId, state: phase, lastDeliveredAt, lastError, completion } = state;
  return { id, pkg, topic, scope, readOperation, readArguments, botId, instance, threadId, state: phase, lastDeliveredAt, lastError, completion };
}

/** Durable subscriptions: invalidation notices trigger fresh reads, never replayed payloads. */
export class McpEventSubscriptions {
  private readonly records = new Map<string, RecordState>();
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly admissions = new Map<string, Promise<Record<string, unknown>>>();
  private readonly setups = new Set<RecordState>();
  onChange?: () => void;

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly validate: (target: EventTarget) => Promise<void>,
    private readonly deliver: (event: EventValue, signal: AbortSignal, authorize: () => Promise<void>, submitting?: () => void) => Promise<void>,
    private readonly rebind?: (botId: string, threadId: string) => Promise<EventTarget | null>,
    private readonly authorizeRead?: (subscription: EventSubscription) => Promise<void>,
    private readonly workspace: string = workspaceRoot(import.meta.dirname)) {
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
    if (!columns.some(({ name }) => name === "completion_json")) this.db.exec("ALTER TABLE subscriptions ADD COLUMN completion_json TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS completion_receipts (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, pkg TEXT NOT NULL,
      operation TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL,
      last_delivered_at INTEGER, last_error TEXT, UNIQUE(pkg, operation, record_id)
    )`);
    const receiptColumns = this.db.prepare("PRAGMA table_info(completion_receipts)").all() as Array<{ name: string }>;
    if (!receiptColumns.some(({ name }) => name === "delivery_kind")) this.db.exec("ALTER TABLE completion_receipts ADD COLUMN delivery_kind TEXT");
    // These are durable Bot watches, not historical provenance. Rebind their
    // package selectors before reconnecting; the old sockets are no longer served.
    this.db.exec(`UPDATE subscriptions SET pkg = CASE pkg
      WHEN 'attention' THEN 'signal' WHEN 'browser' THEN 'browse' WHEN 'workers' THEN 'worker' END,
      topic = CASE WHEN pkg = 'attention' AND topic = 'attention_changed' THEN 'signal_changed' ELSE topic END
      WHERE pkg IN ('attention', 'browser', 'workers')`);
    const rows = this.db.prepare("SELECT * FROM subscriptions").all() as Array<{
      id: string; bot_id: string; instance: string; thread_id: string; pkg: string; topic: string; scope: string | null;
      read_operation: string; read_arguments_json: string; last_delivered_at: number | null; last_error: string | null; last_value_hash: string | null;
      completion_json: string | null;
    }>;
    for (const row of rows) {
      const submissionUnknown = this.receipt(row.id)?.state === "unknown";
      this.records.set(row.id, {
        id: row.id, botId: row.bot_id, instance: row.instance, threadId: row.thread_id,
        pkg: row.pkg, topic: row.topic, scope: row.scope, readOperation: row.read_operation,
        readArguments: JSON.parse(row.read_arguments_json) as Record<string, unknown>,
        state: submissionUnknown ? "error" : "connecting", lastDeliveredAt: row.last_delivered_at,
        lastError: row.last_error ?? (submissionUnknown ? "Native admission outcome is unknown; this completion is not automatically replayed." : null),
        completion: row.completion_json ? JSON.parse(row.completion_json) : null,
        submissionUnknown,
        abort: new AbortController(), pending: false, flushing: false, reconnect: true, lastValueHash: row.last_value_hash, retryDelay: 2_000,
      });
    }
  }

  /** Called once after owner children start; each record retries until its Bot thread is loaded. */
  resume(): void {
    for (const record of this.records.values()) if (!record.socket && !record.retry && !record.submissionUnknown) void this.reconnect(record);
  }

  /** All generated thread-owned operations, including status/removal, verify lineage. */
  async validateInvocation(invocation: InvocationContext): Promise<void> {
    await this.validate(targetOf(invocation));
  }

  /** Record owners verify the private coordination capability before mutating. */
  async verifyCompletion(id: string, pkg: string, operation: string, recordId: string, invocation: InvocationContext): Promise<void> {
    if (this.closed) throw new Error("subscription owner is closing; nothing was sent");
    const target = targetOf(invocation);
    await this.validate(target);
    const row = this.db.prepare("SELECT bot_id, thread_id, state FROM completion_receipts WHERE id = ? AND pkg = ? AND operation = ? AND record_id = ?")
      .get(id, pkg, operation, recordId) as { bot_id: string; thread_id: string; state: CompletionReceipt["state"] } | undefined;
    if (!row || row.bot_id !== target.botId || row.thread_id !== target.threadId) throw new Error("completion coordination capability is invalid; nothing was sent");
    if (row.state === "cancelled") throw new Error("completion watch was explicitly cancelled; nothing was sent");
    const active = this.records.get(id);
    if (active) await this.authorize({ ...active, ...target });
    else {
      const doc = await this.definition(pkg);
      const watch = doc.tools.find(tool => tool.name === operation)?.completionWatch;
      if (!watch || !Object.hasOwn(doc.events?.topics ?? {}, watch.topic) || !doc.tools.some(tool => tool.name === watch.readOperation && tool.annotations?.readOnlyHint))
        throw new Error("completion operation/read/topic exposure is unavailable; nothing was sent");
      await this.validate(target);
    }
    // Awaited authority/exposure checks must not outlive the reserved capability.
    if (this.closed || active && (active.abort.signal.aborted || this.records.get(id) !== active))
      throw new Error("completion coordination capability was cancelled; nothing was sent");
    const finalReceipt = this.receipt(id);
    if (!finalReceipt || finalReceipt.state === "cancelled") throw new Error("completion watch was cancelled or removed; nothing was sent");
  }

  async catalog(pkg: string, admitted?: SocketCatalog): Promise<{ topics: Record<string, string>; scope: { description: string; example: string; required: boolean } | null; reads: Array<{ name: string; description: string; inputSchema: unknown }> }> {
    const doc = admitted ?? await this.definition(pkg);
    return mcpEventCatalog(doc);
  }

  async subscribe(pkg: string, input: { topic: string; scope?: string; readOperation: string; readArguments?: Record<string, unknown> }, invocation?: InvocationContext): Promise<{ subscription: EventSubscription; value: unknown }> {
    if (this.closed) throw new Error("event subscriptions are closing");
    const target = targetOf(invocation);
    await this.validate(target);
    const doc = await this.definition(pkg);
    if (!doc.events || !Object.hasOwn(doc.events.topics, input.topic)) throw new Error(`unknown ${pkg} event topic: ${input.topic}`);
    const scope = input.scope ?? (doc.events.scope?.required && pkg === "bots" ? target.botId : undefined);
    this.preventFeedback(pkg, input.topic, scope, target.botId);
    if (doc.events.scope?.required && !scope) throw new Error(`${pkg} event ${input.topic} requires a scope`);
    if (scope !== undefined && !doc.events.scope) throw new Error(`${pkg} events do not accept a scope`);
    if (!doc.tools.some((tool) => tool.name === input.readOperation && tool.annotations?.readOnlyHint)) throw new Error(`${input.readOperation} is not a read-only ${pkg} operation`);
    const readArguments = input.readArguments ?? {};
    if (JSON.stringify(readArguments).length > 4_000) throw new Error("event read arguments exceed 4000 characters");
    const key = JSON.stringify([target.botId, target.threadId, pkg, input.topic, scope ?? null, input.readOperation, readArguments]);
    const existing = [...this.records.values()].find((record) => !record.completion && JSON.stringify([
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
    const state: RecordState = {
      id: randomUUID(), ...target, pkg, topic: input.topic, scope: scope ?? null,
      readOperation: input.readOperation, readArguments, state: "connecting", lastDeliveredAt: null, lastError: null,
      completion: null,
      abort: new AbortController(), pending: false, flushing: false, reconnect: false, lastValueHash: null, retryDelay: 2_000,
    };
    this.reserveSetup(state);
    try {
      await this.authorize(state);
      // Subscribe before reading, because notices are invalidations without replay.
      state.socket = await socketSubscribe(socketPath(pkg, this.env), [state.topic], () => { state.pending = true; if (this.records.has(state.id)) void this.flush(state); },
        { scope, signal: state.abort.signal });
      const value = await this.read(state);
      if (this.closed) throw new Error("event subscriptions are closing");
      // Another subscription may have completed admission during the read.
      this.preventFeedback(pkg, input.topic, scope, target.botId);
      state.lastValueHash = valueHash(value);
      this.db.prepare("INSERT INTO subscriptions (id, bot_id, instance, thread_id, pkg, topic, scope, read_operation, read_arguments_json, last_value_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(state.id, state.botId, state.instance, state.threadId, state.pkg, state.topic, state.scope, state.readOperation, JSON.stringify(state.readArguments), state.lastValueHash);
      state.state = "active";
      this.setups.delete(state);
      this.records.set(state.id, state);
      this.onChange?.();
      this.watchClosed(state);
      if (state.pending) void this.flush(state);
      return { subscription: publicView(state), value };
    } catch (error) {
      state.abort.abort();
      await state.socket?.close();
      throw error;
    } finally { this.setups.delete(state); }
  }

  status(invocation?: InvocationContext, completionId?: string): { subscriptions: EventSubscription[]; completions: Array<CompletionReceipt & { pkg: string; operation: string; recordId: string }>; completionsTruncated: boolean; lifetime: "durable" } {
    const target = targetOf(invocation);
    const receipts = this.db.prepare(`SELECT id, pkg, operation, record_id FROM completion_receipts WHERE bot_id = ? AND thread_id = ?${completionId ? " AND id = ?" : ""} ORDER BY rowid DESC LIMIT ?`)
      .all(target.botId, target.threadId, ...(completionId ? [completionId] : []), maxSubscriptions + 1) as
      Array<{ id: string; pkg: string; operation: string; record_id: string }>;
    return { subscriptions: [...this.records.values()].filter((record) => record.botId === target.botId && record.threadId === target.threadId).map(publicView),
      completions: receipts.slice(0, maxSubscriptions).map(row => ({ ...this.receipt(row.id)!, pkg: row.pkg, operation: row.operation, recordId: row.record_id })), completionsTruncated: receipts.length > maxSubscriptions, lifetime: "durable" };
  }

  private receipt(id: string): CompletionReceipt | null {
    const row = this.db.prepare("SELECT id, state, last_delivered_at, last_error, delivery_kind FROM completion_receipts WHERE id = ?").get(id) as
      { id: string; state: CompletionReceipt["state"]; last_delivered_at: number | null; last_error: string | null; delivery_kind: CompletionReceipt["lastDeliveryKind"] } | undefined;
    return row ? { id: row.id, state: row.state, lastDeliveredAt: row.last_delivered_at, lastError: row.last_error, lastDeliveryKind: row.delivery_kind } : null;
  }

  /** Persist intent before mutation. This owner, not a stdio child, closes the send/watch crash gap. */
  async callAndWatch(pkg: string, operation: string, input: Record<string, unknown>, invocation: InvocationContext): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("subscription owner is closing; nothing was sent");
    const target = targetOf(invocation);
    await this.validate(target);
    const doc = await this.definition(pkg);
    const declared = doc.tools.find(tool => tool.name === operation)?.completionWatch;
    if (!declared) throw new Error("operation does not declare a completion watch");
    const watch = completionWatchSchema.parse(declared);
    if (!wantsCompletion(watch, input, invocation)) throw new Error("operation does not request a completion watch");
    const recordId = input[watch.idArgument] ?? randomUUID();
    if (typeof recordId !== "string") throw new Error("completion record ID must be a string");
    // The shared coordination capability and retained receipt use stable UUIDs.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) throw new Error("completion record ID must be a UUID");
    const key = JSON.stringify([pkg, operation, recordId]);
    const running = this.admissions.get(key);
    // Never borrow another Chat's in-flight admission or its result.
    if (running) { await running.catch(() => undefined); return this.callAndWatch(pkg, operation, { ...input, [watch.idArgument]: recordId }, invocation); }
    const admission = this.coordinate(pkg, operation, { ...input, [watch.idArgument]: recordId }, invocation, target, watch);
    this.admissions.set(key, admission);
    try { return await admission; } finally { this.admissions.delete(key); }
  }

  private async coordinate(pkg: string, operation: string, input: Record<string, unknown>, invocation: InvocationContext, target: EventTarget, watch: CompletionWatch): Promise<Record<string, unknown>> {
    const recordId = input[watch.idArgument] as string;
    const prior = this.db.prepare("SELECT id, bot_id, thread_id FROM completion_receipts WHERE pkg = ? AND operation = ? AND record_id = ?").get(pkg, operation, recordId) as
      { id: string; bot_id: string; thread_id: string } | undefined;
    if (prior && (prior.bot_id !== target.botId || prior.thread_id !== target.threadId)) throw new Error("completion watch belongs to another Bot Chat; nothing was sent");
    const resolved = resolveCompletionRead(watch, input, invocation);
    const state: RecordState = prior && this.records.get(prior.id) || {
      id: prior?.id ?? randomUUID(), ...target, pkg, topic: watch.topic, ...resolved,
      readOperation: watch.readOperation,
      completion: { operation, terminalField: watch.terminalField, ...(watch.retainFields ? { retainFields: watch.retainFields } : {}), ...(watch.updateField ? { updateField: watch.updateField } : {}), declaration: watch }, state: "connecting", lastDeliveredAt: null, lastError: null,
      abort: new AbortController(), pending: false, flushing: false, reconnect: false, lastValueHash: null, retryDelay: 2_000,
    };
    if (state.scope !== resolved.scope || valueHash(state.readArguments) !== valueHash(resolved.readArguments)) throw new Error("completion retry changes its read identity; nothing was sent");
    if (state.instance !== target.instance) {
      state.instance = target.instance;
      this.db.prepare("UPDATE subscriptions SET instance = ? WHERE id = ?").run(state.instance, state.id);
    }
    const admissionPolicy = prior ? { ...state, ...target } : state;
    await this.authorize(admissionPolicy);
    await this.validate(target);
    const live = (await this.definition(pkg)).tools.find(tool => tool.name === operation)?.completionWatch;
    if (!live || JSON.stringify(completionWatchSchema.parse(live)) !== JSON.stringify(watch)) throw new Error("completion operation exposure changed; nothing was sent");
    if (!prior) {
      this.reserveSetup(state);
      state.admitting = true;
      // Subscribe before the mutation, but reserve durably before invoking it.
      try {
        state.socket = await this.connect(state);
        if (this.closed || state.abort.signal.aborted) throw new Error("completion setup cancelled; nothing was sent");
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare(`INSERT INTO subscriptions (id, bot_id, instance, thread_id, pkg, topic, scope, read_operation, read_arguments_json, completion_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(state.id, state.botId, state.instance, state.threadId, pkg, state.topic, state.scope, state.readOperation, JSON.stringify(state.readArguments), JSON.stringify(state.completion));
          this.db.prepare("INSERT INTO completion_receipts (id, bot_id, thread_id, pkg, operation, record_id, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
            .run(state.id, state.botId, state.threadId, pkg, operation, recordId);
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        this.setups.delete(state);
        this.records.set(state.id, state);
        this.watchClosed(state);
        this.onChange?.();
      } catch (error) { state.abort.abort(); await state.socket?.close(); throw error; }
      finally { this.setups.delete(state); }
    }
    let result: Record<string, unknown>;
    const ownsInitial = !prior || this.records.get(state.id) === state && !state.submissionUnknown;
    if (ownsInitial) state.admitting = true;
    let dispatched = false;
    try {
      await this.authorize(admissionPolicy);
      await this.validate(target);
      // Repeating the same ID still visits the record owner to enforce its content digest.
      dispatched = true;
      result = await socketCall(socketPath(pkg, this.env), "tools/call", { name: operation, arguments: input,
        invocation: { ...invocation, completionWatchId: state.id } }, { timeoutMs: forwardTimeout(pkg, operation) }) as Record<string, unknown>;
    } catch (error) {
      if (ownsInitial) state.admitting = false;
      const refused = !dispatched || error instanceof OperationRejected || error instanceof SocketCallError && !error.dispatched;
      if (!prior && refused) await this.discardUnsent(state, recordId);
      else if (!prior) {
        this.fail(state, new Error(`send outcome may be unknown for ${recordId}; retry only with that ID: ${error instanceof Error ? error.message : String(error)}`));
        // Read-only recovery can discover a successful send even after a lost send acknowledgement.
        state.pending = true; void this.flush(state);
      } else if (ownsInitial && state.pending) void this.flush(state);
      throw new Error(`completion watch ${state.id}, record ${recordId}: ${refused ? "send refused before mutation" : "send failed or outcome unknown"}; retry with the same record ID. ${error instanceof Error ? error.message : String(error)}`);
    }
    const response = (initial?: unknown) => ({ ...result, ...(watch.initialValueField ? { [watch.initialValueField]: initial ?? null } : initial as Record<string, unknown> | undefined), subscription: this.receipt(state.id) });
    if (!ownsInitial) return response();
    try {
      const initial = await this.read(state) as Record<string, unknown>;
      if (this.terminal(state, initial)) {
        await this.finishCompletion(state, "observed");
        return response(initial);
      }
      state.lastValueHash = valueHash(initial);
      state.lastError = null;
      this.db.prepare("UPDATE subscriptions SET last_value_hash = ?, last_error = NULL WHERE id = ?").run(state.lastValueHash, state.id);
      this.db.prepare("UPDATE completion_receipts SET state = 'pending', last_error = NULL WHERE id = ?").run(state.id);
      state.state = "active";
      state.admitting = false;
      if (state.pending) void this.flush(state);
      return response(initial);
    } catch (error) {
      state.admitting = false;
      this.fail(state, error);
      this.retryCompletion(state);
      return response();
    }
  }

  private terminal(state: RecordState, value: unknown): boolean {
    return !!state.completion && !!value && typeof value === "object" &&
      (value as Record<string, unknown>)[state.completion.terminalField] != null;
  }

  private reserveSetup(state: RecordState): void {
    if (this.closed) throw new Error("event subscriptions are closing; nothing was sent");
    if (this.records.size + this.setups.size >= maxSubscriptions) throw new Error("too many event subscriptions; nothing was sent");
    this.setups.add(state);
  }

  /** Only fresh intent with proof of no mutation can be forgotten. Established
   * watches and ambiguous sends retain their original receipts and recovery. */
  private async discardUnsent(state: RecordState, recordId: string): Promise<void> {
    // Graceful close clears the live map, but drains these admissions before
    // closing SQLite. Their proven-unsent reservations must not survive restart.
    if (!this.db.isOpen || !state.completion || state.submissionUnknown || !this.closed && this.records.get(state.id) !== state) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.db.prepare(`SELECT 1 FROM completion_receipts c JOIN subscriptions s ON s.id = c.id
        WHERE c.id = ? AND c.bot_id = ? AND c.thread_id = ? AND c.pkg = ? AND c.operation = ? AND c.record_id = ?
          AND c.state = 'pending' AND c.last_delivered_at IS NULL
          AND s.bot_id = c.bot_id AND s.thread_id = c.thread_id AND s.pkg = c.pkg
          AND s.instance = ? AND s.read_operation = ? AND s.read_arguments_json = ? AND s.completion_json = ?`)
        .get(state.id, state.botId, state.threadId, state.pkg, state.completion.operation, recordId,
          state.instance, state.readOperation, JSON.stringify(state.readArguments), JSON.stringify(state.completion));
      // Explicit cancellation and established/uncertain delivery are retained
      // evidence, never removable by a late fresh-send rejection.
      if (!owned) { this.db.exec("COMMIT"); return; }
      this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(state.id);
      this.db.prepare("DELETE FROM completion_receipts WHERE id = ?").run(state.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.records.delete(state.id);
    state.abort.abort();
    if (state.retry) clearTimeout(state.retry);
    await state.socket?.close();
    if (!this.closed) this.onChange?.();
  }

  private async finishCompletion(state: RecordState, outcome: "observed" | "delivered" | "cancelled"): Promise<void> {
    if (this.closed || this.records.get(state.id) !== state) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE completion_receipts SET state = ?, last_delivered_at = ?, last_error = NULL WHERE id = ?")
        .run(outcome, state.lastDeliveredAt, state.id);
      if (outcome === "cancelled" && state.submissionUnknown) this.db.prepare("UPDATE completion_receipts SET last_error = ? WHERE id = ?")
        .run(state.lastError ?? "Prior native admission outcome is unknown; cancellation cannot recall admitted input.", state.id);
      this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(state.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.records.delete(state.id);
    state.abort.abort();
    if (state.retry) clearTimeout(state.retry);
    await state.socket?.close();
    this.onChange?.();
  }

  private fail(state: RecordState, error: unknown): void {
    state.lastError = error instanceof Error ? error.message : String(error);
    state.state = "error";
    if (this.closed || this.records.get(state.id) !== state) return;
    this.db.prepare("UPDATE subscriptions SET last_error = ? WHERE id = ?").run(state.lastError, state.id);
    if (state.completion) this.db.prepare("UPDATE completion_receipts SET state = ?, last_error = ? WHERE id = ?")
      .run(state.submissionUnknown ? "unknown" : "error", state.lastError, state.id);
    if (state.completion) this.onChange?.();
  }

  private retryCompletion(state: RecordState): void {
    if (this.closed || state.abort.signal.aborted || state.submissionUnknown || state.retry) return;
    state.retry = setTimeout(() => { state.retry = undefined; if (!state.socket) void this.reconnect(state); else { state.pending = true; void this.flush(state); } }, state.retryDelay);
    state.retry.unref();
    state.retryDelay = Math.min(state.retryDelay * 2, 60_000);
  }

  operatorList() {
    return [...this.records.values()].map(state => ({ ...publicView(state), revision: stateHash([state.id, state.botId, state.threadId, state.pkg, state.topic, state.scope, state.readOperation, state.readArguments, state.completion]) }));
  }
  async operatorRemove(id: string, expectedRevision: string) {
    const current = this.operatorList().find(row => row.id === id);
    if (!current) return { id, removed: false };
    if (current.revision !== expectedRevision) throw new Error("subscription revision changed");
    return this.removeRecord(id);
  }

  async unsubscribe(id: string, invocation?: InvocationContext): Promise<{ id: string; removed: boolean }> {
    const target = targetOf(invocation);
    const state = this.records.get(id);
    if (!state) return { id, removed: false };
    if (state.botId !== target.botId || state.threadId !== target.threadId) throw new Error("subscription belongs to another bot thread");
    return this.removeRecord(id);
  }

  private async removeRecord(id: string): Promise<{ id: string; removed: boolean }> {
    const state = this.records.get(id);
    if (!state) return { id, removed: false };
    if (state.completion) { await this.finishCompletion(state, "cancelled"); return { id, removed: true }; }
    this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
    this.records.delete(id);
    state.abort.abort();
    if (state.retry) clearTimeout(state.retry);
    await state.socket?.close();
    this.onChange?.();
    return { id, removed: true };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const states = [...this.records.values(), ...this.setups];
    this.records.clear();
    await Promise.all(states.map(async (state) => {
      state.abort.abort();
      if (state.retry) clearTimeout(state.retry);
      await state.socket?.close();
    }));
    await Promise.allSettled(this.admissions.values());
    this.db.close();
  }

  private definition(pkg: string): Promise<SocketCatalog> {
    return currentMcpCatalog(this.workspace, pkg, this.env);
  }

  private preventFeedback(pkg: string, topic: string, scope: string | null | undefined, botId: string): void {
    preventThreadFeedback(pkg, topic, scope, botId);
    if (pkg !== "bots" || !turnTopics.has(topic) || !scope) return;
    // A watches B and B watches A is as self-referential as A watching A,
    // including mixed chat/thread topics and cycles spanning several Bots.
    const pending = [scope], visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === botId) throw new Error("Bot event subscriptions would create a cross-Bot turn feedback loop");
      if (visited.has(current)) continue;
      visited.add(current);
      for (const record of this.records.values()) {
        if (record.botId === current && record.pkg === "bots" && turnTopics.has(record.topic) && record.scope) pending.push(record.scope);
      }
    }
  }

  private async authorize(state: RecordState): Promise<void> {
    if (this.closed || state.abort.signal.aborted) throw new Error("event subscription cancelled");
    this.preventFeedback(state.pkg, state.topic, state.scope, state.botId);
    // Check policy before package-specific reads, and again afterwards: those
    // checks can themselves await socket I/O while the manifest changes.
    const check = async () => {
      const doc = await this.definition(state.pkg);
      if (!doc.events || !Object.hasOwn(doc.events.topics, state.topic)) throw new Error(`${state.topic} is not available over mcp`);
      if (!doc.tools.some((tool) => tool.name === state.readOperation && tool.annotations?.readOnlyHint))
        throw new Error(`${state.readOperation} is not an exposed read-only ${state.pkg} operation`);
      if (doc.events.scope?.required && !state.scope || state.scope && !doc.events.scope) throw new Error("completion event scope is unavailable");
      if (state.completion) {
        const watch = doc.tools.find(tool => tool.name === state.completion!.operation)?.completionWatch;
        const matches = watch && (state.completion.declaration
          ? valueHash(completionWatchSchema.parse(watch)) === valueHash(state.completion.declaration)
          : watch.topic === state.topic && watch.readOperation === state.readOperation && watch.terminalField === state.completion.terminalField &&
            JSON.stringify(watch.retainFields ?? []) === JSON.stringify(state.completion.retainFields ?? []) && !watch.readArguments && !watch.scope && !watch.updateField &&
            Object.keys(state.readArguments).length === 1 && typeof state.readArguments[watch.idArgument] === "string");
        if (!matches) throw new Error("completion operation is no longer exposed with its watch declaration");
      }
      if (this.closed || state.abort.signal.aborted) throw new Error("event subscription cancelled");
    };
    await check();
    if (state.completion) { await this.validate(state); await check(); }
    if (this.authorizeRead) { await this.authorizeRead(state); await check(); }
  }

  private read(state: RecordState): Promise<unknown> {
    return (async () => {
      await this.authorize(state);
      const value = await socketCall(socketPath(state.pkg, this.env), "tools/call", { name: state.readOperation, arguments: state.readArguments,
        invocation: { transport: "mcp", botId: state.botId, instance: state.instance, threadId: state.threadId, sessionId: null },
      }, { timeoutMs: forwardTimeout(state.pkg, state.readOperation), signal: state.abort.signal });
      await this.authorize(state);
      return value;
    })();
  }

  private watchClosed(state: RecordState): void {
    const current = state.socket;
    if (!current) return;
    void current.closed.then(() => {
      if (state.abort.signal.aborted || this.closed || state.submissionUnknown || this.records.get(state.id) !== state) return;
      state.socket = undefined;
      state.state = "connecting";
      if (state.retry) clearTimeout(state.retry);
      state.retry = setTimeout(() => { state.retry = undefined; void this.reconnect(state); }, 1_000);
      state.retry.unref();
    });
  }

  private async reconnect(state: RecordState): Promise<void> {
    if (state.abort.signal.aborted || this.closed || state.submissionUnknown) return;
    try {
      const target = this.rebind ? await this.rebind(state.botId, state.threadId) : { botId: state.botId, threadId: state.threadId, instance: state.instance };
      if (!target) {
        if (state.completion) { await this.finishCompletion(state, "cancelled"); return; }
        this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(state.id);
        this.records.delete(state.id);
        state.abort.abort();
        return;
      }
      await this.validate(target);
      state.instance = target.instance;
      this.db.prepare("UPDATE subscriptions SET instance = ? WHERE id = ?").run(state.instance, state.id);
      this.preventFeedback(state.pkg, state.topic, state.scope, state.botId);
      await this.authorize(state);
      state.socket = await this.connect(state);
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

  private connect(state: RecordState): Promise<SocketSubscription> {
    return socketSubscribe(socketPath(state.pkg, this.env), [state.topic], () => {
      state.pending = true;
      if (this.records.has(state.id) && !state.admitting) void this.flush(state);
    }, { scope: state.scope ?? undefined, signal: state.abort.signal });
  }

  private async flush(state: RecordState): Promise<void> {
    if (state.flushing || state.admitting || state.submissionUnknown || !this.records.has(state.id)) return;
    state.flushing = true;
    try {
      while (state.pending && !state.abort.signal.aborted) {
        state.pending = false;
        state.state = "delivering";
        try {
          const value = await this.read(state);
          const terminal = this.terminal(state, value);
          const update = state.completion?.updateField && value && typeof value === "object" && (value as Record<string, unknown>)[state.completion.updateField] != null;
          if (state.completion && !terminal && !update) {
            state.state = "active"; state.lastError = null;
            this.db.prepare("UPDATE subscriptions SET last_error = NULL WHERE id = ?").run(state.id);
            this.db.prepare("UPDATE completion_receipts SET state = 'pending', last_error = NULL WHERE id = ?").run(state.id);
            continue;
          }
          const encoded = JSON.stringify(value);
          const hash = valueHash(value);
          if ((!state.reconnect || state.completion) && hash === state.lastValueHash) { state.state = "active"; continue; }
          const authorize = async () => {
            await this.authorize(state);
            if (state.completion && state.admitting) throw new Error("completion initial observation is in progress; native submission deferred");
          };
          await authorize();
          await this.deliver({ subscription: publicView(state), reason: state.reconnect ? "reconnected" : "changed",
            value: encoded.length <= maxValueChars ? value : { ...(state.completion && value && typeof value === "object" ?
                Object.fromEntries(Object.entries(value).filter(([key]) => [state.completion!.terminalField, state.completion!.updateField, ...(state.completion!.retainFields ?? [])].includes(key))) : {}),
               readOperation: state.readOperation, readArguments: state.readArguments, bytes: Buffer.byteLength(encoded), note: "Value exceeds turn limit; call the read operation for the full record. Outcome and attention fields are retained." },
              truncated: encoded.length > maxValueChars }, state.abort.signal, authorize, state.completion ? () => {
                if (state.admitting || state.abort.signal.aborted || this.closed) throw new Error("completion submission cancelled before native admission");
               // Persist before the native send. Crash or a lost ACK is ambiguous, never a safe replay.
               this.db.prepare("UPDATE completion_receipts SET state = 'unknown', delivery_kind = ? WHERE id = ?").run(terminal ? "terminal" : "update", state.id);
               state.submissionUnknown = true;
             } : undefined);
          // Admission ACK only: later snapshots must not wait for the agent's turn to finish.
          state.lastDeliveredAt = Date.now();
          if (state.completion && terminal) { await this.finishCompletion(state, "delivered"); return; }
          state.lastValueHash = hash;
          state.lastError = null;
          state.reconnect = false;
          state.state = "active";
          if (!this.closed) this.db.prepare("UPDATE subscriptions SET last_delivered_at = ?, last_error = NULL, last_value_hash = ? WHERE id = ?").run(state.lastDeliveredAt, state.lastValueHash, state.id);
          if (state.completion && !this.closed && !state.abort.signal.aborted) {
            this.db.prepare("UPDATE completion_receipts SET state = 'pending', last_delivered_at = ?, last_error = NULL WHERE id = ?").run(state.lastDeliveredAt, state.id);
            state.submissionUnknown = false;
            this.onChange?.();
          }
        } catch (error) {
          if (state.completion && error instanceof McpDeliveryRejected) state.submissionUnknown = false;
          this.fail(state, error);
          if (state.completion) { this.retryCompletion(state); break; }
        }
      }
    } finally { state.flushing = false; }
  }
}
