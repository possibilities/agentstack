import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { z } from "zod";
import { operation, type InvocationContext } from "../src/operation.js";
import { McpEventSubscriptions, type EventValue } from "../src/mcp-subscriptions.js";
import { serveSocket } from "../src/socket.js";
import { socketPath } from "../src/workspace.js";

const caller: InvocationContext = { transport: "mcp", botId: "bot-1", instance: "launch-1", threadId: "main", sessionId: "session-1" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function manifest(root: string, name: string, operations = "all", events = "all") {
  const dir = join(root, "packages", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), `name: ${name}\ndescription: Test.\nmcp:\n  description: Test.\n  operations: ${operations}\n  events: ${events}\n`);
}
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await pause(10);
  assert.ok(check(), "expected event activity did not arrive");
}

test("MCP subscriptions return an initial value, coalesce notices, reconnect with a snapshot, and fence ownership", { timeout: 15_000 }, async () => {
  const root = await mkdtemp("/tmp/as-events-");
  await manifest(root, "bots");
  const env = { STACK_STATE_DIR: root };
  let value = 0;
  const snapshot = operation({ name: "bot_list", description: "Read bots.", input: z.strictObject({}), output: z.object({ value: z.number() }),
    annotations: { readOnlyHint: true }, async call(_ctx, _input, invocation) {
      assert.equal(invocation?.botId, caller.botId);
      assert.equal(invocation?.instance, caller.instance);
      assert.equal(invocation?.threadId, caller.threadId);
      return { value };
    } });
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
  }, undefined, undefined, root);
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

test("optional Bot scopes cannot bypass chat and thread wakeup feedback fencing", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-tree-events-"));
  await manifest(root, "bots");
  const env = { STACK_STATE_DIR: root };
  const socket = await serveSocket({
    info: { name: "bots", description: "Bots.", transportDescription: "Socket.", path: socketPath("bots", env) },
    context: {}, operations: [operation({ name: "chat_tree", description: "Read tree.", input: z.strictObject({}), output: z.object({ nodes: z.array(z.string()) }),
      annotations: { readOnlyHint: true }, async call() { return { nodes: [] }; } })],
    events: { topics: { chats_changed: "Refresh chats.", threads_changed: "Refresh threads.", chat_live_changed: "Refresh live chat.", chat_queue_changed: "Refresh queue." },
      scope: { description: "Bot ID.", example: "bot-1", valid: (_ctx, scope) => ["bot-1", "bot-2"].includes(scope) } },
  });
  const service = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
  let restored: McpEventSubscriptions | undefined;
  try {
    for (const topic of ["chats_changed", "threads_changed", "chat_live_changed", "chat_queue_changed"]) {
      for (const scope of [undefined, "bot-1"]) {
        await assert.rejects(service.subscribe("bots", { topic, scope, readOperation: "chat_tree" }, caller), /turn feedback loop/);
      }
      const other = await service.subscribe("bots", { topic, scope: "bot-2", readOperation: "chat_tree" }, caller);
      assert.equal(other.subscription.scope, "bot-2");
    }
    await assert.rejects(service.subscribe("bots", { topic: "chat_live_changed", scope: "bot-1", readOperation: "chat_tree" },
      { ...caller, botId: "bot-2" }), /cross-Bot turn feedback loop/);
    await service.close();
    // Simulate subscriptions admitted by an older server, before the chat and
    // optional-scope guard. Restart must fence them before any delivery too.
    const db = new DatabaseSync(join(root, "event-subscriptions.sqlite"));
    try {
      db.exec("UPDATE subscriptions SET scope = CASE WHEN topic = 'chats_changed' THEN NULL ELSE 'bot-1' END");
    } finally { db.close(); }
    let delivered = 0;
    restored = new McpEventSubscriptions(env, async () => undefined, async () => { delivered++; }, undefined, undefined, root);
    restored.resume();
    await until(() => restored!.status(caller).subscriptions.every((item) => item.state === "error"));
    assert.equal(delivered, 0);
    assert.ok(restored.status(caller).subscriptions.every((item) => item.lastError?.includes("turn feedback loop")));
  } finally {
    await service.close();
    await restored?.close();
    await socket.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions survive server-process recreation and rebind to the current Bot launch", { timeout: 10_000 }, async () => {
  const root = await mkdtemp("/tmp/as-events-durable-");
  await manifest(root, "sample");
  const env = { STACK_STATE_DIR: root };
  const socket = await serveSocket({
    info: { name: "sample", description: "Sample.", transportDescription: "Socket.", path: socketPath("sample", env) },
    context: {}, operations: [operation({ name: "snapshot", description: "Read value.", input: z.strictObject({}), output: z.object({ value: z.number() }),
      annotations: { readOnlyHint: true }, async call() { return { value: 7 }; } })],
    events: { topics: { changed: "Refresh snapshot." } },
  });
  let first: McpEventSubscriptions | undefined;
  let second: McpEventSubscriptions | undefined;
  try {
    first = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
    const subscribed = await first.subscribe("sample", { topic: "changed", readOperation: "snapshot" }, caller);
    assert.equal((await lstat(`${root}/event-subscriptions.sqlite`)).mode & 0o777, 0o600);
    await first.close();
    first = undefined;
    const delivered: EventValue[] = [];
    second = new McpEventSubscriptions(env, async (target) => { assert.equal(target.instance, "launch-2"); },
      async (event) => { delivered.push(event); }, async (botId, threadId) => ({ botId, threadId, instance: "launch-2" }), undefined, root);
    second.resume();
    await until(() => delivered.length === 1);
    assert.equal(delivered[0]?.reason, "reconnected");
    assert.deepEqual(delivered[0]?.value, { value: 7 });
    assert.equal(second.status({ ...caller, instance: "launch-2" }).subscriptions[0]?.id, subscribed.subscription.id);
    await second.unsubscribe(subscribed.subscription.id, { ...caller, instance: "launch-2" });
    await second.close();
    second = undefined;
    const empty = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
    assert.deepEqual(empty.status({ ...caller, instance: "launch-2" }).subscriptions, []);
    await empty.subscribe("sample", { topic: "changed", readOperation: "snapshot" }, caller);
    await empty.close();
    const gone = new McpEventSubscriptions(env, async () => undefined, async () => undefined, async () => null, undefined, root);
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

test("saved package selectors migrate without dropping Bot watches or replaying old sockets", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "as-renamed-events-"));
  const env = { STACK_STATE_DIR: root };
  const names = ["signal", "browse", "worker"] as const;
  await Promise.all(names.map((name) => manifest(root, name)));
  const sockets = await Promise.all(names.map((name) => serveSocket({
    info: { name, description: name, transportDescription: "Socket", path: socketPath(name, env) },
    context: {}, operations: [operation({ name: "snapshot", description: "Read value.", input: z.strictObject({}), output: z.object({ value: z.string() }),
      annotations: { readOnlyHint: true }, async call() { return { value: name }; } })],
    events: { topics: { [name === "signal" ? "signal_changed" : "changed"]: "Refresh snapshot." } },
  })));
  let first: McpEventSubscriptions | undefined;
  let restored: McpEventSubscriptions | undefined;
  try {
    first = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
    const saved = await Promise.all(names.map((name) => first!.subscribe(name,
      { topic: name === "signal" ? "signal_changed" : "changed", readOperation: "snapshot" }, caller)));
    await first.close();
    first = undefined;
    const db = new DatabaseSync(join(root, "event-subscriptions.sqlite"));
    try {
      db.exec(`UPDATE subscriptions SET pkg = CASE pkg WHEN 'signal' THEN 'attention' WHEN 'browse' THEN 'browser' WHEN 'worker' THEN 'workers' END,
        topic = CASE WHEN pkg = 'signal' THEN 'attention_changed' ELSE topic END`);
    } finally { db.close(); }
    const deliveries: EventValue[] = [];
    restored = new McpEventSubscriptions(env, async () => undefined, async (event) => { deliveries.push(event); }, undefined, undefined, root);
    assert.deepEqual(restored.status(caller).subscriptions.map(({ id, pkg, topic }) => ({ id, pkg, topic })).sort((a, b) => a.pkg.localeCompare(b.pkg)),
      saved.map(({ subscription }, i) => ({ id: subscription.id, pkg: names[i]!, topic: names[i] === "signal" ? "signal_changed" : "changed" })).sort((a, b) => a.pkg.localeCompare(b.pkg)));
    restored.resume();
    await until(() => deliveries.length === names.length);
    assert.deepEqual(deliveries.map(({ subscription, reason }) => [subscription.pkg, reason]).sort(),
      names.map((name) => [name, "reconnected"]).sort());
    await restored.close();
    restored = undefined;
    const again = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
    try { assert.deepEqual(again.status(caller).subscriptions.map((row) => row.pkg).sort(), [...names].sort()); }
    finally { await again.close(); }
  } finally {
    await first?.close();
    await restored?.close();
    await Promise.all(sockets.map((socket) => socket.close()));
    await rm(root, { recursive: true, force: true });
  }
});

test("durable watches reauthorize refresh and discard values read across a policy change", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-policy-events-"));
  const env = { STACK_STATE_DIR: root };
  const file = join(root, "packages", "sample", "api.yaml");
  await manifest(root, "sample", "[snapshot]", "[changed]");
  let reads = 0;
  let release: (() => void) | undefined;
  let block: Promise<void> | undefined;
  const socket = await serveSocket({
    info: { name: "sample", description: "Test.", transportDescription: "Test.", path: socketPath("sample", env) }, context: {},
    operations: [operation({ name: "snapshot", description: "Read.", input: z.strictObject({}), output: z.object({ reads: z.number() }), annotations: { readOnlyHint: true },
      async call() { reads++; await block; return { reads }; } })], events: { topics: { changed: "Refresh." } },
  });
  const delivered: EventValue[] = [];
  const service = new McpEventSubscriptions(env, async () => undefined, async (event) => { delivered.push(event); }, undefined, undefined, root);
  try {
    const input = { topic: "changed", readOperation: "snapshot" };
    await service.subscribe("sample", input, caller);
    const changes = [
      () => manifest(root, "sample", "[]", "all"),
      () => manifest(root, "sample", "all", "[]"),
      () => manifest(root, "sample", "[unknown]", "all"),
      () => writeFile(file, "name: [broken"),
      () => writeFile(file, "name: sample\ndescription: Test.\nsocket:\n  description: Test.\n"),
      () => rm(file),
    ];
    for (const change of changes) {
      const before = reads;
      const deliveries = delivered.length;
      await change();
      socket.publish?.("changed");
      await until(() => service.status(caller).subscriptions[0]?.state === "error");
      assert.equal(reads, before, "revoked policy must prevent a fresh read");
      assert.equal(delivered.length, deliveries);
      await assert.rejects(service.subscribe("sample", input, caller));
      await manifest(root, "sample", "[snapshot]", "[changed]");
      socket.publish?.("changed");
      await until(() => delivered.length === deliveries + 1);
      await until(() => service.status(caller).subscriptions[0]?.state === "active");
    }
    const before = reads;
    const deliveries = delivered.length;
    block = new Promise<void>((resolve) => { release = resolve; });
    socket.publish?.("changed");
    await until(() => reads > before);
    await manifest(root, "sample", "all", "[]");
    release!();
    await until(() => service.status(caller).subscriptions[0]?.state === "error");
    assert.equal(delivered.length, deliveries, "a read started before revocation must not deliver afterwards");
  } finally { release?.(); await service.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});

test("queued deliveries reauthorize after the previous turn and respect unsubscribe", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-queued-events-"));
  const env = { STACK_STATE_DIR: root };
  await manifest(root, "sample");
  let value = 0;
  const socket = await serveSocket({
    info: { name: "sample", description: "Test.", transportDescription: "Test.", path: socketPath("sample", env) }, context: {},
    operations: [operation({ name: "snapshot", description: "Read.", input: z.strictObject({ slot: z.number() }), output: z.object({ value: z.number() }), annotations: { readOnlyHint: true },
      async call() { return { value }; } })], events: { topics: { changed: "Refresh." } },
  });
  const delivered: EventValue[] = [];
  let release: (() => void) | undefined;
  const service = new McpEventSubscriptions(env, async () => undefined, async (event) => {
    delivered.push(event);
    await new Promise<void>((resolve) => { release = resolve; });
  }, undefined, undefined, root);
  try {
    for (const slot of [1, 2]) await service.subscribe("sample", { topic: "changed", readOperation: "snapshot", readArguments: { slot } }, caller);
    value++;
    socket.publish?.("changed");
    await until(() => delivered.length === 1 && service.status(caller).subscriptions.every((row) => row.state === "delivering"));
    await manifest(root, "sample", "[]", "all");
    release!();
    await until(() => service.status(caller).subscriptions.some((row) => row.state === "error"));
    assert.equal(delivered.length, 1);
    await manifest(root, "sample");
    value++;
    socket.publish?.("changed");
    await until(() => delivered.length === 2 && service.status(caller).subscriptions.every((row) => row.state === "delivering"));
    const queued = service.status(caller).subscriptions.find((row) => row.id !== delivered[1]!.subscription.id)!;
    await service.unsubscribe(queued.id, caller);
    release!();
    await until(() => service.status(caller).subscriptions[0]?.state === "active");
    assert.equal(delivered.length, 2, "unsubscribing fences a value already waiting in the thread queue");
  } finally { release?.(); await service.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});
