export type ActiveThread = {
  id: string;
  label: string;
  model: string | null;
  activity: "working" | "waiting";
};

export function activeThreads(records: unknown[]): ActiveThread[] {
  const threads: ActiveThread[] = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const thread = record as {
      id?: unknown;
      preview?: unknown;
      model?: unknown;
      status?: { type?: unknown; activeFlags?: unknown };
    };
    if (typeof thread.id !== "string" || thread.status?.type !== "active") continue;
    const flags = Array.isArray(thread.status.activeFlags) ? thread.status.activeFlags : [];
    const waiting = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput");
    threads.push({
      id: thread.id,
      label: typeof thread.preview === "string" && thread.preview.length > 0 ? thread.preview : thread.id,
      model: typeof thread.model === "string" ? thread.model : null,
      activity: waiting ? "waiting" : "working",
    });
  }
  return threads;
}

export async function listActiveThreads(url: string): Promise<ActiveThread[]> {
  const ws = new WebSocket(url);
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
    const records = await Promise.all(
      ids.map(async (threadId) => {
        const result = (await call("thread/read", { threadId })) as { thread?: unknown };
        return result.thread;
      }),
    );
    return activeThreads(records);
  } catch {
    return [];
  } finally {
    ws.close();
  }
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
