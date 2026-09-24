import { spawn, type ChildProcess } from "node:child_process";

export type OwnedChild = {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type ChildStatus = {
  name: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
};

export type RunningOwner = {
  stop(names: readonly string[]): Promise<void>;
  close(): Promise<void>;
  children(): ChildStatus[];
};

const haltMs = 65_000;

export function startOwner(children: OwnedChild[], env: NodeJS.ProcessEnv = process.env, onChange?: () => void, shutdownStages: readonly (readonly string[])[] = []): RunningOwner {
  const running = children.map((child) => ({
    child,
    error: null as string | null,
    proc: spawn(child.command, child.args, {
      cwd: child.cwd,
      env: { ...env, ...child.env },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      detached: process.platform !== "win32",
    }),
  }));

  const alive = (item: (typeof running)[number]) =>
    item.error === null && item.proc.pid !== undefined && item.proc.exitCode === null && item.proc.signalCode === null;
  const statuses = () =>
    running.map((item) => ({
      name: item.child.name,
      pid: alive(item) ? item.proc.pid ?? null : null,
      running: alive(item),
      exitCode: item.proc.exitCode,
      signal: item.proc.signalCode,
      error: item.error,
    }));
  let last = JSON.stringify(statuses());
  const notify = () => {
    const next = JSON.stringify(statuses());
    if (next === last) return;
    last = next;
    onChange?.();
  };

  for (const item of running) {
    item.proc.once("spawn", notify);
    item.proc.once("error", (error) => {
      item.error = error.message;
      console.error(`${item.child.name}: ${error.message}`);
      notify();
    });
    item.proc.once("exit", () => {
      // A child that exits must not leave its descendants behind.
      try {
        signalGroup(item.proc, "SIGTERM");
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
      notify();
    });
  }

  return {
    stop(names) {
      return halt(running.filter((item) => names.includes(item.child.name)).map((item) => item.proc));
    },
    async close() {
      const staged = new Set(shutdownStages.flat());
      let failure: unknown;
      for (const stage of [...shutdownStages, running.filter((item) => !staged.has(item.child.name)).map((item) => item.child.name)]) {
        try {
          await halt(running.filter((item) => stage.includes(item.child.name)).map((item) => item.proc));
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    },
    children() {
      return statuses();
    },
  };
}

async function halt(procs: ChildProcess[]): Promise<void> {
  for (const proc of procs) signalGroup(proc, "SIGTERM");
  const deadline = Date.now() + haltMs;
  while (Date.now() < deadline && procs.some(groupAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const proc of procs.filter(groupAlive)) signalGroup(proc, "SIGKILL");
  const forceDeadline = Date.now() + 1_000;
  while (Date.now() < forceDeadline && procs.some(groupAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (procs.some(groupAlive)) throw new Error("owned process group did not exit");
}

function groupAlive(proc: ChildProcess): boolean {
  if (proc.pid === undefined) return false;
  if (process.platform === "win32") return proc.exitCode === null && proc.signalCode === null;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && !(code === "EPERM" && (proc.exitCode !== null || proc.signalCode !== null));
  }
}

function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  try {
    if (process.platform === "win32") proc.kill(signal);
    else process.kill(-proc.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && !(code === "EPERM" && (proc.exitCode !== null || proc.signalCode !== null))) throw error;
  }
}
