import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

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

const resource = (data) => ({ data, error: null, at: 1 });
const bot = (id) => ({ id, pid: 123, cwd: `/tmp/${id}`, url: null, state: "running", account: null,
  runningAccount: null, mainThreadId: null, recoveryIssue: null, roleRevision: 1 });

async function until(store, condition) {
  if (condition()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("store did not update")); }, 2_000);
    const unsubscribe = store.subscribe(() => {
      if (!condition()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

test("package notices keep bot membership and worker accounts live", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  let bots = [];
  let workerAccounts = [];
  const results = {
    bot_list: () => ({ bots }), voice_status: () => ({ call: null }),
    account_list: () => ({ accounts: [] }), worker_account_list: () => ({ accounts: workerAccounts }),
    account_login_current: () => ({ login: null }),
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    subscriptions = new Map();

    constructor(url) {
      this.url = url;
      sockets.add(this);
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); });
    }

    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      if (method === "events/unsubscribe") this.subscriptions.delete(params.subscription);
      let result, error;
      try {
        result = method.startsWith("events/") ? params : results[params.name]?.(params.arguments);
      } catch (cause) {
        error = { message: cause instanceof Error ? cause.message : String(cause) };
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...(error ? { error } : { result }) }) }));
    }

    close() {
      this.readyState = 3;
      sockets.delete(this);
      this.onclose?.();
    }
  }

  function publish(pkg, topic, scope) {
    for (const socket of sockets) {
      for (const subscription of socket.subscriptions.values()) {
        if (subscription.package !== pkg || !subscription.topics.includes(topic)) continue;
        if (subscription.scope && subscription.scope !== scope) continue;
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  const snapshot = {
    server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null),
    endpoints: { bots: "ws://fixture.invalid/websocket", auth: "ws://fixture.invalid/websocket" },
  };
  const store = new StackStore(snapshot);
  let indexStore;
  try {
    store.start();
    await until(store, () => store.getState().bots.at > 1 && [...sockets].some((socket) =>
      [...socket.subscriptions.values()].some((subscription) => subscription.package === "bots" && !subscription.scope && subscription.topics.includes("bots_changed"))));
    assert.equal(sockets.size, 1, "package channels share a single socket");

    bots = [bot("bot-1")];
    publish("bots", "bots_changed", "bot-1");
    await until(store, () => store.getState().bots.data?.length === 1 && store.getState().scoped["bot-1"]?.status === "open");

    bots = [bot("bot-1"), bot("bot-2")];
    publish("bots", "bots_changed", "bot-2");
    await until(store, () => store.getState().bots.data?.length === 2 && store.getState().scoped["bot-2"]?.status === "open");

    bots = [bot("bot-2")];
    publish("bots", "bots_changed", "bot-1");
    await until(store, () => store.getState().bots.data?.[0]?.id === "bot-2" && !store.getState().scoped["bot-1"]);

    workerAccounts = [{ id: "worker-1", provider: "grok", enabled: true, ready: true, removing: false }];
    publish("auth", "worker_accounts_changed");
    await until(store, () => store.getState().workerAccounts.data?.[0]?.id === "worker-1");

    // A reconnect snapshots membership even when a change occurred while offline.
    assert.equal(sockets.size, 1, "scoped subscriptions also share the socket");
    [...sockets][0].close();
    bots = [bot("bot-2"), bot("bot-3")];
    await until(store, () => store.getState().bots.data?.some((item) => item.id === "bot-3") &&
      store.getState().scoped["bot-3"]?.status === "open");

    store.stop();
    indexStore = new StackStore(snapshot);
    indexStore.start({ packages: ["serve", "bots"], scopedBots: false });
    await until(indexStore, () => indexStore.getState().bots.data?.length === 2);
    assert.equal(sockets.size, 1, "the index needs one shared connection");
    assert.deepEqual(indexStore.getState().scoped, {});
    bots = [bot("bot-3")];
    publish("bots", "bots_changed", "bot-2");
    await until(indexStore, () => indexStore.getState().bots.data?.[0]?.id === "bot-3");
  } finally {
    store.stop();
    indexStore?.stop();
    globalThis.WebSocket = original;
  }
});

test("proc opens only schedule and run topics, refreshes its state, and scopes output reads per run", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const schedules = [{ id: "sched-1", revision: 1, label: "Sync", action: { type: "api", package: "notify", operation: "notify_push", input: {} },
    firstAt: "2026-01-01T00:00:00Z", everyMs: null, enabled: true, system: false, createdBy: { kind: "operator" }, lastEditedBy: { kind: "operator" },
    authority: { kind: "operator" }, blockedReason: null, retryAt: null, removedAt: null, nextAt: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", recent: [] }];
  const run = (id) => ({ id, requestId: null, label: "Snapshot", command: "/bin/echo", state: "running", startedAt: "2026-01-01T00:00:00Z",
    finishedAt: null, exitCode: null, signal: null, error: null, createdBy: { kind: "operator" }, scheduleId: null, scheduleExecutionId: null,
    lineCount: 0, outputTruncated: false, retainOutput: true, pid: 1 });
  const runs = [run("run-1")];
  const status = { running: 1, capacity: 16, inFlightCalls: 0, callCapacity: 16,
    schedules: { total: 1, enabled: 1, held: 0, blocked: 0, legacy: 0, removed: 0 },
    lastSweepAt: "2026-01-01T00:00:00Z", lastPruneAt: null, closing: false, retentionDays: 30, output: { maxBytes: 2_000_000, maxLines: 10_000 } };
  const results = {
    proc_schedule_list: () => ({ schedules }), proc_run_list: () => ({ runs, nextCursor: null }), proc_status: () => status,
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    subscriptions = new Map();
    constructor(url) {
      this.url = url;
      sockets.add(this);
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); });
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      if (method === "events/unsubscribe") this.subscriptions.delete(params.subscription);
      let result, error;
      try {
        result = method.startsWith("events/") ? params : results[params.name]?.(params.arguments);
      } catch (cause) {
        error = { message: cause instanceof Error ? cause.message : String(cause) };
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...(error ? { error } : { result }) }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }

  const publish = (pkg, topic, scope) => {
    for (const socket of sockets) {
      for (const subscription of socket.subscriptions.values()) {
        if (subscription.package !== pkg || !subscription.topics.includes(topic)) continue;
        if (subscription.scope && subscription.scope !== scope) continue;
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
      }
    }
  };

  globalThis.WebSocket = FakeWebSocket;
  const snapshot = {
    server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null),
    endpoints: { proc: "ws://fixture.invalid/websocket" },
  };
  const store = new StackStore(snapshot);
  try {
    store.start();
    await until(store, () => store.getState().procSchedules.at > 1 && store.getState().procRuns.at > 1 && store.getState().procStatus.at > 1);
    const main = [...sockets].flatMap((socket) => [...socket.subscriptions.values()]).find((subscription) => subscription.package === "proc" && !subscription.scope);
    assert.deepEqual([...main.topics].sort(), ["proc_runs_changed", "proc_schedules_changed"], "the main channel never subscribes proc_output_changed");
    assert.deepEqual(store.getState().procSchedules.data?.map((item) => item.id), ["sched-1"]);
    assert.deepEqual(store.getState().procRuns.data?.runs.map((item) => item.id), ["run-1"]);
    assert.equal(store.getState().procStatus.data?.running, 1);

    // A schedules notice bumps the generation and re-reads lists and status.
    publish("proc", "proc_schedules_changed", "sched-1");
    await until(store, () => store.getState().procScheduleGeneration >= 1);
    // A runs notice re-reads runs and status, but not the schedule generation.
    const generation = store.getState().procScheduleGeneration;
    runs.unshift(run("run-0"));
    publish("proc", "proc_runs_changed", "run-1");
    await until(store, () => store.getState().procRuns.data?.runs.length === 2);
    assert.equal(store.getState().procScheduleGeneration, generation);

    // Watching a run opens a scoped subscription to output and run notices; it ref-counts and closes with the last release.
    const releaseOne = store.watchProcRun("run-1");
    const releaseTwo = store.watchProcRun("run-1");
    await until(store, () => [...sockets].flatMap((socket) => [...socket.subscriptions.values()])
      .some((subscription) => subscription.package === "proc" && subscription.scope === "run-1" && subscription.topics.includes("proc_output_changed")));
    const scoped = [...sockets].flatMap((socket) => [...socket.subscriptions.values()]).find((subscription) => subscription.package === "proc" && subscription.scope === "run-1");
    assert.deepEqual([...scoped.topics].sort(), ["proc_output_changed", "proc_runs_changed"]);
    const seen = store.getState().procRunGenerations["run-1"];
    publish("proc", "proc_output_changed", "run-1");
    await until(store, () => (store.getState().procRunGenerations["run-1"] ?? 0) > seen);
    releaseOne();
    assert.ok([...sockets].flatMap((socket) => [...socket.subscriptions.values()]).some((subscription) => subscription.scope === "run-1"), "still watched");
    releaseTwo();
    assert.ok(![...sockets].flatMap((socket) => [...socket.subscriptions.values()]).some((subscription) => subscription.scope === "run-1"), "closed with the last watcher");
    assert.equal(store.getState().procRunGenerations["run-1"], undefined);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("worker sign-in attempts merge, resolve, and dismiss", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const attempt = { id: "wlog-1", account: "worker-1", provider: "codex", status: "pending", authUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345", needsCode: false, error: null };
  let logins = [];
  let statusResult = null;
  const results = {
    account_list: () => ({ accounts: [] }), worker_account_list: () => ({ accounts: [] }),
    account_login_current: () => ({ login: null }),
    worker_account_login_current: () => ({ logins }),
    worker_account_login_start: () => attempt,
    worker_account_login_status: ({ id }) => {
      if (id === attempt.id && statusResult) return statusResult;
      throw new Error("unknown Worker sign-in");
    },
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    subscriptions = new Map();
    constructor(url) {
      this.url = url;
      sockets.add(this);
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); });
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      if (method === "events/unsubscribe") this.subscriptions.delete(params.subscription);
      let result, error;
      try {
        result = method.startsWith("events/") ? params : results[params.name]?.(params.arguments);
      } catch (cause) {
        error = { message: cause instanceof Error ? cause.message : String(cause) };
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...(error ? { error } : { result }) }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }

  function publish(pkg, topic) {
    for (const socket of sockets) {
      for (const subscription of socket.subscriptions.values()) if (subscription.package === pkg && subscription.topics.includes(topic))
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  const snapshot = {
    server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null),
    endpoints: { auth: "ws://fixture.invalid/websocket" },
  };
  const store = new StackStore(snapshot);
  try {
    store.start();
    await until(store, () => [...sockets].some((socket) => [...socket.subscriptions.values()].some((subscription) => subscription.package === "auth" && subscription.topics.includes("worker_login_changed"))));

    const started = await store.call("auth", "worker_account_login_start", { provider: "codex" });
    assert.equal(started.id, "wlog-1");
    assert.equal(store.getState().workerAttempts["worker-1"]?.status, "pending");

    logins = [attempt];
    publish("auth", "worker_login_changed");
    await until(store, () => store.getState().workerLogins.data?.length === 1);
    assert.equal(store.getState().workerAttempts["worker-1"]?.id, "wlog-1");

    // The attempt left the pending list; status resolves it to a terminal state.
    logins = [];
    statusResult = { ...attempt, status: "complete", authUrl: null, userCode: null };
    publish("auth", "worker_login_changed");
    await until(store, () => store.getState().workerAttempts["worker-1"]?.status === "complete");

    store.dismissWorkerAttempt("worker-1");
    assert.equal(store.getState().workerAttempts["worker-1"], undefined);

    // A pending attempt unknown to the server is dropped.
    logins = [attempt];
    publish("auth", "worker_login_changed");
    await until(store, () => store.getState().workerAttempts["worker-1"]?.id === "wlog-1");
    logins = [];
    statusResult = null;
    publish("auth", "worker_login_changed");
    await until(store, () => store.getState().workerAttempts["worker-1"] === undefined && store.getState().workerLogins.at > 1);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});
