import { z } from "zod";
import { completionReceipt, type CompletionWatch } from "@stack/api";

export const handoffSchema = z.strictObject({
  contentClearedAt: z.iso.datetime().nullable().default(null), requestDigest: z.string().nullable().default(null),
  id: z.uuid(), profileId: z.uuid(), botId: z.string(), threadId: z.string(), instance: z.string(), requestId: z.uuid(),
  targetId: z.string().nullable(), targetStatus: z.enum(["unspecified", "present", "missing", "unknown"]), message: z.string(),
  state: z.enum(["preparing", "awaiting_human", "human_controlling", "returning", "resolved"]),
  outcome: z.enum(["completed", "skipped", "cancelled"]).nullable(), note: z.string().nullable(),
  revision: z.number().int(), createdAt: z.string(), resolvedAt: z.string().nullable(), issue: z.string().nullable(),
  quiesced: z.boolean(),
});
export type Handoff = z.infer<typeof handoffSchema>;
export const handoffRequestSchema = z.strictObject({ profileId: z.uuid(), targetId: z.string().min(1).max(256).optional(), message: z.string().min(1).max(4000), requestId: z.uuid(), subscribe: z.boolean().optional() });
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;
export const handoffActionSchema = z.strictObject({ id: z.uuid(), expectedRevision: z.number().int().positive(), requestId: z.uuid() });
export type HandoffAction = z.infer<typeof handoffActionSchema>;
export const completionInput = z.strictObject({ botId: z.string().min(1), threadId: z.string().min(1), requestId: z.uuid() });
export const actionReceiptSchema = z.strictObject({ id: z.uuid(), requestId: z.uuid(), digest: z.string(), revision: z.number().int() });
export const handoffCompletionSchema = z.strictObject({ result: handoffSchema.nullable() });
export const handoffRequestResult = handoffSchema.extend({ subscription: completionReceipt.nullable(), observation: handoffCompletionSchema.nullable() });
export const handoffWatch: CompletionWatch = { topic: "browser_handoffs_changed", readOperation: "browser_handoff_completion", idArgument: "requestId", terminalField: "result", defaultWhen: [],
  defaultOnForBot: true, initialValueField: "observation", readArguments: { requestId: { input: "requestId" }, botId: { invocation: "botId" }, threadId: { invocation: "threadId" } } };
