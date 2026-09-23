import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { attachInputMiddleware, type InputResolution } from "../src/middleware.js";

test("host-side middleware uses the app-server Unix WebSocket and acts only after resolution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-middleware-"));
  const path = join(dir, "codex.sock");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(path, resolve));
  const threadId = "thread-1";
  let callbackCount = 0;
  let decideCount = 0;
  const record = {
    threadId, inputId: "client:c1", originalText: "Mute mic", selectedText: null,
    disposition: { type: "intercepted", operationId: "op-1" }, effect: null,
  };
  server.on("connection", (client) => {
    client.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      const send = (message: object) => client.send(JSON.stringify(message));
      if (frame.method === "initialize") send({ id: frame.id, result: {} });
      if (frame.method === "thread/input/middleware/attach") {
        assert.equal(frame.params?.threadId, threadId);
        send({ id: frame.id, result: { threadId, ownerId: "owner-1" } });
        send({ id: 41, method: "thread/input/requestDisposition", params: {
          threadId, inputId: "client:c1", origin: "client", text: "Mute mic",
        } });
      }
      if (frame.id === 41 && frame.result) {
        assert.deepEqual(frame.result, { type: "intercept", operationId: "op-1" });
        assert.equal(callbackCount, 0, "effect owner must wait for committed resolution");
        send({ method: "thread/input/resolved", params: {
          threadId, inputId: "client:c1", disposition: record.disposition, effect: null,
        } });
      }
      if (frame.method === "thread/input/read") send({ id: frame.id, result: { record } });
      if (frame.method === "thread/input/middleware/detach") {
        assert.equal(frame.params?.ownerId, "owner-1");
        send({ id: frame.id, result: {} });
      }
      if (frame.method === "thread/input/complete") {
        assert.equal(frame.params?.operationId, "op-1");
        send({ id: frame.id, result: { record: { ...record, effect: frame.params?.receipt } } });
      }
    });
  });
  let deliver!: (resolution: InputResolution) => void;
  const resolved = new Promise<InputResolution>((resolve) => { deliver = resolve; });
  try {
    const client = await attachInputMiddleware(`unix://${path}`, threadId, (candidate) => {
      decideCount++;
      assert.equal(candidate.origin, "client");
      return { type: "intercept", operationId: "op-1" };
    }, (resolution) => { callbackCount++; deliver(resolution); }, { onUnavailable: "reject" });
    try {
      assert.deepEqual((await resolved).disposition, record.disposition);
      assert.equal(decideCount, 1);
      assert.equal(callbackCount, 1);
      assert.deepEqual(await client.read("client:c1"), record);
      assert.deepEqual((await client.complete("client:c1", "op-1", { status: "succeeded", summary: "Muted" })).effect,
        { status: "succeeded", summary: "Muted" });
    } finally {
      await client.detach();
    }
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
