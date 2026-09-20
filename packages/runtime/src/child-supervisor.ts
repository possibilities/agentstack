import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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

export class ManagedChild {
  readonly #spec: ChildSpec;
  readonly #policy: RestartPolicy;
  readonly #onChange: () => void;
  #process: ChildProcessWithoutNullStreams | null = null;
  #generation: string | null = null;
  #desired: "running" | "stopped" = "stopped";
  #state: ChildStatus["observedState"] = "stopped";
  #readiness: Readiness = "unknown";
  #startedAt: string | null = null;
  #restartCount = 0;
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
    this.#restartCount += 1;
    await this.stop(false);
    await this.start(true);
  }

  async stop(setDesired = true): Promise<void> {
    if (setDesired) this.#desired = "stopped";
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (this.#stableTimer) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
    const child = this.#process;
    if (!child) {
      this.#state = "stopped";
      this.#readiness = "unknown";
      this.#startedAt = null;
      this.#onChange();
      return;
    }
    const generation = this.#generation;
    this.#state = "stopping";
    this.#onChange();
    child.stdin.end();
    child.kill("SIGTERM");
    const grace = setTimeout(
      () => child.kill("SIGKILL"),
      this.#policy.stopGraceMs,
    );
    grace.unref();
    await once(child, "exit").catch(() => undefined);
    clearTimeout(grace);
    if (this.#generation === generation) {
      this.#process = null;
      this.#state = "stopped";
      this.#readiness = "unknown";
      this.#startedAt = null;
      this.#onChange();
    }
  }

  async #spawn(): Promise<void> {
    const generation = randomUUID();
    this.#generation = generation;
    this.#startedAt = new Date().toISOString();
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
      this.#recordFailure("spawn_failed", error);
      this.#scheduleRestart(generation);
      return;
    }
    this.#process = child;
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(stderrBytes + chunk.length, 1024 * 1024);
    });
    child.once("error", (error) => {
      if (this.#generation !== generation) return;
      this.#recordFailure("process_error", error);
    });
    child.once("exit", (code, signal) => {
      if (this.#generation !== generation) return;
      const intentionalStop = this.#state === "stopping";
      this.#process = null;
      log({
        level: this.#desired === "stopped" ? "info" : "warn",
        component: this.#spec.id,
        event: "child_exited",
        generation,
        code,
        signal,
        stderrBytes,
      });
      if (intentionalStop) return;
      if (this.#desired === "stopped") {
        this.#state = "stopped";
        this.#readiness = "unknown";
        this.#onChange();
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

    const result = await runJsonLineProbe(
      child.stdout,
      child.stdin,
      this.#spec.probe,
      generation,
    );
    if (this.#generation !== generation || this.#process !== child) return;
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
