import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { api } from "../api.js";
import { AttentionService } from "../src/service.js";
import type { Call } from "../src/sources.js";
import { statusSchema, type SourceMessage } from "../src/schema.js";
import type { StatePlan } from "@stack/api";

const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "signal-checkpoint-"));
  const chats: Record<string, string[]> = { first: ["old first"], sibling: ["old sibling"] };
  const workers = [{ seq: 1, turnId: "old", kind: "agent", text: "old worker", at: 1 }];
  let reads = 0, inferences = 0, unavailable = false;
  let hold: Promise<void> | null = null;
  const call: Call = async <T>(_pkg: string, name: string, args: unknown) => {
    if (name === "infer_complete") { inferences++; throw new Error("must not infer"); }
    if (name === "account_list") return { accounts: [] } as T;
    reads++;
    if (hold) await hold;
    if (unavailable) throw new Error("source unavailable");
    if (name === "bot_list") return { bots: [{ id: "one", mainThreadId: "first" }] } as T;
    if (name === "chat_list") return { chats: Object.keys(chats).map(threadId => ({ threadId, parentThreadId: null })) } as T;
    if (name === "worker_list") return { workers: [{ id: "one", botId: "_local_operator", threadId: "root", phase: "closed", currentTurnId: null }] } as T;
    if (name === "worker_read") {
      const after = (args as { afterSeq: number }).afterSeq, entries = workers.filter(row => row.seq > after);
      return { entries, nextSeq: entries.at(-1)?.seq ?? after, hasMore: false } as T;
    }
    assert.equal(name, "chat_message_changes");
    const input = args as { threadId: string; headOnly: boolean; cursor?: { line: number } };
    const lines = chats[input.threadId]!, after = input.headOnly ? lines.length : input.cursor?.line ?? 0;
    return { cursor: { sourceId: input.threadId, line: lines.length, prefixHash: String(lines.length) }, hasMore: false, reset: false,
      entries: lines.slice(after).map((text, index) => ({ key: `line:${after + index}`, line: after + index, revision: "fixture", role: "assistant", text, textChars: text.length, timestamp: null, phase: "final" })) } as T;
  };
  let service = new AttentionService(root, {}, call);
  const invoke = async (name: string, input: unknown, invocation?: any) => {
    const op = api.operations.find(op => op.name === name)!;
    return op.output.parse(await op.call({ service }, op.input.parse(input), invocation)) as any;
  };
  return { root, chats, workers, invoke, get service() { return service; }, counts: () => ({ reads, inferences }), unavailable: () => { unavailable = true; },
    hold: (promise: Promise<void>) => { hold = promise; },
    restart: async () => { await service.close(); service = new AttentionService(root, {}, call); },
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}

test("exact rebaseline skips current upstream messages, preserves suppression/evidence/siblings and receipts across restart", async () => {
  const f = await fixture();
  try {
    await f.service.sources.scan();
    const original: SourceMessage = { source: "bots", conversation: "bot:one:first", key: "retained", role: "assistant", authorKind: "agent", botId: "one", text: "retained captured evidence", complete: true, occurredAt: null, evidence: {} };
    const message = f.service.store.admit(original), job = f.service.store.next()!;
    f.service.store.jobState(job.id, "unknown");
    const sibling = f.service.store.meta("cursor:bot:one:sibling");
    f.chats.first!.push("skip while paused"); f.workers.push({ seq: 2, turnId: "old", kind: "agent", text: "skip chunk", at: 2 });
    const plan = await f.invoke("attention_checkpoint_plan", { sources: ["bot:one:first", "worker:one"], mode: "rebaseline" });
    const request = apply(plan), before = f.counts();
    let invalidations = 0; f.service.onChange = () => invalidations++;
    const receipt = await f.invoke("attention_checkpoint_reset", request);
    assert.equal(receipt.status, "completed"); assert.equal(invalidations, 1);
    assert.equal(f.counts().inferences, before.inferences);
    assert.deepEqual(f.service.store.meta("cursor:bot:one:sibling"), sibling);
    assert.equal(f.service.store.message(message.id).text, original.text);
    assert.equal(f.service.store.admit(original).id, message.id); assert.equal(f.service.store.next(), null);
    const status = await f.invoke("attention_status", {});
    assert.equal(status.checkpointGeneration, 1); assert.equal(status.baselined, true); assert.equal(status.enabled, false);
    assert.deepEqual(status.checkpointResets.map((row: {source:string}) => row.source), ["bot:one:first", "worker:one"]);
    f.service.control(true); await f.service.sources.scan(); await f.service.processOne(); f.service.control(false);
    assert.equal(f.service.store.status().messages, 1); assert.equal(f.counts().inferences, 0);
    await f.restart(); const readCount = f.counts().reads;
    assert.deepEqual(await f.invoke("attention_checkpoint_reset", request), receipt);
    assert.equal(f.counts().reads, readCount);
    assert.deepEqual((await f.invoke("signal_state_receipt_get", { requestId: request.requestId })).receipt, receipt);
    f.chats.first!.push("new after reset"); await f.service.sources.scan();
    assert.equal(f.service.store.status().messages, 2); assert.ok(f.service.store.next());
  } finally { await f.close(); }
});

test("checkpoint plans refuse stale upstream heads, pending inference, enabled processing and resume during observation", async () => {
  const f = await fixture();
  try {
    await f.service.sources.scan();
    const plan = await f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" });
    f.chats.first!.push("new position");
    await assert.rejects(f.invoke("attention_checkpoint_reset", apply(plan)), /changed/);
    assert.equal(statusSchema.parse(f.service.store.status()).checkpointGeneration, 0);
    f.service.control(true);
    await assert.rejects(f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" }), /Pause Signal/);
    f.service.control(false);
    const msg: SourceMessage = { source: "bots", conversation: "bot:one:first", key: "pending", role: "assistant", authorKind: "agent", botId: "one", text: "pending body", complete: true, occurredAt: null, evidence: {} };
    f.service.store.admit(msg);
    const pending = await f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" });
    assert.ok(pending.blockedBy.length);
    await assert.rejects(f.invoke("attention_checkpoint_reset", apply(pending)), /drain|changed/);
    f.service.store.jobState(f.service.store.next()!.id, "cancelled");
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); f.hold(held);
    const observing = f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" });
    assert.throws(() => f.service.control(true), /maintenance/);
    await assert.rejects(f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" }), /maintenance/);
    release(); await observing;
    let finish!: () => void; const draining = new Promise<void>(resolve => { finish = resolve; }); f.hold(draining);
    f.service.control(true); await f.service.tick(); f.service.control(false);
    await assert.rejects(f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" }), /active source reads/);
    finish();
    await assert.rejects(f.invoke("attention_checkpoint_plan", { sources: ["worker:missing"], mode: "rebaseline" }), /not available/);
    await assert.rejects(f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" }, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /operator authority/);
  } finally { await f.close(); }
});

test("interrupted checkpoint admission becomes unknown without new reads, while source failures have no cursor effects", async () => {
  const f = await fixture();
  try {
    await f.service.sources.scan();
    const plan = await f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" }), request = apply(plan);
    const before = f.service.store.meta("cursor:bot:one:first");
    f.service.store.maintenance.begin(request, plan);
    await f.restart(); f.unavailable();
    const count = f.counts().reads;
    const receipt = await f.invoke("attention_checkpoint_reset", request);
    assert.equal(receipt.status, "unknown"); assert.equal(f.counts().reads, count);
    assert.deepEqual(await f.invoke("attention_checkpoint_reset", request), receipt);
    assert.deepEqual(f.service.store.meta("cursor:bot:one:first"), before);
    await assert.rejects(f.invoke("attention_checkpoint_plan", { sources: "all", mode: "rebaseline" }), /unavailable/);
    assert.deepEqual(f.service.store.meta("cursor:bot:one:first"), before);
    assert.equal(f.service.store.status().checkpointGeneration, 0);
  } finally { await f.close(); }
});
