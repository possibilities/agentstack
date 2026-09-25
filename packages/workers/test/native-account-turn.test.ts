import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { operation, serveApi, serveMcp, serveSocket, socketCall, socketPath } from "@agentstack/api";
import { accountEnvironment, type WorkerAccount } from "@agentstack/auth";
import type { RoleSnapshot } from "@agentstack/roles";
import { WorkerManager } from "../src/manager.js";
import { WorkerSupervisor } from "../src/supervisor.js";
import { api as workersApi } from "../api.js";

const git = (cwd: string, args: string[]) => new Promise<void>((resolve, reject) =>
  execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (error) => error ? reject(error) : resolve()));
const skillList = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) =>
  execFile(command, args, { cwd, env, timeout: 15_000, maxBuffer: 200_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));

test("isolated native Grok and Devin accounts finish Worker turns in owned worktrees", {
  skip: process.env.AGENTSTACK_NATIVE_ACCOUNT_TURN !== "1", timeout: 240_000,
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
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root };
  const role: RoleSnapshot = { revision: 1, categories: [{ id: randomUUID(), title: "Test", description: "", enabled: true,
    fragments: [{ id: randomUUID(), categoryId: randomUUID(), title: "Prime", description: "", enabled: true, body: "Follow the disposable test task." }] }],
    skills: [{ id: randomUUID(), name: "agentstack-smoke", description: "Describe test verification", body: "Describe the test result.", files: [], enabled: true }],
    mcpServers: [], trustedProjects: [] };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const roles = await serveSocket({ info: { name: "roles", description: "Roles", transportDescription: "Socket", path: socketPath("roles", env) },
    context: {}, operations: [operation({ name: "role_snapshot", description: "Role", input: z.object({}), output: z.any(),
      async call() { return role; } })] });
  let mcpUrls: Record<string, string> = {};
  const owner = await serveSocket({ info: { name: "owner", description: "Owner", transportDescription: "Socket", path: socketPath("owner", env) },
    context: {}, operations: [operation({ name: "owner_status", description: "Status", input: z.object({}), output: z.any(),
      async call() { return { mcpUrls }; } })] });
  const supervisor = new WorkerSupervisor(root, env);
  const manager = new WorkerManager(root, supervisor, env);
  const workers = await serveSocket({ info: { name: "workers", description: "Workers", transportDescription: "Socket", path: socketPath("workers", env) },
    context: { supervisor, manager }, operations: workersApi.operations });
  const catalogRoot = join(root, "catalog");
  await mkdir(join(catalogRoot, "packages", "workers"), { recursive: true });
  await writeFile(join(catalogRoot, "packages", "workers", "api.yaml"), "name: workers\ndescription: Workers.\nmcp:\n  description: Worker MCP.\n");
  const mcp = await serveMcp({ root: catalogRoot, env, port: 0 });
  mcpUrls = { workers: mcp.urls.workers! };
  try {
    const native = JSON.parse(await readFile(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")) as {
      xai?: { type?: string; expires?: number };
    };
    if (native.xai?.type !== "oauth" || typeof native.xai.expires !== "number" || native.xai.expires < Date.now() + 10 * 60_000) {
      t.skip("native xAI credential is too close to expiry to copy without a competing refresh writer");
      return;
    }
    const provision = async (provider: "grok" | "devin"): Promise<string> => {
      const prepared = await socketCall(socketPath("auth", env), "tools/call", {
        name: "worker_account_prepare", arguments: { provider },
      }) as { account: { id: string } };
      const id = prepared.account.id;
      const destination = provider === "grok" ? join(root, "worker-accounts", id, "data", "opencode", "auth.json")
        : join(root, "worker-accounts", id, "data", "devin", "credentials.toml");
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
      if (provider === "grok") await writeFile(destination, JSON.stringify({ xai: native.xai }), { mode: 0o600 });
      else {
        await copyFile(join(homedir(), ".local", "share", "devin", "credentials.toml"), destination);
        await chmod(destination, 0o600);
      }
      await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_confirm", arguments: { id } });
      return id;
    };
    const grokId = await provision("grok");
    const devinId = await provision("devin");
    await supervisor.reconcile();
    for (const [provider, accountId, model] of [["grok", grokId, "xai/grok-build-0.1"], ["devin", devinId, "swe-1-6-fast"]] as const) {
      const catalog = await supervisor.catalog(accountId, true);
      assert.equal(catalog.stale, false);
      assert.ok(catalog.models.some((item) => item.id === model));
      const marker = `AGENTSTACK_${provider.toUpperCase()}_WORKER_READY`;
      const started = await manager.start({ accountId, model, repo, task: `Reply exactly ${marker}. Do not call tools or change files.`, requestId: randomUUID() });
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
      const discovered = provider === "grok"
        ? await skillList("opencode", ["debug", "skill"], status.worker.cwd!, accountEnvironment(root, account, env))
        : await skillList("devin", ["skills", "list"], status.worker.cwd!, accountEnvironment(root, account, env));
      assert.match(discovered, /agentstack-smoke/);
      if (provider === "devin") assert.match(discovered, /prime/);
      console.log(JSON.stringify({ provider, model, worktree: true, stopReason: status.turn.stopReason, reply: true, skillsVisible: true }));
      await manager.closeWorker(started.worker.id);
      await manager.remove(started.worker.id, true);
    }
  } finally {
    await manager.close();
    await mcp.close(); await workers.close();
    await owner.close(); await roles.close(); await auth.close();
    await rm(root, { recursive: true, force: true });
  }
});
