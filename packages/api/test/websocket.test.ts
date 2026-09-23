import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { serveWebSocket } from "../src/websocket.js";

type Frame = { type?: string; topic?: string; message?: string };

function connect(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : undefined);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame received")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as Frame);
    });
  });
}

test("websocket pubsub serves subscribe, events, and unsubscribe", async () => {
  let stopSource = 0;
  const served = await serveWebSocket({
    topics: { pids_changed: "Fired when pids change." },
    subscribe(publish) {
      publish("pids_changed");
      return () => {
        stopSource += 1;
      };
    },
  });
  const ws = await connect(served.url);
  try {
    assert.match(served.url, /^ws:\/\/127\.0\.0\.1:\d+$/);

    ws.send(JSON.stringify({ type: "subscribe", topic: "pids_changed" }));
    assert.deepEqual(await nextMessage(ws), { type: "subscribed", topic: "pids_changed" });

    served.publish("pids_changed");
    assert.deepEqual(await nextMessage(ws), { type: "event", topic: "pids_changed" });

    ws.send(JSON.stringify({ type: "unsubscribe", topic: "pids_changed" }));
    assert.deepEqual(await nextMessage(ws), { type: "unsubscribed", topic: "pids_changed" });

    served.publish("pids_changed");
    await assert.rejects(nextMessage(ws, 300), /no frame/);

    assert.throws(() => served.publish("nope"), /unknown topic/);
  } finally {
    ws.close();
    await served.close();
  }
  assert.equal(stopSource, 1);
  await served.close();
});

test("websocket rejects unknown topics, bad frames, and oversized payloads", async () => {
  const served = await serveWebSocket({
    topics: { ping: "Fired." },
    maxPayload: 64,
  });
  const ws = await connect(served.url);
  try {
    ws.send(JSON.stringify({ type: "subscribe", topic: "missing" }));
    assert.match((await nextMessage(ws)).message ?? "", /unknown topic/);

    ws.send("not json");
    assert.match((await nextMessage(ws)).message ?? "", /invalid json/);

    ws.send("null");
    assert.match((await nextMessage(ws)).message ?? "", /invalid frame/);

    ws.send("[]");
    assert.match((await nextMessage(ws)).message ?? "", /invalid frame/);

    ws.send("5");
    assert.match((await nextMessage(ws)).message ?? "", /invalid frame/);

    ws.send(JSON.stringify({ type: "explode" }));
    assert.match((await nextMessage(ws)).message ?? "", /unknown message type/);

    ws.send(JSON.stringify({ type: "subscribe", topic: "ping" }));
    assert.deepEqual(await nextMessage(ws), { type: "subscribed", topic: "ping" });

    ws.send(JSON.stringify({ type: "unsubscribe", topic: "ping" }) + "x".repeat(128));
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  } finally {
    await served.close();
  }
});

test("websocket rejects unexpected browser origins", async () => {
  const open = await serveWebSocket({ topics: { ping: "Fired." } });
  try {
    const loopback = await connect(open.url, "http://127.0.0.1:3000");
    loopback.close();
    const localhost = await connect(open.url, "http://localhost:3000");
    localhost.close();
    await assert.rejects(connect(open.url, "https://evil.example"), /403|Unexpected server response/);
  } finally {
    await open.close();
  }

  const pinned = await serveWebSocket({ topics: { ping: "Fired." }, origin: "http://127.0.0.1:3000" });
  try {
    const allowed = await connect(pinned.url, "http://127.0.0.1:3000");
    allowed.close();
    const noOrigin = await connect(pinned.url);
    noOrigin.close();
    await assert.rejects(connect(pinned.url, "http://127.0.0.1:9999"), /403|Unexpected server response/);
    await assert.rejects(connect(pinned.url, "https://evil.example"), /403|Unexpected server response/);
  } finally {
    await pinned.close();
  }
});

test("websocket close drops every client and stops listening", async () => {
  const served = await serveWebSocket({ topics: { ping: "Fired." } });
  const ws = await connect(served.url);
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  await served.close();
  await closed;
  await assert.rejects(connect(served.url));
});

test("websocket source rejection closes listeners and the port", async () => {
  let client: WebSocket | undefined;
  const attempt = serveWebSocket({
    topics: { ping: "Fired." },
    async subscribe(_publish, info) {
      client = await connect(info.url);
      throw new Error("source failed");
    },
  });
  await assert.rejects(attempt, /source failed/);
  assert.ok(client);
  const ws = client;
  await new Promise<void>((resolve) => {
    if (ws.readyState === ws.CLOSED) resolve();
    else ws.once("close", () => resolve());
  });
  await assert.rejects(connect(ws.url));
});

test("websocket close releases listeners when unsubscribe throws", async () => {
  const served = await serveWebSocket({
    topics: { ping: "Fired." },
    subscribe() {
      return () => {
        throw new Error("unsubscribe failed");
      };
    },
  });
  const ws = await connect(served.url);
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  await assert.rejects(served.close(), /unsubscribe failed/);
  await closed;
  await assert.rejects(connect(served.url));
});
