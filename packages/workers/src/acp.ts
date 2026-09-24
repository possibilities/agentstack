import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
export type AcpRequest = { id: number; method: string; params: unknown };

/** One owned ACP v1 stdio process. Unknown agent-to-client requests are refused, never implicitly approved. */
export class AcpProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private inbound = new Map<number, { method: string; sessionId: string | null }>();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  readonly exited: Promise<void>;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (request: AcpRequest) => boolean;
  get pid(): number | null { return this.closed ? null : this.child.pid ?? null; }

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    let stderrBytes = 0;
    this.child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64_000) this.child.stderr.destroy();
    });
    this.exited = new Promise((resolve) => {
      this.child.once("error", () => { this.fail("ACP process could not start"); resolve(); });
      this.child.once("close", () => { this.fail("ACP process exited"); resolve(); });
    });
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { if (pending.timer) clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
    this.inbound.clear();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) { this.fail("ACP response exceeded the limit"); this.child.kill("SIGTERM"); return; }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let frame: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try { frame = JSON.parse(line) as typeof frame; } catch { this.fail("ACP returned invalid JSON"); this.child.kill("SIGTERM"); return; }
      if (frame.method) {
        if (typeof frame.id === "number") {
          try {
            if (this.onRequest?.({ id: frame.id, method: frame.method, params: frame.params })) this.inbound.set(frame.id, {
              method: frame.method, sessionId: record(frame.params) && typeof frame.params.sessionId === "string" ? frame.params.sessionId : null,
            });
            else this.reply(frame.id, { error: { code: -32601, message: "ACP client method unavailable" } });
          } catch { this.reply(frame.id, { error: { code: -32603, message: "ACP client request failed" } }); }
        } else this.onNotification?.(frame.method, frame.params);
        continue;
      }
      if (typeof frame.id !== "number") continue;
      const pending = this.pending.get(frame.id);
      if (!pending) continue;
      this.pending.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(`ACP request failed: ${frame.error.message ?? "unknown error"}`));
      else pending.resolve(frame.result);
    }
  }

  request(method: string, params: object, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("ACP process is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; outcome is unknown`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (error && this.pending.delete(id)) { if (timer) clearTimeout(timer); reject(new Error("ACP transport closed")); }
      });
    });
  }

  notify(method: string, params: object): void {
    if (this.closed) throw new Error("ACP process is closed");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private reply(id: number, value: { result?: unknown; error?: { code: number; message: string } }): void {
    if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...value }) + "\n");
  }

  respondRequest(id: number, result: unknown): void {
    if (!this.inbound.delete(id)) throw new Error("ACP request is no longer pending");
    this.reply(id, { result });
  }

  cancelPermissions(sessionId?: string): void {
    for (const [id, request] of this.inbound) if (request.method === "session/request_permission" && (!sessionId || request.sessionId === sessionId)) {
      this.inbound.delete(id);
      this.reply(id, { result: { outcome: { outcome: "cancelled" } } });
    }
  }

  async initialize(): Promise<Record<string, unknown>> {
    const value = await this.request("initialize", { protocolVersion: 1, clientInfo: { name: "agentstack", version: "0.0.0" },
      clientCapabilities: { session: { configOptions: { boolean: {} } } } });
    if (!record(value) || value.protocolVersion !== 1) throw new Error("ACP v1 is unavailable");
    return value;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.cancelPermissions();
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
    this.child.kill("SIGTERM");
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
