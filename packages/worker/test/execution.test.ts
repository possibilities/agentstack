import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuredMcpServers, workspaceRoot, operation, parseMcpBinding, serveApi, serveSocket, socketCall, socketPath, type StatePlan, type StateReceipt } from "@stack/api";
import { RoleStore, type RoleSnapshot } from "@stack/roles";
import { WorkerSupervisor } from "../src/supervisor.js";
import { WorkerManager } from "../src/manager.js";
import { claimWorktree, loadWorkerRole, removeWorktree } from "../src/worktree.js";
import { api as workersApi } from "../api.js";
import { writeV2Credential } from "./v2-credential-fixture.js";
import type { SettingsView } from "@stack/settings";

const role: RoleSnapshot = { id: randomUUID(), name: "Fixture", description: "", createdAt: null, updatedAt: null, disabledInternalMcpServers: [], revision: 7, categories: [{ id: randomUUID(), title: "Guidance", description: "", enabled: true, createdAt: null, updatedAt: null,
  fragments: [{ id: randomUUID(), categoryId: randomUUID(), title: "Brief", description: "", body: "Check your work.", enabled: true, createdAt: null, updatedAt: null }] }],
  skills: [{ id: randomUUID(), name: "review", description: "Review changes", body: "Review the diff.", files: [], enabled: true }],
  mcpServers: [{ id: randomUUID(), name: "fixture-mcp", description: "", enabled: true,
    definition: { type: "stdio", command: process.execPath, args: ["--version"], env: { TEST_SECRET: "fixture-secret" } } }], trustedProjects: [] };

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (error, stdout) =>
    error ? reject(error) : resolve(stdout.trim())));
}

test("Worker recovery rejects snapshots without an internal MCP selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-worker-legacy-role-"));
  const directory = join(root, "workers", "roles");
  try {
    await mkdir(directory, { recursive: true });
    const { disabledInternalMcpServers: _disabled, id: _id, name: _name, description: _description, createdAt: _created, updatedAt: _updated, ...legacy } = role;
    await writeFile(join(directory, "legacy.json"), JSON.stringify(legacy));
    await assert.rejects(loadWorkerRole(root, "legacy"), /invalid internal MCP selection/);
    assert.equal(await readFile(join(directory, "legacy.json"), "utf8"), JSON.stringify(legacy), "the saved launch remains immutable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
  const root = await mkdtemp(join(tmpdir(), "stack-worker-tree-"));
  try {
    const repo = await repoFixture(root);
    const id = randomUUID();
    const claimed = await claimWorktree(root, id, repo, undefined, role);
    assert.equal(claimed.roleRevision, 7);
    assert.equal(claimed.sourceDirty, false);
    assert.equal(await run(claimed.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    await assert.rejects(stat(join(claimed.cwd, ".devin", "skills", "prime")), /ENOENT/);
    assert.match(await readFile(join(claimed.cwd, ".opencode", "skills", "review", "SKILL.md"), "utf8"), /Review the diff/);
    assert.match(await readFile(join(claimed.cwd, ".devin", "skills", "review", "SKILL.md"), "utf8"), /Review the diff/);
    await assert.rejects(stat(join(repo, ".devin")), /ENOENT/);
    await removeWorktree(claimed, id);
    assert.equal(await run(repo, ["rev-parse", "--verify", claimed.branch]), claimed.baseCommit);
    const interruptedId = randomUUID();
    const orphan = join(root, "workers", "worktrees", interruptedId);
    await run(repo, ["worktree", "add", "-b", `stack-worker-${interruptedId}`, orphan, "HEAD"]);
    await removeWorktree({ repo, cwd: orphan, branch: `stack-worker-${interruptedId}` }, interruptedId);
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
const options = (model = 'openai/gpt-fixture') => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'openai/gpt-fixture', name: 'GPT fixture' }] },
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
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: false }, sessionCapabilities: { close: {} } },
      agentInfo: { version: 'fixture' } } });
    else if (frame.method === 'session/new') { cwd = frame.params.cwd;
      void writeFile(join(cwd, 'mcp-names.json'), JSON.stringify(frame.params.mcpServers.map((entry) => entry.name)));
      void writeFile(join(cwd, 'mcp-launches.json'), JSON.stringify(frame.params.mcpServers));
      const sessionId = 'session-' + Date.now();
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the work' }] } } });
      send({ id: frame.id, result: { sessionId, configOptions: options() } }); }
    else if (frame.method === 'session/load') { cwd = frame.params.cwd;
      send({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'user_message_chunk', messageId: 'replayed-user', content: { type: 'text', text: 'Old task replay' } } } });
      send({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'replayed-agent', content: { type: 'text', text: 'Old answer replay' } } } });
      send({ method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE REASONING' } } } });
      void writeFile(join(cwd, 'loaded-mcp-names.json'), JSON.stringify(frame.params.mcpServers.map((entry) => entry.name)))
        .then(() => send({ id: frame.id, result: { configOptions: options() } })); }
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

test("durable ACP workers dispatch, follow up, answer permissions, and load after server restart", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-worker-execution-"));
  const repo = await repoFixture(root);
  const binary = join(root, "acp-fixture");
  await writeFile(binary, acpFixture);
  await chmod(binary, 0o700);
  const env = { ...process.env, STACK_STATE_DIR: root, STACK_OPENCODE_BIN: binary };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const roleStore = new RoleStore(root);
  const roleId = roleStore.catalog().workerDefaultRoleId!;
  const contents = roleStore.role(roleId);
  let applied = contents.createCategory(0, "Guidance");
  applied = contents.createFragment(applied.revision, applied.categories[0]!.id, "Brief", "Check your work.");
  applied = contents.createSkill(applied.revision, "review", "Review changes", "Review the diff.");
  applied = contents.createMcpServer(applied.revision, "fixture-mcp", "", role.mcpServers[0]!.definition);
  applied = contents.setInternalMcp(applied.revision, "notify", false);
  const roles = await serveApi({ name: "roles", transport: "socket", env });
  const server = await serveSocket({ info: { name: "serve", description: "Server", transportDescription: "Socket", path: socketPath("serve", env) },
    context: {}, operations: [operation({ name: "serve_status", description: "Status", input: z.object({}), output: z.any(),
      async call() { return { mcpUrls: { roles: "http://127.0.0.1:8743/mcp/roles", notify: "http://127.0.0.1:8743/mcp/notify" } }; } })] });
  const bots = await serveSocket({ info: { name: "bots", description: "Bots", transportDescription: "Socket", path: socketPath("bots", env) },
    context: {}, operations: [operation({ name: "bot_list", description: "List", input: z.object({}), output: z.any(),
       async call() { return { bots: [] }; } })] });
  const hud = await serveApi({ name: "hud", transport: "socket", env });
  const hudCall = (name: string, args: object) => socketCall(socketPath("hud", env), "tools/call", { name, arguments: args });
  const workItemId = randomUUID();
  await hudCall("work_create", { requestId: randomUUID(), id: workItemId, title: "Fixture work", objective: "Keep admissions associated", state: "active" });
  let manager: WorkerManager | undefined;
  let workerSocket: Awaited<ReturnType<typeof serveSocket>> | undefined;
  const scopedChanges: string[] = [];
  try {
    const { AuthStore } = await import("@stack/auth");
    const store = new AuthStore(root);
    const botAccount = store.addAccount(JSON.stringify({ tokens: { refresh_token: "refresh", access_token: "access", id_token: "fixture.jwt.signature" } }));
    const pairedId = store.pairedWorker(botAccount.id)!;
    store.close();
    const prepared = await socketCall(socketPath("auth", env), "tools/call", {
      name: "worker_account_prepare", arguments: { provider: "codex", id: pairedId },
    }) as { account: { id: string } };
    const accountId = prepared.account.id;
    const accountPath = join(root, "worker-accounts", accountId, "data", "opencode");
    await mkdir(accountPath, { recursive: true });
    await writeV2Credential(join(accountPath, "opencode.db"), "openai", JSON.stringify({ type: "oauth", access: "fixture", refresh: "fixture" }));
    await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_confirm", arguments: { id: accountId } });
    const supervisor = new WorkerSupervisor(root, env);
    manager = new WorkerManager(root, supervisor, env);
    manager.onChange = (id) => { if (id) scopedChanges.push(id); };
    workerSocket = await serveSocket({ info: { name: "worker", description: "Workers", transportDescription: "Socket", path: socketPath("worker", env) },
      context: { supervisor, manager }, operations: workersApi.operations });
    await supervisor.reconcile();
    const catalog = await supervisor.catalog(accountId, true);
    assert.deepEqual(catalog.models[0]?.efforts, ["low", "high"]);
    const start = { accountId, model: "openai/gpt-fixture", effort: "low", repo, task: "Write an output file", requestId: randomUUID(), workItemId };
    const observationInput = { requestId: start.requestId, botId: "_local_operator", threadId: "_local_operator" };
    assert.deepEqual(await manager.observeTurn(observationInput), { result: null, update: null });
    await assert.rejects(manager.start({ ...start, subscribe: true }), /owner-coordinated/);
    assert.equal(manager.ledger.startByRequestId(start.requestId), null, "unsupported completion delivery must refuse before Worker reservation or worktree preparation");
    await assert.rejects(manager.start(start, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null }), /Bot-bound MCP/);
    await assert.rejects(manager.start(start, { transport: "mcp", botId: "foreign-bot", instance: "old", threadId: "other", sessionId: null }), /verified Bot thread|Bot launch/);
    assert.deepEqual(manager.ledger.workers(), []);
    const failed = await manager.start({ ...start, requestId: randomUUID(), repo: join(root, 'missing-repo'), task: 'Retain failed preparation prompt' });
    assert.equal(failed.turn.phase, "failed"); assert.equal(failed.turn.promptChars, "Retain failed preparation prompt".length);
    assert.equal((await manager.turns(failed.worker.id, undefined, 1)).turns[0]?.prompt, "Retain failed preparation prompt");
    assert.equal(failed.turn.dispatchedAt, null); assert.equal(failed.turn.requestedModel, start.model);
    const started = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_start", arguments: start }) as Awaited<ReturnType<WorkerManager["start"]>>;
    assert.equal(started.duplicate, false);
    assert.deepEqual(started.turn.workContext, { workItemId, scopeRevision: 1, source: "explicit" });
    assert.equal(started.worker.roleId, roleId);
    assert.equal(started.worker.roleRevision, applied.revision);
    await assert.rejects(manager.start({ ...start, task: "Different task" }), /requestId was reused/);
    await assert.rejects(manager.start({ ...start, roleId }), /requestId was reused/);
    const fromApi = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_status", arguments: { id: started.worker.id } }) as { worker: { id: string } };
    assert.equal(fromApi.worker.id, started.worker.id);
    assert.equal((await manager.start(start)).worker.id, started.worker.id);
    const id = started.worker.id;
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.status(id)).turn?.stopReason, "end_turn");
    assert.equal((await manager.observeTurn(observationInput)).result?.turnId, started.turn.id);
    assert.equal((await manager.observeTurn(observationInput)).result?.phase, "completed");
    await assert.rejects(manager.observeTurn({ ...observationInput, threadId: "another-chat" }), /originating Chat/);
    assert.equal(await readFile(join(started.worker.cwd!, "output.txt"), "utf8"), `Check your work.\n\n${start.task}`);
    const listed = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_list", arguments: {} }) as { workers: Awaited<ReturnType<WorkerManager["list"]>> };
    const row = listed.workers.find((worker) => worker.id === id)!;
    assert.equal(row.turn?.phase, "completed"); assert.equal(row.turn?.stopReason, "end_turn"); assert.equal(row.pendingPermissions, 0);
    const resources = await hudCall("work_resources", { id: workItemId }) as { workers: { entries: Array<{ workerId: string; turnPhase: string; context: { scopeRevision: number } }> }; observation: { state: string } };
    assert.equal(resources.observation.state, "available");
    assert.equal(resources.workers.entries.find(entry => entry.workerId === id)?.turnPhase, "completed");
    assert.equal((await hudCall("work_get", { id: workItemId }) as { state: string }).state, "active", "native completion cannot complete semantic work");
    await hudCall("work_update", { requestId: randomUUID(), id: workItemId, expectedRevision: 1, patch: { objective: "Revised work" } });
    assert.equal((await manager.start(start)).turn.workContext?.scopeRevision, 1, "admission retry retains its original scope");
    await assert.rejects(manager.start({ ...start, workItemId: null }), /requestId was reused/);
    assert.equal("prompt" in (row.turn ?? {}), false, "list turns stay compact");
    const changes = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_diff", arguments: { id } }) as Awaited<ReturnType<WorkerManager["diff"]>>;
    assert.equal(changes.baseCommit, started.worker.baseCommit); assert.equal(changes.uncommitted, true);
    assert.deepEqual(changes.files.find((file) => file.path === "output.txt")?.status, "untracked");
    assert.ok(changes.files.every((file) => file.status === "untracked"), "the fixture runtime only adds files");
    const written = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_diff", arguments: { id, path: "output.txt" } }) as { patch: string };
    assert.match(written.patch, /^\+.*Write an output file/m);
    const detail = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_detail", arguments: { id } }) as Awaited<ReturnType<WorkerManager["detail"]>>;
    assert.equal(detail.observedSettings?.model, "openai/gpt-fixture");
    assert.equal(detail.observedSettings?.effort, "low");
    const settingsCall = <T>(name: string, args: Record<string, unknown>) => socketCall(socketPath("worker", env), "tools/call", { name, arguments: args }) as Promise<T>;
    const settingsBefore = await settingsCall<SettingsView>("worker_settings_read", { id });
    const settingsPatch = { target: { id }, patch: { expectedRevision: settingsBefore.saved.revision, requestId: randomUUID(), set: { effort: "high" } } };
    await settingsCall("worker_settings_preview", settingsPatch);
    assert.equal((await settingsCall<SettingsView>("worker_settings_read", { id })).saved.revision, settingsBefore.saved.revision);
    const savedSettings = await settingsCall<{ revision: number }>("worker_settings_patch", settingsPatch);
    assert.equal((await manager.detail(id)).observedSettings?.effort, "low", "saving does not select a native option");
    await assert.rejects(settingsCall("worker_settings_apply", { id, expectedRevision: savedSettings.revision, expectedInstance: randomUUID() }), /exact idle/);
    const turnCount = manager.ledger.turns(id).length;
    const applying = settingsCall("worker_settings_apply", { id, expectedRevision: savedSettings.revision, expectedInstance: started.worker.runtimeInstance });
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "preparing"; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal((await manager.status(id)).worker.phase, "preparing");
    await assert.rejects(manager.send({ id, message: "must not race selection", requestId: randomUUID() }), /not idle/);
    await settingsCall("worker_settings_patch", { target: { id }, patch: { expectedRevision: savedSettings.revision, requestId: randomUUID(), set: { effort: "low" } } });
    await applying;
    const settingsAfter = await settingsCall<SettingsView>("worker_settings_read", { id });
    assert.equal(settingsAfter.saved.values.effort, "low");
    assert.equal(settingsAfter.loaded?.values.effort, "high");
    assert.equal(settingsAfter.fields.find((field) => field.key === "effort")?.effective.value, "high");
    assert.equal(settingsAfter.fields.find((field) => field.key === "effort")?.pending, true);
    assert.equal(manager.ledger.turns(id).length, turnCount, "application sends no prompt");
    assert.ok(detail.metadata.some((entry) => entry.kind === "available_commands_update"));
    assert.ok(detail.metadata.some((entry) => entry.kind === "runtime"));
    assert.equal(detail.subagents.hierarchyAvailable, false);
    const toolPage = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_tool_list", arguments: { id } }) as Awaited<ReturnType<WorkerManager["tools"]>>;
    assert.equal(toolPage.tools[0]?.title, "Write"); assert.equal(toolPage.tools[0]?.status, "completed");
    const history = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_record_list", arguments: { id } }) as Awaited<ReturnType<WorkerManager["records"]>>;
    assert.ok(history.entries.some((entry) => entry.kind === "tool_call_update"));
    assert.equal(JSON.stringify(history).includes("fixture-secret"), false);
    assert.equal(JSON.stringify(history).includes("proof="), false);
    const turnHistory = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_turn_list", arguments: { id } }) as Awaited<ReturnType<WorkerManager["turns"]>>;
    assert.equal(turnHistory.turns[0]?.prompt, start.task);
    assert.ok(turnHistory.turns[0]?.dispatchedPromptSeq);
    const chunk = await socketCall(socketPath("worker", env), "tools/call", { name: "worker_record_read", arguments: { id, seq: turnHistory.turns[0]!.dispatchedPromptSeq! } }) as { data: string };
    assert.match(chunk.data, /Write an output file/);
    assert.equal(chunk.data.includes("Check your work"), true);
    assert.ok(scopedChanges.includes(id));
    const fleet = (await configuredMcpServers(workspaceRoot(import.meta.dirname))).map(item => item.name);
    assert.deepEqual(JSON.parse(await readFile(join(started.worker.cwd!, "mcp-names.json"), "utf8")), [...fleet.filter(name => name !== "notify"), "fixture-mcp"]);
    const wiring = JSON.parse(await readFile(join(started.worker.cwd!, "mcp-launches.json"), "utf8")) as Array<{ name: string; command: string; env: Array<{ name: string; value: string }> }>;
    const internal = wiring.find(item => item.name === "roles")!;
    assert.equal(internal.command, process.execPath);
    assert.deepEqual(parseMcpBinding(internal.env.find(item => item.name === "STACK_MCP_BINDING")!.value, env), { workerId: id, instance: started.worker.runtimeInstance });
    assert.equal(JSON.stringify(await manager.status(id)).includes("fixture-secret"), false);
    const output = await readFile(join(started.worker.cwd!, "output.txt"), "utf8");
    assert.equal(output, `Check your work.\n\n${start.task}`);
    const beforePrompt = manager.send({ id, message: "NEVER WRITE THIS", effort: "high", requestId: randomUUID() });
    for (let i = 0; i < 100 && (await manager.status(id)).turn?.phase !== "queued"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await manager.status(id)).turn?.phase, "queued");
    await manager.cancel(id);
    await beforePrompt;
    assert.equal((await manager.status(id)).turn?.phase, "cancelled");
    assert.equal(await readFile(join(started.worker.cwd!, "output.txt"), "utf8"), output);
    const followed = { id, message: "ASK to write approval", requestId: randomUUID() };
    await assert.rejects(manager.send({ ...followed, subscribe: true }), /owner-coordinated/);
    assert.equal(manager.ledger.turnByRequestId(followed.requestId), null, "unsupported follow-up watch must not reserve a turn");
    const sent = await manager.send(followed);
    assert.deepEqual(sent.turn.workContext, { workItemId, scopeRevision: 2, source: "continuation" });
    assert.equal((await manager.send(followed)).turn.id, sent.turn.id);
    await assert.rejects(manager.send({ ...followed, message: "Different follow-up" }), /requestId was reused/);
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "awaiting_input"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = (await manager.status(id)).pending;
    assert.equal(pending.length, 1);
    const waiting = await manager.observeTurn({ ...observationInput, requestId: followed.requestId });
    assert.equal(waiting.result, null); assert.equal(waiting.update?.phase, "awaiting_input");
    assert.deepEqual(waiting.update?.pending, [{ permissionId: pending[0]!.id, optionCount: 2 }]);
    const permissionLedger = manager.ledger;
    const morePermissions = Array.from({ length: 8 }, (_, n) => permissionLedger.addPermission(id, sent.turn.id, 100 + n, "PRIVATE permission title", pending[0]!.options, started.worker.runtimeInstance));
    const bounded = await manager.observeTurn({ ...observationInput, requestId: followed.requestId });
    assert.equal(bounded.update?.pending.length, 8); assert.equal(bounded.update?.pendingCount, 9); assert.equal(bounded.update?.pendingTruncated, true);
    assert.equal(JSON.stringify(bounded).includes("PRIVATE"), false, "attention summaries contain only permission identity/count, not authored titles/options");
    for (const permission of morePermissions) manager.ledger.resolvePermission(permission.id);
    assert.equal((await manager.observeTurn(observationInput)).result?.turnId, started.turn.id, "a later awaiting-input turn must not change an earlier request's completion");
    assert.ok(scopedChanges.filter((value) => value === id).length >= 2);
    await manager.respond(id, pending[0]!.id, "allow-once");
    for (let i = 0; i < 100 && (await manager.status(id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(await readFile(join(started.worker.cwd!, "approved.txt"), "utf8"), /allow-once/);
    assert.ok((await manager.read(id, 0, 50)).entries.some((item) => item.kind === "agent"));
    const followCompletion = await manager.observeTurn({ ...observationInput, requestId: followed.requestId });
    assert.equal(followCompletion.result?.turnId, sent.turn.id); assert.equal(followCompletion.update, null);
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
    assert.ok((await supervisor.stateDependencies(accountId)).blockedBy.length);
    const cacheDirectory = join(root, "worker-accounts", accountId, "cache", "opencode");
    await mkdir(cacheDirectory, { recursive: true }); await writeFile(join(cacheDirectory, "models.json"), "fixture model cache");
    const credentialBytes = await readFile(join(accountPath, "opencode.db"));
    await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_set_enabled", arguments: { id: accountId, enabled: false } });
    assert.deepEqual((await supervisor.stateDependencies(accountId)).blockedBy, []);
    const cachePlan = await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_cache_plan", arguments: { accountId } }) as StatePlan;
    assert.deepEqual(cachePlan.blockedBy, []);
    const cacheReceipt = await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_cache_clear", arguments: { planId: cachePlan.id, expectedRevision: cachePlan.revision, requestId: randomUUID() } }) as StateReceipt;
    assert.equal(cacheReceipt.status, "completed");
    assert.deepEqual(await readFile(join(accountPath, "opencode.db")), credentialBytes, "native credentials/session database untouched by cache cleanup");
    await assert.rejects(stat(join(cacheDirectory, "models.json")), { code: "ENOENT" });
    assert.equal((await manager.status(id)).worker.phase, "needs_recovery");
    assert.equal((await manager.status(id)).turn?.phase, "unknown");
    await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_set_enabled", arguments: { id: accountId, enabled: true } });
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

    // Recovery must retain the captured Role and its MCP selection, even after default/content edits.
    contents.setInternalMcp(applied.revision, "roles", false);
    const roleCatalog = roleStore.createRole(roleStore.catalog().revision, "Next worker");
    const nextRoleId = roleCatalog.roles.at(-1)!.id;
    roleStore.setWorkerDefault(roleCatalog.revision, nextRoleId);

    const reopenedSupervisor = new WorkerSupervisor(root, env);
    manager = new WorkerManager(root, reopenedSupervisor, env);
    assert.equal((await manager.start(start)).worker.id, id, "a retry keeps its original Worker after the default changes");
    assert.equal((await manager.turnContext(id, started.turn.id)).workContext?.scopeRevision, 1, "restart preserves prior work evidence");
    assert.equal((await manager.status(id)).worker.phase, "needs_recovery");
    await reopenedSupervisor.reconcile();
    assert.equal((await manager.resume(id, false)).phase, "idle");
    assert.equal((await manager.status(id)).worker.roleId, roleId);
    assert.deepEqual(JSON.parse(await readFile(join(started.worker.cwd!, "loaded-mcp-names.json"), "utf8")), [...fleet.filter(name => name !== "notify"), "fixture-mcp"]);
    assert.equal((await manager.closeWorker(id)).phase, "closed");
    const removed = await manager.remove(id, true);
    assert.equal(removed.retainedBranch, started.worker.branch);
    await assert.rejects(stat(started.worker.cwd!), /ENOENT/);
    manager.ledger.settings.patch("worker-defaults:codex", "opencode-codex", { expectedRevision: 0, requestId: randomUUID(), set: { model: start.model, effort: "high" } });
    const withDefaults = { ...start, model: undefined, effort: undefined, requestId: randomUUID() };
    const next = await manager.start(withDefaults);
    assert.equal(next.worker.effort, "high");
    manager.ledger.settings.patch("worker-defaults:codex", "opencode-codex", { expectedRevision: 1, requestId: randomUUID(), set: { effort: "low" } });
    assert.equal((await manager.start(withDefaults)).worker.id, next.worker.id, "retry uses the original admitted defaults");
    for (let i = 0; i < 100 && (await manager.status(next.worker.id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(next.worker.roleId, nextRoleId);
    assert.equal(next.worker.roleRevision, 0);
    assert.deepEqual(JSON.parse(await readFile(join(next.worker.cwd!, "mcp-names.json"), "utf8")), fleet);
    await manager.closeWorker(next.worker.id);
    await manager.remove(next.worker.id, true);
    const chosen = await manager.start({ ...start, roleId, requestId: randomUUID() });
    for (let i = 0; i < 100 && (await manager.status(chosen.worker.id)).worker.phase !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(chosen.worker.roleId, roleId);
    assert.equal(chosen.worker.roleRevision, roleStore.role(roleId).snapshot().revision);
    assert.deepEqual(JSON.parse(await readFile(join(chosen.worker.cwd!, "mcp-names.json"), "utf8")), [...fleet.filter(name => !["roles", "notify"].includes(name)), "fixture-mcp"]);
    assert.match(await readFile(join(chosen.worker.cwd!, ".opencode", "skills", "review", "SKILL.md"), "utf8"), /Review the diff/);
    assert.equal(await readFile(join(chosen.worker.cwd!, "output.txt"), "utf8"), `Check your work.\n\n${start.task}`);
    await manager.closeWorker(chosen.worker.id);
    await manager.remove(chosen.worker.id, true);
    roleStore.role(nextRoleId).createMcpServer(0, "external-http", "Requires native HTTP support", { type: "http", url: "https://fixture.invalid/mcp" });
    const unsupported = await manager.start({ ...start, requestId: randomUUID() });
    assert.equal(unsupported.worker.phase, "failed", "additional HTTP Role servers still need the runtime's HTTP capability");
    await assert.rejects(stat(join(unsupported.worker.cwd!, "output.txt")), { code: "ENOENT" });
    await hudCall("work_update", { requestId: randomUUID(), id: workItemId, expectedRevision: 2, patch: { state: "completed" } });
    const beforeClosedAdmission = manager.ledger.workers().length;
    await assert.rejects(manager.start({ ...start, requestId: randomUUID() }), /work_closed/);
    assert.equal(manager.ledger.workers().length, beforeClosedAdmission, "closed work is refused before Worker admission or native dispatch");
  } finally {
    await workerSocket?.close();
    await manager?.close();
    await hud.close(); await bots.close(); await server.close(); await roles.close(); await auth.close();
    roleStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
