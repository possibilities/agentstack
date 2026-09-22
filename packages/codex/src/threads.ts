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
  const threads: unknown[] = [];
  const ws = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  let notify: () => void = () => undefined;
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      messages.push(JSON.parse(event.data) as Record<string, unknown>);
    } catch {
      return;
    }
    notify();
  });
  try {
    await once(ws, "open", 3_000);
    await rpc(ws, messages, () => notify, 1, "initialize", {
      clientInfo: { name: "agentstack", version: "0.0.0" },
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    let cursor: string | null = null;
    let page = 0;
    do {
      const result = (await rpc(ws, messages, () => notify, page + 2, "thread/list", {
        limit: 100,
        archived: false,
        cursor,
      })) as { data?: unknown; nextCursor?: unknown };
      if (Array.isArray(result.data)) threads.push(...result.data);
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      page += 1;
    } while (cursor && page < 5);
    return activeThreads(threads);
  } catch {
    return [];
  } finally {
    ws.close();
  }
}

function rpc(
  ws: WebSocket,
  messages: Array<Record<string, unknown>>,
  setNotify: (wake: () => void) => void,
  id: number,
  method: string,
  params: unknown,
): Promise<unknown> {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      setNotify(() => undefined);
      reject(new Error(`${method} timed out`));
    }, 3_000);
    const check = () => {
      const message = messages.find((item) => item.id === id);
      if (!message) return;
      clearTimeout(timer);
      setNotify(() => undefined);
      if (message.error) reject(new Error(method));
      else resolve(message.result);
    };
    setNotify(() => {
      check();
    });
    check();
  });
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
