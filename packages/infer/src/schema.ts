import { z } from "zod";

export const accountId = z.uuid();
export const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const effort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const model = z.strictObject({ id: modelId, defaultEffort: effort, supportedEfforts: z.array(effort).min(1) });
export const modelsInput = z.strictObject({ accountId });
export const modelsOutput = z.strictObject({ models: z.array(model), observedAt: z.string().datetime() });
export const completeInput = z.strictObject({
  accountId, model: modelId, effort,
  instructions: z.string().min(1).max(32_000),
  input: z.string().min(1).max(128_000),
  maxOutputTokens: z.number().int().min(1).max(8192).default(256).describe("Post-response output-token threshold, checked when usage is available. The Codex backend does not accept a provider-side output limit; this is not a spending cap."),
  requestId: z.uuid().optional().describe("Stable local dispatch key. Repeating identical input reads the recorded outcome; never dispatches twice."),
});
export const usage = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
});
export const completeOutput = z.strictObject({ requestId: z.uuid(), model: modelId, reportedModel: z.string().nullable(), text: z.string().max(128_000), usage });
export type Model = z.infer<typeof model>;
export type CompleteInput = z.infer<typeof completeInput>;
export type CompleteOutput = z.infer<typeof completeOutput>;
