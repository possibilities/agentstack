#!/usr/bin/env node
import { spawn } from "node:child_process";

// Next does not react to its parent process's IPC disconnect. Keep a small parent-aware
// parent between it and the server so an interrupted shutdown cannot orphan the
// UI listener (or any of Next's descendants).
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Guarded server command is required");

const nextServer = spawn(command, args, { stdio: "inherit", env: process.env,
  detached: process.platform !== "win32" });
let stopping: Promise<void> | null = null;
let parentStopping = false;
let childExitCode = 1;

function alive(): boolean {
  if (nextServer.pid === undefined) return false;
  if (process.platform === "win32") return nextServer.exitCode === null && nextServer.signalCode === null;
  try { process.kill(-nextServer.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function signalGroup(signal: NodeJS.Signals): void {
  if (nextServer.pid === undefined) return;
  try {
    if (process.platform === "win32") nextServer.kill(signal);
    else process.kill(-nextServer.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function stop(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    signalGroup("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (alive()) signalGroup("SIGKILL");
    const forced = Date.now() + 1_000;
    while (alive() && Date.now() < forced) await new Promise((resolve) => setTimeout(resolve, 25));
    if (alive()) console.error("Guarded server process group did not exit");
  })();
  return stopping;
}

function parentGone(): void {
  parentStopping = true;
  void stop().then(() => process.exit(alive() ? 1 : 0), (error) => {
    console.error(error);
    process.exit(1);
  });
}
process.on("SIGINT", parentGone);
process.on("SIGTERM", parentGone);
process.on("disconnect", parentGone);
nextServer.once("error", (error) => { console.error(error); childExitCode = 1; void stop().then(() => process.exit(1)); });
nextServer.once("exit", (code) => {
  childExitCode = code ?? 1;
  void stop().then(() => process.exit(alive() ? 1 : parentStopping ? 0 : childExitCode));
});
