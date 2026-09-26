import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkerLedger } from "../src/ledger.js";
import { WorkerManager } from "../src/manager.js";
import { WorkerSupervisor, type Runtime } from "../src/supervisor.js";
import type { AcpProcess } from "../src/acp.js";
import { LOCAL_OPERATOR_ID, ownsWorker } from "../src/owner.js";
import { api, workerCancel, workerRead, workerSend, workerStart, workerStatus, workerTurnList } from "../api.js";

const intent = (accountId = randomUUID()) => ({ requestId: randomUUID(), botId: "fixture-bot", threadId: "root",
  accountId, provider: "grok" as const, model: "xai/grok-build", effort: "high", repo: "/fixture/repo", baseRef: "main", task: "Review the actual task" });
const config = (model = "xai/grok-observed", effort = "low") => ({ configOptions: [
  { id: "model", name: "Model", type: "select", category: "model", currentValue: model, options: [{ value: model, name: model }] },
  { id: "effort", name: "Effort", type: "select", category: "thought_level", currentValue: effort, options: [{ value: effort, name: effort }] },
] });

function managerFixture(root: string, request = intent()) {
  const runtime: Runtime = { account: { id: request.accountId, provider: "grok", enabled: true, ready: true, removing: false },
    process: { notify() {}, cancelPermissions() {} } as unknown as AcpProcess,
    instance: randomUUID(), version: "fixture", probeSession: null, canLoad: true, canClose: true, supportsHttp: true,
    capabilities: { loadSession: true }, agentInfo: { name: "fixture" } };
  const seed = new WorkerLedger(root);
  const { worker, turn } = seed.reserve(request);
  seed.setSession(worker.id, "fixture-session"); seed.setRuntimeInstance(worker.id, runtime.instance); seed.close();
  const supervisor = new WorkerSupervisor(root, { AGENTSTACK_STATE_DIR: root });
  const manager = new WorkerManager(root, supervisor, { AGENTSTACK_STATE_DIR: root });
  supervisor.runtime = () => runtime;
  supervisor.onRuntimeReady!(runtime);
  return { manager, supervisor, worker, turn, notify: (update: Record<string, unknown>) =>
    runtime.process.onNotification!("session/update", { sessionId: "fixture-session", update }) };
}

test("exhausted structured retention still captures a new turn's text and attributes known late tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-worker-retention-regression-"));
  const ctx = managerFixture(root);
  const { manager, worker, turn, notify } = ctx;
  try {
    manager.ledger.setWorkerPhase(worker.id, "running"); manager.ledger.setTurnPhase(turn.id, "running");
    notify({ sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Old tool", status: "pending" });
    manager.ledger.history.update(worker.id, null, "live", { sessionUpdate: "tool_call", toolCallId: "unattributed-tool", title: "Unattributed" });
    const history = manager.ledger.history;
    for (let i = 0; i < 33; i++) history.append(worker.id, turn.id, "agent_message_chunk", "live", { text: "x".repeat(950_000) });
    const capacity = history.capture(worker.id);
    history.append(worker.id, turn.id, "agent_message_chunk", "live",
      { text: "x".repeat(capacity.maxChars - capacity.retainedChars - JSON.stringify({ text: "" }).length) });
    assert.equal(history.capture(worker.id).retainedChars, capacity.maxChars);

    manager.ledger.completeTurn(turn.id, "completed", "end_turn", null);
    const next = manager.ledger.reserveTurn(worker.id, randomUUID(), "Continue after the structured limit", worker.model, worker.effort).turn;
    manager.ledger.setTurnPhase(next.id, "running");
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The new turn still has text." } });
    notify({ sessionUpdate: "tool_call_update", toolCallId: "old-tool", status: "completed" });
    notify({ sessionUpdate: "tool_call_update", toolCallId: "unattributed-tool", status: "completed" });
    notify({ sessionUpdate: "tool_call", toolCallId: "new-tool", title: "New tool", status: "pending" });
    notify({ sessionUpdate: "plan", entries: [{ content: "New plan", status: "in_progress", priority: "high" }] });
    const dropped = history.capture(worker.id).droppedRecords;
    notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PRIVATE REASONING" } });
    assert.equal(history.capture(worker.id).droppedRecords, dropped);
    assert.ok(dropped >= 5); assert.equal(history.capture(worker.id).truncated, true);

    const transcript = workerRead.output.parse(await workerRead.call(ctx, { id: worker.id, limit: 50 }));
    assert.ok(transcript.entries.some((entry) => entry.turnId === next.id && entry.kind === "agent" && entry.text === "The new turn still has text."));
    assert.ok(transcript.entries.some((entry) => entry.turnId === turn.id && entry.text === "old-tool · completed"));
    assert.ok(transcript.entries.some((entry) => entry.turnId === next.id && entry.text === "New tool · pending"));
    assert.ok(transcript.entries.some((entry) => entry.turnId === next.id && entry.kind === "plan"));
    assert.equal(JSON.stringify(transcript).includes("unattributed-tool"), false);
    assert.equal(JSON.stringify(transcript).includes("PRIVATE REASONING"), false);
    assert.equal(history.capture(worker.id).records, capacity.records + 1);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("65k prompts remain in history while status and lifecycle summaries retain deliverable outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-worker-status-regression-"));
  const request = { ...intent(), botId: LOCAL_OPERATOR_ID, threadId: LOCAL_OPERATOR_ID, task: "p".repeat(65_536) };
  const ctx = managerFixture(root, request);
  const { manager, worker, turn } = ctx;
  try {
    manager.ledger.history.append(worker.id, turn.id, "config_option_update", "response", config());
    manager.ledger.dispatchTurn(turn.id, request.task);
    manager.ledger.completeTurn(turn.id, "completed", "end_turn", null);
    const status = workerStatus.output.parse(await workerStatus.call(ctx, { id: worker.id }));
    assert.ok(JSON.stringify(status).length < 16_000);
    assert.equal(status.turn?.phase, "completed"); assert.equal(status.turn?.stopReason, "end_turn");
    assert.equal(status.turn?.promptChars, 65_536); assert.equal(Object.hasOwn(status.turn!, "prompt"), false);
    assert.equal(status.turn?.requestedEffort, "high"); assert.equal(status.turn?.observedSettings?.effort, "low");
    const saved = workerTurnList.output.parse(await workerTurnList.call(ctx, { id: worker.id }));
    assert.equal(saved.turns[0]?.prompt, request.task);
    assert.deepEqual(manager.ledger.history.data(worker.id, status.turn!.dispatchedPromptSeq!).prompt, [{ type: "text", text: request.task }]);

    const started = workerStart.output.parse(await workerStart.call(ctx, { accountId: request.accountId, model: request.model,
      effort: request.effort, repo: request.repo, baseRef: request.baseRef, task: request.task, requestId: request.requestId }));
    assert.equal(started.duplicate, true); assert.equal(started.turn.promptChars, 65_536);
    assert.equal(Object.hasOwn(started.turn, "prompt"), false); assert.ok(JSON.stringify(started).length < 16_000);
    const followup = { id: worker.id, requestId: randomUUID(), message: "f".repeat(65_536) };
    const admitted = manager.ledger.reserveTurn(worker.id, followup.requestId, followup.message, worker.model, worker.effort).turn;
    manager.ledger.completeTurn(admitted.id, "completed", "end_turn", null);
    const sent = workerSend.output.parse(await workerSend.call(ctx, followup));
    assert.equal(sent.duplicate, true); assert.equal(sent.turn.promptChars, 65_536);
    assert.equal(Object.hasOwn(sent.turn, "prompt"), false); assert.ok(JSON.stringify(sent).length < 16_000);
    const cancelled = workerCancel.output.parse(await workerCancel.call(ctx, { id: worker.id }));
    assert.equal(cancelled.turn?.stopReason, "end_turn"); assert.equal(cancelled.turn?.promptChars, 65_536);
    assert.equal(Object.hasOwn(cancelled.turn!, "prompt"), false); assert.ok(JSON.stringify(cancelled).length < 16_000);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("admitted prompts and requested choices survive failed preparation, restart and legacy migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-worker-history-"));
  let ledger = new WorkerLedger(root);
  try {
    const request = intent();
    const { worker, turn } = ledger.reserve(request);
    assert.equal(turn.prompt, request.task);
    assert.equal(turn.requestedEffort, "high");
    assert.equal(turn.observedSettings, null);
    ledger.setTurnPhase(turn.id, "failed", null, "worktree preparation failed");
    ledger.setWorkerPhase(worker.id, "idle");
    const followup = ledger.reserveTurn(worker.id, randomUUID(), "Fix the failed preparation", "xai/grok-build", "high").turn;
    ledger.history.append(worker.id, followup.id, "config_option_update", "response", config());
    ledger.history.update(worker.id, null, "live", { sessionUpdate: "session_info_update", title: "Durable title" });
    ledger.dispatchTurn(followup.id, "Role instructions\nFix the failed preparation");
    assert.equal(ledger.turn(followup.id)?.observedSettings?.effort, "low");
    ledger.close(); ledger = new WorkerLedger(root);
    assert.equal(ledger.turn(turn.id)?.phase, "failed");
    assert.equal(ledger.turn(turn.id)?.prompt, request.task);
    assert.equal(ledger.turn(followup.id)?.phase, "unknown");
    assert.equal(ledger.turn(followup.id)?.prompt, "Fix the failed preparation");
    assert.equal(ledger.turn(followup.id)?.requestedEffort, "high");
    assert.equal(ledger.turn(followup.id)?.observedSettings?.effort, "low");
    const info = ledger.history.metadata(worker.id).find((entry) => entry.kind === "session_info_update");
    assert.equal((info?.data?.sessionInfo as Record<string, unknown>).title, "Durable title");
    const page = ledger.turnPage(worker.id, undefined, 1);
    assert.equal(page.nextId, turn.id); assert.equal(page.hasMore, true);
    assert.equal(ledger.turnPage(worker.id, page.nextId!, 1).turns[0]?.id, followup.id);
    assert.throws(() => ledger.turnPage(worker.id, randomUUID(), 1), /cursor/);
    ledger.close();
    const db = new DatabaseSync(join(root, "workers.sqlite"));
    for (const column of ["prompt", "requested_model", "requested_effort", "observed_settings_json", "dispatched_at", "dispatched_prompt_seq"])
      db.exec(`ALTER TABLE turns DROP COLUMN ${column}`);
    db.close(); ledger = new WorkerLedger(root);
    assert.equal(ledger.turn(turn.id)?.prompt, null);
    assert.equal(ledger.turn(turn.id)?.observedSettings, null);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("actual ACP partial tool updates preserve structured content, metadata and evidence-backed task references", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-worker-tools-"));
  const ledger = new WorkerLedger(root);
  try {
    const { worker, turn } = ledger.reserve(intent());
    ledger.setSession(worker.id, "ses-root");
    const history = ledger.history;
    const start = history.update(worker.id, turn.id, "live", { sessionUpdate: "tool_call", toolCallId: "call-task", title: "task",
      kind: "think", status: "pending", locations: [{ path: "/fixture" }], rawInput: { prompt: "Check the patch", subagent_type: "review", description: "Review patch" },
      _meta: { vendor: { observation: "retain" } } });
    history.update(worker.id, turn.id, "live", { sessionUpdate: "tool_call_update", toolCallId: "call-task", status: "in_progress" });
    // OpenCode completedToolUpdate omits title unless the underlying completed state has one.
    const completed = history.update(worker.id, turn.id, "live", { sessionUpdate: "tool_call_update", toolCallId: "call-task", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Review complete" } }, { type: "diff", path: "/fixture/a", oldText: "a", newText: "b" }],
      rawOutput: { output: "Review complete", metadata: { parentSessionId: "ses-root", sessionId: "ses-child", model: { providerID: "xai", modelID: "grok-build" } } } });
    const page = history.tools(worker.id, 0, 1);
    assert.equal(page.tools[0]?.title, "task"); assert.equal(page.tools[0]?.status, "completed");
    assert.equal(page.tools[0]?.firstSeq, start); assert.equal(page.tools[0]?.lastSeq, completed);
    assert.deepEqual((page.tools[0]?.record.data?.toolCall as Record<string, unknown>).locations, [{ path: "/fixture" }]);
    assert.equal(page.tasks[0]?.sessionId, "ses-child");
    assert.equal(page.tasks[0]?.childStatus, "unknown"); assert.equal(page.tasks[0]?.hierarchyVerified, false);
    assert.equal(page.tasks[0]?.model?.modelID, "grok-build");
    history.update(worker.id, turn.id, "live", { sessionUpdate: "tool_call", toolCallId: "call-read", title: "read", kind: "read",
      rawInput: { filePath: "/fixture" }, rawOutput: { metadata: { parentSessionId: "ses-root", sessionId: "not-a-child" } } });
    assert.equal(history.tools(worker.id, 0, 50).tasks.length, 1);
    history.update(worker.id, null, "live", { sessionUpdate: "session_info_update", title: "Session title", _meta: { custom: true } });
    const info = history.update(worker.id, null, "live", { sessionUpdate: "session_info_update", updatedAt: "2026-09-25T00:00:00Z" });
    assert.equal((history.data(worker.id, info!).sessionInfo as Record<string, unknown>).title, "Session title");
    const cleared = history.update(worker.id, null, "live", { sessionUpdate: "session_info_update", title: null });
    assert.equal((history.data(worker.id, cleared!).sessionInfo as Record<string, unknown>).title, null);
    const priorCount = history.capture(worker.id).records;
    history.update(worker.id, turn.id, "live", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PRIVATE THOUGHT" } });
    assert.equal(history.capture(worker.id).records, priorCount);
    const safe = history.append(worker.id, null, "runtime", "response", { reasoning: "PRIVATE THOUGHT", credentials: "SECRET",
      _meta: { preserved: true, url: "http://127.0.0.1:8743/mcp/workers?worker=id&runtime=id&proof=PRIVATE" } });
    const serialized = JSON.stringify(history.data(worker.id, safe!));
    assert.equal(serialized.includes("PRIVATE"), false); assert.equal(serialized.includes("SECRET"), false);
    assert.match(serialized, /preserved/);
    for (const content of [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      { type: "resource_link", uri: "file:///fixture/a", name: "a" },
      { type: "resource", resource: { uri: "file:///fixture/a", text: "Embedded context" } }]) {
      const seq = history.update(worker.id, turn.id, "live", { sessionUpdate: "agent_message_chunk", content });
      assert.deepEqual((history.data(worker.id, seq!).update as Record<string, unknown>).content, content);
    }
    const late = history.update(worker.id, null, "live", { sessionUpdate: "tool_call_update", toolCallId: "call-task", content: [], locations: [], rawOutput: null });
    assert.equal(history.get(worker.id, late!).turnId, turn.id);
    const clearedTool = history.tools(worker.id, 0, 1).tools[0]!.record.data!.toolCall as Record<string, unknown>;
    assert.deepEqual(clearedTool.content, []); assert.deepEqual(clearedTool.locations, []); assert.equal(clearedTool.rawOutput, null);
    assert.equal(history.tools(worker.id, 0, 1).tools[0]!.turnId, turn.id);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("structured pages and immutable chunk recovery stay bounded with explicit durable retention loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-worker-bounds-"));
  const ledger = new WorkerLedger(root);
  try {
    const { worker, turn } = ledger.reserve(intent());
    const other = ledger.reserve(intent()).worker;
    const data = { content: [{ type: "text", text: "😀\n\"".repeat(15_000) }], _meta: { preserved: true } };
    const seq = ledger.history.append(worker.id, turn.id, "agent_message_chunk", "live", data)!;
    assert.equal(ledger.history.get(worker.id, seq).data, null);
    let offset = 0; let recovered = "";
    for (;;) {
      const page = ledger.history.chunk(worker.id, seq, offset, 16_000);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 100_000);
      recovered += page.data; offset = page.nextOffset;
      if (!page.hasMore) break;
    }
    assert.deepEqual(JSON.parse(recovered), data);
    assert.throws(() => ledger.history.chunk(other.id, seq, 0, 100), /unknown worker record/);
    assert.throws(() => ledger.history.chunk(worker.id, seq, offset + 1, 100), /out of range/);
    for (let i = 0; i < 60; i++) ledger.history.append(worker.id, turn.id, "agent_message_chunk", "live", { text: "界".repeat(7_000) });
    const first = ledger.history.read(worker.id, seq, 50);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 210_000);
    assert.ok(first.entries.length < 50); assert.equal(first.hasMore, true);
    const next = ledger.history.read(worker.id, first.nextSeq, 50);
    assert.ok(next.entries[0]!.seq > first.nextSeq);
    const large = { content: { type: "text", text: "a".repeat(950_000) } };
    for (let i = 0; i < 35; i++) ledger.history.append(worker.id, null, "agent_message_chunk", "replay", large);
    const captured = ledger.history.capture(worker.id);
    assert.equal(captured.truncated, true); assert.ok(captured.droppedRecords > 0);
    assert.ok(captured.retainedChars <= captured.maxChars);
    assert.equal(ledger.history.get(worker.id, seq).dataChars, recovered.length);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("session metadata outside turns, runtime fencing, permission ownership and scoped progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-worker-events-"));
  const supervisor = new WorkerSupervisor(root, { AGENTSTACK_STATE_DIR: root });
  const manager = new WorkerManager(root, supervisor, { AGENTSTACK_STATE_DIR: root });
  const process = {} as AcpProcess;
  const accountId = randomUUID();
  const runtime: Runtime = { account: { id: accountId, provider: "grok", enabled: true, ready: true, removing: false },
    process, instance: randomUUID(), version: "fixture", probeSession: null, canLoad: true, canClose: true, supportsHttp: true,
    capabilities: { loadSession: true }, agentInfo: { name: "fixture" } };
  supervisor.runtime = () => runtime;
  supervisor.onRuntimeReady!(runtime);
  const notices: Array<{ topic: string; scope?: string }> = [];
  const stop = await api.events!.start!({ manager, supervisor }, (topic, scope) => notices.push({ topic, scope }));
  try {
    const { worker, turn } = manager.ledger.reserve(intent(accountId));
    manager.ledger.setRuntimeInstance(worker.id, runtime.instance);
    manager.ledger.setSession(worker.id, "fixture-session");
    // The manager learns persisted session IDs when constructed; use a new manager below to exercise that path.
    await stop?.(); await manager.close();
    const reopened = new WorkerManager(root, supervisor, { AGENTSTACK_STATE_DIR: root });
    supervisor.onRuntimeReady!(runtime);
    const end = await api.events!.start!({ manager: reopened, supervisor }, (topic, scope) => notices.push({ topic, scope }));
    try {
      // A rebound runtime is not a loaded session until session/load completes.
      reopened.ledger.setWorkerPhase(worker.id, "preparing");
      assert.equal((await reopened.detail(worker.id)).freshness.connected, false);
      reopened.ledger.setWorkerPhase(worker.id, "idle");
      assert.equal((await reopened.detail(worker.id)).freshness.connected, true);
      const notify = (update: Record<string, unknown>) => process.onNotification!("session/update", { sessionId: "fixture-session", update });
      notify({ sessionUpdate: "session_info_update", title: "Idle metadata", _meta: { vendorChild: { id: "claim-only" } } });
      const records = await reopened.records(worker.id, 0, 50, undefined);
      assert.equal(records.entries.at(-1)?.turnId, null);
      assert.equal(records.entries.at(-1)?.source, "live");
      assert.equal((await reopened.tools(worker.id, 0, 50)).tasks.length, 0);
      const foreign = reopened.ledger.reserve(intent()).worker;
      await assert.rejects(reopened.recordChunk(foreign.id, records.entries.at(-1)!.seq, 0, 20), /unknown worker record/);
      await assert.rejects(reopened.detail(worker.id, { transport: "mcp", botId: null, workerId: worker.id,
        instance: runtime.instance, threadId: null, sessionId: null }), /Bot-bound/);
      assert.throws(() => ownsWorker({ botId: "other-bot", threadId: "root" }, worker), /another Bot/);
      const before = reopened.ledger.history.capture(worker.id).records;
      reopened.ledger.setRuntimeInstance(worker.id, randomUUID());
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale process" } });
      assert.equal(reopened.ledger.history.capture(worker.id).records, before);
      reopened.ledger.setRuntimeInstance(worker.id, runtime.instance);
      reopened.ledger.setTurnPhase(turn.id, "running"); reopened.ledger.setWorkerPhase(worker.id, "running");
      assert.equal(process.onRequest!({ id: 27, method: "session/request_permission", params: { sessionId: "fixture-session",
        toolCall: { toolCallId: "call-permission", title: "Write", rawInput: { filePath: "/fixture" } },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } }), true);
      const pending = (await reopened.status(worker.id)).pending[0]!;
      assert.equal(pending.runtimeInstance, runtime.instance); assert.equal(pending.toolCallId, "call-permission");
      assert.ok(pending.recordSeq);
      reopened.ledger.setRuntimeInstance(worker.id, randomUUID());
      await assert.rejects(reopened.respond(worker.id, pending.id, "allow"), /exact runtime and turn/);
      const lifecycleCount = notices.filter((notice) => notice.topic === "worker_changed").length;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.equal(notices.filter((notice) => notice.topic === "worker_changed").length, lifecycleCount);
      assert.ok(notices.some((notice) => notice.topic === "worker_progress" && notice.scope === worker.id));
      assert.ok(notices.some((notice) => notice.topic === "workers_changed" && notice.scope === undefined));
      assert.equal((await reopened.detail(worker.id)).freshness.stale, true);
    } finally { await end?.(); await reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
