import assert from "node:assert/strict";
import test from "node:test";

const { Channel } = await import("../lib/stack/channel.ts");

test("late package and scoped channels share a socket, resnapshot, and unsubscribe independently", async () => {
  const original = globalThis.WebSocket;
  const sockets = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(raw) {
      const frame = JSON.parse(raw);
      this.sent.push(frame);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: frame.id, result: {} }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket;
  let first, second;
  try {
    const openings = [];
    const notices = [];
    first = new Channel("ws://localhost/websocket", "bots", {
      onOpen: () => openings.push("bots"), onNotice: (topic) => notices.push(`bots:${topic}`),
    }).subscribe(["bots_changed"], "bot-1").connect();
    await new Promise((resolve) => setImmediate(resolve));
    second = new Channel("ws://localhost/websocket", "auth", {
      onOpen: () => openings.push("auth"), onNotice: (topic) => notices.push(`auth:${topic}`),
    }).subscribe(["accounts_changed"]).connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    assert.deepEqual(openings, ["bots", "auth"]);
    const ws = sockets[0];
    const subscriptions = ws.sent.filter((frame) => frame.method === "events/subscribe");
    assert.deepEqual(subscriptions.map((frame) => frame.params.package), ["bots", "auth"]);
    const botId = subscriptions[0].params.subscription;
    const authId = subscriptions[1].params.subscription;
    ws.onmessage({ data: JSON.stringify({ method: "events/changed", params: { package: "auth", subscription: authId, topic: "accounts_changed" } }) });
    ws.onmessage({ data: JSON.stringify({ method: "events/changed", params: { package: "bots", subscription: botId, topic: "bots_changed" } }) });
    assert.deepEqual(notices, ["auth:accounts_changed", "bots:bots_changed"]);
    first.dispose();
    assert.equal(ws.readyState, Socket.OPEN);
    assert.ok(ws.sent.some((frame) => frame.method === "events/unsubscribe" && frame.params.subscription === botId));
    assert.deepEqual(await second.call("account_list"), {});
    second.dispose();
    assert.equal(ws.readyState, 3);
  } finally { first?.dispose(); second?.dispose(); globalThis.WebSocket = original; }
});
