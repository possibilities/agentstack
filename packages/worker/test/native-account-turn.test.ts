import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { configuredMcpServers, operation, serveApi, serveSocket, socketCall, socketPath, workspaceRoot } from "@stack/api";
import { accountEnvironment, type WorkerAccount } from "@stack/auth";
import type { RoleSnapshot } from "@stack/roles";
import { WorkerManager } from "../src/manager.js";
import { WorkerSupervisor } from "../src/supervisor.js";
import { api as workersApi } from "../api.js";

const git = (cwd: string, args: string[]) => new Promise<void>((resolve, reject) =>
  execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (error) => error ? reject(error) : resolve()));
const skillList = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) =>
  execFile(command, args, { cwd, env, timeout: 15_000, maxBuffer: 200_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));

test("an isolated native Devin account finishes Worker turns in owned worktrees", {
  skip: process.env.STACK_NATIVE_ACCOUNT_TURN !== "1", timeout: 240_000,
}, async (t) => {
  const root = await mkdtemp("/tmp/aswa-");
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "README.md"), "A disposable worker test repository.\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  const env = { ...process.env, STACK_STATE_DIR: root };
  const disabledInternalMcpServers = (await configuredMcpServers(workspaceRoot(import.meta.dirname))).map(item => item.name).filter(name => name !== "worker");
  const role: RoleSnapshot = { id: randomUUID(), name: "Fixture", description: "", createdAt: null, updatedAt: null, disabledInternalMcpServers, revision: 1, categories: [{ id: randomUUID(), title: "Test", description: "", enabled: true, createdAt: null, updatedAt: null,
    fragments: [{ id: randomUUID(), categoryId: randomUUID(), title: "Prime", description: "", enabled: true, body: "Follow the disposable test task.", createdAt: null, updatedAt: null }] }],
    skills: [{ id: randomUUID(), name: "stack-smoke", description: "Describe test verification", body: "Describe the test result.", files: [], enabled: true }],
    mcpServers: [], trustedProjects: [] };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const roles = await serveSocket({ info: { name: "roles", description: "Roles", transportDescription: "Socket", path: socketPath("roles", env) },
    context: {}, operations: [operation({ name: "role_launch_snapshot", description: "Role", input: z.object({}), output: z.any(),
      async call() { return role; } })] });
  const server = await serveSocket({ info: { name: "serve", description: "Server", transportDescription: "Socket", path: socketPath("serve", env) },
    context: {}, operations: [operation({ name: "serve_status", description: "Status", input: z.object({}), output: z.any(),
      async call() { return { mcpUrls: {} }; } })] });
  const supervisor = new WorkerSupervisor(root, env);
  const manager = new WorkerManager(root, supervisor, env);
  const workers = await serveSocket({ info: { name: "worker", description: "Workers", transportDescription: "Socket", path: socketPath("worker", env) },
    context: { supervisor, manager }, operations: workersApi.operations });
  try {
    const provision = async (provider: "devin"): Promise<string> => {
      const prepared = await socketCall(socketPath("auth", env), "tools/call", {
        name: "worker_account_prepare", arguments: { provider },
      }) as { account: { id: string } };
      const id = prepared.account.id;
      const destination = join(root, "worker-accounts", id, "data", "devin", "credentials.toml");
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
      await copyFile(join(homedir(), ".local", "share", "devin", "credentials.toml"), destination);
      await chmod(destination, 0o600);
      await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_confirm", arguments: { id } });
      return id;
    };
    const devinId = await provision("devin");
    await supervisor.reconcile();
    for (const [provider, accountId, model] of [["devin", devinId, "swe-1-6-fast"]] as const) {
      const catalog = await supervisor.catalog(accountId, true);
      assert.equal(catalog.stale, false);
      assert.ok(catalog.models.some((item) => item.id === model));
      const marker = `STACK_${provider.toUpperCase()}_WORKER_READY`;
      const task = `Reply exactly ${marker}. Do not call tools or change files.`;
      const started = await manager.start({ accountId, model, repo, task, requestId: randomUUID() });
      assert.notEqual(started.worker.phase, "failed");
      for (let i = 0; i < 240 && (await manager.status(started.worker.id)).worker.phase !== "idle"; i++)
        await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await manager.status(started.worker.id);
      assert.equal(status.worker.phase, "idle");
      assert.equal(status.turn?.stopReason, "end_turn");
      const transcript = await manager.read(started.worker.id, 0, 50);
      assert.match(transcript.entries.filter((entry) => entry.kind === "agent").map((entry) => entry.text).join(""), new RegExp(marker));
      assert.ok(status.worker.cwd?.includes(`/workers/worktrees/${started.worker.id}`));
      const account: WorkerAccount = { id: accountId, provider, enabled: true, ready: true, removing: false };
      const discovered = await skillList("devin", ["skills", "list"], status.worker.cwd!, accountEnvironment(root, account, env));
      assert.match(discovered, /stack-smoke/);
      console.log(JSON.stringify({ provider, model, worktree: true, stopReason: status.turn.stopReason, reply: true, skillsVisible: true }));
      await manager.closeWorker(started.worker.id);
      await manager.remove(started.worker.id, true);
    }
  } finally {
    await manager.close();
    await workers.close();
    await server.close(); await roles.close(); await auth.close();
    await rm(root, { recursive: true, force: true });
  }
});
