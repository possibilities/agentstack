import { z } from "zod";
import type { CompletionWatch, InvocationContext } from "./operation.js";
import { OperationRejected } from "./execute.js";
import { socketCall } from "./socket.js";
import { socketPath } from "./workspace.js";

export const completionWatchSchema = z.strictObject({ topic: z.string().min(1), readOperation: z.string().min(1), idArgument: z.string().min(1), terminalField: z.string().min(1), defaultWhen: z.array(z.string().min(1)), retainFields: z.array(z.string().min(1)).optional(),
  defaultOnForBot: z.boolean().optional(),
  readArguments: z.record(z.string().min(1), z.union([z.strictObject({ input: z.string().min(1) }), z.strictObject({ invocation: z.enum(["botId", "threadId"]) })])).optional(),
  scope: z.strictObject({ input: z.string().min(1), prefix: z.string().max(64).optional() }).optional(),
  updateField: z.string().min(1).optional(), initialValueField: z.string().min(1).optional(),
});

/** A native refusal proves that no input was admitted; lost responses do not. */
export class McpDeliveryRejected extends Error {}

export const completionReceipt = z.strictObject({
  id: z.uuid(),
  state: z.enum(["pending", "error", "observed", "delivered", "unknown", "cancelled"]),
  lastDeliveredAt: z.number().nullable().describe("Codex admission acknowledgement, not proof of consumption."),
  lastError: z.string().nullable(),
  lastDeliveryKind: z.enum(["update", "terminal"]).nullable().default(null).describe("Kind of the most recent attempted native admission, including an unknown attempt."),
});
export type CompletionReceipt = z.infer<typeof completionReceipt>;

export function wantsCompletion(watch: CompletionWatch, input: Record<string, unknown>, invocation?: InvocationContext): boolean {
  if (input.subscribe !== undefined && typeof input.subscribe !== "boolean") throw new Error("subscribe must be a boolean");
  if (input.subscribe === false) return false;
  if (input.subscribe === true) return true;
  return invocation?.transport === "mcp" && !!invocation.botId && (watch.defaultOnForBot === true || watch.defaultWhen.some(field => {
    const value = input[field];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
  }));
}

/** A domain calls this after its awaited preparation, immediately before its
 * synchronous admission. Refusal here proves no domain mutation occurred. */
export async function requireCompletionCoordination(env: NodeJS.ProcessEnv, pkg: string, operation: string,
  watch: CompletionWatch, input: Record<string, unknown>, invocation?: InvocationContext): Promise<void> {
  if (!wantsCompletion(watch, input, invocation)) return;
  try {
    const recordId = input[watch.idArgument];
    if (!(invocation?.transport === "mcp" && !invocation.workerId && invocation.botId && invocation.instance && invocation.threadId && invocation.completionWatchId && typeof recordId === "string"))
      throw new Error("subscribe requires owner-coordinated Bot MCP delivery to a verified sanctioned Chat; nothing was sent");
    await socketCall(socketPath("serve", env), "tools/call", { name: "serve_completion_check", arguments: {
      id: invocation.completionWatchId, package: pkg, operation, recordId, caller: invocation,
    } }, { timeoutMs: 5_000 });
  } catch (error) { throw new OperationRejected(error instanceof Error ? error.message : String(error), { cause: error }); }
}

export function resolveCompletionRead(watch: CompletionWatch, input: Record<string, unknown>, invocation: InvocationContext) {
  const identifier = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value)) throw new Error("completion bindings must be bounded identifiers");
    return value;
  };
  const readArguments = watch.readArguments ? Object.fromEntries(Object.entries(watch.readArguments).map(([key, source]) =>
    [key, identifier("input" in source ? input[source.input] : invocation[source.invocation])])) : { [watch.idArgument]: identifier(input[watch.idArgument]) };
  const scope = watch.scope ? `${watch.scope.prefix ?? ""}${identifier(input[watch.scope.input])}` : null;
  return { readArguments, scope };
}
