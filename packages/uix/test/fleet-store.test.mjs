import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { StackStore } = await import("../lib/stack/store.ts");
const resource = (data) => ({ data, error: null, at: 1 });

async function until(store, condition) {
  if (condition()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("store did not update")); }, 2000);
    const off = store.subscribe(() => { if (condition()) { clearTimeout(timer); off(); resolve(); } });
  });
}

test("Fleet snapshots reconnect, retain failed reads, deduplicate catalogs and prune disabled accounts", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const account = { id: "worker-1", provider: "grok", ready: true, enabled: true, removing: false, linkedAccounts: [] };
  let accounts = [account];
  let usage = { atMs: 1, accounts: [], grokBot: { usage: null } };
  let usageError = false;
  let catalogCalls = 0;
  let catalogRead = () => ({ accountId: account.id, models: [{ id: "native-model", efforts: ["low"] }], stale: false });
  const calls = [];
  const results = {
    account_list: () => ({ accounts: [] }), worker_account_list: () => ({ accounts }),
    account_login_current: () => ({ login: null }), worker_account_login_current: () => ({ logins: [] }),
    worker_runtime_list: () => ({ runtimes: [] }), worker_list: () => ({ workers: [] }),
    worker_catalog: (input) => { catalogCalls++; return catalogRead(input); },
    usage_snapshot: () => { if (usageError) throw new Error("usage unavailable"); return usage; },
    bot_list: () => ({ bots: [] }), bot_defaults_get: () => ({}), voice_status: () => ({ call: null }),
    bot_start: () => { throw new Error("connection closed"); },
  };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    subscription = null;
    constructor(url) { this.url = url; sockets.add(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscription = params;
      else calls.push(params);
      void Promise.resolve().then(() => method === "events/subscribe" ? params : results[params.name](params.arguments))
        .then((result) => this.onmessage?.({ data: JSON.stringify({ id, result }) }), (error) => this.onmessage?.({ data: JSON.stringify({ id, error: { message: error.message } }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  function publish(pkg, topic) {
    for (const socket of sockets) if (socket.url.endsWith(`/${pkg}`) && socket.subscription?.topics.includes(topic))
      socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { topic } }) });
  }
  globalThis.WebSocket = Socket;
  const store = new StackStore({ owner: resource(null), accounts: resource([]), workerAccounts: resource([]),
    workerRuntimes: resource([]), workerSessions: resource([]), login: resource(null), workerLogins: resource([]),
    bots: resource([]), botDefaults: resource({}), voice: resource(null), catalog: resource([]), usage: resource(null),
    endpoints: Object.fromEntries(["auth", "workers", "bots", "usage"].map((name) => [name, `ws://localhost/${name}`])) });
  try {
    store.start({ scopedBots: false });
    await until(store, () => store.getState().usage.data && store.getState().workerCatalogs[account.id]?.data && !store.getState().catalogPending[account.id]);
    assert.equal(catalogCalls, 1, "opening workers/auth concurrently shares one account read");
    assert.equal(calls.find((call) => call.name === "worker_catalog").arguments.refresh, false);
    usage = { ...usage, atMs: 2 };
    publish("usage", "usage_changed");
    await until(store, () => store.getState().usage.data.atMs === 2);
    usageError = true;
    publish("usage", "usage_changed");
    await until(store, () => store.getState().usage.error === "usage unavailable");
    assert.equal(store.getState().usage.data.atMs, 2, "last-good usage survives a transport failure");
    usageError = false;
    usage = { ...usage, atMs: 3 };
    [...sockets].find((socket) => socket.url.endsWith("/usage")).close();
    await until(store, () => store.getState().usage.data.atMs === 3 && store.getState().usage.error === null);

    let release;
    catalogRead = () => new Promise((resolve) => { release = resolve; });
    const first = store.refreshWorkerCatalog(account.id);
    const second = store.refreshWorkerCatalog(account.id);
    assert.equal(first, second, "refresh clicks share the same in-flight observation");
    await Promise.resolve();
    accounts = [{ ...account, enabled: false }];
    publish("auth", "worker_accounts_changed");
    await until(store, () => store.getState().workerAccounts.data[0].enabled === false);
    release({ accountId: account.id, models: [], stale: false });
    await first;
    assert.equal(store.getState().workerCatalogs[account.id], undefined, "a late reply cannot resurrect a disabled catalog");
    assert.equal(catalogCalls, 2);

    const readsBefore = calls.filter((call) => call.name === "bot_list").length;
    await assert.rejects(store.call("bots", "bot_start", { account: "bot-account" }), /connection closed/);
    await until(store, () => calls.filter((call) => call.name === "bot_list").length > readsBefore);
    assert.equal(calls.filter((call) => call.name === "bot_start").length, 1, "uncertain Bot writes are never replayed");
  } finally { store.stop(); globalThis.WebSocket = original; }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ accounts = [], bots = [] } = {}) {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const calls = [];
  const handlers = {
    account_list: () => ({ accounts: [] }), worker_account_list: () => ({ accounts }),
    account_login_current: () => ({ login: null }), worker_account_login_current: () => ({ logins: [] }),
    worker_runtime_list: () => ({ runtimes: [] }), worker_list: () => ({ workers: [] }),
    worker_catalog: ({ accountId }) => ({ accountId, models: [], stale: false, runtimeVersion: "initial" }),
    bot_list: () => ({ bots }), bot_defaults_get: () => ({}), voice_status: () => ({ call: null }),
    usage_snapshot: () => ({ atMs: 1, accounts: [] }),
  };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    subscription = null;
    constructor(url) { this.url = url; sockets.add(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscription = params;
      else calls.push(params);
      void Promise.resolve().then(() => method === "events/subscribe" ? params : handlers[params.name](params.arguments))
        .then((result) => this.onmessage?.({ data: JSON.stringify({ id, result }) }), (error) => this.onmessage?.({ data: JSON.stringify({ id, error: { message: error.message } }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  globalThis.WebSocket = Socket;
  const store = new StackStore({ owner: resource(null), accounts: resource([]), workerAccounts: resource([]),
    workerRuntimes: resource([]), workerSessions: resource([]), login: resource(null), workerLogins: resource([]),
    bots: resource(bots), botDefaults: resource({}), voice: resource(null), catalog: resource([]), usage: resource(null),
    endpoints: Object.fromEntries(["auth", "workers", "bots", "usage"].map((name) => [name, `ws://localhost/${name}`])) });
  const publish = (pkg, topic, scope) => {
    for (const socket of sockets) if (socket.url.endsWith(`/${pkg}`) && socket.subscription?.topics.includes(topic) && (!socket.subscription.scope || socket.subscription.scope === scope))
      socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { topic } }) });
  };
  return { store, sockets, calls, handlers, publish, close() { store.stop(); globalThis.WebSocket = original; } };
}

test("catalog disable/re-enable fences the old observation and coalesces dirty notices into one follow-up", async () => {
  const account = { id: "worker-1", provider: "grok", ready: true, enabled: true, removing: false };
  const h = harness({ accounts: [account] });
  const { store, handlers, publish, calls } = h;
  try {
    store.start({ scopedBots: false });
    await until(store, () => store.getState().workerCatalogs[account.id]?.data && !store.getState().catalogPending[account.id]);
    const old = deferred();
    const current = deferred();
    const started = deferred();
    let reads = 0;
    handlers.worker_catalog = () => { reads++; if (reads === 1) return old.promise; started.resolve(); return current.promise; };
    const run = store.refreshWorkerCatalog(account.id);
    handlers.worker_account_list = () => ({ accounts: [{ ...account, enabled: false }] });
    publish("auth", "worker_accounts_changed");
    await until(store, () => store.getState().workerAccounts.data[0].enabled === false);
    handlers.worker_account_list = () => ({ accounts: [account] });
    publish("auth", "worker_accounts_changed");
    await until(store, () => store.getState().workerAccounts.data[0].enabled === true);
    for (let i = 0; i < 5; i++) publish("workers", "workers_changed");
    old.resolve({ accountId: account.id, models: [], stale: false, runtimeVersion: "obsolete" });
    await started.promise;
    assert.equal(store.getState().workerCatalogs[account.id], undefined, "obsolete success must not resurrect the pruned catalog");
    assert.equal(reads, 2, "all invalidations share one subsequent read");
    assert.equal(calls.filter((call) => call.name === "worker_catalog").at(-1).arguments.refresh, false);
    current.resolve({ accountId: account.id, models: [], stale: false, runtimeVersion: "current" });
    await run;
    assert.equal(store.getState().workerCatalogs[account.id].data.runtimeVersion, "current");
    assert.equal(store.getState().catalogPending[account.id], undefined);
  } finally { h.close(); }
});

test("catalog discovery's own notice produces a cache-only follow-up and then settles", async () => {
  const account = { id: "worker-1", provider: "grok", ready: true, enabled: true, removing: false };
  const h = harness({ accounts: [account] });
  const { store, handlers, publish, calls } = h;
  let cached;
  let discoveries = 0;
  handlers.worker_catalog = ({ accountId, refresh }) => {
    if (!cached || refresh) {
      discoveries++;
      cached = { accountId, models: [], stale: false, runtimeVersion: `discovery-${discoveries}` };
      publish("workers", "workers_changed");
    }
    return cached;
  };
  try {
    store.start({ scopedBots: false });
    await until(store, () => store.getState().workerCatalogs[account.id]?.data && !store.getState().catalogPending[account.id]);
    assert.equal(discoveries, 1);
    assert.equal(calls.filter((call) => call.name === "worker_catalog").length, 2);
    const first = store.refreshWorkerCatalog(account.id);
    assert.equal(store.refreshWorkerCatalog(account.id), first, "duplicate refresh clicks do not request extra discovery");
    await first;
    assert.equal(discoveries, 2);
    assert.deepEqual(calls.filter((call) => call.name === "worker_catalog").map((call) => call.arguments.refresh), [false, false, true, false]);
    assert.equal(store.getState().catalogPending[account.id], undefined, "self-notice processing reaches quiescence");
  } finally { h.close(); }
});

test("an explicit catalog refresh arriving during a cache read is preserved once", async () => {
  const account = { id: "worker-1", provider: "codex", ready: true, enabled: true, removing: false };
  const h = harness({ accounts: [account] });
  const initial = deferred();
  const started = deferred();
  const reads = [];
  h.handlers.worker_catalog = ({ refresh }) => {
    reads.push(refresh);
    if (reads.length === 1) { started.resolve(); return initial.promise; }
    return { accountId: account.id, models: [], stale: false, runtimeVersion: "fresh" };
  };
  try {
    h.store.start({ scopedBots: false });
    await started.promise;
    const run = h.store.refreshWorkerCatalog(account.id);
    assert.equal(h.store.refreshWorkerCatalog(account.id), run);
    initial.resolve({ accountId: account.id, models: [], stale: false, runtimeVersion: "cached" });
    await run;
    assert.deepEqual(reads, [false, true]);
    assert.equal(h.store.getState().workerCatalogs[account.id].data.runtimeVersion, "fresh");
  } finally { h.close(); }
});

test("Claude accounts keep independent login recovery, usage, catalogs and native session identities", async () => {
  const accounts = ["claude-a", "claude-b"].map((id) => ({ id, provider: "claude", ready: true, enabled: true, removing: false, linkedAccounts: [] }));
  const attempts = accounts.map((account, index) => ({ id: `login-${index}`, account: account.id, provider: "claude", status: "pending",
    authUrl: "https://claude.ai/oauth/authorize", userCode: null, needsCode: true, error: null }));
  const h = harness({ accounts });
  const { store, handlers, publish, calls } = h;
  let current = attempts;
  const session = { id: "worker-claude", accountId: accounts[0].id, provider: "claude", sessionId: "native-claude-session", phase: "idle" };
  const measurement = { windows: [{ id: "five_hour", label: "5 hours", usedPercent: 23, remainingPercent: 77, resetsAt: null }], extraUsage: null };
  handlers.worker_account_login_current = () => ({ logins: current.map((attempt) => ({ ...attempt })) });
  handlers.worker_account_login_status = ({ id }) => attempts.find((attempt) => attempt.id === id);
  handlers.worker_account_login_submit = ({ id }) => {
    const attempt = attempts.find((item) => item.id === id);
    attempt.needsCode = false;
    return attempt;
  };
  handlers.worker_list = () => ({ workers: [session] });
  handlers.worker_catalog = ({ accountId }) => ({ accountId, provider: "claude", source: "claude-sdk-supported-models", runtimeVersion: "fixture-sdk",
    models: [{ id: `${accountId}-model`, efforts: [] }], stale: false });
  handlers.usage_snapshot = () => ({ atMs: 10, accounts: accounts.map((account, index) => ({ ...account, scope: "worker",
    observedAtMs: index ? null : 10, lastAttemptAtMs: 10, fresh: !index, error: index ? "credentials_unavailable" : null, usage: index ? null : measurement })) });
  try {
    store.start({ scopedBots: false });
    await until(store, () => accounts.every(({ id }) => store.getState().workerCatalogs[id]?.data && store.getState().workerAttempts[id]) && store.getState().workerSessions.data.length && store.getState().usage.data);
    assert.deepEqual(store.getState().workerSessions.data[0], session);
    assert.equal(store.getState().workerCatalogs["claude-a"].data.models[0].id, "claude-a-model");
    assert.equal(store.getState().workerCatalogs["claude-b"].data.models[0].id, "claude-b-model");
    assert.equal(store.getState().workerCatalogs["claude-a"].data.source, "claude-sdk-supported-models");
    assert.equal(store.getState().usage.data.accounts[0].usage.windows[0].remainingPercent, 77);
    assert.equal(store.getState().usage.data.accounts[1].usage, null, "an unobserved account cannot inherit its peer's measurement");
    await store.call("auth", "worker_account_login_submit", { id: attempts[0].id, code: "fixture-code" });
    await until(store, () => store.getState().workerLogins.data.find((attempt) => attempt.id === attempts[0].id)?.needsCode === false);
    assert.equal(store.getState().workerAttempts["claude-a"].needsCode, false);
    assert.equal(store.getState().workerAttempts["claude-b"].needsCode, true);
    attempts[0].status = "complete";
    current = [attempts[1]];
    publish("auth", "worker_login_changed");
    await until(store, () => store.getState().workerAttempts["claude-a"].status === "complete");
    assert.equal(store.getState().workerAttempts["claude-b"].status, "pending");
    assert.ok(calls.some((call) => call.name === "worker_account_login_status" && call.arguments.id === attempts[0].id), "completed login is recovered by attempt ID");
    store.dismissWorkerAttempt("claude-a");
    assert.equal(store.getState().workerAttempts["claude-a"], undefined);
    assert.equal(store.getState().workerAttempts["claude-b"].id, attempts[1].id);
    handlers.worker_account_list = () => ({ accounts: [accounts[0], { ...accounts[1], enabled: false }] });
    publish("auth", "worker_accounts_changed");
    await until(store, () => store.getState().workerAccounts.data[1].enabled === false && !store.getState().workerCatalogs["claude-b"]);
    assert.ok(store.getState().workerCatalogs["claude-a"].data, "disabling one Claude account preserves its peer's catalog");
  } finally { h.close(); }
});

test("per-Bot invalidations survive activity eviction and both kinds of scoped reconnect", async () => {
  const h = harness({ bots: [{ id: "bot-1" }, { id: "bot-2" }] });
  const { store, sockets, publish } = h;
  try {
    store.start();
    await until(store, () => store.getState().scoped["bot-1"]?.status === "open" && store.getState().scoped["bot-2"]?.status === "open");
    const initial = { ...store.getState().botInvalidations };
    publish("bots", "threads_changed", "bot-1");
    assert.equal(store.getState().botInvalidations["bot-1"], initial["bot-1"] + 1);
    for (let i = 0; i < 260; i++) publish("usage", "usage_changed");
    assert.equal(store.getState().events.some((event) => event.scope === "bot-1"), false);
    assert.equal(store.getState().botInvalidations["bot-1"], initial["bot-1"] + 1, "eviction cannot make a stale result current");
    const socket = [...sockets].find((item) => item.subscription?.scope === "bot-1");
    socket.close();
    assert.equal(store.getState().botInvalidations["bot-1"], initial["bot-1"] + 2, "disconnect immediately invalidates old snapshots");
    await until(store, () => store.getState().scoped["bot-1"]?.status === "open");
    const reopened = [...sockets].find((item) => item.subscription?.scope === "bot-1");
    assert.notEqual(reopened, socket);
    const generation = store.getState().botInvalidations["bot-1"];
    assert.ok(generation > initial["bot-1"] + 2);
    reopened.onmessage({ data: JSON.stringify({ method: "events/disconnected" }) });
    await until(store, () => store.getState().botInvalidations["bot-1"] > generation);
    assert.equal(store.getState().botInvalidations["bot-2"], initial["bot-2"], "other Bots are unaffected by this scope's reconnect");
  } finally { h.close(); }
});
