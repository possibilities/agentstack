import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { operation, parseWorkerMcpIdentity, serveApi, serveSocket, socketCall, socketPath } from "@agentstack/api";
import { type RoleSnapshot } from "@agentstack/roles";
import { WorkerSupervisor } from "../src/supervisor.js";
import { WorkerManager } from "../src/manager.js";
import { claimWorktree, removeWorktree } from "../src/worktree.js";
import { api as workersApi } from "../api.js";
import { writeV2Credential } from "./v2-credential-fixture.js";

const role: RoleSnapshot = { revision: 7, categories: [{ id: randomUUID(), title: "Guidance", description: "", enabled: true,
  fragments: [{ id: randomUUID(), categoryId: randomUUID(), title: "Brief", description: "", body: "Check your work.", enabled: true }] }],
  skills: [{ id: randomUUID(), name: "review", description: "Review changes", body: "Review the diff.", files: [], enabled: true }],
  mcpServers: [{ id: randomUUID(), name: "fixture-mcp", description: "", enabled: true,
    definition: { type: "stdio", command: process.execPath, args: ["--version"], env: { TEST_SECRET: "fixture-secret" } } }], trustedProjects: [] };

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (error, stdout) =>
    error ? reject(error) : resolve(stdout.trim())));
}

async function repoFixture(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo);
  await run(repo, ["init", "-b", "main"]);
  await run(repo, ["config", "user.name", "Fixture"]);
  await run(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await run(repo, ["add", "README.md"]);
  await run(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("worker Role resources are private and ignored in only the owned worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-worker-tree-"));
  try {
    const repo = await repoFixture(root);
    const id = randomUUID();
    const claimed = await claimWorktree(root, id, repo, undefined, role);
    assert.equal(claimed.roleRevision, 7);
    assert.equal(claimed.sourceDirty, false);
    assert.equal(await run(claimed.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.match(await readFile(join(claimed.cwd, ".devin", "skills", "prime", "SKILL.md"), "utf8"), /Check your work/);
    assert.match(await readFile(join(claimed.cwd, ".devin", "skills", "prime", "SKILL.md"), "utf8"), /triggers: \[user\]/);
    assert.match(await readFile(join(claimed.cwd, ".opencode", "skills", "review", "SKILL.md"), "utf8"), /Review the diff/);
    assert.match(await readFile(join(claimed.cwd, ".devin", "skills", "review", "SKILL.md"), "utf8"), /Review the diff/);
    await assert.rejects(stat(join(repo, ".devin")), /ENOENT/);
    await removeWorktree(claimed, id);
    assert.equal(await run(repo, ["rev-parse", "--verify", claimed.branch]), claimed.baseCommit);
    const interruptedId = randomUUID();
    const orphan = join(root, "workers", "worktrees", interruptedId);
    await run(repo, ["worktree", "add", "-b", `agentstack-worker-${interruptedId}`, orphan, "HEAD"]);
    await removeWorktree({ repo, cwd: orphan, branch: `agentstack-worker-${interruptedId}` }, interruptedId);
    await assert.rejects(stat(orphan), /ENOENT/);
    await mkdir(join(repo, ".devin"));
    await writeFile(join(repo, ".devin", "config.json"), "{}");
    await run(repo, ["add", ".devin/config.json"]);
    await run(repo, ["commit", "-m", "own native configuration"]);
    await assert.rejects(claimWorktree(root, randomUUID(), repo, undefined, role), /already owns .devin/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const acpFixture = `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('fake-acp 2.0'); process.exit(0); }
let buffer = '';
let cwd = '';
let promptId = null;
let currentEffort = 'low';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const options = (model = 'xai/grok-build') => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'xai/grok-build', name: 'Grok Build' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: currentEffort,
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\\n'); if (end < 0) break;
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const frame = JSON.parse(raw);
    if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } },
      agentInfo: { version: 'fixture' } } });
    else if (frame.method === 'session/new') { cwd = frame.params.cwd;
      void writeFile(join(cwd, 'mcp-names.json'), JSON.stringify(frame.params.mcpServers.map((entry) => entry.name)));
      void writeFile(join(cwd, 'mcp-urls.json'), JSON.stringify(frame.params.mcpServers.filter((entry) => entry.type === 'http').map((entry) => ({ name: entry.name, url: entry.url }))));
      const sessionId = 'session-' + Date.now();
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the work' }] } } });
      send({ id: frame.id, result: { sessionId, configOptions: options() } }); }
    else if (frame.method === 'session/load') { cwd = frame.params.cwd;
      send({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'user_message_chunk', messageId: 'replayed-user', content: { type: 'text', text: 'Old task replay' } } } });
      send({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'replayed-agent', content: { type: 'text', text: 'Old answer replay' } } } });
      send({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE REASONING' } } } });
      send({ id: frame.id, result: { configOptions: options() } }); }
    else if (frame.method === 'session/set_config_option') {
      if (frame.params.configId === 'effort') currentEffort = frame.params.value;
      const reply = () => send({ id: frame.id, result: { configOptions: options() } });
      if (frame.params.value === 'high') setTimeout(reply, 200); else reply();
    }
    else if (frame.method === 'session/close') send({ id: frame.id, result: {} });
    else if (frame.method === 'session/prompt') {
      const text = frame.params.prompt[0].text;
      if (text.includes('ASK')) {
        promptId = frame.id;
        send({ id: 99001, method: 'session/request_permission', params: { sessionId: frame.params.sessionId,
          toolCall: { toolCallId: 't1', title: 'Write a fixture file' }, options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } });
      } else {
        void writeFile(join(cwd, 'output.txt'), text).then(() => {
          send({ method: 'session/update', params: { sessionId: frame.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tool-' + frame.id, title: 'Write', kind: 'edit', status: 'pending', rawInput: { filePath: 'output.txt' } } } });
          send({ method: 'session/update', params: { sessionId: frame.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-' + frame.id, status: 'completed', rawOutput: { output: 'written' }, content: [{ type: 'diff', path: 'output.txt', newText: text }] } } });
          send({ method: 'session/update', params: { sessionId: frame.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
          send({ id: frame.id, result: { stopReason: 'end_turn', usage: { inputTokens: 23, outputTokens: 7 } } });
        });
      }
    } else if (frame.id === 99001) {
      if (frame.result?.outcome?.outcome === 'cancelled') {
        send({ id: promptId, result: { stopReason: 'cancelled' } }); promptId = null;
      } else void writeFile(join(cwd, 'approved.txt'), JSON.stringify(frame.result)).then(() => {
          send({ id: promptId, result: { stopReason: 'end_turn' } }); promptId = null;
        });
    } else if (frame.method === 'session/cancel') {
      if (promptId) { send({ id: promptId, result: { stopReason: 'cancelled' } }); promptId = null; }
    }
  }
});`;

test("durable ACP workers dispatch, follow up, answer permissions, and load after owner restart", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-worker-execution-"));
  const repo = await repoFixture(root);
  const binary = join(root, "acp-fixture");
  await writeFile(binary, acpFixture);
  await chmod(binary, 0o700);
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root, AGENTSTACK_OPENCODE_BIN: binary };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const roles = await serveSocket({ info: { name: "roles", description: "Roles", transportDescription: "Socket", path: socketPath("roles", env) },
    context: {}, operations: [operation({ name: "role_snapshot", description: "Role", input: z.object({}), output: z.any(),
      async call() { return role; } })] });
  const owner = await serveSocket({ info: { name: "owner", description: "Owner", transportDescription: "Socket", path: socketPath("owner", env) },
    context: {}, operations: [operation({ name: "owner_status", description: "Status", input: z.object({}), output: z.any(),
      async call() { return { mcpUrls: { roles: "http://127.0.0.1:8743/mcp/roles" } }; } })] });
  const bots = await serveSocket({ info: { name: "bots", description: "Bots", transportDescription: "Socket", path: socketPath("bots", env) },
    context: {}, operations: [operation({ name: "bot_list", description: "List", input: z.object({}), output: z.any(),
      async call() { return { bots: [] }; } })] });
  let manager: WorkerManager | undefined;
  let workerSocket: Awaited<ReturnType<typeof serveSocket>> | undefined;
  const scopedChanges: string[] = [];
  try {
    const prepared = await socketCall(socketPath("auth", env), "tools/call", {
      name: "worker_account_prepare", arguments: { provider: "grok" },
    }) as { account: { id: string } };
    const accountId = prepared.account.id;
    const accountPath = join(root, "worker-accounts", accountId, "data", "opencode");
    await mkdir(accountPath, { recursive: true });
    await writeV2Credential(join(accountPath, "opencode.db"), "xai", JSON.stringify({ type: "oauth", access: "fixture", refresh: "fixture" }));
    await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_confirm", arguments: { id: accountId } });
    const supervisor = new WorkerSupervisor(root, env);
    manager = new WorkerManager(root, supervisor, env);
    manager.onChange = (id) => { if (id) scopedChanges.push(id); };
    workerSocket = await serveSocket({ info: { name: "workers", description: "Workers", transportDescription: "Socket", path: socketPath("workers", env) },
      context: { supervisor, manager }, operations: workersApi.operations });
    await supervisor.reconcile();
    const catalog = await supervisor.catalog(accountId, true);
    assert.deepEqual(catalog.models[0]?.efforts, ["low", "high"]);
    const start = { accountId, model: "xai/grok-build", effort: "low", repo, task: "Write an output file", requestId: randomUUID() };
    await assert.rejects(manager.start(start, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /Bot-bound MCP/);
    await assert.rejects(manager.start(start, { transport: "mcp", botId: "foreign-bot", instance: "old", threadId: "other", sessionId: null }), /verified Bot thread|Bot launch/);
    assert.deepEqual(manager.ledger.workers(), []);
    const failed = await manager.start({ ...start, requestId: randomUUID(), repo: join(root, 'missing-repo'), task: 'Retain failed preparation prompt' });
    assert.equal(failed.turn.phase, "failed"); assert.equal(failed.turn.promptChars, "Retain failed preparation prompt".length);
    assert.equal((await manager.turns(failed.worker.id, undefined, 1)).turns[0]?.prompt, "Retain failed preparation prompt");
    assert.equal(failed.turn.dispatchedAt, null); assert.equal(failed.turn.requestedModel, start.model);
    const started = await socketCall(socketPath("workers", env), "tools/call", { name: "worker_start", arguments: start }) as Awaited<ReturnType<WorkerManager["start"]>>;
    assert.equal(started.duplicate, false);
    await assert.rejects(manager.start({ ...start, task: "Different task" }), /requestId was reused/);
    const fromApi = await socketCall(socketPath("workers", env), "tools/call", { name: "worker_status", arguments: { id: started.worker.id } }) as { worker: { id: string } };
    assert.equal(fromApi.worker.id, started.worker.id);
    assert.equal((await manager.start(start)).worker.id, started.worker.id);
    const id = started.worker.id;
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.status(id)).turn?.stopReason, "end_turn");
    const detail = await socketCall(socketPath("workers", env), "tools/call", { name: "worker_detail", arguments: { id } }) as Awaited<ReturnType<WorkerManager["detail"]>>;
    assert.equal(detail.observedSettings?.model, "xai/grok-build");
    assert.equal(detail.observedSettings?.effort, "low");
    assert.ok(detail.metadata.some((entry) => entry.kind === "available_commands_update"));
    assert.ok(detail.metadata.some((entry) => entry.kind === "runtime"));
    assert.equal(detail.subagents.hierarchyAvailable, false);
    const toolPage = await socketCall(socketPath("workers", env), "tools/call", { name: "worker_tool_list", arguments: { id } }) as Awaited<ReturnType<WorkerManager["tools"]>>;
    assert.equal(toolPage.tools[0]?.title, "Write"); assert.equal(toolPage.tools[0]?.status, "completed");
    const history = await socketCall(socketPath("workers", env), "tools/call", { name: "worker_record_list", arguments: { id } }) as Awaited<ReturnType<WorkerManager["records"]>>;
    assert.ok(history.entries.some((entry) => entry.kind === "tool_call_update"));
    assert.equal(JSON.stringify(history).includes("fixture-secret"), false);
    assert.equal(JSON.stringify(history).includes("proof="), false);
    const turnHistory = await socketCall(socketPath("workers", env), "tools/call", { name: "worker_turn_list", arguments: { id } }) as Awaited<ReturnType<WorkerManager["turns"]>>;
    assert.equal(turnHistory.turns[0]?.prompt, start.task);
    assert.ok(turnHistory.turns[0]?.dispatchedPromptSeq);
    const chunk = await socketCall(socketPath("workers", env), "tools/call", { name: "worker_record_read", arguments: { id, seq: turnHistory.turns[0]!.dispatchedPromptSeq! } }) as { data: string };
    assert.match(chunk.data, /Check your work/);
    assert.ok(scopedChanges.includes(id));
    assert.deepEqual(JSON.parse(await readFile(join(started.worker.cwd!, "mcp-names.json"), "utf8")), ["roles", "fixture-mcp"]);
    const wiring = JSON.parse(await readFile(join(started.worker.cwd!, "mcp-urls.json"), "utf8")) as Array<{ name: string; url: string }>;
    assert.equal(wiring[0]?.name, "roles");
    assert.deepEqual(parseWorkerMcpIdentity(new URL(wiring[0]!.url), env), { workerId: id, instance: started.worker.runtimeInstance });
    assert.equal(JSON.stringify(await manager.status(id)).includes("fixture-secret"), false);
    const output = await readFile(join(started.worker.cwd!, "output.txt"), "utf8");
    assert.match(output, /Check your work/);
    assert.match(output, /Write an output file/);
    const beforePrompt = manager.send({ id, message: "NEVER WRITE THIS", effort: "high", requestId: randomUUID() });
    for (let i = 0; i < 100 && (await manager.status(id)).turn?.phase !== "queued"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await manager.status(id)).turn?.phase, "queued");
    await manager.cancel(id);
    await beforePrompt;
    assert.equal((await manager.status(id)).turn?.phase, "cancelled");
    assert.equal(await readFile(join(started.worker.cwd!, "output.txt"), "utf8"), output);
    const followed = { id, message: "ASK to write approval", requestId: randomUUID() };
    const sent = await manager.send(followed);
    assert.equal((await manager.send(followed)).turn.id, sent.turn.id);
    await assert.rejects(manager.send({ ...followed, message: "Different follow-up" }), /requestId was reused/);
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "awaiting_input"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = (await manager.status(id)).pending;
    assert.equal(pending.length, 1);
    assert.ok(scopedChanges.filter((value) => value === id).length >= 2);
    await manager.respond(id, pending[0]!.id, "allow-once");
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(await readFile(join(started.worker.cwd!, "approved.txt"), "utf8"), /allow-once/);
    assert.ok((await manager.read(id, 0, 50)).entries.some((item) => item.kind === "agent"));
    assert.equal((await manager.start(start)).turn.id, started.turn.id);

    await manager.send({ id, message: "ASK then cancel", requestId: randomUUID() });
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "awaiting_input"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.status(id)).pending.length, 1);
    await manager.cancel(id);
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.status(id)).turn?.phase, "cancelled");
    assert.deepEqual((await manager.status(id)).pending, []);

    const interrupted = await manager.send({ id, message: "ASK while account stops", requestId: randomUUID() });
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "awaiting_input"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.drain(accountId);
    assert.equal((await manager.status(id)).worker.phase, "needs_recovery");
    assert.equal((await manager.status(id)).turn?.phase, "unknown");
    await supervisor.reconcile();
    await assert.rejects(manager.resume(id, false), /acknowledge the unknown turn/);
    assert.equal((await manager.resume(id, true)).phase, "idle");
    assert.equal(manager.ledger.turn(interrupted.turn.id)?.phase, "unknown");
    const replay = (await manager.records(id, 0, 50, undefined)).entries.filter((entry) => entry.source === "replay");
    assert.equal(replay.length, 2); assert.ok(replay.every((entry) => entry.turnId === null));
    assert.equal(JSON.stringify(replay).includes("PRIVATE REASONING"), false);
    assert.equal((await manager.turns(id, undefined, 50)).turns.find((turn) => turn.id === interrupted.turn.id)?.prompt, "ASK while account stops");
    await manager.send({ id, message: "Fix the interrupted work", requestId: randomUUID() });
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    await workerSocket.close(); workerSocket = undefined;
    await manager.close(); manager = undefined;

    const reopenedSupervisor = new WorkerSupervisor(root, env);
    manager = new WorkerManager(root, reopenedSupervisor, env);
    assert.equal((await manager.status(id)).worker.phase, "needs_recovery");
    await reopenedSupervisor.reconcile();
    assert.equal((await manager.resume(id, false)).phase, "idle");
    assert.equal((await manager.closeWorker(id)).phase, "closed");
    const removed = await manager.remove(id, true);
    assert.equal(removed.retainedBranch, started.worker.branch);
    await assert.rejects(stat(started.worker.cwd!), /ENOENT/);
  } finally {
    await workerSocket?.close();
    await manager?.close();
    await bots.close(); await owner.close(); await roles.close(); await auth.close();
    await rm(root, { recursive: true, force: true });
  }
});
