import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ChildId,
  ChildStatus,
  Readiness,
  SanitizedFailure,
} from "@agentstack/contracts";
import { log, sanitizeReason } from "./log.js";
import { runJsonLineProbe, type ReadinessProbe } from "./probe.js";

export interface ChildSpec {
  id: ChildId;
  sourceVersion: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  probe: ReadinessProbe;
}

export interface RestartPolicy {
  initialBackoffMs: number;
  maxBackoffMs: number;
  maxFailures: number;
  failureWindowMs: number;
  stableResetMs: number;
  stopGraceMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  initialBackoffMs: 250,
  maxBackoffMs: 10_000,
  maxFailures: 5,
  failureWindowMs: 60_000,
  stableResetMs: 60_000,
  stopGraceMs: 10_000,
};

interface Termination {
  promise: Promise<void>;
  settle(): void;
}

function terminationLatch(child: ChildProcessWithoutNullStreams): Termination {
  let settled = false;
  let resolveTermination: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });
  const settle = (): void => {
    if (settled) return;
    settled = true;
    resolveTermination();
  };
  child.once("exit", settle);
  child.once("close", settle);
  return { promise, settle };
}

async function boundedWait(
  promise: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    promise.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), milliseconds);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return !timedOut;
}

export class ManagedChild {
  readonly #spec: ChildSpec;
  readonly #policy: RestartPolicy;
  readonly #onChange: () => void;
  #process: ChildProcessWithoutNullStreams | null = null;
  #termination: Termination | null = null;
  #generation: string | null = null;
  #desired: "running" | "stopped" = "stopped";
  #state: ChildStatus["observedState"] = "stopped";
  #readiness: Readiness = "unknown";
  #startedAt: string | null = null;
  #restartCount = 0;
  #launchAttempts = 0;
  #failures: number[] = [];
  #backoffUntil: string | null = null;
  #lastFailure: SanitizedFailure | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #stableTimer: NodeJS.Timeout | null = null;

  constructor(
    spec: ChildSpec,
    onChange: () => void,
    policy: RestartPolicy = DEFAULT_RESTART_POLICY,
  ) {
    this.#spec = spec;
    this.#onChange = onChange;
    this.#policy = policy;
  }

  status(): ChildStatus {
    return {
      id: this.#spec.id,
      sourceVersion: this.#spec.sourceVersion,
      generation: this.#generation,
      pid: this.#process?.pid ?? null,
      desiredState: this.#desired,
      observedState: this.#state,
      readiness: this.#readiness,
      startedAt: this.#startedAt,
      uptimeMs: this.#startedAt
        ? Math.max(0, Date.now() - Date.parse(this.#startedAt))
        : null,
      restartCount: this.#restartCount,
      backoffUntil: this.#backoffUntil,
      lastFailure: this.#lastFailure,
    };
  }

  async start(resetFailures = false): Promise<void> {
    this.#desired = "running";
    if (resetFailures) this.#failures = [];
    if (this.#process || this.#state === "starting" || this.#restartTimer)
      return;
    await this.#spawn();
  }

  async restart(): Promise<void> {
    await this.stop(false);
    if (this.#desired === "running") await this.start(true);
  }

  async stop(setDesired = true): Promise<void> {
    if (setDesired) this.#desired = "stopped";
    this.#clearTimers();
    const child = this.#process;
    const termination = this.#termination;
    const generation = this.#generation;
    if (!child || !termination) {
      this.#settleStopped(generation);
      return;
    }

    this.#state = "stopping";
    this.#onChange();
    child.stdin.end();
    if (child.pid !== undefined) child.kill("SIGTERM");
    const graceful = await boundedWait(
      termination.promise,
      this.#policy.stopGraceMs,
    );
    if (!graceful && child.pid !== undefined) {
      child.kill("SIGKILL");
      await boundedWait(
        termination.promise,
        Math.min(1_000, Math.max(100, this.#policy.stopGraceMs)),
      );
    }
    termination.settle();
    this.#settleStopped(generation);
  }

  async #spawn(): Promise<void> {
    const generation = randomUUID();
    if (this.#launchAttempts > 0) this.#restartCount += 1;
    this.#launchAttempts += 1;
    this.#generation = generation;
    this.#startedAt = null;
    this.#state = "starting";
    this.#readiness = "unknown";
    this.#backoffUntil = null;
    this.#onChange();
    log({
      level: "info",
      component: this.#spec.id,
      event: "child_starting",
      generation,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#spec.command, this.#spec.args, {
        cwd: this.#spec.cwd,
        env: this.#spec.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });
    } catch (error) {
      this.#settleSpawnFailure(generation, error);
      return;
    }

    const termination = terminationLatch(child);
    this.#process = child;
    this.#termination = termination;
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(stderrBytes + chunk.length, 1024 * 1024);
    });
    child.once("exit", (code, signal) => {
      if (this.#generation !== generation) return;
      const intentionalStop = this.#state === "stopping";
      this.#process = null;
      this.#termination = null;
      this.#startedAt = null;
      log({
        level: intentionalStop || this.#desired === "stopped" ? "info" : "warn",
        component: this.#spec.id,
        event: "child_exited",
        generation,
        code,
        signal,
        stderrBytes,
      });
      if (intentionalStop) return;
      if (this.#desired === "stopped") {
        this.#settleStopped(generation);
        return;
      }
      if (
        this.#readiness === "auth-required" ||
        this.#readiness === "incompatible"
      ) {
        this.#state = "failed";
        this.#onChange();
        return;
      }
      this.#recordFailure(
        "unexpected_exit",
        `exit=${String(code)} signal=${String(signal)}`,
      );
      this.#scheduleRestart(generation);
    });

    const launch = await new Promise<{ error: Error | null }>((resolve) => {
      let launched = false;
      child.once("spawn", () => {
        launched = true;
        resolve({ error: null });
      });
      child.once("error", (error) => {
        if (!launched) resolve({ error });
        else if (this.#generation === generation)
          this.#recordFailure("process_error", error, false);
      });
    });
    if (launch.error) {
      this.#settleSpawnFailure(generation, launch.error);
      return;
    }
    if (this.#launchInvalid(generation, child)) return;

    this.#startedAt = new Date().toISOString();
    const result = await runJsonLineProbe(
      child.stdout,
      child.stdin,
      this.#spec.probe,
      generation,
    );
    if (this.#launchInvalid(generation, child)) return;
    this.#readiness = result.readiness;
    this.#state = "running";
    if (result.failure)
      this.#recordFailure(result.failure.code, result.failure.message, false);
    this.#onChange();
    log({
      level: result.readiness === "ready" ? "info" : "warn",
      component: this.#spec.id,
      event: "readiness",
      generation,
      readiness: result.readiness,
    });
    if (result.readiness === "ready") {
      this.#stableTimer = setTimeout(() => {
        if (this.#generation === generation && this.#readiness === "ready")
          this.#failures = [];
      }, this.#policy.stableResetMs);
      this.#stableTimer.unref();
    }
  }

  #settleSpawnFailure(generation: string, error: unknown): void {
    if (this.#generation !== generation) return;
    this.#process = null;
    this.#termination?.settle();
    this.#termination = null;
    this.#startedAt = null;
    if (this.#desired === "stopped" || this.#state === "stopping") {
      this.#settleStopped(generation);
      return;
    }
    this.#recordFailure("spawn_failed", error);
    this.#scheduleRestart(generation);
  }

  #launchInvalid(
    generation: string,
    child: ChildProcessWithoutNullStreams,
  ): boolean {
    return (
      this.#generation !== generation ||
      this.#process !== child ||
      this.#state === "stopping" ||
      this.#desired === "stopped"
    );
  }

  #settleStopped(generation: string | null): void {
    if (generation !== null && this.#generation !== generation) return;
    this.#process = null;
    this.#termination = null;
    this.#state = "stopped";
    this.#readiness = "unknown";
    this.#startedAt = null;
    this.#backoffUntil = null;
    this.#onChange();
  }

  #clearTimers(): void {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (this.#stableTimer) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
  }

  #recordFailure(code: string, reason: unknown, count = true): void {
    this.#lastFailure = {
      code,
      message: sanitizeReason(reason),
      at: new Date().toISOString(),
    };
    if (count) this.#failures.push(Date.now());
    this.#onChange();
  }

  #scheduleRestart(generation: string): void {
    if (this.#generation !== generation || this.#desired !== "running") return;
    const now = Date.now();
    this.#failures = this.#failures.filter(
      (at) => now - at <= this.#policy.failureWindowMs,
    );
    if (this.#failures.length >= this.#policy.maxFailures) {
      this.#state = "failed";
      this.#readiness = "unavailable";
      this.#backoffUntil = null;
      this.#onChange();
      return;
    }
    const delay = Math.min(
      this.#policy.initialBackoffMs *
        2 ** Math.max(0, this.#failures.length - 1),
      this.#policy.maxBackoffMs,
    );
    this.#state = "backoff";
    this.#readiness = "unavailable";
    this.#backoffUntil = new Date(now + delay).toISOString();
    this.#onChange();
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (this.#generation === generation && this.#desired === "running")
        void this.#spawn();
    }, delay);
    this.#restartTimer.unref();
  }
}
