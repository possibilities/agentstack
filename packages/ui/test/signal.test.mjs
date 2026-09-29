import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { evidenceSegments, isMainThread, pairInterpretations, parseConversation, queueOrder, readChunks, signalErrorText } = await import("../lib/stack/signal.ts");
const { StackStore } = await import("../lib/stack/store.ts");

const item = (id, cursor, urgency, deadline = null) => ({ id, cursor, timing: { urgency, deadline, blockingScope: null } });

test("the queue orders by urgency, then a stated deadline, then newest", () => {
  const items = [item("a", 1, "routine"), item("b", 2, "unspecified"), item("c", 3, "immediate"), item("d", 4, "routine", "Friday"), item("e", 5, "routine")];
  assert.deepEqual(items.sort(queueOrder).map((entry) => entry.id), ["c", "d", "e", "a", "b"]);
});

test("conversation keys name Bot threads and Worker transcripts; only a Bot's main thread has a chat", () => {
  assert.deepEqual(parseConversation("bot:bot-1:019a-thread"), { kind: "bot", botId: "bot-1", threadId: "019a-thread" });
  assert.deepEqual(parseConversation("worker:w1"), { kind: "worker", workerId: "w1" });
  const bots = [{ id: "bot-1", mainThreadId: "main" }];
  assert.equal(isMainThread("bot:bot-1:main", bots), true);
  assert.equal(isMainThread("bot:bot-1:child", bots), false);
  assert.equal(isMainThread("worker:w1", bots), false);
});

test("chunked exports concatenate under one revision and restart when the export changes", async () => {
  let text = "0123456789";
  const reads = [];
  // Like the API: a read fenced by a stale revision is refused.
  const read = async ({ offset, revision }) => {
    reads.push(offset);
    if (revision && revision !== text) throw new Error("attention_export_changed");
    const chunk = text.slice(offset, offset + 4);
    const served = text;
    if (reads.length === 1) text = "abcdefghij";
    return { text: chunk, nextOffset: offset + chunk.length, totalChars: served.length, revision: served };
  };
  assert.equal(await readChunks(read, { id: "r" }), "abcdefghij");
  assert.deepEqual(reads, [0, 4, 0, 4, 8], "a changed export restarts from zero");
  await assert.rejects(readChunks(async () => { throw new Error("unknown attention run"); }, {}), /unknown attention run/);
});

test("evidence segments keep overlapping items and every character", () => {
  const text = "Please approve the plan today.";
  const segments = evidenceSegments(text, [{ id: "a", start: 0, end: 23 }, { id: "b", start: 7, end: 30 }, { id: "bad", start: 5, end: 99 }]);
  assert.equal(segments.map((segment) => segment.text).join(""), text);
  assert.deepEqual(segments.map((segment) => segment.items), [["a"], ["a", "b"], ["b"]]);
});

test("replay comparison pairs items by exact evidence and keeps unmatched ones on their side", () => {
  const mk = (quote, reason, occurrence = 0) => ({ summary: quote, evidence: { quote, occurrence }, state: "open", attention: { reason }, audience: { kind: "human" } });
  const pairs = pairInterpretations([mk("ship it", "action"), mk("fyi", "awareness")], [mk("ship it", "response"), mk("new", "review")]);
  assert.deepEqual(pairs.map((pair) => [pair.quote, pair.original?.attention.reason ?? null, pair.replay?.attention.reason ?? null]),
    [["ship it", "action", "response"], ["fyi", "awareness", null], ["new", null, "review"]]);
  assert.equal(signalErrorText("Error: attention_settings_conflict"), "Defaults changed elsewhere; showing the latest");
  assert.equal(signalErrorText("something_else"), "something_else");
});

test("Signal notices re-read status; only a new changeSeq re-reads records, and polling stays out of the activity log", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  let changeSeq = 1;
  const calls = [];
  const results = {
    attention_status: () => ({ enabled: true, baselined: true, changeSeq, jobs: [], sourceErrors: [], lastInference: null }),
    attention_list: () => ({ entries: [{ cursor: 3, item: { id: "run:0", summary: "Approve" } }], nextCursor: 3, hasMore: false }),
    attention_replay: () => { throw new Error("connection closed"); },
  };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    subscriptions = new Map();
    constructor() { sockets.add(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      else calls.push(params.name);
      void Promise.resolve().then(() => method.startsWith("events/") ? params : results[params.name](params.arguments))
        .then((result) => this.onmessage?.({ data: JSON.stringify({ id, result }) }), (error) => this.onmessage?.({ data: JSON.stringify({ id, error: { message: error.message } }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  const publish = (topic) => { for (const socket of sockets) for (const subscription of socket.subscriptions.values()) if (subscription.package === "signal")
    socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: "signal", subscription: subscription.subscription, topic } }) }); };
  const until = (store, condition) => condition() ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("store did not update")); }, 2000);
    const off = store.subscribe(() => { if (condition()) { clearTimeout(timer); off(); resolve(); } });
  });
  globalThis.WebSocket = Socket;
  const empty = { data: null, error: null, at: null };
  const store = new StackStore({ server: empty, resources: empty, accounts: empty, workerAccounts: empty, workerRuntimes: empty, workerSessions: empty, login: empty,
    workerLogins: empty, bots: empty, botDefaults: empty, voice: empty, roleCatalog: empty, catalog: empty, usage: empty, endpoints: { signal: "ws://fixture.invalid/websocket" } });
  try {
    store.start({ packages: ["signal"], scopedBots: false });
    await until(store, () => store.getState().signalStatus.data?.changeSeq === 1);
    const generation = store.getState().signalGeneration;
    assert.equal(generation, 1, "the first status read opens the record generation");
    publish("signal_changed");
    await until(store, () => calls.filter((name) => name === "attention_status").length === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.getState().signalGeneration, generation, "a scan with no record changes does not re-read lists");
    changeSeq = 2;
    publish("signal_changed");
    await until(store, () => store.getState().signalGeneration === generation + 1);
    assert.deepEqual(store.getState().events, [], "per-scan notices stay out of the activity log");

    const page = await store.readSignal("attention_list", { states: ["open"] });
    assert.deepEqual(page.entries, [{ id: "run:0", summary: "Approve", cursor: 3 }]);
    assert.equal(store.getState().signalRecords.items["run:0"].summary, "Approve", "listed records resolve for links and inspection");

    const reads = calls.filter((name) => name === "attention_status").length;
    await assert.rejects(store.signalAction("attention_replay", { runId: "r", requestId: "k" }), /connection closed/);
    await until(store, () => calls.filter((name) => name === "attention_status").length > reads);
    assert.equal(calls.filter((name) => name === "attention_replay").length, 1, "an uncertain write is re-read, never replayed");
  } finally { store.stop(); globalThis.WebSocket = original; }
});
