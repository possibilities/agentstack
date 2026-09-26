import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { chatTree, chatTreeDetail as detailOperation, chatThreadRead, type BotsContext } from "../api.js";
import { ChatIndex } from "../src/chats.js";
import { chatTreeDetail, detailChunk, pageChatTree, readChatTree, chatTreePage } from "../src/chat-tree.js";
import type { ServerView } from "../src/supervisor.js";

// Evidence contract: codexnk-v0.1.4 / f2905ff011ff8fda607e91dfdd8f13b6083b1642:
// app-server-protocol/schema/typescript/v2/{Thread,ThreadItemsListResponse,ThreadItemEntry,ThreadItem}.ts,
// protocol/src/protocol.rs (SessionMeta, ThreadSettingsAppliedEvent, CollabAgentSpawnEndEvent),
// rollout/src/ordinal.rs, and core/src/tools/handlers/multi_agents/spawn.rs.

const id = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const root = id(1), child = id(2), nested = id(3), foreign = id(4), orphan = id(5), cyclicA = id(6), cyclicB = id(7), malformed = id(8), liveChild = id(9);
const record = (type: string, payload: unknown, ordinal?: number) => ({ type, payload, timestamp: "2026-09-25T01:00:00.000Z", ...(ordinal === undefined ? {} : { ordinal }) });
const user = (text: string, ordinal?: number) => record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }, ordinal);
const bot = (running = false) => ({ id: "bot-1", mainThreadId: root, state: running ? "running" : "stopped", runningAccount: running ? "test" : null, url: running ? "ws://fixture" : null, pid: running ? 1 : null, recoveryIssue: null } as ServerView);
async function rollout(state: string, threadId: string, parent: unknown, extra: Record<string, unknown> = {}, records: unknown[] = []) {
  const dir = join(state, "history", "bot-1", "2026", "09", "25");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-test-${threadId}.jsonl`), [record("session_meta", { id: threadId, session_id: root, parent_thread_id: parent, cwd: "/work", timestamp: "2026-09-25T00:00:00.000Z", ...extra }), ...records].map((value) => JSON.stringify(value)).join("\n") + "\n");
}
async function fixture(run: (state: string, index: ChatIndex) => Promise<void>) {
  const state = await mkdtemp(join(tmpdir(), "agentstack-chat-tree-"));
  const index = new ChatIndex(state);
  try { await run(state, index); } finally { index.close(); await rm(state, { recursive: true, force: true }); }
}
const native = (threadId: string, parentThreadId: string | null, extra = {}) => ({
  id: threadId, sessionId: root, parentThreadId, forkedFromId: null, name: "Named thread", agentNickname: "Ada", agentRole: "researcher",
  model: "gpt-6-astra", reasoningEffort: "high", modelProvider: "openai", cwd: "/native", originator: "codex_cli_rs", cliVersion: "0.1.4",
  historyMode: "paginated", createdAt: 1_790_290_800, updatedAt: 1_790_290_801, ephemeral: false,
  status: { type: "active", activeFlags: ["waitingOnUserInput"] }, turns: [], ...extra,
});

test("stopped tree includes nested history and source-only parents, excludes foreign/orphan/cyclic/malformed lineage", async () => fixture(async (state, index) => {
  await rollout(state, root, null, {}, [user("root")]);
  await rollout(state, child, root, { agent_nickname: "Ada", agent_role: "researcher", model_provider: "openai", history_mode: "paginated", base_instructions: { text: "x".repeat(80_000) } }, [
    record("turn_context", { model: "gpt-5.6-sol", effort: "medium" }),
    record("event_msg", { type: "thread_settings_applied", thread_id: child, thread_settings: { model: "gpt-6-astra", reasoning_effort: "high", model_provider_id: "openai" } }), user("child")]);
  await rollout(state, nested, undefined, { source: { subagent: { thread_spawn: { parent_thread_id: child, depth: 999, agent_path: "/root/child/nested", agent_nickname: "Bob", agent_role: "builder" } } } }, [user("nested")]);
  await rollout(state, foreign, null);
  await rollout(state, orphan, id(99));
  await rollout(state, cyclicA, cyclicB);
  await rollout(state, cyclicB, cyclicA);
  await rollout(state, malformed, root, { source: { subagent: { thread_spawn: { parent_thread_id: foreign } } } });
  const tree = await readChatTree(index, bot());
  assert.deepEqual(tree.rows.map((row) => [row.threadId, row.depth]), [[root, 0], [child, 1], [nested, 2]]);
  assert.equal(tree.rows[1]?.model, "gpt-6-astra");
  assert.equal(tree.rows[1]?.reasoningEffort, "high");
  assert.equal(tree.rows[1]?.configurationSource, "rollout");
  assert.equal(tree.rows[2]?.agentNickname, "Bob");
  assert.equal(tree.rows[2]?.agentPath, "/root/child/nested");
  assert.ok(tree.rows.every((row) => row.status.type === "unknown" && row.status.freshness === "unknown" && row.loaded === null));
  assert.equal(tree.coverage.native, "stopped");
  assert.ok(JSON.stringify(tree.rows).length < 10_000);
  const page = chatTreePage.parse(pageChatTree(tree, 0, 2));
  assert.equal(page.nextOffset, 2);
  assert.deepEqual(pageChatTree(tree, 2, 2, page.snapshot).rows.map((row) => row.threadId), [nested]);
  assert.throws(() => pageChatTree(tree, 2, 2, "old"), /changed/);
  await assert.rejects(chatTreeDetail(index, bot(), tree, foreign), /lineage/);
  assert.deepEqual((await readChatTree(index, { ...bot(), mainThreadId: null })).rows, []);
}));

test("native loaded discovery authorizes live-before-rollout nested children and uses actual v2 fields", async () => fixture(async (state, index) => {
  await rollout(state, root, null);
  await rollout(state, child, root);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const records = new Map([
    [root, native(root, null, { status: { type: "idle" } })], [liveChild, native(liveChild, child, { source: { subAgent: { thread_spawn: { parent_thread_id: child, depth: 2, agent_path: "/r/c/live" } } } })],
    [foreign, native(foreign, null)], [orphan, native(orphan, id(99))], [cyclicA, native(cyclicA, cyclicB)], [cyclicB, native(cyclicB, cyclicA)],
  ]);
  const rpc = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "thread/list") return { data: params.archived ? [native(child, root, { status: { type: "notLoaded" }, model: "persisted-model" })] : [records.get(root)], nextCursor: null };
    if (method === "thread/loaded/list") return params.cursor ? { data: [liveChild, foreign, orphan, cyclicA, cyclicB], nextCursor: null } : { data: [root], nextCursor: "loaded-two" };
    return { thread: records.get(String(params.threadId)) };
  };
  const tree = await readChatTree(index, bot(true), 2000, rpc);
  assert.deepEqual(tree.rows.map((row) => row.threadId), [root, child, liveChild]);
  assert.equal(tree.rows[2]?.status.type, "active");
  assert.deepEqual(tree.rows[2]?.status.activeFlags, ["waitingOnUserInput"]);
  assert.equal(tree.rows[2]?.configurationSource, "nativeLoaded");
  assert.equal(tree.rows[2]?.agentRole, "researcher");
  assert.equal(tree.rows[2]?.depth, 2);
  assert.equal(tree.rows[1]?.archived, true);
  assert.equal(tree.rows[1]?.configurationSource, "nativePersisted");
  assert.equal(tree.rows[1]?.model, "persisted-model");
  assert.equal(tree.coverage.native, "scanned");
  assert.ok((calls.find((call) => call.method === "thread/list")?.params.sourceKinds as string[]).includes("subAgentThreadSpawn"));
  assert.ok(calls.filter((call) => call.method === "thread/read").every((call) => call.params.includeTurns === false));
  const detail = await chatTreeDetail(index, bot(true), tree, liveChild, async (_method, params) => ({ data: [{ turnId: "t", item: params.threadId === liveChild ? { type: "userMessage", id: "first", content: [{ type: "text", text: "live prompt" }] } : { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", receiverThreadIds: [liveChild], prompt: "live prompt", model: "gpt-6-astra", reasoningEffort: "high" } }], nextCursor: null }));
  assert.equal((detail.startingInput as { itemId: string }).itemId, "first");
  assert.equal((detail.spawn as { itemId: string }).itemId, "spawn");
  assert.equal(detail.spawnArguments, null);
  assert.ok((detail.coverage as { issues: string[] }).issues.includes("spawn_arguments_unavailable"));
}));

test("reverted rollout filenames retain stable thread identity; contradictory duplicate parents are excluded", async () => fixture(async (state, index) => {
  await rollout(state, root, null);
  await rollout(state, child, root, {}, [user("before revert")]);
  const dir = join(state, "history", "bot-1", "2026", "09", "25");
  await rename(join(dir, `rollout-test-${child}.jsonl`), join(dir, `rollout-test-${id(100)}.jsonl`));
  assert.deepEqual((await readChatTree(index, bot())).rows.map((row) => row.threadId), [root, child]);
  await writeFile(join(dir, `rollout-test-${id(101)}.jsonl`), JSON.stringify(record("session_meta", { id: child, parent_thread_id: foreign })) + "\n");
  assert.deepEqual((await readChatTree(index, bot())).rows.map((row) => row.threadId), [root]);
}));

test("detail correlates exact spawn arguments, skips inherited context by ordinal, and chunks large prompts with revision fencing", async () => fixture(async (state, index) => {
  const prompt = "start " + "🙂".repeat(60_000);
  const args = JSON.stringify({ message: prompt, model: "gpt-6-astra", reasoning_effort: "high", agent_type: "researcher", fork_context: true });
  await rollout(state, root, null, {}, [record("response_item", { type: "function_call", name: "spawn_agent", call_id: "spawn-1", arguments: args }),
    record("event_msg", { type: "collab_agent_spawn_end", call_id: "spawn-1", sender_thread_id: root, new_thread_id: child, prompt, model: "gpt-6-astra", reasoning_effort: "high", status: "running" })]);
  await rollout(state, child, root, { subagent_history_start_ordinal: 100, history_mode: "paginated" }, [
    record("turn_context", { model: "parent-model", effort: "low" }, 10), user("inherited user input", 20),
    record("turn_context", { model: "gpt-6-astra", effort: "high" }, 100), user(prompt, 101)]);
  const tree = await readChatTree(index, bot());
  const detail = await chatTreeDetail(index, bot(), tree, child);
  assert.equal((detail.startingInput as { line: number }).line, 5);
  assert.equal((detail.initialContext as { line: number }).line, 4);
  assert.equal((detail.spawnArguments as { value: { arguments: string } }).value.arguments, args);
  const first = detailChunk(detail, 0, 65_536);
  assert.equal(first.text.length, 65_536);
  let joined = first.text;
  let cursor = first.nextOffset;
  while (cursor !== null) { const chunk = detailChunk(detail, cursor, 65_536, first.revision); joined += chunk.text; cursor = chunk.nextOffset; }
  assert.deepEqual(JSON.parse(joined), detail);
  assert.throws(() => detailChunk({ ...detail, changed: true }, 0, 10, first.revision), /changed/);
  assert.throws(() => detailChunk(detail, first.totalChars + 1, 1), /exceeds/);
  const rawMeta = await index.recordChunk("bot-1", child, root, 1, 0, 65_536);
  assert.equal(JSON.parse(rawMeta.text).type, "session_meta");
}));

test("partial native scans are bounded, fail closed on conflicting lineage, and never make historical status live", async () => fixture(async (state, index) => {
  await rollout(state, root, null);
  await rollout(state, child, root);
  let scans = 0;
  const tree = await readChatTree(index, bot(true), 100, async (method, params) => {
    scans++;
    if (method === "thread/list") return { data: params.archived ? [] : [native(child, foreign)], nextCursor: "repeating" };
    if (method === "thread/loaded/list") return { data: [], nextCursor: "always-next" };
    throw new Error("unavailable");
  });
  assert.equal(scans, 3);
  assert.deepEqual(tree.rows.map((row) => row.threadId), [root]);
  assert.equal(tree.rows[0]?.status.freshness, "unknown");
  assert.equal(tree.coverage.native, "partial");
  assert.ok(tree.coverage.issues.includes("native_loaded_limit"));
  const unavailable = await readChatTree(index, bot(true), 100, async () => { throw new Error("offline"); });
  assert.deepEqual(unavailable.rows.map((row) => row.threadId), [root, child]);
  assert.ok(unavailable.rows.every((row) => row.status.type === "unknown"));
  assert.equal(chatTree.input.safeParse({ botId: "bot-1", limit: 101 }).success, false);
  assert.equal(detailOperation.input.safeParse({ botId: "bot-1", threadId: child, length: 65_537 }).success, false);
}));

test("raw thread reads authorize loaded children without a materialized rollout through the actual socket RPC", async () => fixture(async (_state, index) => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const records = new Map([[root, native(root, null)], [child, native(child, root)], [nested, native(nested, child)], [foreign, native(foreign, null)]]);
  wss.on("connection", (peer) => peer.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (!frame.id) return;
    const result = frame.method === "initialize" ? {} : frame.method === "thread/list" ? { data: [], nextCursor: null } : frame.method === "thread/loaded/list" ? { data: [...records.keys()], nextCursor: null } : { thread: records.get(frame.params.threadId) };
    peer.send(JSON.stringify({ id: frame.id, result }));
  }));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const running = { ...bot(true), url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
  const ctx = { chats: index, supervisor: { list: () => [running] } } as unknown as BotsContext;
  try {
    const result = await chatThreadRead.call(ctx, { botId: "bot-1", threadId: nested });
    assert.equal(result.thread.id, nested);
    await assert.rejects(chatThreadRead.call(ctx, { botId: "bot-1", threadId: foreign }), /lineage/);
  } finally {
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve())));
  }
}));
