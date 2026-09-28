import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { socketCall, socketPath } from "@agentstack/api";
import { ResearchStore } from "../src/store.js";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`managed ${signal} shutdown cancels a live direct extraction and releases Brain resources`, { timeout: 15_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-life-"));
    let requested = false;
    let disconnected = false;
    const server = createServer((request) => {
      requested = true;
      request.on("close", () => { disconnected = true; });
      // A deliberately slow Markdown response: no browser or real network is involved.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing local port");
    const env = { ...process.env, AGENTSTACK_STATE_DIR: root, AGENTSTACK_BRAIN_SHARE_PORT: "0" };
    const child = spawn(process.execPath, ["--input-type=module", "-e", 'import { runApi } from "@agentstack/api"; await runApi(["brain", "socket"]);'], {
      cwd: join(import.meta.dirname, "../.."), env, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    try {
      const socket = socketPath("brain", env);
      const registration = join(root, "brain", "share-ingress.json");
      for (let n = 0; n < 300 && !(existsSync(socket) && existsSync(registration)); n++) {
        assert.equal(child.exitCode, null, stderr);
        await sleep(10);
      }
      assert.ok(existsSync(socket) && existsSync(registration), stderr);
      const call = (name: string, input: object = {}): Promise<any> => socketCall(socket, "tools/call", { name, arguments: input });
      const status = await call("brain_status");
      const input = { source: `http://127.0.0.1:${address.port}/active.md`, kind: "url", "idempotency-key": "lifecycle-granted" };
      const admission = await call("submit", input);
      await call("egress_grant_create", { scope: { kind: "job", id: admission.job_id }, policy: { privateDestinations: [{ address: "127.0.0.1", port: address.port }] } });
      if ((await call("jobs_show", { "job-id": admission.job_id })).state === "failed") await call("jobs_retry", { "job-id": admission.job_id });
      const waiting = call("submit", { ...input, wait: true, "wait-timeout-ms": 60_000 });
      void waiting.catch(() => {});
      for (let n = 0; n < 400 && !requested; n++) await sleep(10);
      assert.equal(requested, true, stderr);
      const jobs = (await call("jobs_list")).jobs;
      assert.equal(jobs.length, 1);
      const jobId = jobs[0].id;
      const running = await call("jobs_show", { "job-id": jobId });
      assert.equal(running.state, "running");
      assert.equal(child.kill(signal), true);
      const result = await Promise.race([exited, sleep(5000, undefined, { ref: false }).then(() => { throw new Error(`shutdown timed out: ${stderr}`); })]);
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      const admitted = await waiting;
      assert.equal(admitted.job_id, jobId);
      assert.equal(admitted.wait_status, "timeout");
      assert.equal(existsSync(socket), false);
      assert.equal(existsSync(registration), false);
      await assert.rejects(fetch(`${status.shareUrl}/v1/health`));
      for (let n = 0; n < 100 && !disconnected; n++) await sleep(10);
      assert.equal(disconnected, true, "owned HTTP extraction was not cancelled");
      const reopened = new ResearchStore(status.database);
      try {
        reopened.db.transaction(() => {
          assert.equal(reopened.db.query("SELECT COUNT(*) AS count FROM attempts WHERE job_id=?").get(admitted.job_id).count, running.attempt_count);
          assert.equal(reopened.db.query("SELECT COUNT(*) AS count FROM documents").get().count, 0);
        }).immediate();
      } finally { reopened.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
