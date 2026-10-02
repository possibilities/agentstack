import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { extname, join } from "node:path";
import test from "node:test";
import { serveSocket, serveWebSocket, socketPath, withLocalAuth } from "@stack/api";
import { fixtureOperations, gatewayRoot, root, serveFixture } from "./browser-fixture.mjs";

// Load the browser store directly without a Next build. Its bundler-style
// imports need extensions when loaded by Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { StackStore } = await import("../lib/stack/store.ts");
const empty = { data: null, error: null, at: null };
const snapshot = (endpoints, extra = {}) => ({ server: empty, resources: empty, accounts: empty, workerAccounts: empty, workerRuntimes: empty, workerSessions: empty,
  usage: empty, login: empty, workerLogins: empty, bots: empty, botDefaults: empty, voice: empty, roleCatalog: empty, catalog: empty, endpoints, ...extra });

async function until(store, condition, label = "store update") {
  if (condition(store.getState())) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`timed out: ${label}`)); }, 3_000);
    const unsubscribe = store.subscribe(() => {
      if (!condition(store.getState())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

const entry = (id, owner, bytes = null) => ({ id, ownerPackage: owner, subject: null, kind: "storage", authority: "authoritative", location: "server", ownership: "stack",
  revision: null, observedAt: "2026-09-30T00:00:00.000Z", coverage: bytes === null ? "partial" : "complete", items: null, bytes, sensitivity: "content", relationships: [],
  reads: [{ package: owner, operation: `${owner}_state_read`, arguments: {} }], actions: [], retention: "Kept", regeneration: "None", issues: [] });
const subscription = (id, revision = "v1") => ({ id, botId: "alpha", threadId: "thread-1", instance: "i", pkg: "notify", topic: "notify_changed", scope: null,
  readOperation: "notification_list", state: "active", lastDeliveredAt: null, revision });
const completionRow = (id, extra = {}) => ({ id, botId: "alpha", threadId: "thread-1", pkg: "notify", operation: "notification_send",
  recordId: "00000000-0000-4000-8000-0000000000d1", state: "delivered", lastDeliveredAt: 1, lastDeliveryKind: "terminal", lastError: null,
  nativeAdmissionUncertain: false, subscriptionPresent: true, ...extra });
const occurrenceRow = (id, extra = {}) => ({ id, target: { kind: "bot", botId: "alpha", threadId: "thread-1", instance: "i" }, pkg: "xcom", name: "posts",
  policy: "native", cursor: null, truncated: false, revision: "o1", receiptCount: 0, receiptsTruncated: false, ...extra });

test("the System state store reads owner inventories and subscriptions locally, fences stale reads and follows serve_state_changed", async () => {
  const dir = await mkdtemp(join("/tmp", "as-state-store-"));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir };
  let observation = 1;
  const lists = [];
  let subscriptions = [subscription("00000000-0000-4000-8000-000000000001"), subscription("00000000-0000-4000-8000-000000000002")];
  const handlers = {
    async serve_state_list(args) {
      lists.push(args);
      const revision = `r${observation}`;
      if (args.revision && args.revision !== revision) throw new Error("aggregate inventory changed; restart paging");
      const owners = args.owners ?? ["bots", "usage", "xcom"];
      const all = [entry(`bots:workspaces-${observation}`, "bots", args.measure ? 4096 : null), entry("bots:logs", "bots"), entry("usage:observations", "usage")]
        .filter((row) => owners.includes(row.ownerPackage));
      return { entries: all.slice(args.offset, args.offset + 2), revision, observedAt: new Date().toISOString(), nextOffset: args.offset + 2 < all.length ? args.offset + 2 : null,
        owners: owners.map((name) => name === "xcom" ? { package: "xcom", available: false, issue: "Owner unavailable or does not implement the current inventory contract" } : { package: name, available: true, issue: null }) };
    },
    serve_subscription_list(args) {
      const rows = subscriptions.filter((row) => !args.botId || row.botId === args.botId);
      return { subscriptions: rows.slice(args.offset, args.offset + args.limit), revision: JSON.stringify(rows.map((row) => row.revision)), nextOffset: null };
    },
    serve_subscription_remove({ id, expectedRevision }) {
      const row = subscriptions.find((item) => item.id === id);
      if (!row) return { id, removed: false };
      if (row.revision !== expectedRevision) throw new Error("subscription revision changed; inspect it again");
      subscriptions = subscriptions.filter((item) => item.id !== id);
      return { id, removed: true };
    },
  };
  const serve = await serveFixture(handlers);
  const socket = await serveSocket({ info: { name: "serve", description: "serve", transportDescription: "Fixture", path: socketPath("serve", env) }, context: {},
    operations: fixtureOperations(serve.names, serve.handlers), events: { topics: serve.topics } });
  const websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["serve"]), port: 0 });
  const originalFetch = globalThis.fetch, originalWebSocket = globalThis.WebSocket;
  const { WebSocket } = createRequire(join(root, "packages/api/package.json"))("ws");
  const origin = "http://127.0.0.1:8745";
  const session = withLocalAuth(env, auth => auth.redeem(auth.bootstrap(origin, "ui"), origin, "ui"));
  globalThis.fetch = async (url, options) => url === "/connect/local/ticket"
    ? Response.json({ ticket: withLocalAuth(env, auth => auth.ticket(session.token, origin)) }) : originalFetch(url, options);
  globalThis.WebSocket = class extends WebSocket { constructor(url, protocols) { super(url, protocols, { origin }); } };
  const store = new StackStore(snapshot({ serve: websocket.url }));
  try {
    store.start({ packages: ["serve"], scopedBots: false });

    // Every owner, with the unavailable one kept as a gap and unmeasured bytes left null.
    await until(store, (state) => state.stateInventory.data?.entries.length === 2 && state.subscriptions.data?.subscriptions.length === 2, "first pages");
    let state = store.getState();
    assert.deepEqual(state.stateInventory.data.owners.map((owner) => [owner.package, owner.available]), [["bots", true], ["usage", true], ["xcom", false]]);
    assert.deepEqual(state.stateInventory.data.entries.map((row) => row.bytes), [null, null]);
    assert.equal(lists[0].measure, false, "measurement is never implicit");

    // A continuation against a changed observation restarts paging instead of mixing revisions.
    observation = 2;
    await store.moreStateInventory();
    state = store.getState();
    assert.equal(state.stateInventory.data.restarted, true);
    assert.equal(state.stateInventory.data.revision, "r2");
    assert.deepEqual(state.stateInventory.data.entries.map((row) => row.id), ["bots:workspaces-2", "bots:logs"]);
    await store.moreStateInventory();
    assert.deepEqual(store.getState().stateInventory.data.entries.map((row) => row.id), ["bots:workspaces-2", "bots:logs", "usage:observations"]);

    // An older all-owner read whose answer arrives late never replaces a newer, narrower selection.
    const call = store.call, gate = Promise.withResolvers();
    let held = null;
    store.call = async (pkg, name, args) => {
      const result = await call(pkg, name, args);
      if (name === "serve_state_list" && !args.owners && !held) { held = result; await gate.promise; }
      return result;
    };
    const stale = store.refreshStateInventory();
    await store.selectStateInventory({ owners: ["bots"], measure: true });
    assert.ok(held, "the older answer is being held");
    gate.resolve();
    await stale;
    store.call = call;
    state = store.getState();
    assert.deepEqual(state.stateInventory.data.selection, { owners: ["bots"], measure: true });
    assert.deepEqual(state.stateInventory.data.owners.map((owner) => owner.package), ["bots"]);
    assert.equal(state.stateInventory.data.entries.find((row) => row.id === "bots:workspaces-2").bytes, 4096);

    // Exact removal at the listed revision; a stale revision is refused; an absent ID reports removed: false.
    subscriptions[0] = subscription(subscriptions[0].id, "v2");
    await assert.rejects(store.removeSubscription(subscriptions[0].id, "v1"), /revision changed/);
    await until(store, (next) => next.subscriptions.data?.subscriptions[0].revision === "v2", "re-read after a refused removal");
    assert.deepEqual(await store.removeSubscription(subscriptions[0].id, "v2"), { id: "00000000-0000-4000-8000-000000000001", removed: true });
    assert.deepEqual(await store.removeSubscription("00000000-0000-4000-8000-000000000001", "v2"), { id: "00000000-0000-4000-8000-000000000001", removed: false });
    await until(store, (next) => next.subscriptions.data?.subscriptions.length === 1, "list after removal");

    // serve_state_changed re-reads subscriptions and the inventory, and bumps the generation owner views observe.
    const generation = store.getState().serveStateGeneration;
    subscriptions.push(subscription("00000000-0000-4000-8000-000000000003"));
    socket.publish("serve_state_changed");
    await until(store, (next) => next.serveStateGeneration > generation && next.subscriptions.data?.subscriptions.length === 2, "serve_state_changed");

    // Filters are passed exactly.
    await store.filterSubscriptions({ botId: "beta" });
    assert.deepEqual(store.getState().subscriptions.data.subscriptions, []);
  } finally {
    store.stop();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    await websocket.close();
    await socket.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completion history and occurrence subscriptions stay unread until watched, then follow their notices", async () => {
  const dir = await mkdtemp(join("/tmp", "as-state-store-"));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir };
  const historyCalls = [], occurrenceCalls = [], watchCalls = [];
  let receipts = [completionRow("00000000-0000-4000-8000-0000000000c1")];
  let occurrences = [occurrenceRow("00000000-0000-4000-8000-0000000000b1")];
  const handlers = {
    serve_subscription_list(args) {
      watchCalls.push(args);
      return { subscriptions: [], revision: `s${watchCalls.length}`, nextOffset: null };
    },
    serve_completion_list(args) {
      historyCalls.push(args);
      const rows = receipts.filter((row) => (!args.botId || row.botId === args.botId) && (!args.state || row.state === args.state));
      return { completions: rows.slice(args.offset, args.offset + args.limit), revision: `h${receipts.length}`, total: rows.length, nextOffset: null, truncated: false };
    },
    serve_occurrence_list(args) {
      occurrenceCalls.push(args);
      const rows = occurrences.filter((row) => (!args.botId || row.target.kind === "bot" && row.target.botId === args.botId));
      return { subscriptions: rows.slice(args.offset, args.offset + args.limit), revision: `o${occurrences.length}`, nextOffset: null };
    },
  };
  const serve = await serveFixture(handlers);
  const socket = await serveSocket({ info: { name: "serve", description: "serve", transportDescription: "Fixture", path: socketPath("serve", env) }, context: {},
    operations: fixtureOperations(serve.names, serve.handlers), events: { topics: serve.topics } });
  const websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["serve"]), port: 0 });
  const originalFetch = globalThis.fetch, originalWebSocket = globalThis.WebSocket;
  const { WebSocket } = createRequire(join(root, "packages/api/package.json"))("ws");
  const origin = "http://127.0.0.1:8745";
  const session = withLocalAuth(env, auth => auth.redeem(auth.bootstrap(origin, "ui"), origin, "ui"));
  globalThis.fetch = async (url, options) => url === "/connect/local/ticket"
    ? Response.json({ ticket: withLocalAuth(env, auth => auth.ticket(session.token, origin)) }) : originalFetch(url, options);
  globalThis.WebSocket = class extends WebSocket { constructor(url, protocols) { super(url, protocols, { origin }); } };
  const store = new StackStore(snapshot({ serve: websocket.url }));
  try {
    store.start({ packages: ["serve"], scopedBots: false });
    // Nothing reads them until a view watches; only subscriptions refresh on connect.
    await until(store, (state) => state.subscriptions.data !== null, "subscriptions read");
    assert.deepEqual(historyCalls, []);
    assert.deepEqual(occurrenceCalls, []);
    assert.equal(store.getState().completions.data, null);
    assert.equal(store.getState().occurrences.data, null);

    // The first watcher reads; the second watcher shares it.
    const unwatchOne = store.watchCompletions();
    const unwatchBoth = store.watchCompletions();
    const unwatchOccurrences = store.watchOccurrences();
    await until(store, (state) => state.completions.data?.completions.length === 1 && state.occurrences.data?.subscriptions.length === 1, "first watched reads");
    assert.equal(historyCalls.length, 1);
    assert.equal(occurrenceCalls.length, 1);

    // Receipt and occurrence changes arrive on serve_subscriptions_changed.
    receipts.push(completionRow("00000000-0000-4000-8000-0000000000c2"));
    occurrences.push(occurrenceRow("00000000-0000-4000-8000-0000000000b2"));
    const receiptGeneration = store.getState().completionGeneration;
    socket.publish("serve_subscriptions_changed");
    await until(store, (state) => state.completions.data?.completions.length === 2 && state.occurrences.data?.subscriptions.length === 2, "serve_subscriptions_changed");
    assert.equal(store.getState().completionGeneration, receiptGeneration + 1, "the notice bumps the generation mounted watch views re-read on");

    // A domain view's history request points the window filter at one Bot and marks each request.
    assert.equal(store.getState().historyRequest, null);
    const historyReads = historyCalls.length;
    await store.showCompletionHistory({ botId: "alpha" });
    assert.deepEqual(store.getState().completionFilter, { botId: "alpha" });
    assert.equal(store.getState().historyRequest?.seq, 1);
    assert.equal(historyCalls.at(-1).botId, "alpha", "a watched History view re-reads with the new filter");
    assert.ok(historyCalls.length > historyReads);
    await store.showCompletionHistory({ package: "worker" });
    assert.equal(store.getState().historyRequest?.seq, 2, "each request bumps the sequence a mounted window follows");
    await store.filterCompletions({});

    // serve_state_changed re-reads watched lists too, and removal re-reads them as well.
    const beforeState = store.getState().completionGeneration;
    receipts.push(completionRow("00000000-0000-4000-8000-0000000000c3"));
    socket.publish("serve_state_changed");
    await until(store, (state) => state.completionGeneration > beforeState && state.completions.data?.completions.length === 3, "serve_state_changed");
    const afterRemove = historyCalls.length;
    await assert.rejects(store.removeSubscription("00000000-0000-4000-8000-0000000000a1", "v1"), /unobserved|revision|Error/);
    await until(store, () => historyCalls.length > afterRemove, "removal re-reads watched history");

    // A filter re-read passes it exactly; an unwatched list stops following notices but keeps its held page.
    await store.filterCompletions({ state: "unknown" });
    assert.equal(historyCalls.at(-1).state, "unknown");
    assert.equal(store.getState().completions.data.completions.length, 0, "the filtered page is what the fixture answered");
    unwatchBoth(); unwatchOne(); unwatchOccurrences();
    const settled = { history: historyCalls.length, occurrences: occurrenceCalls.length, watches: watchCalls.length };
    receipts.push(completionRow("00000000-0000-4000-8000-0000000000c4"));
    socket.publish("serve_subscriptions_changed");
    await until(store, () => watchCalls.length > settled.watches, "subscriptions still refresh on the notice");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(historyCalls.length, settled.history, "unwatched history is not re-read");
    assert.equal(occurrenceCalls.length, settled.occurrences, "unwatched occurrences are not re-read");
    assert.equal(store.getState().completions.data?.filter.state, "unknown", "unwatching keeps the held data");
  } finally {
    store.stop();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    await websocket.close();
    await socket.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a remote store never reads owner inventories, subscriptions, history or occurrences", async () => {
  const store = new StackStore(snapshot({}, { remote: { scope: "control", scopes: ["ui:view", "ui:control"], contentOrigins: {} } }));
  const calls = [];
  store.call = async (pkg, name) => { calls.push(`${pkg}.${name}`); throw new Error("unexpected"); };
  const unwatchCompletions = store.watchCompletions();
  const unwatchOccurrences = store.watchOccurrences();
  await store.refreshStateInventory();
  await store.refreshSubscriptions();
  await store.refreshCompletions();
  await store.refreshOccurrences();
  await store.moreCompletions();
  await store.moreOccurrences();
  await store.showCompletionHistory({ botId: "alpha" });
  await store.filterCompletions({ state: "unknown" });
  await store.filterOccurrences({ botId: "alpha" });
  await store.selectStateInventory({ owners: null, measure: true });
  unwatchCompletions();
  unwatchOccurrences();
  assert.deepEqual(calls, []);
  assert.equal(store.getState().stateInventory.data, null);
  assert.equal(store.getState().completions.data, null);
  assert.equal(store.getState().occurrences.data, null);
});

test("a remote session never opens the local-only Xcom channel", async () => {
  const local = new StackStore(snapshot({ xcom: "ws://127.0.0.1:9/ws" }));
  const remote = new StackStore(snapshot({ xcom: "ws://127.0.0.1:9/ws" }, { remote: { scope: "control", scopes: ["ui:view", "ui:control"], contentOrigins: {} } }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    local.start({ packages: ["xcom"], scopedBots: false });
    remote.start({ packages: ["xcom"], scopedBots: false });
    assert.ok(local.getState().status.xcom, "the local page opens Xcom's channel");
    assert.equal(remote.getState().status.xcom, undefined, "a remote page never opens it");
  } finally {
    local.stop(); remote.stop();
    globalThis.fetch = originalFetch;
  }
});
