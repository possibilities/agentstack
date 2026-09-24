import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import test from "node:test";
import { z } from "zod";
import { operation } from "../src/operation.js";
import { serveApi } from "../src/serve.js";
import { serveSocket, socketCall, socketSubscribe } from "../src/socket.js";

const topics = { ping_changed: "Fired when the fixture pings.", pong_changed: "Fired when the fixture pongs." };

async function serveEventsSocket(dir: string, extras: { operations?: boolean } = {}) {
  const path = join(dir, "events.sock");
  let publish: ((topic: string) => void) | undefined;
  const ping = operation({
    name: "ping",
    description: "Emit a ping change notice.",
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
    async call(ctx: { emit: (topic: string) => void }) {
      ctx.emit("ping_changed");
      return { done: true };
    },
  });
  const served = await serveSocket({
    info: { name: "demo", description: "Demo.", transportDescription: "Socket.", path },
    context: { emit: (topic: string) => publish?.(topic) },
    operations: extras.operations === false ? [] : [ping],
    events: { topics },
  });
  publish = served.publish;
  return { served, path };
}

test("socket events deliver change notices to subscribed connections only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-"));
  const { served, path } = await serveEventsSocket(dir);
  const received: string[] = [];
  const other: string[] = [];
  try {
    const subscription = await socketSubscribe(path, ["ping_changed"], (topic) => received.push(topic));
    const second = await socketSubscribe(path, ["pong_changed"], (topic) => other.push(topic));
    assert.deepEqual(subscription.topics, ["ping_changed"]);

    await socketCall(path, "tools/call", { name: "ping", arguments: {} });
    for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, ["ping_changed"]);
    assert.deepEqual(other, []);

    served.publish?.("pong_changed");
    for (let i = 0; i < 100 && other.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(other, ["pong_changed"]);
    assert.deepEqual(received, ["ping_changed"]);

    assert.throws(() => served.publish?.("missing"), /unknown topic/);
    await subscription.close();
    await second.close();
  } finally {
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("events/subscribe rejects unknown, duplicate, and empty topic sets atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-reject-"));
  const { served, path } = await serveEventsSocket(dir);
  try {
    await assert.rejects(socketCall(path, "events/subscribe", { topics: [] }), /non-empty/);
    await assert.rejects(socketCall(path, "events/subscribe", {}), /non-empty/);
    await assert.rejects(socketCall(path, "events/subscribe", { topics: "ping_changed" }), /non-empty/);
    await assert.rejects(socketCall(path, "events/subscribe", { topics: ["missing"] }), /unknown topic: missing/);
    await assert.rejects(socketCall(path, "events/subscribe", { topics: ["ping_changed", "missing"] }), /unknown topic: missing/);
    await assert.rejects(socketCall(path, "events/subscribe", { topics: ["ping_changed", "ping_changed"] }), /duplicate topic/);

    const connection = connect(path);
    const lines = lineReader(connection);
    await new Promise<void>((resolve, reject) => {
      connection.once("connect", resolve);
      connection.once("error", reject);
    });
    connection.write(`${JSON.stringify({ id: 1, method: "events/subscribe", params: { topics: ["ping_changed"] } })}\n`);
    assert.deepEqual(await lines.next(), { id: 1, result: { topics: ["ping_changed"] } });
    connection.write(`${JSON.stringify({ id: 2, method: "events/subscribe", params: { topics: ["missing"] } })}\n`);
    const rejected = (await lines.next()) as { id: number; error?: { message?: string } };
    assert.equal(rejected.id, 2);
    assert.match(rejected.error?.message ?? "", /unknown topic/);
    served.publish?.("ping_changed");
    assert.deepEqual(await lines.next(), { method: "events/changed", params: { topic: "ping_changed" } });
    connection.destroy();
  } finally {
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subscribed connection that stops reading is destroyed at the output bound", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-slow-"));
  const { served, path } = await serveEventsSocket(dir);
  try {
    const connection = connect(path);
    const lines = lineReader(connection);
    await new Promise<void>((resolve, reject) => {
      connection.once("connect", resolve);
      connection.once("error", reject);
    });
    connection.write(`${JSON.stringify({ id: 1, method: "events/subscribe", params: { topics: ["ping_changed"] } })}\n`);
    await lines.next();
    connection.pause();
    const closed = new Promise<void>((resolve) => connection.once("close", resolve));
    for (let i = 0; i < 200_000 && !connection.destroyed; i += 1) served.publish?.("ping_changed");
    connection.resume();
    await closed;
    assert.equal(connection.destroyed, true);
  } finally {
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("events/subscribe on an event-free socket fails and closing the connection unsubscribes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-none-"));
  const path = join(dir, "plain.sock");
  const served = await serveSocket({
    info: { name: "demo", description: "Demo.", transportDescription: "Socket.", path },
    context: {},
    operations: [],
  });
  try {
    assert.equal(served.publish, undefined);
    await assert.rejects(socketCall(path, "events/subscribe", { topics: ["ping_changed"] }), /does not serve events/);
    const listed = (await socketCall(path, "tools/list")) as { events: unknown };
    assert.equal(listed.events, null);
  } finally {
    await served.close();
  }

  const { served: events, path: eventsPath } = await serveEventsSocket(dir);
  try {
    const listed = (await socketCall(eventsPath, "tools/list")) as {
      events: { topics: Record<string, string>; subscribe: string } | null;
    };
    assert.equal(listed.events?.subscribe, "events/subscribe");
    assert.deepEqual(listed.events?.topics, topics);

    const raw = connect(eventsPath);
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    raw.write(`${JSON.stringify({ id: 9, method: "events/subscribe", params: { topics: ["ping_changed"] } })}\n`);
    await new Promise<void>((resolve, reject) => {
      raw.once("data", () => resolve());
      raw.once("error", reject);
    });
    raw.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.publish?.("ping_changed");
    events.publish?.("pong_changed");
  } finally {
    await events.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("socketSubscribe rejects bad topic sets and reports a server failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-client-"));
  const { served, path } = await serveEventsSocket(dir);
  try {
    await assert.rejects(socketSubscribe(path, [], () => undefined), /at least one topic/);
    await assert.rejects(socketSubscribe(path, ["ping_changed", "ping_changed"], () => undefined), /repeats a topic/);
    await assert.rejects(socketSubscribe(path, ["missing"], () => undefined), /unknown topic/);
    await assert.rejects(socketSubscribe(join(dir, "missing.sock"), ["ping_changed"], () => undefined, { timeoutMs: 500 }));
  } finally {
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subscription connection does not stall socket shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-close-"));
  const { served, path } = await serveEventsSocket(dir);
  const subscription = await socketSubscribe(path, ["ping_changed"], () => undefined);
  await Promise.race([
    served.close(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close hung")), 5_000)),
  ]);
  await rm(dir, { recursive: true, force: true });
});

test("an event-bearing package fails closed before its context is created on an incapable transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-events-gate-"));
  const dir = join(root, "packages", "demo");
  await mkdir(join(dir, "dist", "src"), { recursive: true });
  await writeFile(
    join(dir, "api.yaml"),
    "name: demo\ndescription: Demo operations.\nmcp:\n  description: MCP transport for demo operations.\n",
  );
  await writeFile(
    join(dir, "dist", "src", "index.js"),
    `export const api = {
      operations: [],
      events: { topics: { ping: "Fired." }, start() { throw new Error("context should never start"); } },
      async createContext() { throw new Error("context must not be created"); },
      async closeContext() {},
    };\n`,
  );
  try {
    await assert.rejects(serveApi({ name: "demo", transport: "mcp", root }), /agentstack mcp/);
    await assert.rejects(serveApi({ name: "demo", transport: "socket", root }), /does not configure socket/);
    await assert.rejects(serveApi({ name: "demo", transport: "websocket", root }), /does not configure websocket/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("socketSubscribe closes on post-ack malformed frames, odd notifications, and abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-stream-"));
  const servers: Array<{ close(): Promise<void> }> = [];
  const fake = async (act: (socket: Socket, request: unknown) => void) => {
    const path = join(dir, `fake-${servers.length}.sock`);
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => act(socket, JSON.parse(String(chunk).split("\n")[0] ?? "{}")));
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    return path;
  };
  try {
    const ackPath = await fake((socket) => {
      socket.write(`${JSON.stringify({ id: 1, result: { topics: ["ping_changed"] } })}\n`);
      socket.write("not-json\n");
    });
    const badFrames = await socketSubscribe(ackPath, ["ping_changed"], () => undefined);
    await badFrames.closed;

    const oddPath = await fake((socket) => {
      socket.write(`${JSON.stringify({ id: 1, result: { topics: ["ping_changed"] } })}\n`);
      socket.write(`${JSON.stringify({ method: "events/changed", params: { topic: "never_requested" } })}\n`);
    });
    const unexpected = await socketSubscribe(oddPath, ["ping_changed"], () => undefined);
    await unexpected.closed;

    const responsePath = await fake((socket) => {
      socket.write(`${JSON.stringify({ id: 1, result: { topics: ["ping_changed"] } })}\n`);
      socket.write(`${JSON.stringify({ id: 77, result: {} })}\n`);
    });
    const oddResponse = await socketSubscribe(responsePath, ["ping_changed"], () => undefined);
    await oddResponse.closed;

    const abortPath = await fake((socket) => {
      socket.write(`${JSON.stringify({ id: 1, result: { topics: ["ping_changed"] } })}\n`);
    });
    const controller = new AbortController();
    const abortable = await socketSubscribe(abortPath, ["ping_changed"], () => undefined, { signal: controller.signal });
    controller.abort();
    await abortable.closed;

    const goodPath = await fake((socket) => {
      socket.write(`${JSON.stringify({ id: 1, result: { topics: ["ping_changed"] } })}\n`);
      socket.write(`${JSON.stringify({ method: "events/changed", params: { topic: "ping_changed" } })}\n`);
      socket.write(`${JSON.stringify({ method: "events/changed", params: { topic: "ping_changed" } })}\n`);
    });
    const received: string[] = [];
    const good = await socketSubscribe(goodPath, ["ping_changed"], (topic) => received.push(topic));
    for (let i = 0; i < 100 && received.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, ["ping_changed", "ping_changed"]);
    await good.close();
  } finally {
    for (const server of servers) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("socketSubscribe rejects acknowledgements that do not match the requested topics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-events-ack-"));
  const servers: Array<{ close(): Promise<void> }> = [];
  const fake = async (response: unknown) => {
    const path = join(dir, `fake-${servers.length}.sock`);
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => socket.write(`${JSON.stringify(response)}\n`));
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    return path;
  };
  const ack = (granted: unknown) => ({ id: 1, result: { topics: granted } });
  try {
    await assert.rejects(socketSubscribe(await fake(ack(["other_changed"])), ["ping_changed"], () => undefined), /did not match/);
    await assert.rejects(socketSubscribe(await fake(ack(["ping_changed", "extra_changed"])), ["ping_changed"], () => undefined), /did not match/);
    await assert.rejects(socketSubscribe(await fake(ack(["ping_changed", "ping_changed"])), ["ping_changed"], () => undefined), /did not match/);
    await assert.rejects(
      socketSubscribe(await fake(ack(["ping_changed", "ping_changed"])), ["ping_changed", "pong_changed"], () => undefined),
      /did not match/,
    );
    await assert.rejects(socketSubscribe(await fake(ack("ping_changed")), ["ping_changed"], () => undefined), /did not match/);
    await assert.rejects(socketSubscribe(await fake(ack([])), ["ping_changed"], () => undefined), /did not match/);
    await assert.rejects(socketSubscribe(await fake({ id: 1, error: null }), ["ping_changed"], () => undefined), /subscribe failed/);
    await assert.rejects(socketSubscribe(await fake({ id: 1, error: { message: "denied" } }), ["ping_changed"], () => undefined), /denied/);
  } finally {
    for (const server of servers) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function lineReader(socket: Socket): { next(): Promise<unknown> } {
  socket.setEncoding("utf8");
  let buffered = "";
  const ready: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const waiter = waiting.shift();
      if (waiter) waiter(line);
      else ready.push(line);
      newline = buffered.indexOf("\n");
    }
  });
  return {
    next() {
      const line = ready.shift();
      if (line !== undefined) return Promise.resolve(JSON.parse(line));
      return new Promise((resolve) => waiting.push((next) => resolve(JSON.parse(next))));
    },
  };
}
