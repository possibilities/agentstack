import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, serveWebSocket, socketCall, socketPath } from "@agentstack/api";
import { gatewayRoot } from "./browser-fixture.mjs";

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
const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const empty = { data: null, error: null, at: null };

async function until(store, condition) {
  if (condition(store.getState())) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("store did not update")); }, 3_000);
    const unsubscribe = store.subscribe(() => {
      if (!condition(store.getState())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

test("the Inbox store pages, filters, follows notify_changed and applies dismissals from the real notify API", async () => {
  // Unix socket paths are short; keep the state directory near the root of the temporary tree.
  const dir = await mkdtemp(join("/tmp", "as-notify-store-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: dir };
  const notify = await serveApi({ name: "notify", transport: "socket", env, root });
  const websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["notify"]), port: 0 });
  const call = (name, args = {}) => socketCall(socketPath("notify", env), "tools/call", { name, arguments: args });
  const store = new StackStore({ owner: empty, resources: empty, accounts: empty, workerAccounts: empty, workerRuntimes: empty, workerSessions: empty,
    usage: empty, login: empty, workerLogins: empty, bots: empty, botDefaults: empty, voice: empty, role: empty, rolePreview: empty, catalog: empty,
    endpoints: { notify: websocket.url } });
  try {
    const sent = [];
    for (let index = 0; index < 27; index += 1) sent.push(await call("notification_send", { title: `Notice ${index}`, message: "Body", source: index % 3 === 0 ? "ci" : "brain" }));
    store.start({ packages: ["notify"], scopedBots: false });

    // A first page of 25, the full open count, and every loaded record addressable by ID.
    await until(store, (state) => state.notifications.data?.entries.length === 25 && state.notifyCounts.data?.open === 27);
    let state = store.getState();
    assert.equal(state.notifications.data.entries[0].id, sent[26].id);
    assert.ok(state.notifications.data.nextCursor);
    assert.deepEqual(state.notifyCounts.data.sources.map((item) => [item.source, item.open]), [["brain", 18], ["ci", 9]]);
    assert.equal(state.notificationRecords[sent[26].id].title, "Notice 26");

    await store.loadOlderNotifications();
    state = store.getState();
    assert.equal(state.notifications.data.entries.length, 27);
    assert.equal(state.notifications.data.nextCursor, null);

    // An invalidation re-reads every loaded page, so older rows stay and the new one leads.
    const newest = await call("notification_send", { title: "Deploy?", message: "Ready", actions: ["Ship", "Hold"], source: "ci" });
    await until(store, (next) => next.notifications.data?.entries.length === 28);
    assert.equal(store.getState().notifications.data.entries[0].id, newest.id);

    // A source filter replaces the pages; a stale response for the old filter never lands.
    const filter = { dismissed: false, source: "ci" };
    store.setNotificationFilter(filter);
    await until(store, (next) => next.notifications.data?.filter === filter);
    assert.deepEqual(store.getState().notifications.data.entries.map((item) => item.source), Array(10).fill("ci"));

    // Answering dismisses once: the record, the open list and the counts all follow.
    const answered = await store.notify("notification_dismiss", { id: newest.id, outcome: "action", response: "Ship" });
    assert.deepEqual([answered.outcome, answered.response], ["action", "Ship"]);
    assert.equal(store.getState().notificationRecords[newest.id].outcome, "action");
    await until(store, (next) => next.notifications.data?.filter === filter && next.notifications.data.entries.length === 9 && next.notifyCounts.data?.open === 27);
    await assert.rejects(store.notify("notification_dismiss", { id: newest.id }), /notification_already_dismissed/);

    // A watched record stays fresh even though the loaded filter no longer lists it.
    const unwatch = store.watchNotification(sent[1].id);
    await call("notification_dismiss", { id: sent[1].id, outcome: "opened" });
    await until(store, (next) => next.notificationRecords[sent[1].id]?.outcome === "opened");
    unwatch();

    const { dismissed } = await store.notify("notification_dismiss_all", {});
    assert.equal(dismissed, 26);
    await until(store, (next) => next.notifyCounts.data?.open === 0 && next.notifications.data?.entries.length === 0);
  } finally {
    store.stop();
    await websocket.close();
    await notify.close();
    await rm(dir, { recursive: true, force: true });
  }
});
