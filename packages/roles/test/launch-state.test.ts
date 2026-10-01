import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { api } from "../api.js";
import { processBirth } from "../src/launch-state.js";
import type { StatePlan } from "@stack/api";

const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
test("Role launch cleanup is exact, liveness/staleness fenced, and never reexecutes uncertain admissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "role-launch-state-")), env = { STACK_STATE_DIR: root, STACK_COMMAND_DIR: join(root, "commands") };
  let ctx = await api.createContext(env);
  const call = async (name: string, args: unknown, invocation?: any) => {
    const op = api.operations.find(op => op.name === name)!; return op.output.parse(await op.call(ctx, op.input.parse(args), invocation)) as any;
  };
  const make = async (id: string, state: string, birth: string) => {
    const path = join(root, "roles", "inject", id); await mkdir(path);
    await writeFile(join(path, "launch-lock.json"), JSON.stringify({ version: 1, pid: process.pid, birth, state }));
    await writeFile(join(path, "native-history"), `private ${id}`); return path;
  };
  try {
    const first = await make("codex-ABC123", "exited", "earlier PID incarnation"), sibling = await make("codex-DEF456", "exited", "earlier PID incarnation");
    await make("codex-LIVE12", "running", await processBirth(process.pid));
    await make("codex-UNKN12", "preparing", "earlier PID incarnation");
    const listed = await call("role_launch_list", {});
    assert.equal(listed.launches.find((row: any) => row.id === "codex-LIVE12").state, "live");
    assert.equal(listed.launches.find((row: any) => row.id === "codex-UNKN12").state, "unknown");
    for (const id of ["codex-LIVE12", "codex-UNKN12"]) {
      const plan = await call("role_launch_plan", { ids: [id] }); assert.ok(plan.blockedBy.length);
      await assert.rejects(call("role_launch_clear", apply(plan)), /alive|interrupted/);
    }
    const stale = await call("role_launch_plan", { ids: ["codex-ABC123"] });
    await writeFile(join(first, "native-history"), "changed native history");
    await assert.rejects(call("role_launch_clear", apply(stale)), /changed/);
    const plan = await call("role_launch_plan", { ids: ["codex-ABC123"] }), request = apply(plan);
    const receipt = await call("role_launch_clear", request); assert.equal(receipt.status, "completed");
    assert.deepEqual(await call("role_launch_clear", request), receipt);
    await assert.rejects(readFile(join(first, "native-history")), { code: "ENOENT" });
    assert.equal(await readFile(join(sibling, "native-history"), "utf8"), "private codex-DEF456");
    assert.ok(!(await call("role_launch_list", {})).launches.some((row: any) => row.id === "codex-ABC123"));
    const interrupted = await call("role_launch_plan", { ids: ["codex-DEF456"] }), interruptedInput = apply(interrupted);
    ctx.launches!.journal.begin(interruptedInput, interrupted);
    await api.closeContext!(ctx); ctx = await api.createContext(env);
    const unknown = await call("role_launch_clear", interruptedInput); assert.equal(unknown.status, "unknown");
    assert.deepEqual(await call("role_launch_clear", interruptedInput), unknown);
    assert.equal(await readFile(join(sibling, "native-history"), "utf8"), "private codex-DEF456");
    assert.deepEqual((await call("roles_state_receipt_get", { requestId: request.requestId })).receipt, receipt);
    await symlink(sibling, join(root, "roles", "inject", "codex-SYML12"));
    const symlinkPlan = await call("role_launch_plan", { ids: ["codex-SYML12"] }); assert.ok(symlinkPlan.blockedBy.some((row: string) => row.includes("symlink")));
    await assert.rejects(call("role_launch_clear", apply(symlinkPlan)), /symlink|invalid launch lock/);
    await assert.rejects(call("role_launch_plan", { ids: ["codex-DEF456"] }, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /operator authority/);
  } finally { await api.closeContext!(ctx); await rm(root, { recursive: true, force: true }); }
});
