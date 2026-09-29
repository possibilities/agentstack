import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { activityOf, applyLive, applyNewest, applyOlder, emptyTranscript, entriesOf, historyRow, liveRow, reasoningHeadline, turnEnds } = await import("../lib/stack/transcript.ts");
const { ChatWindowStore, primaryChat } = await import("../lib/stack/chat-windows.ts");
const { markdownBlocks } = await import("../lib/stack/markdown-blocks.ts");

const user = (id, text) => ({ type: "userMessage", id, content: [{ type: "text", text, text_elements: [] }] });
const say = (id, text) => ({ type: "agentMessage", id, text, phase: "final_answer" });
const tool = (id) => ({ type: "commandExecution", id, command: "pnpm test", status: "completed" });
/** Newest-first native entries, as chat_main_items pages them. */
const page = (...entries) => entries.map(([turnId, item, at]) => ({ turnId, item, startedAtMs: at ?? 1, completedAtMs: (at ?? 1) + 10 })).reverse()
  .map((entry) => historyRow(entry, null));
const texts = (state) => entriesOf(state, new Map()).entries.map((entry) => `${entry.kind}:${entry.text}`);

test("history pages and live rows assemble one ordered human/assistant transcript", () => {
  let state = applyNewest(emptyTranscript, page(["t2", user("u2", "second"), 20], ["t2", tool("x2"), 22], ["t2", say("a2", "two"), 24])).state;
  state = applyOlder(state, page(["t1", user("u1", "first"), 1], ["t1", say("a1", "one"), 5]));
  assert.deepEqual(texts(state), ["human:first", "assistant:one", "human:second", "assistant:two"]);

  // A live turn appends and streams; a draft never replaces canonical history.
  state = applyLive(state, [liveRow({ turnId: "t3", item: user("u3", "third"), completed: true, omitted: false }, 50),
    liveRow({ turnId: "t3", item: say("a3", "Thr"), completed: false, omitted: false }, 50)], false);
  state = applyLive(state, [liveRow({ turnId: "t3", item: say("a3", "Three"), completed: false, omitted: false }, 51),
    liveRow({ turnId: "t2", item: say("a2", "stale draft"), completed: false, omitted: false }, 51)], false);
  const { entries } = entriesOf(state, new Map());
  assert.deepEqual(entries.map((entry) => entry.text), ["first", "one", "second", "two", "third", "Three"]);
  assert.equal(entries.at(-1).streaming, true);

  // The newest history page overlaps known rows: earlier rows keep their place, drafts are finalized in place.
  state = applyNewest(state, page(["t2", say("a2", "two"), 24], ["t3", user("u3", "third"), 50], ["t3", say("a3", "Three!"), 52])).state;
  const finished = entriesOf(state, new Map()).entries;
  assert.deepEqual(finished.map((entry) => entry.text), ["first", "one", "second", "two", "third", "Three!"]);
  assert.equal(finished.at(-1).streaming, false);
});

test("unchanged rows keep entry identity and a gap replaces the transcript", () => {
  const first = applyNewest(emptyTranscript, page(["t1", user("u1", "hi"), 1], ["t1", say("a1", "hello"), 2])).state;
  const view = entriesOf(first, new Map());
  const again = applyNewest(first, page(["t1", user("u1", "hi"), 1], ["t1", say("a1", "hello"), 2])).state;
  assert.equal(again, first, "an identical page is a no-op");
  const grown = applyLive(first, [liveRow({ turnId: "t2", item: say("a2", "more"), completed: false, omitted: false }, 9)], false);
  const next = entriesOf(grown, view.cache);
  assert.equal(next.entries[0], view.entries[0]);
  assert.equal(next.entries[1], view.entries[1]);

  const gap = applyNewest(first, page(["t9", user("u9", "far later"), 90]));
  assert.equal(gap.contiguous, false);
  assert.deepEqual(texts(gap.state), ["human:far later"]);

  // A live reset drops drafts but keeps canonical rows.
  const reset = applyLive(grown, [], true);
  assert.deepEqual(texts(reset), ["human:hi", "assistant:hello"]);
});

test("only human and assistant text become entries", () => {
  const state = applyNewest(emptyTranscript, page(
    ["t", { type: "userMessage", id: "u", content: [{ type: "text", text: "look" }, { type: "localImage", path: "/tmp/shot.png" }, { type: "mention", name: "api.ts", path: "/w/api.ts" }] }],
    ["t", { type: "reasoning", id: "r", summary: ["**Plan**"], content: [] }],
    ["t", tool("x")], ["t", { type: "plan", id: "p", text: "1. do" }], ["t", say("empty", "")], ["t", say("a", "done")],
  )).state;
  const { entries } = entriesOf(state, new Map());
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.text, entry.attachments]), [["human", "look", ["image shot.png", "@api.ts"]], ["assistant", "done", []]]);
});

test("finished turns carry their span and the active turn reports its phase and reasoning heading", () => {
  const state = applyNewest(emptyTranscript, [
    historyRow({ turnId: "t1", item: user("u1", "go"), startedAtMs: 1000, completedAtMs: 1001 }, null),
    historyRow({ turnId: "t1", item: say("c1", "checking"), startedAtMs: 2000, completedAtMs: 2001 }, null),
    historyRow({ turnId: "t1", item: say("a1", "done"), startedAtMs: 3000, completedAtMs: 13_400 }, null),
  ].reverse()).state;
  const { entries } = entriesOf(state, new Map());
  const ends = turnEnds(state, entries, null);
  assert.deepEqual([...ends.keys()], [entries.at(-1).key], "only the turn's last assistant entry ends it");
  assert.deepEqual(ends.get(entries.at(-1).key), { turnId: "t1", startedAtMs: 1000, completedAtMs: 13_400 });
  assert.equal(turnEnds(state, entries, "t1").size, 0, "an active turn has no end yet");

  let live = applyLive(state, [liveRow({ turnId: "t2", item: { type: "reasoning", id: "r", summary: ["**Reading files**\n\nlooking"], content: [] }, completed: false, omitted: false }, 1)], false);
  assert.deepEqual(activityOf(live, "t2"), { phase: "thinking", headline: "Reading files" });
  live = applyLive(live, [liveRow({ turnId: "t2", item: tool("x"), completed: false, omitted: false }, 1)], false);
  assert.deepEqual(activityOf(live, "t2"), { phase: "working", headline: "Reading files" });
  live = applyLive(live, [liveRow({ turnId: "t2", item: say("a", "Hel"), completed: false, omitted: false }, 1)], false);
  assert.equal(activityOf(live, "t2").phase, "responding");
  assert.equal(activityOf(live, null), null);
  assert.equal(reasoningHeadline({ summary: ["plain first line\nmore"] }), "plain first line");
  assert.equal(reasoningHeadline({ summary: [] }), null);
});

test("chat windows switch the primary, reveal an existing Bot, add and close extras, and restore safely", () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const chats = new ChatWindowStore();
  chats.attach(storage);
  assert.deepEqual(chats.getWindows(), [{ id: primaryChat, botId: null }]);
  assert.equal(chats.show("bot-1"), primaryChat);
  assert.equal(chats.open("bot-2"), "chat-2");
  assert.equal(chats.show("bot-2"), "chat-2", "a Bot already shown is revealed, not duplicated");
  assert.equal(chats.getWindows()[0].botId, "bot-1");
  assert.equal(chats.open(null), "chat-3");
  chats.close("chat-2");
  assert.equal(chats.open("bot-4"), "chat-2", "window IDs are reused");
  chats.close(primaryChat);
  assert.equal(chats.getWindows()[0].botId, null, "the primary window empties instead of closing");
  chats.prune(new Set(["bot-1"]));
  assert.deepEqual(chats.getWindows().map((chat) => chat.id), [primaryChat, "chat-3"]);

  const restored = new ChatWindowStore();
  let notified = 0;
  restored.subscribe(() => notified++);
  restored.attach(storage);
  assert.deepEqual(restored.getWindows(), chats.getWindows());
  assert.equal(notified, 1);
  saved.set("agentstack.uix.chats.v1", JSON.stringify([{ id: "chat-2", botId: "bot-9" }, { id: "../evil" }, { id: "chat-2" }, "junk"]));
  const repaired = new ChatWindowStore();
  repaired.attach(storage);
  assert.deepEqual(repaired.getWindows(), [{ id: primaryChat, botId: null }, { id: "chat-2", botId: "bot-9" }]);
});

test("markdown splits into top-level blocks outside fences and continuations", () => {
  assert.deepEqual(markdownBlocks("# Title\n\nFirst para\nline two\n\n\n- a\n- b"), ["# Title", "First para\nline two", "- a\n- b"]);
  assert.deepEqual(markdownBlocks("```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter"), ["```ts\nconst a = 1;\n\nconst b = 2;\n```", "after"]);
  assert.deepEqual(markdownBlocks("- item\n\n  continued\n\nnext"), ["- item\n\n  continued", "next"]);
  assert.deepEqual(markdownBlocks("streaming ```py\nprint(1)\n\nstill code"), ["streaming ```py\nprint(1)", "still code"], "a fence marker must open the line");
  assert.deepEqual(markdownBlocks("````\n```\ninner\n```\n````\n\nx"), ["````\n```\ninner\n```\n````", "x"]);
  assert.deepEqual(markdownBlocks(""), []);
});
