import { socketCall, socketPath, type InvocationContext } from "@agentstack/api";
import { record, type AcpRequest } from "./acp.js";
import { currentOption, effortOption, modelOption, optionsOf } from "./catalog.js";
import { WorkerLedger, type WorkerRecord, type TurnRecord, type PendingRequest } from "./ledger.js";
import { LOCAL_OPERATOR_ID, ownsWorker, workerOwner, type WorkerOwner } from "./owner.js";
import { roleSnapshot, sessionMcpServers } from "./resources.js";
import { WorkerSupervisor, type Runtime } from "./supervisor.js";
import { claimWorktree, loadWorkerRole, removeWorkerRole, removeWorktree, saveWorkerRole } from "./worktree.js";

export type StartInput = { accountId: string; model: string; effort?: string; repo: string; baseRef?: string; task: string; requestId: string };
export type SendInput = { id: string; message: string; requestId: string; model?: string; effort?: string };

export class WorkerManager {
  readonly ledger: WorkerLedger;
  onChange?: (workerId?: string) => void;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private readonly sessions = new Map<string, string>();

  constructor(private readonly stateDir: string, readonly supervisor: WorkerSupervisor, private readonly env: NodeJS.ProcessEnv) {
    this.ledger = new WorkerLedger(stateDir);
    for (const worker of this.ledger.workers()) if (worker.acpSessionId)
      this.sessions.set(`${worker.accountId}:${worker.acpSessionId}`, worker.id);
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
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => { this.progressTimer = undefined; this.onChange?.(); }, 1_000);
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
    if (this.closing) return;
    if (method !== "session/update" || !record(params) || typeof params.sessionId !== "string" || !record(params.update)) return;
    const worker = this.findSession(runtime.account.id, params.sessionId);
    if (!worker?.currentTurnId || !["running", "awaiting_input", "cancelling"].includes(worker.phase)) return;
    const turn = this.ledger.turn(worker.currentTurnId);
    if (!turn || !["running", "awaiting_input", "cancelling"].includes(turn.phase)) return;
    const update = params.update;
    const type = update.sessionUpdate;
    if (type === "agent_message_chunk" && record(update.content) && update.content.type === "text" && typeof update.content.text === "string") {
      this.ledger.append(worker.id, turn.id, "agent", update.content.text);
    } else if ((type === "tool_call" || type === "tool_call_update") && typeof update.title === "string") {
      this.ledger.append(worker.id, turn.id, "tool", `${update.title.slice(0, 1_000)}${typeof update.status === "string" ? ` · ${update.status}` : ""}`);
    } else if (type === "plan" && Array.isArray(update.entries)) {
      this.ledger.append(worker.id, turn.id, "plan", JSON.stringify(update.entries).slice(0, 16_000));
    } else return;
    this.changed(true);
  }

  private onRequest(runtime: Runtime, request: AcpRequest): boolean {
    if (this.closing) return false;
    if (request.method !== "session/request_permission" || !record(request.params) || typeof request.params.sessionId !== "string") return false;
    const worker = this.findSession(runtime.account.id, request.params.sessionId);
    if (!worker?.currentTurnId || !["running", "awaiting_input"].includes(worker.phase) || this.ledger.pending(worker.id).length >= 8) return false;
    const options = Array.isArray(request.params.options) ? request.params.options.flatMap((value: unknown) => {
      if (!record(value) || typeof value.optionId !== "string" || typeof value.name !== "string") return [];
      return [{ optionId: value.optionId, name: value.name, kind: typeof value.kind === "string" ? value.kind : "other" }];
    }) : [];
    if (!options.length || options.length > 32 || options.some((option) => option.optionId.length > 256 || option.name.length > 1_000)) return false;
    const toolCall = request.params.toolCall;
    const title = record(toolCall) && typeof toolCall.title === "string" ? toolCall.title : "Worker requests permission";
    this.ledger.addPermission(worker.id, worker.currentTurnId, request.id, title, options);
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
  async list(invocation?: InvocationContext): Promise<WorkerRecord[]> {
    const owner = await this.owner(invocation);
    return this.ledger.workers(owner.botId === LOCAL_OPERATOR_ID ? undefined : owner.botId);
  }
  async status(id: string, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnRecord | null; pending: PendingRequest[] }> {
    const worker = await this.owned(id, invocation);
    return { worker, turn: worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null, pending: this.ledger.pending(id) };
  }
  async read(id: string, afterSeq: number, limit: number, invocation?: InvocationContext) {
    await this.owned(id, invocation);
    return this.ledger.read(id, afterSeq, limit);
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
    if (!selected) throw new Error("model is not in this account's ACP catalog");
    if (selected.efforts.length && !effort) throw new Error("select an explicit effort from this model's catalog choices");
    if (effort && !selected.efforts.includes(effort)) throw new Error("effort is not offered for this account/model combination");
  }

  private async select(runtime: Runtime, sessionId: string, initial: unknown, model: string, effort: string | null): Promise<void> {
    const option = modelOption(optionsOf(initial));
    if (!option || !option.values.some((value) => value.value === model)) throw new Error("ACP session did not offer the selected model");
    const selected = await runtime.process.request("session/set_config_option", { sessionId, configId: option.id, value: model });
    const current = currentOption(selected, option.id);
    if (current && current !== model) throw new Error("ACP selected a different model");
    const effortOptionForModel = effortOption(optionsOf(selected));
    if (effort) {
      if (!effortOptionForModel?.values.some((value) => value.value === effort)) throw new Error("ACP session did not offer the selected effort");
      const response = await runtime.process.request("session/set_config_option", { sessionId, configId: effortOptionForModel.id, value: effort });
      const actual = currentOption(response, effortOptionForModel.id);
      if (actual && actual !== effort) throw new Error("ACP selected a different effort");
    }
  }

  async start(input: StartInput, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnRecord; duplicate: boolean }> {
    const owner = await this.owner(invocation);
    const intent = { requestId: input.requestId, botId: owner.botId, threadId: owner.threadId, accountId: input.accountId,
      provider: "" as WorkerRecord["provider"], model: input.model, effort: input.effort ?? null, repo: input.repo,
      baseRef: input.baseRef ?? null, task: input.task };
    const existing = this.ledger.startByRequestId(input.requestId);
    if (existing) {
      ownsWorker(owner, existing);
      const prior = this.ledger.findStart(input.requestId, { ...intent, provider: existing.provider })!;
      return { ...prior, duplicate: true };
    }
    const account = await this.account(input.accountId);
    intent.provider = account.provider;
    await this.checkChoice(input.accountId, input.model, input.effort ?? null);
    const snapshot = await roleSnapshot(this.env);
    const reserved = this.ledger.reserve(intent);
    if (reserved.duplicate) return reserved;
    const id = reserved.worker.id;
    let stage = "worktree";
    try {
      const claim = await claimWorktree(this.stateDir, id, input.repo, input.baseRef, snapshot);
      stage = "Role snapshot";
      await saveWorkerRole(this.stateDir, id, snapshot);
      this.ledger.setWorktree(id, claim);
      stage = "ACP session";
      const runtime = this.supervisor.runtime(input.accountId);
      if (!runtime) throw new Error("account ACP process is unavailable");
      this.ledger.setRuntimeInstance(id, runtime.instance);
      const mcpServers = await sessionMcpServers(snapshot, this.env, runtime.supportsHttp, claim.cwd, { id, instance: runtime.instance });
      const result = await runtime.process.request("session/new", { cwd: claim.cwd, mcpServers });
      if (!record(result) || typeof result.sessionId !== "string") throw new Error("ACP returned no session ID");
      await this.select(runtime, result.sessionId, result, input.model, input.effort ?? null);
      this.ledger.setSession(id, result.sessionId);
      this.sessions.set(`${input.accountId}:${result.sessionId}`, id);
      this.prompt(id, reserved.turn.id, input.task, claim.instructions && account.provider !== "devin"
        ? `AgentStack Role instructions for this worker:\n${claim.instructions}\n\nTask:\n${input.task}` : input.task);
    } catch {
      const issue = `${stage} preparation failed; inspect the owned worktree and account runtime`;
      this.ledger.setTurnPhase(reserved.turn.id, "failed", null, issue);
      this.ledger.setWorkerPhase(id, "failed", issue);
      this.ledger.append(id, reserved.turn.id, "turn", issue);
    }
    this.changed(false, id);
    return { worker: this.ledger.worker(id)!, turn: this.ledger.turn(reserved.turn.id)!, duplicate: false };
  }

  private prompt(id: string, turnId: string, visibleMessage: string, promptText: string): void {
    const pending = this.ledger.turn(turnId);
    if (!pending || pending.phase === "cancelling") {
      if (pending) this.ledger.completeTurn(turnId, "cancelled", "cancelled", null);
      this.changed(false, id);
      return;
    }
    const worker = this.ledger.worker(id)!;
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || !worker.acpSessionId) {
      this.ledger.completeTurn(turnId, "unknown", null, "ACP process unavailable before prompt dispatch");
      this.ledger.append(id, turnId, "turn", "outcome unknown · ACP process unavailable before prompt dispatch");
      this.changed(false, id);
      return;
    }
    this.ledger.setTurnPhase(turnId, "running");
    this.ledger.setWorkerPhase(id, "running");
    this.ledger.append(id, turnId, "user", visibleMessage);
    this.changed(false, id);
    void runtime.process.request("session/prompt", { sessionId: worker.acpSessionId, prompt: [{ type: "text", text: promptText }] }, 0)
      .then((result) => {
        if (this.closing) return;
        const current = this.ledger.turn(turnId);
        if (!current || ["completed", "cancelled", "failed", "unknown"].includes(current.phase)) return;
        const reason = record(result) && typeof result.stopReason === "string" ? result.stopReason : null;
        this.ledger.completeTurn(turnId, reason === "cancelled" ? "cancelled" : reason ? "completed" : "unknown", reason,
          reason ? null : "ACP prompt returned no stop reason; inspect before continuing");
        this.ledger.append(id, turnId, "turn", reason ? `stopped · ${reason}` : "outcome unknown · no stop reason");
        this.changed(false, id);
      }).catch(() => {
        if (this.closing) return;
        this.ledger.completeTurn(turnId, "unknown", null, "ACP prompt outcome is unknown; inspect the worktree before resuming");
        this.ledger.append(id, turnId, "turn", "outcome unknown · ACP connection failed");
        this.changed(false, id);
      });
  }

  async send(input: SendInput, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnRecord; duplicate: boolean }> {
    const worker = await this.owned(input.id, invocation);
    const selected = input.model ?? worker.model;
    const effort = input.model && input.model !== worker.model ? input.effort ?? null : input.effort ?? worker.effort;
    // Check an existing request before requiring a currently fresh catalog or an idle worker.
    const prior = this.ledger.findTurnRequest(worker.id, input.requestId, input.message, selected, effort);
    if (prior) return { worker: this.ledger.worker(worker.id)!, turn: prior, duplicate: true };
    await this.checkChoice(worker.accountId, selected, effort);
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || !worker.acpSessionId) throw new Error("worker ACP session is not loaded; use worker_resume");
    const reserved = this.ledger.reserveTurn(worker.id, input.requestId, input.message, selected, effort);
    if (reserved.duplicate) return { worker, turn: reserved.turn, duplicate: true };
    try {
      if (input.model || input.effort) {
        const catalog = await this.supervisor.catalog(worker.accountId, false);
        if (!catalog.modelConfigId || catalog.stale) throw new Error("account model configuration is unavailable");
        const current = await runtime.process.request("session/set_config_option", { sessionId: worker.acpSessionId,
          configId: catalog.modelConfigId, value: selected });
        const actualModel = currentOption(current, catalog.modelConfigId);
        if (actualModel && actualModel !== selected) throw new Error("ACP selected a different model");
        const option = effortOption(optionsOf(current));
        if (effort) {
          if (!option?.values.some((value) => value.value === effort)) throw new Error("ACP did not offer requested effort");
          const confirmed = await runtime.process.request("session/set_config_option", { sessionId: worker.acpSessionId, configId: option.id, value: effort });
          const actualEffort = currentOption(confirmed, option.id);
          if (actualEffort && actualEffort !== effort) throw new Error("ACP selected a different effort");
        }
        this.ledger.setSelection(worker.id, selected, effort);
      }
      this.prompt(worker.id, reserved.turn.id, input.message, input.message);
    } catch {
      this.ledger.completeTurn(reserved.turn.id, "unknown", null, "ACP selection outcome is unknown; inspect before retrying");
      this.ledger.append(worker.id, reserved.turn.id, "turn", "outcome unknown · ACP selection failed");
    }
    this.changed(false, worker.id);
    return { worker: this.ledger.worker(worker.id)!, turn: this.ledger.turn(reserved.turn.id)!, duplicate: false };
  }

  async respond(id: string, permissionId: string, optionId: string | null, invocation?: InvocationContext): Promise<PendingRequest> {
    const worker = await this.owned(id, invocation);
    const pending = this.ledger.permission(permissionId);
    if (!pending || pending.workerId !== id || pending.state !== "pending") throw new Error("permission request is not pending for this worker");
    if (optionId && !pending.options.some((option) => option.optionId === optionId)) throw new Error("permission option is not offered");
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || worker.phase !== "awaiting_input") throw new Error("worker is not awaiting this permission");
    runtime.process.respondRequest(pending.acpRequestId, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    this.ledger.resolvePermission(permissionId);
    this.changed(false, id);
    return this.ledger.permission(permissionId)!;
  }

  async cancel(id: string, invocation?: InvocationContext): Promise<{ worker: WorkerRecord; turn: TurnRecord | null }> {
    const worker = await this.owned(id, invocation);
    const turn = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null;
    if (!turn || !["queued", "running", "awaiting_input", "cancelling"].includes(turn.phase)) return { worker, turn };
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime || !worker.acpSessionId) throw new Error("ACP session is unavailable; turn outcome requires recovery");
    runtime.process.cancelPermissions(worker.acpSessionId);
    this.ledger.cancelPending(id);
    this.ledger.setTurnPhase(turn.id, "cancelling");
    this.ledger.setWorkerPhase(id, "cancelling");
    runtime.process.notify("session/cancel", { sessionId: worker.acpSessionId });
    this.changed(false, id);
    return { worker: this.ledger.worker(id)!, turn: this.ledger.turn(turn.id) };
  }

  async resume(id: string, acknowledgeUnknownTurn: boolean, invocation?: InvocationContext): Promise<WorkerRecord> {
    const worker = await this.owned(id, invocation);
    if (worker.phase !== "needs_recovery" || !worker.acpSessionId || !worker.cwd) throw new Error("worker has no loadable saved ACP session");
    const turn = worker.currentTurnId ? this.ledger.turn(worker.currentTurnId) : null;
    if (turn?.phase === "unknown" && !acknowledgeUnknownTurn) throw new Error("acknowledge the unknown turn outcome after inspecting the worktree");
    const runtime = this.supervisor.runtime(worker.accountId);
    if (!runtime?.canLoad) throw new Error("account ACP process cannot load saved sessions");
    const snapshot = await loadWorkerRole(this.stateDir, id);
    this.ledger.setRuntimeInstance(id, runtime.instance);
    this.ledger.setWorkerPhase(id, "preparing");
    try {
      const mcpServers = await sessionMcpServers(snapshot, this.env, runtime.supportsHttp, worker.cwd, { id, instance: runtime.instance });
      await runtime.process.request("session/load", { sessionId: worker.acpSessionId, cwd: worker.cwd, mcpServers }, 60_000);
      this.ledger.setWorkerPhase(id, "idle");
    } catch {
      this.ledger.setWorkerPhase(id, "needs_recovery", "ACP session load failed; inspect before retrying");
      throw new Error("ACP session load failed; inspect before retrying");
    }
    this.changed(false, id);
    return this.ledger.worker(id)!;
  }

  async closeWorker(id: string, invocation?: InvocationContext): Promise<WorkerRecord> {
    const worker = await this.owned(id, invocation);
    if (worker.phase === "closed") return worker;
    if (["running", "awaiting_input", "cancelling", "preparing"].includes(worker.phase)) throw new Error("worker has active or uncertain preparation; cancel or inspect before closing");
    const runtime = this.supervisor.runtime(worker.accountId);
    if (runtime?.canClose && worker.acpSessionId && worker.phase === "idle")
      await runtime.process.request("session/close", { sessionId: worker.acpSessionId });
    this.ledger.setWorkerPhase(id, "closed");
    if (worker.acpSessionId) this.sessions.delete(`${worker.accountId}:${worker.acpSessionId}`);
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
    if (worker.acpSessionId) this.sessions.delete(`${worker.accountId}:${worker.acpSessionId}`);
    this.changed(false, id);
    return { id, retainedBranch: worker.branch };
  }
}
