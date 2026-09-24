import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { operation, type InvocationContext } from "../src/operation.js";
import { McpEventSubscriptions, type EventValue } from "../src/mcp-subscriptions.js";
import { serveSocket } from "../src/socket.js";
import { socketPath } from "../src/workspace.js";

const caller: InvocationContext = { transport: "mcp", botId: "bot-1", instance: "launch-1", threadId: "main", sessionId: "session-1" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await pause(10);
  assert.ok(check(), "expected event activity did not arrive");
}

test("MCP subscriptions return an initial value, coalesce notices, reconnect with a snapshot, and fence ownership", { timeout: 15_000 }, async () => {
  const root = await mkdtemp("/tmp/as-events-");
  const env = { AGENTSTACK_STATE_DIR: root };
  let value = 0;
  const snapshot = operation({ name: "bot_list", description: "Read bots.", input: z.strictObject({}), output: z.object({ value: z.number() }),
    annotations: { readOnlyHint: true }, async call() { return { value }; } });
  const change = operation({ name: "change", description: "Mutate.", input: z.strictObject({}), output: z.object({ ok: z.boolean() }),
    async call() { return { ok: true }; } });
  const serve = () => serveSocket({
    info: { name: "bots", description: "Bots.", transportDescription: "Socket.", path: socketPath("bots", env) },
    context: {}, operations: [snapshot, change],
    events: { topics: { bots_changed: "Refresh bot_list.", threads_changed: "Refresh thread state." }, scope: { description: "Bot ID.", example: "bot-1", required: true, valid: (_ctx, scope) => scope === "bot-1" } },
  });
  let socket = await serve();
  const delivered: EventValue[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const service = new McpEventSubscriptions(env, async (target) => { assert.equal(target.threadId, "main"); }, async (event) => {
    delivered.push(event);
    if (delivered.length === 1) await firstWait;
  });
  try {
    const catalog = await service.catalog("bots");
    assert.deepEqual(catalog.topics, { bots_changed: "Refresh bot_list.", threads_changed: "Refresh thread state." });
    assert.deepEqual(catalog.reads.map((item) => item.name), ["bot_list"]);
    await assert.rejects(service.subscribe("bots", { topic: "threads_changed", readOperation: "bot_list" }, caller), /turn feedback loop/);
    await assert.rejects(service.subscribe("bots", { topic: "bots_changed", readOperation: "change" }, caller), /not a read-only/);
    const input = { topic: "bots_changed", readOperation: "bot_list" };
    const initial = await service.subscribe("bots", input, caller);
    assert.deepEqual(initial.value, { value: 0 });
    assert.equal(initial.subscription.scope, "bot-1");
    assert.equal((await service.subscribe("bots", input, caller)).subscription.id, initial.subscription.id);
    assert.equal(service.status(caller).subscriptions.length, 1);
    value = 1;
    socket.publish?.("bots_changed", "bot-1");
    await until(() => delivered.length === 1);
    value = 3;
    socket.publish?.("bots_changed", "bot-1");
    socket.publish?.("bots_changed", "bot-1");
    await pause(30); // Let both invalidations arrive while the first delivery is still blocked.
    releaseFirst?.();
    await until(() => delivered.length === 2);
    assert.deepEqual(delivered.map((event) => event.value), [{ value: 1 }, { value: 3 }]);
    assert.deepEqual(delivered.map((event) => event.reason), ["changed", "changed"]);
    socket.publish?.("bots_changed", "bot-1");
    await pause(30);
    assert.equal(delivered.length, 2, "unchanged snapshots do not create duplicate turns");
    await assert.rejects(service.unsubscribe(initial.subscription.id, { ...caller, threadId: "other" }), /another bot thread/);
    await socket.close();
    socket = await serve();
    value = 4;
    await until(() => delivered.length === 3, 5_000);
    assert.equal(delivered[2]?.reason, "reconnected");
    assert.deepEqual(delivered[2]?.value, { value: 4 });
    assert.deepEqual(await service.unsubscribe(initial.subscription.id, caller), { id: initial.subscription.id, removed: true });
    value = 5;
    socket.publish?.("bots_changed", "bot-1");
    await pause(30);
    assert.equal(delivered.length, 3);
  } finally {
    releaseFirst?.();
    await service.close();
    await socket.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions survive owner-process recreation and rebind to the current Bot launch", { timeout: 10_000 }, async () => {
  const root = await mkdtemp("/tmp/as-events-durable-");
  const env = { AGENTSTACK_STATE_DIR: root };
  const socket = await serveSocket({
    info: { name: "sample", description: "Sample.", transportDescription: "Socket.", path: socketPath("sample", env) },
    context: {}, operations: [operation({ name: "snapshot", description: "Read value.", input: z.strictObject({}), output: z.object({ value: z.number() }),
      annotations: { readOnlyHint: true }, async call() { return { value: 7 }; } })],
    events: { topics: { changed: "Refresh snapshot." } },
  });
  let first: McpEventSubscriptions | undefined;
  let second: McpEventSubscriptions | undefined;
  try {
    first = new McpEventSubscriptions(env, async () => undefined, async () => undefined);
    const subscribed = await first.subscribe("sample", { topic: "changed", readOperation: "snapshot" }, caller);
    assert.equal((await lstat(`${root}/event-subscriptions.sqlite`)).mode & 0o777, 0o600);
    await first.close();
    first = undefined;
    const delivered: EventValue[] = [];
    second = new McpEventSubscriptions(env, async (target) => { assert.equal(target.instance, "launch-2"); },
      async (event) => { delivered.push(event); }, async (botId, threadId) => ({ botId, threadId, instance: "launch-2" }));
    second.resume();
    await until(() => delivered.length === 1);
    assert.equal(delivered[0]?.reason, "reconnected");
    assert.deepEqual(delivered[0]?.value, { value: 7 });
    assert.equal(second.status({ ...caller, instance: "launch-2" }).subscriptions[0]?.id, subscribed.subscription.id);
    await second.unsubscribe(subscribed.subscription.id, { ...caller, instance: "launch-2" });
    await second.close();
    second = undefined;
    const empty = new McpEventSubscriptions(env, async () => undefined, async () => undefined);
    assert.deepEqual(empty.status({ ...caller, instance: "launch-2" }).subscriptions, []);
    await empty.subscribe("sample", { topic: "changed", readOperation: "snapshot" }, caller);
    await empty.close();
    const gone = new McpEventSubscriptions(env, async () => undefined, async () => undefined, async () => null);
    gone.resume();
    await until(() => gone.status(caller).subscriptions.length === 0);
    await gone.close();
  } finally {
    await first?.close();
    await second?.close();
    await socket.close();
    await rm(root, { recursive: true, force: true });
  }
});
