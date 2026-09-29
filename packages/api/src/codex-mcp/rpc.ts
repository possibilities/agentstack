import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
export type Elicitation = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };

/** One private app-server process. A lost call is never automatically replayed. */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private next = 0;
  private buffer = "";
  private stopped = false;
  private exited = false;
  private exit: Promise<void>;
  private closing?: Promise<void>;
  onElicitation?: Elicitation;

  constructor(binary: string, home: string, env: NodeJS.ProcessEnv) {
    // Never inherit an agent's selected inference credentials or project config.
    const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: home };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_MANAGED_CONFIG_PATH"]) delete childEnv[key];
    this.child = spawn(binary, ["app-server"], { cwd: home, env: childEnv, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.child.once("exit", () => { this.kill("SIGKILL"); this.exited = true; });
    this.exit = new Promise((resolve) => this.child.once("close", () => {
      this.kill("SIGKILL"); this.exited = true;
      this.fail(new Error("Codex tools runtime exited; reconnect this MCP server")); resolve();
    }));
    this.child.stderr.resume(); // Diagnostics may contain personal configuration; never expose them to callers.
    this.child.stdin.on("error", () => { void this.close(); });
    this.child.on("error", () => { this.fail(new Error("Could not start the Codex tools runtime")); void this.close(); });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) { this.fail(new Error("Codex tool output exceeded 32 MiB")); void this.close(); return; }
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(new Error("Invalid Codex app-server response")); void this.close(); return; }
      }
    });
  }

  notify(method: string, params: object = {}) { this.send({ method, params }); }
  request(method: string, params: object, signal?: AbortSignal, timeoutMs = 120_000): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("Codex tools session is closed; reconnect the MCP server"));
    if (signal?.aborted) return Promise.reject(new Error("Codex tool request cancelled"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => { this.fail(new Error("Codex tool request cancelled; execution may already have occurred")); void this.close(); };
      const timer = setTimeout(() => { this.fail(new Error(`Codex ${method} timed out; execution may already have occurred. Do not blindly retry.`)); void this.close(); }, timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      this.send({ id, method, params });
    });
  }

  private send(value: object) {
    if (!this.stopped) this.child.stdin.write(JSON.stringify(value) + "\n", (error) => { if (error) void this.close(); });
  }
  private receive(message: unknown) {
    if (!record(message)) throw new Error("invalid message");
    if (message.method && message.id !== undefined) {
      if (message.method === "mcpServer/elicitation/request") {
        const callback = this.onElicitation;
        void (async () => {
          let result: Record<string, unknown> = { action: "cancel" };
          try { if (callback && record(message.params)) result = await callback(message.params); } catch { /* cancelled */ }
          if (!["accept", "decline", "cancel"].includes(String(result.action))) result = { action: "cancel" };
          this.send({ id: message.id, result });
        })();
      } else this.send({ id: message.id, error: { code: -32601, message: "Stack Codex tools bridge does not handle this request" } });
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); pending.cleanup();
    // Do not relay arbitrary upstream diagnostics (config paths, credentials) to an agent.
    if (message.error) pending.reject(new Error(`Codex tools request failed (${message.error.code ?? "unknown"}); check that the requested plugin is enabled in the selected desktop installation`));
    else pending.resolve(message.result);
  }
  private fail(error: Error) {
    this.stopped = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
  }
  private kill(signal: NodeJS.Signals) {
    if (this.exited) return;
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.fail(new Error("Codex tools session closed"));
      this.child.stdin.end(); this.kill("SIGTERM");
      const timer = setTimeout(() => this.kill("SIGKILL"), 3_000); timer.unref();
      await this.exit; clearTimeout(timer); this.kill("SIGKILL");
    })();
    return this.closing;
  }
}
