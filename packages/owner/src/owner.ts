import { spawn, type ChildProcess } from "node:child_process";

export type OwnedChild = {
  name: string;
  command: string;
  args: string[];
};

export type RunningOwner = {
  close(): Promise<void>;
};

const haltMs = 2_000;

export function startOwner(children: OwnedChild[], env: NodeJS.ProcessEnv = process.env): RunningOwner {
  const running = children.map((child) => ({
    child,
    proc: spawn(child.command, child.args, {
      env,
      stdio: "inherit",
      detached: false,
    }),
  }));

  for (const { child, proc } of running) {
    proc.once("error", (error) => {
      console.error(`${child.name}: ${error.message}`);
    });
  }

  return {
    close() {
      return halt(running.map((item) => item.proc));
    },
  };
}

function halt(procs: ChildProcess[]): Promise<void> {
  return new Promise((resolve) => {
    const live = procs.filter((proc) => proc.exitCode === null && proc.signalCode === null);
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
