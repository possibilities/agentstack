import { socketCall, socketPath, type InvocationContext } from "@stack/api";
import { z } from "zod";
import { workContext, type WorkContext } from "./schema.js";

/** A turn captures semantic context in the same transaction as admission, never as a second HUD write. */
export async function resolveWorkContext(env: NodeJS.ProcessEnv, workItemId: string | null | undefined,
  invocation?: InvocationContext, previous: WorkContext | null = null): Promise<WorkContext | null> {
  if (workItemId === null) return null;
  const continuation = workItemId === undefined && previous !== null;
  if (workItemId === undefined && !continuation && !invocation?.botId) return null;
  const value = await socketCall(socketPath("hud", env), "tools/call", {
    name: "work_context_resolve", arguments: { ...(workItemId !== undefined || continuation ? { workItemId: workItemId ?? previous!.workItemId } : {}) },
    ...(invocation ? { invocation } : {}),
  }, { timeoutMs: 20_000 }) as { context: unknown };
  const context = workContext.nullable().parse(value.context);
  return context && continuation ? { ...context, source: "continuation" } : context;
}

export const workAdmission = z.strictObject({
  sequence: z.number().int().positive(), workerId: z.uuid(), turnId: z.uuid(), context: workContext,
  botId: z.string(), threadId: z.string(), accountId: z.uuid(), provider: z.enum(["codex", "grok", "devin", "claude"]),
  model: z.string().nullable(), effort: z.string().nullable(),
  workerPhase: z.enum(["preparing", "idle", "running", "awaiting_input", "cancelling", "closed", "failed", "needs_recovery"]),
  turnPhase: z.enum(["queued", "running", "awaiting_input", "cancelling", "completed", "cancelled", "failed", "unknown"]),
  current: z.boolean(), createdAt: z.number().int(), updatedAt: z.number().int(),
});
export const workAdmissionPage = z.strictObject({ entries: z.array(workAdmission), nextCursor: z.number().int().positive().nullable() });
export type WorkAdmission = z.infer<typeof workAdmission>;
