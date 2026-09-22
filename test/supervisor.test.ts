import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appServerArgs, Supervisor, type LaunchSpec, type RunningChild } from "../src/supervisor.js";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));

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
      async reservePort() {
        return 41000 + launched.length;
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
    const stoppedAgain = await supervisor.stop("alpha");
    assert.equal(stoppedAgain.state, "stopped");
    assert.deepEqual(killed, ["SIGTERM"]);
    assert.equal(supervisor.list().length, 1);
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
      async reservePort() {
        return 41000;
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
  const killed: number[] = [];
  const supervisor = new Supervisor({
    stateDir,
    async commandLine(pid) {
      if (pid === 7) return "codex app-server --listen ws://127.0.0.1:9";
      return "unrelated process";
    },
  });
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal === "SIGTERM") killed.push(pid);
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
    assert.deepEqual(killed, [7]);
    assert.equal(supervisor.list().every((server) => server.state === "stopped"), true);
  } finally {
    process.kill = originalKill;
    await rm(stateDir, { recursive: true, force: true });
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
    assert.match(started.url ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`http://127.0.0.1:${new URL(started.url ?? "").port}/readyz`);
    assert.equal(response.status, 200);
    const stopped = await supervisor.stop("live");
    assert.equal(stopped.state, "stopped");
    await assert.rejects(fetch(`http://127.0.0.1:${new URL(started.url ?? "").port}/readyz`));
  } finally {
    await supervisor.stopAll();
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
