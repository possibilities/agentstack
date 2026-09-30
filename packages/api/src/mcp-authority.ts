import { botInstance, parseBotMcpIdentity, parseWorkerMcpIdentity } from "./bot-mcp-identity.js";
import { socketCall } from "./socket.js";
import { socketPath } from "./workspace.js";
import type { InvocationContext } from "./operation.js";

export type McpIdentity = { botId: string; instance: string } | { workerId: string; instance: string } | null;

/** Signed launch payload, independent of the MCP transport carrying it. */
export function parseMcpBinding(binding: string, env: NodeJS.ProcessEnv): Exclude<McpIdentity, null> {
  if (!binding || binding.includes("#")) throw new Error("missing or invalid managed MCP binding");
  const url = new URL(`stack://mcp?${binding}`);
  const identity = url.searchParams.has("worker") || url.searchParams.has("runtime")
    ? parseWorkerMcpIdentity(url, env) : parseBotMcpIdentity(url, env);
  if (!identity) throw new Error("missing managed MCP binding");
  return identity;
}

export async function verifyMcpIdentity(identity: Exclude<McpIdentity, null>, env: NodeJS.ProcessEnv): Promise<void> {
  if ("botId" in identity) {
    const listed = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 2_000 }) as {
      bots: Array<{ id: string; url: string | null; state: string; recoveryIssue: string | null }>;
    };
    const bot = listed.bots.find(entry => entry.id === identity.botId);
    if (!bot || bot.state !== "running" || bot.recoveryIssue || !bot.url || botInstance(bot.url) !== identity.instance)
      throw new Error("bot MCP connection is no longer bound to a running instance");
  } else {
    const [status, runtimes] = await Promise.all([
      socketCall(socketPath("worker", env), "tools/call", { name: "worker_status", arguments: { id: identity.workerId } }, { timeoutMs: 2_000 }) as Promise<{
        worker: { accountId: string; phase: string; runtimeInstance: string | null };
      }>,
      socketCall(socketPath("worker", env), "tools/call", { name: "worker_runtime_list", arguments: {} }, { timeoutMs: 2_000 }) as Promise<{
        runtimes: Array<{ id: string; state: string; instance: string | null }>;
      }>,
    ]);
    if (status.worker.runtimeInstance !== identity.instance || !["preparing", "idle", "running", "awaiting_input", "cancelling"].includes(status.worker.phase) ||
        !runtimes.runtimes.some(runtime => runtime.id === status.worker.accountId && runtime.state === "running" && runtime.instance === identity.instance))
      throw new Error("worker MCP connection is no longer bound to a live Worker session");
  }
}

export function mcpInvocation(identity: McpIdentity, meta: unknown): InvocationContext {
  const ids = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
  const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
  const bot = identity && "botId" in identity ? identity : null;
  const worker = identity && "workerId" in identity ? identity : null;
  const threadId = identifier(ids.threadId);
  if (bot && !threadId) throw new Error("bot MCP tool call is missing Codex threadId metadata");
  return { transport: "mcp", botId: bot?.botId ?? null, instance: bot?.instance ?? null, threadId,
    sessionId: identifier(ids.sessionId), workerId: worker?.workerId ?? null, workerInstance: worker?.instance ?? null };
}
