import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { socketCall, socketPath } from "@agentstack/api";
import { ResearchStore } from "../src/store.js";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`managed ${signal} shutdown settles an active socket wait, reaps extraction and releases Brain resources`, { timeout: 15_000, skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-life-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const providerFile = join(root, "provider.pid");
    const descendantFile = join(root, "descendant.pid");
    writeFileSync(join(bin, "agentscrape"), `#!/bin/sh
printf '%s' "$$" > '${providerFile}'
/bin/sh -c 'trap "" HUP INT TERM; printf "%s" "$$" > "${descendantFile}"; exec /bin/sleep 30' &
wait
`, { mode: 0o755 });
    const env = { HOME: root, PATH: bin, AGENTSTACK_STATE_DIR: root, AGENTSTACK_BRAIN_SHARE_PORT: "0" };
    // runApi is the same shared signal/lifecycle entry point used by owner children.
    const child = spawn(process.execPath, ["--input-type=module", "-e", 'import { runApi } from "@agentstack/api"; await runApi(["brain", "socket"]);'], {
      cwd: join(import.meta.dirname, "../.."), env, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let providerPid: number | undefined;
    let descendantPid: number | undefined;
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
      const waiting = call("submit", { source: "https://example.test/active-extraction", kind: "url", wait: true, "wait-timeout-ms": 60_000 });
      void waiting.catch(() => {});
      for (let n = 0; n < 400 && !existsSync(descendantFile); n++) await sleep(10);
      assert.ok(existsSync(descendantFile), stderr);
      providerPid = Number(readFileSync(providerFile, "utf8"));
      descendantPid = Number(readFileSync(descendantFile, "utf8"));
      assert.ok(providerPid > 0 && descendantPid > 0);
      process.kill(providerPid, 0);
      process.kill(descendantPid, 0);
      const jobs = (await call("jobs_list")).jobs;
      assert.equal(jobs.length, 1);
      const jobId = jobs[0].id;
      assert.equal((await call("jobs_show", { "job-id": jobId })).state, "running");
      assert.equal(child.kill(signal), true);
      const result = await Promise.race([exited, sleep(5000, undefined, { ref: false }).then(() => { throw new Error(`shutdown timed out: ${stderr}`); })]);
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      const admitted = await waiting;
      assert.equal(admitted.job_id, jobId);
      assert.equal(admitted.wait_status, "timeout");
      assert.equal(existsSync(socket), false);
      assert.equal(existsSync(registration), false);
      await assert.rejects(fetch(`${status.shareUrl}/v1/health`));
      for (const pid of [providerPid, descendantPid]) {
        const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
        assert.ok(state.status === 1 || /^Z/.test(state.stdout.trim()), `owned process ${pid} survived: ${state.stdout}`);
      }
      const reopened = new ResearchStore(status.database);
      try {
        reopened.db.transaction(() => {
          assert.equal(reopened.db.query("SELECT COUNT(*) AS count FROM attempts WHERE job_id=?").get(admitted.job_id).count, 1);
          assert.equal(reopened.db.query("SELECT COUNT(*) AS count FROM documents").get().count, 0);
        }).immediate();
      } finally { reopened.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      // Only owned fixture groups can require cleanup after an assertion failure.
      const ownedProvider = providerPid ?? (existsSync(providerFile) ? Number(readFileSync(providerFile, "utf8")) : undefined);
      if (ownedProvider && ownedProvider > 0) { try { process.kill(-ownedProvider, "SIGKILL"); } catch {} }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
