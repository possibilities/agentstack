import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { socketCall, socketPath, installationControlRoot, serveApi, type StatePlan } from "@stack/api";
import { AuthStore } from "@stack/auth";
import { api as accessApi } from "@stack/access";
import { api as workerApi } from "@stack/worker";
import { factoryResetReceipt, recoverFactoryReset, releaseFactoryReset } from "../src/factory-reset.js";

const parent = fileURLToPath(new URL("../../test/fixtures/factory-parent.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const git = async (root: string, args: string[]) => (await promisify(execFile)("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
const input = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID(), confirmation: "factory-reset", externalWritersQuiesced: true });
async function fixture(options: NodeJS.ProcessEnv = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "stack-factory-"))), root = join(directory, "state"), repo = join(directory, "source");
  await mkdir(root, { mode: 0o700 }); await mkdir(repo); await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture"]); await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "file"), "source history"); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "base"]);
  const access = await accessApi.createContext({ STACK_STATE_DIR: root }), oldIdentity = access.store.serverId; await accessApi.closeContext(access);
  const auth = new AuthStore(root), account = auth.prepareWorker("devin"); auth.enableWorker(account.id, false); auth.close();
  await mkdir(join(root, "worker-accounts", account.id), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "worker-accounts", account.id, "private-native-data"), "native body");
  const workerContext = await workerApi.createContext({ STACK_STATE_DIR: root }), ledger = workerContext.manager.ledger;
  const reserved = ledger.reserve({ requestId: randomUUID(), botId: "_local_operator", threadId: "", accountId: account.id, provider: "devin", model: "fixture", effort: null, repo, baseRef: null, task: "private prompt" });
  const claim = { repo, cwd: join(root, "workers", "worktrees", reserved.worker.id), branch: `stack-worker-${reserved.worker.id}`, baseCommit: await git(repo, ["rev-parse", "HEAD"]), sourceDirty: false, roleId: randomUUID(), roleRevision: 1 };
  await mkdir(join(root, "workers", "worktrees"), { recursive: true }); await git(repo, ["worktree", "add", "-b", claim.branch, claim.cwd]);
  ledger.setWorktree(reserved.worker.id, claim); ledger.setWorkerPhase(reserved.worker.id, "closed");
  const retired = ledger.reserve({ requestId: randomUUID(), botId: "_local_operator", threadId: "", accountId: account.id, provider: "devin", model: "fixture", effort: null, repo, baseRef: null, task: "old retained worker" });
  const retiredClaim = { ...claim, cwd: join(root, "workers", "worktrees", retired.worker.id), branch: `stack-worker-${retired.worker.id}` };
  await git(repo, ["worktree", "add", "-b", retiredClaim.branch, retiredClaim.cwd]); await git(repo, ["worktree", "remove", retiredClaim.cwd]);
  ledger.setWorktree(retired.worker.id, retiredClaim); ledger.setWorkerPhase(retired.worker.id, "closed"); await workerApi.closeContext(workerContext);
  await writeFile(join(claim.cwd, "file"), "Worker committed history"); await git(claim.cwd, ["add", "."]); await git(claim.cwd, ["commit", "-m", "worker"]);
  const tip = await git(claim.cwd, ["rev-parse", "HEAD"]); await git(repo, ["update-ref", `refs/stack/retained/${reserved.worker.id}`, tip]);
  await writeFile(join(claim.cwd, "unsaved"), "uncommitted work lost by approved reset");
  await writeFile(join(repo, "human-unsaved"), "source edits stay");
  const vault = join(root, "wiki", "vault"); await mkdir(vault, { recursive: true }); await git(vault, ["init", "-b", "main"]);
  await git(vault, ["config", "user.name", "Fixture"]); await git(vault, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(vault, "note.md"), "retained authored history"); await git(vault, ["add", "."]); await git(vault, ["commit", "-m", "authored history"]);
  await writeFile(join(directory, "device-copy"), "independent outbox");
  const env = { ...process.env, STACK_STATE_DIR: root, STACK_CONTENT_PORT: "0", STACK_CONTENT_ARTIFACT_PORT: "0", STACK_GITHUB_PORT: "0", ...options };
  const child = spawn(process.execPath, [parent], { env, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true });
  let logs = ""; child.stderr!.on("data", data => { logs += data; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const call = (name: string, args: unknown = {}) => socketCall(socketPath("serve", env), "tools/call", { name, arguments: args }, { timeoutMs: 10_000 });
  try {
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error(logs))); });
    // Readiness calls are observation only, never retries of an uncertain mutation.
    await ready(async () => { await socketCall(socketPath("content", env), "tools/call", { name: "list", arguments: {} }); await socketCall(socketPath("github", env), "tools/call", { name: "github_status", arguments: {} }); await call("serve_factory_reset_plan", { scope: "installation" }); });
    await socketCall(socketPath("github", env), "tools/call", { name: "github_endpoint_create", arguments: { id: randomUUID(), label: "Reset receiver", target: { kind: "app" } } });
  } catch (error) { child.kill("SIGTERM"); await exited; await rm(directory, { recursive: true, force: true }); throw error; }
  return { directory, root, env, repo, claim, tip, oldIdentity, child, exited, call, logs: () => logs,
    async close() { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } await rm(directory, { recursive: true, force: true }); } };
}
async function ready(read: () => Promise<unknown>) {
  const deadline = Date.now() + 15_000;
  while (true) { try { await read(); return; } catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

test("factory reset socket admission drains actual owners, retains source/Git/device copies, empties the generation and stays stopped until exact cold release", { timeout: 30_000 }, async () => {
  const f = await fixture({ FACTORY_DRAIN_DELAY: "400" });
  try {
    await writeFile(join(f.root, "foreign.txt"), "not owned");
    await assert.rejects(f.call("serve_factory_reset_plan", { scope: "installation" }), /Unknown\/unsafe/);
    assert.equal(existsSync(join(installationControlRoot(f.env), "fence.json")), false);
    await rm(join(f.root, "foreign.txt"));
    const providerStore = join(f.root, "browser", "hypeman");
    await mkdir(providerStore); await writeFile(join(providerStore, "foreign-disk"), "unattributed provider data");
    await assert.rejects(f.call("serve_factory_reset_plan", { scope: "installation" }), /In-root Hypeman/);
    assert.equal(await readFile(join(providerStore, "foreign-disk"), "utf8"), "unattributed provider data");
    assert.equal(existsSync(join(installationControlRoot(f.env), "fence.json")), false);
    await rm(providerStore, { recursive: true });
    const stale = await f.call("serve_factory_reset_plan", { scope: "installation" }) as StatePlan;
    const auth = new AuthStore(f.root); auth.prepareWorker("devin"); auth.close();
    await assert.rejects(f.call("serve_factory_reset_clear", input(stale)), /scope changed/);
    assert.equal(existsSync(join(installationControlRoot(f.env), "fence.json")), false);
    const plan = await f.call("serve_factory_reset_plan", { scope: "installation" }) as StatePlan;
    assert.deepEqual(plan.blockedBy, []);
    const request = input(plan);
    await assert.rejects(f.call("serve_factory_reset_clear", { ...request, confirmation: "erase" }), /factory-reset/);
    const admitted = await f.call("serve_factory_reset_clear", request) as { status: string };
    assert.equal(admitted.status, "running");
    assert.equal(factoryResetReceipt(f.env, request.requestId).receipt?.status, "running", "cold reads do not recover a live writer");
    assert.throws(() => recoverFactoryReset(f.env, request.requestId), /alive or PID reused/);
    assert.deepEqual(await f.call("serve_factory_reset_clear", request), admitted);
    await assert.rejects(f.call("serve_factory_reset_clear", { ...request, expectedRevision: "conflict" }), /already used/);
    await assert.rejects(f.call("serve_settings_update", { developerMode: true, expectedRevision: 0 }), /fenced/);
    assert.equal(await f.exited, 0, f.logs());
    const cold = factoryResetReceipt(f.env, request.requestId); assert.equal(cold.receipt?.status, "completed", JSON.stringify(cold));
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(existsSync(f.claim.cwd), false);
    assert.equal(await git(f.repo, ["rev-parse", f.claim.branch]), f.tip);
    assert.equal(await git(f.repo, ["rev-parse", `refs/stack/retained/${f.claim.branch.replace("stack-worker-", "")}`]), f.tip);
    assert.equal(await readFile(join(f.repo, "human-unsaved"), "utf8"), "source edits stay");
    assert.equal(await readFile(join(f.directory, "device-copy"), "utf8"), "independent outbox");
    const retainedVault = join(f.directory, "state.retained-git", request.requestId, "vault");
    assert.equal(await readFile(join(retainedVault, "note.md"), "utf8"), "retained authored history");
    assert.equal(await git(retainedVault, ["show", "HEAD:note.md"]), "retained authored history");
    await assert.rejects(serveApi({ name: "auth", transport: "socket", env: f.env }), /factory reset is fenced/);
    assert.deepEqual(await readdir(f.root), [], "startup refusal must precede owner initialization");
    await assert.rejects(promisify(execFile)(process.execPath, [cli, "serve"], { env: f.env }), /factory reset is fenced/);
    const cliReceipt = JSON.parse((await promisify(execFile)(process.execPath, [cli, "factory-reset-control", "serve_factory_reset_receipt_get", JSON.stringify({ requestId: request.requestId })], { env: f.env })).stdout);
    assert.deepEqual(cliReceipt, cold);
    assert.throws(() => releaseFactoryReset(f.env, { requestId: request.requestId, expectedGeneration: randomUUID() }), /completed reset/);
    await rename(f.root, join(f.directory, "original-root")); await mkdir(f.root, { mode: 0o700 });
    assert.throws(() => releaseFactoryReset(f.env, { requestId: request.requestId, expectedGeneration: cold.fence!.nextGeneration }), /incarnation\/generation changed/);
    assert.deepEqual(factoryResetReceipt(f.env, request.requestId), cold, "replacement root cannot release the old fence");
    await rmdir(f.root); await rename(join(f.directory, "original-root"), f.root);
    assert.equal(releaseFactoryReset(f.env, { requestId: request.requestId, expectedGeneration: cold.fence!.nextGeneration }).released, true);
    assert.deepEqual(await readdir(f.root), [], "release never starts an owner");
    const replacement = await accessApi.createContext({ STACK_STATE_DIR: f.root }); assert.notEqual(replacement.store.serverId, f.oldIdentity); assert.deepEqual(replacement.store.inventory().clients, []); await accessApi.closeContext(replacement);
    assert.deepEqual(factoryResetReceipt(f.env, request.requestId).receipt, cold.receipt, "old outcome survives new identity");
  } finally { await f.close(); }
});

test("failed owner teardown keeps data and fence, and dead-writer recovery never repeats interrupted reset effects", { timeout: 30_000 }, async () => {
  for (const options of [{ FACTORY_FAIL_OWNER: "proc" }, { FACTORY_CRASH: "yes" }]) {
    const f = await fixture(options);
    try {
      const request = input(await f.call("serve_factory_reset_plan", { scope: "installation" }) as StatePlan);
      assert.equal((await f.call("serve_factory_reset_clear", request) as { status: string }).status, "running");
      assert.equal(await f.exited, 1);
      assert.equal(await readFile(join(f.claim.cwd, "unsaved"), "utf8"), "uncommitted work lost by approved reset");
      assert.equal(await readFile(join(f.root, "worker-accounts", (await readAccountId(f.root)), "private-native-data"), "utf8"), "native body");
      if (options.FACTORY_CRASH) {
        // IPC disconnect owns child cleanup even when the parent died early.
        await ready(async () => { await assert.rejects(socketCall(socketPath("auth", f.env), "tools/list", {}, { timeoutMs: 300 })); });
      }
      const recovered = recoverFactoryReset(f.env, request.requestId);
      assert.ok(["partial", "unknown"].includes(recovered.receipt!.status));
      assert.throws(() => releaseFactoryReset(f.env, { requestId: request.requestId, expectedGeneration: recovered.fence!.nextGeneration }), /completed reset/);
      assert.deepEqual(recoverFactoryReset(f.env, request.requestId), recovered);
      await assert.rejects(serveApi({ name: "worker", transport: "socket", env: f.env }), /fenced/);
      assert.equal(await readFile(join(f.claim.cwd, "unsaved"), "utf8"), "uncommitted work lost by approved reset");
    } finally { await f.close(); }
  }
});
async function readAccountId(root: string) { const store = new AuthStore(root); try { return store.workerAccounts()[0]!.id; } finally { store.close(); } }
