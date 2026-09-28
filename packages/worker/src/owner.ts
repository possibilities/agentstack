import { botInstance, socketCall, socketPath, type InvocationContext } from "@agentstack/api";
import { listActiveThreads, type ActiveThread } from "@agentstack/bots";
import type { WorkerRecord } from "./ledger.js";

export type WorkerOwner = { botId: string; threadId: string };
// Bot IDs must begin with an alphanumeric character; this cannot alias a Bot named by a caller.
export const LOCAL_OPERATOR_ID = "_local_operator";

function contains(threads: ActiveThread[], id: string): boolean {
  return threads.some((thread) => thread.id === id || contains(thread.children ?? [], id));
}

export async function workerOwner(invocation: InvocationContext | undefined, env: NodeJS.ProcessEnv): Promise<WorkerOwner> {
  if (!invocation) return { botId: LOCAL_OPERATOR_ID, threadId: LOCAL_OPERATOR_ID };
  if (!invocation.botId) throw new Error("worker lifecycle operations require a Bot-bound MCP call or the local socket");
  if (!invocation.instance || !invocation.threadId) throw new Error("worker operations require a verified Bot thread");
  const listed = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 2_000 }) as {
    bots: Array<{ id: string; state: string; url: string | null; mainThreadId: string | null; recoveryIssue: string | null }>;
  };
  const bot = listed.bots.find((entry) => entry.id === invocation.botId);
  if (!bot || bot.state !== "running" || bot.recoveryIssue || !bot.url || botInstance(bot.url) !== invocation.instance || !bot.mainThreadId)
    throw new Error("Bot launch is not verified and running with a main thread");
  if (!contains(await listActiveThreads(bot.url, bot.mainThreadId), invocation.threadId))
    throw new Error("worker caller is outside the Bot's sanctioned main-thread lineage");
  return { botId: bot.id, threadId: invocation.threadId };
}

export function ownsWorker(owner: WorkerOwner, worker: WorkerRecord): void {
  if (owner.botId !== LOCAL_OPERATOR_ID && owner.botId !== worker.botId) throw new Error("worker belongs to another Bot");
}
