import { socketCall, socketPath, type InvocationContext } from "@stack/api";
import { renderInstructions } from "@stack/roles";
import { record, type AcpRequest } from "./acp.js";
import { currentOption, effortOption, modelOption, optionsOf } from "./catalog.js";
import { WorkerLedger, summarizeTurn, type WorkerRecord, type TurnSummary, type PendingRequest } from "./ledger.js";
import { LOCAL_OPERATOR_ID, ownsWorker, workerOwner, type WorkerOwner } from "./owner.js";
import { roleSnapshot, sessionMcpServers } from "./resources.js";
import { WorkerSupervisor, type Runtime } from "./supervisor.js";
import { claimWorktree, claudeRole, loadWorkerRole, removeWorkerRole, removeWorktree, saveWorkerRole } from "./worktree.js";
import { safeValue } from "./history.js";
import { readWorktreeDiff, type DiffOptions } from "./diff.js";
import { evidence, settingsState, type SettingsPatch, type SettingsBackend, type SettingsSnapshot } from "@stack/settings";
import { randomUUID } from "node:crypto";
import { resolveWorkContext } from "@stack/hud/client";

/** worker_list's compact most recent turn; worker_status and worker_turn_list carry the rest. */
export type ListedTurn = Pick<TurnSummary, "id" | "phase" | "stopReason" | "issue" | "dispatchedAt" | "createdAt" | "updatedAt" | "workContext">;

export type StartInput = { accountId: string; model?: string; effort?: string; repo: string; baseRef?: string; roleId?: string; task: string; requestId: string; workItemId?: string | null };
export type SendInput = { id: string; message: string; requestId: string; model?: string; effort?: string; workItemId?: string | null };

export class WorkerManager {
  readonly ledger: WorkerLedger;
  onChange?: (workerId?: string) => void;
  onProgress?: (workerId: string) => void;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly progressWorkers = new Set<string>();
  private closing = false;
  private readonly sessions = new Map<string, string>();
  private readonly loading = new Set<string>();
  private readonly creating = new Map<string, { count: number; chars: number; dropped: number;
    updates: Array<{ sessionId: string; update: Record<string, unknown>; meta: unknown }> }>();

  constructor(private readonly stateDir: string, readonly supervisor: WorkerSupervisor, private readonly env: NodeJS.ProcessEnv) {
    this.ledger = new WorkerLedger(stateDir);
    for (const worker of this.ledger.workers()) if (worker.sessionId)
      this.sessions.set(`${worker.accountId}:${worker.sessionId}`, worker.id);
    supervisor.onChange = () => this.onChange?.();
    supervisor.onRuntimeReady = (runtime) => this.attach(runtime);
    supervisor.onRuntimeExit = (accountId) => {
      this.ledger.interruptAccount(accountId);
      for (const worker of this.ledger.workers().filter((item) => item.accountId === accountId && item.phase === "needs_recovery"))
        this.onChange?.(worker.id);
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.progressTimer) clearTimeout(this.progressTimer);
    await this.supervisor.close();
    this.ledger.close();
  }

  private changed(progress = false, workerId?: string): void {
    if (!progress) { this.onChange?.(workerId); return; }
    if (workerId) this.progressWorkers.add(workerId);
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      this.onChange?.();
      for (const id of this.progressWorkers) this.onProgress?.(id);
      this.progressWorkers.clear();
    }, 1_000);
    this.progressTimer.unref();
  }

  private attach(runtime: Runtime): void {
    runtime.process.onNotification = (method, params) => this.onNotification(runtime, method, params);
    runtime.process.onRequest = (request) => this.onRequest(runtime, request);
  }

  private findSession(accountId: string, sessionId: string): WorkerRecord | undefined {
    const id = this.sessions.get(`${accountId}:${sessionId}`);
    const worker = id ? this.ledger.worker(id) : null;
    return worker?.phase !== "closed" ? worker ?? undefined : undefined;
  }

  private onNotification(runtime: Runtime, method: string, params: unknown): void {
    if (this.closing || this.supervisor.runtime(runtime.account.id) !== runtime) return;
    if (method !== "session/update" || !record(params) || typeof params.sessionId !== "string" || !record(params.update)) return;
    const worker = this.findSession(runtime.account.id, params.sessionId);
    if (!worker) {
      // OpenCode sends available_commands_update before session/new returns its ID. Bind only after that exact response.
      const creating = this.creating.get(runtime.instance);
      if (creating && params.update.sessionUpdate !== "agent_thought_chunk") {
        const chars = JSON.stringify(params).length;
        if (creating.updates.length < 128 && creating.chars + chars <= 512_000) {
          creating.updates.push({ sessionId: params.sessionId, update: params.update, meta: params._meta }); creating.chars += chars;
        } else creating.dropped++;
      }
      return;
    }
    if (worker.runtimeInstance !== runtime.instance) return;
    this.captureUpdate(worker, params.update, params._meta);
  }

  private captureUpdate(worker: WorkerRecord, update: Record<string, unknown>, meta?: unknown): void {
    update = safeValue(update) as Record<string, unknown>;
    const type = update.sessionUpdate;
    if (type === "agent_thought_chunk") return;
    const replay = this.loading.has(worker.id);
    const current = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null;
    const turn = !replay && ["running", "awaiting_input", "cancelling"].includes(worker.phase)
      && current && ["running", "awaiting_input", "cancelling"].includes(current.phase) ? current : null;
    const seq = this.ledger.history.update(worker.id, turn?.id ?? null, replay ? "replay" : "live", update, meta);
    if (seq !== null && turn && ["config_option_update", "current_mode_update"].includes(String(type)))
      this.ledger.observeTurn(turn.id, this.ledger.history.settings(worker.id));
    // The structured Worker budget is independent of each turn's legacy text budget.
    if (turn && type === "agent_message_chunk" && record(update.content) && update.content.type === "text" && typeof update.content.text === "string") {
      this.ledger.append(worker.id, turn.id, "agent", update.content.text);
    } else if (!replay && (type === "tool_call" || type === "tool_call_update")) {
      const knownTurnId = typeof update.toolCallId === "string" ? this.ledger.history.toolTurnId(worker.id, update.toolCallId) : undefined;
      const toolTurnId = knownTurnId === undefined ? turn?.id ?? null : knownTurnId;
      if (toolTurnId) this.ledger.append(worker.id, toolTurnId, "tool", `${typeof update.title === "string" ? update.title.slice(0, 1_000) : String(update.toolCallId ?? "Tool")}${typeof update.status === "string" ? ` · ${update.status}` : ""}`);
    } else if (turn && type === "plan" && Array.isArray(update.entries)) {
      this.ledger.append(worker.id, turn.id, "plan", JSON.stringify(update.entries).slice(0, 16_000));
    }
    if (seq !== null || this.ledger.history.capture(worker.id).truncated) this.changed(true, worker.id);
  }

  private onRequest(runtime: Runtime, request: AcpRequest): boolean {
    if (this.closing || this.supervisor.runtime(runtime.account.id) !== runtime) return false;
    if (request.method !== "session/request_permission" || !record(request.params) || typeof request.params.sessionId !== "string") return false;
    const worker = this.findSession(runtime.account.id, request.params.sessionId);
    if (!worker?.currentTurnId || worker.runtimeInstance !== runtime.instance || !["running", "awaiting_input"].includes(worker.phase)
      || !["running", "awaiting_input"].includes(this.ledger.turn(worker.currentTurnId)?.phase ?? "") || this.ledger.pending(worker.id).length >= 8) return false;
    const options = Array.isArray(request.params.options) ? request.params.options.flatMap((value: unknown) => {
      if (!record(value) || typeof value.optionId !== "string" || typeof value.name !== "string") return [];
      return [{ optionId: value.optionId, name: value.name, kind: typeof value.kind === "string" ? value.kind : "other" }];
    }) : [];
    if (!options.length || options.length > 32 || options.some((option) => option.optionId.length > 256 || option.name.length > 1_000)) return false;
    const toolCall = request.params.toolCall;
    const title = safeValue(record(toolCall) && typeof toolCall.title === "string" ? toolCall.title : "Worker requests permission") as string;
    const seq = this.ledger.history.append(worker.id, worker.currentTurnId, "session/request_permission", "live", request.params);
    this.ledger.addPermission(worker.id, worker.currentTurnId, request.id, title, options, runtime.instance,
      record(toolCall) && typeof toolCall.toolCallId === "string" && toolCall.toolCallId.length <= 512 ? toolCall.toolCallId : null, seq);
    this.changed(false, worker.id);
    return true;
  }

  private async owner(invocation?: InvocationContext): Promise<WorkerOwner> { return workerOwner(invocation, this.env); }
  private async owned(id: string, invocation?: InvocationContext): Promise<WorkerRecord> {
    const owner = await this.owner(invocation);
    const worker = this.ledger.worker(id);
    if (!worker) throw new Error("unknown worker");
    ownsWorker(owner, worker);
    return worker;
  }
  /** Worker self-reads do not grant Bot/operator ownership or mutation rights. */
  private async readable(id: string, invocation?: InvocationContext): Promise<WorkerRecord> {
    if (!invocation?.workerId) return this.owned(id, invocation);
    if (invocation.transport !== "mcp" || invocation.botId || invocation.instance || invocation.workerId !== id)
      throw new Error("Worker reads are limited to the calling Worker");
    const worker = this.ledger.worker(id);
    const runtime = worker && this.supervisor.runtime(worker.accountId);
    if (!worker || !runtime || !invocation.workerInstance || worker.runtimeInstance !== invocation.workerInstance
      || runtime.instance !== invocation.workerInstance || !["preparing", "idle", "running", "awaiting_input", "cancelling"].includes(worker.phase))
      throw new Error("Worker read requires its exact live runtime");
    return worker;
  }

  settingsSnapshot(worker: WorkerRecord): SettingsSnapshot {
    return this.ledger.settings.seed(`worker:${worker.id}`, { model: worker.model, ...(worker.effort ? { effort: worker.effort } : {}) }, "Saved Worker selection");
  }

  async readSettings(id: string, invocation?: InvocationContext) {
    const worker = await this.readable(id, invocation);
    const runtime = this.supervisor.runtime(worker.accountId);
    const connected = runtime?.instance === worker.runtimeInstance && ["idle", "running", "awaiting_input", "cancelling"].includes(worker.phase);
    const saved = this.settingsSnapshot(worker);
    const view = settingsState(workerSettingsBackend(worker.provider), saved, this.ledger.settings.get(`worker-defaults:${worker.provider}`),
      connected ? this.ledger.settings.loaded(`worker:${id}`, worker.runtimeInstance!) : null, connected ? worker.runtimeInstance : null);
    const runtimeRecord = this.ledger.history.metadata(id).find((item) => item.kind === "runtime");
    const observed = runtimeRecord ? this.ledger.history.settings(id, runtimeRecord.seq) : null;
    for (const field of view.fields) {
      const value = field.key === "model" ? observed?.model : observed?.effort;
      if (connected && value && observed)
        field.effective = evidence({ [field.key]: value }, field.key, "Native Worker observation", observed.at);
    }
    view.issues.push("Reset removes a saved selection. Existing sessions retain their native selection until explicitly changed; it does not recreate the session.");
    return view;
  }

  async patchSettings(id: string, input: SettingsPatch, invocation?: InvocationContext, preview = false) {
    const worker = await this.owned(id, invocation);
    this.settingsSnapshot(worker);
    if (preview) return this.ledger.settings.preview(`worker:${id}`, workerSettingsBackend(worker.provider), input);
    const receipt = this.ledger.settings.patch(`worker:${id}`, workerSettingsBackend(worker.provider), input);
    this.changed(false, id);
    return receipt;
  }

  async applySettings(id: string, expectedRevision: number, expectedInstance: string, invocation?: InvocationContext) {
    await this.owned(id, invocation);
    const worker = this.ledger.worker(id)!;
    const snapshot = this.settingsSnapshot(worker);
    if (snapshot.revision !== expectedRevision) throw new Error("Settings revision conflict; reread before applying");
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || runtime.instance !== expectedInstance || worker.runtimeInstance !== expectedInstance || !worker.sessionId || worker.phase !== "idle")
      throw new Error("Settings application requires the exact idle native Worker session");
    // Preparing is the existing durable admission fence, checked by send/close/recovery.
    this.ledger.setWorkerPhase(id, "preparing");
    let nativeAttempted = false;
    try {
      const model = typeof snapshot.values.model === "string" ? snapshot.values.model : null;
      const effort = typeof snapshot.values.effort === "string" ? snapshot.values.effort : null;
      if (model || effort) {
        await this.checkChoice(worker.accountId, model ?? worker.model, effort ?? worker.effort);
        const catalog = await this.supervisor.catalog(worker.accountId, false);
        if (!catalog.modelConfigId) throw new Error("Native model selector is unavailable");
        nativeAttempted = true;
        await this.selectValues(id, null, runtime, worker.sessionId, catalog.modelConfigId, model, effort,
          catalog.models.find((entry) => entry.id === (model ?? worker.model))?.effortConfigId ?? null);
      }
      if (this.supervisor.runtime(worker.accountId) !== runtime) throw new Error("Native runtime changed");
      const observed = this.ledger.history.settings(id);
      this.ledger.setSelection(id, model ?? observed?.model ?? worker.model, effort ?? observed?.effort ?? worker.effort);
      this.ledger.settings.markLoaded(`worker:${id}`, runtime.instance, snapshot);
      this.ledger.setWorkerPhase(id, "idle");
      this.changed(false, id);
      return { id, revision: snapshot.revision, status: "loaded" as const };
    } catch (error) {
      if (!nativeAttempted && this.supervisor.runtime(worker.accountId) === runtime) {
        this.ledger.setWorkerPhase(id, "idle");
        this.changed(false, id);
        throw error;
      }
      this.ledger.setWorkerPhase(id, "needs_recovery", "Settings application outcome is unknown; inspect native observations before recovery");
      this.changed(false, id);
      throw new Error("Settings application failed or is unknown; saved settings retained, no automatic retry");
    }
  }
  async list(invocation?: InvocationContext): Promise<Array<WorkerRecord & { turn: ListedTurn | null; pendingPermissions: number }>> {
    const owner = invocation?.workerId ? null : await this.owner(invocation);
    const workers = invocation?.workerId ? [await this.readable(invocation.workerId, invocation)]
      : this.ledger.workers(owner!.botId === LOCAL_OPERATOR_ID ? undefined : owner!.botId);
    return workers.map((worker) => {
      const turn = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null;
      return { ...worker, turn: turn && { id: turn.id, workContext: turn.workContext, phase: turn.phase, stopReason: turn.stopReason, issue: turn.issue,
        dispatchedAt: turn.dispatchedAt, createdAt: turn.createdAt, updatedAt: turn.updatedAt }, pendingPermissions: this.ledger.pending(worker.id).length };
    });
  }
  async diff(id: string, options: DiffOptions, invocation?: InvocationContext) {
    const worker = await this.readable(id, invocation);
    if (!worker.cwd || !worker.baseCommit) throw new Error("this Worker has no prepared worktree");
    return { workerId: worker.id, branch: worker.branch, ...await readWorktreeDiff(worker.cwd, worker.baseCommit, options) };
  }
  async status(id: string, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnSummary | null; pending: PendingRequest[] }> {
    const worker = await this.readable(id, invocation);
    const turn = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null;
    return { worker, turn: turn ? summarizeTurn(turn) : null, pending: this.ledger.pending(id) };
  }
  async workAdmissions(workItemId: string, after: number, limit: number, invocation?: InvocationContext) {
    if (invocation?.workerId) {
      await this.readable(invocation.workerId, invocation);
      return this.ledger.workAdmissions(workItemId, after, limit, { workerId: invocation.workerId });
    }
    const owner = await this.owner(invocation);
    return this.ledger.workAdmissions(workItemId, after, limit, owner.botId === LOCAL_OPERATOR_ID ? undefined : { botId: owner.botId });
  }
  async turnContext(id: string, turnId: string, invocation?: InvocationContext) {
    await this.readable(id, invocation);
    const turn = this.ledger.turn(turnId);
    if (!turn || turn.workerId !== id) throw new Error("turn does not belong to this worker");
    return { workerId: id, turnId, workContext: turn.workContext };
  }
  async read(id: string, afterSeq: number, limit: number, invocation?: InvocationContext) {
    await this.readable(id, invocation);
    return this.ledger.read(id, afterSeq, limit);
  }
  async detail(id: string, invocation?: InvocationContext) {
    const worker = await this.readable(id, invocation);
    const runtime = this.supervisor.runtime(worker.accountId);
    const connected = Boolean(worker.sessionId && runtime && runtime.instance === worker.runtimeInstance
      && ["idle", "running", "awaiting_input", "cancelling"].includes(worker.phase));
    const capture = this.ledger.history.capture(id);
    return { worker, observedSettings: this.ledger.history.settings(id), metadata: this.ledger.history.metadata(id),
      capture, freshness: { connected, stale: !connected || capture.truncated, readAt: Date.now(),
        reason: capture.truncated ? "Capture limit reached; retained projections may be incomplete" : connected ? null : "Retained observations; the exact Worker session is not connected" },
      subagents: { coverage: worker.provider === "devin" ? "unavailable" as const : "partial" as const,
        hierarchyAvailable: false as const, childTranscriptsAvailable: false as const,
        reason: worker.provider === "claude" ? "Claude SDK tool observations may carry parent_tool_use_id; this API does not enumerate native child sessions or read child transcripts. Missing evidence does not prove no children."
          : "ACP supplies no portable parent/child enumeration. OpenCode task rawOutput.metadata can reference a called session; tool completion is not a live child status. Vendor _meta is evidence only; absence does not prove no children." } };
  }
  async turns(id: string, afterId: string | undefined, limit: number, invocation?: InvocationContext) {
    await this.readable(id, invocation);
    return this.ledger.turnPage(id, afterId, limit);
  }
  async records(id: string, afterSeq: number, limit: number, turnId: string | undefined, invocation?: InvocationContext) {
    await this.readable(id, invocation);
    if (turnId && this.ledger.turn(turnId)?.workerId !== id) throw new Error("turn does not belong to this worker");
    return this.ledger.history.read(id, afterSeq, limit, turnId);
  }
  async recordChunk(id: string, seq: number, offset: number, limit: number, invocation?: InvocationContext) {
    await this.readable(id, invocation);
    return this.ledger.history.chunk(id, seq, offset, limit);
  }
  async tools(id: string, afterSeq: number, limit: number, invocation?: InvocationContext) {
    await this.readable(id, invocation);
    return this.ledger.history.tools(id, afterSeq, limit);
  }

  private response(id: string, turnId: string | null, kind: string, value: unknown): void {
    if (!record(value)) return;
    // Never retain session/new/load arguments: those include signed MCP URLs and external MCP credentials.
    this.ledger.history.append(id, turnId, kind, "response", Object.fromEntries(
      Object.entries(value).filter(([key]) => ["sessionId", "configOptions", "models", "modes", "stopReason", "usage", "_meta"].includes(key))));
    if (turnId) this.ledger.observeTurn(turnId, this.ledger.history.settings(id));
  }
  private bindRuntime(id: string, runtime: Runtime): void {
    this.ledger.setRuntimeInstance(id, runtime.instance);
    this.ledger.history.append(id, null, "runtime", "response", { backend: runtime.backend, protocolVersion: runtime.backend === "acp" ? 1 : null, version: runtime.version,
      agentInfo: runtime.agentInfo, capabilities: runtime.capabilities, instance: runtime.instance,
      command: runtime.backend === "claude-sdk" ? "@anthropic-ai/claude-agent-sdk" : runtime.account.provider === "devin" ? "devin" : "opencode",
      args: runtime.backend === "acp" ? ["acp"] : [], processModel: runtime.backend === "claude-sdk" ? "session" : "account" });
  }

  private async account(id: string) {
    const result = await socketCall(socketPath("auth", this.env), "tools/call", { name: "worker_account_list", arguments: {} }, { timeoutMs: 5_000 }) as {
      accounts: Array<{ id: string; provider: WorkerRecord["provider"]; enabled: boolean; ready: boolean; removing: boolean }>;
    };
    const account = result.accounts.find((entry) => entry.id === id);
    if (!account || !account.enabled || !account.ready || account.removing) throw new Error("worker account is not enabled and ready");
    return account;
  }

  private async checkChoice(accountId: string, model: string, effort: string | null): Promise<void> {
    const catalog = await this.supervisor.catalog(accountId, false);
    if (catalog.stale) throw new Error("worker catalog is stale; refresh it before dispatch");
    const selected = catalog.models.find((item) => item.id === model);
    if (!selected) throw new Error("model is not in this account's runtime catalog");
    if (selected.efforts.length && !effort) throw new Error("select an explicit effort from this model's catalog choices");
    if (effort && !selected.efforts.includes(effort)) throw new Error("effort is not offered for this account/model combination");
  }

  private async select(id: string, turnId: string | null, runtime: Runtime, sessionId: string, initial: unknown, model: string, effort: string | null): Promise<void> {
    const option = modelOption(optionsOf(initial));
    if (!option || !option.values.some((value) => value.value === model)) throw new Error("ACP session did not offer the selected model");
    await this.selectValues(id, turnId, runtime, sessionId, option.id, model, effort, null);
  }

  private async selectValues(id: string, turnId: string | null, runtime: Runtime, sessionId: string, configId: string,
    model: string | null, effort: string | null, effortId: string | null): Promise<void> {
    if (model) {
      const selected = await runtime.process.request("session/set_config_option", { sessionId, configId, value: model });
      this.response(id, turnId, "config_option_update", selected);
      const current = currentOption(selected, configId);
      if (current && current !== model) throw new Error("Native runtime selected a different model");
      const option = effortOption(optionsOf(selected));
      if (effort && !option?.values.some((value) => value.value === effort)) throw new Error("Native session did not offer the selected effort");
      effortId = option?.id ?? null;
    }
    if (effort) {
      if (!effortId) throw new Error("Native effort selector unavailable");
      const response = await runtime.process.request("session/set_config_option", { sessionId, configId: effortId, value: effort });
      this.response(id, turnId, "config_option_update", response);
      const actual = currentOption(response, effortId);
      if (actual && actual !== effort) throw new Error("ACP selected a different effort");
    }
  }

  async start(input: StartInput, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnSummary; duplicate: boolean }> {
    const owner = await this.owner(invocation);
    const intent = { requestId: input.requestId, botId: owner.botId, threadId: owner.threadId, accountId: input.accountId,
      provider: "" as WorkerRecord["provider"], model: input.model, effort: input.effort ?? null, repo: input.repo,
      baseRef: input.baseRef ?? null, task: input.task, ...(input.roleId ? { roleId: input.roleId } : {}), ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}) };
    const existing = this.ledger.startByRequestId(input.requestId);
    if (existing) {
      ownsWorker(owner, existing);
      const initial = this.ledger.turnByRequestId(input.requestId)!;
      intent.model ??= initial.requestedModel ?? existing.model;
      if (input.effort === undefined) intent.effort = initial.requestedEffort;
      const prior = this.ledger.findStart(input.requestId, { ...intent, model: intent.model!, provider: existing.provider })!;
      return { worker: prior.worker, turn: summarizeTurn(prior.turn), duplicate: true };
    }
    const account = await this.account(input.accountId);
    intent.provider = account.provider;
    const defaults = this.ledger.settings.get(`worker-defaults:${account.provider}`)!;
    const model = input.model ?? (typeof defaults.values.model === "string" ? defaults.values.model : undefined);
    const effort = input.effort ?? (typeof defaults.values.effort === "string" ? defaults.values.effort : null);
    if (!model) throw new Error("Select a model from worker_catalog or save a provider Worker default");
    intent.model = model; intent.effort = effort;
    await this.checkChoice(input.accountId, model, effort);
    const workContext = await resolveWorkContext(this.env, input.workItemId, invocation);
    const reserved = this.ledger.reserve({ ...intent, model }, workContext);
    if (reserved.duplicate) return { ...reserved, turn: summarizeTurn(reserved.turn) };
    const id = reserved.worker.id;
    const selection = this.ledger.settings.seed(`worker:${id}`, { model, ...(effort ? { effort } : {}) }, "Worker admission selection", defaults.revision);
    let stage = "Role snapshot";
    try {
      const snapshot = await roleSnapshot(this.env, input.roleId);
      stage = "worktree";
      const claim = await claimWorktree(this.stateDir, id, input.repo, input.baseRef, snapshot);
      stage = "Role snapshot";
      await saveWorkerRole(this.stateDir, id, snapshot);
      this.ledger.setWorktree(id, claim);
      stage = "Worker session";
      const runtime = this.supervisor.runtime(input.accountId);
      if (!runtime) throw new Error("account runtime is unavailable");
      this.bindRuntime(id, runtime);
      const mcpServers = await sessionMcpServers(snapshot, this.env, runtime.supportsHttp, claim.cwd, { id, instance: runtime.instance });
      const creating = this.creating.get(runtime.instance) ?? { count: 0, chars: 0, dropped: 0, updates: [] };
      this.creating.set(runtime.instance, creating); creating.count++;
      let result: Record<string, unknown>;
      try {
        const resources = account.provider === "claude" ? await claudeRole(this.stateDir, id, snapshot) : {};
        const value = await runtime.process.request("session/new", { cwd: claim.cwd, mcpServers, ...resources });
        if (!record(value) || typeof value.sessionId !== "string") throw new Error("ACP returned no session ID");
        result = value;
        this.ledger.setSession(id, value.sessionId);
        this.ledger.setWorkerPhase(id, "preparing");
        this.sessions.set(`${input.accountId}:${value.sessionId}`, id);
        for (const notification of creating.updates.filter((item) => item.sessionId === value.sessionId))
          this.captureUpdate(this.ledger.worker(id)!, notification.update, notification.meta);
        if (creating.dropped) this.ledger.history.drop(id, creating.dropped);
        this.response(id, reserved.turn.id, "session/new", value);
      } finally { if (--creating.count === 0) this.creating.delete(runtime.instance); }
      await this.select(id, reserved.turn.id, runtime, result.sessionId as string, result, model, effort);
      this.ledger.settings.markLoaded(`worker:${id}`, runtime.instance, selection);
      const instructions = renderInstructions(snapshot);
      this.prompt(id, reserved.turn.id, account.provider !== "claude" && instructions ? `${instructions}\n\n${input.task}` : input.task);
    } catch {
      const issue = `${stage} preparation failed; inspect the owned worktree and account runtime`;
      this.ledger.setTurnPhase(reserved.turn.id, "failed", null, issue);
      this.ledger.setWorkerPhase(id, "failed", issue);
      this.ledger.append(id, reserved.turn.id, "turn", issue);
    }
    this.changed(false, id);
    return { worker: this.ledger.worker(id)!, turn: summarizeTurn(this.ledger.turn(reserved.turn.id)!), duplicate: false };
  }

  private prompt(id: string, turnId: string, promptText: string): void {
    const pending = this.ledger.turn(turnId);
    if (!pending || pending.phase === "cancelling") {
      if (pending) this.ledger.completeTurn(turnId, "cancelled", "cancelled", null);
      this.changed(false, id);
      return;
    }
    const worker = this.ledger.worker(id)!;
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || runtime.instance !== worker.runtimeInstance || !worker.sessionId) {
      this.ledger.completeTurn(turnId, "unknown", null, "Worker runtime unavailable before prompt dispatch");
      this.ledger.append(id, turnId, "turn", "outcome unknown · Worker runtime unavailable before prompt dispatch");
      this.changed(false, id);
      return;
    }
    this.ledger.setTurnPhase(turnId, "running");
    this.ledger.setWorkerPhase(id, "running");
    this.ledger.dispatchTurn(turnId, promptText);
    this.changed(false, id);
    void runtime.process.request("session/prompt", { sessionId: worker.sessionId, prompt: [{ type: "text", text: promptText }] }, 0)
      .then((result) => {
        if (this.closing) return;
        const current = this.ledger.turn(turnId);
        if (!current || ["completed", "cancelled", "failed", "unknown"].includes(current.phase)) return;
        const reason = record(result) && typeof result.stopReason === "string" ? result.stopReason : null;
        this.response(id, turnId, "session/prompt", result);
        const failed = record(result) && result.failed === true;
        this.ledger.completeTurn(turnId, reason === "cancelled" ? "cancelled" : failed ? "failed" : reason ? "completed" : "unknown", reason,
          failed ? "Native runtime reported a failed turn" : reason ? null : "Worker prompt returned no stop reason; inspect before continuing");
        this.ledger.append(id, turnId, "turn", reason ? `stopped · ${reason}` : "outcome unknown · no stop reason");
        this.changed(false, id);
      }).catch(() => {
        if (this.closing) return;
        const current = this.ledger.turn(turnId);
        if (!current || ["completed", "cancelled", "failed", "unknown"].includes(current.phase)) return;
        this.ledger.completeTurn(turnId, "unknown", null, "Worker prompt outcome is unknown; inspect the worktree before resuming");
        this.ledger.append(id, turnId, "turn", "outcome unknown · Worker connection failed");
        this.changed(false, id);
      });
  }

  async send(input: SendInput, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnSummary; duplicate: boolean }> {
    const worker = await this.owned(input.id, invocation);
    const snapshot = this.settingsSnapshot(worker);
    const previous = this.ledger.turnByRequestId(input.requestId);
    const selected = input.model ?? (previous?.workerId === worker.id ? previous.requestedModel ?? worker.model : String(snapshot.values.model ?? worker.model));
    const effort = input.effort ?? (previous?.workerId === worker.id ? previous.requestedEffort : input.model && input.model !== worker.model ? null : typeof snapshot.values.effort === "string" ? snapshot.values.effort : worker.effort);
    // Check an existing request before requiring a currently fresh catalog or an idle worker.
    const prior = this.ledger.findTurnRequest(worker.id, input.requestId, input.message, selected, effort, input.workItemId);
    if (prior) return { worker: this.ledger.worker(worker.id)!, turn: summarizeTurn(prior), duplicate: true };
    await this.checkChoice(worker.accountId, selected, effort);
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || runtime.instance !== worker.runtimeInstance || !worker.sessionId) throw new Error("worker session is not loaded; use worker_resume");
    const previousContext = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId)?.workContext ?? null : null;
    const workContext = await resolveWorkContext(this.env, input.workItemId, invocation, previousContext);
    const reserved = this.ledger.reserveTurn(worker.id, input.requestId, input.message, selected, effort, input.workItemId, workContext);
    if (reserved.duplicate) return { worker, turn: summarizeTurn(reserved.turn), duplicate: true };
    let applied = snapshot;
    try {
      if (input.model || input.effort) {
        this.ledger.settings.patch(`worker:${worker.id}`, workerSettingsBackend(worker.provider), { expectedRevision: snapshot.revision, requestId: randomUUID(),
          set: { model: selected, ...(effort ? { effort } : {}) }, ...(effort ? {} : { reset: ["effort"] }) });
        applied = this.ledger.settings.get(`worker:${worker.id}`)!;
      }
      const loaded = this.ledger.settings.loaded(`worker:${worker.id}`, runtime.instance);
      if (!loaded || loaded.revision !== applied.revision || input.model || input.effort) {
        const catalog = await this.supervisor.catalog(worker.accountId, false);
        if (!catalog.modelConfigId || catalog.stale) throw new Error("account model configuration is unavailable");
        await this.selectValues(worker.id, reserved.turn.id, runtime, worker.sessionId, catalog.modelConfigId,
          typeof applied.values.model === "string" ? applied.values.model : null, typeof applied.values.effort === "string" ? applied.values.effort : null,
          catalog.models.find((entry) => entry.id === selected)?.effortConfigId ?? null);
        this.ledger.setSelection(worker.id, selected, effort);
        this.ledger.settings.markLoaded(`worker:${worker.id}`, runtime.instance, applied);
      }
      this.prompt(worker.id, reserved.turn.id, input.message);
    } catch {
      this.ledger.completeTurn(reserved.turn.id, "unknown", null, "Worker selection outcome is unknown; inspect before retrying");
      this.ledger.append(worker.id, reserved.turn.id, "turn", "outcome unknown · Worker selection failed");
    }
    this.changed(false, worker.id);
    return { worker: this.ledger.worker(worker.id)!, turn: summarizeTurn(this.ledger.turn(reserved.turn.id)!), duplicate: false };
  }

  async respond(id: string, permissionId: string, optionId: string | null, invocation?: InvocationContext): Promise<PendingRequest> {
    const worker = await this.owned(id, invocation);
    const pending = this.ledger.permission(permissionId);
    if (!pending || pending.workerId !== id || pending.state !== "pending") throw new Error("permission request is not pending for this worker");
    if (optionId && !pending.options.some((option) => option.optionId === optionId)) throw new Error("permission option is not offered");
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || runtime.instance !== worker.runtimeInstance || pending.runtimeInstance !== runtime.instance
      || pending.turnId !== worker.currentTurnId || this.ledger.turn(pending.turnId)?.phase !== "awaiting_input"
      || worker.phase !== "awaiting_input") throw new Error("worker is not awaiting this permission in the exact runtime and turn");
    runtime.process.respondRequest(pending.acpRequestId, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    this.ledger.resolvePermission(permissionId);
    this.changed(false, id);
    return this.ledger.permission(permissionId)!;
  }

  async cancel(id: string, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnSummary | null }> {
    const worker = await this.owned(id, invocation);
    const turn = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null;
    if (!turn || !["queued", "running", "awaiting_input", "cancelling"].includes(turn.phase)) return { worker, turn: turn ? summarizeTurn(turn) : null };
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || runtime.instance !== worker.runtimeInstance || !worker.sessionId) throw new Error("Worker session is unavailable; turn outcome requires recovery");
    runtime.process.cancelPermissions(worker.sessionId);
    this.ledger.cancelPending(id);
    this.ledger.setTurnPhase(turn.id, "cancelling");
    this.ledger.setWorkerPhase(id, "cancelling");
    runtime.process.notify("session/cancel", { sessionId: worker.sessionId });
    this.changed(false, id);
    return { worker: this.ledger.worker(id)!, turn: summarizeTurn(this.ledger.turn(turn.id)!) };
  }

  async resume(id: string, acknowledgeUnknownTurn: boolean, invocation?: InvocationContext): Promise<WorkerRecord> {
    const worker = await this.owned(id, invocation);
    if (worker.phase !== "needs_recovery" || !worker.sessionId || !worker.cwd) throw new Error("worker has no loadable saved session");
    const turn = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null;
    if (turn?.phase === "unknown" && !acknowledgeUnknownTurn) throw new Error("acknowledge the unknown turn outcome after inspecting the worktree");
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime?.canLoad) throw new Error("account runtime cannot load saved sessions");
    this.bindRuntime(id, runtime);
    this.ledger.setWorkerPhase(id, "preparing");
    this.ledger.settings.clearLoaded(`worker:${id}`);
    this.loading.add(id);
    try {
      const snapshot = await loadWorkerRole(this.stateDir, id);
      const mcpServers = await sessionMcpServers(snapshot, this.env, runtime.supportsHttp, worker.cwd, { id, instance: runtime.instance });
      const resources = worker.provider === "claude" ? await claudeRole(this.stateDir, id, snapshot) : {};
      const result = await runtime.process.request("session/load", { sessionId: worker.sessionId, cwd: worker.cwd, mcpServers, ...resources }, 60_000);
      this.response(id, null, "session/load", result);
      if (worker.provider === "claude") await this.select(id, null, runtime, worker.sessionId, result, worker.model, worker.effort);
      this.ledger.setWorkerPhase(id, "idle");
    } catch {
      this.ledger.setWorkerPhase(id, "needs_recovery", "Worker session load failed; inspect before retrying");
      this.changed(false, id);
      throw new Error("Worker session load failed; inspect before retrying");
    } finally { this.loading.delete(id); }
    this.changed(false, id);
    return this.ledger.worker(id)!;
  }

  async closeWorker(id: string, invocation?: InvocationContext): Promise<WorkerRecord> {
    const worker = await this.owned(id, invocation);
    if (worker.phase === "closed") return worker;
    if (["running", "awaiting_input", "cancelling", "preparing"].includes(worker.phase)) throw new Error("worker has active or uncertain preparation; cancel or inspect before closing");
    const runtime = this.supervisor.runtime(worker.accountId);
    if (runtime?.canClose && runtime.instance === worker.runtimeInstance && worker.sessionId && ["idle", "failed"].includes(worker.phase))
      await runtime.process.request("session/close", { sessionId: worker.sessionId });
    this.ledger.setWorkerPhase(id, "closed");
    if (worker.sessionId) this.sessions.delete(`${worker.accountId}:${worker.sessionId}`);
    this.changed(false, id);
    return this.ledger.worker(id)!;
  }

  async remove(id: string, discardWorktree: boolean, invocation?: InvocationContext): Promise<{ id: string; retainedBranch: string | null }> {
    const worker = await this.owned(id, invocation);
    if (worker.phase !== "closed") throw new Error("close the worker before removing its record");
    if (!discardWorktree) throw new Error("explicit discardWorktree: true is required; this deletes the worktree, including uncommitted changes");
    if (worker.cwd && worker.branch) await removeWorktree({ repo: worker.repo, cwd: worker.cwd, branch: worker.branch }, id);
    await removeWorkerRole(this.stateDir, id);
    this.ledger.removeWorker(id);
    if (worker.sessionId) this.sessions.delete(`${worker.accountId}:${worker.sessionId}`);
    this.changed(false, id);
    return { id, retainedBranch: worker.branch };
  }
}

export function workerSettingsBackend(provider: WorkerRecord["provider"]): SettingsBackend {
  return provider === "claude" ? "claude-sdk" : provider === "devin" ? "devin-acp" : provider === "codex" ? "opencode-codex" : "opencode-grok";
}
