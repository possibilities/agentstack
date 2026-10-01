import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ChatIndex, ChatQueue, ChatUploads, chatRpc } from "../src/chats.js";
import type { ServerView } from "../src/supervisor.js";
import { chatSend, chatSteer, chatEnqueue, type BotsContext } from "../api.js";

const rootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const line = (type: string, payload: unknown, timestamp = "2026-09-25T00:00:00Z") => JSON.stringify({ timestamp, type, payload });
const message = (role: string, body: string) => line("response_item", { type: "message", role, content: [{ type: "input_text", text: body }] });
const fixture = async (state: string, id: string, parent: string | null, body: string) => {
  const dir = join(state, "history", "bot-1", "2026", "09", "25");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-test-${id}.jsonl`);
  await writeFile(path, [line("session_meta", { id, session_id: rootId, parent_thread_id: parent, cwd: "/work" }), message("user", body), line("response_item", { type: "function_call", name: "shell", arguments: "{\"command\":\"rg needle\"}" }), message("assistant", "Here is the result"), ""].join("\n"));
  return path;
};

test("owned chat index scopes history, searches tool content, and pages raw records while stopped", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-chats-"));
  let index: ChatIndex | undefined;
  try {
    const root = await fixture(state, rootId, null, "needle root chat");
    await fixture(state, childId, rootId, "needle child chat");
    await fixture(state, otherId, null, "needle foreign top-level chat");
    index = new ChatIndex(state);
    assert.equal((await lstat(join(state, "chats.sqlite"))).mode & 0o777, 0o600);
    await index.refresh("bot-1", rootId);
    assert.deepEqual(index.list("bot-1", rootId, 10, 0).map((chat) => chat.threadId).sort(), [rootId, childId].sort());
    assert.equal(index.list("bot-1", null, 10, 0).length, 0);
    assert.deepEqual(index.search("bot-1", rootId, "needle", 10, 0).map((hit) => hit.threadId).sort(), [rootId, childId].sort());
    assert.equal(index.search("bot-1", rootId, "rg", 10, 0).length, 2);
    const source = [line("session_meta", { id: rootId, session_id: rootId, cwd: "/work" }),
      message("user", "needle root chat"),
      line("response_item", { type: "function_call_output", output: { content: [{ text: "MCP output searchable" }] } }),
      line("response_item", { type: "message", role: "assistant", content: [{ text: "x".repeat(90_000) }] }), ""].join("\n");
    await writeFile(root, source);
    await index.refresh("bot-1", rootId);
    assert.equal(index.search("bot-1", rootId, "searchable", 10, 0)[0]?.threadId, rootId);
    const long = await index.records("bot-1", rootId, rootId, 0, 10);
    assert.equal(long.records.at(-1)?.truncated, true);
    const chunk = await index.recordChunk("bot-1", rootId, rootId, long.records.at(-1)!.line, 0, 1024);
    assert.ok(chunk.nextOffset !== null);
    assert.ok(chunk.text.startsWith('{"timestamp"'));
    assert.equal(index.search("bot-1", rootId, "\" * ()", 10, 0).length, 0);
    await assert.rejects(index.records("bot-1", otherId, rootId, 0, 10), /lineage/);
    const first = await index.records("bot-1", rootId, rootId, 0, 1);
    assert.equal(first.records[0]?.payload && (first.records[0].payload as { role: string }).role, "user");
    assert.ok(first.nextLine !== null);
    const rest = await index.records("bot-1", rootId, rootId, first.nextLine!, 10);
    assert.equal(rest.records.length, 2);
    await rm(root);
    await index.refresh("bot-1", rootId);
    assert.deepEqual(index.list("bot-1", rootId, 10, 0), []); // descendant is no longer reachable
  } finally { index?.close(); await rm(state, { recursive: true, force: true }); }
});

test("legacy shared history admits only the adopted root and its private descendants", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-legacy-chats-"));
  let index: ChatIndex | undefined;
  try {
    const shared = join(state, "history", "2025", "09", "25");
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, `rollout-test-${rootId}.jsonl`), [line("session_meta", { id: rootId, cwd: "/w" }), message("user", "legacy root text"), ""].join("\n"));
    await fixture(state, childId, rootId, "child text");
    await fixture(state, otherId, null, "foreign text");
    index = new ChatIndex(state);
    await index.refresh("bot-1", rootId);
    assert.deepEqual(index.list("bot-1", rootId, 10, 0).map((chat) => chat.threadId).sort(), [rootId, childId].sort());
    assert.equal((await index.records("bot-1", rootId, rootId, 0, 20)).records.length, 1);
    assert.equal(index.search("bot-1", rootId, "foreign", 10, 0).length, 0);
  } finally { index?.close(); await rm(state, { recursive: true, force: true }); }
});

test("a symlinked history root cannot redirect indexing outside the Bot's state", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-chats-root-"));
  const external = await mkdtemp(join(tmpdir(), "stack-chats-outside-"));
  let index: ChatIndex | undefined;
  try {
    await mkdir(join(state, "history"));
    await symlink(external, join(state, "history", "bot-1"));
    index = new ChatIndex(state);
    await assert.rejects(index.refresh("bot-1", rootId), /not a real directory/);
    await rm(join(state, "history", "bot-1"));
    await rm(join(state, "history"), { recursive: true });
    await symlink(external, join(state, "history"));
    await assert.rejects(index.refresh("bot-1", rootId), /not a real directory/);
  } finally { index?.close(); await rm(state, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});

test("queue admits once, drains while Codex is working, and preserves an unknown dispatch fence across restart", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-queue-"));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const accepted: string[] = [];
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as { id?: number; method: string; params: { clientUserMessageId?: string } };
    if (frame.method === "initialize") peer.send(JSON.stringify({ id: frame.id, result: {} }));
    else if (frame.method === "thread/read") peer.send(JSON.stringify({ id: frame.id, result: { thread: { status: { type: "active" } } } }));
    else if (frame.method === "turn/start") { accepted.push(frame.params.clientUserMessageId!); peer.send(JSON.stringify({ id: frame.id, result: { turn: { id: "turn-one" } } })); }
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  let index: ChatIndex | undefined;
  try {
    await fixture(state, rootId, null, "queue test");
    index = new ChatIndex(state);
    await index.refresh("bot-1", rootId);
    const bot = { id: "bot-1", mainThreadId: rootId, state: "running", runningAccount: "test", url, recoveryIssue: null } as ServerView;
    const queue = new ChatQueue(index, () => bot);
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    assert.equal(index.enqueue("bot-1", rootId, id, [{ type: "text", text: "first" }]).state, "pending");
    assert.equal(index.enqueue("bot-1", rootId, id, [{ type: "text", text: "first" }]).state, "pending");
    assert.throws(() => index!.enqueue("bot-1", otherId, id, [{ type: "text", text: "first" }]), /different content or destination/);
    const second = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    index.enqueue("bot-1", rootId, second, [{ type: "text", text: "second" }]);
    queue.wake("bot-1", rootId);
    for (let n = 0; n < 150 && index.queued(second)?.state !== "sent"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(accepted, [id, second]);
    assert.equal(index.queued(id)?.state, "sent");
    assert.equal(index.queued(id)?.turnId, "turn-one");
    assert.equal(index.queued(second)?.turnId, "turn-one", "both messages can be admitted to the same active turn");
    const third = randomUUID();
    index.enqueue("bot-1", rootId, third, [{ type: "text", text: "third" }]);
    index.setQueued(third, "dispatching");
    index.enqueue("bot-1", rootId, randomUUID(), [{ type: "text", text: "behind unknown" }]);
    await queue.close();
    index.close(); index = new ChatIndex(state);
    assert.equal(index.queued(third)?.state, "unknown");
    assert.equal(index.nextQueued("bot-1", rootId), null);
    assert.deepEqual((await chatRpc(url, "thread/read", { threadId: rootId })).thread, { status: { type: "active" } });
  } finally { index?.close(); await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve()))); await rm(state, { recursive: true, force: true }); }
});

test("chat submissions return receipt-time state and admit working threads even when observation fails", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-chat-send-"));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let status: Record<string, unknown> = { type: "idle" };
  let failRead = false;
  const submitted: string[] = [];
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.method === "initialize") peer.send(JSON.stringify({ id: frame.id, result: {} }));
    if (frame.method === "thread/read") peer.send(JSON.stringify(failRead
      ? { id: frame.id, error: { message: "status unavailable" } }
      : { id: frame.id, result: { thread: { status } } }));
    if (frame.method === "turn/start" || frame.method === "turn/steer") {
      submitted.push(frame.method);
      // Deliberately change state between observation and acknowledgement.
      status = { type: "active", activeFlags: [] };
      peer.send(JSON.stringify({ id: frame.id, result: frame.method === "turn/steer" ? { turnId: "active" } : { turn: { id: "active" } } }));
    }
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const chats = new ChatIndex(state);
  const bot = { id: "bot-1", mainThreadId: rootId, state: "running", runningAccount: "test", cwd: state,
    url: `ws://127.0.0.1:${address.port}`, recoveryIssue: null } as ServerView;
  const queue = new ChatQueue(chats, () => bot);
  const ctx = { chats, queue, supervisor: { list: () => [bot] }, store: { stateIdentity: () => ({ generation: randomUUID() }) } } as unknown as BotsContext;
  const input = { botId: bot.id, threadId: rootId, input: [{ type: "text" as const, text: "hello" }] };
  try {
    await fixture(state, rootId, null, "chat send");
    const idle = await chatSend.call(ctx, input);
    assert.deepEqual(idle.threadState.status, { type: "idle" });
    assert.equal(idle.threadState.activity, "idle");
    assert.ok(Number.isFinite(Date.parse(idle.threadState.observedAt)));
    const working = await chatSend.call(ctx, input);
    assert.equal(working.threadState.activity, "working");
    assert.deepEqual(working.turn, idle.turn);
    status = { type: "active", activeFlags: ["waitingOnApproval"] };
    const waiting = await chatSteer.call(ctx, { ...input, expectedTurnId: "active" });
    assert.equal(waiting.threadState.activity, "waiting");
    assert.deepEqual(waiting.threadState.status, { type: "active", activeFlags: ["waitingOnApproval"] });
    failRead = true;
    const unavailable = await chatSend.call(ctx, input);
    assert.equal(unavailable.threadState.activity, "unknown");
    assert.equal(unavailable.threadState.status, null);
    assert.match(unavailable.threadState.error!, /status unavailable/);
    const queued = await chatEnqueue.call(ctx, { ...input, id: randomUUID() });
    assert.equal(queued.threadState.activity, "unknown");
    for (let n = 0; n < 150 && chats.queued(queued.id)?.state !== "sent"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(chats.queued(queued.id)?.state, "sent");
    assert.deepEqual(submitted, ["turn/start", "turn/start", "turn/steer", "turn/start", "turn/start"]);
  } finally {
    await queue.close(); chats.close();
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    await rm(state, { recursive: true, force: true });
  }
});

test("chunked uploads resume by actual offset, validate bytes, and stay Bot-scoped", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-chat-upload-"));
  const uploads = new ChatUploads(state);
  const id = randomUUID();
  const bytes = Buffer.from([0, 1, 255, 128, 65, 0]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    await assert.rejects(uploads.start("bot-1", id, "../escape", bytes.length, sha256), /safe filename/);
    await assert.rejects(uploads.start("bot-1", id, "manifest.json", bytes.length, sha256), /safe filename/);
    assert.equal((await uploads.start("bot-1", id, "capture.bin", bytes.length, sha256)).offset, 0);
    await assert.rejects(uploads.start("bot-1", id, "other.bin", bytes.length, sha256), /different content/);
    await uploads.append("bot-1", id, 0, bytes.subarray(0, 3).toString("base64"));
    assert.equal((await new ChatUploads(state).status("bot-1", id)).offset, 3);
    await assert.rejects(uploads.append("bot-1", id, 0, bytes.subarray(0, 3).toString("base64")), /offset changed/);
    await uploads.append("bot-1", id, 3, bytes.subarray(3).toString("base64"));
    const finished = await uploads.finish("bot-1", id);
    assert.ok(finished.path);
    assert.equal((await uploads.finish("bot-1", id)).path, finished.path);
    assert.equal(await uploads.within("bot-1", finished.path!), true);
    assert.equal(await uploads.within("bot-2", finished.path!), false);
    await uploads.removeBot("bot-1");
    await assert.rejects(uploads.status("bot-1", id), /ENOENT/);
  } finally { await rm(state, { recursive: true, force: true }); }
});
