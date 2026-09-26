import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operation, serveSocket, socketCall, socketSubscribe } from "@agentstack/api";
import { z } from "zod";
import { api, ownerResources, ownerResourceHistory, type OwnerContext } from "../api.js";
import { StatusSource } from "../src/status.js";
import { attribute, intervalCpu, selectScope, type ResourceRoots } from "../src/resources/attribution.js";
import { CollectionError, createCollector, parseCpuTime, parseDarwinProcesses, parseLinuxStat, processIdentity, type Collection, type ProcessReading } from "../src/resources/collector.js";
import { createDomainReader, type DomainReading } from "../src/resources/domains.js";
import { ResourceMonitor } from "../src/resources/monitor.js";
import { ownerResourcesOutput, ownerResourceHistoryOutput } from "../src/resources/schema.js";

const roots: ResourceRoots = { pid: 10, attached: true, children: [
  { name: "bots", pid: 20, running: true, exitCode: null, signal: null, error: null },
  { name: "workers", pid: 30, running: true, exitCode: null, signal: null, error: null },
] };
function proc(pid: number, ppid: number, cpuTimeMs = 100, birth = "birth-1"): ProcessReading {
  return { pid, ppid, cpuTimeMs, birth, id: processIdentity(pid, birth), name: `p${pid}`, rssBytes: pid * 100, virtualBytes: pid * 1000, threads: 2 };
}
function collection(processes = [proc(10, 1)], monotonicMs = performance.now()): Collection {
  return { processes, monotonicMs, capturedAt: new Date().toISOString(), unreadableProcesses: 0, vanishedDuringCollection: 0, excludedCollectorProcesses: 0,
    host: { platform: "linux", logicalCpuCount: 4, totalMemoryBytes: 100_000_000, freeMemoryBytes: 10_000_000, loadAverage: [1, 2, 3] } };
}
function domains(): DomainReading {
  return { labels: [
    { pid: 21, component: "bots", botId: "bot-1", accountId: "bot-account", provider: "codex", runtimeInstance: null },
    { pid: 31, component: "workers", botId: null, accountId: "worker-account", provider: "grok", runtimeInstance: "launch-1" },
  ], statuses: ["bots", "workers"].map((source) => ({ source: source as "bots" | "workers", capturedAt: new Date().toISOString(), state: "current", error: null, unmatched: 0 })) };
}
const tree = () => [proc(10, 1), proc(20, 10), proc(21, 20), proc(22, 21), proc(23, 22), proc(30, 10), proc(31, 30), proc(32, 31), proc(99, 1)];

test("macOS ps parsing uses cumulative CPU and byte units without exposing command paths", () => {
  const rows = parseDarwinProcesses("  10 1 Fri Sep 25 09:01:02 2026 123 456 1:23.45 /Applications/Some App/helper\n 11 10 Fri Sep 25 09:01:03 2026 0 0 01:02:03 /bin/tool\n");
  assert.equal(rows[0].cpuTimeMs, 83_450);
  assert.equal(rows[0].rssBytes, 123 * 1024);
  assert.equal(rows[0].virtualBytes, 456 * 1024);
  assert.equal(rows[0].name, "helper");
  assert.equal(rows[0].threads, null);
  assert.equal(rows[1].cpuTimeMs, 3_723_000);
  assert.equal(parseCpuTime("2-01:02:03.50"), 176_523_500);
  assert.throws(() => parseDarwinProcesses("garbage"), /collection_failed/);
  assert.throws(() => parseCpuTime("NaN"), /collection_failed/);
  assert.notEqual(rows[0].id, parseDarwinProcesses("10 1 Fri Sep 25 09:01:04 2026 123 456 0:00.01 /bin/other")[0].id);
});

test("Linux stat parsing handles parentheses/newlines in comm and tick/page conversion", () => {
  const fields = Array(40).fill("0");
  fields[0] = "S"; fields[1] = "10"; fields[11] = "125"; fields[12] = "75"; fields[17] = "6";
  fields[19] = "123456789"; fields[20] = "987654"; fields[21] = "12";
  const row = parseLinuxStat(`42 (tool ) with\nspaces) ${fields.join(" ")}`, "boot-1", 100, 4096);
  assert.equal(row.pid, 42); assert.equal(row.ppid, 10);
  assert.equal(row.cpuTimeMs, 2000); assert.equal(row.threads, 6);
  assert.equal(row.rssBytes, 49152); assert.equal(row.virtualBytes, 987654);
  assert.equal(row.birth, "linux:boot-1:123456789");
  assert.equal(row.name, "tool ) with?spaces");
  assert.throws(() => parseLinuxStat("bad", "boot", 100, 4096), /collection_failed/);
});

test("interval CPU supports multiple cores, warmup, counter reset and PID reuse", () => {
  const old = proc(10, 1, 1000);
  assert.deepEqual(intervalCpu(proc(10, 1, 4500), old, 1000), { percent: 350, interval: 1000, status: "measured" });
  assert.equal(intervalCpu(old, undefined, 1000).status, "warmup");
  assert.equal(intervalCpu(proc(10, 1, 0), old, 1000).status, "reset");
  assert.equal(intervalCpu(old, old, 0).percent, null);
  assert.equal(intervalCpu(proc(10, 1, 2000, "new-birth"), old, 1000).status, "warmup");
});

test("ownership includes descendants and excludes foreign domain PIDs; rollups never double count", () => {
  const labels = domains();
  labels.labels.push({ ...labels.labels[0], pid: 99, botId: "foreign" });
  labels.labels.push({ ...labels.labels[0], pid: 31, botId: "wrong-component" });
  const frame = attribute(collection(tree(), 1000), roots, labels);
  assert.equal(frame.processes.size, 8);
  assert.equal(frame.coverage.domains[0].unmatched, 2);
  assert.equal(frame.scopes.get("total")!.metrics.rssBytes, tree().filter((p) => p.pid !== 99).reduce((sum, p) => sum + p.rssBytes, 0));
  assert.equal(frame.scopes.get("component:bots")!.metrics.processCount, 4);
  assert.equal(frame.scopes.get("bot:bot-1")!.metrics.processCount, 3);
  assert.equal(frame.scopes.get("account:bot:bot-account")!.metrics.processCount, 3);
  assert.equal(frame.scopes.get("runtime:launch-1")!.metrics.processCount, 2);
  assert.equal(frame.scopes.get("account:worker:worker-account")!.metrics.processCount, 2);
  assert.equal(frame.processes.get(proc(21, 20).id)!.self.processCount, 1);
  assert.equal(selectScope(frame, proc(21, 20).id.replace("process:", "subtree:"))!.scope.metrics.processCount, 3);
  assert.equal(frame.scopes.get("total")!.metrics.cpuPercent, null);
  const next = attribute(collection(tree().map((p) => ({ ...p, cpuTimeMs: p.cpuTimeMs + 250 })), 2000), roots, domains(), frame);
  assert.equal(next.scopes.get("total")!.metrics.cpuPercent, 200);
  assert.equal(next.scopes.get("total")!.metrics.cpuMeasuredProcessCount, 8);
  assert.equal(next.scopes.get("runtime:launch-1")!.shared, true);
});

test("retained birth identities survive reparenting and exited intermediaries, never PID reuse", () => {
  const first = attribute(collection(tree(), 1000), roots, domains());
  const remaining = tree().filter((p) => p.pid !== 22).map((p) => p.pid === 23 ? { ...p, ppid: 1 } : p);
  const second = attribute(collection(remaining, 2000), roots, domains(), first);
  const orphan = second.processes.get(proc(23, 22).id)!;
  assert.equal(orphan.ownership, "retained"); assert.equal(orphan.parentId, null);
  assert.equal(orphan.ancestryParentId, proc(22, 21).id);
  assert.equal(orphan.botId, "bot-1");
  assert.equal(second.processes.get(proc(21, 20).id)!.subtree.processCount, 2);
  const third = attribute(collection(remaining.map((p) => p.pid === 23 ? proc(23, 1, 0, "reused") : p), 3000), roots, domains(), second);
  assert.equal([...third.processes.values()].some((p) => p.pid === 23), false);
  const fourth = attribute(collection(tree(), 4000), roots, domains(), third);
  assert.equal(fourth.processes.get(proc(23, 22).id)!.cpuStatus, "warmup", "a vanished process cannot supply an interval baseline");
});

test("source failure retains exact-identity labels and recovers without assigning stale labels to new processes", () => {
  const first = attribute(collection(tree()), roots, domains());
  const failed = domains(); failed.labels = [];
  for (const status of failed.statuses) { status.state = "stale"; status.error = "source_unavailable"; }
  const second = attribute(collection(tree().map((p) => p.pid === 31 ? proc(31, 30, 0, "new") : p)), roots, failed, first);
  assert.equal(second.processes.get(proc(21, 20).id)!.attribution, "retained");
  assert.equal(second.processes.get(proc(31, 30, 0, "new").id)!.accountId, null);
  const third = attribute(collection(tree()), roots, domains(), second);
  assert.equal(third.processes.get(proc(21, 20).id)!.attribution, "current");
  assert.equal(third.processes.get(proc(31, 30).id)!.runtimeInstance, "launch-1");
});

test("nested domain roots partition domain costs; conflicting records do not select a winner", () => {
  const labels = domains(); labels.labels.push({ ...labels.labels[0], pid: 22, botId: "nested" });
  const frame = attribute(collection(tree()), roots, labels);
  assert.equal(frame.scopes.get("bot:bot-1")!.metrics.processCount, 1);
  assert.equal(frame.scopes.get("bot:nested")!.metrics.processCount, 2);
  assert.equal(frame.scopes.get("account:bot:bot-account")!.metrics.processCount, 3);
  assert.equal(frame.processes.get(proc(21, 20).id)!.subtree.processCount, 3);
  labels.labels.push({ ...labels.labels[0], pid: 22, botId: "conflict" });
  const conflict = attribute(collection(tree()), roots, labels);
  assert.ok(!conflict.scopes.has("bot:nested")); assert.ok(!conflict.scopes.has("bot:conflict"));
});

test("standalone API samples only its own process, even with live descendants", () => {
  const frame = attribute(collection(tree()), { ...roots, attached: false, children: [] }, { labels: [], statuses: [] });
  assert.equal(frame.coverage.mode, "self_only"); assert.equal(frame.processes.size, 1);
  assert.throws(() => attribute(collection([]), roots, domains()), /owner_missing/);
  assert.throws(() => attribute(collection([proc(10, 1), ...Array.from({ length: 2048 }, (_, i) => proc(100 + i, 10))]), roots, domains()), /process_limit/);
});

test("deep process trees use bounded iterative attribution and subtree aggregation", () => {
  const items = Array.from({ length: 2048 }, (_, i) => proc(i + 10, i === 0 ? 1 : i + 9));
  const frame = attribute(collection(items), roots, { labels: [], statuses: [] });
  const selected = selectScope(frame, items[0].id.replace("process:", "subtree:"))!;
  assert.equal(selected.scope.metrics.processCount, 2048);
  assert.equal(selected.members.size, 2048);
});

test("cached reads, pinned pagination, bounded history, explicit failure gaps and recovery", async () => {
  let calls = 0;
  let fail = false;
  const monitor = new ResourceMonitor({ roots: () => roots, platform: "linux", maxSamples: 3,
    collect: async () => { calls++; if (fail) throw new CollectionError("collection_timeout"); return collection(tree(), performance.now()); }, domains: async () => domains() });
  try {
    await monitor.sample();
    const first = ownerResourcesOutput.parse(await monitor.resources({ view: "processes", limit: 2 }));
    assert.equal(first.observation.freshness, "fresh"); assert.equal(first.page.total, 8); assert.equal(first.page.nextOffset, 2);
    const firstId = first.observation.snapshotId!;
    await Promise.all(Array.from({ length: 50 }, () => monitor.resources()));
    assert.equal(calls, 1, "API reads must not trigger sampling");
    await monitor.sample();
    const page = await monitor.resources({ snapshotId: firstId, view: "processes", offset: 2, limit: 2 });
    assert.equal(page.observation.snapshotId, firstId); assert.equal(page.processes[0].pid, 21);
    await assert.rejects(monitor.resources({ offset: 1 }), /snapshotId/);
    await assert.rejects(monitor.resources({ scopeId: "bogus" }), /unknown_resource_scope/);
    await assert.rejects(monitor.resources({ limit: 101 }), /100/);
    await assert.rejects(monitor.resources({ view: "processes", kind: "bot" }), /kind/);
    fail = true; await monitor.sample();
    const stale = await monitor.resources();
    assert.equal(stale.observation.freshness, "stale"); assert.equal(stale.observation.error, "collection_timeout");
    assert.equal((await monitor.resources({ snapshotId: firstId })).observation.freshness, "stale");
    assert.equal(stale.scope!.metrics.processCount, 8);
    const history = ownerResourceHistoryOutput.parse(await monitor.history());
    assert.deepEqual(history.points.map((p) => p.state), ["measured", "measured", "gap"]);
    assert.equal(history.points[2].metrics, null);
    fail = false; await monitor.sample();
    assert.equal((await monitor.resources()).observation.freshness, "fresh");
    await assert.rejects(monitor.resources({ snapshotId: firstId }), /unknown_or_expired_snapshot/);
    assert.equal((await monitor.history()).retention.retainedSamples, 3);
    assert.equal((await monitor.history()).truncated, true);
    assert.equal((await monitor.history({ limit: 1 })).points.length, 1);
    await assert.rejects(monitor.history({ scopeId: "missing" }), /unknown_or_expired_resource_scope/);
    await assert.rejects(monitor.history({ since: "2026-09-26T00:00:00Z", until: "2026-09-25T00:00:00Z" }), /since/);
  } finally { await monitor.close(); }
});

test("history absent scopes are null and record-budget pressure shortens retention", async () => {
  let items = [proc(10, 1), ...Array.from({ length: 1099 }, (_, i) => proc(100 + i, 10))];
  const monitor = new ResourceMonitor({ roots: () => roots, maxProcessRecords: 2048, platform: "linux",
    collect: async () => collection(items), domains: async () => domains() });
  try {
    await monitor.sample(); await monitor.sample();
    assert.equal((await monitor.history()).retention.retainedSamples, 1);
    const id = items.at(-1)!.id;
    items = [proc(10, 1)]; await monitor.sample();
    assert.deepEqual((await monitor.history({ scopeId: id })).points.map((p) => p.state), ["measured", "absent"]);
    const result = await monitor.resources({ view: "processes" });
    assert.equal(result.processes.length, 1);
  } finally { await monitor.close(); }
});

test("maximum process pages and history responses retain socket-line headroom", async () => {
  const items = [proc(10, 1), ...Array.from({ length: 200 }, (_, i) => ({ ...proc(100 + i, 10), name: "😀".repeat(60), birth: "b".repeat(160) }))];
  const monitor = new ResourceMonitor({ roots: () => roots, platform: "linux", collect: async () => collection(items), domains: async () => domains() });
  try {
    for (let i = 0; i < 120; i++) await monitor.sample();
    const page = ownerResourcesOutput.parse(await monitor.resources({ view: "processes", limit: 100 }));
    assert.equal(page.processes.length, 100);
    assert.ok(JSON.stringify({ id: 1, result: page }).length < 300_000);
    const history = ownerResourceHistoryOutput.parse(await monitor.history());
    assert.equal(history.points.length, 120);
    assert.ok(JSON.stringify({ id: 1, result: history }).length < 300_000);
  } finally { await monitor.close(); }
});

test("single-flight collection, initial read wait, cancellation and no post-close timer work", async () => {
  let calls = 0;
  let aborted = false;
  const monitor = new ResourceMonitor({ roots: () => roots, intervalMs: 1000,
    collect: (signal) => { calls++; return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })); },
    domains: async () => domains() });
  monitor.start();
  const initial = monitor.resources();
  const samples = Array.from({ length: 20 }, () => monitor.sample());
  assert.equal(calls, 1);
  await monitor.close(); await Promise.all(samples); await initial;
  assert.equal(aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(calls, 1);
  await assert.rejects(monitor.resources(), /resources_closed/);
});

test("attempt deadlines abort and drain collection before publishing a gap", async () => {
  let cancelled = false;
  const monitor = new ResourceMonitor({ roots: () => roots, timeoutMs: 50, domains: async () => domains(),
    collect: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => {
      cancelled = true; reject(signal.reason);
    }, { once: true })),
  });
  try {
    await monitor.sample();
    assert.equal(cancelled, true);
    assert.equal((await monitor.resources()).observation.error, "collection_timeout");
    assert.equal((await monitor.history()).points[0].state, "gap");
  } finally { await monitor.close(); }
});

test("periodic failures are published and unsupported metrics never become zeros", async () => {
  const monitor = new ResourceMonitor({ roots: () => roots, platform: "win32", domains: async () => domains() });
  let events = 0; monitor.onChange = () => { events++; throw new Error("transport closed"); };
  monitor.start();
  try {
    const result = await monitor.resources();
    assert.equal(result.observation.freshness, "unavailable");
    assert.equal(result.observation.error, "unsupported_platform");
    assert.equal(result.scope, null); assert.equal(result.capabilities.cpuPercent, false);
    assert.equal(events, 1); assert.equal((await monitor.history()).points[0].state, "gap");
  } finally { await monitor.close(); }
});

test("automatic sampling recovers from failure and halts after process-capacity exhaustion", { timeout: 6000 }, async () => {
  let calls = 0;
  const monitor = new ResourceMonitor({ roots: () => roots, intervalMs: 1000, domains: async () => domains(), collect: async () => {
    calls++;
    if (calls === 1) throw new CollectionError("collection_failed");
    if (calls === 3) throw new CollectionError("process_capacity");
    return collection();
  } });
  let finish: () => void = () => undefined;
  const exhausted = new Promise<void>((resolve) => { finish = resolve; });
  monitor.onChange = () => { if (calls === 3) finish(); };
  monitor.start();
  try {
    await exhausted;
    assert.deepEqual((await monitor.history()).points.map((p) => p.state), ["gap", "measured", "gap"]);
    assert.equal((await monitor.resources()).observation.error, "process_capacity");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls, 3);
  } finally { await monitor.close(); }
});

test("bounded domain failures are labelled; standalone mode never connects", async () => {
  const state = await mkdtemp(join(tmpdir(), "resource-domains-"));
  const read = createDomainReader({ AGENTSTACK_STATE_DIR: state });
  try {
    const absent = await read(true, new AbortController().signal);
    assert.ok(absent.statuses.every((status) => status.error === "source_unavailable"));
    const standalone = await read(false, new AbortController().signal);
    assert.ok(standalone.statuses.every((status) => status.state === "not_attached" && status.error === null));
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("domain readers validate inventories, flag unverified Bots, retain last-good timestamps and recover", async () => {
  const state = await mkdtemp(join(tmpdir(), "resource-labels-"));
  let bots: unknown = { bots: [
    { id: "healthy", pid: 21, state: "running", recoveryIssue: null, runningAccount: "account-1" },
    { id: "fenced", pid: 99, state: "running", recoveryIssue: "not-owned", runningAccount: "account-2" },
  ] };
  const server = await serveSocket({ info: { path: join(state, "sockets", "bots.sock"), name: "bots", description: "test", transportDescription: "test" },
    context: {}, operations: [operation({ name: "bot_list", description: "Test inventory", input: z.object({}), output: z.unknown(), async call() { return bots; } })] });
  const read = createDomainReader({ AGENTSTACK_STATE_DIR: state });
  try {
    const first = await read(true, new AbortController().signal);
    assert.equal(first.labels.length, 1); assert.equal(first.labels[0].botId, "healthy");
    assert.equal(first.statuses[0].unmatched, 1); assert.equal(first.statuses[0].state, "current");
    const timestamp = first.statuses[0].capturedAt;
    bots = { bots: "bad-schema" };
    const failed = await read(true, new AbortController().signal);
    assert.equal(failed.labels.length, 0); assert.equal(failed.statuses[0].error, "invalid_source");
    assert.equal(failed.statuses[0].capturedAt, timestamp); assert.equal(failed.statuses[0].state, "stale");
    bots = { bots: [] };
    assert.equal((await read(true, new AbortController().signal)).statuses[0].state, "current");
  } finally { await server.close(); await rm(state, { recursive: true, force: true }); }
});

test("resource operations and payload-free invalidations work on the existing socket transport", async () => {
  const state = await mkdtemp(join(tmpdir(), "resource-api-"));
  const resources = new ResourceMonitor({ roots: () => roots, collect: async () => collection(tree()), domains: async () => domains() });
  const context: OwnerContext = { source: new StatusSource(), resources };
  const socket = await serveSocket({ info: { path: join(state, "owner.sock"), name: "owner", description: "test", transportDescription: "test" },
    context, operations: [ownerResources, ownerResourceHistory], events: { topics: api.events!.topics! } });
  const stop = await api.events!.start(context, (topic) => socket.publish!(topic));
  const received: string[] = [];
  const subscription = await socketSubscribe(socket.path, ["resources_changed"], (topic) => received.push(topic));
  try {
    await resources.sample();
    const response = ownerResourcesOutput.parse(await socketCall(socket.path, "tools/call", { name: "owner_resources", arguments: {} }));
    assert.equal(response.scope!.metrics.processCount, 8);
    const history = ownerResourceHistoryOutput.parse(await socketCall(socket.path, "tools/call", { name: "owner_resource_history", arguments: { scopeId: "bot:bot-1" } }));
    assert.equal(history.points[0].metrics!.processCount, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(received, ["resources_changed"]);
    await assert.rejects(socketCall(socket.path, "tools/call", { name: "owner_resources", arguments: { limit: 1000 } }), /limit/);
  } finally { stop?.(); await subscription.close(); await socket.close(); await resources.close(); await rm(state, { recursive: true, force: true }); }
});

test("real bounded collector observes an owned child and grandchild, then reaps both", { timeout: 15_000, skip: process.platform !== "darwin" && process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    grandchild.once('spawn', () => process.send({ pid: grandchild.pid }));
    process.on('message', () => { grandchild.once('exit', () => process.exit(0)); grandchild.kill('SIGTERM'); });
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let grandchildPid: number | undefined;
  try {
    const [message] = await once(child, "message") as [{ pid: number }]; grandchildPid = message.pid;
    const collect = createCollector();
    const first = await collect(AbortSignal.timeout(4000));
    const observedRoots: ResourceRoots = { pid: child.pid!, attached: true, children: [] };
    const frame = attribute(first, observedRoots, { labels: [], statuses: [] });
    assert.ok(frame.processes.has(first.processes.find((p) => p.pid === grandchildPid)!.id));
    assert.equal(frame.processes.size, 2);
    assert.ok(frame.scopes.get("total")!.metrics.rssBytes! > 0);
    assert.ok(first.host.totalMemoryBytes! > 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = attribute(await collect(AbortSignal.timeout(4000)), observedRoots, { labels: [], statuses: [] }, frame);
    assert.equal(second.scopes.get("total")!.metrics.cpuMeasuredProcessCount, 2);
  } finally {
    const exited = once(child, "exit"); child.send({ stop: true }); await exited;
    if (grandchildPid) assert.throws(() => process.kill(grandchildPid!, 0), { code: "ESRCH" });
  }
});
