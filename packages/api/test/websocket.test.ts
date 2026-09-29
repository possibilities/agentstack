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
import { operatorHeaders, withLocalAuth } from "../src/local-auth.js";

type Frame = { id?: number; result?: any; error?: { message: string }; method?: string; params?: { topic: string } };

const credentials = new Map<string, NodeJS.ProcessEnv>();
function connect(url: string, origin?: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const env = credentials.get(url);
    let protocols: string[] = [];
    if (env && origin && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      protocols = [withLocalAuth(env, auth => `agentstack-local.${auth.ticket(auth.redeem(auth.bootstrap(origin, "uix"), origin, "uix").token, origin)}`)];
    }
    const ws = new WebSocket(url, protocols, { ...(origin ? { origin } : {}), headers: { ...(!origin && env ? operatorHeaders(env) : {}), ...headers } });
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

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentstack-ws-"));
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  description: WebSocket.\n  operations: all\n  events: all\n");
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root, AGENTSTACK_WEBSOCKET_PORT: "0", AGENTSTACK_UIX_PORT: "8745", AGENTSTACK_WEBSOCKET_ORIGIN: undefined, ...overrides };
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
  credentials.set(served.url, env);
  return { root, env, socket, served, url: served.url, async close() { credentials.delete(served.url); await served.close(); await socket.close(); await rm(root, { recursive: true, force: true }); } };
}

test("one WebSocket routes operations and scoped subscriptions to socket owners", async () => {
  const setup = await fixture();
  const ws = await connect(setup.url);
  const other = await connect(setup.url);
  try {
    assert.match(setup.url, /^ws:\/\/127\.0\.0\.1:\d+\/websocket$/);
    ws.send(JSON.stringify({ id: 1, method: "tools/list", params: { package: "demo" } }));
    assert.deepEqual((await nextMessage(ws)).result.tools.map((tool: { name: string }) => tool.name), ["greet"]);
    ws.send(JSON.stringify({ id: 2, method: "tools/call", params: { package: "demo", name: "greet", arguments: { name: "Ada" } } }));
    assert.deepEqual(await nextMessage(ws), { id: 2, result: { greeting: "Hello Ada" } });
    ws.send(JSON.stringify({ id: 3, method: "tools/call", params: { package: "demo", name: "greet", arguments: { bad: true } } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /name|unrecognized/i);
    ws.send(JSON.stringify({ id: 4, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bad" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /invalid event scope/);
    ws.send(JSON.stringify({ id: 5, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"] } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /needs a scope/);
    ws.send(JSON.stringify({ id: 6, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } }));
    assert.deepEqual(await nextMessage(ws), { id: 6, result: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } });
    ws.send(JSON.stringify({ id: 7, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bad" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /invalid event scope/);
    setup.socket.publish?.("changed", "bot-other");
    await assert.rejects(nextMessage(ws, 100), /no frame/);
    const notice = nextMessage(ws);
    setup.socket.publish?.("changed", "bot-1");
    assert.deepEqual(await notice, { method: "events/changed", params: { package: "demo", subscription: "watch", topic: "changed" } });
    const secondNotice = nextMessage(ws);
    setup.socket.publish?.("changed", "bot-1");
    assert.deepEqual(await secondNotice, { method: "events/changed", params: { package: "demo", subscription: "watch", topic: "changed" } });
    await assert.rejects(nextMessage(other, 100), /no frame/);
  } finally {
    ws.close(); other.close(); await setup.close();
  }
});

test("one package-addressed connection calls and watches multiple Package APIs independently", async () => {
  const setup = await fixture();
  const betaDir = join(setup.root, "packages", "beta");
  await mkdir(betaDir);
  await writeFile(join(betaDir, "api.yaml"), "name: beta\ndescription: Beta.\nsocket:\n  description: Socket.\nwebsocket:\n  description: WebSocket.\n  operations: [ping]\n  events: all\n");
  const beta = await serveSocket({
    info: { name: "beta", description: "Beta.", transportDescription: "Socket.", path: socketPath("beta", setup.env) },
    context: {},
    operations: [
      operation({ name: "ping", description: "Ping.", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), async call() { return { ok: true }; } }),
      operation({ name: "hidden", description: "Hidden.", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), async call() { return { ok: true }; } }),
    ],
    events: { topics: { changed: "A change." } },
  });
  const ws = await connect(setup.url);
  try {
    ws.send(JSON.stringify({ id: 1, method: "tools/list", params: { package: "beta" } }));
    assert.deepEqual((await nextMessage(ws)).result.tools.map((tool: { name: string }) => tool.name), ["ping"]);
    ws.send(JSON.stringify({ id: 2, method: "tools/call", params: { package: "demo", name: "greet", arguments: { name: "Ada" } } }));
    assert.deepEqual(await nextMessage(ws), { id: 2, result: { greeting: "Hello Ada" } });
    ws.send(JSON.stringify({ id: 3, method: "tools/call", params: { package: "beta", name: "ping", arguments: {} } }));
    assert.deepEqual(await nextMessage(ws), { id: 3, result: { ok: true } });
    ws.send(JSON.stringify({ id: 4, method: "tools/call", params: { package: "beta", name: "hidden", arguments: {} } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /not available over websocket/);
    ws.send(JSON.stringify({ id: 5, method: "tools/call", params: { package: "absent", name: "ping", arguments: {} } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /package absent is not available/);
    ws.send(JSON.stringify({ id: 6, method: "tools/call", params: { name: "ping", arguments: {} } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /not available over websocket/);
    ws.send(JSON.stringify({ id: 11, method: "tools/call", params: { package: "beta", name: "ping", arguments: {}, resultFormat: "mcp" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /MCP result presentation is not available/);
    ws.send(JSON.stringify({ id: 12, method: "tools/call", params: { package: "beta", name: "ping", arguments: {}, invocation: { transport: "mcp", botId: "bot-1", instance: "forged", threadId: "main", sessionId: null } } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /invocation context is supplied only/);
    ws.send(JSON.stringify({ id: 7, method: "events/subscribe", params: { package: "demo", subscription: "bot", topics: ["changed"], scope: "bot-1" } }));
    assert.deepEqual(await nextMessage(ws), { id: 7, result: { package: "demo", subscription: "bot", topics: ["changed"], scope: "bot-1" } });
    ws.send(JSON.stringify({ id: 8, method: "events/subscribe", params: { package: "beta", subscription: "beta", topics: ["changed"] } }));
    assert.deepEqual(await nextMessage(ws), { id: 8, result: { package: "beta", subscription: "beta", topics: ["changed"] } });
    ws.send(JSON.stringify({ id: 9, method: "events/subscribe", params: { package: "beta", subscription: "bot", topics: ["changed"] } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /another package/);
    const demoNotice = nextMessage(ws);
    setup.socket.publish?.("changed", "bot-1");
    assert.deepEqual(await demoNotice, { method: "events/changed", params: { package: "demo", subscription: "bot", topic: "changed" } });
    const betaNotice = nextMessage(ws);
    beta.publish?.("changed");
    assert.deepEqual(await betaNotice, { method: "events/changed", params: { package: "beta", subscription: "beta", topic: "changed" } });
    ws.send(JSON.stringify({ id: 10, method: "events/unsubscribe", params: { package: "beta", subscription: "beta" } }));
    assert.deepEqual(await nextMessage(ws), { id: 10, result: { subscription: "beta" } });
    beta.publish?.("changed");
    await assert.rejects(nextMessage(ws, 100), /no frame/);
    const disconnected = nextMessage(ws);
    await setup.socket.close();
    assert.deepEqual(await disconnected, { method: "events/disconnected", params: { package: "demo", subscription: "bot" } });
  } finally { ws.close(); await beta.close(); await setup.close(); }
});

test("WebSocket restricts host, origin, paths, frames and cleans up on close", async () => {
  const setup = await fixture();
  const ws = await connect(setup.url);
  try {
    await assert.rejects(connect(`${setup.url}/demo`), /404|Unexpected server response/);
    await assert.rejects(connect(`${setup.url}/absent`), /404|Unexpected server response/);
    await assert.rejects(connect(setup.url, "https://evil.example"), /403|Unexpected server response/);
    for (const origin of ["http://localhost:1", "http://127.0.0.1:8778", "null", "ftp://localhost:8745", "http://localhost:8745/evil"]) {
      await assert.rejects(connect(setup.url, origin), /403/);
    }
    for (const origin of ["http://127.0.0.1:8745", "http://localhost:8745"]) {
      const browser = await connect(setup.url, origin);
      browser.close();
    }
    await assert.rejects(connect(setup.url, undefined, { Host: "evil.example" }), /403|Unexpected server response/);
    ws.send("not json");
    assert.match((await nextMessage(ws)).error?.message ?? "", /invalid json/);
    ws.send(JSON.stringify({ id: 2, method: "unknown", params: { package: "demo" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /unknown method/);
    ws.send(JSON.stringify({ id: 3, method: "tools/list" }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /package undefined is not available/);
    ws.send(JSON.stringify({ id: 4, method: "events/subscribe", params: { package: "demo", topics: ["changed"], scope: "bot-1" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /invalid subscription id/);
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

test("a WebSocket operation list denies direct calls as well as hiding names", async () => {
  const setup = await fixture();
  const ws = await connect(setup.url);
  let restricted: WebSocket | undefined;
  try {
    await writeFile(join(setup.root, "packages", "demo", "api.yaml"),
      "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  description: WebSocket.\n  operations: []\n  events: all\n");
    restricted = await connect(setup.url);
    restricted.send(JSON.stringify({ id: 1, method: "tools/list", params: { package: "demo" } }));
    assert.deepEqual((await nextMessage(restricted)).result.tools, []);
    restricted.send(JSON.stringify({ id: 2, method: "tools/call", params: { package: "demo", name: "greet", arguments: { name: "Ada" } } }));
    assert.match((await nextMessage(restricted)).error?.message ?? "", /not available over websocket/);
    ws.send(JSON.stringify({ id: 3, method: "tools/call", params: { package: "demo", name: "greet", arguments: { name: "Ada" } } }));
    assert.deepEqual((await nextMessage(ws)).result, { greeting: "Hello Ada" });
  } finally { ws.close(); restricted?.close(); await setup.close(); }
});

test("a lost socket subscription tells the WebSocket client to resnapshot after reconnecting", async () => {
  const setup = await fixture();
  const ws = await connect(setup.url);
  try {
    ws.send(JSON.stringify({ id: 1, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } }));
    assert.deepEqual(await nextMessage(ws), { id: 1, result: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } });
    const disconnected = nextMessage(ws);
    await setup.socket.close();
    assert.deepEqual(await disconnected, { method: "events/disconnected", params: { package: "demo", subscription: "watch" } });
    ws.send(JSON.stringify({ id: 2, method: "tools/list", params: { package: "demo" } }));
    assert.match((await nextMessage(ws)).error?.message ?? "", /ENOENT|connect/);
  } finally {
    ws.close();
    await setup.close();
  }
});

test("WebSocket event selection gates listing and subscription independently at handshake", async () => {
  const setup = await fixture();
  const existing = await connect(setup.url);
  const file = join(setup.root, "packages", "demo", "api.yaml");
  const configure = (operations: string, events: string) => writeFile(file,
    `name: demo\ndescription: Demo.\nwebsocket:\n  description: Selected.\n  operations: ${operations}\n  events: ${events}\n`);
  let restricted: WebSocket | undefined;
  try {
    await configure("all", "[]");
    restricted = await connect(setup.url);
    restricted.send(JSON.stringify({ id: 1, method: "tools/list", params: { package: "demo" } }));
    const listed = (await nextMessage(restricted)).result;
    assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name), ["greet"]);
    assert.equal(listed.events, null);
    restricted.send(JSON.stringify({ id: 2, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } }));
    assert.match((await nextMessage(restricted)).error?.message ?? "", /not available over websocket/);
    existing.send(JSON.stringify({ id: 3, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } }));
    assert.deepEqual((await nextMessage(existing)).result.topics, ["changed"]);
    restricted.close();
    await configure("[]", "[changed]");
    restricted = await connect(setup.url);
    restricted.send(JSON.stringify({ id: 4, method: "tools/list", params: { package: "demo" } }));
    const eventsOnly = (await nextMessage(restricted)).result;
    assert.deepEqual(eventsOnly.tools, []);
    assert.deepEqual(eventsOnly.events.topics, { changed: "A change." });
    for (const [ops, events] of [["[unknown]", "all"], ["all", "[unknown]"], ["all", "[changed, changed]"], ["[greet, greet]", "all"]]) {
      await configure(ops!, events!);
      await assert.rejects(connect(setup.url), /503/);
    }
  } finally { existing.close(); restricted?.close(); await setup.close(); }
});

test("WebSocket admits current configuration while existing connections keep working", async () => {
  const setup = await fixture();
  const existing = await connect(setup.url);
  const demoConfig = "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  description: WebSocket.\n  operations: all\n  events: all\n";
  const demoFile = join(setup.root, "packages", "demo", "api.yaml");
  let betaSocket: Awaited<ReturnType<typeof serveSocket>> | undefined;
  let beta: WebSocket | undefined;
  let restored: WebSocket | undefined;
  try {
    existing.send(JSON.stringify({ id: 1, method: "events/subscribe", params: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } }));
    assert.deepEqual(await nextMessage(existing), { id: 1, result: { package: "demo", subscription: "watch", topics: ["changed"], scope: "bot-1" } });
    await writeFile(demoFile, "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\n");
    await assert.rejects(connect(setup.url), /503|Unexpected server response/);
    const notice = nextMessage(existing);
    setup.socket.publish?.("changed", "bot-1");
    assert.deepEqual(await notice, { method: "events/changed", params: { package: "demo", subscription: "watch", topic: "changed" } });
    existing.send(JSON.stringify({ id: 2, method: "tools/list", params: { package: "demo" } }));
    assert.deepEqual((await nextMessage(existing)).result.tools.map((tool: { name: string }) => tool.name), ["greet"]);

    const betaDir = join(setup.root, "packages", "beta");
    await mkdir(betaDir);
    const betaFile = join(betaDir, "api.yaml");
    await writeFile(betaFile, "name: beta\ndescription: Beta.\nsocket:\n  description: Socket.\nwebsocket:\n  description: WebSocket.\n  operations: all\n  events: all\n");
    betaSocket = await serveSocket({
      info: { name: "beta", description: "Beta.", transportDescription: "Socket.", path: socketPath("beta", setup.env) },
      context: {},
      operations: [operation({ name: "ping", description: "Ping.", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), async call() { return { ok: true }; } })],
    });
    existing.send(JSON.stringify({ id: 3, method: "tools/call", params: { package: "beta", name: "ping", arguments: {} } }));
    assert.match((await nextMessage(existing)).error?.message ?? "", /not available over websocket/);
    beta = await connect(setup.url);
    beta.send(JSON.stringify({ id: 4, method: "tools/call", params: { package: "beta", name: "ping", arguments: {} } }));
    assert.deepEqual(await nextMessage(beta), { id: 4, result: { ok: true } });
    await writeFile(betaFile, "name: beta\ndescription: Beta.\nsocket:\n  description: Socket.\n");
    await assert.rejects(connect(setup.url), /503|Unexpected server response/);
    beta.send(JSON.stringify({ id: 5, method: "tools/call", params: { package: "beta", name: "ping", arguments: {} } }));
    assert.deepEqual(await nextMessage(beta), { id: 5, result: { ok: true } });

    await writeFile(demoFile, "name: [broken");
    await assert.rejects(connect(setup.url), /503|Unexpected server response/);
    await writeFile(demoFile, demoConfig);
    restored = await connect(setup.url);
  } finally {
    existing.close(); beta?.close(); restored?.close();
    await betaSocket?.close();
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

test("anonymous sockets, replayed tickets and revoked operator/browser connections are refused", async () => {
  const setup = await fixture();
  const origin = "http://127.0.0.1:8745";
  const raw = (protocols: string[] = [], headers: Record<string, string> = {}) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(setup.url, protocols, { headers });
    ws.once("open", () => resolve(ws)); ws.once("error", reject);
  });
  let native: WebSocket | undefined, browser: WebSocket | undefined;
  try {
    await assert.rejects(raw(), /403/);
    await assert.rejects(raw([], { origin }), /403/);
    const token = withLocalAuth(setup.env, auth => auth.redeem(auth.bootstrap(origin, "uix"), origin, "uix").token);
    const ticket = withLocalAuth(setup.env, auth => auth.ticket(token, origin));
    await assert.rejects(raw([`agentstack-local.${ticket}`], { origin: "http://localhost:8745" }), /403/);
    browser = await raw([`agentstack-local.${ticket}`], { origin });
    await assert.rejects(raw([`agentstack-local.${ticket}`], { origin }), /403/);
    const headers = operatorHeaders(setup.env);
    native = await raw([], headers);
    const closed = [native, browser].map(ws => new Promise<void>(resolve => ws.once("close", () => resolve())));
    withLocalAuth(setup.env, auth => auth.rotate());
    await Promise.all(closed);
    await assert.rejects(raw([], headers), /403/);
    assert.throws(() => withLocalAuth(setup.env, auth => auth.ticket(token, origin)));
  } finally { native?.terminate(); browser?.terminate(); await setup.close(); }
});

test("WebSocket explicit development origin replaces the default UI origins", async () => {
  const setup = await fixture({ AGENTSTACK_WEBSOCKET_ORIGIN: "http://localhost:3000" });
  try {
    await assert.rejects(connect(setup.url, "http://localhost:8745"), /403/);
    const browser = await connect(setup.url, "http://localhost:3000");
    browser.close();
  } finally { await setup.close(); }
});
