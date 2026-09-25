import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { botInstance, operation, serveSocket, socketPath, type EventTarget, type InvocationContext } from "@agentstack/api";
import { createMcpEventSubscriptions, verifiedTarget } from "../src/mcp-delivery.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await pause(10);
  assert.ok(check(), "expected Codex turn was not started");
}

test("event values start a turn only on a loaded descendant of the Bot's sanctioned main thread", { timeout: 15_000 }, async () => {
  const root = await mkdtemp("/tmp/as-turn-events-");
  const env = { AGENTSTACK_STATE_DIR: root };
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const turns: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
  let childActivity: "idle" | "active" = "idle";
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (!frame.id || !frame.method) return;
    let result: unknown = {};
    if (frame.method === "thread/loaded/list") result = { data: ["main", "child", "foreign"] };
    if (frame.method === "thread/read") {
      const id = frame.params?.threadId;
      result = { thread: { id, parentThreadId: id === "child" ? "main" : null, status: { type: id === "child" ? childActivity : "idle" } } };
    }
    if (frame.method === "turn/start") {
      turns.push(frame.params as typeof turns[number]);
      result = { turn: { id: `turn-${turns.length}` } };
    }
    peer.send(JSON.stringify({ id: frame.id, result }));
    if (frame.method === "turn/start") {
      setTimeout(() => peer.send(JSON.stringify({ method: "turn/completed", params: { threadId: frame.params?.threadId, turn: { id: `turn-${turns.length}` } } })), 10);
    }
  }));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const bots = await serveSocket({
    info: { name: "bots", description: "Bots.", transportDescription: "Socket.", path: socketPath("bots", env) }, context: {},
    operations: [operation({ name: "bot_list", description: "List bots.", input: z.strictObject({}), output: z.object({ bots: z.array(z.unknown()) }),
      async call() { return { bots: [{ id: "bot-1", state: "running", url: endpoint, mainThreadId: "main", recoveryIssue: null }] }; } })],
  });
  let value = 0;
  const sample = await serveSocket({
    info: { name: "sample", description: "Sample.", transportDescription: "Socket.", path: socketPath("sample", env) }, context: {},
    operations: [operation({ name: "snapshot", description: "Read state.", input: z.strictObject({}), output: z.object({ value: z.number() }), annotations: { readOnlyHint: true },
      async call() { return { value }; } })], events: { topics: { changed: "Refresh snapshot." } },
  });
  const workerId = "11111111-1111-4111-8111-111111111111";
  let workerOwner = "bot-1";
  let workerPhase = "running";
  const workers = await serveSocket({
    info: { name: "workers", description: "Workers.", transportDescription: "Socket.", path: socketPath("workers", env) }, context: {},
    operations: [operation({ name: "worker_status", description: "Read Worker.", input: z.strictObject({ id: z.string() }), output: z.any(), annotations: { readOnlyHint: true },
      async call(_ctx, { id }) { assert.equal(id, workerId); return { worker: { id, botId: workerOwner, threadId: "child", phase: workerPhase }, turn: { stopReason: workerPhase === "completed" ? "end_turn" : null }, pending: [] }; } })],
    events: { topics: { worker_changed: "Worker changed." }, scope: { description: "Worker ID.", example: workerId, required: false, valid: (_ctx, id) => id === workerId } },
  });
  const subscriptions = createMcpEventSubscriptions(env);
  const target: EventTarget = { botId: "bot-1", instance: botInstance(endpoint), threadId: "child" };
  const invocation: InvocationContext = { transport: "mcp", ...target, sessionId: "session-1" };
  try {
    await verifiedTarget(target, env);
    await assert.rejects(verifiedTarget({ ...target, threadId: "foreign" }, env), /not loaded in the Bot's sanctioned/);
    await assert.rejects(verifiedTarget({ botId: "bot-1", instance: "0".repeat(32), threadId: "child" }, env), /not verified/);
    const initial = await subscriptions.subscribe("sample", { topic: "changed", readOperation: "snapshot" }, invocation);
    assert.deepEqual(initial.value, { value: 0 });
    childActivity = "active";
    value = 1;
    sample.publish?.("changed");
    await pause(100);
    assert.equal(turns.length, 0, "busy thread must not receive another turn");
    childActivity = "idle";
    await until(() => turns.length === 1);
    assert.equal(turns[0]?.threadId, "child");
    assert.match(turns[0]?.input[0]?.text ?? "", /Current value: \{"value":1\}/);
    assert.match(turns[0]?.input[0]?.text ?? "", /Topic: changed/);
    await until(() => typeof subscriptions.status(invocation).subscriptions[0]?.lastDeliveredAt === "number");
    const choice = { topic: "worker_changed", scope: workerId, readOperation: "worker_status", readArguments: { id: workerId } };
    await assert.rejects(subscriptions.subscribe("workers", { ...choice, readArguments: { id: "other" } }, invocation), /exact worker_changed scope/);
    await assert.rejects(subscriptions.subscribe("workers", choice, { ...invocation, threadId: "main" }), /not owned by this Bot thread/);
    const workerSub = await subscriptions.subscribe("workers", choice, invocation);
    assert.equal((workerSub.value as { worker: { phase: string } }).worker.phase, "running");
    workerPhase = "completed";
    workers.publish?.("worker_changed", workerId);
    await until(() => turns.length === 2);
    assert.equal(turns[1]?.threadId, "child");
    assert.match(turns[1]?.input[0]?.text ?? "", /Topic: worker_changed · Scope:/);
    assert.match(turns[1]?.input[0]?.text ?? "", /"stopReason":"end_turn"/);
    workerOwner = "bot-2";
    workerPhase = "idle";
    workers.publish?.("worker_changed", workerId);
    for (let i = 0; i < 100 && subscriptions.status(invocation).subscriptions.find((item) => item.id === workerSub.subscription.id)?.state !== "error"; i++) await pause(10);
    assert.equal(subscriptions.status(invocation).subscriptions.find((item) => item.id === workerSub.subscription.id)?.state, "error");
    assert.equal(turns.length, 2, "a Worker ownership change must not wake the previous Bot thread");
  } finally {
    await subscriptions.close();
    await workers.close();
    await sample.close();
    await bots.close();
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
