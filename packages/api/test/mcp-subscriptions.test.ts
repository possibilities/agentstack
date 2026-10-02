import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { z } from "zod";
import { operation, type CompletionWatch, type InvocationContext } from "../src/operation.js";
import { OperationRejected } from "../src/execute.js";
import { completionHistoryListInput } from "../src/completion-history.js";
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
      // Recreate the pre-completion-watch shape, not a fresh current database.
      db.exec("ALTER TABLE subscriptions DROP COLUMN completion_json; DROP TABLE completion_receipts");
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

test("subscriptions on one thread submit independently and cancellation fences an in-flight value", async () => {
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
  const service = new McpEventSubscriptions(env, async () => undefined, async (event, _signal, authorize) => {
    if (event.subscription.readArguments.slot === 1) await new Promise<void>((resolve) => { release = resolve; });
    await authorize();
    delivered.push(event);
  }, undefined, undefined, root);
  try {
    for (const slot of [1, 2]) await service.subscribe("sample", { topic: "changed", readOperation: "snapshot", readArguments: { slot } }, caller);
    value++;
    socket.publish?.("changed");
    await until(() => delivered.length === 1 && Boolean(release));
    assert.equal(delivered[0]?.subscription.readArguments.slot, 2, "one slow admission must not block another subscription on the same thread");
    const blocked = service.status(caller).subscriptions.find((row) => row.readArguments.slot === 1)!;
    await service.unsubscribe(blocked.id, caller);
    release!();
    await until(() => service.status(caller).subscriptions[0]?.state === "active");
    await pause(30);
    assert.equal(delivered.length, 1, "unsubscribing fences the blocked submission");
  } finally { release?.(); await service.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});

test("ordinary and completion admissions share bounded active plus in-flight capacity and release failed setup", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "as-capacity-events-"));
  const env = { STACK_STATE_DIR: root };
  await manifest(root, "sample"); await mkdir(join(root, "sockets"));
  const peers = new Set<Socket>();
  const pending: Array<{ peer: Socket; id: unknown }> = [];
  const records = new Map<string, object>();
  let held = true, settled = 0;
  const reply = (peer: Socket, frame: object) => { if (!peer.destroyed) peer.write(`${JSON.stringify(frame)}\n`); };
  // Hold the real events/subscribe acknowledgements, after owner capacity checks.
  const socket = createServer(peer => {
    peers.add(peer); peer.once("close", () => peers.delete(peer)); peer.on("error", () => undefined);
    peer.once("data", raw => {
      const request = JSON.parse(String(raw)) as { id: unknown; method: string; params?: any };
      if (request.method === "tools/list") reply(peer, { id: request.id, result: { tools: [
        { name: "snapshot", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "send", inputSchema: { type: "object" }, completionWatch: { topic: "changed", readOperation: "snapshot", idArgument: "id", terminalField: "done", defaultWhen: [] } },
      ], events: { topics: { changed: "Refresh" } } } });
      else if (request.method === "events/subscribe") {
        pending.push({ peer, id: request.id });
        if (!held) reply(peer, { id: request.id, result: { topics: ["changed"] } });
      } else if (request.method === "tools/call") {
        const input = request.params.arguments;
        if (request.params.name === "send") records.set(input.id, { id: input.id, done: null });
        reply(peer, { id: request.id, result: records.get(input.id) ?? { slot: input.slot, done: null } });
      }
    });
  });
  await new Promise<void>(resolve => socket.listen(socketPath("sample", env), resolve));
  const service = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
  const requests = Array.from({ length: 130 }, (_, n) => (n % 2
    ? service.callAndWatch("sample", "send", { id: randomUUID(), subscribe: true }, caller)
    : service.subscribe("sample", { topic: "changed", readOperation: "snapshot", readArguments: { slot: n } }, caller)
  ).finally(() => { settled++; }));
  // Observe rejected promises immediately while admitted requests await the ACK.
  const results = Promise.allSettled(requests);
  try {
    await until(() => pending.length + settled === 130);
    assert.equal(pending.length, 128, "in-flight setup must count against the shared limit before any watch is active");
    held = false;
    pending.forEach(({ peer, id }, n) => reply(peer, n ? { id, result: { topics: ["changed"] } } : { id, error: { message: "setup refused" } }));
    const outcomes = await results;
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 127);
    assert.equal(outcomes.filter(result => result.status === "rejected").length, 3);
    assert.equal(service.operatorList().length, 127);
    const recovered = await service.subscribe("sample", { topic: "changed", readOperation: "snapshot", readArguments: { slot: 999 } }, caller);
    assert.equal(service.operatorList().length, 128, "failed setup releases its capacity reservation");
    await assert.rejects(service.callAndWatch("sample", "send", { id: randomUUID(), subscribe: true }, caller), /too many event subscriptions/);
    await service.unsubscribe(recovered.subscription.id, caller);
    await service.subscribe("sample", { topic: "changed", readOperation: "snapshot", readArguments: { slot: 1000 } }, caller);
    assert.equal(service.operatorList().length, 128, "explicit removal releases active capacity");
  } finally {
    held = false; pending.forEach(({ peer, id }) => reply(peer, { id, error: { message: "test closing" } }));
    await results; await service.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => socket.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});

test("mapped admission watches retain exact identity, acknowledge attention without retirement and never replay ambiguous attention", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "as-turn-watch-"));
  const env = { STACK_STATE_DIR: root };
  await manifest(root, "sample");
  const watch: CompletionWatch = { topic: "changed", readOperation: "observation", idArgument: "requestId", terminalField: "result", defaultWhen: [],
    defaultOnForBot: true, updateField: "update", initialValueField: "observation", scope: { input: "requestId", prefix: "request:" },
    readArguments: { requestId: { input: "requestId" }, botId: { invocation: "botId" }, threadId: { invocation: "threadId" } } };
  const values = new Map<string, { result: Record<string, unknown> | null; update: Record<string, unknown> | null }>();
  const delivered: EventValue[] = [];
  let ambiguous: string | null = null;
  const socket = await serveSocket({
    info: { name: "sample", description: "Test.", transportDescription: "Test.", path: socketPath("sample", env) }, context: {},
    operations: [
      operation({ name: "admit", description: "Admit.", input: z.strictObject({ requestId: z.uuid() }), output: z.object({ admitted: z.string() }), completionWatch: watch,
        async call(_ctx, { requestId }) { if (!values.has(requestId)) values.set(requestId, { result: null, update: null }); return { admitted: requestId }; } }),
      operation({ name: "observation", description: "Read exact request.", input: z.strictObject({ requestId: z.uuid(), botId: z.string(), threadId: z.string() }), output: z.object({ result: z.object({}).passthrough().nullable(), update: z.object({}).passthrough().nullable() }), annotations: { readOnlyHint: true },
        async call(_ctx, { requestId, botId, threadId }) {
          assert.equal(botId, caller.botId); assert.equal(threadId, caller.threadId);
          return values.get(requestId) ?? { result: null, update: null };
        } }),
    ], events: { topics: { changed: "Semantic change." }, scope: { required: true, description: "Exact pre-admission request.", example: "request:UUID", valid: (_ctx, scope) => /^request:[0-9a-f-]{36}$/.test(scope) } },
  });
  const create = () => new McpEventSubscriptions(env, async () => undefined, async (event, _signal, authorize, submitting) => {
    await authorize(); submitting?.(); delivered.push(event);
    if (event.subscription.readArguments.requestId === ambiguous) throw new Error("native response lost");
  }, undefined, undefined, root);
  let service = create();
  const requestId = randomUUID(), unknownId = randomUUID();
  try {
    const admitted = await service.callAndWatch("sample", "admit", { requestId }, caller);
    assert.equal(admitted.admitted, requestId, "the read projection must not replace admission fields");
    assert.deepEqual(admitted.observation, { result: null, update: null });
    const receiptId = (admitted.subscription as { id: string }).id;
    assert.equal(service.operatorList()[0]?.scope, `request:${requestId}`);
    values.set(requestId, { result: null, update: { phase: "awaiting_input", permissionIds: ["permission-1"] } });
    socket.publish?.("changed", `request:${requestId}`);
    await until(() => service.status(caller).completions[0]?.lastDeliveredAt !== null);
    assert.equal(delivered.length, 1);
    assert.equal(service.status(caller).completions[0]?.state, "pending");
    assert.equal(service.status(caller).completions[0]?.lastDeliveryKind, "update");
    await service.close(); service = create(); service.resume();
    await until(() => service.operatorList()[0]?.state === "active", 5_000);
    await pause(50);
    assert.equal(delivered.length, 1, "reconnect must not repeat acknowledged permission facts");
    values.set(requestId, { result: { turnId: "exact-turn", phase: "completed" }, update: null });
    socket.publish?.("changed", `request:${requestId}`);
    await until(() => service.status(caller, receiptId).completions[0]?.state === "delivered");
    assert.equal(service.operatorList().length, 0, "only terminal acknowledgement retires the watch");
    assert.equal(service.status(caller, receiptId).completions[0]?.lastDeliveryKind, "terminal");
    assert.equal(delivered.length, 2);
    const repeated = await service.callAndWatch("sample", "admit", { requestId }, caller);
    assert.equal((repeated.subscription as { state: string }).state, "delivered");
    assert.equal(delivered.length, 2);
    values.delete(requestId);
    await assert.rejects(service.callAndWatch("sample", "admit", { requestId }, caller), /retained admission.*unavailable/);
    assert.equal(values.has(requestId), false, "retired receipt retry must not re-admit a record removed by owner maintenance");

    const unknown = await service.callAndWatch("sample", "admit", { requestId: unknownId }, caller);
    ambiguous = unknownId;
    values.set(unknownId, { result: null, update: { phase: "awaiting_input", permissionIds: ["permission-2"] } });
    socket.publish?.("changed", `request:${unknownId}`);
    const unknownReceipt = (unknown.subscription as { id: string }).id;
    await until(() => service.status(caller, unknownReceipt).completions[0]?.state === "unknown");
    assert.equal(service.status(caller, unknownReceipt).completions[0]?.lastDeliveryKind, "update");
    await service.close(); service = create(); service.resume();
    values.set(unknownId, { result: { phase: "completed" }, update: null });
    socket.publish?.("changed", `request:${unknownId}`);
    await service.callAndWatch("sample", "admit", { requestId: unknownId }, caller);
    await pause(50);
    assert.equal(delivered.length, 3, "ambiguous intermediate admission freezes subsequent delivery and ID retries");
    assert.equal(service.status(caller, unknownReceipt).completions[0]?.state, "unknown");
  } finally { await service.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});

test("operator completion history pages retained receipts across all states without leaking arguments or error text", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "as-history-"));
  await manifest(root, "sample");
  const env = { STACK_STATE_DIR: root };
  const watch: CompletionWatch = { topic: "changed", readOperation: "observation", idArgument: "requestId", terminalField: "result", defaultWhen: [],
    defaultOnForBot: true, updateField: "update", initialValueField: "observation", scope: { input: "requestId", prefix: "request:" },
    readArguments: { requestId: { input: "requestId" }, botId: { invocation: "botId" }, threadId: { invocation: "threadId" }, tag: { input: "tag" } } };
  const values = new Map<string, { result: Record<string, unknown> | null; update: Record<string, unknown> | null }>();
  const failReads = new Set<string>();
  const failDeliveries = new Set<string>();
  const refuseAdmissions = new Set<string>();
  const socket = await serveSocket({
    info: { name: "sample", description: "Test.", transportDescription: "Test.", path: socketPath("sample", env) }, context: {},
    operations: [
      operation({ name: "admit", description: "Admit.", input: z.strictObject({ requestId: z.uuid(), tag: z.string() }), output: z.object({ admitted: z.string() }), completionWatch: watch,
        async call(_ctx, { requestId }) {
          if (refuseAdmissions.has(requestId)) throw new OperationRejected("CANARY-ERROR-refused");
          if (!values.has(requestId)) values.set(requestId, { result: null, update: null });
          return { admitted: requestId };
        } }),
      operation({ name: "observation", description: "Read.", input: z.strictObject({ requestId: z.uuid(), botId: z.string(), threadId: z.string(), tag: z.string() }),
        output: z.object({ result: z.object({}).passthrough().nullable(), update: z.object({}).passthrough().nullable() }), annotations: { readOnlyHint: true },
        async call(_ctx, { requestId }) {
          if (failReads.has(requestId)) throw new Error("CANARY-ERROR-read-failed");
          return values.get(requestId) ?? { result: null, update: null };
        } }),
    ], events: { topics: { changed: "Changed." }, scope: { description: "Exact request.", example: "request:UUID", required: true, valid: (_ctx, scope) => /^request:[0-9a-f-]{36}$/.test(scope) } },
  });
  const delivered: EventValue[] = [];
  let announcements = 0, announcedBeforeSend = -1;
  let service = new McpEventSubscriptions(env, async () => undefined, async (event, _signal, authorize, submitting) => {
    await authorize(); submitting?.(); announcedBeforeSend = announcements; delivered.push(event);
    const requestId = (event.subscription.readArguments as { requestId?: string }).requestId;
    if (requestId && failDeliveries.has(requestId)) throw new Error("CANARY-ERROR-delivery-lost");
  }, undefined, undefined, root);
  service.onSubscriptionsChange = () => { announcements++; };
  const history = (input: Record<string, unknown> = {}) => service.completionHistory(completionHistoryListInput.parse(input));
  const get = (id: string) => service.completionHistoryGet(id)!;
  const admit = async (requestId: string) => (await service.callAndWatch("sample", "admit", { requestId, tag: `CANARY-READARG-${requestId}` }, caller)).subscription as { id: string };
  try {
    let revision = history().revision;
    let before = announcements;
    const pendingId = randomUUID();
    const pendingReceipt = (await admit(pendingId)).id;
    assert.ok(announcements > before, "watch creation announces a subscription change");
    assert.notEqual(history().revision, revision);
    assert.deepEqual(get(pendingReceipt), {
      id: pendingReceipt, botId: caller.botId, threadId: caller.threadId, pkg: "sample", operation: "admit", recordId: pendingId,
      state: "pending", lastDeliveredAt: null, lastDeliveryKind: null, lastError: null, nativeAdmissionUncertain: false, subscriptionPresent: true,
    });

    const observedId = randomUUID();
    values.set(observedId, { result: { done: true }, update: null });
    before = announcements;
    const observed = await service.callAndWatch("sample", "admit", { requestId: observedId, tag: "CANARY-READARG-o" }, caller);
    assert.equal((observed.subscription as { state: string }).state, "observed");
    const observedReceipt = (observed.subscription as { id: string }).id;
    assert.ok(announcements > before);
    assert.equal(get(observedReceipt).subscriptionPresent, false, "a watch that observes terminal on its first read retires immediately");

    const errorId = randomUUID();
    failReads.add(errorId);
    const errorReceipt = (await admit(errorId)).id;
    await until(() => service.completionHistoryGet(errorReceipt)?.state === "error");
    assert.equal(get(errorReceipt).lastError, "diagnostic_withheld");
    assert.equal(get(errorReceipt).nativeAdmissionUncertain, false);
    assert.equal(get(errorReceipt).subscriptionPresent, true);

    before = announcements;
    revision = history().revision;
    values.set(pendingId, { result: null, update: { phase: "awaiting_input" } });
    socket.publish?.("changed", `request:${pendingId}`);
    await until(() => service.completionHistoryGet(pendingReceipt)?.lastDeliveryKind === "update" && service.completionHistoryGet(pendingReceipt)?.state === "pending");
    assert.ok(announcedBeforeSend > before, "the pre-dispatch unknown write is announced before the native send returns");
    assert.ok(announcements > announcedBeforeSend, "the pending acknowledgement is announced");
    assert.notEqual(history().revision, revision);
    assert.equal(get(pendingReceipt).state, "pending");
    assert.equal(get(pendingReceipt).lastDeliveryKind, "update");
    assert.ok(get(pendingReceipt).lastDeliveredAt !== null);

    const doneId = randomUUID();
    const doneReceipt = (await admit(doneId)).id;
    before = announcements;
    values.set(doneId, { result: { finished: true }, update: null });
    socket.publish?.("changed", `request:${doneId}`);
    await until(() => service.completionHistoryGet(doneReceipt)?.state === "delivered");
    assert.ok(announcements > before);
    assert.equal(get(doneReceipt).lastDeliveryKind, "terminal");
    assert.equal(get(doneReceipt).subscriptionPresent, false, "a retired watch keeps its receipt");

    const unknownId = randomUUID();
    const unknownReceipt = (await admit(unknownId)).id;
    failDeliveries.add(unknownId);
    values.set(unknownId, { result: null, update: { phase: "awaiting_input" } });
    socket.publish?.("changed", `request:${unknownId}`);
    await until(() => service.completionHistoryGet(unknownReceipt)?.state === "unknown");
    assert.equal(get(unknownReceipt).lastError, "native_admission_unknown");
    assert.equal(get(unknownReceipt).nativeAdmissionUncertain, true);
    assert.equal(get(unknownReceipt).lastDeliveryKind, "update");
    assert.equal(get(unknownReceipt).subscriptionPresent, true);

    const cancelReceipt = (await admit(randomUUID())).id;
    before = announcements;
    await service.operatorRemove(cancelReceipt, service.operatorList().find(row => row.id === cancelReceipt)!.revision);
    assert.ok(announcements > before);
    const cancelled = get(cancelReceipt);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.subscriptionPresent, false);
    assert.equal(cancelled.lastError, null);
    assert.equal(cancelled.nativeAdmissionUncertain, false);

    const errorCancelId = randomUUID();
    failReads.add(errorCancelId);
    const errorCancelReceipt = (await admit(errorCancelId)).id;
    await until(() => service.completionHistoryGet(errorCancelReceipt)?.state === "error");
    await service.operatorRemove(errorCancelReceipt, service.operatorList().find(row => row.id === errorCancelReceipt)!.revision);
    const cancelledError = get(errorCancelReceipt);
    assert.equal(cancelledError.state, "cancelled");
    assert.equal(cancelledError.lastError, null, "cancellation of a known-failed watch withholds nothing uncertain");
    assert.equal(cancelledError.nativeAdmissionUncertain, false);

    const refusedId = randomUUID();
    refuseAdmissions.add(refusedId);
    before = announcements;
    const total = history().total;
    await assert.rejects(service.callAndWatch("sample", "admit", { requestId: refusedId, tag: "CANARY-READARG-r" }, caller), /send refused before mutation/);
    assert.ok(announcements > before, "discarding a proven-unsent reservation announces");
    assert.equal(history().total, total, "a refused fresh send retains no receipt");

    const file = join(root, "event-subscriptions.sqlite");
    const reads = new DatabaseSync(file);
    try {
      const snapshot = () => JSON.stringify([db_all(reads, "subscriptions"), db_all(reads, "completion_receipts"), db_all(reads, "completion_history_meta")]);
      const beforeReads = snapshot();
      for (let n = 0; n < 20; n++) { history(); history({ limit: 3, state: "pending" }); service.completionHistoryGet(pendingReceipt); service.completionHistoryGet(randomUUID()); }
      assert.equal(snapshot(), beforeReads, "reads never write");
    } finally { reads.close(); }

    for (const output of [history(), history({ state: "error" }), service.completionHistoryGet(errorReceipt), service.completionHistoryGet(unknownReceipt)])
      assert.ok(!JSON.stringify(output).includes("CANARY"), "history projections withhold arguments and error text");

    assert.throws(() => service.completionHistory(completionHistoryListInput.parse({ offset: 100 })), /requires the revision from offset 0/);
    for (const bad of [{ limit: 0 }, { limit: 101 }, { recordId: "not-a-uuid" }, { state: "bogus" }, { revision: "shallow" }])
      assert.equal(completionHistoryListInput.safeParse(bad).success, false, JSON.stringify(bad));

    const revisionBefore = history().revision;
    const receiptsBefore = history({ limit: 100 }).completions;
    await service.close();
    service = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
    service.onSubscriptionsChange = () => { announcements++; };
    assert.equal(history().revision, revisionBefore, "restart without receipt changes keeps the paging revision");
    assert.deepEqual(history({ limit: 100 }).completions, receiptsBefore);
    assert.equal(get(unknownReceipt).state, "unknown", "an uncertain admission stays frozen across restart");
    assert.equal(get(doneReceipt).subscriptionPresent, false, "retired watches remain listed");

    const unknownRow = service.operatorList().find(row => row.id === unknownReceipt)!;
    await service.operatorRemove(unknownReceipt, unknownRow.revision);
    const cancelledUnknown = get(unknownReceipt);
    assert.equal(cancelledUnknown.state, "cancelled");
    assert.equal(cancelledUnknown.lastError, "native_admission_unknown", "cancellation preserves uncertainty only for an ambiguous admission");
    assert.equal(cancelledUnknown.nativeAdmissionUncertain, true);
    assert.equal(cancelledUnknown.subscriptionPresent, false);
  } finally {
    await service.close();
    await socket.close();
    await rm(root, { recursive: true, force: true });
  }
});

const db_all = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

test("operator completion history pages beyond the 128-receipt conversation cap with exact filters and revision fencing", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-history-pages-"));
  const env = { STACK_STATE_DIR: root };
  const file = join(root, "event-subscriptions.sqlite");
  let service = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
  await service.close();
  const states = ["delivered", "pending", "error", "cancelled"] as const;
  const receiptIds = Array.from({ length: 300 }, () => randomUUID());
  const requestIds = Array.from({ length: 300 }, () => randomUUID());
  const db = new DatabaseSync(file);
  try {
    const insert = db.prepare("INSERT INTO completion_receipts (id, bot_id, thread_id, pkg, operation, record_id, state, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    receiptIds.forEach((id, n) => insert.run(id, n % 5 === 0 ? "bot-2" : "bot-1", "main", n % 3 === 0 ? "probe" : "sample", n % 3 === 0 ? "sync" : "send", requestIds[n],
      states[n % 4], n % 4 === 2 ? `CANARY-ERROR-${n}` : null));
  } finally { db.close(); }
  const sortedIds = [...receiptIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  service = new McpEventSubscriptions(env, async () => undefined, async () => undefined, undefined, undefined, root);
  try {
    const parse = completionHistoryListInput.parse;
    const first = service.completionHistory(parse({ limit: 100 }));
    assert.equal(first.total, 300);
    assert.equal(first.completions.length, 100);
    assert.equal(first.truncated, true);
    assert.equal(first.nextOffset, 100);
    const second = service.completionHistory(parse({ limit: 100, offset: 100, revision: first.revision }));
    const third = service.completionHistory(parse({ limit: 100, offset: 200, revision: first.revision }));
    assert.equal(third.completions.length, 100);
    assert.equal(third.nextOffset, null);
    assert.equal(third.truncated, false);
    const ids = [...first.completions, ...second.completions, ...third.completions].map(row => row.id);
    assert.equal(new Set(ids).size, 300, "pages are disjoint");
    assert.deepEqual(ids, sortedIds, "pages order by receipt ID, never by time");
    const deep = service.completionHistoryGet(sortedIds[250]!);
    assert.equal(deep?.id, sortedIds[250], "exact get reads outside paged windows");

    const status = service.status(caller);
    assert.equal(status.completions.length, 128, "the conversation status view stays capped");
    assert.equal(status.completionsTruncated, true);

    assert.equal(service.completionHistory(parse({ state: "error" })).total, 75);
    assert.equal(service.completionHistory(parse({ botId: "bot-2" })).total, 60);
    assert.equal(service.completionHistory(parse({ package: "probe" })).total, 100);
    assert.equal(service.completionHistory(parse({ operation: "send" })).total, 200);
    assert.equal(service.completionHistory(parse({ recordId: requestIds[7] })).total, 1);
    assert.equal(service.completionHistory(parse({ state: "error", package: "probe" })).total, 25);

    const filtered = service.completionHistory(parse({ state: "error" }));
    assert.throws(() => service.completionHistory(parse({ state: "delivered", revision: filtered.revision })), /restart paging/, "a revision binds its filter set");
    assert.throws(() => service.completionHistory(parse({ offset: 50 })), /requires the revision/);

    const writes = new DatabaseSync(file);
    try { writes.prepare("UPDATE completion_receipts SET state = 'delivered' WHERE id = ?").run(receiptIds[1]!); } finally { writes.close(); }
    assert.throws(() => service.completionHistory(parse({ limit: 100, offset: 100, revision: first.revision })), /restart paging/, "a receipt change between pages fences stale paging");

    const fresh = service.completionHistory(parse({}));
    const noise = new DatabaseSync(file);
    try { noise.prepare("UPDATE completion_receipts SET last_error = 'CANARY-ERROR-rewritten' WHERE id = ? AND last_error IS NOT NULL").run(receiptIds[2]!); } finally { noise.close(); }
    assert.equal(service.completionHistory(parse({})).revision, fresh.revision, "projection-irrelevant error text churn must not bump the revision");

    for (const page of [first, second, third]) assert.ok(!JSON.stringify(page).includes("CANARY"));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
