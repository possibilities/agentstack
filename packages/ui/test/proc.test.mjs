import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

// Load the pure stack modules directly without a Next build. Their
// bundler-style imports need extensions when loaded by Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { blockedCopy, cadence, errorCopy, executionView, filterRuns, filterSchedules, formatLimitBytes, groupRuns, groupSchedules,
  joinPartials, lineGaps, maskActionEnv, ownerLabel, ownerOf, runTitle, runView, scheduleTitle, stripAnsi } = await import("../lib/stack/proc.ts");

const operator = { kind: "operator" };
const system = { kind: "system", name: "brain-source-sync" };
const bot = { kind: "bot", botId: "bot-1", mainThreadId: "main-1", threadId: "t-1" };
const legacy = { kind: "legacy_unknown" };
const brainId = "00000000-0000-4000-8000-000000000001";

const apiAction = (pkg = "notify", operation = "notify_push", input = {}) => ({ type: "api", package: pkg, operation, input });
const processAction = (command = "/usr/bin/env", args = [], extra = {}) =>
  ({ type: "process", process: { command, args, cwd: null, env: null, timeoutMs: null, retainOutput: true, ...extra } });
const schedule = (id, extra = {}) => ({
  id, revision: 1, label: null, action: apiAction(), firstAt: "2026-01-01T00:00:00Z", everyMs: null, enabled: true,
  system: false, createdBy: operator, lastEditedBy: operator, authority: operator,
  blockedReason: null, retryAt: null, removedAt: null, nextAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  recent: [], ...extra,
});
const execution = (state, extra = {}) => ({ id: `ex-${state}-${Math.random().toString(36).slice(2, 8)}`, startedAt: "2026-01-01T00:00:00Z", state, error: null, ...extra });
const run = (id, state, extra = {}) => ({
  id, requestId: null, label: null, command: "/bin/echo", state, startedAt: "2026-01-01T00:00:00Z", finishedAt: null,
  exitCode: null, signal: null, error: null, createdBy: operator, scheduleId: null, scheduleExecutionId: null,
  lineCount: 0, outputTruncated: false, retainOutput: true, pid: null, ...extra,
});
const line = (seq, stream, text, partial = false) => ({ seq, stream, text, partial });

test("scheduleTitle prefers the label, names the system Brain schedule, and describes actions", () => {
  assert.equal(scheduleTitle(schedule("s1", { label: "Digest" })), "Digest");
  assert.equal(scheduleTitle(schedule(brainId, { system: true, authority: system, createdBy: system })), "Brain source sync");
  assert.equal(scheduleTitle(schedule("s2", { action: apiAction("brain", "sources_sync") })), "brain.sources_sync");
  assert.equal(scheduleTitle(schedule("s3", { action: processAction("/opt/homebrew/bin/ffmpeg", ["-y", "x"]) })), "ffmpeg -y");
  const long = `/bin/${"a".repeat(70)}`;
  assert.ok(scheduleTitle(schedule("s4", { action: processAction(long) })).length <= 63);
});

test("runTitle prefers the label, then the executable, then a short ID", () => {
  assert.equal(runTitle(run("r1", "running", { label: "Snapshot" })), "Snapshot");
  assert.equal(runTitle(run("r2", "running", { command: "/opt/homebrew/bin/ffmpeg" })), "ffmpeg");
  assert.equal(runTitle(run("0fd9d71a-8b46-4c79-9e1a-3a05f1f2f5d2", "running", { command: null })), "Process run 0fd9d71a");
});

test("ownerOf resolves operator, system, Bot and unattributed callers", () => {
  assert.deepEqual(ownerOf(operator), { kind: "operator" });
  assert.deepEqual(ownerOf(system), { kind: "system" });
  assert.deepEqual(ownerOf(bot), { kind: "bot", botId: "bot-1", threadId: "main-1" });
  assert.deepEqual(ownerOf(null), { kind: "unattributed" });
  assert.deepEqual(ownerOf(legacy), { kind: "unattributed" });
  assert.deepEqual(ownerOf({ ...bot, botId: "bot-2", mainThreadId: "m-2" }), { kind: "bot", botId: "bot-2", threadId: "m-2" });
  assert.equal(ownerLabel(ownerOf(bot)), "bot-1");
});

test("cadence writes every-interval text", () => {
  assert.equal(cadence(null), "once");
  assert.equal(cadence(45_000), "every 45 s");
  assert.equal(cadence(300_000), "every 5 min");
  assert.equal(cadence(3_600_000), "every 1 h");
  assert.equal(cadence(5_400_000), "every 1 h 30 min");
  assert.equal(cadence(86_400_000), "every 1 d");
  assert.equal(cadence(93_600_000), "every 1 d 2 h");
});

test("groupSchedules puts what needs a person first, then held, upcoming, off and removed", () => {
  const needs = [
    schedule("reauth", { authority: null, blockedReason: "legacy_reauthorization_required", enabled: false }),
    schedule("blocked", { blockedReason: "bot_removed", retryAt: null }),
    schedule("failed", { recent: [execution("failed")] }),
    schedule("unknown", { recent: [execution("unknown")] }),
  ];
  const held = [schedule("waiting", { blockedReason: "bot_not_running", retryAt: "2026-01-01T00:10:00Z" })];
  const upcoming = [schedule("later", { nextAt: "2026-01-03T00:00:00Z" }), schedule("sooner", { nextAt: "2026-01-02T00:00:00Z" })];
  const off = [
    schedule("disabled", { enabled: false }),
    schedule("done", { recent: [execution("completed")], nextAt: null }),
    schedule("quiet-bot-fail", { authority: bot, recent: [execution("failed")] }),
  ];
  const removed = [schedule("gone", { removedAt: "2026-01-02T00:00:00Z", authority: null })];
  const groups = groupSchedules([...off, ...needs, ...upcoming, ...held, ...removed]);
  const ids = (group) => groups.get(group).map((item) => item.id);
  assert.deepEqual(ids("attention"), ["reauth", "blocked", "failed", "unknown"]);
  assert.deepEqual(ids("held"), ["waiting"]);
  assert.deepEqual(ids("upcoming"), ["sooner", "later"]);
  assert.deepEqual(ids("off").sort(), ["disabled", "done", "quiet-bot-fail"].sort());
  assert.deepEqual(ids("removed"), ["gone"]);
});

test("groupSchedules sorts upcoming by nextAt and removed by removedAt, newest first", () => {
  const groups = groupSchedules([
    schedule("old", { removedAt: "2026-01-01T00:00:00Z" }),
    schedule("new", { removedAt: "2026-01-05T00:00:00Z" }),
  ]);
  assert.deepEqual(groups.get("removed").map((item) => item.id), ["new", "old"]);
});

test("filterSchedules matches owner roots and kinds", () => {
  const list = [
    schedule("op"), schedule("sys", { system: true, authority: system, createdBy: system }),
    schedule("b1", { authority: bot }), schedule("b2", { authority: { ...bot, botId: "bot-2" } }),
    schedule("un", { authority: null, createdBy: legacy }),
    schedule("proc", { authority: bot, action: processAction("/bin/true") }),
  ];
  assert.deepEqual(filterSchedules(list, {}).map((s) => s.id), list.map((s) => s.id));
  assert.deepEqual(filterSchedules(list, { owner: "operator" }).map((s) => s.id), ["op"]);
  assert.deepEqual(filterSchedules(list, { owner: "system" }).map((s) => s.id), ["sys"]);
  assert.deepEqual(filterSchedules(list, { owner: "bot-1" }).map((s) => s.id), ["b1", "proc"]);
  assert.deepEqual(filterSchedules(list, { owner: "unattributed" }).map((s) => s.id), ["un"]);
  assert.deepEqual(filterSchedules(list, { kind: "process" }).map((s) => s.id), ["proc"]);
  assert.deepEqual(filterSchedules(list, { kind: "api" }).map((s) => s.id), ["op", "sys", "b1", "b2", "un"]);
});

test("groupRuns flags live and recent bad exits inside 24 h, then bins the rest", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const list = [
    run("live", "running", { startedAt: at(1) }),
    run("pre", "starting", { startedAt: at(0) }),
    run("bad", "failed", { finishedAt: at(2) }),
    run("exit3", "exited", { exitCode: 3, finishedAt: at(4) }),
    run("mystery", "unknown", { finishedAt: at(6) }),
    run("old-fail", "failed", { finishedAt: at(30) }),
    run("ok", "exited", { exitCode: 0, finishedAt: at(1) }),
    run("halted", "cancelled", { finishedAt: at(1) }),
  ];
  const groups = groupRuns(list, now);
  const ids = (group) => groups.get(group).map((item) => item.id);
  assert.deepEqual(ids("running"), ["pre", "live"]);
  assert.deepEqual(ids("attention"), ["bad", "exit3", "mystery"]);
  assert.deepEqual(ids("finished"), ["old-fail", "ok", "halted"]);
  // Newest first within a group.
  const sorted = groupRuns([run("a", "exited", { exitCode: 1, startedAt: at(5), finishedAt: at(4) }), run("b", "exited", { exitCode: 1, startedAt: at(1), finishedAt: at(0) })], now);
  assert.deepEqual(sorted.get("attention").map((item) => item.id), ["b", "a"]);
});

test("filterRuns matches owners", () => {
  const list = [run("a", "exited"), run("b", "exited", { createdBy: { kind: "bot", botId: "bot-1", threadId: "t" } }), run("c", "exited", { createdBy: legacy })];
  assert.deepEqual(filterRuns(list, {}).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(filterRuns(list, { owner: "bot-1" }).map((item) => item.id), ["b"]);
  assert.deepEqual(filterRuns(list, { owner: "unattributed" }).map((item) => item.id), ["c"]);
});

test("blockedCopy and errorCopy write plain words and fall back to the raw code", () => {
  assert.equal(blockedCopy("bot_removed"), "Its Bot was removed");
  assert.equal(blockedCopy("legacy_reauthorization_required"), "Created before attribution; needs your reauthorization");
  assert.equal(blockedCopy("something_new"), "something_new");
  assert.equal(errorCopy("call_outcome_unknown"), "Sent, but no reply arrived. It may have taken effect; Proc won't retry.");
  assert.equal(errorCopy("process_timeout"), "Stopped after its timeout.");
  assert.equal(errorCopy("something_new"), "something_new");
});

test("executionView and runView map every state to a word and tone", () => {
  assert.deepEqual(executionView.running, { word: "Running", tone: "info" });
  assert.deepEqual(executionView.unknown, { word: "Unknown", tone: "warning" });
  assert.equal(runView(run("r", "exited", { exitCode: 0 })).word, "Exited 0");
  assert.equal(runView(run("r", "exited", { exitCode: 3 })).word, "Exited 3");
  assert.equal(runView(run("r", "exited", { exitCode: 0 })).tone, "success");
  assert.equal(runView(run("r", "failed", { error: "process_timeout" })).word, "Timed out");
  assert.equal(runView(run("r", "failed", { error: "spawn_failed" })).word, "Failed");
  assert.equal(runView(run("r", "cancelled")).word, "Stopped");
  assert.equal(runView(run("r", "starting")).tone, "info");
});

test("joinPartials merges a split line under its first seq and keeps a trailing partial", () => {
  const joined = joinPartials([
    line(1, "stdout", "one"),
    line(2, "stderr", "two"),
    line(3, "stdout", "part ", true), line(4, "stdout", "of ", true), line(5, "stdout", "line"),
    line(6, "stderr", "err ", true), line(7, "stderr", "line"),
    line(8, "stdout", "tail", true),
  ]);
  assert.deepEqual(joined.map((entry) => entry.seq), [1, 2, 3, 6, 8]);
  assert.equal(joined[2].text, "part of line");
  assert.equal(joined[2].partial, false);
  assert.equal(joined[3].text, "err line");
  assert.equal(joined[4].partial, true);
  // Different streams never merge, even mid-partial.
  assert.deepEqual(joinPartials([line(1, "stdout", "a", true), line(2, "stderr", "b")]).map((entry) => entry.seq), [1, 2]);
});

test("stripAnsi removes CSI, OSC and other C0 controls but keeps tab", () => {
  assert.equal(stripAnsi("[31mred[0m plain"), "red plain");
  assert.equal(stripAnsi("[2K[1Gdone"), "done");
  assert.equal(stripAnsi("[38;5;196mcolor"), "color");
  assert.equal(stripAnsi("titleso"), "titleso");
  assert.equal(stripAnsi("a\tb"), "a\tb");
  assert.equal(stripAnsi("bellover"), "bellover");
});

test("lineGaps finds flagged boundaries, seq jumps and unbounded tails", () => {
  assert.deepEqual(lineGaps(0, [line(1, "stdout", "a"), line(5, "stdout", "b")], false),
    [{ afterSeq: 1, from: 2, to: 4 }]);
  assert.deepEqual(lineGaps(10, [line(13, "stdout", "a")], true),
    [{ afterSeq: 10, from: 11, to: 12 }]);
  assert.deepEqual(lineGaps(5, [], true), [{ afterSeq: 5, from: 6, to: null }]);
  assert.deepEqual(lineGaps(0, [line(1, "stdout", "a"), line(2, "stdout", "b")], false), []);
});

test("formatLimitBytes writes the bound in words", () => {
  assert.equal(formatLimitBytes(2_000_000), "2 MB");
  assert.equal(formatLimitBytes(1_048_576), "1.048576 MB");
  assert.equal(formatLimitBytes(10_000), "10 KB");
});

test("maskActionEnv masks process env values but keeps keys and other actions", () => {
  const schedule = { id: "s1", action: { type: "process", process: { command: "/bin/echo", args: [], env: { API_TOKEN: "s3cret", OTHER: "x" }, timeoutMs: null, retainOutput: true } } };
  const masked = maskActionEnv(schedule);
  assert.deepEqual(masked.action.process.env, { API_TOKEN: "••••••", OTHER: "••••••" });
  assert.equal(masked.action.process.command, "/bin/echo");
  assert.equal(masked.action.type, "process");
  assert.equal(schedule.action.process.env.API_TOKEN, "s3cret", "the input record is untouched");
  const api = { id: "s2", action: { type: "api", package: "notify", operation: "notify_push", input: {} } };
  assert.equal(maskActionEnv(api), api, "api actions return the same object");
  const nullAction = { id: "e1", action: null };
  assert.equal(maskActionEnv(nullAction), nullAction, "legacy executions have no action");
});
