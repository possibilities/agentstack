import { appServerSocket } from "./threads.js";

export type InputCandidate = {
  threadId: string;
  inputId: string;
  origin: "client" | "realtime";
  text: string;
};

export type InputDecision =
  | { type: "pass" }
  | { type: "replace"; text: string }
  | { type: "intercept"; operationId: string };

export type InputResolution = {
  threadId: string;
  inputId: string;
  disposition: { type: "passed" | "replaced" | "rejected" } | { type: "intercepted"; operationId: string };
  effect: null | { status: "succeeded" | "failed" | "unknown"; summary: string };
};

export type InputRecord = InputResolution & {
  originalText: string;
  selectedText: string | null;
};

export type InputMiddlewareConnection = {
  read(inputId: string): Promise<InputRecord | null>;
  complete(inputId: string, operationId: string, receipt: NonNullable<InputRecord["effect"]>): Promise<InputRecord>;
  detach(): Promise<void>;
  close(): void;
};

/** Connects a trusted host-side policy owner to Codex's existing app-server WebSocket.
 * The handler only chooses a disposition. Run external effects after the resolved
 * notification (or read-after-reconnect), never inside `decide`.
 */
export async function attachInputMiddleware(
  url: string,
  threadId: string,
  decide: (candidate: InputCandidate) => InputDecision | Promise<InputDecision>,
  onResolved: (resolution: InputResolution) => void,
  options: { timeoutMs?: number; onUnavailable?: "pass" | "reject" } = {},
): Promise<InputMiddlewareConnection> {
  const ws = appServerSocket(url);
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const send = (message: object) => ws.send(JSON.stringify(message));
  const call = (method: string, params: object): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed || ws.readyState !== ws.OPEN) return reject(new Error("app-server connection closed"));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 5_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  const fail = () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("app-server connection closed"));
    }
    pending.clear();
  };
  ws.on("message", (raw) => {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    try { message = JSON.parse(String(raw)) as typeof message; } catch { return; }
    if (typeof message.id === "number" && typeof message.method !== "string") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`app-server rejected request ${message.id}: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "thread/input/resolved") {
      const resolution = message.params as InputResolution;
      if (resolution?.threadId === threadId) {
        try { onResolved(resolution); } catch { /* Caller policy cannot break the RPC reader. */ }
      }
      return;
    }
    if (message.method !== "thread/input/requestDisposition" || typeof message.id !== "number") return;
    const candidate = message.params as InputCandidate;
    if (candidate?.threadId !== threadId || typeof candidate.inputId !== "string" || typeof candidate.text !== "string") {
      send({ id: message.id, error: { code: -32602, message: "invalid candidate" } });
      return;
    }
    const requestId = message.id;
    void Promise.resolve().then(() => decide(candidate)).then(
      (decision) => { if (ws.readyState === ws.OPEN) send({ id: requestId, result: decision }); },
      () => { if (ws.readyState === ws.OPEN) send({ id: requestId, error: { code: -32603, message: "middleware decision failed" } }); },
    );
  });
  ws.on("close", fail);
  ws.on("error", fail);
  let ownerId: string;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("app-server handshake timed out")), 2_000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    await call("initialize", { clientInfo: { name: "agentstack-codex-middleware", version: "0.0.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const attached = await call("thread/input/middleware/attach", {
      threadId,
      timeoutMs: options.timeoutMs ?? 500,
      onUnavailable: options.onUnavailable ?? "pass",
    }) as { threadId: string; ownerId: string };
    if (attached.threadId !== threadId || typeof attached.ownerId !== "string") {
      throw new Error("app-server returned an invalid middleware owner");
    }
    ownerId = attached.ownerId;
  } catch (error) {
    ws.close();
    throw error;
  }
  return {
    async read(inputId) {
      const result = await call("thread/input/read", { threadId, inputId }) as { record: InputRecord | null };
      return result.record;
    },
    async complete(inputId, operationId, receipt) {
      const result = await call("thread/input/complete", { threadId, inputId, operationId, receipt }) as { record: InputRecord };
      return result.record;
    },
    async detach() {
      await call("thread/input/middleware/detach", { threadId, ownerId });
      ws.close();
    },
    close() { ws.close(); },
  };
}
