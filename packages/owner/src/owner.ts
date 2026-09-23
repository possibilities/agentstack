import { spawn, type ChildProcess } from "node:child_process";

export type OwnedChild = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ChildStatus = {
  name: string;
  pid: number | null;
  running: boolean;
};

export type RunningOwner = {
  close(): Promise<void>;
  children(): ChildStatus[];
};

const haltMs = 2_000;

export function startOwner(children: OwnedChild[], env: NodeJS.ProcessEnv = process.env, onChange?: () => void): RunningOwner {
  const running = children.map((child) => ({
    child,
    failed: false,
    proc: spawn(child.command, child.args, {
      env: { ...env, ...child.env },
      stdio: "inherit",
      detached: false,
    }),
  }));

  const alive = (item: (typeof running)[number]) =>
    !item.failed && item.proc.exitCode === null && item.proc.signalCode === null;
  const statuses = () =>
    running.filter(alive).map(({ child, proc }) => ({ name: child.name, pid: proc.pid ?? null, running: true }));
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
      item.failed = true;
      console.error(`${item.child.name}: ${error.message}`);
      notify();
    });
    item.proc.once("exit", notify);
  }

  return {
    close() {
      return halt(running.map((item) => item.proc));
    },
    children() {
      return statuses();
    },
  };
}

function halt(procs: ChildProcess[]): Promise<void> {
  return new Promise((resolve) => {
    const live = procs.filter((proc) => proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null);
    if (live.length === 0) {
      resolve();
      return;
    }
    let pending = live.length;
    const finish = () => {
      pending -= 1;
      if (pending === 0) resolve();
    };
    const force = setTimeout(() => {
      for (const proc of live) {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
    }, haltMs);
    force.unref();
    for (const proc of live) {
      proc.once("exit", () => {
        if (live.every((item) => item.exitCode !== null || item.signalCode !== null)) clearTimeout(force);
        finish();
      });
      proc.kill("SIGTERM");
    }
  });
}
