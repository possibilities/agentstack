import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

// Load the pure stack modules directly without a Next build. Their bundler-style imports need extensions under Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { blankSnapshot, destinationIdentity, destinationPrefix, destinationStorages, notRecorded, ScopedStorage, waitingForIdentity } = await import("../lib/stack/destination.ts");
const { ChatWindowStore } = await import("../lib/stack/chat-windows.ts");
const { WorkerWindowStore } = await import("../lib/stack/worker-windows.ts");
const { ProcWindowStore } = await import("../lib/stack/proc-windows.ts");
const { ViewerWindowStore } = await import("../lib/stack/browse-viewers.ts");
const { HudViewStore } = await import("../lib/stack/hud-view.ts");
const { saveRecovery, readRecovery, listRecoveries, StateFlowController } = await import("../lib/stack/state.ts");
const { begin, readJournal, destinationKeyValue } = await import("../lib/stack/source-setup.ts");
const { loadIntent, saveIntent } = await import("../lib/stack/browse.ts");
const { notificationDraftKey } = await import("../lib/stack/notify-compose.ts");
const { StackStore } = await import("../lib/stack/store.ts");

const alpha = "7f3c1d52-9a64-4be1-8c0a-2d5e6f708192";
const beta = "0b9a4c1e-5d27-4f83-a1b6-93c70e2d8f45";
const origin = "http://127.0.0.1:8745";
const identity = (extra = {}) => destinationIdentity({ serverId: alpha, authority: "local", origin, ...extra });

/** An in-memory Storage area; `values` holds the real keys a browser would. */
function area() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, removeItem: (key) => { values.delete(key); },
    key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
const scoped = (shared, extra) => new ScopedStorage(identity(extra), () => shared);

test("an identity is complete only with a UUID the server named and an origin, and normalizes both", () => {
  assert.deepEqual(identity(), { serverId: alpha, authority: "local", origin });
  assert.equal(identity({ serverId: alpha.toUpperCase() }).serverId, alpha, "ids compare lowercase");
  assert.equal(identity({ origin: "http://127.0.0.1:8745/path?x=1" }).origin, origin, "only the origin is kept");
  for (const missing of [{ serverId: null }, { serverId: "" }, { serverId: "not-a-uuid" }, { serverId: "../../escape" }, { origin: null }, { origin: "" }, { origin: "not a url" }, { origin: "null" }]) {
    assert.equal(identity(missing), null, JSON.stringify(missing));
  }
  assert.equal(destinationIdentity(null), null);
  assert.equal(destinationIdentity(undefined), null);
  assert.deepEqual(destinationStorages(null), { local: null, session: null }, "no identity, no storage");
});

test("the namespace is stack.destination.<serverId>.<authority>.<origin>. with every separator escaped", () => {
  assert.equal(destinationPrefix(identity()), `stack.destination.${alpha}.local.http%3A%2F%2F127%2E0%2E0%2E1%3A8745.`);
  const remote = identity({ authority: "remote", origin: "https://box.tail1234.ts.net:8945" });
  assert.equal(destinationPrefix(remote), `stack.destination.${alpha}.remote.https%3A%2F%2Fbox%2Etail1234%2Ets%2Enet%3A8945.`);
  // One origin being a dotted extension of another must not let a prefix match the other's keys.
  const short = identity({ origin: "https://a.b" }), long = identity({ origin: "https://a.b.c" });
  assert.ok(!destinationPrefix(long).startsWith(destinationPrefix(short)));
  assert.ok(!destinationPrefix(short).startsWith(destinationPrefix(long)));
});

test("destinations never see each other's records, and unqualified legacy records are left untouched and unread", () => {
  const shared = area();
  const legacy = { "stack.uix.chats.v1": "[]", "stack.uix.bench.v2.fleet": "{\"x\":1}", "stack.uix.bench.v1": "{}", "stack.state-flow.bots:a:workspace": "{}", "stack.worker-catalog-held.v1": "[\"a\"]", "stack.source-setup.create": "{}" };
  for (const [key, value] of Object.entries(legacy)) shared.setItem(key, value);
  const a = scoped(shared), b = scoped(shared, { serverId: beta }), remote = scoped(shared, { authority: "remote" }), elsewhere = scoped(shared, { origin: "http://localhost:8745" });
  a.setItem("uix.chats.v1", "A");
  assert.equal(a.getItem("uix.chats.v1"), "A");
  for (const other of [b, remote, elsewhere]) assert.equal(other.getItem("uix.chats.v1"), null, "another server, authority or origin reads nothing");
  assert.equal(a.getItem("stack.uix.chats.v1"), null, "a legacy key is not addressable through a destination");
  assert.equal(a.getItem("uix.bench.v1"), null);
  b.setItem("uix.chats.v1", "B");
  b.removeItem("uix.chats.v1");
  assert.equal(a.getItem("uix.chats.v1"), "A", "another destination's write and removal do not reach this one");
  a.setItem("state-flow.bots:a:workspace", "x"); a.setItem("state-flow.bots:b:queue", "y"); a.setItem("uix.proc.v1", "z");
  b.setItem("state-flow.bots:c:other", "q");
  assert.deepEqual(a.keys("state-flow.bots:").sort(), ["state-flow.bots:a:workspace", "state-flow.bots:b:queue"]);
  assert.deepEqual(a.keys().sort(), ["state-flow.bots:a:workspace", "state-flow.bots:b:queue", "uix.chats.v1", "uix.proc.v1"], "never another destination's, never an unqualified key");
  for (const [key, value] of Object.entries(legacy)) assert.equal(shared.getItem(key), value, `${key} was neither read, migrated nor changed`);
});

test("storage that is blocked or absent reads as empty and refuses writes", () => {
  const blocked = new ScopedStorage(identity(), () => null);
  assert.equal(blocked.getItem("uix.chats.v1"), null);
  assert.deepEqual(blocked.keys(), []);
  assert.throws(() => blocked.setItem("uix.chats.v1", "x"), /unavailable/);
  assert.doesNotThrow(() => blocked.removeItem("uix.chats.v1"));
  const refusing = new ScopedStorage(identity(), () => ({ ...area(), setItem() { throw new Error("quota"); } }));
  assert.throws(() => refusing.setItem("a", "b"), /quota/);
});

test("every browser store restores only its own destination's arrangement and is inert when detached", () => {
  const shared = area();
  const a = scoped(shared), b = scoped(shared, { serverId: beta });
  shared.setItem("stack.uix.chats.v1", JSON.stringify([{ id: "chat", botId: "legacy" }]));
  shared.setItem("stack.uix.workers.v1", JSON.stringify([{ id: "worker-2", workerId: "legacy" }]));
  const stores = () => ({ chats: new ChatWindowStore(), workers: new WorkerWindowStore(), procs: new ProcWindowStore(), viewers: new ViewerWindowStore(), hud: new HudViewStore() });
  const first = stores();
  for (const store of Object.values(first)) store.attach(a);
  assert.deepEqual(first.chats.getWindows(), [{ id: "chat", botId: null }], "a legacy arrangement is not restored");
  first.chats.show("bot-1");
  first.workers.show("w-1");
  first.procs.selectSchedule("schedule-1");
  first.viewers.show("profile-1");
  first.hud.select("00000000-0000-4000-8000-0000000000a1");
  assert.ok(a.keys().length >= 5, "each store wrote under the destination");
  assert.ok(![...shared.values.keys()].some((key) => key.startsWith("uix.")), "no unqualified short key is ever written");

  const again = stores();
  for (const store of Object.values(again)) store.attach(a);
  assert.equal(again.chats.getWindows()[0].botId, "bot-1", "the same destination restores it");
  assert.equal(again.procs.getSelected(), "schedule-1");
  assert.equal(again.hud.getView().selectedId, "00000000-0000-4000-8000-0000000000a1");

  const other = stores();
  for (const store of Object.values(other)) store.attach(b);
  assert.deepEqual(other.chats.getWindows(), [{ id: "chat", botId: null }], "another server restores nothing");
  assert.equal(other.procs.getSelected(), null);
  assert.equal(other.hud.getView().selectedId, null);

  const before = shared.values.size, unknown = stores();
  for (const store of Object.values(unknown)) store.attach(null);
  unknown.chats.show("bot-2"); unknown.workers.show("w-2"); unknown.procs.selectSchedule("schedule-2"); unknown.viewers.show("profile-2"); unknown.hud.select("00000000-0000-4000-8000-0000000000a2");
  assert.equal(shared.values.size, before, "with no destination nothing is written");
  assert.equal(unknown.chats.getWindows()[0].botId, "bot-2", "in-memory use still works");
});

test("a state flow saves, reads and lists requests only in its own destination, and never with none", async () => {
  const shared = area();
  const a = scoped(shared), b = scoped(shared, { serverId: beta });
  const input = { planId: "p", expectedRevision: "r", requestId: "00000000-0000-4000-8000-000000000001" };
  shared.setItem("stack.state-flow.xcom:posts", JSON.stringify({ input, at: 1 }));
  saveRecovery(a, "xcom:posts", input);
  assert.deepEqual(readRecovery(a, "xcom:posts").input, input);
  assert.equal(readRecovery(b, "xcom:posts"), null, "another server never sees the request");
  assert.equal(readRecovery(null, "xcom:posts"), null, "with no destination nothing is read, even the legacy record");
  assert.deepEqual(listRecoveries(a, "xcom:").map((item) => item.key), ["xcom:posts"]);
  assert.deepEqual(listRecoveries(b, "xcom:"), []);
  assert.deepEqual(listRecoveries(null, "xcom:"), []);
  const writes = shared.values.size;
  saveRecovery(null, "xcom:more", input);
  assert.equal(shared.values.size, writes, "with no destination nothing is written");

  const calls = [];
  const operations = { prepare: async () => { throw new Error("not planned"); }, apply: async () => { throw new Error("not applied"); }, readReceipt: async (requestId) => { calls.push(requestId); return null; } };
  const wrong = new StateFlowController({ operations, recoveryKey: "xcom:posts", recovery: b });
  await wrong.recover();
  assert.deepEqual(calls, [], "no recovery is dispatched for a request another destination saved");
  const none = new StateFlowController({ operations, recoveryKey: "xcom:posts" });
  await none.recover();
  assert.deepEqual(calls, [], "none is dispatched while the destination is unknown");
  const right = new StateFlowController({ operations, recoveryKey: "xcom:posts", recovery: a });
  await right.recover();
  assert.deepEqual(calls, [input.requestId], "this destination's request is read back, by its own id, once");
  right.update({ operations, recovery: b });
  await right.recover();
  assert.deepEqual(calls, [input.requestId], "only an idle flow recovers");
});

test("a recovery that appears after the destination is named is read once, not before", async () => {
  const shared = area();
  const a = scoped(shared);
  saveRecovery(a, "worker:branch:ids", { planId: "p", expectedRevision: "r", requestId: "00000000-0000-4000-8000-000000000002" });
  const calls = [];
  const operations = { prepare: async () => { throw new Error("x"); }, apply: async () => { throw new Error("x"); }, readReceipt: async (requestId) => { calls.push(requestId); return null; } };
  const flow = new StateFlowController({ operations, recoveryKey: "worker:branch:ids", recovery: null });
  await flow.recover();
  assert.deepEqual(calls, []);
  flow.update({ operations, recovery: a });
  await flow.recover();
  assert.deepEqual(calls, ["00000000-0000-4000-8000-000000000002"]);
});

test("the Source journal and Browse intents are destination-bound and refuse writes with no destination", () => {
  const shared = area();
  const a = scoped(shared), b = scoped(shared, { serverId: beta });
  const entry = { requestId: "33333333-3333-4333-8333-333333333333", endpointId: "22222222-2222-4222-8222-222222222222", kind: "ping", at: 1, intent: "ping", status: "pending", startedAt: null, completedAt: null, error: null };
  assert.equal(begin(destinationKeyValue(null), entry), false, "a request that cannot be recorded is not sent");
  assert.deepEqual(readJournal(destinationKeyValue(null), entry.endpointId), []);
  assert.equal(shared.values.size, 0);
  assert.equal(begin(destinationKeyValue(a), entry), true);
  assert.deepEqual(readJournal(destinationKeyValue(a), entry.endpointId).map((item) => item.requestId), [entry.requestId]);
  assert.deepEqual(readJournal(destinationKeyValue(b), entry.endpointId), [], "another server never offers this request again");
  assert.ok([...shared.values.keys()].every((key) => key.startsWith(destinationPrefix(identity()))), "recorded under the destination only");

  const intent = { kind: "take", args: { id: "h1", expectedRevision: 3, requestId: "req-1" } };
  saveIntent(a, intent, "h1");
  assert.deepEqual(loadIntent(a, "h1"), intent);
  assert.equal(loadIntent(b, "h1"), null, "a take recorded for one server is never repeated against another");
  saveIntent(null, intent, "h2");
  assert.equal(loadIntent(null, "h2"), null);
  assert.equal(notificationDraftKey("ws://x/y"), "uix.notify-compose.v1.ws%3A%2F%2Fx%2Fy", "a draft's name carries its endpoint only; the namespace carries the destination");
});

test("a replacement destination starts from a blank snapshot that keeps only how to reach it", () => {
  const filled = (data) => ({ data, error: null, at: 5 });
  const snapshot = { server: filled({ pid: 1 }), resources: filled({}), accounts: filled([{ id: "a" }]), workerAccounts: filled([]), workerRuntimes: filled([]), workerSessions: filled([{ id: "w" }]),
    usage: filled({}), login: filled(null), workerLogins: filled([]), bots: filled([{ id: "bot-1" }]), botDefaults: filled({}), voice: filled(null), roleCatalog: filled({}), catalog: filled([{ name: "x" }]),
    endpoints: { bots: "ws://one/websocket" }, contentOrigins: { document: "d", artifact: "a" }, remote: { scope: "view", scopes: ["ui:view"], contentOrigins: { document: "d", artifact: "a" } },
    destination: { authority: "remote", origin: "https://box.example:8945", serverId: alpha } };
  const next = blankSnapshot(snapshot, { authority: "remote", origin: "https://box.example:8945", serverId: beta });
  for (const key of ["server", "resources", "accounts", "workerAccounts", "workerRuntimes", "workerSessions", "usage", "login", "workerLogins", "bots", "botDefaults", "voice", "roleCatalog", "catalog"]) {
    assert.deepEqual(next[key], { data: null, error: null, at: null }, `${key} carries nothing across`);
  }
  assert.deepEqual(next.endpoints, snapshot.endpoints);
  assert.deepEqual(next.remote, snapshot.remote);
  assert.equal(next.destination.serverId, beta);
  assert.equal(new StackStore(next).getState().destination.serverId, beta);
  assert.equal(new StackStore(next).getState().bots.data, null);
});

/** A WebSocket answering serve reads from `answers`, so a store can learn its identity the way a page does. */
function fakeServe(answers) {
  const trace = [];
  const sockets = new Set();
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1;
    readyState = 0; subscriptions = new Map();
    constructor(url) { this.url = url; sockets.add(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "tools/call") trace.push(params.name);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      let result;
      if (method.startsWith("events/")) result = params;
      else { const answer = answers[params.name]; result = typeof answer === "function" ? answer(params.arguments) : answer ?? {}; }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  const publish = (pkg, topic) => { for (const socket of sockets) for (const item of socket.subscriptions.values()) if (item.package === pkg && item.topics.includes(topic)) socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: item.subscription, topic } }) }); };
  return { FakeWebSocket, trace, publish };
}
const resource = (data) => ({ data, error: null, at: 1 });
const snapshotFor = (extra = {}) => ({ server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]), login: resource(null),
  workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null), endpoints: { serve: "ws://fixture.invalid/websocket" }, ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

test("the store learns its identity only from serve_status: adopted once, never inferred, and a different one is reported, not adopted", async () => {
  let status = { pid: 1, children: [] };
  const serve = fakeServe({ serve_status: () => status });
  const original = globalThis.WebSocket;
  globalThis.WebSocket = serve.FakeWebSocket;
  const store = new StackStore(snapshotFor({ destination: { authority: "remote", origin: "https://box.example:8945", serverId: null }, remote: { scope: "view", scopes: ["ui:view"], contentOrigins: {} } }));
  const moved = [];
  store.onDestinationMoved((next) => moved.push(next));
  try {
    assert.equal(store.getState().destination.serverId, null);
    store.start({ packages: ["serve"], scopedBots: false });
    await settle();
    assert.equal(store.getState().destination.serverId, null, "a status without a name names nothing");
    status = { pid: 1, children: [], serverId: alpha.toUpperCase() };
    serve.publish("serve", "pids_changed");
    await settle();
    assert.deepEqual(store.getState().destination, { authority: "remote", origin: "https://box.example:8945", serverId: alpha }, "the first name completes the destination");
    status = { pid: 1, children: [] };
    serve.publish("serve", "pids_changed");
    await settle();
    assert.equal(store.getState().destination.serverId, alpha, "a later status without a name does not forget it");
    assert.deepEqual(moved, []);
    status = { pid: 2, children: [], serverId: beta };
    serve.publish("serve", "pids_changed");
    await settle();
    serve.publish("serve", "pids_changed");
    await settle();
    assert.equal(store.getState().destination.serverId, alpha, "another platform is never adopted in place");
    assert.deepEqual(moved, [{ authority: "remote", origin: "https://box.example:8945", serverId: beta }], "it is reported once, for the tree's owner to replace");
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("a server snapshot that names itself completes a local destination at once", () => {
  const store = new StackStore(snapshotFor({ server: resource({ serverId: alpha, pid: 1 }), destination: { authority: "local", origin, serverId: alpha } }));
  assert.deepEqual(store.getState().destination, { authority: "local", origin, serverId: alpha });
  assert.deepEqual(store.getServerState().destination, store.getState().destination, "the first client render matches the server's");
  const bare = new StackStore(snapshotFor());
  assert.deepEqual(bare.getState().destination, { authority: "local", origin: null, serverId: null }, "a snapshot with no destination has no identity, so nothing is persisted");
  assert.equal(destinationIdentity(bare.getState().destination), null);
});

test("saved catalog fences are read from this destination only, and implicit discovery waits until they have been", async () => {
  const shared = area();
  const a = scoped(shared), b = scoped(shared, { serverId: beta });
  a.setItem("worker-catalog-held.v1", JSON.stringify(["acct-1"]));
  shared.setItem("stack.worker-catalog-held.v1", JSON.stringify(["acct-2"]));
  const serve = fakeServe({ worker_catalog: () => ({ models: [] }), worker_list: () => ({ workers: [] }), worker_runtime_list: () => ({ runtimes: [] }) });
  const original = globalThis.WebSocket;
  globalThis.WebSocket = serve.FakeWebSocket;
  const accounts = ["acct-1", "acct-2", "acct-3"].map((id) => ({ id, enabled: true, ready: true, removing: false }));
  const catalogCalls = () => serve.trace.filter((name) => name === "worker_catalog").length;
  const fresh = () => new StackStore(snapshotFor({ workerAccounts: resource(accounts), endpoints: { worker: "ws://fixture.invalid/websocket" }, destination: { authority: "local", origin, serverId: alpha } }));
  const first = fresh();
  try {
    first.start({ packages: ["worker"], scopedBots: false });
    await settle();
    assert.equal(catalogCalls(), 0, "no implicit discovery before the saved fences are read");
    first.attachStorage(a);
    await settle();
    assert.equal(catalogCalls(), 2, "acct-3 discovers; acct-1's saved fence holds, and the legacy acct-2 record is not a fence");
    assert.equal(first.holdWorkerCatalog("acct-3"), null, "a fence that was saved reports no refusal");
    assert.deepEqual(JSON.parse(a.getItem("worker-catalog-held.v1")).sort(), ["acct-1", "acct-3"], "a fence is written to this destination's storage");
    assert.equal(b.getItem("worker-catalog-held.v1"), null, "and to no other");
    assert.equal(shared.getItem("stack.worker-catalog-held.v1"), JSON.stringify(["acct-2"]), "the legacy record is untouched");
  } finally { first.stop(); }
  const second = fresh();
  try {
    second.start({ packages: ["worker"], scopedBots: false });
    second.attachStorage(b);
    await settle();
    assert.equal(catalogCalls(), 2 + 3, "another destination holds none of those fences");
    second.attachStorage(null);
    assert.equal(second.holdWorkerCatalog("acct-1"), waitingForIdentity, "a store with no storage cannot save the fence, so it refuses the apply that depends on it");
    assert.equal(b.getItem("worker-catalog-held.v1"), null, "a store detached from storage persists nothing");
  } finally {
    second.stop();
    globalThis.WebSocket = original;
  }
});

/** A scripted owner whose apply and receipt reads are counted, so a refusal can be shown to send nothing. */
function countingOwner(plan) {
  const calls = { prepare: 0, apply: 0, receipt: 0 };
  return { calls, operations: { prepare: async () => { calls.prepare++; return plan; }, apply: async (input) => { calls.apply++; return { status: "completed", requestId: input.requestId, outcomes: [], completedAt: null }; },
    readReceipt: async () => { calls.receipt++; return null; } } };
}
const flowPlan = { id: "plan-1", revision: "rev-1", action: "clear", subject: { kind: "x", id: "1" }, blockedBy: [], expiresAt: new Date(Date.now() + 600_000).toISOString(), createdAt: new Date().toISOString(),
  entries: [], retained: [], regeneration: [], resources: [] };
const sequential = (n) => { let i = 0; return { now: () => Date.now(), uuid: () => `00000000-0000-4000-8000-${String(++i + n).padStart(12, "0")}` }; };

test("a state flow with a recovery slot prepares, applies, retries and reads nothing until its destination has storage", async () => {
  const owner = countingOwner(flowPlan);
  const flow = new StateFlowController({ operations: owner.operations, recoveryKey: "xcom:posts", recovery: null }, sequential(10));
  assert.equal(flow.getBlock(), waitingForIdentity);
  await flow.prepare(); await flow.apply(); await flow.retry(); await flow.readReceipt();
  assert.deepEqual(owner.calls, { prepare: 0, apply: 0, receipt: 0 }, "nothing is asked of the owner");
  assert.equal(flow.getState().phase, "idle");
  const unslotted = new StateFlowController({ operations: owner.operations }, sequential(20));
  assert.equal(unslotted.getBlock(), null, "a flow that records nothing is not held back");
  await unslotted.prepare();
  assert.equal(owner.calls.prepare, 1);
  flow.update({ operations: owner.operations, recovery: scoped(area()) });
  assert.equal(flow.getBlock(), null, "named, it proceeds");
  await flow.prepare();
  assert.equal(owner.calls.prepare, 2);
});

test("an apply is refused, sending nothing, when its request cannot be recorded first", async () => {
  const shared = area();
  const owner = countingOwner(flowPlan);
  const flow = new StateFlowController({ operations: owner.operations, recoveryKey: "worker:branch:ids", recovery: scoped(shared) }, sequential(30));
  await flow.prepare();
  assert.equal(flow.getState().phase, "preview");
  // The destination's storage goes away between the plan and the apply.
  flow.update({ operations: owner.operations, recovery: null });
  await flow.apply();
  assert.equal(owner.calls.apply, 0, "no apply without a recoverable record");
  assert.equal(flow.getState().phase, "preview");
  assert.equal(flow.getState().refused, waitingForIdentity);
  // Storage that refuses the write blocks the dispatch too.
  const refusing = new ScopedStorage(identity(), () => ({ ...area(), setItem() { throw new Error("quota"); } }));
  flow.update({ operations: owner.operations, recovery: refusing });
  await flow.apply();
  assert.equal(owner.calls.apply, 0);
  assert.equal(flow.getState().refused, notRecorded);
  // Storage that accepts but does not hold it is the same refusal.
  const forgetful = new ScopedStorage(identity(), () => ({ ...area(), setItem() {} }));
  flow.update({ operations: owner.operations, recovery: forgetful });
  await flow.apply();
  assert.equal(owner.calls.apply, 0);
  assert.equal(flow.getState().refused, notRecorded);
  // A guard that refuses (the catalog fence could not be saved) sends nothing and records nothing.
  const good = scoped(shared);
  flow.update({ operations: owner.operations, recovery: good, guard: () => waitingForIdentity });
  await flow.apply();
  assert.equal(owner.calls.apply, 0);
  assert.equal(flow.getState().refused, waitingForIdentity);
  assert.deepEqual(good.keys("state-flow."), [], "a refused apply leaves no record");
  flow.update({ operations: owner.operations, recovery: good });
  await flow.apply();
  assert.equal(owner.calls.apply, 1, "recorded, it is sent once");
  assert.equal(good.keys("state-flow.").length, 0, "a completed receipt retires its record");
});

test("recording helpers answer whether the record is held", () => {
  const shared = area();
  const a = scoped(shared);
  const input = { planId: "p", expectedRevision: "r", requestId: "00000000-0000-4000-8000-000000000003" };
  assert.equal(saveRecovery(a, "x:y", input), true);
  assert.equal(saveRecovery(null, "x:y", input), false);
  assert.equal(saveRecovery(new ScopedStorage(identity(), () => ({ ...area(), setItem() { throw new Error("quota"); } })), "x:y", input), false);
  const intent = { kind: "take", args: { id: "h1", expectedRevision: 3, requestId: "req-1" } };
  assert.equal(saveIntent(a, intent, "h1"), true);
  assert.equal(saveIntent(null, intent, "h1"), false, "a take that cannot be recorded is not sent");
  assert.equal(saveIntent(new ScopedStorage(identity(), () => ({ ...area(), setItem() { throw new Error("quota"); } })), intent, "h1"), false);
  assert.equal(saveIntent(new ScopedStorage(identity(), () => ({ ...area(), setItem() {} })), intent, "h1"), false);
  assert.equal(saveIntent(null, null, "h1"), true, "forgetting needs no storage");
  assert.equal(saveIntent(a, null, "h1"), true);
  assert.equal(loadIntent(a, "h1"), null);
});

test("a catalog fence that cannot be saved is reported so its apply is refused, and still holds in memory", async () => {
  const shared = area();
  const refusing = new ScopedStorage(identity(), () => ({ ...area(), setItem() { throw new Error("quota"); } }));
  const store = new StackStore(snapshotFor({ destination: { authority: "local", origin, serverId: alpha } }));
  assert.equal(store.holdWorkerCatalog("acct-1"), waitingForIdentity, "no storage yet");
  store.attachStorage(refusing);
  assert.equal(store.holdWorkerCatalog("acct-1"), notRecorded, "storage refused");
  store.attachStorage(scoped(shared));
  assert.equal(store.holdWorkerCatalog("acct-1"), null, "saved");
  assert.deepEqual(JSON.parse(scoped(shared).getItem("worker-catalog-held.v1")), ["acct-1"]);
});
