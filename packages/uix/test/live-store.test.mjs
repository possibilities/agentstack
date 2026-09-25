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
    account_list: () => ({ accounts: workerAccounts }),
    account_login_current: () => ({ login: null }),
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    subscription = null;

    constructor(url) {
      this.url = url;
      sockets.add(this);
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); });
    }

    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscription = params;
      const result = method === "events/subscribe" ? params : results[params.name]?.();
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result }) }));
    }

    close() {
      this.readyState = 3;
      sockets.delete(this);
      this.onclose?.();
    }
  }

  function publish(pkg, topic, scope) {
    for (const socket of sockets) {
      if (!socket.url.endsWith(`/${pkg}`) || !socket.subscription?.topics.includes(topic)) continue;
      if (socket.subscription.scope && socket.subscription.scope !== scope) continue;
      socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { topic } }) });
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  const snapshot = {
    owner: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), bots: resource([]), voice: resource(null), catalog: resource(null),
    endpoints: { bots: "ws://localhost/bots", auth: "ws://localhost/auth" },
  };
  const store = new StackStore(snapshot);
  let indexStore;
  try {
    store.start();
    await until(store, () => store.getState().bots.at > 1 && [...sockets].some((socket) =>
      socket.url.endsWith("/bots") && !socket.subscription?.scope && socket.subscription?.topics.includes("bots_changed")));

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
    publish("auth", "accounts_changed");
    await until(store, () => store.getState().workerAccounts.data?.[0]?.id === "worker-1");

    // A reconnect snapshots membership even when a change occurred while offline.
    [...sockets].find((socket) => socket.url.endsWith("/bots") && !socket.subscription?.scope).close();
    bots = [bot("bot-2"), bot("bot-3")];
    await until(store, () => store.getState().bots.data?.some((item) => item.id === "bot-3") &&
      store.getState().scoped["bot-3"]?.status === "open");

    store.stop();
    indexStore = new StackStore(snapshot);
    indexStore.start({ packages: ["owner", "bots"], scopedBots: false });
    await until(indexStore, () => indexStore.getState().bots.data?.length === 2);
    assert.equal(sockets.size, 1, "the index needs only its package-level bot connection");
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
