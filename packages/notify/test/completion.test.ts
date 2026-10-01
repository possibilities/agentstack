import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { botInstance, botMcpUrl, invocationContext, McpDeliveryRejected, McpEventSubscriptions, operation, operatorHeaders, serveApi, serveMcp,
  serveSocket, socketCall, socketPath, type CompletionReceipt, type EventValue, type InvocationContext } from "@stack/api";
import type { Notification } from "../src/schema.js";
import { api } from "../api.js";

type Send = Notification & { subscription: CompletionReceipt | null };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let n = 0; n < 300 && !check(); n++) await pause(10);
  assert.ok(check(), "expected completion activity did not arrive");
}

function capabilitySocket(env: NodeJS.ProcessEnv, owner: () => McpEventSubscriptions, available: () => boolean = () => true) {
  return serveSocket({ info: { name: "serve", description: "Fixture", transportDescription: "Fixture", path: socketPath("serve", env) }, context: {}, operations: [
    operation({ name: "serve_completion_check", description: "Reserved capability", input: z.strictObject({ id: z.uuid(), package: z.string(), operation: z.string(), recordId: z.uuid(), caller: invocationContext }), output: z.any(),
      async call(_ctx, input) { if (!available()) throw new Error("owner coordination unavailable"); await owner().verifyCompletion(input.id, input.package, input.operation, input.recordId, input.caller); return { verified: true }; } }),
  ] });
}

// The real Notification owner and HTTP gateway protect defaults, mutation ordering,
// durable response reads and receipts. Serve's Codex test owns native turn admission.
test("send-and-watch defaults, terminal-only answers and durable one-shot receipts cross the real Notification boundary", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-notify-completion-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const dir = join(root, "packages", "notify"); await mkdir(dir, { recursive: true });
  const manifest = (operations = "all", events = "all") => writeFile(join(dir, "api.yaml"),
    `name: notify\ndescription: Notifications.\nmcp:\n  description: Notifications.\n  operations: ${operations}\n  events: ${events}\n`);
  await manifest();
  const endpoint = "unix:///fixture/notification-bot.sock";
  const caller: InvocationContext = { transport: "mcp", botId: "bot-1", instance: botInstance(endpoint), threadId: "child", sessionId: null };
  const notifications = await serveApi({ name: "notify", transport: "socket", env });
  const call = <T>(name: string, args: Record<string, unknown> = {}) => socketCall(notifications.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  const bots = await serveSocket({ info: { name: "bots", description: "Fixture", transportDescription: "Fixture", path: socketPath("bots", env) }, context: {}, operations: [
    operation({ name: "bot_list", description: "Live launch", input: z.strictObject({}), output: z.any(), async call() {
      return { bots: [{ id: "bot-1", state: "running", url: endpoint, recoveryIssue: null }] };
    } }),
  ] });
  const deliveries: EventValue[] = [];
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const createOwner = () => new McpEventSubscriptions(env, async target => {
    if (target.threadId !== "child" || target.botId !== "bot-1" || target.instance !== caller.instance) throw new Error("not the sanctioned Chat");
  }, async (event, signal, authorize, submitting) => {
    await authorize(); submitting?.(); deliveries.push(event);
    if (held) await held;
    signal.throwIfAborted();
  }, undefined, undefined, root);
  let owner = createOwner();
  const server = await capabilitySocket(env, () => owner);
  let mcp = await serveMcp({ root, env, port: 0, subscriptions: owner });
  const tool = async (name: string, args: Record<string, unknown>, threadId: string | null = "child") => {
    const url = threadId ? botMcpUrl(mcp.urls.notify!, "bot-1", endpoint, env) : mcp.urls.notify!;
    const response = await fetch(url, { method: "POST", headers: { ...(threadId ? {} : operatorHeaders(env)), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) } }) });
    assert.equal(response.status, 200);
    const frame = await response.json() as { result: { isError?: boolean; structuredContent?: unknown; content: Array<{ text: string }> } };
    return frame.result;
  };
  const send = async (args: Record<string, unknown>) => {
    const result = await tool("notification_send", args); assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent as Send;
  };
  const restart = async () => { await mcp.close(); await owner.close(); owner = createOwner(); owner.resume(); mcp = await serveMcp({ root, env, port: 0, subscriptions: owner }); };
  try {
    const cases: Array<{ extra: Record<string, unknown>; watches: boolean }> = [
      { extra: { actions: ["Yes"] }, watches: true }, { extra: { reply: "Answer" }, watches: true },
      { extra: { actions: [], reply: null }, watches: false }, { extra: { subscribe: true }, watches: true },
      { extra: { actions: ["Yes"], reply: "Answer", subscribe: false }, watches: false }, { extra: {}, watches: false },
    ];
    const records: Send[] = [];
    for (const { extra, watches } of cases) {
      const record = await send({ title: "Question", message: "Choose", ...extra }); records.push(record);
      assert.equal(record.subscription?.state ?? null, watches ? "pending" : null);
    }
    assert.equal(owner.status(caller).subscriptions.length, 3);
    await pause(50); assert.equal(deliveries.length, 0, "open records and other sends never wake the Chat");
    const count = (await call<{ total: number }>("notification_counts")).total;
    for (const thread of [null, "foreign-root"])
      assert.equal((await tool("notification_send", { title: "Denied", message: "No effect", subscribe: true }, thread)).isError, true);
    const operator = await tool("notification_send", { title: "Operator", message: "Prompt", actions: ["Yes"] }, null);
    assert.equal((operator.structuredContent as Send).subscription, null);
    await assert.rejects(socketCall(notifications.socketPath!, "tools/call", { name: "notification_send", arguments: { id: randomUUID(), title: "Forged", message: "No", subscribe: true },
      invocation: { ...caller, completionWatchId: randomUUID() } }), /capability is invalid/);
    assert.equal((await call<{ total: number }>("notification_counts")).total, count + 1, "unsupported or forged subscriptions fail before mutation");
    for (const [operations, events] of [["all", "[]"], ["[notification_send]", "all"], ["[notification_get]", "all"]]) {
      await manifest(operations, events);
      assert.equal((await tool("notification_send", { title: "Fenced", message: "No", subscribe: true })).isError, true);
    }
    await manifest();
    assert.equal((await call<{ total: number }>("notification_counts")).total, count + 1);

    held = new Promise(resolve => { release = resolve; });
    await call("notification_dismiss", { id: records[0]!.id, outcome: "action", response: "Yes" });
    await until(() => deliveries.length === 1);
    assert.equal(owner.status(caller).subscriptions.length, 3, "the one-shot watch remains until native admission ACK");
    assert.deepEqual([(deliveries[0]!.value as Notification).outcome, (deliveries[0]!.value as Notification).response], ["action", "Yes"]);
    release!(); held = undefined;
    await until(() => owner.status(caller).completions.some(receipt => receipt.id === records[0]!.subscription!.id && receipt.state === "delivered"));
    await call("notification_dismiss", { id: records[1]!.id, outcome: "replied", response: "Atlas" });
    await call("notification_dismiss", { id: records[3]!.id, outcome: "opened" });
    await until(() => deliveries.length === 3 && owner.status(caller).subscriptions.length === 0);
    const terminalById = new Map(deliveries.map(event => { const record = event.value as Notification; return [record.id, [record.outcome, record.response]]; }));
    assert.deepEqual([records[0]!, records[1]!, records[3]!].map(record => terminalById.get(record.id)), [["action", "Yes"], ["replied", "Atlas"], ["opened", null]]);
    const retried = await send({ id: records[0]!.id, title: "Question", message: "Choose", actions: ["Yes"] });
    assert.equal(retried.subscription!.id, records[0]!.subscription!.id); assert.equal(retried.subscription!.state, "delivered");
    assert.equal((await tool("notification_send", { id: records[0]!.id, title: "Different", message: "Choose", actions: ["Yes"] })).isError, true);

    const existing = await call<Send>("notification_send", { title: "Already done", message: "Inspect", subscribe: false });
    await call("notification_dismiss", { id: existing.id });
    const observed = await send({ id: existing.id, title: "Already done", message: "Inspect", subscribe: true });
    assert.equal(observed.outcome, "closed"); assert.equal(observed.subscription!.state, "observed");
    assert.equal(deliveries.length, 3, "an already-completed initial record is returned, not delivered twice");
    const pending = await send({ title: "Across restart", message: "Reply", reply: "Answer" });
    await mcp.close(); await owner.close();
    await call("notification_dismiss", { id: pending.id, outcome: "replied", response: "Recovered" });
    owner = createOwner(); owner.resume(); mcp = await serveMcp({ root, env, port: 0, subscriptions: owner });
    await until(() => deliveries.length === 4 && owner.status(caller).subscriptions.length === 0);
    assert.equal((deliveries[3]!.value as Notification).response, "Recovered");
    await restart();
    assert.equal((await send({ id: observed.id, title: "Already done", message: "Inspect", subscribe: true })).subscription!.state, "observed");
    assert.equal((await send({ id: pending.id, title: "Across restart", message: "Reply", reply: "Answer" })).subscription!.state, "delivered");
    const replaced = await send({ title: "Progress", message: "Waiting", group: "task:replacement", subscribe: true });
    await call("notification_send", { title: "Progress", message: "New", group: "task:replacement" });
    await until(() => deliveries.length === 5 && owner.status(caller).subscriptions.length === 0);
    assert.equal((deliveries[4]!.value as Notification).id, replaced.id); assert.equal((deliveries[4]!.value as Notification).outcome, "replaced");
    const concurrentlyRetried = { id: randomUUID(), title: "Concurrent", message: "Choose", actions: ["Yes"] };
    const beforeConcurrent = (await call<{ total: number }>("notification_counts")).total;
    const [a, b] = await Promise.all([send(concurrentlyRetried), send(concurrentlyRetried)]);
    assert.equal(a.subscription!.id, b.subscription!.id); assert.equal(owner.status(caller).subscriptions.length, 1);
    assert.equal((await call<{ total: number }>("notification_counts")).total, beforeConcurrent + 1);
    await call("notification_dismiss", { id: a.id, outcome: "action", response: "Yes" });
    await until(() => deliveries.length === 6 && owner.status(caller).subscriptions.length === 0);
    const exact = await tool("events_status", { completionId: a.subscription!.id });
    assert.deepEqual((exact.structuredContent as { completions: Array<{ id: string; state: string }> }).completions.map(row => [row.id, row.state]), [[a.subscription!.id, "delivered"]]);
  } finally {
    release?.(); await mcp.close(); await owner.close(); await Promise.all([server.close(), bots.close(), notifications.close()]); await rm(root, { recursive: true, force: true });
  }
});

test("fast completion, lost send ACKs and failed reads retain durable intent; ambiguous native admission never replays", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-notify-failures-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const dir = join(root, "packages", "notify"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: notify\ndescription: Notifications.\nmcp:\n  description: Notifications.\n  operations: all\n  events: all\n");
  const caller: InvocationContext = { transport: "mcp", botId: "bot-1", instance: "launch-1", threadId: "child", sessionId: null };
  const context = await api.createContext(env);
  let sendMode: "normal" | "fast" | "lost" = "normal", readFails = false, available = true, valid = true;
  // Faults occur after the actual record owner executes, not in a mock store or receipt producer.
  const notifications = await serveSocket({ info: { name: "notify", description: "Notifications", transportDescription: "Socket", path: socketPath("notify", env) }, context,
    events: { topics: api.events!.topics }, operations: api.operations.map(op => ({ ...op, async call(ctx: typeof context, input: any, invocation?: InvocationContext) {
      if (op.name === "notification_get" && readFails) throw new Error("read temporarily unavailable");
      const result = await op.call(ctx, input, invocation);
      if (op.name === "notification_send" && sendMode === "fast") { ctx.store.dismiss(result.id, { outcome: "replied", response: "Immediate" }); ctx.changed?.(); }
      if (op.name === "notification_send" && sendMode === "lost") throw new Error("send response lost after persistence");
      return result;
    } })) });
  const stopEvents = await api.events!.start(context, topic => notifications.publish!(topic));
  const deliveries: EventValue[] = [];
  let deliveryMode: "normal" | "refused" | "unknown" = "normal";
  const createOwner = () => new McpEventSubscriptions(env, async target => {
    if (!valid || target.threadId !== "child" || target.instance !== caller.instance) throw new Error("Chat identity fenced");
  }, async (event, _signal, authorize, submitting) => {
    await authorize(); submitting?.();
    if (deliveryMode === "refused") throw new McpDeliveryRejected("native refusal before admission");
    deliveries.push(event);
    if (deliveryMode === "unknown") throw new Error("native ACK lost; admission unknown");
  }, undefined, undefined, root);
  let owner = createOwner();
  const server = await capabilitySocket(env, () => owner, () => available);
  const send = (input: Record<string, unknown>) => owner.callAndWatch("notify", "notification_send", { title: "Prompt", message: "Answer", reply: "Reply", ...input }, caller) as Promise<Send>;
  const dismiss = (id: string, response = "Later") => { context.store.dismiss(id, { outcome: "replied", response }); context.changed?.(); };
  const restart = async () => { await owner.close(); owner = createOwner(); owner.resume(); };
  try {
    sendMode = "fast";
    const fast = await send({});
    assert.equal(fast.response, "Immediate"); assert.equal(fast.subscription!.state, "observed");
    await restart(); await pause(50); assert.equal(deliveries.length, 0, "fast initial completion is never a second wakeup after restart");

    sendMode = "lost";
    const lostId = randomUUID();
    await assert.rejects(send({ id: lostId }), error => String(error).includes(lostId) && /outcome unknown/.test(String(error)));
    assert.equal(context.store.get(lostId).dismissedAt, null);
    sendMode = "normal";
    await restart(); dismiss(lostId, "Recovered after lost send");
    await until(() => deliveries.length === 1 && owner.status(caller).completions.some(receipt => receipt.recordId === lostId && receipt.state === "delivered"));
    assert.equal((deliveries[0]!.value as Notification).response, "Recovered after lost send");
    assert.equal((await send({ id: lostId })).subscription!.state, "delivered");

    readFails = true;
    const failedRead = await send({});
    assert.equal(failedRead.subscription!.state, "error"); assert.equal(context.store.get(failedRead.id).dismissedAt, null);
    readFails = false; await restart(); dismiss(failedRead.id);
    await until(() => deliveries.length === 2 && owner.status(caller).subscriptions.length === 0);

    const initiallyCompletedRetry = await send({}); valid = false; dismiss(initiallyCompletedRetry.id, "Inspect on retry");
    await until(() => owner.status(caller).subscriptions[0]?.state === "error");
    valid = true;
    const inspected = await send({ id: initiallyCompletedRetry.id });
    assert.equal(inspected.response, "Inspect on retry"); assert.equal(inspected.subscription!.state, "observed");
    await restart(); context.changed?.(); await pause(40);
    assert.equal(deliveries.length, 2, "a terminal initial ID retry retires unsubmitted intent without a duplicate wakeup");

    available = false;
    const refusedSend = randomUUID();
    await assert.rejects(send({ id: refusedSend }), /coordination unavailable/);
    assert.throws(() => context.store.get(refusedSend), /not_found/, "failed coordination does not create a Notification");
    available = true;
    const retriedSend = await send({ id: refusedSend });
    assert.equal(retriedSend.subscription!.id, owner.status(caller).completions.find(receipt => receipt.recordId === refusedSend)!.id);
    dismiss(refusedSend); await until(() => deliveries.length === 3 && owner.status(caller).subscriptions.length === 0);

    const fenced = await send({}); valid = false; dismiss(fenced.id);
    await until(() => owner.status(caller).subscriptions[0]?.state === "error");
    assert.equal(deliveries.length, 3, "revoked Chat identity fences fresh reads and delivery");
    valid = true; context.changed?.(); await until(() => deliveries.length === 4 && owner.status(caller).subscriptions.length === 0);

    const refused = await send({}); deliveryMode = "refused"; dismiss(refused.id);
    await until(() => owner.status(caller).completions.find(receipt => receipt.id === refused.subscription!.id)?.state === "error");
    deliveryMode = "normal"; context.changed?.(); await until(() => deliveries.length === 5 && owner.status(caller).subscriptions.length === 0);

    const unknown = await send({}); deliveryMode = "unknown"; dismiss(unknown.id);
    await until(() => owner.status(caller).completions.find(receipt => receipt.id === unknown.subscription!.id)?.state === "unknown");
    assert.equal(deliveries.length, 6);
    deliveryMode = "normal"; context.changed?.(); await restart(); context.changed?.();
    assert.equal((await send({ id: unknown.id })).subscription!.state, "unknown");
    await pause(100); assert.equal(deliveries.length, 6, "unknown native admission is not safe to replay after notices, restart or ID retry");
    assert.equal(owner.status(caller).subscriptions.length, 1, "an unknown delivery stays inspectable rather than falsely retiring as delivered");
  } finally {
    await owner.close(); await server.close(); stopEvents?.(); await notifications.close(); await api.closeContext(context); await rm(root, { recursive: true, force: true });
  }
});
