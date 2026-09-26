import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serveSocket, socketPath } from "@agentstack/api";

const require = createRequire(import.meta.url);
const uixDir = dirname(dirname(fileURLToPath(import.meta.url)));
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

test("the UI entry redirects to the canvas without losing local links, processes, or Bot recovery details", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-uix-recovery-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, NEXT_TELEMETRY_DISABLED: "1" };
  const served = [];
  let next;
  let output = "";
  try {
    const owner = {
      pid: process.pid, docsUrl: "http://127.0.0.1:43101/docs", indexUrl: "http://127.0.0.1:43102/", uixUrl: "http://127.0.0.1:43102/x",
      inspectorUrl: "http://127.0.0.1:43103/", mcpUrls: { owner: "http://127.0.0.1:43104/mcp/owner" },
      children: [
        { name: "inspector", pid: 9876, running: true, exitCode: null, signal: null, error: null },
        { name: "workers", pid: null, running: false, exitCode: 1, signal: null, error: "Fixture spawn failure" },
      ],
    };
    const definitions = {
      owner: [operation("owner_status", owner)],
      auth: [operation("account_list", { accounts: [] }), operation("account_login_current", { login: null })],
      bots: [operation("bot_list", { bots: [bot] }), operation("bot_defaults_get", bot.settings), operation("voice_status", { call: null })],
      api: [operation("docs_snapshot", { packages: [packageDoc("bots", "bot_list", "bots")] })],
    };
    for (const [name, operations] of Object.entries(definitions)) {
      served.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture socket", path: socketPath(name, env) }, context: {}, operations }));
    }
    const port = await availablePort();
    const nextBin = require.resolve("next/dist/bin/next", { paths: [uixDir] });
    next = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: uixDir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    for (const stream of [next.stdout, next.stderr]) stream?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-8_000); });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (next.exitCode !== null || next.signalCode !== null) throw new Error(`Next exited before ready: ${output}`);
      try { ready = (await fetch(`${origin}/`)).ok; } catch { /* Starting. */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Next did not become ready: ${output}`);
    const entry = await fetch(`${origin}/`, { redirect: "manual" });
    assert.equal(entry.status, 308);
    assert.equal(new URL(entry.headers.get("location"), origin).href, `${origin}/x`);
    // Inspect rendered content, not the serialized snapshot embedded by Next.
    const readCanvas = async (path) => {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, `${path}: ${output}`);
      const html = await response.text();
      const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0];
      assert.ok(main, `Missing canvas: ${path}`);
      return main;
    };
    const canvas = await readCanvas("/");
    assert.match(canvas, /AgentStack Fleet canvas/);
    assert.match(canvas, /Needs inspection|needs inspection/);
    assert.match(canvas, /Recorded process ownership could not be verified/);
    assert.match(canvas, /bot-1/);
    assert.ok(canvas.includes(String(bot.pid)));
    assert.ok(canvas.includes(bot.cwd));
    assert.ok(canvas.includes(bot.url));
    assert.doesNotMatch(canvas, /Local links and bot processes/);

    const [system, api] = await Promise.all(["/x/system", "/x/api"].map(readCanvas));
    for (const value of ["API reference", "MCP Inspector", "MCP endpoints", "inspector", "9876", "workers", "Fixture spawn failure", owner.docsUrl, owner.inspectorUrl, owner.mcpUrls.owner]) {
      assert.ok(system.includes(value), `System is missing ${value}`);
    }
    assert.doesNotMatch(system, /Runtime index/);
    assert.match(api, /bot_list/);

    owner.children[0].running = false;
    owner.children[0].pid = null;
    const stopped = await readCanvas("/x/system");
    assert.doesNotMatch(stopped, /MCP Inspector/);
    assert.match(stopped, /API reference/);

    await served.shift().close();
    const unavailable = await readCanvas("/x/system");
    assert.match(unavailable, /Owner status unavailable/);
    assert.doesNotMatch(unavailable, /MCP Inspector/);
    assert.match(await readCanvas("/x"), /bot-1/);
    assert.equal((await fetch(`${origin}/x/nope`)).status, 404);
    assert.equal((await fetch(`${origin}/x.md`)).status, 404);
    assert.equal((await fetch(`${origin}/index.md`)).status, 404);
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
