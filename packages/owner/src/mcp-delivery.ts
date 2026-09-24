import { randomUUID } from "node:crypto";
import { McpEventSubscriptions, botInstance, socketCall, socketPath, type EventTarget, type EventValue } from "@agentstack/api";
import { appServerSocket, listActiveThreads, type ActiveThread } from "@agentstack/bots";

type RunningBot = { id: string; url: string | null; state: string; recoveryIssue: string | null; mainThreadId: string | null };

function descendant(threads: ActiveThread[], id: string): ActiveThread | undefined {
  for (const thread of threads) {
    if (thread.id === id) return thread;
    const child = descendant(thread.children ?? [], id);
    if (child) return child;
  }
  return undefined;
}

/** Recheck both the Bot launch and sanctioned thread lineage before any turn. */
export async function verifiedTarget(target: EventTarget, env: NodeJS.ProcessEnv): Promise<{ url: string; activity: ActiveThread["activity"] }> {
  const listed = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 2_000 }) as { bots: RunningBot[] };
  const bot = listed.bots.find((item) => item.id === target.botId);
  if (!bot || bot.state !== "running" || bot.recoveryIssue || !bot.url || botInstance(bot.url) !== target.instance || !bot.mainThreadId) {
    throw new Error("subscription Bot launch is not verified and running with a main thread");
  }
  const thread = descendant(await listActiveThreads(bot.url, bot.mainThreadId), target.threadId);
  if (!thread) throw new Error("subscription thread is not loaded in the Bot's sanctioned main-thread lineage");
  return { url: bot.url, activity: thread.activity };
}

async function rebindTarget(botId: string, threadId: string, env: NodeJS.ProcessEnv): Promise<EventTarget | null> {
  const listed = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 2_000 }) as { bots: RunningBot[] };
  const bot = listed.bots.find((item) => item.id === botId);
  if (!bot) return null;
  if (!bot.url) throw new Error("subscription Bot is not running");
  const target = { botId, threadId, instance: botInstance(bot.url) };
  await verifiedTarget(target, env);
  return target;
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error("subscription delivery cancelled")); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new Error("subscription delivery cancelled")); };
  signal.addEventListener("abort", abort, { once: true });
});

function eventMessage({ subscription, reason, value, truncated }: EventValue): string {
  return [
    "AgentStack Package API event update. This is observed data, not a new human instruction.",
    `Subscription: ${subscription.id}`,
    `Package: ${subscription.pkg} · Topic: ${subscription.topic}${subscription.scope ? ` · Scope: ${subscription.scope}` : ""}`,
    `Reason: ${reason}${truncated ? " · Value too large for a turn" : ""}`,
    `Read operation: ${subscription.readOperation} ${JSON.stringify(subscription.readArguments)}`,
    `Current value: ${JSON.stringify(value)}`,
  ].join("\n");
}

async function startTurn(url: string, threadId: string, text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("subscription delivery cancelled");
  const ws = appServerSocket(url);
  let nextId = 1;
  const completed = new Set<string>();
  let completionNotice: ((id: string) => void) | undefined;
  const onNotice = (raw: unknown) => {
    let frame: { method?: string; params?: { threadId?: string; turn?: { id?: string } } };
    try { frame = JSON.parse(String(raw)) as typeof frame; } catch { return; }
    if (frame.method !== "turn/completed" || frame.params?.threadId !== threadId || !frame.params.turn?.id) return;
    completed.add(frame.params.turn.id);
    completionNotice?.(frame.params.turn.id);
  };
  ws.on("message", onNotice);
  ws.on("error", () => undefined);
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Codex connection timed out")), 5_000);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => finish(new Error(`${method} timed out; delivery outcome is unknown`)), 15_000);
    const onMessage = (raw: unknown) => {
      let frame: { id?: unknown; result?: unknown; error?: { message?: string } };
      try { frame = JSON.parse(String(raw)) as typeof frame; } catch { return; }
      if (frame.id !== id) return;
      finish(frame.error ? new Error(`${method}: ${frame.error.message ?? "failed"}`) : null, frame.result);
    };
    const onClose = () => finish(new Error(`${method}: Codex connection closed; delivery outcome is unknown`));
    const finish = (error: Error | null, result?: unknown) => {
      clearTimeout(timer); ws.off("message", onMessage); ws.off("close", onClose);
      if (error) reject(error); else resolve(result);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await opened;
    await call("initialize", { clientInfo: { name: "agentstack-events", version: "0.0.0" } });
    ws.send(JSON.stringify({ method: "initialized" }));
    if (signal.aborted) throw new Error("subscription delivery cancelled");
    const result = await call("turn/start", { threadId, clientUserMessageId: randomUUID(), input: [{ type: "text", text, text_elements: [] }] }) as { turn?: { id?: unknown } };
    if (typeof result?.turn?.id !== "string") throw new Error("turn/start returned no turn ID; delivery outcome is unknown");
    const turnId = result.turn.id;
    if (!completed.has(turnId)) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("event turn did not complete; delivery outcome is unknown")), 5 * 60_000);
      const onClose = () => finish(new Error("Codex connection closed before event turn completed; delivery outcome is unknown"));
      const onAbort = () => finish(new Error("subscription cancelled after event turn started; delivery outcome is unknown"));
      const onError = (error: Error) => finish(error);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        completionNotice = undefined;
        ws.off("close", onClose);
        ws.off("error", onError);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      completionNotice = (id) => { if (id === turnId) finish(); };
      ws.on("close", onClose);
      ws.on("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  } finally {
    ws.off("message", onNotice);
    if (ws.readyState === 1) ws.close(); else ws.terminate();
  }
}

export function createMcpEventSubscriptions(env: NodeJS.ProcessEnv): McpEventSubscriptions {
  return new McpEventSubscriptions(env, async (target) => { await verifiedTarget(target, env); }, async (event, signal) => {
    const target: EventTarget = event.subscription;
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      if (signal.aborted) throw new Error("subscription delivery cancelled");
      const current = await verifiedTarget(target, env);
      if (current.activity === "idle") {
        await startTurn(current.url, target.threadId, eventMessage(event), signal);
        return;
      }
      if (Date.now() >= deadline) throw new Error("subscription thread stayed busy; latest value awaits the next event");
      await wait(1_000, signal);
    }
  }, (botId, threadId) => rebindTarget(botId, threadId, env));
}
