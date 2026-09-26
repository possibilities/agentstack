#!/usr/bin/env node
import { spawn } from "node:child_process";

// Next does not react to its owner's IPC disconnect. Keep a small owner-aware
// parent between it and the owner so an interrupted shutdown cannot orphan the
// UI listener (or any of Next's descendants).
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Guarded server command is required");

const server = spawn(command, args, { stdio: "inherit", env: process.env,
  detached: process.platform !== "win32" });
let stopping: Promise<void> | null = null;
let ownerStopping = false;
let childExitCode = 1;

function alive(): boolean {
  if (server.pid === undefined) return false;
  if (process.platform === "win32") return server.exitCode === null && server.signalCode === null;
  try { process.kill(-server.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function signalGroup(signal: NodeJS.Signals): void {
  if (server.pid === undefined) return;
  try {
    if (process.platform === "win32") server.kill(signal);
    else process.kill(-server.pid, signal);
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

function ownerGone(): void {
  ownerStopping = true;
  void stop().then(() => process.exit(alive() ? 1 : 0), (error) => {
    console.error(error);
    process.exit(1);
  });
}
process.on("SIGINT", ownerGone);
process.on("SIGTERM", ownerGone);
process.on("disconnect", ownerGone);
server.once("error", (error) => { console.error(error); childExitCode = 1; void stop().then(() => process.exit(1)); });
server.once("exit", (code) => {
  childExitCode = code ?? 1;
  void stop().then(() => process.exit(alive() ? 1 : ownerStopping ? 0 : childExitCode));
});
