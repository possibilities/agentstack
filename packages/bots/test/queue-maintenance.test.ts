import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operation, serveSocket, socketPath, stateDependencies, stateDependencyInput, type StatePlan, type StateReceipt } from "@stack/api";
import { api } from "../api.js";
import { ChatIndex, ChatQueue, type QueuedChat } from "../src/chats.js";
import type { StoredServer } from "../src/store.js";

test("Bot terminal queue-body cleanup is atomic, incarnation/generation fenced and cannot resend unknown deliveries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-queue-maintenance-")), env = { ...process.env, STACK_STATE_DIR: root };
  const ctx = await api.createContext!(env);
  const owners = await Promise.all(["worker", "browse", "proc", "serve"].map(name => serveSocket({
    info: { name, description: "Dependency fixture", transportDescription: "Socket", path: socketPath(name, env) }, context: {},
    operations: [operation({ name: `${name}_bot_dependencies`, description: "Observed no dependent resources", input: stateDependencyInput, output: stateDependencies,
      async call() { return { revision: "none", blockedBy: [], retained: [], relationships: [] }; } })],
  })));
  const call = async <T>(name: string, input: object): Promise<T> => {
    const op = api.operations.find(op => op.name === name)!;
    return op.output.parse(await op.call(ctx, op.input.parse(input))) as T;
  };
  const plan = (selection: object) => call<StatePlan>("bot_state_plan", { botId: "bot-1", action: { kind: "queue_bodies_clear", selection } });
  const apply = (plan: StatePlan) => ({ botId: "bot-1", planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
  try {
    const threadId = randomUUID(), history = join(root, "history", "bot-1");
    await mkdir(history, { recursive: true });
    await writeFile(join(history, `rollout-test-${threadId}.jsonl`), JSON.stringify({ type: "session_meta", timestamp: new Date().toISOString(), payload: { id: threadId, cwd: root } }) + "\n");
    const record: StoredServer = { id: "bot-1", pid: null, cwd: join(root, "bots", "bot-1"), url: null, state: "stopped", codexBin: "not-launched",
      account: null, launchedAccount: null, authVersion: null, runtimeRoot: null, mainThreadId: threadId, threadStarting: false, args: [] };
    ctx.store.saveServer(record); await ctx.supervisor.load();
    const generation = ctx.store.stateIdentity(record.id).generation;
    const id = randomUUID(), sent = randomUUID(), pending = randomUUID(), sibling = randomUUID(), legacy = randomUUID();
    const body = [{ type: "text", text: "Unknown queued secret" }];
    const admission = ctx.chats.enqueue("bot-1", threadId, id, body, generation); ctx.chats.setQueued(id, "unknown");
    ctx.chats.enqueue("bot-1", threadId, sent, [{ text: "Sent secret" }], generation); ctx.chats.setQueued(sent, "sent", "native-turn");
    ctx.chats.enqueue("bot-1", threadId, pending, [{ text: "Pending secret" }], generation);
    ctx.chats.enqueue("bot-2", threadId, sibling, [{ text: "Sibling secret" }]); ctx.chats.setQueued(sibling, "cancelled");
    ctx.chats.enqueue("bot-1", threadId, legacy, [{ text: "Unattributed legacy" }]); ctx.chats.setQueued(legacy, "cancelled");
    const blocked = await plan({ ids: [pending] }); assert.ok(blocked.blockedBy.some(reason => reason.includes(pending)));
    await assert.rejects(call("bot_queue_bodies_clear", apply(blocked)), /pending/);
    await assert.rejects(plan({ ids: [sibling] }), /unknown queue entry/);
    await assert.rejects(plan({ generation }), /retired generation/);
    const stale = await plan({ ids: [id] }); ctx.chats.setQueued(id, "sent", "observed-turn");
    await assert.rejects(call("bot_queue_bodies_clear", apply(stale)), /changed/); ctx.chats.setQueued(id, "unknown");
    const selected = await plan({ ids: [id, sent] });
    ctx.store.saveServer({ ...record, state: "running" }); await ctx.supervisor.load();
    await assert.rejects(call("bot_queue_bodies_clear", apply(selected)), /Stop and verify/);
    ctx.store.saveServer(record); await ctx.supervisor.load();
    const exact = await plan({ ids: [id, sent] }), input = apply(exact);
    const receipt = await call<StateReceipt>("bot_queue_bodies_clear", input);
    assert.equal(receipt.status, "completed"); assert.deepEqual(await call("bot_queue_bodies_clear", input), receipt);
    const read = await call<{ entries: QueuedChat[] }>("chat_queue_list", { botId: "bot-1", threadId });
    const cleared = read.entries.find(row => row.id === id)!;
    assert.ok(cleared.contentClearedAt); assert.deepEqual(cleared.input, []); assert.equal(cleared.state, "unknown");
    assert.equal(cleared.bytes, admission.bytes); assert.equal(cleared.admissionDigest, admission.admissionDigest);
    assert.equal(ctx.chats.nextQueued("bot-1", threadId), null, "unknown still fences pending work");
    assert.deepEqual(ctx.chats.enqueue("bot-1", threadId, id, body, generation), cleared, "retry recognizes the original body by digest without resurrecting it");
    assert.throws(() => ctx.chats.enqueue("bot-1", threadId, id, [{ text: "different" }], generation), /different content/);
    assert.throws(() => ctx.chats.setQueued(id, "pending"), /cannot be dispatched/);
    assert.deepEqual(ctx.chats.queued(sibling)!.input, [{ text: "Sibling secret" }]);
    const reset = await call<StatePlan>("bot_state_plan", { botId: "bot-1", action: { kind: "session_reset", history: "retain" } });
    await call("bot_session_reset", apply(reset));
    const retired = await plan({ generation }); assert.ok(retired.resources.includes(pending)); assert.ok(!retired.resources.includes(legacy));
    await call("bot_queue_bodies_clear", apply(retired));
    assert.equal(ctx.chats.queued(pending)!.state, "cancelled"); assert.deepEqual(ctx.chats.queued(pending)!.input, []);
    assert.deepEqual(ctx.chats.queued(legacy)!.input, [{ text: "Unattributed legacy" }], "generation selection never guesses legacy attribution");
    const interrupted = await plan({ ids: [legacy] }), unknown = apply(interrupted);
    ctx.chats.maintenance.begin({ planId: unknown.planId, expectedRevision: unknown.expectedRevision, requestId: unknown.requestId }, interrupted);
    await ctx.queue.close(); ctx.chats.close(); ctx.chats = new ChatIndex(root, id => ctx.store.historyPath(id));
    ctx.queue = new ChatQueue(ctx.chats, id => ctx.supervisor.list().find(bot => bot.id === id));
    assert.equal((await call<StateReceipt>("bot_queue_bodies_clear", unknown)).status, "unknown");
    assert.deepEqual(ctx.chats.queued(legacy)!.input, [{ text: "Unattributed legacy" }]);
    assert.deepEqual((await call<{ receipt: StateReceipt }>("bot_state_receipt_get", { requestId: input.requestId })).receipt, receipt);
    const cross = await call<StatePlan>("bot_state_plan", { botId: "bot-1", action: { kind: "session_reset", history: "retain" } });
    await assert.rejects(call("bot_session_reset", { ...apply(cross), requestId: input.requestId }), /already used/);
    ctx.store.deleteServer("bot-1"); ctx.store.saveServer({ ...record, mainThreadId: null }); await ctx.supervisor.load();
    await assert.rejects(call("bot_queue_bodies_clear", input), /another Bot incarnation/);
  } finally { await api.closeContext!(ctx); await Promise.all(owners.map(owner => owner.close())); await rm(root, { recursive: true, force: true }); }
});
