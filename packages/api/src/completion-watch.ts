import { z } from "zod";
import type { CompletionWatch, InvocationContext } from "./operation.js";

export const completionWatchSchema = z.strictObject({ topic: z.string().min(1), readOperation: z.string().min(1), idArgument: z.string().min(1), terminalField: z.string().min(1), defaultWhen: z.array(z.string().min(1)), retainFields: z.array(z.string().min(1)).optional() });

/** A native refusal proves that no input was admitted; lost responses do not. */
export class McpDeliveryRejected extends Error {}

export const completionReceipt = z.strictObject({
  id: z.uuid(),
  state: z.enum(["pending", "error", "observed", "delivered", "unknown", "cancelled"]),
  lastDeliveredAt: z.number().nullable().describe("Codex admission acknowledgement, not proof of consumption."),
  lastError: z.string().nullable(),
});
export type CompletionReceipt = z.infer<typeof completionReceipt>;

export function wantsCompletion(watch: CompletionWatch, input: Record<string, unknown>, invocation?: InvocationContext): boolean {
  if (input.subscribe !== undefined && typeof input.subscribe !== "boolean") throw new Error("subscribe must be a boolean");
  if (input.subscribe === false) return false;
  if (input.subscribe === true) return true;
  return invocation?.transport === "mcp" && !!invocation.botId && watch.defaultWhen.some(field => {
    const value = input[field];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
  });
}
