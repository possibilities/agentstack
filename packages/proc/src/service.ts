import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { forwardTimeout, socketCall, socketPath, type InvocationContext } from "@agentstack/api";
import { operator, systemBrainId, type Action, type Authority, type ProcessSpec, type ScheduleSpec } from "./schema.js";
import { ProcStore } from "./store.js";
import { AuthorityBlocked, owns, ProcAuthority } from "./authority.js";

type Call = (pkg: string, operation: string, input: unknown, timeoutMs: number, signal?: AbortSignal, invocation?: InvocationContext) => Promise<unknown>;
const runnerPath = fileURLToPath(new URL("./runner.js", import.meta.url));
function killGroup(pid: number) {
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("proc group cleanup failed:", error); }
}

export class ProcService {
  onRunsChanged?: (id: string) => void;
  onOutputChanged?: (id: string) => void;
  onSchedulesChanged?: (id: string) => void;
  private readonly active = new Map<string, { guard: ChildProcess; task: Promise<void>; cancel: () => void }>();
  private readonly calls = new Set<{ controller: AbortController; task: Promise<void> }>();
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private lastPrune = 0;
  private sweep?: Promise<void>;
  private closing = false;
  readonly policy: ProcAuthority;
  constructor(readonly store: ProcStore, private readonly env: NodeJS.ProcessEnv,
    private readonly call: Call = async (pkg, operation, input, timeoutMs, signal, invocation) =>
      socketCall(socketPath(pkg, env), "tools/call", { name: operation, arguments: input, invocation }, { timeoutMs, signal }),
    root?: string) { this.policy = new ProcAuthority(env, root); }

  async validate(action: Action, authority: Authority = operator) { await this.policy.target(action, authority); }

  async createSchedule(id: string, spec: ScheduleSpec, invocation?: InvocationContext) {
    const actor = await this.policy.actor(invocation);
    await this.validate(spec.action, actor);
    if (actor.kind === "bot") await this.policy.resolve(actor, invocation?.instance ?? undefined);
    const record = this.store.createSchedule(id, spec, actor);
    this.onSchedulesChanged?.(id);
    return record;
  }
  async updateSchedule(id: string, revision: number, spec: ScheduleSpec, invocation?: InvocationContext, reauthorize = false) {
    const actor = await this.policy.actor(invocation);
    const current = this.store.getSchedule(id);
    owns(actor, current.authority);
    if (current.system) throw new Error("schedule_revision_conflict_or_protected");
    if (reauthorize ? current.authority !== null || actor.kind !== "operator" : current.authority === null)
      throw new Error(reauthorize ? "schedule_reauthorization_refused" : "legacy_reauthorization_required");
    if (spec.enabled || reauthorize) await this.validate(spec.action, reauthorize ? operator : current.authority!);
    if (actor.kind === "bot") await this.policy.resolve(actor, invocation?.instance ?? undefined);
    const record = this.store.updateSchedule(id, revision, spec, actor, reauthorize);
    this.onSchedulesChanged?.(id);
    return record;
  }
  async schedule(id: string, invocation?: InvocationContext, includeRemoved = false) {
    const actor = await this.policy.actor(invocation);
    const record = this.store.getSchedule(id, includeRemoved);
    owns(actor, record.authority);
    return record;
  }
  async removeSchedule(id: string, revision: number, invocation?: InvocationContext) {
    const actor = await this.policy.actor(invocation);
    owns(actor, this.store.getSchedule(id).authority);
    const result = this.store.removeSchedule(id, revision, actor);
    this.onSchedulesChanged?.(id);
    return result;
  }
  async schedules(limit: number, invocation?: InvocationContext) {
    const actor = await this.policy.actor(invocation);
    return this.store.schedules(limit, actor.kind === "bot" ? actor : undefined);
  }
  async execution(id: string, invocation?: InvocationContext) {
    const actor = await this.policy.actor(invocation);
    const record = this.store.getExecution(id);
    owns(actor, record.authority);
    return record;
  }
  async executions(id: string, limit: number, invocation?: InvocationContext) {
    const actor = await this.policy.actor(invocation);
    if (actor.kind !== "operator") owns(actor, this.store.getSchedule(id, true).authority);
    return this.store.executions(id, limit);
  }
  async run(id: string, invocation?: InvocationContext) {
    const actor = await this.policy.actor(invocation);
    const record = this.store.getRun(id);
    owns(actor, record.createdBy);
    return record;
  }
  async runs(limit: number, invocation?: InvocationContext) {
    const actor = await this.policy.actor(invocation);
    return this.store.runs(limit, actor.kind === "bot" ? actor : undefined);
  }

  start() {
    // This schedule is the sole automatic source trigger. It admits no work
    // unless an operator separately registered and enabled Brain Sources.
    this.store.ensureSystemSchedule(systemBrainId, {
      action: { type: "api", package: "brain", operation: "sources_sync", input: { due: true } },
      firstAt: new Date(Date.now() + 10_000).toISOString(), everyMs: 300_000, enabled: true,
    });
    this.timer = setInterval(() => void this.tick().catch((error) => console.error("proc schedule tick:", error)), 1_000);
    void this.tick().catch((error) => console.error("proc schedule tick:", error));
  }

  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.sweep ??= this.sweepOnce().finally(() => { this.sweep = undefined; });
  }
  private async sweepOnce() {
    if (Date.now() - this.lastPrune > 86_400_000) { this.store.prune(); this.lastPrune = Date.now(); }
    // Bounded sweep. The next tick continues if more schedules are due.
    for (const schedule of this.store.pending(Math.max(0, 16 - this.calls.size))) {
      if (this.closing) break;
      let instance: string | null;
      try {
        instance = await this.policy.resolve(schedule.authority!);
        await this.validate(schedule.action, schedule.authority!);
        if (schedule.authority!.kind === "bot") instance = await this.policy.resolve(schedule.authority!, instance ?? undefined);
      } catch (error) {
        if (this.closing) break;
        const blocked = error instanceof AuthorityBlocked ? error : new AuthorityBlocked("authorization_unavailable");
        if (this.store.block(schedule, blocked.reason, blocked.retryMs)) this.onSchedulesChanged?.(schedule.id);
        continue;
      }
      if (this.closing) break;
      // Async authorization may race an edit or removal: admission fences the captured revision and due time.
      const due = this.store.admit(schedule);
      if (!due) continue;
      this.onSchedulesChanged?.(due.scheduleId);
      const controller = new AbortController();
      const task = (async () => {
        if (this.closing) {
          this.store.finishExecution(due.executionId, "refused", null, "service_closing_before_dispatch");
          this.onSchedulesChanged?.(due.scheduleId);
          return;
        }
        if (due.action.type === "process") {
          try {
            const run = this.startRun(due.action.process, due.executionId, undefined, due.authority);
            this.store.attachProcess(due.executionId, run.id);
          } catch (error) {
            this.store.finishExecution(due.executionId, "failed", null,
              error instanceof Error && error.message === "proc_capacity" ? "proc_capacity" : "process_admission_failed");
            this.onSchedulesChanged?.(due.scheduleId);
          }
          return;
        }
        try {
          const invocation: InvocationContext = { transport: "proc", scheduleId: due.scheduleId, executionId: due.executionId,
            authority: due.authority, botId: due.authority.kind === "bot" ? due.authority.botId : null,
            instance, threadId: due.authority.kind === "bot" ? due.authority.threadId : null, sessionId: null };
          const result = await this.call(due.action.package, due.action.operation, due.action.input, forwardTimeout(due.action.package, due.action.operation), controller.signal, invocation);
          this.store.finishExecution(due.executionId, "completed", result);
        } catch {
          // A socket error or lost reply cannot prove the operation did not run.
          this.store.finishExecution(due.executionId, "unknown", null, "call_outcome_unknown");
        }
        this.onSchedulesChanged?.(due.scheduleId);
        this.notify();
      })().catch(() => {
        this.store.finishExecution(due.executionId, "unknown", null, "dispatch_interrupted");
        this.onSchedulesChanged?.(due.scheduleId);
      }).finally(() => this.calls.delete(entry));
      const entry = { controller, task };
      this.calls.add(entry);
    }
  }

  startRun(spec: ProcessSpec, executionId: string | null = null, requestId?: string, actor: Authority = operator) {
    if (this.closing) throw new Error("proc_closing");
    if (this.active.size >= 16 && (!requestId || !this.store.hasRun(requestId))) throw new Error("proc_capacity");
    const admitted = this.store.startRun(spec, executionId, requestId, actor);
    if (!admitted.created) return admitted.record;
    const record = admitted.record;
    let guard: ChildProcess;
    try { guard = fork(runnerPath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: this.env,
      execArgv: [], detached: process.platform !== "win32" }); }
    catch { this.store.finishRun(record.id, "failed", null, null, "guardian_failed"); throw new Error("guardian_failed"); }
    let completed = false;
    let resolveTask: () => void = () => {};
    const task = new Promise<void>((resolve) => { resolveTask = resolve; });
    const finish = (state: "exited" | "failed" | "cancelled" | "unknown", code: number | null, signal: string | null, error: string | null) => {
      if (completed) return;
      completed = true;
      if (state === "unknown") {
        const pid = this.store.getRun(record.id).pid;
        if (pid !== null) killGroup(pid);
      }
      this.store.finishRun(record.id, state, code, signal, error);
      if (executionId) this.store.finishExecution(executionId,
        state === "exited" && code === 0 ? "completed" : state === "unknown" ? "unknown" : "failed",
        { exitCode: code, signal }, error, record.id);
      this.onRunsChanged?.(record.id);
      if (executionId) this.onSchedulesChanged?.(this.store.getExecution(executionId).scheduleId);
      this.notify();
      this.active.delete(record.id);
      if (guard.connected) guard.disconnect();
      resolveTask();
    };
    guard.on("message", (message: { kind?: string; pid?: number; stream?: "stdout" | "stderr"; text?: string; partial?: boolean; error?: string;
      code?: number | null; signal?: string | null; timedOut?: boolean; cancelled?: boolean }) => {
      if (completed) return;
      if (message.kind === "started" && message.pid) { this.store.running(record.id, message.pid); this.onRunsChanged?.(record.id); this.notify(); }
      if (message.kind === "line" && message.stream && typeof message.text === "string") {
        if (this.store.line(record.id, message.stream, message.text, !!message.partial)) {
          this.onOutputChanged?.(record.id); // One invalidation per line. Read by cursor to survive coalescing.
          this.notify();
        }
      }
      if (message.kind === "truncated") { this.store.markTruncated(record.id); this.onOutputChanged?.(record.id); this.notify(); }
      if (message.kind === "error") finish("failed", null, null, message.error === "group_cleanup_failed" ? message.error : "spawn_failed");
      if (message.kind === "exit") finish(message.timedOut ? "failed" : message.cancelled ? "cancelled" : "exited",
        message.code ?? null, message.signal ?? null, message.timedOut ? "process_timeout" : null);
    });
    guard.once("error", () => finish("failed", null, null, "guardian_failed"));
    guard.once("exit", () => finish("unknown", null, null, "guardian_lost"));
    this.active.set(record.id, { guard, task, cancel: () => { if (guard.connected) guard.send({ kind: "cancel" }); } });
    guard.send({ kind: "start", spec }, (error) => { if (error) finish("failed", null, null, "guardian_unavailable"); });
    this.onRunsChanged?.(record.id);
    return record;
  }

  cancel(id: string) {
    const run = this.store.getRun(id);
    this.active.get(id)?.cancel();
    return run;
  }
  read(id: string, after: number, limit: number) { return this.store.read(id, after, limit); }
  async wait(id: string, after: number, limit: number, waitMs: number) {
    const first = this.read(id, after, limit);
    if (first.done || first.lines.length || first.run.outputTruncated) return first;
    return new Promise<ReturnType<ProcService["read"]>>((resolve) => {
      const complete = () => { clearTimeout(timer); this.listeners.delete(complete); resolve(this.read(id, after, limit)); };
      const timer = setTimeout(complete, waitMs);
      this.listeners.add(complete);
      // Close the registration race with the preceding read.
      const current = this.read(id, after, limit);
      if (current.done || current.lines.length || current.run.outputTruncated) complete();
    });
  }
  async join(id: string, waitMs: number) {
    const first = this.store.getRun(id);
    if (["exited", "failed", "cancelled", "unknown"].includes(first.state)) return { run: first, timedOut: false };
    return new Promise<{ run: typeof first; timedOut: boolean }>((resolve) => {
      const complete = () => {
        const run = this.store.getRun(id);
        if (!["exited", "failed", "cancelled", "unknown"].includes(run.state) && !this.closing) return;
        clearTimeout(timer); this.listeners.delete(complete); resolve({ run, timedOut: this.closing && !["exited", "failed", "cancelled", "unknown"].includes(run.state) });
      };
      const timer = setTimeout(() => {
        this.listeners.delete(complete); resolve({ run: this.store.getRun(id), timedOut: true });
      }, waitMs);
      this.listeners.add(complete);
      complete();
    });
  }
  private notify() { for (const listener of [...this.listeners]) listener(); }
  prepareClose() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    this.notify();
    for (const call of this.calls) call.controller.abort();
    for (const run of this.active.values()) run.cancel();
  }
  async close() {
    this.prepareClose();
    await this.sweep;
    await Promise.allSettled([...this.calls].map((call) => call.task).concat([...this.active.values()].map((run) => run.task)));
    this.store.close();
  }
}

export function newId() { return randomUUID(); }
export function scheduleFromInput(input: ScheduleSpec): ScheduleSpec { return { ...input, firstAt: new Date(input.firstAt).toISOString() }; }
