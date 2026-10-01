import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { RoleSnapshot } from "@stack/roles";
import type { StatePlan } from "@stack/api";
import { WorkerManager } from "../src/manager.js";
import { WorkerSupervisor } from "../src/supervisor.js";
import { claimWorktree } from "../src/worktree.js";
import { api } from "../api.js";

const request = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
const role: RoleSnapshot = { id: randomUUID(), name: "Fixture", description: "", revision: 1, createdAt: null, updatedAt: null, categories: [], skills: [], mcpServers: [], trustedProjects: [], disabledInternalMcpServers: [] };
const git = async (cwd: string, args: string[]) => (await promisify(execFile)("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { timeout: 10_000 })).stdout.trim();
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stack-worker-state-"))), env = { ...process.env, STACK_STATE_DIR: root };
  const repo = join(root, "repo"); await mkdir(repo); await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture"]); await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "file.txt"), "base\n"); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "base"]);
  const supervisor = new WorkerSupervisor(root, env); const manager = new WorkerManager(root, supervisor, env);
  const call = async (name: string, input: unknown, invocation?: any): Promise<any> => { const op = api.operations.find(op => op.name === name)!; return op.output.parse(await op.call({ manager, supervisor }, op.input.parse(input), invocation)); };
  const make = async (phase: "closed" | "idle" = "closed") => {
    const input = { botId: "_local_operator", threadId: "", accountId: randomUUID(), provider: "codex" as const, model: "fixture", effort: "low", repo, baseRef: null, task: "private prompt", requestId: randomUUID() };
    const workContext = { workItemId: randomUUID(), scopeRevision: 3, source: "explicit" as const };
    const row = manager.ledger.reserve(input, workContext);
    const claim = await claimWorktree(root, row.worker.id, repo, undefined, role);
    manager.ledger.setWorktree(row.worker.id, claim); manager.ledger.setWorkerPhase(row.worker.id, phase); return { ...row, claim, input, workContext };
  };
  let closed = false;
  return { root, env, repo, supervisor, manager, call, make, async close(remove = true) { if (!closed) { await manager.close(); closed = true; } if (remove) await rm(root, { recursive: true, force: true }); } };
}

test("closed owned Git reset fences files/index, retains the old tip and foreign/source/sibling bytes; branches require exact recorded unreferenced scope", async () => {
  const f = await fixture();
  try {
    const selected = await f.make(), sibling = await f.make(); const id = selected.worker.id, cwd = selected.claim.cwd;
    await writeFile(join(cwd, "file.txt"), "committed Worker change\n"); await git(cwd, ["add", "."]); await git(cwd, ["commit", "-m", "Worker unmerged tip"]);
    const oldTip = await git(cwd, ["rev-parse", "HEAD"]);
    await writeFile(join(cwd, "file.txt"), "staged change\n"); await git(cwd, ["add", "."]);
    await writeFile(join(cwd, "untracked file.txt"), "uncommitted body");
    await writeFile(join(f.repo, "source-only.txt"), "human source edits");
    const stale = await f.call("worker_state_plan", { kind: "git_reset", ids: [id] }); assert.deepEqual(stale.blockedBy, []);
    await writeFile(join(cwd, "file.txt"), "changed after plan\n");
    await assert.rejects(f.call("worker_state_clear", request(stale)), /changed/);
    const plan = await f.call("worker_state_plan", { kind: "git_reset", ids: [id] }), input = request(plan);
    let notices = 0; f.manager.onChange = () => notices++;
    const receipt = await f.call("worker_state_clear", input); assert.equal(receipt.status, "completed"); assert.ok(notices > 1);
    assert.deepEqual(await f.call("worker_state_clear", input), receipt);
    assert.equal(await git(cwd, ["rev-parse", "HEAD"]), selected.claim.baseCommit);
    assert.equal(await git(f.repo, ["rev-parse", `refs/stack/retained/${id}`]), oldTip);
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "base\n"); await assert.rejects(readFile(join(cwd, "untracked file.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(cwd, ".devin", "stack-owner.json"), "utf8"), JSON.stringify({ id }));
    assert.equal(await readFile(join(f.repo, "source-only.txt"), "utf8"), "human source edits");
    assert.equal(await readFile(join(sibling.claim.cwd, "file.txt"), "utf8"), "base\n");
    assert.equal((await f.call("worker_diff", { id })).files.length, 0);
    const checked = await f.call("worker_state_plan", { kind: "branch", ids: [id] }); assert.ok(checked.blockedBy.some((s: string) => s.includes("checked out")));
    await assert.rejects(f.call("worker_state_clear", request(checked)), /references|checked out/);
    await f.call("worker_remove", { id, discardWorktree: true });
    assert.ok((await f.call("worker_state_branches", {})).branches.some((row: any) => row.workerId === id));
    const branchPlan = await f.call("worker_state_plan", { kind: "branch", ids: [id] }); assert.deepEqual(branchPlan.blockedBy, []);
    const branchInput = request(branchPlan); assert.equal((await f.call("worker_state_clear", branchInput)).status, "completed");
    await assert.rejects(git(f.repo, ["rev-parse", "--verify", `refs/heads/${selected.claim.branch}`]));
    assert.equal(await git(f.repo, ["rev-parse", `refs/stack/retained/${id}`]), oldTip);
    const foreign = randomUUID(); await git(f.repo, ["branch", `stack-worker-${foreign}`]);
    await assert.rejects(f.call("worker_state_plan", { kind: "branch", ids: [foreign] }), /No recorded/);
    const unmerged = await f.make(); await writeFile(join(unmerged.claim.cwd, "unique.txt"), "unmerged tip"); await git(unmerged.claim.cwd, ["add", "."]); await git(unmerged.claim.cwd, ["commit", "-m", "unique"]);
    await f.call("worker_remove", { id: unmerged.worker.id, discardWorktree: true });
    assert.ok((await f.call("worker_state_plan", { kind: "branch", ids: [unmerged.worker.id] })).blockedBy.some((s: string) => s.includes("Unmerged")));
    const external = join(f.root, "external-worktree"); await git(f.repo, ["worktree", "add", external, unmerged.claim.branch]);
    const checkedOut = await f.call("worker_state_plan", { kind: "branch", ids: [unmerged.worker.id], allowUnmerged: [unmerged.worker.id] });
    assert.equal(checkedOut.blockedBy.length, 1); await assert.rejects(f.call("worker_state_clear", request(checkedOut)), /checked out/);
    await git(f.repo, ["worktree", "remove", external]);
    const override = await f.call("worker_state_plan", { kind: "branch", ids: [unmerged.worker.id], allowUnmerged: [unmerged.worker.id] });
    assert.equal((await f.call("worker_state_clear", request(override))).status, "completed");
    const live = await f.make("idle"); assert.ok((await f.call("worker_state_plan", { kind: "git_reset", ids: [live.worker.id] })).blockedBy.some((s: string) => s.includes("closed")));
    await symlink(join(f.repo, "source-only.txt"), join(sibling.claim.cwd, "escape"));
    assert.ok((await f.call("worker_state_plan", { kind: "git_reset", ids: [sibling.worker.id] })).blockedBy.some((s: string) => s.includes("unsafe")));
    await assert.rejects(f.call("worker_state_plan", { kind: "transcript", ids: [sibling.worker.id] }, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /operator authority/);
  } finally { await f.close(); }
});

test("transcript redaction preserves unknown turns, admission replay, usage and Work; restarted file admission stays unknown and catalog siblings retain sessions", async () => {
  const f = await fixture();
  try {
    const selected = await f.make(), sibling = await f.make(), id = selected.worker.id;
    f.manager.ledger.history.update(id, selected.turn.id, "live", { sessionUpdate: "tool_call", toolCallId: "secret-tool", title: "private title", rawInput: { body: "secret payload" }, rawOutput: "secret output" });
    f.manager.ledger.history.update(id, selected.turn.id, "live", { sessionUpdate: "usage_update", used: 4, size: 10, cost: { amount: 1, currency: "USD" } });
    f.manager.ledger.history.append(id, selected.turn.id, "session/prompt", "response", { usage: { input_tokens: 12, output_tokens: 4 }, _meta: { body: "private response payload" } });
    f.manager.ledger.completeTurn(selected.turn.id, "unknown", null, "inspected interruption"); f.manager.ledger.setWorkerPhase(id, "closed");
    const before = await f.call("worker_turn_list", { id });
    const stale = await f.call("worker_state_plan", { kind: "transcript", ids: [id] }); f.manager.ledger.append(id, selected.turn.id, "agent", "late retained body");
    await assert.rejects(f.call("worker_state_clear", request(stale)), /changed/);
    const input = request(await f.call("worker_state_plan", { kind: "transcript", ids: [id] })); const receipt = await f.call("worker_state_clear", input);
    assert.equal(receipt.status, "completed"); assert.deepEqual(await f.call("worker_state_clear", input), receipt);
    const after = await f.call("worker_turn_list", { id }); assert.equal(after.turns[0].id, before.turns[0].id); assert.equal(after.turns[0].phase, "unknown"); assert.equal(after.turns[0].prompt, null); assert.ok(after.turns[0].contentClearedAt);
    assert.equal((await f.call("worker_read", { id })).entries.every((row: any) => row.text === ""), true);
    assert.equal((await f.call("worker_tool_list", { id })).tools.length, 0);
    const records = JSON.stringify(await f.call("worker_record_list", { id })); assert.equal(records.includes("secret payload"), false); assert.equal(records.includes("private response payload"), false); assert.match(records, /USD/); assert.match(records, /input_tokens/);
    assert.ok((await f.call("worker_status", { id })).worker.contentClearedAt);
    assert.equal(f.manager.ledger.findStart(selected.turn.requestId, selected.input)!.turn.id, selected.turn.id);
    assert.deepEqual(after.turns[0].workContext, selected.workContext);
    await assert.rejects(f.call("worker_resume", { id, acknowledgeUnknownTurn: true }), /no loadable/);
    assert.equal((await f.call("worker_turn_list", { id: sibling.worker.id })).turns[0].prompt, "private prompt");
    const profile = join(f.root, "worker-accounts", sibling.worker.accountId); await mkdir(profile, { recursive: true }); await writeFile(join(profile, "catalog.json"), "cached derived catalog");
    const interrupted = await f.call("worker_state_plan", { kind: "catalog", ids: [sibling.worker.id] }), interruptedInput = request(interrupted);
    f.manager.state.journal.begin(interruptedInput, interrupted); await f.close(false);
    const supervisor = new WorkerSupervisor(f.root, f.env), manager = new WorkerManager(f.root, supervisor, f.env);
    try {
      assert.equal((await manager.state.clear(interruptedInput)).status, "unknown"); assert.equal(await readFile(join(profile, "catalog.json"), "utf8"), "cached derived catalog");
      const catalogPlan = await manager.state.plan({ kind: "catalog", ids: [sibling.worker.id], allowUnmerged: [] });
      assert.equal((await manager.state.clear(request(catalogPlan))).status, "completed"); await assert.rejects(readFile(join(profile, "catalog.json")), { code: "ENOENT" });
      assert.equal(manager.ledger.worker(sibling.worker.id)!.phase, "closed"); assert.equal(manager.ledger.turn(sibling.turn.id)!.prompt, "private prompt");
      assert.equal(manager.state.journal.receipt(input.requestId)!.status, "completed");
    } finally { await manager.close(); }
  } finally { await f.close(); }
});
