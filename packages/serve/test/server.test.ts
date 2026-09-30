import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe } from "@stack/api";
import { apiChild, signalChild, authChild, brainChild, xcomChild, browseChild, contentChild, inferChild, notifyChild, procChild, rolesChild, scrapeChild, workerChild, websocketChild } from "../src/children.js";
import { inspectorChild, inspectorPort } from "../src/inspector.js";
import { botsChild } from "../src/bots.js";
import { startServer } from "../src/server.js";
import { statusSource } from "../src/status.js";
import { uiChild, uiPort } from "../src/ui.js";

const childBin = fileURLToPath(new URL("../../test/fixtures/child.mjs", import.meta.url));
const guardedServerBin = fileURLToPath(new URL("../src/guarded-server.js", import.meta.url));

test("the server stops a child it started", async () => {
  const server = startServer([{ name: "fixture", command: process.execPath, args: [childBin] }]);
  await server.close();
});

test("the server signals descendants in its process group", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-server-tree-"));
  const ready = join(dir, "ready");
  const stopped = join(dir, "stopped");
  const helper = `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(stopped)}, "yes"); process.exit(0); }); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "yes"); setInterval(() => {}, 1000);`;
  const parent = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  const server = startServer([{ name: "tree", command: process.execPath, args: ["-e", parent] }]);
  try {
    await waitFor(() => existsSync(ready), 5_000);
    await server.close();
    assert.equal(await readFile(stopped, "utf8"), "yes");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser lifecycle parent drains before its Hypeman-like descendant is signalled", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-browser-drain-"));
  const ready = join(dir, "ready"), drained = join(dir, "drained"), stopped = join(dir, "stopped");
  const helper = `const fs=require("node:fs"); process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(stopped)},fs.existsSync(${JSON.stringify(drained)})?"after":"before");process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},"ready");setInterval(()=>{},1000);`;
  const parent = `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(helper)}],{stdio:"ignore"});process.on("SIGTERM",()=>{setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(drained)},"flushed");child.kill("SIGTERM");child.once("exit",()=>process.exit(0));},100)});setInterval(()=>{},1000);`;
  const server = startServer([{ name: "browse", command: process.execPath, args: ["-e", parent], parentFirst: true }]);
  try {
    await waitFor(() => existsSync(ready), 5_000); await server.close();
    assert.equal(await readFile(stopped, "utf8"), "after");
    assert.equal(browseChild().parentFirst, true);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the UI guardian closes its listener when the server disappears", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-ui-guardian-"));
  const ready = join(dir, "ready.json");
  const script = `
    const fs = require("node:fs"), net = require("node:net");
    process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
    const server = net.createServer(() => {});
    server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(ready)},
      JSON.stringify({ pid: process.pid, port: server.address().port })));
  `;
  const guardian = spawn(process.execPath, [guardedServerBin, process.execPath, "-e", script],
    { stdio: ["ignore", "ignore", "inherit", "ipc"], detached: true });
  let serverPid: number | undefined;
  try {
    await waitFor(() => existsSync(ready), 5_000);
    const { pid, port } = JSON.parse(await readFile(ready, "utf8")) as { pid: number; port: number };
    serverPid = pid;
    assert.notEqual(guardian.pid, serverPid, "the Next-like listener is a distinct process");
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    });
    guardian.disconnect(); // The server died before its staged shutdown completed.
    await waitFor(() => !processAlive(serverPid), 5_000);
    await waitFor(() => guardian.exitCode !== null, 5_000);
    assert.equal(guardian.exitCode, 0);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    }), /ECONNREFUSED/);
  } finally {
    if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill("SIGKILL");
    killProcessGroup(serverPid);
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown drains a dependent child before stopping its dependency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-server-drain-"));
  const ingressStopped = join(dir, "ingress-stopped");
  const botStopped = join(dir, "bot-stopped");
  const drained = join(dir, "drained");
  const script = (name: string) => `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(join(dir, `${name}-ready`))}, "ready");
    process.on("SIGTERM", () => {
      if (${JSON.stringify(name)} === "auth") {
        const safe = fs.existsSync(${JSON.stringify(ingressStopped)}) && !fs.existsSync(${JSON.stringify(botStopped)});
        setTimeout(() => { fs.writeFileSync(${JSON.stringify(drained)}, safe ? "yes" : "no"); process.exit(0); }, 100);
      } else {
        fs.writeFileSync(${JSON.stringify(name === "ingress" ? ingressStopped : botStopped)}, "stopped");
        process.exit(0);
      }
    });
    setInterval(() => {}, 1000);
  `;
  const server = startServer(["ingress", "auth", "bots"].map((name) => ({ name, command: process.execPath, args: ["-e", script(name)] })), process.env, undefined, [["auth"], ["bots"]]);
  try {
    await waitFor(() => ["ingress", "auth", "bots"].every((name) => existsSync(join(dir, `${name}-ready`))), 5_000);
    await server.stop(["ingress"]);
    await server.close();
    assert.equal(await readFile(drained, "utf8"), "yes");
    assert.ok(existsSync(botStopped));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server starts the required socket children", () => {
  for (const child of [apiChild(), signalChild(), authChild(), rolesChild(), botsChild(), workerChild(), inferChild(), notifyChild(), contentChild(), brainChild(), xcomChild(), procChild(), browseChild(), scrapeChild()]) {
    assert.equal(child.command, process.execPath);
    assert.deepEqual(child.args.slice(1), [child.name, "socket"]);
    assert.equal(existsSync(child.args[0] ?? ""), true);
  }
  assert.deepEqual([apiChild(), signalChild(), authChild(), rolesChild(), botsChild(), workerChild(), inferChild(), notifyChild(), contentChild(), brainChild(), xcomChild(), procChild(), browseChild(), scrapeChild()].map((child) => child.name), ["api", "signal", "auth", "roles", "bots", "worker", "infer", "notify", "content", "brain", "xcom", "proc", "browse", "scrape"]);
  assert.equal(procChild().parentFirst, true);
  assert.deepEqual(botsChild(43123).env, { STACK_SERVER_MCP_PORT: "43123" });
  const websocket = websocketChild();
  assert.equal(websocket.command, process.execPath);
  assert.equal(existsSync(websocket.args[0] ?? ""), true);
  assert.deepEqual(websocket.args.slice(1), ["websocket"]);
  const inspector = inspectorChild("/tmp/mcp.json", 6274);
  assert.equal(inspector.command, process.execPath);
  assert.equal(existsSync(inspector.args[0] ?? ""), true);
  assert.deepEqual(inspector.args.slice(1), ["/tmp/mcp.json"]);
  assert.equal(inspectorPort({}), 6274);
  assert.throws(() => inspectorPort({ STACK_INSPECTOR_PORT: "0" }), /STACK_INSPECTOR_PORT/);
  const ui = uiChild(8745);
  assert.equal(ui.name, "ui");
  assert.equal(ui.command, process.execPath);
  assert.equal(existsSync(ui.args[0] ?? ""), true);
  assert.equal(ui.args[1], process.execPath);
  assert.equal(existsSync(ui.args[2] ?? ""), true);
  assert.deepEqual(ui.args.slice(3), ["start", "--hostname", "127.0.0.1", "--port", "8745"]);
  assert.equal(existsSync(join(ui.cwd ?? "", "app", "[[...space]]", "page.tsx")), true);
  assert.equal(uiPort({}), 8745);
  assert.equal(uiPort({ STACK_UI_PORT: "8123" }), 8123);
  assert.throws(() => uiPort({ STACK_UI_PORT: "0" }), /STACK_UI_PORT/);
});

function orphanParent(stateDir: string, keepAlive: boolean) {
  const script = `
    import { startServer } from ${JSON.stringify(fileURLToPath(new URL("../src/server.js", import.meta.url)))};
    import { apiChild, authChild, brainChild, rolesChild } from ${JSON.stringify(fileURLToPath(new URL("../src/children.js", import.meta.url)))};
    import { botsChild } from ${JSON.stringify(fileURLToPath(new URL("../src/bots.js", import.meta.url)))};
    const server = startServer([apiChild(), authChild(), rolesChild(), botsChild(), brainChild()], { ...process.env, STACK_STATE_DIR: ${JSON.stringify(stateDir)}, STACK_BRAIN_SHARE_HOST: "127.0.0.1", STACK_BRAIN_SHARE_PORT: "0" });
    for (const child of server.children()) console.log(\`PID \${child.name} \${child.pid}\`);
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

const sockets = (stateDir: string) => ["api", "auth", "roles", "bots", "brain"].map((name) => join(stateDir, "sockets", `${name}.sock`));

test("api children shut down when the server parent dies abruptly", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-orphan-"));
  const { parent, pids } = orphanParent(stateDir, true);
  const socks = sockets(stateDir);
  try {
    await waitFor(() => pids.size === 5 && socks.every(existsSync), 15_000);
    for (const sock of socks) await connectable(sock);
    parent.kill("SIGKILL");
    await waitFor(() => [apiChild(), authChild(), rolesChild(), botsChild(), brainChild()].every((child) => !processAlive(pids.get(child.name))), 15_000);
    await waitFor(() => socks.every((sock) => !existsSync(sock)), 15_000);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    for (const pid of pids.values()) killProcessGroup(pid);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("api children shut down when the server exits before they finish starting", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-orphan-early-"));
  const { parent, pids } = orphanParent(stateDir, false);
  const socks = sockets(stateDir);
  try {
    await waitFor(() => pids.size === 5, 5_000);
    await waitFor(() => [apiChild(), authChild(), rolesChild(), botsChild(), brainChild()].every((child) => !processAlive(pids.get(child.name))), 15_000);
    for (const sock of socks) assert.equal(existsSync(sock), false);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    for (const pid of pids.values()) killProcessGroup(pid);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("server retains running and failed child statuses", async () => {
  const events: number[] = [];
  const server = startServer(
    [
      { name: "fixture", command: process.execPath, args: [childBin] },
      { name: "missing", command: "stack-missing-binary", args: [] },
      { name: "exit", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ],
    process.env,
    () => events.push(events.length + 1),
  );
  try {
    await waitFor(() => events.length >= 2 && server.children().filter((child) => child.running).length === 1, 5_000);
    assert.equal(server.children().find((child) => child.running)?.name, "fixture");
    assert.match(server.children().find((child) => child.name === "missing")?.error ?? "", /ENOENT/);
    const fixture = server.children().find((child) => child.name === "fixture")!;
    assert.ok(fixture.startedAt && !Number.isNaN(Date.parse(fixture.startedAt)));
    assert.equal(fixture.exitedAt, null);
    const missing = server.children().find((child) => child.name === "missing")!;
    assert.equal(missing.startedAt, null);
    assert.ok(missing.exitedAt, "a failed spawn records its exit time");
    const exited = server.children().find((child) => child.name === "exit")!;
    assert.ok(exited.startedAt && exited.exitedAt && Date.parse(exited.exitedAt) >= Date.parse(exited.startedAt));
  } finally {
    await server.close();
  }
  await waitFor(() => events.length >= 3, 5_000);
  assert.equal(server.children().every((child) => !child.running), true);
});

test("server close resolves promptly after a failed spawn", async () => {
  const server = startServer([{ name: "missing", command: "stack-missing-binary", args: [] }]);
  await waitFor(() => server.children().every((child) => !child.running), 5_000);
  await Promise.race([
    server.close(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("close hung")), 1_000)),
  ]);
});

test("server api serves status and pids_changed on its socket", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-server-sock-"));
  const env = { ...process.env, STACK_STATE_DIR: stateDir };
  const served = await serveApi({ name: "serve", transport: "socket", env });
  const received: string[] = [];
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "serve.sock"));
    const listed = (await socketCall(served.socketPath, "tools/list")) as {
      events: { topics: Record<string, string> } | null;
      tools: Array<{ name: string }>;
    };
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["serve_state_list", "serve_subscription_list", "serve_subscription_get", "serve_subscription_remove", "serve_bot_dependencies", "serve_status", "serve_codex_tools", "serve_codex_tools_check", "serve_resources", "serve_resource_history", "serve_local_connect", "serve_local_revoke", "serve_state_read"]);
    assert.deepEqual(Object.keys(listed.events?.topics ?? {}), ["serve_state_changed", "pids_changed", "codex_tools_changed", "resources_changed"]);
    const unavailable = await socketCall(served.socketPath!, "tools/call", { name: "serve_state_list", arguments: { owners: ["bots"] } }) as { entries: unknown[]; owners: Array<{ available: boolean; issue: string | null }> };
    assert.deepEqual(unavailable.entries, []);
    assert.equal(unavailable.owners[0]?.available, false);
    assert.ok(unavailable.owners[0]?.issue);

    const empty = (await socketCall(served.socketPath, "tools/call", { name: "serve_status", arguments: {} })) as {
      pid: number;
      indexUrl: string | null;
      uiUrl: string | null;
      inspectorUrl: string | null;
      mcpUrls: Record<string, string>;
      children: Array<{ name: string; running: boolean }>;
    };
    assert.equal(empty.pid, process.pid);
    assert.deepEqual(Object.keys(empty).sort(), ["children", "indexUrl", "inspectorUrl", "mcpUrls", "nodeVersion", "pid", "startedAt", "uiUrl"]);
    assert.ok(Number.isFinite(Date.parse((empty as { startedAt?: string }).startedAt!)));
    assert.equal((empty as { nodeVersion?: string }).nodeVersion, process.version);
    assert.equal(empty.indexUrl, null);
    assert.equal(empty.uiUrl, null);
    assert.equal(empty.inspectorUrl, null);
    assert.deepEqual(empty.mcpUrls, {});
    assert.deepEqual(empty.children, []);

    const subscription = await socketSubscribe(served.socketPath ?? "", ["pids_changed"], (topic) => received.push(topic));
    const server = startServer(
      [
        { name: "fixture", command: process.execPath, args: [childBin] },
        { name: "exit", command: process.execPath, args: ["-e", "process.exit(0)"] },
      ],
      env,
      () => statusSource.notify(),
    );
    statusSource.attach(server);
    try {
      const status = (await socketCall(served.socketPath, "tools/call", { name: "serve_status", arguments: {} })) as {
        pid: number;
        children: Array<{ name: string; pid: number | null; running: boolean; exitCode: number | null; signal: string | null; error: string | null; startedAt: string | null; exitedAt: string | null }>;
      };
      const fixture = status.children.find((child) => child.name === "fixture");
      assert.equal(status.pid, process.pid);
      assert.equal(fixture?.running, true);
      assert.ok(fixture?.pid);
      assert.equal(fixture?.error, null);
      assert.ok(fixture?.startedAt && !Number.isNaN(Date.parse(fixture.startedAt)));
      assert.equal(fixture?.exitedAt, null);
      for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(received.length >= 1 && received.every((topic) => topic === "pids_changed"), `unexpected notices: ${received}`);
    } finally {
      statusSource.detach();
      await server.close();
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

test("serve socket checks Codex tools only on request and announces the finished observation", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-codex-tools-"));
  // An absent runtime keeps the check off the desktop while exercising the real context and event path.
  const env = { ...process.env, STACK_STATE_DIR: stateDir, STACK_CODEX_TOOLS_HOME: stateDir, STACK_CODEX_TOOLS_BIN: join(stateDir, "absent-codex") };
  const served = await serveApi({ name: "serve", transport: "socket", env });
  const received: string[] = [];
  const subscription = await socketSubscribe(served.socketPath!, ["codex_tools_changed"], (topic) => received.push(topic));
  type Status = { checking: unknown; runtime: { state: string }; connections: Array<{ name: string; catalog: { state: string; problem: { code: string } | null } }> };
  const read = () => socketCall(served.socketPath!, "tools/call", { name: "serve_codex_tools", arguments: {} }) as Promise<Status>;
  try {
    assert.equal((await read()).runtime.state, "not_checked");
    assert.deepEqual(received, [], "reading starts no check");
    const admitted = await socketCall(served.socketPath!, "tools/call", { name: "serve_codex_tools_check", arguments: {} }) as { admitted: boolean };
    assert.equal(admitted.admitted, true);
    for (let i = 0; i < 200 && (await read()).checking; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < 100 && received.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await read();
    assert.equal(status.runtime.state, "missing");
    assert.deepEqual(status.connections.map((item) => [item.name, item.catalog.state, item.catalog.problem?.code]), [
      ["computer-use", "unavailable", "runtime_missing"], ["chrome", "unavailable", "runtime_missing"], ["messages", "unavailable", "runtime_missing"],
      ["computer-history", "unavailable", "runtime_missing"], ["openai-developer-docs", "unavailable", "runtime_missing"]]);
    assert.deepEqual(received, ["codex_tools_changed", "codex_tools_changed"], "start and finish are announced");
  } finally {
    await subscription.close();
    await served.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
