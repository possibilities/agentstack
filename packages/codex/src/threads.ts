import { connect } from "node:net";
import WebSocket, { type RawData } from "ws";

export type ActiveThread = {
  id: string;
  label: string;
  model: string | null;
  activity: "working" | "waiting" | "idle";
  parentThreadId: string | null;
  children?: ActiveThread[];
};

export function activeThreads(records: unknown[]): ActiveThread[] {
  const threads: ActiveThread[] = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const thread = record as {
      id?: unknown;
      preview?: unknown;
      model?: unknown;
      parentThreadId?: unknown;
      status?: { type?: unknown; activeFlags?: unknown };
    };
    if (typeof thread.id !== "string") continue;
    const status = thread.status?.type;
    if (status !== "active" && status !== "idle") continue;
    const flags = Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : [];
    const waiting = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput");
    threads.push({
      id: thread.id,
      label: typeof thread.preview === "string" && thread.preview.length > 0 ? thread.preview : thread.id,
      model: typeof thread.model === "string" ? thread.model : null,
      activity: status === "idle" ? "idle" : waiting ? "waiting" : "working",
      parentThreadId: typeof thread.parentThreadId === "string" ? thread.parentThreadId : null,
    });
  }
  return threads;
}

export function threadTree(threads: ActiveThread[]): ActiveThread[] {
  const nodes = new Map(threads.map((thread) => [thread.id, { ...thread, children: [] as ActiveThread[] }]));
  const parentIds = new Map(threads.map((thread) => [thread.id, thread.parentThreadId]));
  const cycleRoots = new Set<string>();
  for (const thread of threads) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let id: string | null | undefined = thread.id;
    while (id && nodes.has(id) && !seen.has(id)) {
      seen.set(id, path.length);
      path.push(id);
      id = parentIds.get(id);
    }
    if (id && seen.has(id)) cycleRoots.add([...path.slice(seen.get(id))].sort()[0]);
  }
  const roots: ActiveThread[] = [];
  for (const thread of threads) {
    const node = nodes.get(thread.id);
    if (!node) continue;
    const parent = thread.parentThreadId && !cycleRoots.has(thread.id) ? nodes.get(thread.parentThreadId) : undefined;
    if (parent && parent !== node) parent.children?.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Join the server's durable main thread, creating it only on its first launch. */
export async function bindMainThread(url: string, cwd: string, threadId: string | null, beforeStart?: () => Promise<void>): Promise<string> {
  const ws = appServerSocket(url);
  ws.on("error", () => undefined); // The close event rejects any in-flight request.
  let nextId = 1;
  const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), 15_000);
    const onMessage = (raw: RawData) => {
      let frame: { id?: unknown; result?: unknown; error?: { message?: string } };
      try { frame = JSON.parse(String(raw)) as typeof frame; } catch { return; }
      if (frame.id !== id) return;
      finish(frame.error ? new Error(`${method}: ${frame.error.message ?? "failed"}`) : null, frame.result);
    };
    const onClose = () => finish(new Error(`${method}: connection closed`));
    const finish = (error: Error | null, result?: unknown) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      if (error) reject(error);
      else resolve(result);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await once(ws, "open", 5_000);
    await call("initialize", { clientInfo: { name: "agentstack", version: "0.0.0" } });
    ws.send(JSON.stringify({ method: "initialized" }));
    if (!threadId) await beforeStart?.();
    const method = threadId ? "thread/resume" : "thread/start";
    const response = await call(method, threadId ? { threadId, cwd } : { cwd }) as { thread?: { id?: unknown } };
    const id = response?.thread?.id;
    if (typeof id !== "string" || !id || (threadId && id !== threadId)) {
      throw new Error(`${method} returned an unexpected thread id`);
    }
    return id;
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else ws.terminate();
  }
}

export async function listActiveThreads(url: string): Promise<ActiveThread[]> {
  const ws = appServerSocket(url);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(event.data) as { id?: unknown; result?: unknown; error?: unknown };
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const waiter = pending.get(id);
    if (!waiter || Number.isNaN(id)) return;
    pending.delete(id);
    if (message.error) waiter.reject(new Error("rpc failed"));
    else waiter.resolve(message.result);
  });
  const call = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 1_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  try {
    await once(ws, "open", 1_000);
    await call("initialize", { clientInfo: { name: "agentstack", version: "0.0.0" } });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    const loaded = (await call("thread/loaded/list", {})) as { data?: unknown };
    const ids = Array.isArray(loaded.data) ? loaded.data.filter((id): id is string => typeof id === "string") : [];
    const results = await Promise.allSettled(
      ids.map(async (threadId) => {
        const result = (await call("thread/read", { threadId })) as { thread?: unknown };
        return result.thread;
      }),
    );
    const records = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (results.some((result) => result.status === "rejected")) {
      console.error(`thread/read failed for ${results.filter((result) => result.status === "rejected").length} loaded threads`);
    }
    return threadTree(activeThreads(records));
  } catch {
    return [];
  } finally {
    ws.close();
  }
}

const threadChangeMethods = new Set([
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "thread/name/updated",
  "thread/archived",
  "thread/deleted",
  "turn/started",
  "turn/completed",
]);

export function watchThreadEvents(url: string, onChange: () => void): () => void {
  let stopped = false;
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (stopped) return;
    const current = appServerSocket(url);
    ws = current;
    current.on("open", () => current.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "agentstack", version: "0.0.0" } } })));
    current.on("message", (raw) => {
      let message: { id?: unknown; result?: unknown; method?: unknown };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      if (message.id === 1 && message.result) {
        current.send(JSON.stringify({ method: "initialized" }));
        if (!stopped) onChange();
      } else if (typeof message.method === "string" && threadChangeMethods.has(message.method)) {
        if (!stopped) onChange();
      }
    });
    current.on("error", () => current.terminate());
    current.on("close", () => {
      if (stopped || ws !== current) return;
      retry = setTimeout(open, 1_000);
      retry.unref();
    });
  };
  open();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    ws?.terminate();
  };
}

export function appServerSocket(url: string): WebSocket {
  const path = url.startsWith("unix://") ? url.slice("unix://".length) : null;
  return path
    ? new WebSocket("ws://localhost/", { createConnection: () => connect(path), handshakeTimeout: 1_000 })
    : new WebSocket(url, { handshakeTimeout: 1_000 });
}

function once(ws: WebSocket, type: "open", timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket timed out")), timeoutMs);
    ws.addEventListener(type, () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket failed"));
    });
  });
}
