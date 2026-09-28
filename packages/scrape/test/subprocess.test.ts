import assert from "node:assert/strict";
import { test } from "node:test";
import { runProcess } from "../src/subprocess.js";

test("Node subprocess runner preserves argv and bounds captured output", async () => {
  const command = [process.execPath, "-e", "process.stdout.write(process.argv[1])", "one two"];
  const success = await runProcess(command, { timeoutMs: 2_000, maxOutputBytes: 32 });
  assert.deepEqual(success.argv, command);
  assert.equal(success.stdout, "one two");
  assert.equal(success.exitCode, 0);
  const bounded = await runProcess([process.execPath, "-e", "process.stdout.write('x'.repeat(1024))"], { timeoutMs: 2_000, maxOutputBytes: 16 });
  assert.equal(bounded.stdout.length, 16);
  assert.equal(bounded.truncated, true);
});

test("Node subprocess runner aborts a sleeping child without waiting for its deadline", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runProcess([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { signal: controller.signal, timeoutMs: 30_000 });
  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.exitCode, 130);
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - started < 2_000);
});
