import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { Options, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { operation, parseWorkerMcpIdentity, serveSocket, socketPath } from "@agentstack/api";
import { type RoleSnapshot } from "@agentstack/roles";
import { ClaudeBackend, type ClaudeQuery, type ClaudeQueryFactory } from "../src/claude.js";
import { WorkerManager } from "../src/manager.js";
import { WorkerSupervisor } from "../src/supervisor.js";

const models = [{ value: "fixture-sonnet", displayName: "Fixture Sonnet", description: "Fixture", supportsEffort: true,
  supportedEffortLevels: ["low", "high"] as ("low" | "high")[] },
{ value: "fixture-haiku", displayName: "Fixture Haiku", description: "Fixture", supportsEffort: false }];

class Output implements AsyncIterable<SDKMessage> {
  private queue: SDKMessage[] = [];
  private wake?: () => void;
  ended = false;
  emit(value: object) { this.queue.push(value as SDKMessage); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      const value = this.queue.shift();
      if (value) yield value;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

/** Native-shaped SDK boundary fixture, with a separate input/output stream for every query. */
function sdkFixture() {
  const calls: Array<{ options: Options; id: string; output: Output; inputs: SDKUserMessage[]; permissions: PermissionResult[]; closed: boolean }> = [];
  const persisted = new Set<string>();
  const factory: ClaudeQueryFactory = ({ options, prompt }) => {
    const id = options.resume ?? options.sessionId!;
    const output = new Output();
    const call = { options, id, output, inputs: [] as SDKUserMessage[], permissions: [] as PermissionResult[], closed: false };
    calls.push(call);
    let model = models[0]!.value;
    let effort: string | null = null;
    let current: SDKUserMessage | undefined;
    const result = (subtype = "success", isError = false) => output.emit({ type: "result", subtype, is_error: isError, session_id: id,
      uuid: randomUUID(), user_message_uuid: current?.uuid, stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 },
      modelUsage: {}, total_cost_usd: 0, errors: ["MUST NOT EXPOSE https://secret.invalid?token=credential"], result: "Done" });
    const api: ClaudeQuery = {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      async initializationResult() {
        if (options.resume && !persisted.has(id)) throw new Error("missing native session");
        return { commands: [], agents: [], output_style: "default", available_output_styles: [], models, account: {}, plugins_applied: true };
      },
      async supportedModels() { return models; },
      async setModel(value) { model = value!; },
      async applyFlagSettings(settings) { effort = settings.effortLevel as string | null; },
      async interrupt() { result(); return { still_queued: [] }; },
      close() { call.closed = true; output.close(); },
    };
    void (async () => {
      for await (const input of prompt) {
        call.inputs.push(input); current = input; persisted.add(id);
        const text = String(input.message.content);
        if (text === "LOSS") { output.close(); continue; }
        output.emit({ type: "system", subtype: "init", uuid: randomUUID(), session_id: id, model, effort,
          claude_code_version: "fixture", tools: ["Write"], mcp_servers: [], skills: [] });
        if (text === "HANG") continue;
        if (text.startsWith("ASK")) {
          const answer = await options.canUseTool!("Write", { path: "fixture.txt", content: text },
            { signal: new AbortController().signal, toolUseID: `tool-${input.uuid}`, requestId: `permission-${input.uuid}` });
          assert.ok(answer);
          call.permissions.push(answer);
        }
        const tool = `tool-${input.uuid}`;
        const messageId = `message-${input.uuid}`;
        output.emit({ type: "assistant", uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
          message: { content: [{ type: "thinking", thinking: "PRIVATE REASONING" }, { type: "tool_use", id: tool, name: "Write", input: { path: "fixture.txt" } }] } });
        output.emit({ type: "user", uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: tool, content: "written" }] } });
        output.emit({ type: "stream_event", uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
          event: { type: "message_start", message: { id: messageId } } });
        const internal = options.mcpServers?.roles;
        const textOutput = text === "SECRETS" && internal && "url" in internal
          ? `Do not retain ${internal.url} or fixture-bearer-token` : "Done.\n";
        for (let i = 0; i < textOutput.length; i += 7) output.emit({ type: "stream_event", uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: textOutput.slice(i, i + 7) } } });
        output.emit({ type: "assistant", uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
          message: { id: messageId, content: [{ type: "text", text: textOutput }] } });
        result(text === "ERROR" ? "error_during_execution" : "success", text === "API_ERROR");
      }
    })();
    return api;
  };
  return { factory, calls };
}

const role: RoleSnapshot = { revision: 3, categories: [{ id: randomUUID(), title: "Role", description: "", enabled: true,
  fragments: [{ id: randomUUID(), categoryId: randomUUID(), title: "Instruction", description: "", body: "Check your work.", enabled: true }] }],
skills: [{ id: randomUUID(), name: "fixture", description: "Fixture skill", body: "Review carefully", enabled: true, files: [] }],
mcpServers: [{ id: randomUUID(), name: "external", description: "", enabled: true,
  definition: { type: "http", url: "https://fixture.invalid/mcp", httpHeaders: { Authorization: "Bearer fixture-bearer-token" } } }], trustedProjects: [] };

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("git", ["-C", cwd, ...args], (error) => error ? reject(error) : resolve()));
}
async function wait(manager: WorkerManager, id: string, phase: string) {
  for (let i = 0; i < 200; i++) { const status = await manager.status(id); if (status.worker.phase === phase) return status;
    await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail(`Worker did not reach ${phase}: ${JSON.stringify(await manager.status(id))}`);
}

test("Claude SDK workers preserve account/session continuity, exact permission answers and durable unknown recovery", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "as-claude-fixture-"));
  const repo = join(root, "repo"); await mkdir(repo);
  await git(repo, ["init", "-b", "main"]); await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "file.txt"), "fixture"); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "fixture"]);
  const accounts = [randomUUID(), randomUUID()].map((id) => ({ id, provider: "claude" as const, ready: true, enabled: true, removing: false }));
  const env = { PATH: process.env.PATH, HOME: root, AGENTSTACK_STATE_DIR: root, ANTHROPIC_API_KEY: "ambient-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "ambient-token", CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" };
  const socket = async (name: string, operationName: string, value: unknown) => serveSocket({
    info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
    operations: [operation({ name: operationName, description: "Fixture", input: z.object({}), output: z.any(), async call() { return value; } })],
  });
  const auth = await socket("auth", "worker_account_list", { accounts });
  const roles = await socket("roles", "role_snapshot", role);
  const owner = await socket("owner", "owner_status", { mcpUrls: { roles: "http://127.0.0.1:12345/mcp/roles" } });
  const sdk = sdkFixture();
  let supervisor = new WorkerSupervisor(root, env, { claudeQuery: sdk.factory });
  let manager = new WorkerManager(root, supervisor, env);
  try {
    await supervisor.reconcile();
    const catalog = await supervisor.catalog(accounts[0]!.id, true);
    assert.equal(catalog.source, "claude-sdk-supported-models");
    assert.deepEqual(catalog.models.map(({ id, efforts }) => ({ id, efforts })), [{ id: "fixture-sonnet", efforts: ["low", "high"] }, { id: "fixture-haiku", efforts: [] }]);
    assert.equal(sdk.calls[0]!.closed, true); assert.equal(sdk.calls[0]!.inputs.length, 0);
    const startInput = (accountId: string) => ({ accountId, model: "fixture-sonnet", effort: "high", repo, task: "First", requestId: randomUUID() });
    const request = startInput(accounts[0]!.id);
    const first = await manager.start(request);
    const second = await manager.start(startInput(accounts[1]!.id));
    const id = first.worker.id;
    await wait(manager, id, "idle"); await wait(manager, second.worker.id, "idle");
    assert.notEqual(first.worker.sessionId, second.worker.sessionId);
    const native = sdk.calls.find((call) => call.id === first.worker.sessionId)!;
    const otherNative = sdk.calls.find((call) => call.id === second.worker.sessionId)!;
    assert.notEqual(native.options.env!.CLAUDE_CONFIG_DIR, otherNative.options.env!.CLAUDE_CONFIG_DIR);
    assert.equal(native.options.env!.ANTHROPIC_API_KEY, undefined); assert.equal(native.options.env!.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(native.options.env!.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, undefined);
    assert.deepEqual(native.options.settingSources, []); assert.equal(native.options.strictMcpConfig, true);
    assert.deepEqual(native.options.systemPrompt, { type: "preset", preset: "claude_code", append: "Check your work." });
    const plugin = native.options.plugins![0]!;
    assert.match(await readFile(join(plugin.path, "skills", "fixture", "SKILL.md"), "utf8"), /Review carefully/);
    const internal = native.options.mcpServers!.roles!;
    assert.ok("url" in internal);
    assert.deepEqual(parseWorkerMcpIdentity(new URL(internal.url), env), { workerId: id, instance: first.worker.runtimeInstance });
    assert.equal(native.inputs[0]!.message.content, "First");
    assert.equal((await manager.start(request)).duplicate, true); assert.equal(native.inputs.length, 1);
    const runtime = supervisor.runtimeList()[0]!;
    assert.equal(runtime.backend, "claude-sdk"); assert.equal(runtime.pid, null); assert.equal(runtime.processModel, "session");
    assert.equal((await manager.detail(id)).observedSettings?.model, "fixture-sonnet");
    assert.equal((await manager.detail(id)).observedSettings?.effort, "high");
    assert.equal((await manager.tools(id, 0, 20)).tools[0]?.status, "completed");
    assert.equal((await manager.read(id, 0, 50)).entries.filter((entry) => entry.kind === "agent").map((entry) => entry.text).join(""), "Done.\n");

    for (const option of ["allow-once", "deny-once"]) {
      const follow = { id, message: `ASK ${option}`, requestId: randomUUID() };
      const sent = await manager.send(follow); assert.equal((await manager.send(follow)).turn.id, sent.turn.id);
      const pending = (await wait(manager, id, "awaiting_input")).pending[0]!;
      await assert.rejects(manager.respond(second.worker.id, pending.id, option), /not pending/);
      await assert.rejects(manager.respond(id, pending.id, "allow-always"), /not offered/);
      await manager.respond(id, pending.id, option); await wait(manager, id, "idle");
      await assert.rejects(manager.respond(id, pending.id, option), /not pending/);
      assert.equal(native.permissions.at(-1)?.behavior, option === "allow-once" ? "allow" : "deny");
      assert.equal(native.permissions.at(-1)?.toolUseID, pending.toolCallId);
    }
    await manager.send({ id, message: "HANG", requestId: randomUUID() }); await wait(manager, id, "running");
    await manager.cancel(id); assert.equal((await wait(manager, id, "idle")).turn?.phase, "cancelled");
    await manager.send({ id, message: "ASK cancel permission", requestId: randomUUID() });
    const pending = (await wait(manager, id, "awaiting_input")).pending[0]!;
    await manager.respond(id, pending.id, null); assert.equal((await wait(manager, id, "idle")).turn?.phase, "cancelled");
    for (const message of ["ERROR", "API_ERROR"]) {
      await manager.send({ id, message, requestId: randomUUID() });
      assert.equal((await wait(manager, id, "idle")).turn?.phase, "failed");
    }
    await manager.send({ id, message: "Change model", model: "fixture-haiku", requestId: randomUUID() });
    assert.equal((await wait(manager, id, "idle")).worker.effort, null);
    const beforeLoss = native.inputs.length;
    await manager.send({ id, message: "LOSS", requestId: randomUUID() });
    const lost = await wait(manager, id, "needs_recovery"); assert.equal(lost.turn?.phase, "unknown");
    assert.equal((await manager.status(second.worker.id)).worker.phase, "idle");
    await supervisor.reconcile();
    await assert.rejects(manager.resume(id, false), /acknowledge/);
    const resumed = await manager.resume(id, true);
    assert.equal(resumed.sessionId, first.worker.sessionId); assert.notEqual(resumed.runtimeInstance, first.worker.runtimeInstance);
    const resumedNative = sdk.calls.at(-1)!;
    assert.equal(resumedNative.options.resume, first.worker.sessionId);
    assert.equal(resumedNative.options.sessionId, undefined); assert.equal(resumedNative.inputs.length, 0);
    assert.equal(native.inputs.length, beforeLoss + 1); assert.equal(manager.ledger.turn(lost.turn!.id)?.phase, "unknown");
    await manager.send({ id, message: "Explicit correction", requestId: randomUUID() }); await wait(manager, id, "idle");
    assert.equal(resumedNative.inputs.length, 1);
    await manager.send({ id, message: "SECRETS", requestId: randomUUID() }); await wait(manager, id, "idle");
    const history = JSON.stringify(await manager.records(id, 0, 50, undefined));
    assert.equal(history.includes("proof="), false); assert.equal(history.includes("ambient-secret"), false);
    assert.equal(history.includes("PRIVATE REASONING"), false); assert.equal(history.includes("MUST NOT EXPOSE"), false);
    const lastTurn = (await manager.status(id)).turn!;
    const secretRecords = JSON.stringify(await manager.records(id, 0, 50, lastTurn.id));
    const transcript = JSON.stringify(await manager.read(id, 0, 50));
    for (const value of [secretRecords, transcript]) {
      assert.equal(value.includes("fixture-bearer-token"), false); assert.equal(value.includes("proof="), false);
    }

    await manager.close();
    supervisor = new WorkerSupervisor(root, env, { claudeQuery: sdk.factory }); manager = new WorkerManager(root, supervisor, env);
    assert.equal((await manager.status(id)).worker.phase, "needs_recovery");
    await supervisor.reconcile(); await manager.resume(id, false);
    assert.equal(sdk.calls.at(-1)!.inputs.length, 0);
    await manager.closeWorker(id); assert.equal(sdk.calls.at(-1)!.closed, true);
    assert.equal((await manager.status(id)).worker.phase, "closed");
  } finally { await manager.close(); await owner.close(); await roles.close(); await auth.close(); await rm(root, { recursive: true, force: true }); }
});

test("native Claude SDK no-turn catalog in a credential-free disposable profile", {
  skip: process.env.AGENTSTACK_NATIVE_CLAUDE_PROBE !== "1", timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "as-claude-no-turn-"));
  const config = join(root, "config"); await mkdir(config);
  const backend = new ClaudeBackend({ PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: config,
    USER: `as-probe-${randomUUID()}`, LOGNAME: "as-probe", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  try {
    const result = await backend.request("session/new", { cwd: root, mcpServers: [] }, 20_000) as { sessionId: string; configOptions: unknown[] };
    assert.match(result.sessionId, /^[a-f0-9-]{36}$/); assert.ok(result.configOptions.length); assert.equal(backend.pids.length, 1);
    await backend.request("session/close", { sessionId: result.sessionId }); assert.deepEqual(backend.pids, []);
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
});
