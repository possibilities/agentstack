import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { serveSocket, socketCall, socketPath, type StatePlan } from "@stack/api";
import { api as authApi } from "@stack/auth";
import { accountRoot, accountEnvironment, prepareAccountProfile } from "@stack/auth";
import { api } from "../api.js";
import { WorkerManager } from "../src/manager.js";
import { WorkerSupervisor } from "../src/supervisor.js";

const opencode = process.env.STACK_OPENCODE_BIN ?? join(homedir(), ".local", "bin", "opencode");
const devin = process.env.STACK_DEVIN_BIN ?? join(homedir(), ".local", "share", "devin", "cli", "_versions", "current", "bin", "devin");
const sandbox = '(version 1) (allow default) (deny network-outbound (require-not (remote ip "localhost:*"))) (deny process-exec (literal "/usr/bin/open"))';
const request = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });

test("verified offline native primitives delete exact sessions/descendants but retain sibling transcripts, credentials and Stack unknown admissions", {
  skip: process.platform !== "darwin" || !existsSync(opencode) || !existsSync(devin), timeout: 120_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stack-native-state-"))), env = { ...process.env, STACK_STATE_DIR: root, STACK_OPENCODE_BIN: opencode, STACK_DEVIN_BIN: devin };
  const auth = await authApi.createContext(env), supervisor = new WorkerSupervisor(root, env), manager = new WorkerManager(root, supervisor, env);
  const authServer = await serveSocket({ info: { name: "auth", description: "Auth", transportDescription: "Socket", path: socketPath("auth", env) }, context: auth, operations: authApi.operations });
  const workerServer = await serveSocket({ info: { name: "worker", description: "Worker", transportDescription: "Socket", path: socketPath("worker", env) }, context: { manager, supervisor }, operations: api.operations });
  const call = async (name: string, args: unknown): Promise<any> => socketCall(workerServer.path, "tools/call", { name, arguments: args });
  const native = async (binary: string, args: string[], cwd: string, profileEnv: NodeJS.ProcessEnv) => (await promisify(execFile)("/usr/bin/sandbox-exec", ["-p", sandbox, binary, ...args], { cwd, env: profileEnv, timeout: 30_000, maxBuffer: 2_000_000 })).stdout.trim();
  const make = async (provider: "codex" | "devin" | "claude") => {
    const account = provider === "codex" ? (() => { const bot = auth.store.addAccount(JSON.stringify({ tokens: { refresh_token: "fixture-refresh", access_token: "fixture-access", id_token: "fixture.jwt.signature" } })); return auth.store.workerAccounts().find(row => row.id === auth.store.pairedWorker(bot.id))!; })() : auth.store.prepareWorker(provider);
    auth.store.enableWorker(account.id, false);
    // Claude's real profile preparation owns keychain recovery. This credential-free
    // fixture only creates the transcript root; it never imports/signs in an account.
    if (provider !== "claude") await prepareAccountProfile(root, account);
    else await mkdir(join(accountRoot(root, account.id), "claude", "projects"), { recursive: true, mode: 0o700 });
    const cwd = join(root, `cwd-${provider}`); await mkdir(cwd);
    const input = { botId: "_local_operator", threadId: "", accountId: account.id, provider, model: "fixture", effort: "low", repo: cwd, baseRef: null, task: "Stack retained private prompt", requestId: randomUUID() };
    const reserved = manager.ledger.reserve(input);
    const sibling = manager.ledger.reserve({ ...input, requestId: randomUUID() });
    // Prepared cwd is captured by the ledger owner, no paid Worker/native turn.
    manager.ledger.setWorktree(reserved.worker.id, { repo: cwd, cwd, branch: `stack-worker-${reserved.worker.id}`, baseCommit: "f".repeat(40), sourceDirty: false, roleId: randomUUID(), roleRevision: 1 });
    manager.ledger.setWorktree(sibling.worker.id, { repo: cwd, cwd, branch: `stack-worker-${sibling.worker.id}`, baseCommit: "f".repeat(40), sourceDirty: false, roleId: randomUUID(), roleRevision: 1 });
    manager.ledger.completeTurn(reserved.turn.id, "unknown", null, "native outcome unresolved");
    manager.ledger.setWorkerPhase(reserved.worker.id, "closed"); manager.ledger.setWorkerPhase(sibling.worker.id, "closed");
    const profile = accountRoot(root, account.id), profileEnv = accountEnvironment(root, account, env); profileEnv.HOME = profile;
    return { account, cwd, reserved, sibling, profile, profileEnv };
  };
  try {
    await assert.rejects(call("worker_state_native_effect", { id: randomUUID(), workerId: randomUUID(), token: randomUUID(), provider: "codex" }), /owner-issued/);
    const codex = await make("codex");
    const create = async (title: string) => JSON.parse(await native(opencode, ["api", "post", "/api/session", "--standalone", "--data", JSON.stringify({ title, location: { directory: codex.cwd } })], codex.cwd, codex.profileEnv)).data;
    const selected = await create("Selected fixture"), child = await create("Selected descendant fixture"), other = await create("Unselected sibling fixture");
    const codexPath = join(codex.profile, "data", "opencode", "opencode.db"), codexDb = new DatabaseSync(codexPath);
    codexDb.prepare("UPDATE session_v2 SET parent_id=? WHERE id=?").run(selected.id, child.id);
    codexDb.prepare("INSERT INTO credential(id,integration_id,label,value,time_created,time_updated) VALUES('fixture','openai','Fixture',?,0,0)").run(JSON.stringify({ type: "oauth", access: "fake-access", refresh: "fake-refresh" })); codexDb.close();
    manager.ledger.setSession(codex.reserved.worker.id, selected.id); manager.ledger.setSession(codex.sibling.worker.id, other.id);
    manager.ledger.setWorkerPhase(codex.reserved.worker.id, "closed"); manager.ledger.setWorkerPhase(codex.sibling.worker.id, "closed");
    const blocked = await call("worker_state_plan", { kind: "native_session", ids: [codex.reserved.worker.id] }); assert.deepEqual(blocked.blockedBy, []);
    const stale = request(blocked), db = new DatabaseSync(codexPath); db.prepare("UPDATE session_v2 SET title='changed after plan' WHERE id=?").run(selected.id); db.close();
    await assert.rejects(call("worker_state_clear", stale), /changed/);
    const plan = await call("worker_state_plan", { kind: "native_session", ids: [codex.reserved.worker.id] }); assert.ok(plan.retained.some((s: string) => s.includes(child.id)));
    const input = request(plan), receipt = await call("worker_state_clear", input); assert.equal(receipt.status, "completed"); assert.deepEqual(await call("worker_state_clear", input), receipt);
    const verify = new DatabaseSync(codexPath, { readOnly: true });
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM session_v2 WHERE id IN (?,?)").get(selected.id, child.id)!.n, 0);
    assert.equal(verify.prepare("SELECT title FROM session_v2 WHERE id=?").get(other.id)!.title, "Unselected sibling fixture"); assert.match(String(verify.prepare("SELECT value FROM credential WHERE id='fixture'").get()!.value), /fake-refresh/); verify.close();
    assert.equal((await call("worker_turn_list", { id: codex.reserved.worker.id })).turns[0].phase, "unknown"); assert.equal((await call("worker_turn_list", { id: codex.sibling.worker.id })).turns[0].prompt, "Stack retained private prompt");

    const d = await make("devin"); await native(devin, ["list", "--format", "json"], d.cwd, d.profileEnv);
    const dpath = join(d.profile, "data", "devin", "cli", "sessions.db"), ddb = new DatabaseSync(dpath), ids = ["fixture-selected-native", "fixture-sibling-native"];
    for (const sid of ids) {
      ddb.prepare("INSERT INTO sessions(id,working_directory,backend_type,model,agent_mode,created_at,last_activity_at) VALUES(?,?,'local','swe-1-6-fast','code',0,0)").run(sid, d.cwd);
      ddb.prepare("INSERT INTO prompt_history(content,timestamp,session_id) VALUES('native private prompt',0,?)").run(sid);
    }
    ddb.close(); await writeFile(join(d.profile, "data", "devin", "credentials.toml"), "fake credential sentinel");
    manager.ledger.setSession(d.reserved.worker.id, ids[0]!); manager.ledger.setSession(d.sibling.worker.id, ids[1]!);
    manager.ledger.setWorkerPhase(d.reserved.worker.id, "closed"); manager.ledger.setWorkerPhase(d.sibling.worker.id, "closed");
    const dp = await call("worker_state_plan", { kind: "native_session", ids: [d.reserved.worker.id] }); assert.deepEqual(dp.blockedBy, []);
    const dr = await call("worker_state_clear", request(dp)); assert.equal(dr.status, "completed");
    const dv = new DatabaseSync(dpath, { readOnly: true }); assert.equal(dv.prepare("SELECT id FROM sessions WHERE id=?").get(ids[0]!), undefined); assert.equal(dv.prepare("SELECT content FROM prompt_history WHERE session_id=?").get(ids[1]!)!.content, "native private prompt"); dv.close();
    assert.equal(await readFile(join(d.profile, "data", "devin", "credentials.toml"), "utf8"), "fake credential sentinel");

    const c = await make("claude"), sid = randomUUID(), siblingId = randomUUID(), project = join(c.profile, "claude", "projects", c.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(join(project, sid, "subagents"), { recursive: true });
    await writeFile(join(project, `${sid}.jsonl`), JSON.stringify({ type: "user", sessionId: sid, uuid: randomUUID(), cwd: c.cwd, message: { role: "user", content: "Claude native fixture body" } }) + "\n");
    await writeFile(join(project, `${siblingId}.jsonl`), "Claude sibling transcript sentinel\n"); await writeFile(join(project, sid, "subagents", "agent-fixture.jsonl"), "native child body\n");
    await writeFile(join(c.profile, "claude", "credentials-sentinel"), "not selected");
    manager.ledger.setSession(c.reserved.worker.id, sid); manager.ledger.setSession(c.sibling.worker.id, siblingId);
    manager.ledger.setWorkerPhase(c.reserved.worker.id, "closed"); manager.ledger.setWorkerPhase(c.sibling.worker.id, "closed");
    const cp = await call("worker_state_plan", { kind: "native_session", ids: [c.reserved.worker.id] }); assert.deepEqual(cp.blockedBy, []);
    assert.equal((await call("worker_state_clear", request(cp))).status, "completed");
    await assert.rejects(readFile(join(project, `${sid}.jsonl`)), { code: "ENOENT" }); await assert.rejects(readFile(join(project, sid, "subagents", "agent-fixture.jsonl")), { code: "ENOENT" });
    assert.equal(await readFile(join(project, `${siblingId}.jsonl`), "utf8"), "Claude sibling transcript sentinel\n"); assert.equal(await readFile(join(c.profile, "claude", "credentials-sentinel"), "utf8"), "not selected");
  } finally { await workerServer.close(); await authServer.close(); await manager.close(); await authApi.closeContext!(auth); await rm(root, { recursive: true, force: true }); }
});
