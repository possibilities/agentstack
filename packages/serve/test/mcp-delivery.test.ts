import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { botInstance, operation, pollEvent, serveApi, serveSocket, socketCall, socketPath, type CompletionReceipt, type EventTarget, type InvocationContext, type Occurrence } from "@stack/api";
import { serverCompletionCheck, type ServerContext } from "../api.js";
import { StatusSource } from "../src/status.js";
import { authorizeWorkerRead, createMcpEventSubscriptions, verifiedTarget } from "../src/mcp-delivery.js";
import { serverStateOperations } from "../src/state.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await pause(10);
  assert.ok(check(), "expected Codex turn was not started");
}

test("Worker UI progress and rich reads cannot become originating-Bot wakeups", async () => {
  const subscription = {
    id: "subscription", botId: "bot-1", threadId: "child", instance: "instance", pkg: "worker",
    topic: "worker_changed", scope: "worker", readOperation: "worker_status", readArguments: { id: "worker" },
    state: "active" as const, lastDeliveredAt: null, lastError: null, completion: null,
  };
  // These are rejected before a socket read, even when paired with the sanctioned
  // scope. Progress must not feed back into a new inference turn on every update.
  for (const topic of ["workers_changed", "worker_progress"]) {
    await assert.rejects(authorizeWorkerRead({ ...subscription, topic }, {}), /exact worker_changed scope/);
  }
  await assert.rejects(authorizeWorkerRead({ ...subscription, readOperation: "worker_read" }, {}), /exact worker_changed scope/);
  const requestId = "00000000-0000-4000-8000-000000000001";
  const turn = { ...subscription, topic: "worker_turn_changed", scope: `request:${requestId}`, readOperation: "worker_turn_observation", readArguments: { requestId, botId: "bot-1", threadId: "child" } };
  await authorizeWorkerRead(turn, {});
  for (const invalid of [{ ...turn, scope: "worker" }, { ...turn, readOperation: "worker_detail" }, { ...turn, readArguments: { ...turn.readArguments, threadId: "main" } }])
    await assert.rejects(authorizeWorkerRead(invalid, {}), /exact request-scoped observation/);
});

test("event values are admitted on idle and working sanctioned threads without waiting for completion", { timeout: 30_000 }, async () => {
  const root = await mkdtemp("/tmp/as-turn-events-");
  for (const name of ["sample", "worker", "browse", "notify"]) {
    await mkdir(join(root, "packages", name), { recursive: true });
    await writeFile(join(root, "packages", name, "api.yaml"), `name: ${name}\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: all\n${name === "sample" ? "  workerEvents: [arrived]\n" : ""}`);
  }
  const env = { STACK_STATE_DIR: root };
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const turns: Array<{ threadId: string; input: unknown[]; toolOutput: { namespace: string; name: string; output: string } }> = [];
  let childActivity: "idle" | "active" = "idle";
  let holdEventConnection = false;
  let releaseConnection: (() => void) | undefined;
  let rejectSubmission = false;
  let dropSubmission = false;
  let eventPeer: WebSocket | undefined;
  let holdAuthorization = false, postInit = false;
  let releaseAuthorization: (() => void) | undefined;
  let attempts = 0;
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (frame.method === "initialize" && (frame.params?.clientInfo as { name?: string })?.name === "stack-events") eventPeer = peer;
    if (frame.method === "initialized" && peer === eventPeer) postInit = true;
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
      if (dropSubmission) { peer.close(); return; }
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
      async call() {
        if (holdAuthorization && postInit) await new Promise<void>(resolve => { releaseAuthorization = resolve; });
        return { bots: [{ id: "bot-1", state: "running", url: endpoint, mainThreadId: "main", recoveryIssue: null }] };
      } })],
  });
  let value = 0;
  const occurrences: Occurrence[] = [];
  const poll = pollEvent({ name: "arrived", operation: "read_events", description: "Fixture occurrences.", input: z.strictObject({}), payload: z.strictObject({ value: z.number() }),
    async poll(_ctx, _args, request) { return { events: occurrences.slice(request.cursor === null ? occurrences.length : Number(request.cursor)), cursor: String(occurrences.length), truncated: false, hasMore: false, nextPollMs: 1000 }; } });
  const sample = await serveSocket({
    info: { name: "sample", description: "Sample.", transportDescription: "Socket.", path: socketPath("sample", env) }, context: {},
    operations: [operation({ name: "snapshot", description: "Read state.", input: z.strictObject({}), output: z.object({ value: z.number() }), annotations: { readOnlyHint: true },
      async call() { return { value }; } }), poll], events: { topics: { changed: "Refresh snapshot." } },
  });
  const workerId = "11111111-1111-4111-8111-111111111111";
  let workerServer = "bot-1";
  let workerPhase = "running";
  const workerInstance = "22222222-2222-4222-8222-222222222222";
  const workerInputs: Record<string, unknown>[] = [];
  const workers = await serveSocket({
    info: { name: "worker", description: "Workers.", transportDescription: "Socket.", path: socketPath("worker", env) }, context: {},
    operations: [operation({ name: "worker_status", description: "Read Worker.", input: z.strictObject({ id: z.string() }), output: z.any(), annotations: { readOnlyHint: true },
      async call(_ctx, { id }) { assert.equal(id, workerId); return { worker: { id, accountId: "account", botId: workerServer, threadId: "child", phase: workerPhase, sessionId: "exact-session", runtimeInstance: workerInstance }, turn: { stopReason: workerPhase === "completed" ? "end_turn" : null }, pending: [] }; } }),
      operation({ name: "worker_runtime_list", description: "Fixture runtime.", input: z.strictObject({}), output: z.any(), async call() { return { runtimes: [{ id: "account", instance: workerInstance, state: "running" }] }; } }),
      operation({ name: "worker_event_receive", description: "Fixture private intake.", input: z.record(z.string(), z.unknown()), output: z.any(), async call(_ctx, args, invocation) {
        assert.equal(invocation, undefined); workerInputs.push(args); return { deliveryId: args.deliveryId };
      } })],
    events: { topics: { worker_changed: "Worker changed." }, scope: { description: "Worker ID.", example: workerId, required: false, valid: (_ctx, id) => id === workerId } },
  });
  const subscriptions = createMcpEventSubscriptions(env, root);
  const source = new StatusSource(); source.subscriptions = subscriptions;
  const owner = await serveSocket({ info: { name: "serve", description: "Owner", transportDescription: "Private socket", path: socketPath("serve", env) },
    context: { source, env } as unknown as ServerContext, operations: [serverCompletionCheck, ...serverStateOperations] });
  const notifications = await serveApi({ name: "notify", transport: "socket", env });
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

    // A real Notification answer travels through the same owner and native input path.
    holdEventConnection = false;
    const question = await subscriptions.callAndWatch("notify", "notification_send", { title: "Name?", message: "x".repeat(16_000), reply: "Name" }, invocation);
    const receipt = question.subscription as CompletionReceipt;
    holdEventConnection = true;
    await socketCall(notifications.socketPath!, "tools/call", { name: "notification_dismiss", arguments: { id: question.id, outcome: "replied", response: "Atlas" } });
    await until(() => Boolean(releaseConnection));
    await writeFile(join(root, "packages", "notify", "api.yaml"), "name: notify\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: []\n");
    releaseConnection!(); releaseConnection = undefined;
    await until(() => subscriptions.status(invocation).completions.find(row => row.id === receipt.id)?.state === "error");
    assert.equal(attempts, 5, "completion exposure revocation after connection setup fences native input");
    await writeFile(join(root, "packages", "notify", "api.yaml"), "name: notify\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: all\n");
    holdEventConnection = false;
    await socketCall(notifications.socketPath!, "tools/call", { name: "notification_send", arguments: { title: "Unrelated", message: "Recover read" } });
    await until(() => turns.length === 5 && subscriptions.status(invocation).completions.some(row => row.id === receipt.id && row.state === "delivered"));
    assert.equal(turns[4]!.threadId, "child"); assert.deepEqual(turns[4]!.input, []);
    assert.equal(turns[4]!.toolOutput.name, "subscription_update");
    assert.match(turns[4]!.toolOutput.output, /"outcome":"replied"/); assert.match(turns[4]!.toolOutput.output, /"response":"Atlas"/);
    assert.ok(!subscriptions.status(invocation).subscriptions.some(row => row.id === receipt.id), "native ACK retires the one-shot watch without waiting for turn completion");

    const preDispatch = await subscriptions.callAndWatch("notify", "notification_send", { title: "Reconnect", message: "Choose", actions: ["Yes"] }, invocation);
    const preDispatchId = (preDispatch.subscription as CompletionReceipt).id;
    postInit = false; holdAuthorization = true;
    await socketCall(notifications.socketPath!, "tools/call", { name: "notification_dismiss", arguments: { id: preDispatch.id, outcome: "action", response: "Yes" } });
    await until(() => Boolean(releaseAuthorization));
    const closed = new Promise<void>(resolve => eventPeer!.once("close", resolve));
    eventPeer!.close(); await closed;
    holdAuthorization = false; releaseAuthorization!(); releaseAuthorization = undefined;
    await until(() => subscriptions.status(invocation).completions.some(row => row.id === preDispatchId && (row.state === "error" || row.state === "unknown")));
    assert.equal(subscriptions.status(invocation).completions.find(row => row.id === preDispatchId)?.state, "error", "a socket closed during post-init authorization has not dispatched native input");
    assert.equal(attempts, 6, "the closed event socket received zero turn/start frames");
    await socketCall(notifications.socketPath!, "tools/call", { name: "notification_send", arguments: { title: "Unrelated", message: "Recover pre-dispatch loss" } });
    await until(() => subscriptions.status(invocation).completions.some(row => row.id === preDispatchId && row.state === "delivered"));
    assert.equal(attempts, 7, "a later healthy connection may deliver a proven pre-dispatch failure");
    const uncertain = await subscriptions.callAndWatch("notify", "notification_send", { title: "Unknown", message: "Choose", actions: ["Yes"] }, invocation);
    dropSubmission = true;
    await socketCall(notifications.socketPath!, "tools/call", { name: "notification_dismiss", arguments: { id: uncertain.id, outcome: "action", response: "Yes" } });
    await until(() => subscriptions.status(invocation).completions.some(row => row.id === (uncertain.subscription as CompletionReceipt).id && row.state === "unknown" && row.lastError?.includes("connection closed")));
    const afterUnknown = attempts;
    dropSubmission = false;
    await socketCall(notifications.socketPath!, "tools/call", { name: "notification_send", arguments: { title: "Unrelated", message: "No retry" } });
    await pause(100); assert.equal(attempts, afterUnknown, "a connection lost after turn/start must not replay an unacknowledged answer");
    await assert.rejects(subscriptions.occurrences!.subscribe("sample", { name: "arrived", policy: "interrupt" }, invocation), /Unsupported/);
    await writeFile(join(root, "packages", "sample", "api.yaml"), "name: sample\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: all\n  workerEvents: [arrived]\n");
    await subscriptions.occurrences!.subscribe("sample", { name: "arrived" }, invocation);
    workerPhase = "idle";
    const workerInvocation: InvocationContext = { transport: "mcp", botId: null, threadId: "untrusted-other-session", instance: null, sessionId: "untrusted-other-session", workerId, workerInstance };
    await subscriptions.occurrences!.subscribe("sample", { name: "arrived" }, workerInvocation);
    const beforeOccurrence = turns.length;
    occurrences.push({ name: "arrived", eventId: "source-event", timestamp: new Date().toISOString(), data: { value: 42 } });
    await until(() => turns.length === beforeOccurrence + 1 && workerInputs.length === 1);
    const nativeEvent = turns.at(-1)!;
    assert.equal(nativeEvent.threadId, "child"); assert.deepEqual(nativeEvent.input, []);
    assert.match(nativeEvent.toolOutput.output, /source-event/);
    assert.match(nativeEvent.toolOutput.output, /not a new human instruction/);
    assert.equal(workerInputs[0]!.sessionId, "exact-session", "resolve session from the signed Worker's owner, not caller metadata");
    assert.equal(workerInputs[0]!.instance, workerInstance); assert.equal(workerInputs[0]!.policy, "native");
    const botReceipts = (await subscriptions.occurrences!.status(invocation))[0]!.deliveries;
    const workerReceipts = (await subscriptions.occurrences!.status(workerInvocation))[0]!.deliveries;
    assert.equal(botReceipts[0]!.boundary, "native_admission"); assert.equal(workerReceipts[0]!.boundary, "worker_inbox");
    const operator = (name: string, args: Record<string, unknown>, caller?: InvocationContext) => socketCall(owner.path, "tools/call", { name, arguments: args, ...(caller ? { invocation: caller } : {}) });
    const inventory = await operator("serve_occurrence_list", { workerId }) as { subscriptions: Array<{ id: string; revision: string }> };
    assert.equal(inventory.subscriptions.length, 1);
    assert.equal(Object.hasOwn(inventory.subscriptions[0]!, "deliveries"), false, "inventories omit potentially large receipt bodies");
    assert.equal(Object.hasOwn(inventory.subscriptions[0]!, "arguments"), false);
    const inspected = await operator("serve_occurrence_get", { id: inventory.subscriptions[0]!.id }) as { subscription: { deliveries: Array<{ boundary: string }> } };
    assert.equal(inspected.subscription.deliveries[0]!.boundary, "worker_inbox");
    await assert.rejects(operator("serve_occurrence_list", {}, invocation), /operator/);
    const dependencies = await operator("serve_bot_dependencies", { botId: "bot-1", cwd: root }) as { relationships: Array<{ id: string }> };
    const botOccurrence = (await subscriptions.occurrences!.status(invocation))[0]!;
    assert.ok(dependencies.relationships.some(row => row.id === botOccurrence.id), "Bot maintenance must include occurrence input, not just snapshots");
    await assert.rejects(operator("serve_subscription_remove", { id: inventory.subscriptions[0]!.id, expectedRevision: "stale" }), /revision/);
    assert.deepEqual(await operator("serve_subscription_remove", { id: inventory.subscriptions[0]!.id, expectedRevision: inventory.subscriptions[0]!.revision }), { id: inventory.subscriptions[0]!.id, removed: true });
    assert.deepEqual(await subscriptions.occurrences!.status(workerInvocation), []);
  } finally {
    holdAuthorization = false; releaseAuthorization?.();
    await subscriptions.close();
    await notifications.close(); await owner.close();
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
