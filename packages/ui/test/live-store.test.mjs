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

    workerAccounts = [{ id: "worker-1", provider: "devin", enabled: true, ready: true, removing: false }];
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

test("Role reads follow the selected Role: another Role's response never lands, a deleted Role is not read, and discovery rereads the internal list", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const role = (id, revision) => ({ id, name: `Role ${id}`, description: "", revision, createdAt: null, updatedAt: null });
  let catalog = { revision: 4, defaultRoleId: "A", workerDefaultRoleId: "B", roles: [role("A", 3), role("B", 1)] };
  const revisions = { A: 3, B: 1 };
  const calls = [];
  const gates = new Map();
  // A read that waits for its gate is computed when released, so it can answer with a revision from after the switch.
  const gated = (key, make) => gates.has(key) ? gates.get(key).promise.then(make) : make();
  const hold = (key) => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    gates.set(key, { promise, release });
    return () => { gates.delete(key); release(); };
  };
  const known = (roleId) => { if (!catalog.roles.some((item) => item.id === roleId)) throw new Error(`unknown role: ${roleId}`); };
  let failing = false;
  const results = {
    roles_snapshot: () => catalog,
    role_editor_snapshot: ({ roleId }) => { calls.push(`snapshot:${roleId}`); known(roleId);
      return gated(`snapshot:${roleId}`, () => {
        if (failing && roleId === "A") throw new Error("Role A could not be read");
        return { ...role(roleId, revisions[roleId]), categories: [], skills: [], mcpServers: [], trustedProjects: [], disabledInternalMcpServers: [] };
      }); },
    role_preview: ({ roleId }) => { known(roleId); return { roleId, revision: revisions[roleId], rendered: "", segments: [], bytes: 0, limitBytes: 262144 }; },
    role_launch_preview: ({ roleId }) => { known(roleId); return { roleId, revision: revisions[roleId], instructions: { bytes: 0, limitBytes: 1, fragments: 0 }, skills: [],
      internalMcpServers: [{ name: "bots", enabled: true }], mcpServers: [], config: "", trustedProjects: [], cwds: [], issues: [], snapshotChars: 0, snapshotLimitChars: 1 }; },
    role_internal_mcp_list: ({ roleId }) => { calls.push(`internal:${roleId}`); known(roleId);
      return gated(`internal:${roleId}`, () => ({ roleId, revision: revisions[roleId], servers: [{ name: "bots", enabled: true }] })); },
    docs_snapshot: () => { calls.push("docs"); return { packages: [] }; },
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
      const reply = (body) => queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...body }) }));
      if (method.startsWith("events/")) return reply({ result: params });
      try {
        Promise.resolve(results[params.name]?.(params.arguments)).then((result) => reply({ result }), (cause) => reply({ error: { message: cause.message } }));
      } catch (cause) {
        reply({ error: { message: cause instanceof Error ? cause.message : String(cause) } });
      }
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }

  const publish = (pkg, topic) => {
    for (const socket of sockets) {
      for (const subscription of socket.subscriptions.values()) {
        if (subscription.package === pkg && subscription.topics.includes(topic))
          socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
      }
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  globalThis.WebSocket = FakeWebSocket;
  const snapshot = {
    server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null), roleCatalog: resource(null),
    endpoints: { roles: "ws://roles-store.invalid/websocket", api: "ws://api-store.invalid/websocket" },
  };
  const store = new StackStore(snapshot);
  try {
    store.start();
    // Nothing Role-scoped is read until a Role is selected: there is no singleton read to fall back on.
    await until(store, () => store.getState().roleCatalog.data?.revision === 4);
    await settle();
    assert.deepEqual(calls.filter((call) => call.startsWith("snapshot:") || call.startsWith("internal:")), []);
    assert.equal(store.getState().roleId, null);

    store.selectRole("A");
    await until(store, () => store.getState().role.data?.id === "A" && store.getState().roleInternal.data?.roleId === "A" && store.getState().rolePreview.data?.roleId === "A" && store.getState().roleLaunch.data?.roleId === "A");

    // A's reads are in flight when the selection moves to B. Switching clears A's data at once and B's reads do not wait.
    const releaseSnapshot = hold("snapshot:A");
    const releaseInternal = hold("internal:A");
    publish("roles", "role_changed");
    await settle();
    const shown = [];
    const unsubscribe = store.subscribe(() => shown.push(store.getState().role.data?.id ?? null));
    store.selectRole("B");
    assert.equal(store.getState().role.data, null);
    assert.equal(store.getState().roleInternal.data, null);
    await until(store, () => store.getState().role.data?.id === "B" && store.getState().roleInternal.data?.roleId === "B");
    // A answers late, at a far higher revision than B has: it must not replace B.
    revisions.A = 99;
    releaseSnapshot();
    releaseInternal();
    await settle();
    unsubscribe();
    assert.equal(store.getState().role.data.id, "B");
    assert.equal(store.getState().role.data.revision, 1);
    assert.equal(store.getState().roleInternal.data.roleId, "B");
    assert.ok(!shown.includes("A"), "Role A's data is never shown under Role B");

    // A read of A that fails after the switch does not leave its error on B either.
    store.selectRole("A");
    await until(store, () => store.getState().role.data?.id === "A");
    const releaseFailing = hold("snapshot:A");
    publish("roles", "role_changed");
    await settle();
    store.selectRole("B");
    await until(store, () => store.getState().role.data?.id === "B");
    failing = true;
    releaseFailing();
    await settle();
    failing = false;
    assert.equal(store.getState().role.error, null);
    assert.equal(store.getState().role.data.id, "B");

    // A direct read of another Role is returned to its caller but not held; the same Role never rolls back.
    revisions.A = 120;
    assert.equal((await store.reloadRole("A")).revision, 120);
    assert.equal(store.getState().role.data.id, "B");
    revisions.B = 5;
    assert.equal((await store.reloadRole("B")).revision, 5);
    await until(store, () => store.getState().role.data.revision === 5 && store.getState().roleInternal.data?.revision === 5);
    revisions.B = 2;
    assert.equal((await store.reloadRole("B")).revision, 2);
    assert.equal((await store.reloadRoleInternal("B")).revision, 2);
    await settle();
    assert.equal(store.getState().role.data.revision, 5, "an older read of the same Role is dropped");
    assert.equal(store.getState().roleInternal.data.revision, 5);

    // A discovery refresh rereads the internal list, since manifest changes do not advance Role revisions.
    revisions.B = 6;
    const internalReads = calls.filter((call) => call === "internal:B").length;
    [...sockets].find((socket) => socket.url.startsWith("ws://api-store.invalid")).close();
    await until(store, () => calls.filter((call) => call === "internal:B").length > internalReads && store.getState().roleInternal.data?.revision === 6);

    // The selected Role is deleted elsewhere: its data is dropped at once and nothing more is read for it.
    catalog = { revision: 5, defaultRoleId: "A", workerDefaultRoleId: "A", roles: [role("A", 120)] };
    publish("roles", "role_changed");
    await until(store, () => store.getState().roleCatalog.data?.revision === 5 && store.getState().role.data === null);
    await settle();
    assert.equal(store.getState().roleId, "B", "the page decides what to select instead; the store never falls back on its own");
    assert.equal(store.getState().role.error, null);
    assert.equal(store.getState().roleLaunch.data, null);
    const reads = calls.length;
    publish("roles", "role_changed");
    await settle();
    assert.deepEqual(calls.slice(reads).filter((call) => call.endsWith(":B")), [], "a Role the catalog no longer lists is not read");

    store.selectRole("A");
    await until(store, () => store.getState().role.data?.id === "A" && store.getState().role.data.revision === 120);
    // A stale catalog never replaces a newer one.
    assert.equal(store.getState().roleCatalog.data.revision, 5);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("both previews read with the page's rendering context, and an answer for an earlier context never replaces a newer one", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const role = (id, revision) => ({ id, name: `Role ${id}`, description: "", revision, createdAt: null, updatedAt: null });
  const catalog = { revision: 1, defaultRoleId: "A", workerDefaultRoleId: "A", roles: [role("A", 3), role("B", 1)] };
  const revisions = { A: 3, B: 1 };
  const calls = [];
  const gates = new Map();
  const hold = (key) => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    gates.set(key, promise);
    return () => { gates.delete(key); release(); };
  };
  // Each answer names the context it was asked with, which the real API does not echo.
  const tag = (context) => JSON.stringify(context ?? null);
  const gated = (key, make) => gates.has(key) ? gates.get(key).then(make) : make();
  const results = {
    roles_snapshot: () => catalog,
    role_editor_snapshot: ({ roleId }) => ({ ...role(roleId, revisions[roleId]), categories: [], skills: [], mcpServers: [], trustedProjects: [], disabledInternalMcpServers: [] }),
    role_preview: (args) => { calls.push(["preview", args.roleId, tag(args.context), "context" in args]);
      return gated(`preview:${tag(args.context)}`, () => ({ roleId: args.roleId, revision: revisions[args.roleId], rendered: tag(args.context), segments: [], bytes: 0, limitBytes: 262144 })); },
    role_launch_preview: (args) => { calls.push(["launch", args.roleId, tag(args.context), "context" in args]);
      return gated(`launch:${tag(args.context)}`, () => ({ roleId: args.roleId, revision: revisions[args.roleId], instructions: { bytes: 0, limitBytes: 1, fragments: args.context ? 1 : 0 }, skills: [],
        internalMcpServers: [], mcpServers: [], config: tag(args.context), trustedProjects: [], cwds: [], issues: [], snapshotChars: 0, snapshotLimitChars: 1 })); },
    role_internal_mcp_list: ({ roleId }) => ({ roleId, revision: revisions[roleId], servers: [] }),
    docs_snapshot: () => ({ packages: [] }),
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
      const reply = (body) => queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...body }) }));
      if (method.startsWith("events/")) return reply({ result: params });
      Promise.resolve(results[params.name]?.(params.arguments)).then((result) => reply({ result }), (cause) => reply({ error: { message: cause.message } }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  const publish = (pkg, topic) => {
    for (const socket of sockets) for (const subscription of socket.subscriptions.values()) {
      if (subscription.package === pkg && subscription.topics.includes(topic))
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  globalThis.WebSocket = FakeWebSocket;
  const store = new StackStore({
    server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null), roleCatalog: resource(null),
    endpoints: { roles: "ws://roles-context.invalid/websocket" },
  });
  const shows = (context) => {
    const { rolePreview, roleLaunch, roleContextShown } = store.getState();
    return rolePreview.data?.rendered === context && roleLaunch.data?.config === context && roleContextShown.rolePreview === JSON.stringify(JSON.parse(context) ?? {}) && roleContextShown.roleLaunch === roleContextShown.rolePreview;
  };
  try {
    store.start();
    await until(store, () => store.getState().roleCatalog.data !== null);
    store.selectRole("A");
    // Without context the argument is omitted, as for a launch that supplies none.
    await until(store, () => shows("null"));
    assert.ok(calls.every(([, , , sent]) => !sent));

    store.setRoleContext({ model: "foo", harness: "" });
    const foo = JSON.stringify({ model: "foo" });
    await until(store, () => shows(foo));
    assert.deepEqual(store.getState().roleContext, { model: "foo" }, "empty values are not sent");
    assert.equal(store.getState().role.data.revision, 3, "a context change rereads only the previews");

    // foo's reads are still in flight when the context moves to bar; foo answers last, at a higher revision.
    const releasePreview = hold(`preview:${JSON.stringify({ model: "foo", harness: "codex" })}`);
    const releaseLaunch = hold(`launch:${JSON.stringify({ model: "foo", harness: "codex" })}`);
    store.setRoleContext({ model: "foo", harness: "codex" });
    await settle();
    const bar = JSON.stringify({ model: "bar" });
    store.setRoleContext({ model: "bar" });
    await until(store, () => shows(bar));
    revisions.A = 9;
    releasePreview();
    releaseLaunch();
    await settle();
    assert.ok(shows(bar), "an earlier context's answer is dropped even at a higher revision");

    // Saves and role_changed reread with the current context; so does another Role, which keeps the page's context.
    publish("roles", "role_changed");
    await until(store, () => store.getState().rolePreview.data?.revision === 9);
    assert.ok(shows(bar));
    store.selectRole("B");
    assert.equal(store.getState().rolePreview.data, null);
    await until(store, () => store.getState().rolePreview.data?.roleId === "B" && shows(bar));
    assert.ok(calls.filter(([, roleId]) => roleId === "B").every(([, , context]) => context === bar));

    // Clearing returns to the context-free preview.
    store.setRoleContext({});
    await until(store, () => shows("null"));
    assert.equal(calls.at(-1)[3], false);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("the launch preview reads with the page's capability harness, fenced like the rendering context", async () => {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const role = (id, revision) => ({ id, name: `Role ${id}`, description: "", revision, createdAt: null, updatedAt: null });
  const catalog = { revision: 1, defaultRoleId: "A", workerDefaultRoleId: "A", roles: [role("A", 3), role("B", 1)] };
  const revisions = { A: 3, B: 1 };
  const calls = [];
  const gates = new Map();
  const hold = (key) => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    gates.set(key, promise);
    return () => { gates.delete(key); release(); };
  };
  const gated = (key, make) => gates.has(key) ? gates.get(key).then(make) : make();
  // The launch read echoes the harness it was asked with and tags its config, which the real API's
  // response does too (`harness` is echoed; the config reflects the selection).
  const results = {
    roles_snapshot: () => catalog,
    role_editor_snapshot: ({ roleId }) => ({ ...role(roleId, revisions[roleId]), categories: [], skills: [], mcpServers: [], trustedProjects: [], disabledInternalMcpServers: [] }),
    role_preview: (args) => { calls.push(["preview", args]); return { roleId: args.roleId, revision: revisions[args.roleId], rendered: "", segments: [], bytes: 0, limitBytes: 262144 }; },
    role_launch_preview: (args) => { calls.push(["launch", args]);
      return gated(`launch:${args.roleId}:${args.harness ?? "any"}`, () => ({ roleId: args.roleId, revision: revisions[args.roleId], harness: args.harness ?? null,
        instructions: { bytes: 0, limitBytes: 1, fragments: 0 }, skills: [], internalMcpServers: [], mcpServers: [], excludedCapabilities: [],
        config: `config:${args.harness ?? "any"}`, trustedProjects: [], cwds: [], issues: [], snapshotChars: 0, snapshotLimitChars: 1 })); },
    role_internal_mcp_list: (args) => { calls.push(["internal", args]); return { roleId: args.roleId, revision: revisions[args.roleId], servers: [] }; },
    docs_snapshot: () => ({ packages: [] }),
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
      const reply = (body) => queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...body }) }));
      if (method.startsWith("events/")) return reply({ result: params });
      Promise.resolve(results[params.name]?.(params.arguments)).then((result) => reply({ result }), (cause) => reply({ error: { message: cause.message } }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  const publish = (pkg, topic) => {
    for (const socket of sockets) for (const subscription of socket.subscriptions.values()) {
      if (subscription.package === pkg && subscription.topics.includes(topic))
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const launches = () => calls.filter(([kind]) => kind === "launch").map(([, args]) => args);
  const previews = () => calls.filter(([kind]) => kind === "preview");
  const internals = () => calls.filter(([kind]) => kind === "internal");
  const shown = () => store.getState().roleLaunch.data?.config;

  globalThis.WebSocket = FakeWebSocket;
  const store = new StackStore({
    server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null), roleCatalog: resource(null),
    endpoints: { roles: "ws://roles-harness.invalid/websocket" },
  });
  try {
    store.start();
    await until(store, () => store.getState().roleCatalog.data !== null);
    store.selectRole("A");
    // An unspecified harness omits the argument entirely, as a launch without one does.
    await until(store, () => shown() === "config:any" && store.getState().roleLaunch.data?.harness === null);
    assert.ok(launches().every((args) => !("harness" in args)), "unspecified sends no harness");
    assert.ok(internals().every(([, args]) => !("harness" in args)), "the internal list never takes a harness");

    // Selecting a harness rereads only the launch preview; its read is held while the harness moves on.
    const releaseCodex = hold("launch:A:codex");
    const previewCalls = previews().length;
    const internalCalls = internals().length;
    store.setRoleHarness("codex");
    await until(store, () => launches().some((args) => args.harness === "codex"));
    assert.equal(previews().length, previewCalls, "rolePreview is not reread for a harness change");
    assert.equal(internals().length, internalCalls, "roleInternal is not reread for a harness change");
    assert.equal(store.getState().roleHarness, "codex");

    // Claude's read lands; codex's late answer at a higher revision is still dropped.
    store.setRoleHarness("claude");
    await until(store, () => shown() === "config:claude" && store.getState().roleLaunch.data?.harness === "claude");
    revisions.A = 9;
    releaseCodex();
    await settle();
    assert.equal(shown(), "config:claude", "an earlier harness's answer never replaces a newer one");
    assert.equal(store.getState().roleLaunch.data?.harness, "claude");
    assert.equal(store.getState().roleLaunch.data?.revision, 3, "the higher-revision stale read did not land");

    // role_changed rereads with the harness the page holds now.
    revisions.A = 10;
    const before = launches().length;
    publish("roles", "role_changed");
    await until(store, () => launches().length > before && launches().at(-1).harness === "claude" && store.getState().roleLaunch.data?.revision === 10);

    // Another Role keeps the page's harness.
    store.selectRole("B");
    assert.equal(store.getState().roleLaunch.data, null);
    await until(store, () => store.getState().roleLaunch.data?.roleId === "B");
    assert.equal(store.getState().roleHarness, "claude", "the harness is page-held, not per-Role");
    assert.ok(launches().filter((args) => args.roleId === "B").every((args) => args.harness === "claude"));

    // The rendering context rides along independently: both arguments, no interaction.
    store.setRoleContext({ model: "foo" });
    await until(store, () => launches().at(-1).context?.model === "foo" && previews().at(-1)[1].context?.model === "foo");
    const lastLaunch = launches().at(-1);
    assert.equal(lastLaunch.harness, "claude", "a context change keeps the harness argument");
    assert.ok(!("harness" in previews().at(-1)[1]), "role_preview never receives a harness");

    // Back to unspecified: the argument is omitted again.
    store.setRoleHarness(null);
    await until(store, () => shown() === "config:any" && store.getState().roleLaunch.data?.roleId === "B" && store.getState().roleLaunch.data?.harness === null);
    assert.ok(!("harness" in launches().at(-1)));
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("hud subscribes before its first read, resnapshots after reconnecting, and scopes item notices", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  // The real HUD store answers reads, so tree and snapshot semantics are the API's own.
  const { HudStore } = await import("../../hud/dist/src/store.js");
  const { change } = await import("../../hud/dist/src/schema.js");
  const root = mkdtempSync(join(tmpdir(), "stack-ui-hud-live-"));
  const hud = new HudStore(root);
  const create = (title) => { const id = randomUUID(); hud.apply(randomUUID(), [change.parse({ action: "create", id, title, objective: title })], { kind: "operator" }); return id; };
  const first = create("First");
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const trace = [];
  const results = { work_tree: (args) => hud.tree(args), worker_list: () => ({ workers: [] }), worker_runtime_list: () => ({ runtimes: [] }) };

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
      if (params?.package === "hud") trace.push(method === "tools/call" ? params.name : `${method}:${params.topics?.join(",") ?? ""}`);
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
  const subscriptions = () => [...sockets].flatMap((socket) => [...socket.subscriptions.values()]);
  const publish = (pkg, topic, scope) => {
    for (const socket of sockets) for (const subscription of socket.subscriptions.values()) {
      if (subscription.package !== pkg || !subscription.topics.includes(topic) || subscription.scope && subscription.scope !== scope) continue;
      socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
    }
  };

  globalThis.WebSocket = FakeWebSocket;
  const snapshot = {
    server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null),
    endpoints: { hud: "ws://fixture.invalid/websocket", worker: "ws://fixture.invalid/websocket" },
  };
  const store = new StackStore(snapshot);
  try {
    store.start();
    await until(store, () => store.getState().hudTree.data?.rows.length === 1);
    assert.equal(trace[0], "events/subscribe:hud_changed", "the invalidation subscription precedes the first snapshot");
    assert.deepEqual(subscriptions().find((item) => item.package === "hud" && !item.scope).topics, ["hud_changed"]);

    const second = create("Second");
    const generation = store.getState().hudGeneration;
    publish("hud", "hud_changed");
    await until(store, () => store.getState().hudTree.data?.rows.length === 2);
    assert.ok(store.getState().hudGeneration > generation, "views re-read their own projections on the notice");

    // A change made while disconnected produces no notice; reconnecting resnapshots anyway.
    [...sockets][0].close();
    create("Made while offline");
    await until(store, () => store.getState().hudTree.data?.rows.length === 3);

    const release = store.watchWorkItem(first);
    await until(store, () => subscriptions().some((item) => item.package === "hud" && item.scope === first));
    assert.deepEqual(subscriptions().find((item) => item.scope === first).topics, ["work_changed"]);
    const seen = store.getState().hudItemGenerations[first] ?? 0;
    publish("hud", "work_changed", second);
    publish("hud", "work_changed", first);
    await until(store, () => (store.getState().hudItemGenerations[first] ?? 0) === seen + 1);
    assert.equal(store.getState().hudItemGenerations[second], undefined, "another item's notice doesn't reach this watcher");

    const resources = store.getState().hudResourceGeneration;
    publish("worker", "workers_changed");
    await until(store, () => store.getState().hudResourceGeneration > resources);

    release();
    assert.ok(!subscriptions().some((item) => item.scope === first), "the scoped subscription closes with its last watcher");
  } finally {
    store.stop();
    globalThis.WebSocket = original;
    hud.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A fake serve socket for developer mode: settings with real revision fences, releases refused while disabled,
 * a trace of serve subscriptions and calls in send order, and `hold(name)` to delay one answer computed at request time.
 */
function developerServe() {
  const sockets = new Set();
  const trace = [];
  const held = new Map();
  const server = {
    settings: { developerMode: false, revision: 0, updatedAt: null },
    releases: { checking: null, intervalMs: 21_600_000, timeoutMs: 15_000, maxResponseBytes: 262_144, lastAttemptAt: null, lastCompletedAt: null,
      nextCheckAt: null, cacheError: null, observations: [{ id: "codex", title: "Codex", sourceUrl: "https://registry.npmjs.org/@openai/codex/latest",
        packageName: "@openai/codex", channel: "npm-latest", version: "0.50.0", previousVersion: null, changedAt: null, lastAttemptAt: null, lastCompletedAt: null,
        lastSuccessAt: null, outcome: "succeeded", error: null, freshness: "fresh", staleReason: null }] },
    updates: [],
    admission: null,
  };
  const results = {
    serve_settings_read: () => ({ ...server.settings }),
    serve_settings_update: (args) => {
      server.updates.push(args);
      if (args.expectedRevision !== server.settings.revision) throw new Error("serve_settings_revision_conflict: read settings before retrying");
      if (args.developerMode !== server.settings.developerMode) server.settings = { developerMode: args.developerMode, revision: server.settings.revision + 1, updatedAt: new Date().toISOString() };
      return { ...server.settings };
    },
    serve_harness_releases: () => {
      if (!server.settings.developerMode) throw new Error("developer_mode_disabled");
      return structuredClone(server.releases);
    },
    serve_harness_releases_check: () => {
      if (!server.settings.developerMode) throw new Error("developer_mode_disabled");
      return server.admission;
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
      if (params?.package === "serve") trace.push(method === "tools/call" ? params.name : `${method}:${params.topics?.join(",") ?? ""}`);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      if (method === "events/unsubscribe") this.subscriptions.delete(params.subscription);
      let result, error;
      try {
        result = method.startsWith("events/") ? params : results[params.name]?.(params.arguments);
      } catch (cause) {
        error = { message: cause instanceof Error ? cause.message : String(cause) };
      }
      const gate = method === "tools/call" ? held.get(params.name) : undefined;
      held.delete(params?.name);
      void Promise.resolve(gate?.promise).then(() => this.onmessage?.({ data: JSON.stringify({ id, ...(error ? { error } : { result }) }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  return {
    server, trace, sockets, FakeWebSocket,
    subscriptions: () => [...sockets].flatMap((socket) => [...socket.subscriptions.values()]).filter((item) => item.package === "serve"),
    hold(name) { const gate = Promise.withResolvers(); held.set(name, gate); return gate.resolve; },
    publish(topic) {
      for (const socket of sockets) for (const subscription of socket.subscriptions.values()) {
        if (subscription.package !== "serve" || !subscription.topics.includes(topic)) continue;
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: "serve", subscription: subscription.subscription, topic } }) });
      }
    },
  };
}

const serveSnapshot = (extra = {}) => ({
  server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
  login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null),
  endpoints: { serve: "ws://fixture.invalid/websocket" }, ...extra,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const releaseTopic = (item) => item.topics.includes("harness_releases_changed");

test("developer mode gates release reads: disabled never reads them, enabling subscribes first, and a late reply after disabling is dropped", async () => {
  const fake = developerServe();
  const original = globalThis.WebSocket;
  globalThis.WebSocket = fake.FakeWebSocket;
  const store = new StackStore(serveSnapshot());
  const count = (name) => fake.trace.filter((entry) => entry === name).length;
  try {
    store.start({ packages: ["serve"], scopedBots: false });
    await until(store, () => store.getState().serveSettings.data !== null);
    assert.ok(fake.trace.findIndex((entry) => entry.startsWith("events/subscribe:") && entry.includes("serve_settings_changed")) < fake.trace.indexOf("serve_settings_read"),
      "the settings invalidation subscription precedes the settings snapshot");
    await settle();
    assert.equal(count("serve_harness_releases"), 0, "disabled settings never read releases");
    assert.ok(!fake.subscriptions().some(releaseTopic), "nor subscribe to their notices");
    assert.equal(store.getState().harnessReleases.data, null);

    // An explicit save at the read revision; the returned settings turn the feature on, subscription first.
    await store.saveServeSettings(true);
    assert.deepEqual(fake.server.updates, [{ developerMode: true, expectedRevision: 0 }]);
    await until(store, () => store.getState().harnessReleases.data !== null);
    const subscribed = fake.trace.findIndex((entry) => entry === "events/subscribe:harness_releases_changed");
    assert.ok(subscribed >= 0 && subscribed < fake.trace.indexOf("serve_harness_releases"), "subscribed before the first release snapshot");
    assert.equal(count("serve_harness_releases_check"), 0, "reading starts no check");

    // A release notice re-reads the cache.
    fake.server.releases.checking = { startedAt: new Date().toISOString() };
    fake.publish("harness_releases_changed");
    await until(store, () => store.getState().harnessReleases.data?.checking !== null);

    // A read answered while enabled lands only after another client disabled: it is dropped.
    const release = fake.hold("serve_harness_releases");
    const reads = count("serve_harness_releases");
    fake.publish("harness_releases_changed");
    await settle();
    assert.equal(count("serve_harness_releases"), reads + 1, "the held read was sent while enabled");
    fake.server.settings = { developerMode: false, revision: 2, updatedAt: new Date().toISOString() };
    fake.publish("serve_settings_changed");
    await until(store, () => store.getState().serveSettings.data?.developerMode === false);
    assert.equal(store.getState().harnessReleases.data, null, "disabling clears the feature at once");
    assert.ok(!fake.subscriptions().some(releaseTopic), "and drops its subscription");
    release();
    await settle();
    assert.equal(store.getState().harnessReleases.data, null, "the late answer did not restore old observations");
    assert.equal(store.getState().harnessReleases.error, null);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("a reconnect forgets settings and the feature, then reads settings again before any release data", async () => {
  const fake = developerServe();
  fake.server.settings = { developerMode: true, revision: 1, updatedAt: new Date().toISOString() };
  const original = globalThis.WebSocket;
  globalThis.WebSocket = fake.FakeWebSocket;
  const store = new StackStore(serveSnapshot());
  try {
    store.start({ packages: ["serve"], scopedBots: false });
    await until(store, () => store.getState().harnessReleases.data !== null);
    // A pending check is part of the feature too.
    const admit = fake.hold("serve_harness_releases_check");
    fake.server.admission = { admitted: true, startedAt: new Date().toISOString() };
    const checking = store.checkHarnessReleases();
    assert.equal(store.getState().harnessCheck?.pending, true);

    fake.trace.length = 0;
    [...fake.sockets][0].close();
    let state = store.getState();
    assert.equal(state.serveSettings.data, null, "settings from a closed connection are not authority");
    assert.equal(state.harnessReleases.data, null);
    assert.equal(state.harnessCheck, null, "a pending check is cleared, not left spinning");
    admit();
    await checking;
    assert.equal(store.getState().harnessCheck, null, "its late answer is dropped");

    await until(store, () => store.getState().harnessReleases.data !== null);
    assert.ok(fake.trace.indexOf("serve_settings_read") < fake.trace.indexOf("serve_harness_releases"), "settings are read before release data");
    state = store.getState();
    assert.equal(state.serveSettings.data?.developerMode, true);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("a stale-revision save is refused once and never retried; the current setting is re-read and shown", async () => {
  const fake = developerServe();
  const original = globalThis.WebSocket;
  globalThis.WebSocket = fake.FakeWebSocket;
  const store = new StackStore(serveSnapshot());
  try {
    store.start({ packages: ["serve"], scopedBots: false });
    await until(store, () => store.getState().serveSettings.data !== null);
    // Another client enables it without this page hearing yet.
    fake.server.settings = { developerMode: true, revision: 1, updatedAt: new Date().toISOString() };
    await assert.rejects(store.saveServeSettings(true), /serve_settings_revision_conflict/);
    await until(store, () => store.getState().serveSettings.data?.revision === 1);
    await settle();
    assert.deepEqual(fake.server.updates, [{ developerMode: true, expectedRevision: 0 }], "one attempt at the observed revision, no automatic retry");
    assert.equal(store.getState().serveSettings.data.developerMode, true, "the current value replaces the stale one");
    await until(store, () => store.getState().harnessReleases.data !== null);

    // Saving again is the person's choice, at the revision now shown.
    await store.saveServeSettings(false);
    assert.deepEqual(fake.server.updates.at(-1), { developerMode: false, expectedRevision: 1 });
    assert.equal(store.getState().harnessReleases.data, null);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("Check now follows admission to the event-driven read, and a refusal is never shown as a started check", async () => {
  const fake = developerServe();
  fake.server.settings = { developerMode: true, revision: 1, updatedAt: new Date().toISOString() };
  const original = globalThis.WebSocket;
  globalThis.WebSocket = fake.FakeWebSocket;
  const store = new StackStore(serveSnapshot());
  try {
    store.start({ packages: ["serve"], scopedBots: false });
    await until(store, () => store.getState().harnessReleases.data !== null);
    const startedAt = new Date().toISOString();
    fake.server.admission = { admitted: false, startedAt };
    fake.server.releases.checking = { startedAt };
    await store.checkHarnessReleases();
    assert.deepEqual(store.getState().harnessCheck, { pending: false, admitted: false, startedAt, error: null }, "joined the running check");
    await until(store, () => store.getState().harnessReleases.data?.checking?.startedAt === startedAt);
    assert.ok(store.getState().harnessCheck, "admission is not completion");

    fake.server.releases = { ...fake.server.releases, checking: null, lastCompletedAt: new Date(Date.parse(startedAt) + 1_000).toISOString() };
    fake.publish("harness_releases_changed");
    await until(store, () => store.getState().harnessCheck === null);

    // Disabled elsewhere before this page heard: the refusal stays a refusal, and settings are re-read.
    fake.server.settings = { developerMode: false, revision: 2, updatedAt: new Date().toISOString() };
    const release = fake.hold("serve_settings_read");
    await store.checkHarnessReleases();
    assert.equal(store.getState().harnessCheck?.error, "developer_mode_disabled");
    assert.equal(store.getState().harnessCheck?.startedAt, null);
    release();
    await until(store, () => store.getState().serveSettings.data?.developerMode === false);
    assert.equal(store.getState().harnessCheck, null);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("a remote page never reads global settings or subscribes to their notices", async () => {
  const fake = developerServe();
  const original = globalThis.WebSocket;
  globalThis.WebSocket = fake.FakeWebSocket;
  const store = new StackStore(serveSnapshot({ remote: { scope: "control", scopes: ["ui:view", "ui:control"], contentOrigins: {} } }));
  try {
    store.start({ packages: ["serve"], scopedBots: false });
    await until(store, () => fake.subscriptions().length > 0);
    await settle();
    assert.ok(!fake.trace.some((entry) => /serve_settings|harness_releases/.test(entry)), fake.trace.join("\n"));
    await assert.rejects(store.saveServeSettings(true), /not loaded/);
    assert.deepEqual(fake.server.updates, []);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});
