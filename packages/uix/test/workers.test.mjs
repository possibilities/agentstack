import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { appendBySeq, conversation, filterWorkers, groupWorkers, parsePlan, parseToolLine, settingsMismatch, workerAttention, workerLabel, workerNote, workerOrigin } = await import("../lib/stack/workers.ts");
const { WorkerWindowStore, primaryWorker } = await import("../lib/stack/worker-windows.ts");

const session = (id, phase, extra = {}) => ({ id, botId: "bot-1", threadId: "t", accountId: "w1", provider: "claude", model: "opus", effort: "high",
  repo: "/src/agentstack/", cwd: null, branch: null, baseCommit: null, sourceDirty: false, roleRevision: 1, sessionId: null, runtimeInstance: null,
  phase, currentTurnId: null, issue: null, createdAt: 1, updatedAt: 1, ...extra });
const entry = (seq, turnId, kind, text) => ({ seq, workerId: "w", turnId, kind, text, at: seq });

test("Workers are named by repository and short ID, and the local operator by role", () => {
  assert.equal(workerLabel(session("0fd9d71a-8b46", "idle")), "agentstack · 0fd9d7");
  assert.equal(workerOrigin("_local_operator"), "Operator");
  assert.equal(workerOrigin("bot-3"), "bot-3");
});

test("groupWorkers puts what needs a look first and keeps each group newest first", () => {
  const groups = groupWorkers([
    session("idle-old", "idle", { updatedAt: 1 }), session("idle-new", "idle", { updatedAt: 5 }), session("run", "running"), session("prep", "preparing"),
    session("perm", "awaiting_input"), session("rec", "needs_recovery"), session("fail", "failed"), session("done", "closed"),
  ]);
  const ids = (group) => groups.get(group).map((worker) => worker.id);
  assert.deepEqual(ids("attention"), ["perm", "rec", "fail"]);
  assert.deepEqual(ids("running"), ["run", "prep"]);
  assert.deepEqual(ids("idle"), ["idle-new", "idle-old"]);
  assert.deepEqual(ids("closed"), ["done"]);
  assert.equal(workerAttention(session("x", "needs_recovery", { issue: "Owner restarted" })), "Owner restarted");
  assert.equal(workerAttention(session("x", "closed", { issue: "stale" })), null);
  assert.equal(workerAttention(session("x", "awaiting_input", { pendingPermissions: 3 })), "Waiting for its Bot to answer 3 permission requests");
  assert.equal(workerAttention(session("x", "closed", { pendingPermissions: 3 })), null);
  // An unknown outcome stays after the Bot resumes, so it is a row note, not attention.
  const unknown = session("x", "idle", { turn: { id: "t", phase: "unknown", stopReason: null, issue: null, dispatchedAt: null, createdAt: 1, updatedAt: 1 } });
  assert.equal(workerAttention(unknown), null);
  assert.equal(workerNote(unknown), "Last turn outcome unknown");
  assert.equal(workerNote({ ...unknown, phase: "closed" }), null);
});

test("filterWorkers narrows by Bot and account", () => {
  const workers = [session("a", "idle"), session("b", "idle", { botId: "bot-2" }), session("c", "idle", { accountId: "w2" })];
  assert.deepEqual(filterWorkers(workers, {}).map((worker) => worker.id), ["a", "b", "c"]);
  assert.deepEqual(filterWorkers(workers, { botId: "bot-2" }).map((worker) => worker.id), ["b"]);
  assert.deepEqual(filterWorkers(workers, { botId: "bot-1", accountId: "w2" }).map((worker) => worker.id), ["c"]);
});

test("tool lines split a known trailing status and resolve bare tool call IDs", () => {
  assert.deepEqual(parseToolLine("Edit src/a · b.ts · in_progress"), { title: "Edit src/a · b.ts", status: "in_progress" });
  assert.deepEqual(parseToolLine("Read file"), { title: "Read file", status: null });
  assert.deepEqual(parseToolLine("Mixed · unusual"), { title: "Mixed · unusual", status: null });
  const tools = new Map([["toolu_1", { toolCallId: "toolu_1", title: "Edit a.ts" }]]);
  assert.deepEqual(parseToolLine("toolu_1 · completed", tools), { title: "Edit a.ts", status: "completed" });
});

test("conversation joins text chunks and collapses tool and plan updates per turn", () => {
  const tools = new Map([["toolu_1", { toolCallId: "toolu_1", title: "Edit a.ts" }]]);
  const turns = conversation([
    entry(1, "t1", "user", "Fix the "), entry(2, "t1", "user", "bug"),
    entry(3, "t1", "agent", "Looking"), entry(4, "t1", "agent", " now."),
    entry(5, "t1", "tool", "Edit a.ts · pending"), entry(6, "t1", "tool", "toolu_1 · completed"),
    entry(7, "t1", "plan", JSON.stringify([{ content: "Read", status: "in_progress" }])),
    entry(8, "t1", "plan", JSON.stringify([{ content: "Read", status: "completed" }, { content: "Edit", status: "pending", priority: "high" }])),
    entry(9, "t1", "agent", "Done."), entry(10, "t1", "turn", "stopped · end_turn"),
    entry(11, "t2", "user", "Also tests"), entry(12, "t2", "notice", "Transcript limit reached"),
  ], tools);
  assert.deepEqual(turns.map((turn) => turn.turnId), ["t1", "t2"]);
  const [first, second] = turns;
  assert.deepEqual(first.items.map((item) => item.kind), ["user", "agent", "tool", "plan", "agent", "turn"]);
  assert.equal(first.items[0].text, "Fix the bug");
  assert.equal(first.items[1].text, "Looking now.");
  assert.deepEqual({ title: first.items[2].title, status: first.items[2].status, updates: first.items[2].updates }, { title: "Edit a.ts", status: "completed", updates: 2 });
  assert.equal(first.items[3].key, "7");
  assert.deepEqual(first.items[3].entries, [{ content: "Read", status: "completed", priority: null }, { content: "Edit", status: "pending", priority: "high" }]);
  assert.deepEqual(second.items.map((item) => item.kind), ["user", "notice"]);
  assert.equal(parsePlan('[{"content":"cut'), null);
});

test("appendBySeq ignores overlap and keeps identity when nothing is new", () => {
  const known = [{ seq: 1 }, { seq: 2 }];
  assert.equal(appendBySeq(known, [{ seq: 2 }]), known);
  assert.deepEqual(appendBySeq(known, [{ seq: 2 }, { seq: 3 }]).map((item) => item.seq), [1, 2, 3]);
});

test("settingsMismatch treats unreported observations as unknown", () => {
  assert.equal(settingsMismatch({ model: "opus", effort: "high" }, null), false);
  assert.equal(settingsMismatch({ model: "opus", effort: "high" }, { model: null, effort: "high" }), false);
  assert.equal(settingsMismatch({ model: "opus", effort: "high" }, { model: "sonnet", effort: "high" }), true);
  assert.equal(settingsMismatch({ model: "opus", effort: "high" }, { model: "opus", effort: "low" }), true);
});

test("WorkerWindowStore follows Workers like chat windows and restores a valid arrangement", () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const windows = new WorkerWindowStore();
  windows.attach(storage);
  assert.equal(windows.show("a"), primaryWorker);
  assert.equal(windows.show("a"), primaryWorker);
  const second = windows.open("b");
  assert.equal(second, "worker-2");
  assert.equal(windows.show("b"), "worker-2");
  assert.equal(windows.show("c"), primaryWorker);
  windows.prune(new Set(["c"]));
  assert.deepEqual(windows.getWindows(), [{ id: "worker", workerId: "c" }]);
  windows.open(null);
  windows.close("worker");
  assert.deepEqual(windows.getWindows(), [{ id: "worker", workerId: null }, { id: "worker-2", workerId: null }]);
  windows.setFilter({ botId: "bot-1" });
  assert.deepEqual(windows.getFilter(), { botId: "bot-1" });

  saved.set("agentstack.uix.workers.v1", JSON.stringify([{ id: "worker-3", workerId: "x" }, { id: "bogus", workerId: "y" }, { id: "worker-3", workerId: "dup" }]));
  const restored = new WorkerWindowStore();
  restored.attach(storage);
  assert.deepEqual(restored.getWindows(), [{ id: "worker", workerId: null }, { id: "worker-3", workerId: "x" }]);
});
