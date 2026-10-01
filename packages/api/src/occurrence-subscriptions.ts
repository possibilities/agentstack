import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { currentMcpCatalog, currentWorkerCatalog } from "./exposure.js";
import { socketCall } from "./socket.js";
import { socketPath } from "./workspace.js";
import { stateHash } from "./state.js";
import { pollInput, pollOutput, type Occurrence } from "./occurrence.js";
import { McpDeliveryRejected } from "./completion-watch.js";
import type { InvocationContext } from "./operation.js";

export type OccurrenceTarget = { kind: "bot"; botId: string; threadId: string; instance: string }
  | { kind: "worker"; workerId: string; sessionId: string; instance: string };
export type EventPolicy = "native" | "interrupt";
export type OccurrenceRuntime = {
  resolve(invocation: InvocationContext): Promise<OccurrenceTarget>;
  verify(target: OccurrenceTarget): Promise<OccurrenceTarget>;
  deliver(target: OccurrenceTarget, event: Occurrence, deliveryId: string, policy: EventPolicy,
    signal: AbortSignal, authorize: () => Promise<void>, packageName: string): Promise<{ boundary: "native_admission" | "worker_inbox" }>;
};
export const listenInput = z.strictObject({ name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()).default({}),
  cursor: z.string().min(1).max(4096).nullable().default(null), maxAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  policy: z.enum(["native", "interrupt"]).default("native") });
type Subscription = { id: string; target: OccurrenceTarget; pkg: string; name: string; arguments: Record<string, unknown>;
  policy: EventPolicy; cursor: string | null; maxAgeMs?: number; truncated: boolean; lastError: string | null };
type Live = { subscription: Subscription; abort: AbortController; timer?: ReturnType<typeof setTimeout>; running?: Promise<void> };
const identity = (target: OccurrenceTarget) => target.kind === "bot" ? ["bot", target.botId, target.threadId] : ["worker", target.workerId, target.sessionId];
const invocationOf = (target: OccurrenceTarget): InvocationContext => ({ transport: "mcp", botId: target.kind === "bot" ? target.botId : null,
  instance: target.kind === "bot" ? target.instance : null, threadId: target.kind === "bot" ? target.threadId : null, sessionId: null,
  ...(target.kind === "worker" ? { workerId: target.workerId, workerInstance: target.instance } : {}) });

/** A component of Serve's sole subscription owner, sharing its private database.
 * Poll intake is durable before cursor advancement. Native admission is fenced
 * separately; an unknown attempt blocks later input and is never replayed. */
export class OccurrenceSubscriptions {
  private readonly live = new Map<string, Live>();
  private readonly setups = new Map<string, Promise<Subscription>>();
  private closed = false;
  constructor(private readonly db: DatabaseSync, private readonly root: string, private readonly env: NodeJS.ProcessEnv,
    private readonly runtime: OccurrenceRuntime, private readonly capacity: () => number, private readonly changed: () => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS occurrence_subscriptions(id TEXT PRIMARY KEY, identity TEXT NOT NULL, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS occurrence_deliveries(id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, value TEXT NOT NULL,
        state TEXT NOT NULL, boundary TEXT, error TEXT, UNIQUE(subscription_id,event_id));`);
    for (const row of db.prepare("SELECT value FROM occurrence_subscriptions").all() as { value: string }[])
      this.add(JSON.parse(row.value));
  }
  get size() { return this.live.size + this.setups.size; }
  has(id: string) { return this.live.has(id); }
  private add(subscription: Subscription) { this.live.set(subscription.id, { subscription, abort: new AbortController() }); }
  resume() { for (const live of this.live.values()) this.schedule(live, 0); }
  private catalog(pkg: string, target: OccurrenceTarget) { return target.kind === "worker" ? currentWorkerCatalog(this.root, pkg, this.env) : currentMcpCatalog(this.root, pkg, this.env); }
  private async source(subscription: Subscription) {
    const catalog = await this.catalog(subscription.pkg, subscription.target);
    const source = catalog.tools.find(tool => tool.eventSource?.name === subscription.name);
    if (!source || source.annotations?.readOnlyHint !== true) throw new McpError(-32012, "Forbidden", { kind: "event" });
    return source;
  }
  private persist(subscription: Subscription) { this.db.prepare("UPDATE occurrence_subscriptions SET value=? WHERE id=?").run(JSON.stringify(subscription), subscription.id); }
  async subscribe(pkg: string, args: unknown, invocation: InvocationContext) {
    if (this.closed) throw new Error("subscription owner is closing");
    const input = listenInput.parse(args), target = await this.runtime.resolve(invocation);
    if (target.kind === "bot" && input.policy === "interrupt") throw new McpError(-32014, "Unsupported", { feature: "policy", value: "interrupt" });
    if (JSON.stringify(input.arguments).length > 4000) throw new McpError(-32013, "ResourceExhausted", { limit: "argument_bytes" });
    const key = stateHash([identity(target), pkg, input.name, input.arguments, input.policy, input.maxAgeMs ?? null]);
    const pending = this.setups.get(key);
    if (pending) return pending;
    const create = async () => {
      const old = this.db.prepare("SELECT value FROM occurrence_subscriptions WHERE key=?").get(key) as { value: string } | undefined;
      if (old) {
        const existing = JSON.parse(old.value) as Subscription;
        await this.source(existing); await this.runtime.verify(existing.target);
        return existing;
      }
      if (this.capacity() >= 128) throw new McpError(-32013, "ResourceExhausted", { limit: "subscriptions", max: 128 });
      const subscription: Subscription = { id: randomUUID(), target, pkg, ...input, truncated: false, lastError: null };
      const source = await this.source(subscription);
      // Null bootstrap records a source-owned watermark, without waking a model.
      const initial = pollOutput.parse(await socketCall(socketPath(pkg, this.env), "tools/call", { name: source.name,
        arguments: pollInput.parse({ name: input.name, arguments: input.arguments, cursor: input.cursor, maxAgeMs: input.maxAgeMs, maxEvents: 1 }), invocation: invocationOf(target) }));
      if (this.closed) throw new Error("subscription owner is closing");
      await this.source(subscription); await this.runtime.verify(target);
      if (initial.events.length) {
        // An explicit replay cursor is retained; the pump durably admits its first batch.
        subscription.cursor = input.cursor;
      } else subscription.cursor = initial.cursor;
      subscription.truncated = initial.truncated;
      if (this.closed) throw new Error("subscription owner is closing");
      this.db.prepare("INSERT INTO occurrence_subscriptions VALUES(?,?,?,?)").run(subscription.id, JSON.stringify(identity(target)), key, JSON.stringify(subscription));
      this.add(subscription); this.schedule(this.live.get(subscription.id)!, 0); this.changed();
      return subscription;
    };
    const task = create(); this.setups.set(key, task);
    try { return await task; } finally { this.setups.delete(key); }
  }
  async status(invocation: InvocationContext) {
    const target = await this.runtime.resolve(invocation);
    return [...this.live.values()].filter(({ subscription }) => JSON.stringify(identity(subscription.target)) === JSON.stringify(identity(target)))
      .map(({ subscription }) => ({ ...subscription, deliveries: this.db.prepare("SELECT id,event_id AS eventId,state,boundary,error FROM occurrence_deliveries WHERE subscription_id=? ORDER BY rowid DESC LIMIT 128").all(subscription.id) }));
  }
  async unsubscribe(id: string, invocation: InvocationContext) {
    const target = await this.runtime.resolve(invocation), live = this.live.get(id);
    if (!live) return { id, removed: false };
    if (JSON.stringify(identity(live.subscription.target)) !== JSON.stringify(identity(target))) throw new Error("occurrence subscription belongs to another conversation");
    live.abort.abort(); if (live.timer) clearTimeout(live.timer);
    await live.running;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM occurrence_deliveries WHERE subscription_id=?").run(id);
      this.db.prepare("DELETE FROM occurrence_subscriptions WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.live.delete(id); this.changed(); return { id, removed: true };
  }
  private schedule(live: Live, delay: number) {
    if (this.closed || live.abort.signal.aborted || live.timer || live.running) return;
    live.timer = setTimeout(() => {
      live.timer = undefined;
      live.running = this.pump(live).finally(() => { live.running = undefined; });
    }, delay);
    live.timer.unref();
  }
  private async pump(live: Live) {
    const sub = live.subscription;
    let delay = 1000;
    try {
      sub.target = await this.runtime.verify(sub.target);
      const source = await this.source(sub);
      const unknown = this.db.prepare("SELECT 1 FROM occurrence_deliveries WHERE subscription_id=? AND state='unknown'").get(sub.id);
      if (unknown) throw new Error("Prior delivery is unknown; inspect it before replacing this subscription. No automatic replay.");
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM occurrence_deliveries").get() as { count: number }).count;
      if (count >= 10_000) throw new McpError(-32013, "ResourceExhausted", { limit: "occurrence_receipts", max: 10_000 });
      const result = pollOutput.parse(await socketCall(socketPath(sub.pkg, this.env), "tools/call", { name: source.name,
        arguments: { name: sub.name, arguments: sub.arguments, cursor: sub.cursor, maxAgeMs: sub.maxAgeMs, maxEvents: Math.min(25, 10_000 - count) },
        invocation: invocationOf(sub.target) }, { signal: live.abort.signal }));
      await this.source(sub); sub.target = await this.runtime.verify(sub.target);
      live.abort.signal.throwIfAborted(); if (this.closed) return;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const event of result.events) {
          if (event.name !== sub.name) throw new Error("source returned another event name");
          this.db.prepare("INSERT OR IGNORE INTO occurrence_deliveries VALUES(?,?,?,?,'pending',NULL,NULL)").run(randomUUID(), sub.id, event.eventId, JSON.stringify(event));
        }
        sub.cursor = result.cursor; sub.truncated ||= result.truncated; this.persist(sub);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      const pending = this.db.prepare("SELECT id,value FROM occurrence_deliveries WHERE subscription_id=? AND state='pending' ORDER BY rowid LIMIT 25").all(sub.id) as { id: string; value: string }[];
      for (const row of pending) {
        const authorize = async () => { await this.source(sub); sub.target = await this.runtime.verify(sub.target); live.abort.signal.throwIfAborted(); if (this.closed) throw new Error("subscription owner closing"); };
        await authorize();
        // Fenced before crossing any native/owner input boundary, including crashes.
        this.db.prepare("UPDATE occurrence_deliveries SET state='unknown' WHERE id=?").run(row.id);
        try {
          const ack = await this.runtime.deliver(sub.target, JSON.parse(row.value), row.id, sub.policy, live.abort.signal, authorize, sub.pkg);
          if (this.closed) return;
          this.db.prepare("UPDATE occurrence_deliveries SET state='admitted',boundary=?,error=NULL WHERE id=?").run(ack.boundary, row.id);
        } catch (error) {
          if (!this.closed) this.db.prepare("UPDATE occurrence_deliveries SET state=?,error=? WHERE id=?").run(error instanceof McpDeliveryRejected ? "pending" : "unknown", error instanceof Error ? error.message : String(error), row.id);
          throw error;
        }
      }
      sub.lastError = null;
      delay = result.hasMore || pending.length === 25 ? 1000 : Math.max(1000, result.nextPollMs);
    } catch (error) { sub.lastError = error instanceof Error ? error.message : String(error); delay = 5000; }
    finally {
      if (!this.closed && !live.abort.signal.aborted) { this.persist(sub); this.changed();
        // Schedule after running has settled, without overlapping pumps.
        queueMicrotask(() => { void live.running?.then(() => this.schedule(live, delay)); }); }
    }
  }
  async close() {
    this.closed = true;
    for (const live of this.live.values()) { live.abort.abort(); if (live.timer) clearTimeout(live.timer); }
    await Promise.allSettled([...this.setups.values(), ...[...this.live.values()].map(live => live.running)]);
  }
}
