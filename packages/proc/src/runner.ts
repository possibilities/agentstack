#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ProcessSpec } from "./schema.js";

// This small IPC guardian outlives a crashed Proc context just long enough to
// terminate the process group. No user command or environment is placed in argv.
let child: ChildProcess | undefined;
let stopping = false;
let timedOut = false;
let cancelled = false;
let killTimer: ReturnType<typeof setTimeout> | undefined;
function signal(signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function groupAlive() {
  if (!child?.pid) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function reapGroup() {
  signal("SIGTERM");
  for (let n = 0; n < 40 && groupAlive(); n++) await new Promise((resolve) => setTimeout(resolve, 25));
  if (groupAlive()) signal("SIGKILL");
  for (let n = 0; n < 40 && groupAlive(); n++) await new Promise((resolve) => setTimeout(resolve, 25));
  return !groupAlive();
}
function stop(reason: "timeout" | "cancel" | "disconnect") {
  if (stopping) return;
  stopping = true;
  timedOut = reason === "timeout";
  cancelled = reason !== "timeout";
  signal("SIGTERM");
  killTimer = setTimeout(() => signal("SIGKILL"), 2_000);
  killTimer.unref();
}

function lines(stream: "stdout" | "stderr", source: NodeJS.ReadableStream) {
  const decoder = new StringDecoder("utf8");
  let pending = "", sentBytes = 0;
  let capped = false;
  const emit = (text: string, partial: boolean) => {
    sentBytes += Buffer.byteLength(text);
    if (sentBytes > 2_000_000 || capped) {
      if (!capped) process.send?.({ kind: "truncated" });
      capped = true;
      return;
    }
    process.send?.({ kind: "line", stream, text, partial });
  };
  const consume = (chunk: string) => {
    pending += chunk;
    let at = pending.indexOf("\n");
    while (at !== -1) {
      const line = pending.slice(0, at).replace(/\r$/, "");
      for (let i = 0; i < line.length;) {
        let end = Math.min(i + 4096, line.length);
        if (end < line.length && line.charCodeAt(end - 1) >= 0xD800 && line.charCodeAt(end - 1) <= 0xDBFF) end--;
        emit(line.slice(i, end), end < line.length);
        i = end;
      }
      if (!line.length) emit("", false);
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
    }
    while (pending.length > 4096) {
      const end = pending.charCodeAt(4095) >= 0xD800 && pending.charCodeAt(4095) <= 0xDBFF ? 4095 : 4096;
      emit(pending.slice(0, end), true);
      pending = pending.slice(end);
    }
  };
  source.on("data", (chunk: Buffer) => consume(decoder.write(chunk)));
  source.on("end", () => { consume(decoder.end()); if (pending.length) emit(pending, true); });
}

process.once("message", (message: { kind?: string; spec?: ProcessSpec }) => {
  if (message?.kind !== "start" || !message.spec) { process.exitCode = 1; return; }
  const spec = message.spec;
  try {
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch { process.send?.({ kind: "error", code: "spawn_failed" }); return; }
  child.once("spawn", () => {
    process.send?.({ kind: "started", pid: child!.pid });
    lines("stdout", child!.stdout!);
    lines("stderr", child!.stderr!);
  });
  child.once("error", () => { process.send?.({ kind: "error", code: "spawn_failed" }); });
  child.once("close", (code, sig) => { void (async () => {
    clearTimeout(killTimer);
    // The root may exit before a background descendant. Drain the group before
    // claiming a terminal outcome; an uncooperative descendant is killed.
    if (!await reapGroup()) { process.send?.({ kind: "error", error: "group_cleanup_failed" }, () => process.exit(1)); return; }
    process.send?.({ kind: "exit", code, signal: sig, timedOut, cancelled }, () => process.exit(0));
  })(); });
  if (spec.timeoutMs !== null) setTimeout(() => stop("timeout"), spec.timeoutMs).unref();
});
process.on("message", (message: { kind?: string }) => { if (message?.kind === "cancel") stop("cancel"); });
process.on("disconnect", () => { stop("disconnect"); setTimeout(() => process.exit(1), 3_000).unref(); });
