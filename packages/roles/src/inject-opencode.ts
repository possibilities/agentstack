import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Start one host, owning its stdin lifetime. Never discover or restart the shared service. */
export async function startOpenCodeHost(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ url: string; closed: Promise<void>; stop(): Promise<void> }> {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./inject-opencode-host.js", import.meta.url))], {
    env, stdio: ["pipe", "pipe", "inherit"],
  });
  let running = true;
  const closed = new Promise<void>((resolve) => { child.once("close", () => { running = false; resolve(); }); });
  const errors: Error[] = [];
  child.on("error", (error) => errors.push(error));
  const abort = () => child.stdin.end();
  signal.addEventListener("abort", abort, { once: true });
  const stop = async () => {
    signal.removeEventListener("abort", abort);
    if (!running) return;
    child.stdin.end();
    const term = setTimeout(() => child.kill("SIGTERM"), 10_000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { await closed; } finally { clearTimeout(term); clearTimeout(kill); }
  };
  let dispose = () => {};
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("OpenCode Role host did not become ready within 30 seconds")), 30_000);
      const exit = () => reject(errors[0] ?? new Error("OpenCode Role host exited before readiness"));
      child.once("close", exit);
      child.once("error", reject);
      let buffer = "";
      const data = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 1_000_000) { reject(new Error("OpenCode Role host readiness output exceeded its limit")); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let url: URL;
          try {
            const value = JSON.parse(line) as { url?: string };
            if (typeof value.url !== "string") continue;
            url = new URL(value.url);
          } catch { continue; }
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
            reject(new Error("OpenCode Role host returned an invalid listener address")); return;
          }
          resolve(url.origin);
        }
      };
      child.stdout.on("data", data);
      dispose = () => { clearTimeout(timeout); child.off("close", exit); child.off("error", reject); child.stdout.off("data", data); child.stdout.resume(); };
    });
    return { url, closed, stop };
  } catch (error) { await stop(); throw error; }
  finally { dispose(); }
}
