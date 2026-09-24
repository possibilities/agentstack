import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe } from "@agentstack/api";
import { apiChild, authChild, websocketChild } from "../src/children.js";
import { inspectorChild, inspectorPort } from "../src/inspector.js";
import { botsChild } from "../src/bots.js";
import { codexChild } from "../src/codex.js";
import { startOwner } from "../src/owner.js";
import { statusSource } from "../src/status.js";

const childBin = fileURLToPath(new URL("../../test/fixtures/child.mjs", import.meta.url));

test("the owner stops a child it started", async () => {
  const owner = startOwner([{ name: "fixture", command: process.execPath, args: [childBin] }]);
  await owner.close();
});

test("the owner signals descendants in its process group", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-owner-tree-"));
  const ready = join(dir, "ready");
  const stopped = join(dir, "stopped");
  const helper = `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(stopped)}, "yes"); process.exit(0); }); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "yes"); setInterval(() => {}, 1000);`;
  const parent = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  const owner = startOwner([{ name: "tree", command: process.execPath, args: ["-e", parent] }]);
  try {
    await waitFor(() => existsSync(ready), 5_000);
    await owner.close();
    assert.equal(await readFile(stopped, "utf8"), "yes");
  } finally {
    await owner.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the owner starts the four required socket children", () => {
  for (const child of [apiChild(), authChild(), codexChild(), botsChild()]) {
    assert.equal(child.command, process.execPath);
    assert.deepEqual(child.args.slice(1), [child.name, "socket"]);
    assert.equal(existsSync(child.args[0] ?? ""), true);
  }
  assert.deepEqual([apiChild(), authChild(), codexChild(), botsChild()].map((child) => child.name), ["api", "auth", "codex", "bots"]);
  const websocket = websocketChild();
  assert.equal(websocket.command, process.execPath);
  assert.equal(existsSync(websocket.args[0] ?? ""), true);
  assert.deepEqual(websocket.args.slice(1), ["websocket"]);
  const inspector = inspectorChild("/tmp/mcp.json", 6274);
  assert.equal(inspector.command, process.execPath);
  assert.equal(existsSync(inspector.args[0] ?? ""), true);
  assert.deepEqual(inspector.args.slice(1), ["/tmp/mcp.json"]);
  assert.equal(inspectorPort({}), 6274);
  assert.throws(() => inspectorPort({ AGENTSTACK_INSPECTOR_PORT: "0" }), /AGENTSTACK_INSPECTOR_PORT/);
});

function orphanParent(stateDir: string, keepAlive: boolean) {
  const script = `
    import { startOwner } from ${JSON.stringify(fileURLToPath(new URL("../src/owner.js", import.meta.url)))};
    import { apiChild, authChild } from ${JSON.stringify(fileURLToPath(new URL("../src/children.js", import.meta.url)))};
    import { codexChild } from ${JSON.stringify(fileURLToPath(new URL("../src/codex.js", import.meta.url)))};
    import { botsChild } from ${JSON.stringify(fileURLToPath(new URL("../src/bots.js", import.meta.url)))};
    const owner = startOwner([apiChild(), authChild(), codexChild(), botsChild()], { ...process.env, AGENTSTACK_STATE_DIR: ${JSON.stringify(stateDir)} });
    for (const child of owner.children()) console.log(\`PID \${child.name} \${child.pid}\`);
    ${keepAlive ? "setInterval(() => {}, 1000);" : "process.exit(0);"}
  `;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const pids = new Map<string, number>();
  let pending = "";
  parent.stdout?.setEncoding("utf8");
  parent.stdout?.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(/^PID (\w+) (\d+)$/);
      if (match) pids.set(match[1], Number(match[2]));
    }
  });
  return { parent, pids };
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function connectable(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(path);
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw failure;
}

const sockets = (stateDir: string) => ["api", "auth", "codex", "bots"].map((name) => join(stateDir, "sockets", `${name}.sock`));

test("api children shut down when the owner parent dies abruptly", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-orphan-"));
  const { parent, pids } = orphanParent(stateDir, true);
  const socks = sockets(stateDir);
  try {
    await waitFor(() => pids.size === 4 && socks.every(existsSync), 15_000);
    for (const sock of socks) await connectable(sock);
    parent.kill("SIGKILL");
    await waitFor(() => [apiChild(), authChild(), codexChild(), botsChild()].every((child) => !processAlive(pids.get(child.name))), 15_000);
    await waitFor(() => socks.every((sock) => !existsSync(sock)), 15_000);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    for (const pid of pids.values()) killProcessGroup(pid);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("api children shut down when the owner exits before they finish starting", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-orphan-early-"));
  const { parent, pids } = orphanParent(stateDir, false);
  const socks = sockets(stateDir);
  try {
    await waitFor(() => pids.size === 4, 5_000);
    await waitFor(() => [apiChild(), authChild(), codexChild(), botsChild()].every((child) => !processAlive(pids.get(child.name))), 15_000);
    for (const sock of socks) assert.equal(existsSync(sock), false);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    for (const pid of pids.values()) killProcessGroup(pid);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("owner retains running and failed child statuses", async () => {
  const events: number[] = [];
  const owner = startOwner(
    [
      { name: "fixture", command: process.execPath, args: [childBin] },
      { name: "missing", command: "agentstack-missing-binary", args: [] },
      { name: "exit", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ],
    process.env,
    () => events.push(events.length + 1),
  );
  try {
    await waitFor(() => events.length >= 2 && owner.children().filter((child) => child.running).length === 1, 5_000);
    assert.equal(owner.children().find((child) => child.running)?.name, "fixture");
    assert.match(owner.children().find((child) => child.name === "missing")?.error ?? "", /ENOENT/);
  } finally {
    await owner.close();
  }
  await waitFor(() => events.length >= 3, 5_000);
  assert.equal(owner.children().every((child) => !child.running), true);
});

test("owner close resolves promptly after a failed spawn", async () => {
  const owner = startOwner([{ name: "missing", command: "agentstack-missing-binary", args: [] }]);
  await waitFor(() => owner.children().every((child) => !child.running), 5_000);
  await Promise.race([
    owner.close(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close hung")), 1_000)),
  ]);
});

test("owner api serves status and pids_changed on its socket", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-owner-sock-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const served = await serveApi({ name: "owner", transport: "socket", env });
  const received: string[] = [];
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "owner.sock"));
    const listed = (await socketCall(served.socketPath, "tools/list")) as {
      events: { topics: Record<string, string> } | null;
      tools: Array<{ name: string }>;
    };
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["owner_status"]);
    assert.deepEqual(Object.keys(listed.events?.topics ?? {}), ["pids_changed"]);

    const empty = (await socketCall(served.socketPath, "tools/call", { name: "owner_status", arguments: {} })) as {
      pid: number;
      docsUrl: string | null;
      children: Array<{ name: string; running: boolean }>;
    };
    assert.equal(empty.pid, process.pid);
    assert.equal(empty.docsUrl, null);
    assert.deepEqual(empty.children, []);

    const subscription = await socketSubscribe(served.socketPath ?? "", ["pids_changed"], (topic) => received.push(topic));
    const owner = startOwner(
      [
        { name: "fixture", command: process.execPath, args: [childBin] },
        { name: "exit", command: process.execPath, args: ["-e", "process.exit(0)"] },
      ],
      env,
      () => statusSource.notify(),
    );
    statusSource.attach(owner);
    try {
      const status = (await socketCall(served.socketPath, "tools/call", { name: "owner_status", arguments: {} })) as {
        pid: number;
        children: Array<{ name: string; pid: number | null; running: boolean; exitCode: number | null; signal: string | null; error: string | null }>;
      };
      const fixture = status.children.find((child) => child.name === "fixture");
      assert.equal(status.pid, process.pid);
      assert.equal(fixture?.running, true);
      assert.ok(fixture?.pid);
      assert.equal(fixture?.error, null);
      for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(received, ["pids_changed"]);
    } finally {
      statusSource.detach();
      await owner.close();
    }
    await subscription.close();
  } finally {
    await served.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), "condition was not met before the deadline");
}
