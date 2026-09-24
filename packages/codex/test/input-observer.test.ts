import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { InputObserver } from "../src/input-observer.js";

test("an explicit observer records candidate, committed pass and clean detach", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-observer-"));
  const path = join(dir, "codex.sock");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(path, resolve));
  const observer = new InputObserver();
  let publishCount = 0;
  let finish!: () => void;
  const resolved = new Promise<void>((resolve) => { finish = resolve; });
  observer.setPublisher(() => {
    publishCount++;
    if (observer.snapshot().entries[0]?.disposition === "passed") finish();
  });
  server.on("connection", (client) => {
    client.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { id?: number; method?: string; result?: unknown };
      const send = (message: object) => client.send(JSON.stringify(message));
      if (frame.method === "initialize") send({ id: frame.id, result: {} });
      if (frame.method === "thread/input/middleware/attach") {
        send({ id: frame.id, result: { threadId: "t1", ownerId: "owner" } });
        send({ id: 41, method: "thread/input/requestDisposition", params: {
          threadId: "t1", inputId: "client:c1", origin: "client", text: "Original text",
        } });
      }
      if (frame.id === 41) {
        assert.deepEqual(frame.result, { type: "pass" });
        send({ method: "thread/input/resolved", params: {
          threadId: "t1", inputId: "client:c1", disposition: { type: "passed" }, effect: null,
        } });
      }
      if (frame.method === "thread/input/read") send({ id: frame.id, result: { record: {
        threadId: "t1", inputId: "client:c1", originalText: "Original text", selectedText: "Original text",
        disposition: { type: "passed" }, effect: null,
      } } });
      if (frame.method === "thread/input/middleware/detach") send({ id: frame.id, result: {} });
    });
  });
  try {
    await observer.start({ id: "s1", cwd: dir, pid: 1, state: "running", url: `unix://${path}`, account: null }, "t1");
    await resolved;
    assert.equal(observer.snapshot().entries[0]?.originalText, "Original text");
    assert.equal(observer.snapshot().entries[0]?.disposition, "passed");
    assert.ok(publishCount >= 2);
    await observer.stop("s1", "t1");
    assert.deepEqual(observer.snapshot().targets, []);
    assert.equal(observer.snapshot().entries[0]?.disposition, "passed");
  } finally {
    observer.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
