import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTION_KEY as CONFIG_KEY } from "../connection.js";
import { HISTORY_KEY } from "../history.js";
import { OUTBOX_KEY } from "../outbox.js";

test("the service worker persists before transport and binds admission/history to its destination", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = new Map();
  const messages = [];
  const notifications = [];
  const listeners = () => ({ addListener() {} });
  let optionsOpened = 0;
  let requests = 0;
  let reply = { ok: true, data: { status: "queued", job_id: 7 } };
  globalThis.chrome = {
    storage: { local: {
      async get(defaults) { return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, structuredClone(storage.get(key) ?? fallback)])); },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value)); },
    } },
    runtime: {
      id: "test-extension", getURL: path => `chrome-extension://test-extension/${path}`,
      onInstalled: listeners(), onStartup: listeners(),
      onMessage: { addListener(listener) { messages.push(listener); } },
      async openOptionsPage() { optionsOpened++; },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    alarms: { onAlarm: listeners(), async create() {}, async clear() {} },
    commands: { onCommand: listeners() },
    contextMenus: { onClicked: listeners() },
    notifications: { async create(notification) { notifications.push(notification); } },
    permissions: { async contains() { return true; } },
    tabs: { async query() { return [{ url: "https://example.com/article", title: "Test article" }]; } },
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/v1/access/identity")) return Response.json({ ok: true, data: { serverId: "instance-one" } });
    requests++;
    assert.equal(url, "https://first.example/v1/share");
    assert.equal(options.headers["X-AgentStack-Server-ID"], "instance-one");
    assert.ok(storage.get(OUTBOX_KEY).length > 0, "the request must already be durable");
    if (reply === null) throw new TypeError("Synthetic offline state");
    return Response.json(reply);
  });
  await import("../background.js");
  assert.equal(messages[0]({ type: "agentstack.connection", action: "access" }, { id: chrome.runtime.id, url: chrome.runtime.getURL("options.html") }, () => { throw new Error("credential exposed"); }), false);
  assert.equal(messages[0]({ type: "agentstack.connection", action: "state" }, { id: chrome.runtime.id, url: "https://example.com" }, () => { throw new Error("webpage accepted"); }), false);
  const ask = (type) => new Promise((resolve) => {
    assert.equal(messages[0]({ type: `agentstack.${type}` }, { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }, resolve), true);
  });

  await ask("share-current-page");
  assert.equal(requests, 0);
  assert.equal(optionsOpened, 1);
  assert.equal(storage.get(OUTBOX_KEY).length, 1);
  assert.equal(storage.get(HISTORY_KEY)[0].outcome, "held");

  const configured = serverUrl => ({ serverUrl, serverId: "instance-one", refreshToken: "synthetic-refresh", tokens: { brain: { accessToken: "synthetic-token", expiresAt: Date.now() + 300_000 } } });
  storage.set(CONFIG_KEY, configured("https://first.example"));
  const admitted = await ask("outbox-flush");
  assert.equal(admitted.delivered, 1);
  assert.equal(storage.get(OUTBOX_KEY).length, 0);
  assert.equal(storage.get(HISTORY_KEY)[0].job, 7);
  assert.equal(storage.get(HISTORY_KEY)[0].destination, "https://first.example#agentstack=instance-one");

  storage.set(CONFIG_KEY, configured("https://second.example"));
  await ask("history-refresh");
  assert.equal(requests, 1, "a job from the first server must never be queried on the second");

  storage.set(CONFIG_KEY, configured("https://first.example"));
  reply = null;
  await ask("share-current-page");
  assert.equal(storage.get(OUTBOX_KEY).length, 1);
  assert.equal(storage.get(HISTORY_KEY)[0].outcome, "held");
  await ask("outbox-clear");
  assert.equal(storage.get(OUTBOX_KEY).length, 0);
  assert.equal(storage.get(HISTORY_KEY)[0].outcome, "discarded");
  assert.ok(notifications.some((notice) => notice.title === "Held for later"));
});
