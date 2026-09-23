import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appServerArgs, Supervisor, waitForReady, type LaunchSpec, type RunningChild } from "../src/supervisor.js";

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

test("a failed record rename rolls back the launched child", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-persist-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-cwd-"));
  const signals: string[] = [];
  try {
    await mkdir(join(stateDir, "servers", "blocked.json"), { recursive: true });
    const supervisor = new Supervisor({
      stateDir,
      endpoint: async () => "ws://127.0.0.1:40001",
      launch(): RunningChild {
        let resolveExit: (code: number | null) => void = () => undefined;
        const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
        return { pid: 12345, exited, kill(signal) { signals.push(signal); resolveExit(0); } };
      },
      waitReady: async () => undefined,
    });
    await supervisor.load();
    await assert.rejects(supervisor.start({ cwd, id: "blocked" }), /EISDIR|directory/);
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
    });
    await supervisor.load();
    const first = await supervisor.start({ cwd, id: "alpha", codexBin: "/tmp/codex" });
    const second = await supervisor.start({ cwd, id: "alpha", codexBin: "/tmp/codex" });
    assert.equal(first.pid, second.pid);
    assert.equal(first.url, "ws://127.0.0.1:41000");
    assert.equal(launched.length, 1);
    assert.deepEqual(launched[0]?.args, ["app-server", "--listen", "ws://127.0.0.1:41000"]);
    assert.equal(launched[0]?.cwd, cwd);
    const stopped = await supervisor.stop("alpha");
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.pid, null);
    assert.equal(stopped.url, null);
    const stoppedAgain = await supervisor.stop("alpha");
    assert.equal(stoppedAgain.state, "stopped");
    assert.deepEqual(killed, ["SIGTERM"]);
    assert.equal(supervisor.list().length, 1);
  } finally {
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
    });
    await supervisor.load();
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

test("caller arguments are merged and --listen is rejected", async () => {
  const url = "ws://127.0.0.1:41000";
  assert.deepEqual(appServerArgs(["--model", "gpt-5.4", "-c", "foo=bar"], url), [
    "app-server",
    "--listen",
    url,
    "--model",
    "gpt-5.4",
    "-c",
    "foo=bar",
  ]);
  assert.deepEqual(appServerArgs(["-c", "foo=bar", "app-server", "--remote-control"], url), [
    "-c",
    "foo=bar",
    "app-server",
    "--listen",
    url,
    "--remote-control",
  ]);
  assert.throws(() => appServerArgs(["--listen", "ws://127.0.0.1:1"], url), /do not pass --listen/);
  assert.throws(() => appServerArgs(["--listen=ws://127.0.0.1:1"], url), /do not pass --listen/);

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
    });
    await supervisor.load();
    await supervisor.start({ cwd, id: "flags", args: ["--model", "gpt-5.4"] });
    assert.deepEqual(launched[0]?.args, ["app-server", "--listen", url, "--model", "gpt-5.4"]);
    await assert.rejects(supervisor.start({ cwd, id: "nope", args: ["--listen", url] }), /do not pass --listen/);
    assert.equal(launched.length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reap kills only a recorded app-server command", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-"));
  const killed: string[] = [];
  const supervisor = new Supervisor({
    stateDir,
    graceMs: 30,
    async commandLine(pid) {
      if (pid === 7) return "codex app-server --listen ws://127.0.0.1:9";
      return "unrelated process";
    },
  });
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    killed.push(`${pid}:${signal ?? "SIGTERM"}`);
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
        url: "ws://127.0.0.1:9",
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
    });
    await supervisor.load();
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
    });
    await supervisor.load();
    await supervisor.start({ cwd, id: "alpha" });
    child.exitCode = 0;
    resolveExit(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  const supervisor = new Supervisor({
    stateDir,
    graceMs: 30,
    async commandLine(pid) {
      if (pid === 11) return "codex app-server --listen ws://127.0.0.1:41000";
      if (pid === 12) return "codex app-server --listen ws://127.0.0.1:4100";
      return null;
    },
  });
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    killed.push(`${pid}:${signal ?? "SIGTERM"}`);
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
      async commandLine() {
        return "unrelated process";
      },
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
  const supervisor = new Supervisor({ stateDir, graceMs: 1_000 });
  try {
    await supervisor.load();
    const started = await supervisor.start({ cwd, id: "live", codexBin: fakeBin });
    assert.equal(started.state, "running");
    assert.equal(started.url, `unix://${join(stateDir, "app", "live.sock")}`);
    await new Promise<void>((resolve, reject) => {
      const socket = connect((started.url ?? "").slice("unix://".length));
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    });
    const stopped = await supervisor.stop("live");
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.url, null);
  } finally {
    await supervisor.stopAll();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
