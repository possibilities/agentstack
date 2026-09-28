import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { forwardTimeout, socketCall, socketPath } from "@agentstack/api";
import type { Action, ProcessSpec, ScheduleSpec } from "./schema.js";
import { ProcStore } from "./store.js";

type Call = (pkg: string, operation: string, input: unknown, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>;
const runnerPath = fileURLToPath(new URL("./runner.js", import.meta.url));
const systemBrainId = "00000000-0000-4000-8000-000000000001";
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
  private checking = false;
  private closing = false;
  constructor(readonly store: ProcStore, private readonly env: NodeJS.ProcessEnv,
    private readonly call: Call = async (pkg, operation, input, timeoutMs, signal) =>
      socketCall(socketPath(pkg, env), "tools/call", { name: operation, arguments: input }, { timeoutMs, signal })) {}

  async validate(action: Action) {
    if (action.type !== "api") return;
    if (action.package === "proc") throw new Error("recursive_schedule_refused");
    const catalog = await socketCall(socketPath(action.package, this.env), "tools/list", {}, { timeoutMs: 5_000 }) as {
      tools?: Array<{ name: string }> };
    if (!catalog.tools?.some((item) => item.name === action.operation)) throw new Error("target_operation_unavailable");
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

  async tick() {
    if (this.checking || this.closing) return;
    this.checking = true;
    try {
      if (Date.now() - this.lastPrune > 86_400_000) { this.store.prune(); this.lastPrune = Date.now(); }
      // Bounded sweep. The next tick continues if more schedules are due.
      for (const due of this.store.due(Math.max(0, 16 - this.calls.size))) {
        this.onSchedulesChanged?.(due.scheduleId);
        const controller = new AbortController();
        const task = (async () => {
          if (due.action.type === "process") {
            try {
              const run = this.startRun(due.action.process, due.executionId);
              this.store.attachProcess(due.executionId, run.id);
            } catch (error) {
              this.store.finishExecution(due.executionId, "failed", null,
                error instanceof Error && error.message === "proc_capacity" ? "proc_capacity" : "process_admission_failed");
              this.onSchedulesChanged?.(due.scheduleId);
            }
            return;
          }
          try {
            await this.validate(due.action);
          } catch {
            this.store.finishExecution(due.executionId, "failed", null, "target_unavailable");
            this.onSchedulesChanged?.(due.scheduleId);
            return;
          }
          try {
            const result = await this.call(due.action.package, due.action.operation, due.action.input, forwardTimeout(due.action.package, due.action.operation), controller.signal);
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
    } finally { this.checking = false; }
  }

  startRun(spec: ProcessSpec, executionId: string | null = null, requestId?: string) {
    if (this.closing) throw new Error("proc_closing");
    if (this.active.size >= 16 && (!requestId || !this.store.hasRun(requestId))) throw new Error("proc_capacity");
    const admitted = this.store.startRun(spec, executionId, requestId);
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
    await Promise.allSettled([...this.calls].map((call) => call.task).concat([...this.active.values()].map((run) => run.task)));
    this.store.close();
  }
}

export function newId() { return randomUUID(); }
export function scheduleFromInput(input: ScheduleSpec): ScheduleSpec { return { ...input, firstAt: new Date(input.firstAt).toISOString() }; }
