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

const { loadResources, mergeHistory, processTree, scopeTarget, formatBytes, formatPercent, formatDuration } = await import("../lib/stack/resources.ts");

const observation = { snapshotId: "snap-1", capturedAt: "2026-01-01T00:00:00Z", ageMs: 100, freshness: "fresh", lastAttemptAt: null, error: null,
  source: "darwin_ps", intervalMs: 5000, staleAfterMs: 14000, collectionDurationMs: 12, coverage: null };
const retention = { maxSamples: 120, maxProcessRecords: 50_000, retainedSamples: 3, oldestAttemptAt: null, newestAttemptAt: null, droppedSamples: 0 };
const capabilities = { rssBytes: true, virtualBytes: true, cpuTimeMs: true, cpuPercent: true, threads: false,
  diskIoBytes: false, openFileDescriptors: false, networkBytes: false, gpu: false, perSessionAllocation: false };
const scope = (id, kind = "component", extra = {}) => ({ id, kind, name: id, component: null, botId: null, accountId: null, runtimeInstance: null, provider: null,
  shared: true, metrics: { processCount: 1, rssBytes: 1, virtualBytes: 1, cpuTimeMs: 1, cpuPercent: 1, cpuMeasuredProcessCount: 1, threads: 1 }, ...extra });
const proc = (id, pid, extra = {}) => ({ id, subtreeId: id.replace("process:", "subtree:"), pid, ppid: 0, birth: "b", name: id,
  parentId: null, ancestryParentId: null, ownership: "descendant", component: "owner", botId: null, accountId: null, runtimeInstance: null,
  provider: null, attribution: "component", attributedAt: null, cpuIntervalMs: null, cpuStatus: "warmup",
  self: { processCount: 1 }, subtree: { processCount: 1 }, ...extra });

test("loadResources pages scopes and processes against the pinned snapshot", async () => {
  const calls = [];
  const read = async (name, args = {}) => {
    calls.push({ name, args });
    if (args.view === "processes") {
      const all = [proc("process:1:a", 1), proc("process:2:b", 2), proc("process:3:c", 3)];
      const offset = args.offset ?? 0;
      const slice = all.slice(offset, offset + 2);
      return { observation, host: null, capabilities, retention, runtime: null, scopes: [], processes: slice,
        page: { offset, limit: 2, total: all.length, nextOffset: offset + 2 < all.length ? offset + 2 : null } };
    }
    const all = [scope("total", "total"), scope("component:owner"), scope("component:bots")];
    const offset = args.offset ?? 0;
    const slice = all.slice(offset, offset + 2);
    return { observation, host: { hostname: "h" }, capabilities, retention, runtime: { pid: 1 }, scopes: slice, processes: [],
      page: { offset, limit: 2, total: all.length, nextOffset: offset + 2 < all.length ? offset + 2 : null } };
  };
  const result = await loadResources(read);
  assert.equal(result.scopes.length, 3);
  assert.equal(result.processes.length, 3);
  assert.equal(result.processTotal, 3);
  assert.equal(result.host.hostname, "h");
  assert.equal(result.runtime.pid, 1);
  assert.deepEqual(calls.map((call) => call.args), [
    { view: "scopes", limit: 100 },
    { snapshotId: "snap-1", view: "scopes", offset: 2, limit: 100 },
    { snapshotId: "snap-1", view: "processes", limit: 100 },
    { snapshotId: "snap-1", view: "processes", offset: 2, limit: 100 },
  ]);
});

test("loadResources skips processes without a snapshot and honors maxProcesses", async () => {
  const read = async () => ({ observation: { ...observation, snapshotId: null }, host: null, capabilities, retention, runtime: null,
    scopes: [], processes: [], page: { offset: 0, limit: 100, total: 0, nextOffset: null } });
  const empty = await loadResources(read);
  assert.equal(empty.processTotal, 0);
  assert.deepEqual(empty.processes, []);

  const calls = [];
  const many = Array.from({ length: 5 }, (_, i) => proc(`process:${i}:x`, i));
  const paging = async (name, args = {}) => {
    calls.push(args);
    if (args.view === "processes") {
      const offset = args.offset ?? 0;
      const slice = many.slice(offset, offset + 2);
      return { observation, host: null, capabilities, retention, runtime: null, scopes: [], processes: slice,
        page: { offset, limit: 2, total: 5, nextOffset: offset + 2 < 5 ? offset + 2 : null } };
    }
    return { observation, host: null, capabilities, retention, runtime: null, scopes: [scope("total", "total")], processes: [],
      page: { offset: 0, limit: 100, total: 1, nextOffset: null } };
  };
  const result = await loadResources(paging, { maxProcesses: 3 });
  assert.equal(result.processes.length, 3);
  assert.equal(result.processTotal, 5);
});

test("mergeHistory unions by attempt, sorts, applies retention and keeps the last 120", () => {
  const point = (id, at, state = "measured") => ({ attemptId: id, attemptedAt: at, snapshotId: null, capturedAt: at, state, error: null, metrics: null, host: null, coverage: null });
  const existing = [point("a1", "2026-01-01T00:00:01Z"), point("a2", "2026-01-01T00:00:02Z")];
  const merged = mergeHistory(existing, [point("a2b", "2026-01-01T00:00:03Z"), point("a2", "2026-01-01T00:00:02Z")], { ...retention, oldestAttemptAt: null });
  assert.deepEqual(merged.map((p) => p.attemptId), ["a1", "a2", "a2b"]);
  const trimmed = mergeHistory(existing, [point("a3", "2026-01-01T00:00:03Z")], { ...retention, oldestAttemptAt: "2026-01-01T00:00:02Z" });
  assert.deepEqual(trimmed.map((p) => p.attemptId), ["a2", "a3"]);
  const wide = Array.from({ length: 130 }, (_, i) => point(`w${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
  const capped = mergeHistory([], wide, { ...retention, oldestAttemptAt: null });
  assert.equal(capped.length, 120);
  assert.equal(capped[0].attemptId, "w10");
  // Incoming order and duplicate across the seam never corrupt the order.
  const seam = mergeHistory([point("b", "2026-01-01T00:00:02Z")], [point("a", "2026-01-01T00:00:01Z"), point("b", "2026-01-01T00:00:02Z", "gap")], retention);
  assert.deepEqual(seam.map((p) => [p.attemptId, p.state]), [["a", "measured"], ["b", "gap"]]);
});

test("processTree walks observed then ancestry parents, orders by pid, and survives cycles", () => {
  const rows = processTree([
    proc("process:30:c", 30, { parentId: "process:20:b" }),
    proc("process:10:a", 10, { ownership: "root" }),
    proc("process:20:b", 20, { parentId: "process:10:a" }),
    proc("process:40:d", 40, { parentId: "process:gone:x", ancestryParentId: "process:20:b" }),
    proc("process:50:e", 50, { ancestryParentId: "process:gone:x" }),
  ]);
  assert.deepEqual(rows.map((row) => [row.process.pid, row.depth, row.hasChildren]), [[10, 0, true], [20, 1, true], [30, 2, false], [40, 2, false], [50, 0, false]]);
  // A and B parent each other: neither is reachable from a root, so both surface as extra roots.
  const cyclic = processTree([proc("process:1:x", 1, { parentId: "process:2:y" }), proc("process:2:y", 2, { parentId: "process:1:x" })]);
  assert.equal(cyclic.length, 2);
  assert.deepEqual(cyclic.map((row) => row.process.pid).sort(), [1, 2]);
});

test("scopeTarget maps each scope kind to its bench destination or null", () => {
  assert.deepEqual(scopeTarget(scope("component:owner", "component", { component: "owner" })), { kind: "owner" });
  assert.deepEqual(scopeTarget(scope("component:bots", "component", { component: "bots" })), { kind: "child", id: "bots" });
  assert.deepEqual(scopeTarget(scope("bot:bot-1", "bot", { botId: "bot-1" })), { kind: "bot", id: "bot-1" });
  assert.deepEqual(scopeTarget(scope("account:bot:a1", "account", { accountId: "a1" })), { kind: "account", id: "a1" });
  assert.deepEqual(scopeTarget(scope("account:worker:w1", "account", { accountId: "w1" })), { kind: "worker-account", id: "w1" });
  assert.deepEqual(scopeTarget(scope("runtime:launch-1", "runtime", { accountId: "w1" })), { kind: "worker-account", id: "w1" });
  assert.deepEqual(scopeTarget(scope("process:1:x", "process")), { kind: "process", id: "process:1:x" });
  assert.equal(scopeTarget(scope("total", "total")), null);
  assert.equal(scopeTarget(scope("subtree:1:x", "subtree")), null);
  assert.equal(scopeTarget(scope("account:mystery", "account", { accountId: null })), null);
});

test("formatters render binary bytes, percents and compact durations", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(831 * 1024 * 1024), "831 MiB");
  assert.equal(formatBytes(1.4 * 1024 * 1024 * 1024), "1.4 GiB");
  assert.equal(formatBytes(1024), "1 KiB");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(87.6), "88%");
  assert.equal(formatPercent(3.24), "3.2%");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(12 * 60), "12m");
  assert.equal(formatDuration(3 * 3600 + 4 * 60), "3h 4m");
  assert.equal(formatDuration(2 * 86400 + 5 * 3600), "2d 5h");
  assert.equal(formatDuration(null), "—");
});
