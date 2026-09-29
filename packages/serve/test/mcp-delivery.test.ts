import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { botInstance, operation, serveSocket, socketPath, type EventTarget, type InvocationContext } from "@stack/api";
import { authorizeWorkerRead, createMcpEventSubscriptions, verifiedTarget } from "../src/mcp-delivery.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await pause(10);
  assert.ok(check(), "expected Codex turn was not started");
}

test("Worker UI progress and rich reads cannot become originating-Bot wakeups", async () => {
  const subscription = {
    id: "subscription", botId: "bot-1", threadId: "child", instance: "instance", pkg: "worker",
    topic: "worker_changed", scope: "worker", readOperation: "worker_status", readArguments: { id: "worker" },
    state: "active" as const, lastDeliveredAt: null, lastError: null,
  };
  // These are rejected before a socket read, even when paired with the sanctioned
  // scope. Progress must not feed back into a new inference turn on every update.
  for (const topic of ["workers_changed", "worker_progress"]) {
    await assert.rejects(authorizeWorkerRead({ ...subscription, topic }, {}), /exact worker_changed scope/);
  }
  await assert.rejects(authorizeWorkerRead({ ...subscription, readOperation: "worker_read" }, {}), /exact worker_changed scope/);
});

test("event values are admitted on idle and working sanctioned threads without waiting for completion", { timeout: 15_000 }, async () => {
  const root = await mkdtemp("/tmp/as-turn-events-");
  for (const name of ["sample", "worker", "browse"]) {
    await mkdir(join(root, "packages", name), { recursive: true });
    await writeFile(join(root, "packages", name, "api.yaml"), `name: ${name}\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: all\n`);
  }
  const env = { STACK_STATE_DIR: root };
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const turns: Array<{ threadId: string; input: unknown[]; toolOutput: { namespace: string; name: string; output: string } }> = [];
  let childActivity: "idle" | "active" = "idle";
  let holdEventConnection = false;
  let releaseConnection: (() => void) | undefined;
  let rejectSubmission = false;
  let attempts = 0;
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (!frame.id || !frame.method) return;
    if (frame.method === "initialize" && (frame.params?.clientInfo as { name?: string })?.name === "stack-events" && holdEventConnection) {
      releaseConnection = () => peer.send(JSON.stringify({ id: frame.id, result: {} }));
      return;
    }
    let result: unknown = {};
    if (frame.method === "thread/loaded/list") result = { data: ["main", "child", "foreign"] };
    if (frame.method === "thread/read") {
      const id = frame.params?.threadId;
      result = { thread: { id, parentThreadId: id === "child" ? "main" : null, status: { type: id === "child" ? childActivity : "idle" } } };
    }
    if (frame.method === "turn/start") {
      attempts++;
      if (rejectSubmission) { peer.send(JSON.stringify({ id: frame.id, error: { message: "cannot steer a compact turn" } })); return; }
      turns.push(frame.params as typeof turns[number]);
      result = { turn: { id: "same-active-turn" } };
    }
    peer.send(JSON.stringify({ id: frame.id, result }));
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
  let workerServer = "bot-1";
  let workerPhase = "running";
  const workers = await serveSocket({
    info: { name: "worker", description: "Workers.", transportDescription: "Socket.", path: socketPath("worker", env) }, context: {},
    operations: [operation({ name: "worker_status", description: "Read Worker.", input: z.strictObject({ id: z.string() }), output: z.any(), annotations: { readOnlyHint: true },
      async call(_ctx, { id }) { assert.equal(id, workerId); return { worker: { id, botId: workerServer, threadId: "child", phase: workerPhase }, turn: { stopReason: workerPhase === "completed" ? "end_turn" : null }, pending: [] }; } })],
    events: { topics: { worker_changed: "Worker changed." }, scope: { description: "Worker ID.", example: workerId, required: false, valid: (_ctx, id) => id === workerId } },
  });
  const subscriptions = createMcpEventSubscriptions(env, root);
  let handback: unknown = null;
  const browser = await serveSocket({
    info: { name: "browse", description: "Browser.", transportDescription: "Socket.", path: socketPath("browse", env) }, context: {},
    operations: [operation({ name: "browser_handoff_completion", description: "Completion only.", input: z.object({ botId: z.string(), threadId: z.string(), requestId: z.string() }), output: z.any(), annotations: { readOnlyHint: true },
      async call(_ctx, input, caller) { assert.equal(caller?.botId, input.botId); assert.equal(caller?.threadId, input.threadId); assert.equal(caller?.instance, botInstance(endpoint)); return { result: handback }; } })],
    events: { topics: { browser_handoffs_changed: "Handoff invalidation." } },
  });
  const target: EventTarget = { botId: "bot-1", instance: botInstance(endpoint), threadId: "child" };
  const invocation: InvocationContext = { transport: "mcp", ...target, sessionId: "session-1" };
  try {
    await verifiedTarget(target, env);
    await assert.rejects(verifiedTarget({ ...target, threadId: "foreign" }, env), /not loaded in the Bot's sanctioned/);
    await assert.rejects(verifiedTarget({ botId: "bot-1", instance: "0".repeat(32), threadId: "child" }, env), /not verified/);
    const initial = await subscriptions.subscribe("sample", { topic: "changed", readOperation: "snapshot" }, invocation);
    assert.deepEqual(initial.value, { value: 0 });
    value = 1;
    sample.publish?.("changed");
    await until(() => turns.length === 1);
    assert.equal(turns[0]?.threadId, "child");
    assert.deepEqual(turns[0]?.input, []);
    assert.equal(turns[0]?.toolOutput.namespace, "stack");
    assert.equal(turns[0]?.toolOutput.name, "subscription_update");
    assert.match(turns[0]?.toolOutput.output ?? "", /Current value: \{"value":1\}/);
    assert.match(turns[0]?.toolOutput.output ?? "", /Topic: changed/);
    await until(() => typeof subscriptions.status(invocation).subscriptions[0]?.lastDeliveredAt === "number");
    childActivity = "active";
    const choice = { topic: "worker_changed", scope: workerId, readOperation: "worker_status", readArguments: { id: workerId } };
    await assert.rejects(subscriptions.subscribe("worker", { ...choice, readArguments: { id: "other" } }, invocation), /exact worker_changed scope/);
    await assert.rejects(subscriptions.subscribe("worker", choice, { ...invocation, threadId: "main" }), /not owned by this Bot thread/);
    const workerSub = await subscriptions.subscribe("worker", choice, invocation);
    assert.equal((workerSub.value as { worker: { phase: string } }).worker.phase, "running");
    workerPhase = "completed";
    workers.publish?.("worker_changed", workerId);
    await until(() => turns.length === 2);
    assert.equal(turns[1]?.threadId, "child");
    assert.match(turns[1]?.toolOutput.output ?? "", /Topic: worker_changed · Scope:/);
    assert.match(turns[1]?.toolOutput.output ?? "", /"stopReason":"end_turn"/);
    workerServer = "bot-2";
    workerPhase = "idle";
    workers.publish?.("worker_changed", workerId);
    for (let i = 0; i < 100 && subscriptions.status(invocation).subscriptions.find((item) => item.id === workerSub.subscription.id)?.state !== "error"; i++) await pause(10);
    assert.equal(subscriptions.status(invocation).subscriptions.find((item) => item.id === workerSub.subscription.id)?.state, "error");
    assert.equal(turns.length, 2, "a Worker ownership change must not wake the previous Bot thread");
    const handoffChoice = { topic: "browser_handoffs_changed", readOperation: "browser_handoff_completion", readArguments: { botId: "bot-1", threadId: "child", requestId: workerId } };
    await assert.rejects(subscriptions.subscribe("browse", { ...handoffChoice, readArguments: { ...handoffChoice.readArguments, threadId: "main" } }, invocation), /originating Chat/);
    const subscribed = await subscriptions.subscribe("browse", handoffChoice, invocation);
    assert.deepEqual(subscribed.value, { result: null }, "subscribe before handoff admission has a stable empty initial value");
    for (const _phase of ["preparing", "awaiting_human", "human_controlling", "returning"]) { browser.publish?.("browser_handoffs_changed"); await pause(20); }
    assert.equal(turns.length, 2, "intermediate handoff states do not wake the Chat");
    handback = { state: "resolved", outcome: "completed", note: "Signed in" }; browser.publish?.("browser_handoffs_changed");
    await until(() => turns.length === 3);
    assert.equal(turns[2]?.threadId, "child"); assert.match(turns[2]?.toolOutput.output ?? "", /"outcome":"completed"/);
    await until(() => typeof subscriptions.status(invocation).subscriptions.find((s) => s.id === subscribed.subscription.id)?.lastDeliveredAt === "number");
    const completedBeforeSubscribe = await subscriptions.subscribe("browse", { ...handoffChoice, readArguments: { ...handoffChoice.readArguments, requestId: "22222222-2222-4222-8222-222222222222" } }, invocation);
    assert.deepEqual(completedBeforeSubscribe.value, { result: handback }, "a completion before subscribe is returned initially, never lost awaiting a future notice");
    assert.equal(turns.length, 3);
    value = 2;
    sample.publish?.("changed");
    await until(() => turns.length === 4);
    await until(() => subscriptions.status(invocation).subscriptions.find((s) => s.id === initial.subscription.id)?.state === "active");
    assert.match(turns[3]?.toolOutput.output ?? "", /Current value: \{"value":2\}/);

    holdEventConnection = true;
    value = 3;
    sample.publish?.("changed");
    await until(() => Boolean(releaseConnection));
    await writeFile(join(root, "packages", "sample", "api.yaml"), "name: sample\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: []\n");
    releaseConnection!(); releaseConnection = undefined;
    await until(() => subscriptions.status(invocation).subscriptions.find((s) => s.id === initial.subscription.id)?.state === "error");
    assert.equal(turns.length, 4, "revocation during connection setup must fence submission");

    await writeFile(join(root, "packages", "sample", "api.yaml"), "name: sample\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: all\n");
    holdEventConnection = false;
    rejectSubmission = true;
    sample.publish?.("changed");
    await until(() => attempts === 5);
    await until(() => subscriptions.status(invocation).subscriptions.find((s) => s.id === initial.subscription.id)?.lastError?.includes("compact") === true);
    await pause(100);
    assert.equal(attempts, 5, "a refusal is recorded without blind retry");

    rejectSubmission = false;
    holdEventConnection = true;
    sample.publish?.("changed");
    await until(() => Boolean(releaseConnection));
    await subscriptions.unsubscribe(initial.subscription.id, invocation);
    releaseConnection!(); releaseConnection = undefined;
    await pause(100);
    assert.equal(attempts, 5, "unsubscribe during connection setup fences submission");
  } finally {
    await subscriptions.close();
    await browser.close();
    await workers.close();
    await sample.close();
    await bots.close();
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
