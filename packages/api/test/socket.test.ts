import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Server } from "node:net";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { operation } from "../src/operation.js";
import { serveSocket, socketCall } from "../src/socket.js";

test("scheduled invocation provenance crosses the socket and mismatched identities fail before the handler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "as-scheduled-wire-"));
  let calls = 0;
  const served = await serveSocket({ info: { name: "demo", description: "Demo", transportDescription: "Socket", path: join(dir, "demo.sock") }, context: {},
    operations: [operation({ name: "read", description: "Read", input: z.object({}), output: z.any(), async call(_ctx, _input, invocation) { calls++; return invocation; } })] });
  const invocation = { transport: "proc", authority: { kind: "bot", botId: "a", mainThreadId: "root", threadId: "child" },
    scheduleId: randomUUID(), executionId: randomUUID(), botId: "a", threadId: "child", instance: "current-launch", sessionId: null };
  const call = (value: object) => socketCall(served.path, "tools/call", { name: "read", arguments: {}, invocation: value });
  try {
    assert.deepEqual(await call(invocation), invocation);
    for (const bad of [{ ...invocation, botId: null }, { ...invocation, threadId: "foreign" }, { ...invocation, instance: null },
      { ...invocation, authority: { kind: "operator" } }, { ...invocation, workerId: "worker" }, { ...invocation, scheduleId: "invalid" }]) {
      await assert.rejects(call(bad));
    }
    assert.equal(calls, 1);
  } finally { await served.close(); await rm(dir, { recursive: true, force: true }); }
});

test("socket advertises and calls a typed operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-socket-"));
  const path = join(dir, "demo.sock");
  const ping = operation({
    name: "ping",
    description: "Reply with the same name.",
    input: z.object({ name: z.string().describe("Name to echo.") }),
    output: z.object({ name: z.string() }),
    annotations: { title: "Ping", readOnlyHint: true },
    async call(_ctx: { seen: string[] }, input) {
      _ctx.seen.push(input.name);
      return { name: input.name };
    },
  });
  const served = await serveSocket({
    info: { name: "demo", description: "Demo operations.", transportDescription: "Demo socket.", path },
    context: { seen: [] as string[] },
    operations: [ping],
  });
  try {
    const listed = (await socketCall(path, "tools/list")) as {
      server: { name: string };
      tools: Array<{ name: string; inputSchema: { properties: { name: { description?: string } } } }>;
    };
    assert.equal(listed.server.name, "demo");
    assert.equal(listed.tools[0]?.name, "ping");
    assert.equal(listed.tools[0]?.inputSchema.properties.name.description, "Name to echo.");
    assert.deepEqual(await socketCall(path, "tools/call", { name: "ping", arguments: { name: "codex" } }), {
      name: "codex",
    });
    await assert.rejects(socketCall(path, "tools/call", { name: "missing", arguments: {} }), /unknown operation/);
    await assert.rejects(
      serveSocket({
        info: { name: "demo", description: "Demo operations.", transportDescription: "Demo socket.", path },
        context: { seen: [] },
        operations: [ping],
      }),
      /already listening/,
    );
  } finally {
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("socketCall rejects malformed, incomplete, and silent responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-socket-peer-"));
  try {
    for (const [name, reply, pattern] of [
      ["json", "{bad}\n", /JSON/],
      ["error", '{"error":"bad"}\n', /invalid socket response error/],
      ["eof", '{"result":1}', /complete response/],
      ["silent", null, /timed out/],
    ] as const) {
      const path = join(dir, `${name}.sock`);
      const server = createServer((peer) => {
        peer.once("data", () => {
          if (reply === null) return;
          peer.end(reply);
        });
      });
      await new Promise<void>((resolve) => server.listen(path, resolve));
      try {
        await assert.rejects(socketCall(path, "ping", {}, { timeoutMs: 100 }), pattern);
      } finally {
        await close(server);
      }
    }
    await assert.rejects(socketCall(join(dir, "missing.sock"), "ping", { value: 1n }), /BigInt/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await assert.rejects(socketCall(join(dir, "missing.sock"), "ping", cyclic), /circular/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("socket rejects null frames and waits for active calls before closing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-socket-drain-"));
  const path = join(dir, "demo.sock");
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = operation({
    name: "slow",
    description: "Wait for a test gate.",
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
    async call() {
      entered();
      await gate;
      return { done: true };
    },
  });
  const served = await serveSocket({
    info: { name: "demo", description: "Demo.", transportDescription: "Socket.", path },
    context: {},
    operations: [slow],
  });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const peer = connect(path);
      peer.setEncoding("utf8");
      peer.once("error", reject);
      peer.once("data", (frame: string) => { resolve(frame); peer.destroy(); });
      peer.once("connect", () => peer.write("null\n"));
    });
    assert.match(response, /invalid json/);
    const call = socketCall(path, "tools/call", { name: "slow", arguments: {} });
    await started;
    const firstClose = served.close();
    assert.equal(served.close(), firstClose);
    let done = false;
    void firstClose.then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false);
    release();
    assert.deepEqual(await call, { done: true });
    await firstClose;
  } finally {
    release();
    await served.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
