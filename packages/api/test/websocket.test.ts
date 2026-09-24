import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { operation } from "../src/operation.js";
import { serveSocket } from "../src/socket.js";
import { serveWebSocket } from "../src/websocket.js";
import { socketPath, websocketPort } from "../src/workspace.js";

type Frame = { id?: number; result?: any; error?: { message: string }; method?: string; params?: { topic: string } };

function connect(url: string, origin?: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { ...(origin ? { origin } : {}), ...(headers ? { headers } : {}) });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("no frame received")); }, timeoutMs);
    const receive = (raw: RawData) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as Frame);
    };
    ws.once("message", receive);
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentstack-ws-"));
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  description: WebSocket.\n");
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root, AGENTSTACK_WEBSOCKET_PORT: "0" };
  const socket = await serveSocket<{ allowed: string }>({
    info: { name: "demo", description: "Demo.", transportDescription: "Socket.", path: socketPath("demo", env) },
    context: { allowed: "bot-1" },
    operations: [operation({
      name: "greet", description: "Greet a user.", input: z.strictObject({ name: z.string() }), output: z.object({ greeting: z.string() }),
      async call(_ctx, input) { return { greeting: `Hello ${input.name}` }; },
    })],
    events: { topics: { changed: "A change." }, scope: { description: "Bot ID", example: "bot-1", required: true, valid: (ctx, scope) => scope === ctx.allowed } },
  });
  const served = await serveWebSocket({ root, env });
  return { root, env, socket, served, url: served.urls.demo!, async close() { await served.close(); await socket.close(); await rm(root, { recursive: true, force: true }); } };
}

test("one WebSocket routes operations and scoped subscriptions to socket owners", async () => {
  const setup = await fixture();
  const ws = await connect(setup.url);
  const other = await connect(setup.url);
  try {
    assert.match(setup.url, /^ws:\/\/127\.0\.0\.1:\d+\/websocket\/demo$/);
    ws.send(JSON.stringify({ id: 1, method: "tools/list" }));
    assert.deepEqual((await nextMessage(ws)).result.tools.map((tool: { name: string }) => tool.name), ["greet"]);
    ws.send(JSON.stringify({ id: 2, method: "tools/call", params: { name: "greet", arguments: { name: "Ada" } } }));
    assert.deepEqual(await nextMessage(ws), { id: 2, result: { greeting: "Hello Ada" } });
    ws.send(JSON.stringify({ id: 3, method: "tools/call", params: { name: "greet", arguments: { bad: true } } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /name|unrecognized/i);
    ws.send(JSON.stringify({ id: 4, method: "events/subscribe", params: { topics: ["changed"], scope: "bad" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /invalid event scope/);
    ws.send(JSON.stringify({ id: 5, method: "events/subscribe", params: { topics: ["changed"] } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /needs a scope/);
    ws.send(JSON.stringify({ id: 6, method: "events/subscribe", params: { topics: ["changed"], scope: "bot-1" } }));
    assert.deepEqual(await nextMessage(ws), { id: 6, result: { topics: ["changed"], scope: "bot-1" } });
    ws.send(JSON.stringify({ id: 7, method: "events/subscribe", params: { topics: ["changed"], scope: "bad" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /invalid event scope/);
    setup.socket.publish?.("changed", "bot-other");
    await assert.rejects(nextMessage(ws, 100), /no frame/);
    const notice = nextMessage(ws);
    setup.socket.publish?.("changed", "bot-1");
    assert.deepEqual(await notice, { method: "events/changed", params: { topic: "changed" } });
    const secondNotice = nextMessage(ws);
    setup.socket.publish?.("changed", "bot-1");
    assert.deepEqual(await secondNotice, { method: "events/changed", params: { topic: "changed" } });
    await assert.rejects(nextMessage(other, 100), /no frame/);
  } finally {
    ws.close(); other.close(); await setup.close();
  }
});

test("WebSocket restricts host, origin, paths, frames and cleans up on close", async () => {
  const setup = await fixture();
  const ws = await connect(setup.url);
  try {
    await assert.rejects(connect(setup.url.replace("/demo", "/absent")), /404|Unexpected server response/);
    await assert.rejects(connect(setup.url, "https://evil.example"), /403|Unexpected server response/);
    await assert.rejects(connect(setup.url, undefined, { Host: "evil.example" }), /403|Unexpected server response/);
    ws.send("not json");
    assert.match((await nextMessage(ws)).error?.message ?? "", /invalid json/);
    ws.send(JSON.stringify({ id: 2, method: "unknown" }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /unknown method/);
    ws.send(Buffer.from([0, 1]));
    assert.match((await nextMessage(ws)).error?.message ?? "", /binary/);
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await setup.served.close();
    await closed;
    await assert.rejects(connect(setup.url));
  } finally {
    await setup.close();
  }
});

test("a lost socket subscription tells the WebSocket client to resnapshot after reconnecting", async () => {
  const setup = await fixture();
  const ws = await connect(setup.url);
  try {
    ws.send(JSON.stringify({ id: 1, method: "events/subscribe", params: { topics: ["changed"], scope: "bot-1" } }));
    assert.deepEqual(await nextMessage(ws), { id: 1, result: { topics: ["changed"], scope: "bot-1" } });
    const disconnected = nextMessage(ws);
    await setup.socket.close();
    assert.deepEqual(await disconnected, { method: "events/disconnected", params: {} });
    ws.send(JSON.stringify({ id: 2, method: "tools/list" }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /ENOENT|connect/);
  } finally {
    ws.close();
    await setup.close();
  }
});

test("WebSocket port configuration rejects invalid values", () => {
  assert.equal(websocketPort({}), 8744);
  assert.equal(websocketPort({ AGENTSTACK_WEBSOCKET_PORT: "0" }), 0);
  for (const value of ["", "-1", "65536", "123.5", "abc"]) {
    assert.throws(() => websocketPort({ AGENTSTACK_WEBSOCKET_PORT: value }), /AGENTSTACK_WEBSOCKET_PORT/);
  }
});
