import { socketCall, socketPath } from "@agentstack/api";
import { z } from "zod";
import type { DomainStatus } from "./schema.js";

export type DomainLabel = {
  pid: number; component: "bots" | "workers"; botId: string | null;
  accountId: string | null; runtimeInstance: string | null; provider: string;
};
export type DomainReading = { labels: DomainLabel[]; statuses: DomainStatus[] };
export type DomainReader = (attached: boolean, signal: AbortSignal) => Promise<DomainReading>;
const identifier = z.string().min(1).max(160);
const botList = z.object({ bots: z.array(z.object({
  id: identifier, pid: z.number().int().positive().nullable(), state: z.string(),
  runningAccount: identifier.nullable(), recoveryIssue: z.string().nullable(),
})).max(2048) });
const runtimeList = z.object({ runtimes: z.array(z.object({
  id: identifier, pid: z.number().int().positive().nullable(), state: z.string(),
  instance: identifier.nullable(), provider: z.enum(["codex", "grok", "devin"]),
})).max(2048) });

export function createDomainReader(env: NodeJS.ProcessEnv): DomainReader {
  const lastGood = new Map<string, string>();
  return async (attached, signal) => {
    const results = await Promise.all((["bots", "workers"] as const).map(async (source) => {
      const status: DomainStatus = { source, capturedAt: lastGood.get(source) ?? null, error: null, state: "not_attached", unmatched: 0 };
      if (!attached) return { status, labels: [] as DomainLabel[] };
      try {
        const raw = await socketCall(socketPath(source, env), "tools/call", {
          name: source === "bots" ? "bot_list" : "worker_runtime_list", arguments: {},
        }, { timeoutMs: 1_000, signal });
        let labels: DomainLabel[];
        if (source === "bots") {
          const running = botList.parse(raw).bots.filter((bot) => bot.state === "running");
          labels = running.flatMap((bot) => bot.pid && !bot.recoveryIssue
            ? [{ pid: bot.pid, component: source, botId: bot.id, accountId: bot.runningAccount, runtimeInstance: null, provider: "codex" }] : []);
          status.unmatched = running.length - labels.length;
        } else {
          const running = runtimeList.parse(raw).runtimes.filter((runtime) => runtime.state === "running");
          labels = running.flatMap((runtime) => runtime.pid && runtime.instance
            ? [{ pid: runtime.pid, component: source, botId: null, accountId: runtime.id, runtimeInstance: runtime.instance, provider: runtime.provider }] : []);
          status.unmatched = running.length - labels.length;
        }
        status.capturedAt = new Date().toISOString();
        status.state = "current";
        lastGood.set(source, status.capturedAt);
        return { status, labels };
      } catch (error) {
        status.state = status.capturedAt ? "stale" : "unavailable";
        status.error = error instanceof z.ZodError ? "invalid_source" : "source_unavailable";
        return { status, labels: [] as DomainLabel[] };
      }
    }));
    return { labels: results.flatMap((result) => result.labels), statuses: results.map((result) => result.status) };
  };
}
