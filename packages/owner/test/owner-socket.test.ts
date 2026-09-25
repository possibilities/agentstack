import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWithOwnerSocketRecovery } from "../src/owner-socket.js";

test("an abruptly killed owner leaves a socket that the next owner can reclaim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owner-socket-"));
  const path = join(dir, "owner.sock");
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

    const result = await startWithOwnerSocketRecovery(path, async () => {
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

test("owner recovery never removes a live socket or a non-socket path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owner-live-"));
  const path = join(dir, "owner.sock");
  const listener = createServer();
  try {
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(path, resolve));
    await assert.rejects(startWithOwnerSocketRecovery(path, async () => { throw new Error("must not start"); }), /not proven stale.*listening/);
    assert.equal(existsSync(path), true);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await writeFile(path, "not a socket");
    await assert.rejects(startWithOwnerSocketRecovery(path, async () => { throw new Error("must not start"); }), /not a socket/);
    assert.equal(existsSync(path), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent owner startup cannot bypass the recovery lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owner-lock-"));
  const path = join(dir, "owner.sock");
  let release!: () => void;
  try {
    const first = startWithOwnerSocketRecovery(path, () => new Promise<void>((resolve) => { release = resolve; }));
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(startWithOwnerSocketRecovery(path, async () => { throw new Error("must not start"); }), /startup is already in progress/);
    release();
    await first;
    assert.equal(existsSync(`${path}.starting`), false);
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});
