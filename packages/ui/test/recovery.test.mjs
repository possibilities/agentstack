import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serveSocket, socketPath, withLocalAuth, localCookieName } from "@agentstack/api";

const require = createRequire(import.meta.url);
const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const passthrough = { parse: (value) => value };
const issue = "Recorded process ownership could not be verified. Inspect its PID and endpoint before retrying.";

const record = (id) => ({ id, pid: 4321, cwd: "/tmp/fixture-workspace", url: "unix:///tmp/fixture.sock", state: "running", account: null,
  runningAccount: null, mainThreadId: "thread-fixture", recoveryIssue: issue, roleRevision: 1,
  settings: { model: "gpt-6-sol", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" } });
const bot = record("bot-1");
const operation = (name, value) => ({ name, description: `${name} fixture`, input: passthrough, output: passthrough, async call() { return value; } });
const packageDoc = (name, operationName, collection) => ({
  name, description: `${name} fixture`, packageName: `@agentstack/${name}`, events: {}, eventScope: null, transports: [],
  operations: [{ name: operationName, title: operationName, description: "Fixture list", annotations: {}, inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { [collection]: { type: "array", items: { type: "object", properties: {
      recoveryIssue: { type: ["string", "null"], description: "Why recovery needs inspection." },
    } } } } } }],
});

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test("the root UI renders the canvas without losing local links, processes, or Bot recovery details", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-ui-recovery-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_WEBSOCKET_PORT: "0", NEXT_TELEMETRY_DISABLED: "1" };
  const served = [];
  let next;
  let output = "";
  try {
    const server = {
      pid: process.pid, startedAt: new Date(Date.now() - 60_000).toISOString(), nodeVersion: process.version,
      indexUrl: "http://127.0.0.1:43102/", uiUrl: "http://127.0.0.1:43102/",
      inspectorUrl: "http://127.0.0.1:43103/", mcpUrls: { serve: "http://127.0.0.1:43104/mcp/serve" },
      children: [
        { name: "inspector", pid: 9876, running: true, exitCode: null, signal: null, error: null, startedAt: new Date(Date.now() - 50_000).toISOString(), exitedAt: null },
        { name: "worker", pid: null, running: false, exitCode: 1, signal: null, error: "Fixture spawn failure", startedAt: null, exitedAt: new Date(Date.now() - 40_000).toISOString() },
      ],
    };
    const metric = (processCount, rssBytes) => ({ processCount, rssBytes, virtualBytes: rssBytes * 3, cpuTimeMs: 2_400, cpuPercent: 4.2, cpuMeasuredProcessCount: processCount, threads: null });
    const resources = {
      observation: {
        snapshotId: "fixture-snap-1", capturedAt: new Date().toISOString(), ageMs: 400, freshness: "fresh",
        lastAttemptAt: new Date().toISOString(), error: null, source: "darwin_ps", intervalMs: 5_000, staleAfterMs: 14_000, collectionDurationMs: 18,
        coverage: { mode: "server_tree", observedHostProcesses: 512, ownedProcesses: 4, unreadableProcesses: 0, vanishedDuringCollection: 0, retainedProcesses: 0, excludedCollectorProcesses: 1, domains: [] },
      },
      host: { platform: "darwin", logicalCpuCount: 8, hostname: "fixture-host", arch: "arm64", release: "24.5.0", cpuModel: "Apple M4", uptimeSeconds: 86_400, totalMemoryBytes: 16_000_000_000, freeMemoryBytes: 2_000_000_000, loadAverage: [1.5, 1.2, 1.1] },
      capabilities: { rssBytes: true, virtualBytes: true, cpuTimeMs: true, cpuPercent: true, threads: false,
        diskIoBytes: false, openFileDescriptors: false, networkBytes: false, gpu: false, perSessionAllocation: false },
      retention: { maxSamples: 120, maxProcessRecords: 50_000, retainedSamples: 1, oldestAttemptAt: new Date().toISOString(), newestAttemptAt: new Date().toISOString(), droppedSamples: 0 },
      runtime: { pid: process.pid, nodeVersion: process.version, uptimeSeconds: 60, heapUsedBytes: 24_000_000, heapTotalBytes: 40_000_000, externalBytes: 2_000_000, arrayBuffersBytes: 100_000, eventLoopUtilization: null },
      scope: null,
      scopes: [
        { id: "total", kind: "total", name: "AgentStack", component: null, botId: null, accountId: null, runtimeInstance: null, provider: null, shared: true, metrics: metric(4, 120_000_000) },
        { id: "component:serverr", kind: "component", name: "serve", component: "server", botId: null, accountId: null, runtimeInstance: null, provider: null, shared: true, metrics: metric(1, 40_000_000) },
        { id: "component:inspector", kind: "component", name: "inspector", component: "inspector", botId: null, accountId: null, runtimeInstance: null, provider: null, shared: true, metrics: metric(1, 30_000_000) },
      ],
      processes: [
        { id: "process:1:root", subtreeId: "subtree:1:root", pid: process.pid, ppid: 1, birth: "b1", name: "agentstack", parentId: null, ancestryParentId: null, ownership: "root", component: "server",
          botId: null, accountId: null, runtimeInstance: null, provider: null, attribution: "component", attributedAt: null, cpuIntervalMs: 5_000, cpuStatus: "measured", self: metric(1, 40_000_000), subtree: metric(4, 120_000_000) },
        { id: "process:2:child", subtreeId: "subtree:2:child", pid: 9876, ppid: process.pid, birth: "b2", name: "inspector", parentId: "process:1:root", ancestryParentId: "process:1:root", ownership: "descendant", component: "inspector",
          botId: null, accountId: null, runtimeInstance: null, provider: null, attribution: "component", attributedAt: null, cpuIntervalMs: 5_000, cpuStatus: "measured", self: metric(1, 30_000_000), subtree: metric(1, 30_000_000) },
      ],
      page: { offset: 0, limit: 100, total: 2, nextOffset: null },
    };
    const history = {
      scopeId: "total", intervalMs: 5_000, truncated: false, retention: resources.retention,
      points: [{ attemptId: "a1", attemptedAt: new Date().toISOString(), snapshotId: "fixture-snap-1", capturedAt: new Date().toISOString(), state: "measured", error: null, metrics: metric(4, 120_000_000), host: resources.host, coverage: resources.observation.coverage }],
    };
    const definitions = {
      serve: [operation("serve_status", server), operation("serve_resources", resources), operation("serve_resource_history", history)],
      auth: [operation("account_list", { accounts: [] }), operation("account_login_current", { login: null }), operation("worker_account_list", { accounts: [] }), operation("worker_account_login_current", { logins: [] })],
      bots: [operation("bot_list", { bots: [bot] }), operation("bot_defaults_get", bot.settings), operation("voice_status", { call: null })],
      workers: [operation("worker_runtime_list", { runtimes: [] }), operation("worker_list", { workers: [] })],
      usage: [operation("usage_snapshot", { atMs: Date.now(), inventoryAtMs: null, inventoryError: null, accounts: [], grokBot: { observedAtMs: null, lastAttemptAtMs: null, fresh: false, error: "not_observed", usage: null } })],
      api: [operation("docs_snapshot", { packages: [packageDoc("bots", "bot_list", "bots"), packageDoc("brain", "brain_catalog_probe", "documents")] })],
    };
    for (const [name, operations] of Object.entries(definitions)) {
      served.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture socket", path: socketPath(name, env) }, context: {}, operations }));
    }
    const port = await availablePort();
    const nextBin = require.resolve("next/dist/bin/next", { paths: [uiDir] });
    next = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: uiDir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    for (const stream of [next.stdout, next.stderr]) stream?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8_000); });
    const origin = `http://127.0.0.1:${port}`;
    const session = withLocalAuth(env, auth => auth.redeem(auth.bootstrap(origin, "ui"), origin, "ui"));
    const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { cookie: `${localCookieName("ui")}=${session.token}` } });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (next.exitCode !== null || next.signalCode !== null) throw new Error(`Next exited before ready: ${output}`);
      try { ready = (await fetch(`${origin}/`)).ok; } catch { /* Starting. */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Next did not become ready: ${output}`);
    const refused = await globalThis.fetch(`${origin}/`);
    assert.equal(refused.status, 401);
    assert.ok(!(await refused.text()).includes(bot.cwd));
    const entry = await fetch(`${origin}/`, { redirect: "manual" });
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get("location"), null);
    // Inspect rendered content, not the serialized snapshot embedded by Next.
    const readCanvas = async (path) => {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, `${path}: ${output}`);
      const html = await response.text();
      const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0];
      assert.ok(main, `Missing canvas: ${path}`);
      return main;
    };
    const readDock = async (path, side) => {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, `${path}: ${output}`);
      const html = await response.text();
      const dock = html.match(new RegExp(`<aside\\b[^>]*data-dock="${side}"[^>]*>[\\s\\S]*?<\\/aside>`))?.[0];
      assert.ok(dock, `Missing ${side} dock: ${path}`);
      return dock;
    };
    const canvas = await readCanvas("/");
    assert.match(canvas, /AgentStack open bench/);
    assert.match(canvas, /Needs inspection|needs inspection/);
    assert.match(canvas, /Recorded process ownership could not be verified/);
    assert.match(canvas, /bot-1/);
    assert.ok(canvas.includes(String(bot.pid)));
    assert.ok(canvas.includes(bot.cwd));
    assert.ok(canvas.includes(bot.url));
    assert.doesNotMatch(canvas, /Local links and bot processes/);

    const [system, api, brainReference] = await Promise.all([
      readCanvas("/system"),
      readDock("/?reference=package%3Abots", "right"),
      readDock("/?reference=package%3Abrain", "right"),
    ]);
    assert.match(system, /Filter activity/);
    for (const value of ["MCP Inspector", "Packages", "inspector", "9876", "worker", "Fixture spawn failure", server.inspectorUrl, server.mcpUrls.serve,
      "fixture-host", "Apple M4", "Fresh", "server_tree", "AgentStack", "darwin_ps"]) {
      assert.ok(system.includes(value), `System is missing ${value}`);
    }
    assert.doesNotMatch(system, /Runtime index/);
    assert.doesNotMatch(system, /data-dock="left"/);
    assert.match(api, /bot_list/);
    assert.match(brainReference, /brain_catalog_probe/);
    assert.match(brainReference, /@agentstack\/brain/);

    server.children[0].running = false;
    server.children[0].pid = null;
    const stopped = await readCanvas("/system");
    assert.doesNotMatch(stopped, /MCP Inspector/);
    assert.match(stopped, /inspector/);

    await served.shift().close();
    const unavailable = await readCanvas("/system");
    assert.match(unavailable, /Server status unavailable/);
    assert.match(unavailable, /No resource data/);
    assert.doesNotMatch(unavailable, /MCP Inspector/);
    assert.match(await readCanvas("/"), /bot-1/);
    assert.equal((await fetch(`${origin}/nope`)).status, 404);
    assert.equal((await fetch(`${origin}/x`)).status, 404);
    assert.equal((await fetch(`${origin}/x/system`)).status, 404);
    assert.equal((await fetch(`${origin}/fleet`)).status, 404);
    assert.equal((await fetch(`${origin}/system`)).status, 200);
    assert.equal((await fetch(`${origin}/api`)).status, 404);
    assert.equal((await fetch(`${origin}/x.md`)).status, 404);
    assert.equal((await fetch(`${origin}/index.md`)).status, 404);
    withLocalAuth(env, auth => auth.rotate());
    assert.equal((await fetch(`${origin}/`)).status, 401);
  } finally {
    if (next?.pid) {
      try { process.kill(process.platform === "win32" ? next.pid : -next.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      let timer;
      if (next.exitCode === null && next.signalCode === null) {
        await Promise.race([
          new Promise((resolve) => next.once("exit", resolve)),
          new Promise((resolve) => { timer = setTimeout(resolve, 2_000); }),
        ]);
        if (timer) clearTimeout(timer);
      }
      if (next.exitCode === null && next.signalCode === null) {
        try { process.kill(process.platform === "win32" ? next.pid : -next.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    await Promise.allSettled(served.map((socket) => socket.close()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
