import { z } from "zod";
import type { CompletionWatch } from "@stack/api";
import { workContext } from "@stack/hud/schema";

export const turnObservationInput = z.strictObject({ requestId: z.uuid(), botId: z.string().min(1), threadId: z.string().min(1) });
const identity = { workerId: z.uuid(), turnId: z.uuid(), requestId: z.uuid() };
export const turnObservation = z.strictObject({
  result: z.strictObject({ ...identity, phase: z.enum(["completed", "cancelled", "failed", "unknown"]), stopReason: z.string().nullable(), issue: z.string().max(4_000).nullable(),
    workContext: workContext.nullable(), contentClearedAt: z.number().nullable() }).nullable(),
  update: z.strictObject({ ...identity, phase: z.enum(["queued", "running", "awaiting_input", "cancelling"]),
    pending: z.array(z.strictObject({ permissionId: z.uuid(), optionCount: z.number().int() })).max(8), pendingCount: z.number().int(), pendingTruncated: z.boolean() }).nullable(),
});
export const turnWatch: CompletionWatch = { topic: "worker_turn_changed", readOperation: "worker_turn_observation", idArgument: "requestId", terminalField: "result", defaultWhen: [],
  defaultOnForBot: true, updateField: "update", initialValueField: "observation", scope: { input: "requestId", prefix: "request:" },
  readArguments: { requestId: { input: "requestId" }, botId: { invocation: "botId" }, threadId: { invocation: "threadId" } } };
