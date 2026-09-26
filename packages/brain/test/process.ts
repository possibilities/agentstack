import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { constants } from "node:os";

interface Options {
  cmd: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
}
export function spawnSync(options: Options) {
  const child = nodeSpawnSync(options.cmd[0]!, options.cmd.slice(1), {
    cwd: options.cwd, env: options.env, stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"], maxBuffer: 20_000_000,
  });
  if (child.error) throw child.error;
  return { exitCode: child.status, stdout: child.stdout ?? Buffer.alloc(0), stderr: child.stderr ?? Buffer.alloc(0) };
}
export function spawn(options: Options) {
  const child = nodeSpawn(options.cmd[0]!, options.cmd.slice(1), {
    cwd: options.cwd, env: options.env, stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"],
  });
  return {
    pid: child.pid,
    stdout: child.stdout ? Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array> : null,
    stderr: child.stderr ? Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array> : null,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    exited: new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    }),
  };
}
