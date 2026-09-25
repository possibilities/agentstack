import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer as createNetServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appServerArgs, launchChild, processOwnsEndpoint, Supervisor, waitForReady, type LaunchSpec, type RunningChild, type SupervisorOptions } from "../src/supervisor.js";
import { codexRuntimePath } from "../src/paths.js";
import { DEFAULT_BOT_SETTINGS } from "../src/store.js";
import type { StoredServer } from "../src/store.js";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));

test("readiness times out when an HTTP listener never answers", async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(waitForReady(`ws://127.0.0.1:${address.port}`, new Promise(() => undefined), 80), /not ready/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a failed database write rolls back the launched child", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-persist-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-cwd-"));
  const signals: string[] = [];
  try {
    const supervisor = new Supervisor({
      stateDir,
      endpoint: async () => "ws://127.0.0.1:40001",
      launch(): RunningChild {
        let resolveExit: (code: number | null) => void = () => undefined;
        const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
        return { pid: 12345, exited, kill(signal) { signals.push(signal); resolveExit(0); } };
      },
      waitReady: async () => undefined,
      bindThread: async (_url, _cwd, id) => id ?? "thread-blocked",
    });
    await supervisor.load();
    seedAccount(supervisor);
    supervisor.store.saveServer = () => { throw new Error("database unavailable"); };
    await assert.rejects(supervisor.start({ cwd, id: "blocked" }), /database unavailable/);
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(supervisor.list().find((server) => server.id === "blocked")?.state, "stopped");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("start is idempotent and stop is idempotent", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-cwd-"));
  let pids = 20;
  const launched: LaunchSpec[] = [];
  const killed: string[] = [];
  const children = new Map<number, { resolve: (code: number | null) => void }>();
  try {
    const supervisor = new Supervisor({
      stateDir,
      graceMs: 20,
      async endpoint() {
        return "ws://127.0.0.1:" + (41000 + launched.length);
      },
      launch(spec): RunningChild {
        launched.push(spec);
        const pid = pids++;
        let resolveExit: (code: number | null) => void = () => undefined;
        const exited = new Promise<number | null>((resolve) => {
          resolveExit = resolve;
        });
        children.set(pid, { resolve: resolveExit });
        return {
          pid,
          exited,
          kill(signal) {
            killed.push(signal);
            resolveExit(signal === "SIGKILL" ? null : 0);
          },
        };
      },
      async waitReady() {
        return undefined;
      },
      bindThread: async (_url, _cwd, id) => id ?? "thread-alpha",
    });
    await supervisor.load();
    seedAccount(supervisor);
    const first = await supervisor.start({ cwd, id: "alpha" });
    const second = await supervisor.start({ cwd, id: "alpha" });
    assert.equal(first.pid, second.pid);
    assert.equal(first.url, "ws://127.0.0.1:41000");
    assert.equal(launched.length, 1);
    assert.equal(launched[0]?.bin, codexRuntimePath());
    assert.deepEqual(launched[0]?.args.slice(0, 3), ["app-server", "--listen", "ws://127.0.0.1:41000"]);
    assert.deepEqual(launched[0]?.args.filter((arg) => arg.startsWith("--") && arg !== "--listen"), ["--enable", "--identity", "--capabilities", "--history-dir"]);
    assert.equal(first.account, supervisor.store.listAccounts()[0]?.id);
    assert.equal(first.mainThreadId, null);
    assert.equal(launched[0]?.cwd, cwd);
    await assert.rejects(supervisor.start({ cwd: stateDir, id: "alpha" }), /bound to/);
    const stopped = await supervisor.stop("alpha");
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.pid, null);
    assert.equal(stopped.url, null);
    const stoppedAgain = await supervisor.stop("alpha");
    assert.equal(stoppedAgain.state, "stopped");
    assert.equal(stoppedAgain.mainThreadId, first.mainThreadId);
    assert.deepEqual(killed, ["SIGTERM"]);
    assert.equal(supervisor.list().length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("adoption is fenced to one live Server and rolls back a failed binding write", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-adopt-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-adopt-cwd-"));
  let resolveExit: (code: number | null) => void = () => undefined;
  let scans = 0;
  const supervisor = new Supervisor({ stateDir, graceMs: 20,
    endpoint: async () => "ws://127.0.0.1:43010",
    launch: () => ({ pid: 91, exited: new Promise((resolve) => { resolveExit = resolve; }), kill: () => resolveExit(0) }),
    waitReady: async () => undefined,
    findMainThread: async () => { scans += 1; return "ui-thread"; },
    bindThread: async (_url, _cwd, id) => id,
  });
  try {
    await supervisor.load();
    const started = await supervisor.start({ cwd, id: "one" });
    assert.equal(started.mainThreadId, null);
    assert.equal(await supervisor.adoptMainThread("one", "ws://127.0.0.1:wrong"), null);
    assert.equal(scans, 0);
    const save = supervisor.store.saveServer.bind(supervisor.store);
    try {
      supervisor.store.saveServer = () => { throw new Error("write failed"); };
      await assert.rejects(supervisor.adoptMainThread("one", started.url!), /write failed/);
      assert.equal(supervisor.list()[0]?.mainThreadId, null);
    } finally { supervisor.store.saveServer = save; }
    const [first, second] = await Promise.all([
      supervisor.adoptMainThread("one", started.url!),
      supervisor.adoptMainThread("one", started.url!),
    ]);
    assert.equal(first?.mainThreadId, "ui-thread");
    assert.equal(second, null);
    assert.equal(scans, 2);
    assert.equal(supervisor.store.servers()[0]?.mainThreadId, "ui-thread");
    await supervisor.stop("one");
    assert.equal(await supervisor.adoptMainThread("one", started.url!), null);
    assert.equal((await supervisor.start({ cwd, id: "one" })).mainThreadId, "ui-thread");
  } finally {
    await supervisor.stopAll();
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("launch arguments survive owner recovery and can change only while stopped", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-persist-args-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-persist-args-cwd-"));
  const launches: string[][] = [];
  const options: SupervisorOptions = {
    stateDir, graceMs: 20,
    endpoint: async () => `ws://127.0.0.1:${43300 + launches.length}`,
      launch(spec): RunningChild {
        launches.push(spec.args.slice(spec.args.indexOf("approval_policy=\"never\"") + 1, spec.args.indexOf("--enable")));
      let finish: (code: number | null) => void = () => undefined;
      const child: RunningChild = {
        pid: 100 + launches.length,
        exited: new Promise((resolve) => { finish = resolve; }),
        kill() { child.exitCode = 0; finish(0); },
      };
      return child;
    },
    waitReady: async () => undefined,
    bindThread: async (_url, _cwd, id) => id ?? "thread-persisted",
  };
  const first = new Supervisor(options);
  let recovered: Supervisor | undefined;
  try {
    await first.load();
    seedAccount(first);
    await first.start({ cwd, id: "configured", args: ["-c", 'model="gpt-5.4"'] });
    assert.deepEqual(launches, [["-c", 'model="gpt-5.4"']]);
    await first.start({ cwd, id: "configured" });
    await first.start({ cwd, id: "configured", args: ["-c", 'model="gpt-5.4"'] });
    await assert.rejects(first.start({ cwd, id: "configured", args: ["-c", 'model="gpt-5.6"'] }), /stop it before changing args/);
    await assert.rejects(first.start({ cwd, id: "configured", args: ["--listen", "other"] }), /agentstack owns these axes/);
    assert.equal(launches.length, 1);
    await first.stop("configured");

    recovered = new Supervisor(options);
    await recovered.load();
    assert.deepEqual(recovered.store.servers()[0]?.args, ["-c", 'model="gpt-5.4"']);
    await recovered.resumeAll();
    assert.deepEqual(launches[1], ["-c", 'model="gpt-5.4"']);
    assert.equal(recovered.list()[0]?.mainThreadId, null);
    await recovered.stop("configured");
    await recovered.start({ cwd, id: "configured", args: ["-c", 'model="gpt-5.6"'] });
    assert.deepEqual(launches[2], ["-c", 'model="gpt-5.6"']);
    await recovered.stop("configured");
    await recovered.start({ cwd, id: "configured", args: [] });
    assert.deepEqual(launches[3], []);
    assert.deepEqual(recovered.store.servers()[0]?.args, []);
  } finally {
    await recovered?.stopAll();
    await recovered?.runtime.close();
    recovered?.store.close();
    await first.runtime.close();
    first.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saved Bot settings survive defaults changes and override only when stopped", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-settings-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-settings-cwd-"));
  const launches: string[][] = [];
  const options: SupervisorOptions = {
    stateDir,
    endpoint: async () => `ws://127.0.0.1:${43900 + launches.length}`,
    launch(spec) {
      launches.push(spec.args);
      let finish: (code: number | null) => void = () => undefined;
      const child: RunningChild = { pid: 500 + launches.length, exited: new Promise((resolve) => { finish = resolve; }), kill() { child.exitCode = 0; finish(0); } };
      return child;
    },
    waitReady: async () => undefined,
  };
  const first = new Supervisor(options);
  let recovered: Supervisor | undefined;
  try {
    await first.load();
    first.store.setBotDefaults({ model: "gpt-new", reasoningEffort: "high", sandboxMode: "read-only" });
    const created = await first.start({ id: "one", cwd, settings: { model: "gpt-local" } });
    assert.deepEqual(created.settings, { model: "gpt-local", reasoningEffort: "high", sandboxMode: "read-only", approvalPolicy: "never" });
    assert.deepEqual(launches[0]?.slice(3, 11), ["-c", 'model="gpt-local"', "-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"']);
    await assert.rejects(first.start({ id: "one", cwd, settings: { reasoningEffort: "medium" } }), /stop it before changing settings/);
    await first.stop("one");
    first.store.setBotDefaults({ model: "gpt-future", reasoningEffort: "low" });
    recovered = new Supervisor(options);
    await recovered.load();
    assert.equal(recovered.store.botDefaults().model, "gpt-future");
    await recovered.resumeAll();
    assert.equal(recovered.list()[0]?.settings?.model, "gpt-local");
    assert.deepEqual(launches[1]?.slice(3, 7), ["-c", 'model="gpt-local"', "-c", 'model_reasoning_effort="high"']);
    await recovered.stop("one");
    const changed = await recovered.start({ id: "one", cwd, settings: { reasoningEffort: "medium" } });
    assert.equal(changed.settings?.reasoningEffort, "medium");
    assert.equal(launches[2]?.[6], 'model_reasoning_effort="medium"');
  } finally {
    await recovered?.stopAll();
    await recovered?.runtime.close();
    recovered?.role.close();
    recovered?.store.close();
    await first.runtime.close();
    first.role.close();
    first.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("owner MCP connections are materialized in each launch bundle without persisting as caller arguments", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-mcp-launch-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-mcp-cwd-"));
  const launches: string[][] = [];
  let exposed: Record<string, string> = { auth: "http://127.0.0.1:43123/mcp/auth" };
  const supervisor = new Supervisor({
    stateDir,
    endpoint: async () => `ws://127.0.0.1:${43400 + launches.length}`,
    mcpServers: async () => exposed,
    launch(spec) {
      launches.push(spec.args);
      let finish: (code: number | null) => void = () => undefined;
      const child: RunningChild = {
        pid: 200 + launches.length,
        exited: new Promise((resolve) => { finish = resolve; }),
        kill() { child.exitCode = 0; finish(0); },
      };
      return child;
    },
    waitReady: async () => undefined,
    bindThread: async (_url, _cwd, id) => id ?? "main-mcp",
  });
  try {
    await supervisor.load();
    seedAccount(supervisor);
    await supervisor.start({ id: "with-mcp", cwd, args: ["-c", 'model="gpt-5.4"'] });
    const firstRoot = launches[0]?.[launches[0].indexOf("--capabilities") + 1];
    assert.ok(firstRoot);
    assert.match(await readFile(join(firstRoot, "config.toml"), "utf8"), /\[mcp_servers.auth\]/);
    assert.deepEqual(supervisor.store.servers()[0]?.args, ["-c", 'model="gpt-5.4"']);
    await supervisor.stop("with-mcp");
    exposed = { ...exposed, bots: "http://127.0.0.1:43123/mcp/bots" };
    await supervisor.start({ id: "with-mcp", cwd });
    const secondRoot = launches[1]?.[launches[1].indexOf("--capabilities") + 1];
    assert.ok(secondRoot);
    assert.match(await readFile(join(secondRoot, "config.toml"), "utf8"), /\[mcp_servers.bots\]/);
    assert.equal(supervisor.list()[0]?.mainThreadId, null);
  } finally {
    await supervisor.stopAll();
    await supervisor.runtime.close();
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Bot launch passes only matching Role project trust to the private codexnk config", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-project-mcp-launch-"));
  const project = join(stateDir, "project");
  const cwd = join(project, "nested");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(project, ".git"));
  const launches: string[][] = [];
  const supervisor = new Supervisor({
    stateDir, endpoint: async () => `ws://127.0.0.1:${43500 + launches.length}`,
    launch(spec) {
      launches.push(spec.args);
      let finish: (code: number | null) => void = () => undefined;
      const child: RunningChild = { pid: 300 + launches.length, exited: new Promise((resolve) => { finish = resolve; }), kill() { child.exitCode = 0; finish(0); } };
      return child;
    },
    waitReady: async () => undefined,
  });
  try {
    await supervisor.load();
    const role = supervisor.role.createTrustedProject(0, project, "Explicit project MCP");
    await supervisor.start({ id: "project-bot", cwd });
    const firstRoot = launches[0]?.[launches[0].indexOf("--capabilities") + 1];
    assert.ok(firstRoot);
    assert.match(await readFile(join(firstRoot, "config.toml"), "utf8"), /\[projects\..*\]\ntrust_level = "trusted"/);
    await supervisor.stop("project-bot");
    supervisor.role.updateTrustedProject(role.revision, role.trustedProjects[0]!.id, { enabled: false });
    await supervisor.start({ id: "project-bot", cwd });
    const secondRoot = launches[1]?.[launches[1].indexOf("--capabilities") + 1];
    assert.ok(secondRoot);
    assert.doesNotMatch(await readFile(join(secondRoot, "config.toml"), "utf8"), /\[projects\./);
  } finally {
    await supervisor.stopAll();
    await supervisor.runtime.close();
    supervisor.role.close();
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a new Server launches with credentials reconciled from an older Server", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-fresh-generation-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-fresh-cwd-"));
  const auth = (stamp: string, token: string) => JSON.stringify({ last_refresh: stamp, tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });
  let launchedWith = "";
  const supervisor = new Supervisor({ stateDir,
    endpoint: async () => "ws://127.0.0.1:43210",
    launch(spec) {
      const at = spec.args.indexOf("--identity");
      launchedWith = readFileSync(join(spec.args[at + 1]!, "auth.json"), "utf8");
      return { pid: 12345, exited: new Promise(() => undefined), kill() {} };
    },
    waitReady: async () => undefined,
    bindThread: async () => "thread-new",
  });
  try {
    const account = supervisor.store.addAccount(auth("2026-09-23T10:00:00Z", "old"));
    const runtimeRoot = await supervisor.runtime.prepare("older");
    const home = join(runtimeRoot, "codex-runtime");
    await mkdir(home);
    await writeFile(join(home, "auth.json"), auth("2026-09-23T11:00:00Z", "refreshed"));
    const older: StoredServer = { id: "older", pid: null, cwd, url: null, state: "stopped", codexBin: codexRuntimePath(), account: account.id, launchedAccount: account.id, authVersion: 1, runtimeRoot, mainThreadId: "thread-old", threadStarting: false, args: [] };
    supervisor.store.saveServer(older);
    await supervisor.load();
    await supervisor.start({ cwd, id: "new" });
    assert.equal(launchedWith, auth("2026-09-23T11:00:00Z", "refreshed"));
    assert.equal(supervisor.store.servers().find(({ id }) => id === "new")?.authVersion, 2);
  } finally {
    await supervisor.runtime.close();
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a stopped Server resumes after re-sign-in while preserving its old runtime", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-replaced-generation-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-replaced-cwd-"));
  const auth = (token: string) => JSON.stringify({ last_refresh: "2026-09-23T10:00:00Z", tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });
  let launchedWith = "";
  let launchedArgs: string[] = [];
  const supervisor = new Supervisor({ stateDir,
    endpoint: async () => "ws://127.0.0.1:43211",
    launch(spec) {
      launchedArgs = spec.args;
      const at = spec.args.indexOf("--identity");
      launchedWith = readFileSync(join(spec.args[at + 1]!, "auth.json"), "utf8");
      return { pid: 12346, exited: new Promise(() => undefined), kill() {} };
    },
    waitReady: async () => undefined,
    bindThread: async (_url, _cwd, id) => id ?? "unexpected-new-thread",
  });
  try {
    const account = supervisor.store.addAccount(auth("old"));
    const runtimeRoot = await supervisor.runtime.prepare("bound");
    const home = join(runtimeRoot, "codex-runtime");
    await mkdir(home);
    await writeFile(join(home, "auth.json"), auth("old"));
    const bound: StoredServer = { id: "bound", pid: null, cwd, url: null, state: "stopped", codexBin: codexRuntimePath(), account: account.id, launchedAccount: account.id, authVersion: 1, runtimeRoot, mainThreadId: "thread-bound", threadStarting: false, args: [] };
    supervisor.store.saveServer(bound);
    supervisor.store.replaceCredentials(account.id, auth("new"));
    await supervisor.load();
    const resumed = await supervisor.start({ cwd, id: "bound" });
    assert.equal(resumed.mainThreadId, "thread-bound");
    assert.equal(launchedWith, auth("new"));
    assert.equal(resumed.settings, null);
    assert.equal(launchedArgs.some((arg) => arg.startsWith("model=") || arg.startsWith("model_reasoning_effort=")), false);
    assert.equal(supervisor.store.servers()[0]?.authVersion, 2);
    const archived = await readdir(join(stateDir, "runtime-recovery", "bound"));
    assert.equal(archived.length, 1);
    assert.equal(await readFile(join(stateDir, "runtime-recovery", "bound", archived[0]!, "codex-runtime", "auth.json"), "utf8"), auth("old"));
  } finally {
    await supervisor.runtime.close();
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("onChange fires only on persisted running/stopped transitions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-change-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-change-cwd-"));
  const events: string[] = [];
  const children = new Map<number, { resolve: (code: number | null) => void }>();
  let pids = 50;
  try {
    const supervisor = new Supervisor({
      stateDir,
      graceMs: 20,
      onChange: () => events.push("change"),
      async endpoint() {
        return "ws://127.0.0.1:" + (42000 + pids);
      },
      launch(): RunningChild {
        const pid = pids++;
        let resolveExit: (code: number | null) => void = () => undefined;
        const exited = new Promise<number | null>((resolve) => {
          resolveExit = resolve;
        });
        children.set(pid, { resolve: resolveExit });
        const child: RunningChild = {
          pid,
          exited,
          kill() {
            child.exitCode = 0;
            resolveExit(0);
          },
        };
        return child;
      },
      async waitReady() {
        return undefined;
      },
      bindThread: async (_url, _cwd, id) => id ?? "thread-alpha",
    });
    await supervisor.load();
    seedAccount(supervisor);
    await supervisor.start({ cwd, id: "alpha" });
    assert.equal(events.length, 1);
    await supervisor.start({ cwd, id: "alpha" });
    assert.equal(events.length, 1);
    await supervisor.stop("alpha");
    assert.equal(events.length, 2);
    await supervisor.stop("alpha");
    assert.equal(events.length, 2);

    const started = await supervisor.start({ cwd, id: "alpha" });
    assert.equal(events.length, 3);
    children.get(started.pid ?? -1)?.resolve(0);
    for (let i = 0; i < 100 && events.length < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(events.length, 4);
    assert.equal(supervisor.list().find((server) => server.id === "alpha")?.state, "stopped");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model, effort, and access defaults precede caller overrides, and owned launch axes are rejected", async () => {
  const url = "ws://127.0.0.1:41000";
  const defaults = ["-c", 'model="gpt-6-sol"', "-c", 'model_reasoning_effort="medium"', "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"'];
  assert.deepEqual(appServerArgs([], url), ["app-server", "--listen", url, ...defaults]);
  assert.deepEqual(appServerArgs([], url, null), ["app-server", "--listen", url, "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"']);
  assert.deepEqual(appServerArgs(["-c", 'model="gpt-5.4"', "-c", "foo=bar"], url), [
    "app-server",
    "--listen",
    url,
    ...defaults,
    "-c",
    'model="gpt-5.4"',
    "-c",
    "foo=bar",
  ]);
  assert.deepEqual(appServerArgs(["-c", "foo=bar", "app-server", "--remote-control"], url), [
    "app-server",
    "--listen",
    url,
    ...defaults,
    "-c",
    "foo=bar",
    "--remote-control",
  ]);
  assert.deepEqual(appServerArgs(["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="on-request"'], url).slice(3), [
    ...defaults, "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="on-request"',
  ]);
  assert.deepEqual(appServerArgs([], url, { ...DEFAULT_BOT_SETTINGS, model: "gpt-custom", reasoningEffort: "high" }).slice(3, 7), ["-c", 'model="gpt-custom"', "-c", 'model_reasoning_effort="high"']);
  assert.throws(() => appServerArgs(["--listen", "ws://127.0.0.1:1"], url), /do not pass --listen/);
  assert.throws(() => appServerArgs(["--listen=ws://127.0.0.1:1"], url), /do not pass --listen/);
  assert.throws(() => appServerArgs(["--identity", "/tmp/other"], url), /agentstack owns these axes/);

  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-args-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-args-cwd-"));
  const launched: LaunchSpec[] = [];
  try {
    const supervisor = new Supervisor({
      stateDir,
      async endpoint() {
        return "ws://127.0.0.1:" + (41000);
      },
      launch(spec): RunningChild {
        launched.push(spec);
        return { pid: 40, exited: new Promise(() => undefined), kill() {} };
      },
      async waitReady() {
        return undefined;
      },
      bindThread: async (_url, _cwd, id) => id ?? "thread-flags",
    });
    await supervisor.load();
    seedAccount(supervisor);
    await supervisor.start({ cwd, id: "flags", args: ["-c", 'model="gpt-5.4"'] });
    assert.deepEqual(launched[0]?.args.slice(0, 3 + defaults.length + 2), ["app-server", "--listen", url, ...defaults, "-c", 'model="gpt-5.4"']);
    await assert.rejects(supervisor.start({ cwd, id: "nope", args: ["--listen", url] }), /do not pass --listen/);
    assert.equal(launched.length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reap kills only a recorded app-server command", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack recovery "));
  const url = `unix://${join(stateDir, "app", "keep.sock")}`;
  const killed: string[] = [];
  const dead = new Set<number>();
  const supervisor = new Supervisor({
    stateDir,
    graceMs: 30,
    async commandLine(pid) {
      if (pid === 7) return `codex app-server --listen ${url}`;
      return "unrelated process";
    },
    endpointOwner: async (pid) => pid === 7,
  });
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal === 0 && dead.has(pid)) throw Object.assign(new Error("exited"), { code: "ESRCH" });
    if (signal === "SIGKILL") dead.add(pid);
    if (signal !== 0) killed.push(`${pid}:${signal ?? "SIGTERM"}`);
    return true;
  }) as typeof process.kill;
  try {
    await supervisor.load();
    await mkdir(join(stateDir, "servers"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(stateDir, "servers", "keep.json"),
      JSON.stringify({
        id: "keep",
        pid: 7,
        cwd: "/tmp",
        url,
        state: "running",
        codexBin: "codex",
      }),
    );
    await writeFile(
      join(stateDir, "servers", "other.json"),
      JSON.stringify({
        id: "other",
        pid: 8,
        cwd: "/tmp",
        url: "ws://127.0.0.1:10",
        state: "running",
        codexBin: "codex",
      }),
    );
    await supervisor.load();
    await supervisor.reap();
    assert.deepEqual(killed, ["7:SIGTERM", "7:SIGKILL"]);
    assert.equal(supervisor.list().every((server) => server.state === "stopped" && server.pid === null && server.url === null), true);
  } finally {
    process.kill = originalKill;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an unverifiable recorded process remains fenced during recovery", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-unknown-owner-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-unknown-cwd-"));
  const url = `unix://${join(stateDir, "app", "uncertain.sock")}`;
  const signals: string[] = [];
  const changes: string[] = [];
  let command = `codex app-server --listen ${url}`;
  let endpointOwner: boolean | null = null;
  const originalKill = process.kill;
  process.kill = ((_pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal !== 0) signals.push(String(signal));
    return true; // The recorded PID is still present, but inspection is unavailable.
  }) as typeof process.kill;
  const supervisor = new Supervisor({ stateDir, commandLine: async () => command, endpointOwner: async () => endpointOwner, onChange: (id) => changes.push(id) });
  try {
    await mkdir(join(stateDir, "servers"));
    await writeFile(join(stateDir, "servers", "uncertain.json"), JSON.stringify({
      id: "uncertain", pid: 99999, cwd, url, state: "running", codexBin: "codex",
    }));
    await supervisor.load();
    await supervisor.reap();
    assert.equal(supervisor.list()[0]?.state, "running");
    assert.match(supervisor.list()[0]?.recoveryIssue ?? "", /ownership could not be verified/);
    await assert.rejects(supervisor.start({ cwd, id: "uncertain" }), /could not both be verified/);
    await assert.rejects(supervisor.stop("uncertain"), /could not both be verified/);
    assert.deepEqual(signals, []);
    assert.deepEqual(changes, ["uncertain"]);
    command = "unrelated process";
    endpointOwner = false;
    assert.equal((await supervisor.stop("uncertain")).recoveryIssue, null);
    assert.equal(supervisor.list()[0]?.state, "stopped");
    assert.deepEqual(changes, ["uncertain", "uncertain"]);
  } finally {
    process.kill = originalKill;
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("recovery retains a Server if its verified process survives SIGKILL", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-stubborn-owner-"));
  const url = "ws://127.0.0.1:41001";
  const signals: string[] = [];
  const originalKill = process.kill;
  process.kill = ((_pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal !== 0) signals.push(String(signal));
    return true;
  }) as typeof process.kill;
  const supervisor = new Supervisor({ stateDir, graceMs: 20, commandLine: async () => `codex app-server --listen ${url}`, endpointOwner: async () => true });
  try {
    await mkdir(join(stateDir, "servers"));
    await writeFile(join(stateDir, "servers", "stubborn.json"), JSON.stringify({
      id: "stubborn", pid: 99998, cwd: stateDir, url, state: "running", codexBin: "codex",
    }));
    await supervisor.load();
    await supervisor.reap();
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(supervisor.list()[0]?.state, "running");
    assert.match(supervisor.list()[0]?.recoveryIssue ?? "", /did not exit after SIGKILL/);
  } finally {
    process.kill = originalKill;
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a pre-existing app socket path is never unlinked during launch", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-stale-path-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-stale-cwd-"));
  const path = join(stateDir, "app", "stale.sock");
  const supervisor = new Supervisor({ stateDir, endpoint: async () => `unix://${path}`, launch: () => { throw new Error("must not launch"); } });
  try {
    await mkdir(join(stateDir, "app"));
    await writeFile(path, "leave intact");
    await supervisor.load();
    seedAccount(supervisor);
    await assert.rejects(supervisor.start({ cwd, id: "stale" }), /socket path already exists/);
    assert.equal(await readFile(path, "utf8"), "leave intact");
  } finally {
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("macOS endpoint inspection distinguishes an exact Unix socket path with spaces", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack socket probe "));
  const path = join(dir, "live.sock");
  const server = createNetServer();
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve));
    assert.equal(await processOwnsEndpoint(process.pid, `unix://${path}`), true);
    assert.equal(await processOwnsEndpoint(process.pid, `unix://${path}2`), false);
    assert.equal(await processOwnsEndpoint(-1, `unix://${path}`), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("macOS endpoint inspection verifies an exact legacy loopback TCP listener", { skip: process.platform !== "darwin" }, async () => {
  const server = createNetServer();
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(await processOwnsEndpoint(process.pid, `ws://127.0.0.1:${address.port}`), true);
    assert.equal(await processOwnsEndpoint(process.pid, `ws://127.0.0.1:${address.port + 1}`), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("recovery reaps a real recorded app-server with a spaced socket path", { skip: process.platform !== "darwin" }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack prior "));
  const path = join(stateDir, "app", "prior.sock");
  const url = `unix://${path}`;
  await Promise.all(["app", "logs", "history"].map((name) => mkdir(join(stateDir, name))));
  const child = launchChild({
    bin: fakeBin,
    args: ["app-server", "--listen", url, "--history-dir", join(stateDir, "history")],
    cwd: stateDir,
    logPath: join(stateDir, "logs", "prior.log"),
    env: { ...process.env },
  });
  const supervisor = new Supervisor({ stateDir, graceMs: 1_000 });
  try {
    await waitForReady(url, child.exited, 2_000);
    const account = supervisor.store.addAccount(JSON.stringify({ tokens: { refresh_token: "fixture", access_token: "access", id_token: "fixture.jwt.signature" } }));
    const record: StoredServer = { id: "prior", pid: child.pid, cwd: stateDir, url, state: "running", codexBin: fakeBin,
      account: account.id, launchedAccount: account.id, authVersion: 1, runtimeRoot: null, mainThreadId: "thread-prior", threadStarting: false, args: [] };
    supervisor.store.saveServer(record);
    await supervisor.load();
    await supervisor.reap();
    await child.exited;
    assert.equal(supervisor.list()[0]?.state, "stopped");
    await assert.rejects(lstat(path), /ENOENT/);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    supervisor.store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a dead in-memory server is stopped and can start again", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-dead-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-dead-cwd-"));
  const launched: number[] = [];
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  const child: RunningChild = { pid: 21, exited, kill() {} };
  try {
    const supervisor = new Supervisor({
      stateDir,
      async endpoint() {
        return "ws://127.0.0.1:" + (41000 + launched.length);
      },
      launch(): RunningChild {
        launched.push(launched.length + 1);
        if (launched.length === 1) return child;
        return { pid: 22, exited: new Promise(() => undefined), kill() {} };
      },
      async waitReady() {
        return undefined;
      },
      bindThread: async (_url, _cwd, id) => id ?? "thread-alpha",
    });
    await supervisor.load();
    seedAccount(supervisor);
    const first = await supervisor.start({ cwd, id: "alpha" });
    assert.equal(first.pid, 21);
    child.exitCode = 0;
    const restarted = await supervisor.start({ cwd, id: "alpha" });
    assert.equal(launched.length, 2);
    assert.equal(restarted.pid, 22);
    assert.equal(restarted.state, "running");
    resolveExit(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = supervisor.list().find((server) => server.id === "alpha");
    assert.equal(current?.pid, 22);
    assert.equal(current?.state, "running");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an exited in-memory server is recorded as stopped", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-exited-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-exited-cwd-"));
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  const child: RunningChild = { pid: 21, exited, kill() {} };
  try {
    const supervisor = new Supervisor({
      stateDir,
      async endpoint() {
        return "ws://127.0.0.1:" + (41000);
      },
      launch(): RunningChild {
        return child;
      },
      async waitReady() {
        return undefined;
      },
      bindThread: async (_url, _cwd, id) => id ?? "thread-alpha",
    });
    await supervisor.load();
    seedAccount(supervisor);
    await supervisor.start({ cwd, id: "alpha" });
    child.exitCode = 0;
    resolveExit(0);
    for (let i = 0; i < 100 && supervisor.list().find((server) => server.id === "alpha")?.state !== "stopped"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const listed = supervisor.list().find((server) => server.id === "alpha");
    assert.equal(listed?.state, "stopped");
    assert.equal(listed?.pid, null);
    assert.equal(listed?.url, null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a listen url is not owned when it is only a prefix of another port", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-prefix-"));
  const killed: string[] = [];
  const dead = new Set<number>();
  const supervisor = new Supervisor({
    stateDir,
    graceMs: 30,
    async commandLine(pid) {
      if (pid === 11) return "codex app-server --listen ws://127.0.0.1:41000";
      if (pid === 12) return "codex app-server --listen ws://127.0.0.1:4100";
      return null;
    },
    endpointOwner: async (pid) => pid === 12,
  });
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal === 0 && dead.has(pid)) throw Object.assign(new Error("exited"), { code: "ESRCH" });
    if (signal === "SIGKILL") dead.add(pid);
    if (signal !== 0) killed.push(`${pid}:${signal ?? "SIGTERM"}`);
    return true;
  }) as typeof process.kill;
  try {
    await supervisor.load();
    await mkdir(join(stateDir, "servers"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(stateDir, "servers", "prefix.json"),
      JSON.stringify({
        id: "prefix",
        pid: 11,
        cwd: "/tmp",
        url: "ws://127.0.0.1:4100",
        state: "running",
        codexBin: "codex",
      }),
    );
    await writeFile(
      join(stateDir, "servers", "exact.json"),
      JSON.stringify({
        id: "exact",
        pid: 12,
        cwd: "/tmp",
        url: "ws://127.0.0.1:4100",
        state: "running",
        codexBin: "codex",
      }),
    );
    await supervisor.load();
    await supervisor.reap();
    assert.deepEqual(killed, ["12:SIGTERM", "12:SIGKILL"]);
  } finally {
    process.kill = originalKill;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a reused pid is not treated as the recorded server", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-reused-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-reused-cwd-"));
  const launched: number[] = [];
  try {
    const supervisor = new Supervisor({
      stateDir,
      graceMs: 20,
      async endpoint() {
        return "ws://127.0.0.1:" + (41000 + launched.length);
      },
      launch(): RunningChild {
        launched.push(1);
        return { pid: 70 + launched.length, exited: new Promise(() => undefined), kill() {} };
      },
      async waitReady() {
        return undefined;
      },
      bindThread: async (_url, _cwd, id) => id ?? "thread-old",
      async commandLine() {
        return "unrelated process";
      },
      endpointOwner: async () => false,
    });
    await mkdir(join(stateDir, "servers"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(stateDir, "servers", "old.json"),
      JSON.stringify({
        id: "old",
        pid: 70,
        cwd,
        url: "ws://127.0.0.1:9",
        state: "running",
        codexBin: "codex",
      }),
    );
    await supervisor.load();
    seedAccount(supervisor);
    const started = await supervisor.start({ cwd, id: "old" });
    assert.equal(launched.length, 1);
    assert.notEqual(started.pid, 70);
    assert.equal(started.url, "ws://127.0.0.1:41000");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a fake app-server becomes ready and can be stopped", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-live-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-live-cwd-"));
  const supervisor = new Supervisor({ stateDir, graceMs: 1_000, launch: (spec) => launchChild({ ...spec, bin: fakeBin }) });
  try {
    await supervisor.load();
    seedAccount(supervisor);
    const started = await supervisor.start({ cwd, id: "live" });
    assert.equal(started.state, "running");
    assert.equal(started.mainThreadId, null);
    assert.match(started.url ?? "", /\/app\/[0-9a-f]{14}\.sock$/);
    await new Promise<void>((resolve, reject) => {
      const socket = connect((started.url ?? "").slice("unix://".length));
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    });
    const stopped = await supervisor.stop("live");
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.url, null);
    const resumed = await supervisor.start({ cwd, id: "live" });
    assert.equal(resumed.mainThreadId, started.mainThreadId);
    assert.notEqual(resumed.url, started.url);
    await assert.rejects(readFile(join(stateDir, "history", "live", "fake-threads.jsonl"), "utf8"), /ENOENT/);
  } finally {
    await supervisor.stopAll();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed resume retains the main thread and never creates a replacement", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-resume-fail-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-resume-cwd-"));
  let resolveExit: (code: number | null) => void = () => undefined;
  const calls: Array<string | null> = [];
  const options: SupervisorOptions = { stateDir, graceMs: 20,
    endpoint: async () => "ws://127.0.0.1:43111",
    launch: () => ({ pid: 77, exited: new Promise((resolve) => { resolveExit = resolve; }), kill: () => resolveExit(0) }),
    waitReady: async () => undefined,
    bindThread: async (_url, _cwd, id) => {
      calls.push(id);
      throw new Error("thread missing");
    },
  };
  const supervisor = new Supervisor(options);
  try {
    await supervisor.load();
    seedAccount(supervisor);
    await supervisor.start({ cwd, id: "one" });
    await supervisor.stop("one");
    const record = supervisor.store.servers().find(({ id }) => id === "one")!;
    record.mainThreadId = "main-1";
    supervisor.store.saveServer(record);
    supervisor.store.close();
    const recovered = new Supervisor(options);
    try {
      await recovered.load();
      await assert.rejects(recovered.start({ cwd, id: "one" }), /thread missing/);
      assert.deepEqual(calls, ["main-1"]);
      assert.equal(recovered.list()[0]?.mainThreadId, "main-1");
      assert.equal(recovered.list()[0]?.state, "stopped");
    } finally { recovered.store.close(); }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a legacy unconfirmed thread start still blocks automatic recovery", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-uncertain-thread-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-uncertain-cwd-"));
  let resolveExit: (code: number | null) => void = () => undefined;
  const options: SupervisorOptions = { stateDir, graceMs: 20,
    endpoint: async () => "ws://127.0.0.1:43112",
    launch: () => ({ pid: 78, exited: new Promise<number | null>((resolve) => { resolveExit = resolve; }), kill: () => resolveExit(0) }),
    waitReady: async () => undefined,
    bindThread: async () => { throw new Error("must not allocate a thread"); },
  };
  const first = new Supervisor(options);
  try {
    await first.load();
    seedAccount(first);
    await first.start({ cwd, id: "one" });
    await first.stop("one");
    const record = first.store.servers()[0]!;
    record.threadStarting = true;
    first.store.saveServer(record);
    assert.equal(first.store.servers()[0]?.threadStarting, true);
    first.store.close();
    const recovered = new Supervisor(options);
    try {
      await recovered.load();
      await assert.rejects(recovered.start({ cwd, id: "one" }), /unconfirmed thread\/start/);
      assert.equal(recovered.list()[0]?.mainThreadId, null);
    } finally { recovered.store.close(); }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a persisted live server from another runtime is not returned as codexnk", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-legacy-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-legacy-cwd-"));
  let launched = false;
  const supervisor = new Supervisor({
    stateDir,
    commandLine: async () => "vendor-codex app-server --listen ws://127.0.0.1:41000",
    endpointOwner: async () => true,
    launch: () => { launched = true; throw new Error("unexpected launch"); },
  });
  try {
    await mkdir(join(stateDir, "servers"));
    await writeFile(join(stateDir, "servers", "legacy.json"), JSON.stringify({
      id: "legacy", pid: 12345, cwd, url: "ws://127.0.0.1:41000", state: "running", codexBin: "codex",
    }));
    await supervisor.load();
    seedAccount(supervisor);
    await assert.rejects(supervisor.start({ cwd, id: "legacy" }), /different Codex runtime; stop it/);
    assert.equal(launched, false);
    assert.equal(supervisor.list()[0]?.state, "running");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

function seedAccount(supervisor: Supervisor): void {
  supervisor.store.addAccount(JSON.stringify({ tokens: { refresh_token: "test-refresh", access_token: "access", id_token: "fixture.jwt.signature" } }));
}
