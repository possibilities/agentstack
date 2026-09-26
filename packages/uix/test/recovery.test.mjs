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

test("the index and canvas render a fenced bot honestly", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-uix-recovery-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, NEXT_TELEMETRY_DISABLED: "1" };
  const served = [];
  let next;
  let output = "";
  try {
    const definitions = {
      owner: [operation("owner_status", { pid: process.pid, indexUrl: null, uixUrl: null, inspectorUrl: null, mcpUrls: {}, children: [] })],
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
    const [index, canvas] = await Promise.all(["/", "/x"].map(async (path) => {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, `${path}: ${output}`);
      return response.text();
    }));
    for (const page of [index, canvas]) {
      assert.match(page, /Needs inspection|needs inspection/);
      assert.match(page, /Recorded process ownership could not be verified/);
    }
    assert.match(canvas, /bot-1/);
    assert.match(canvas, /Call a bot/);
    assert.doesNotMatch(index, /bot-1[^<]*Running · PID/);

    const [system, api] = await Promise.all(["/x/fleet?system=open", "/x/fleet?reference=package%3Abots"].map(async (path) => {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, `${path}: ${output}`);
      return response.text();
    }));
    assert.match(system, /Filter System/);
    assert.match(api, /bot_list/);
    assert.equal((await fetch(`${origin}/x/nope`)).status, 404);
    assert.equal((await fetch(`${origin}/x/system`)).status, 404);
    assert.equal((await fetch(`${origin}/x/api`)).status, 404);
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
