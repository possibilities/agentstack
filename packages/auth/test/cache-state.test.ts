import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { z } from "zod";
import { operation, serveSocket, socketPath, stateDependencies, type StatePlan } from "@stack/api";
import { api } from "../api.js";
import { accountRoot, credentialEvidence, prepareAccountProfile } from "../src/worker-accounts.js";

const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
test("allow-listed cache cleanup retains usable sign-in/session/sibling bytes and fences stale/live/uncertain requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "auth-cache-state-")), env = { STACK_STATE_DIR: root };
  let ctx = await api.createContext(env), blocked = false, hold: Promise<void> | null = null;
  const worker = await serveSocket({ info: { name: "worker", description: "Worker", transportDescription: "Socket", path: socketPath("worker", env) }, context: {}, operations: [
    operation({ name: "worker_account_state_dependencies", description: "Native dependency fixture", input: z.strictObject({ id: z.uuid() }), output: stateDependencies,
      async call() { if (hold) await hold; return { revision: blocked ? "live" : "drained", blockedBy: blocked ? ["Runtime still live"] : [], retained: [], relationships: [] }; } }),
  ] });
  const call = async (name: string, args: unknown, invocation?: any) => { const op = api.operations.find(op => op.name === name)!; return op.output.parse(await op.call(ctx, op.input.parse(args), invocation)) as any; };
  try {
    const make = async (secret: string) => {
      const bot = ctx.store.addAccount(JSON.stringify({ tokens: { refresh_token: secret, access_token: secret, id_token: "fixture.jwt.signature" } }));
      const account = ctx.store.workerAccounts().find(row => row.id === ctx.store.pairedWorker(bot.id))!;
      await prepareAccountProfile(root, account);
      const profile = accountRoot(root, account.id); await mkdir(join(profile, "data", "opencode"), { recursive: true });
      const path = join(profile, "data", "opencode", "opencode.db"), db = new DatabaseSync(path);
      db.exec("CREATE TABLE credential(integration_id TEXT,value TEXT); CREATE TABLE session(id TEXT,body TEXT)");
      db.prepare("INSERT INTO credential VALUES('openai',?)").run(JSON.stringify({ type: "oauth", access: secret, refresh: secret }));
      db.prepare("INSERT INTO session VALUES('native',?)").run(`session ${secret}`); db.close(); await chmod(path, 0o600);
      ctx.store.confirmWorker(account.id, (await credentialEvidence(root, account)).digest); ctx.store.enableWorker(account.id, false);
      await mkdir(join(profile, "cache", "opencode"), { recursive: true }); await writeFile(join(profile, "cache", "opencode", "models.json"), `model list ${secret}`);
      await writeFile(join(profile, "cache", "opencode", "unknown.json"), `retain ${secret}`);
      return { account, profile, path };
    };
    const first = await make("first-fixture"), sibling = await make("second-fixture"), before = await readFile(first.path), evidence = await credentialEvidence(root, first.account);
    blocked = true;
    const active = await call("worker_account_cache_plan", { accountId: first.account.id }); assert.ok(active.blockedBy.length);
    await assert.rejects(call("worker_account_cache_clear", apply(active)), /Runtime still live/); blocked = false;
    const stale = await call("worker_account_cache_plan", { accountId: first.account.id });
    await writeFile(join(first.profile, "cache", "opencode", "models.json"), "changed catalog");
    await assert.rejects(call("worker_account_cache_clear", apply(stale)), /changed/);
    const plan = await call("worker_account_cache_plan", { accountId: first.account.id }), request = apply(plan);
    let notices = 0; ctx.onWorkerAccountsChanged = () => notices++;
    const receipt = await call("worker_account_cache_clear", request); assert.equal(receipt.status, "completed"); assert.ok(notices);
    assert.deepEqual(await call("worker_account_cache_clear", request), receipt);
    await assert.rejects(readFile(join(first.profile, "cache", "opencode", "models.json")), { code: "ENOENT" });
    assert.deepEqual(await readFile(first.path), before); assert.deepEqual(await credentialEvidence(root, first.account), evidence);
    assert.equal(await readFile(join(first.profile, "cache", "opencode", "unknown.json"), "utf8"), "retain first-fixture");
    assert.equal(await readFile(join(sibling.profile, "cache", "opencode", "models.json"), "utf8"), "model list second-fixture");
    const interrupted = await call("worker_account_cache_plan", { accountId: sibling.account.id }), interruptedInput = apply(interrupted);
    ctx.cache!.journal.begin(interruptedInput, interrupted); await api.closeContext!(ctx); ctx = await api.createContext(env);
    assert.equal((await call("worker_account_cache_clear", interruptedInput)).status, "unknown");
    assert.deepEqual(await call("worker_account_cache_clear", request), receipt);
    assert.equal(await readFile(join(sibling.profile, "cache", "opencode", "models.json"), "utf8"), "model list second-fixture");
    let release!: () => void; hold = new Promise(resolve => { release = resolve; });
    const observing = call("worker_account_cache_plan", { accountId: sibling.account.id });
    await assert.rejects(call("worker_account_set_enabled", { id: sibling.account.id, enabled: true }), /in progress/);
    release(); await observing; hold = null;
    ctx.store.enableWorker(sibling.account.id, true);
    assert.ok((await call("worker_account_cache_plan", { accountId: sibling.account.id })).blockedBy.some((row: string) => row.includes("disabled")));
    ctx.store.enableWorker(sibling.account.id, false);
    const cache = join(first.profile, "cache", "opencode", "models.json"); await symlink(sibling.path, cache);
    assert.ok((await call("worker_account_cache_plan", { accountId: first.account.id })).blockedBy.some((row: string) => row.includes("unsafe")));
    const unsupported = ctx.store.prepareWorker("devin"); assert.ok((await call("worker_account_cache_plan", { accountId: unsupported.id })).blockedBy.some((row: string) => row.includes("allow-list")));
    await assert.rejects(call("worker_account_cache_plan", { accountId: sibling.account.id }, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /operator authority/);
  } finally { await api.closeContext!(ctx); await worker.close(); await rm(root, { recursive: true, force: true }); }
});
