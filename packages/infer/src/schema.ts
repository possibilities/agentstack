import { z } from "zod";

export const accountId = z.uuid();
export const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const effort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const model = z.strictObject({ id: modelId, defaultEffort: effort, supportedEfforts: z.array(effort).min(1) });
export const modelsInput = z.strictObject({ accountId });
export const modelsOutput = z.strictObject({ models: z.array(model), observedAt: z.string().datetime() });
export const completeInput = z.strictObject({
  accountId, model: modelId, effort,
  instructions: z.string().min(1).max(4_000),
  input: z.string().min(1).max(16_000),
  maxOutputTokens: z.number().int().min(1).max(1024).default(256),
});
export const usage = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
});
export const completeOutput = z.strictObject({ requestId: z.uuid(), model: modelId, text: z.string().max(16_000), usage });
export type Model = z.infer<typeof model>;
export type CompleteInput = z.infer<typeof completeInput>;
export type CompleteOutput = z.infer<typeof completeOutput>;
