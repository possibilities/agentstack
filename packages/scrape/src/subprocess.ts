import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ProcessResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}
export interface ProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export function findExecutable(name: string): string | null {
  if (name.includes("/")) return executable(name) ? name : null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function decodeWithin(bytes: Buffer, limit: number): string {
  let end = Math.min(limit, bytes.length);
  while (end >= Math.max(0, bytes.length - 3)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

/** Explicit argv, bounded output, process-group teardown, and cancellation. */
export async function runProcess(argv: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (!argv.length) throw new Error("empty subprocess argv");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const limit = options.maxOutputBytes ?? 4_000_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("invalid subprocess timeout");
  if (!Number.isInteger(limit) || limit < 0) throw new Error("invalid subprocess output limit");
  const cancelled = (): ProcessResult => ({ argv: [...argv], exitCode: 130, stdout: "", stderr: "operation cancelled", timedOut: false, truncated: false });
  if (options.signal?.aborted) return cancelled();
  const executablePath = findExecutable(argv[0]!);
  if (!executablePath) throw new Error(`${argv[0]} not found on PATH`);
  const child = spawn(executablePath, argv.slice(1), {
    detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env },
  });
  const buffers: [Buffer[], Buffer[]] = [[], []];
  const lengths = [0, 0];
  let cause: "timeout" | "cancelled" | "overflow" | null = null;
  let error: Error | null = null;
  let resolve!: (code: number) => void;
  const exited = new Promise<number>((done) => { resolve = done; });
  child.once("error", (failure) => { error = failure; resolve(1); });
  child.once("close", (code) => resolve(code ?? 1));
  let settle!: () => void;
  const stopped = new Promise<void>((done) => { settle = done; });
  const stop = (reason: typeof cause) => {
    if (cause !== null) return;
    cause = reason;
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
    child.stdout?.destroy();
    child.stderr?.destroy();
    settle();
  };
  const capture = (index: 0 | 1) => (chunk: Buffer) => {
    if (cause) return;
    const remaining = limit - lengths[index]!;
    if (remaining > 0) {
      const selected = chunk.subarray(0, remaining);
      buffers[index].push(selected);
      lengths[index] += selected.length;
    }
    if (chunk.length > remaining) stop("overflow");
  };
  child.stdout?.on("data", capture(0));
  child.stderr?.on("data", capture(1));
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.stdin);
  const onAbort = () => stop("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  try {
    const code = await Promise.race([exited, stopped.then(async () => {
      // A descendant can retain the pipe after the group is killed. Never wait on it forever.
      return Promise.race([exited, new Promise<number>((done) => setTimeout(() => {
        child.unref(); done(1);
      }, 100))]);
    })]);
    if (error) throw error;
    return {
      argv: [...argv], exitCode: cause === "cancelled" ? 130 : cause === "timeout" ? 124 : code,
      stdout: decodeWithin(Buffer.concat(buffers[0]), limit),
      stderr: cause === "cancelled" ? "operation cancelled" : decodeWithin(Buffer.concat(buffers[1]), limit),
      timedOut: cause === "timeout", truncated: cause === "overflow",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
