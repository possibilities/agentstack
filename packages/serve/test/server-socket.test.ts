import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWithServerSocketRecovery } from "../src/server-socket.js";

test("an abruptly killed server leaves a socket that the next server can reclaim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "server-socket-"));
  const path = join(dir, "serve.sock");
  const child = spawn(process.execPath, ["-e", `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('ready'))`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("socket child exited before listening")));
      child.stdout?.once("data", () => resolve());
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    assert.equal(existsSync(path), true);

    const result = await startWithServerSocketRecovery(path, async () => {
      const listener = createServer();
      await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(path, resolve));
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      return "restarted";
    });
    assert.equal(result, "restarted");
    assert.equal(existsSync(`${path}.starting`), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("server recovery never removes a live socket or a non-socket path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "server-live-"));
  const path = join(dir, "serve.sock");
  const listener = createServer();
  try {
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(path, resolve));
    await assert.rejects(startWithServerSocketRecovery(path, async () => { throw new Error("must not start"); }), /not proven stale.*listening/);
    assert.equal(existsSync(path), true);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await writeFile(path, "not a socket");
    await assert.rejects(startWithServerSocketRecovery(path, async () => { throw new Error("must not start"); }), /not a socket/);
    assert.equal(existsSync(path), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent server startup cannot bypass the recovery lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "server-lock-"));
  const path = join(dir, "serve.sock");
  let release!: () => void;
  try {
    const first = startWithServerSocketRecovery(path, () => new Promise<void>((resolve) => { release = resolve; }));
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(startWithServerSocketRecovery(path, async () => { throw new Error("must not start"); }), /startup is already in progress/);
    release();
    await first;
    assert.equal(existsSync(`${path}.starting`), false);
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});
