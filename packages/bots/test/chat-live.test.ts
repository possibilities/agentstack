import assert from "node:assert/strict";
import test from "node:test";
import { LiveChats, boundedMainItems } from "../src/chat-live.js";

const root = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const url = "unix:///private/bot.sock";

test("main chat observation grows text, replaces completions, and fences other threads and reconnects", () => {
  const chats = new LiveChats();
  const start = chats.read("bot-1", url, root);
  assert.equal(start.coverage, "partial");
  assert.deepEqual(start.items, []);
  const item = { id: "item-one", type: "agentMessage", text: "Hi" };
  chats.observe("bot-1", url, other, "item/started", { threadId: other, turnId: "turn", item });
  chats.observe("bot-1", url, root, "item/started", { threadId: other, turnId: "turn", item });
  assert.equal(chats.read("bot-1", url, root).revision, 0);
  chats.observe("bot-1", url, root, "turn/started", { threadId: root, turn: { id: "turn" } });
  chats.observe("bot-1", url, root, "item/started", { threadId: root, turnId: "turn", item });
  chats.observe("bot-1", url, root, "item/agentMessage/delta", { threadId: root, turnId: "turn", itemId: item.id, delta: " there" });
  assert.equal(chats.read("bot-1", url, root).activeTurnId, "turn");
  assert.deepEqual(chats.read("bot-1", url, root).items, [{ turnId: "turn", item: { ...item, text: "Hi there" }, complete: true, completed: false, omitted: false }]);
  chats.observe("bot-1", url, root, "item/completed", { threadId: root, turnId: "turn", item: { ...item, text: "Hi there!" } });
  chats.observe("bot-1", url, root, "turn/completed", { threadId: root, turn: { id: "turn" } });
  assert.equal(chats.read("bot-1", url, root).items[0]?.item.text, "Hi there!");
  assert.equal(chats.read("bot-1", url, root).items[0]?.completed, true);
  assert.equal(chats.read("bot-1", url, root).activeTurnId, null);
  chats.observe("bot-1", url, root, "item/started", { threadId: root, turnId: "next", item: { id: "diff", type: "fileChange", changes: [] } });
  chats.observe("bot-1", url, root, "item/fileChange/outputDelta", { threadId: root, turnId: "next", itemId: "diff", delta: "patch" });
  assert.equal(chats.read("bot-1", url, root).items.at(-1)?.complete, false);
  chats.connected("bot-1", url);
  const resumed = chats.read("bot-1", url, root);
  assert.notEqual(resumed.instance, start.instance);
  assert.deepEqual(resumed.items, []);
  chats.observe("bot-1", url, root, "item/started", { threadId: root, turnId: "next", item });
  chats.observe("bot-1", url, root, "thread/reverted", { threadId: root });
  assert.deepEqual(chats.read("bot-1", url, root).items, []);
  assert.equal(chats.read("bot-1", null, root).instance, null);
});

test("live projection bounds oversized native items and old rows without hiding status", () => {
  const chats = new LiveChats();
  for (let n = 0; n < 80; n++) chats.observe("bot-1", url, root, "item/completed", {
    threadId: root, turnId: `turn-${n}`, item: { id: `item-${n}`, type: "commandExecution", command: "echo", status: "completed", aggregatedOutput: "x".repeat(90_000) },
  });
  const items = chats.read("bot-1", url, root).items;
  assert.equal(items.length, 64);
  assert.equal(items[0]?.item.id, "item-16");
  assert.equal(items[0]?.item.status, "completed");
  assert.equal(items[0]?.omitted, true);
  assert.equal(items[0]?.complete, false);
  assert.ok(JSON.stringify(items).length < 320_000);
});

test("native item pages shrink to the response budget and preserve native continuation", async () => {
  const calls: number[] = [];
  const read = async (limit: number) => {
    calls.push(limit);
    return { data: Array.from({ length: limit }, (_, n) => ({ turnId: "turn", item: { id: `item-${n}`, type: "agentMessage", text: "x".repeat(200_000) } })), nextCursor: `after-${limit}` };
  };
  const page = await boundedMainItems(read, 8);
  assert.deepEqual(calls, [8, 4, 2]);
  assert.equal(page.data.length, 2);
  assert.equal(page.nextCursor, "after-2");
  const huge = await boundedMainItems(async () => ({ data: [{ turnId: "turn", item: { id: "large", type: "commandExecution", status: "failed", aggregatedOutput: "x".repeat(700_000) } }], nextCursor: "after-large" }), 1);
  assert.deepEqual(huge, { data: [{ turnId: "turn", item: { id: "large", type: "commandExecution", status: "failed" }, omitted: true }], nextCursor: "after-large" });
});
