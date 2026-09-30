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
const timestamp = z.iso.datetime();

export const modelObservation = z.strictObject({
  accountId,
  models: z.array(model).nullable().describe("Last successful discovery, or null before one."),
  observedAt: timestamp.nullable(),
  discovering: z.boolean(),
  error: z.string().nullable().describe("Code from the most recent failed discovery, such as catalog_unavailable."),
});
export const modelListInput = z.strictObject({ accountId: accountId.optional() });
export const modelListOutput = z.strictObject({ accounts: z.array(modelObservation) });
export const discoverInput = z.strictObject({ accountId });

export const startInput = completeInput.extend({
  requestId: z.uuid().describe("Client-generated idempotency key. Resend identical input after an uncertain response; it never dispatches twice."),
});
export const requestState = z.enum(["running", "completed", "failed", "unknown"]).describe(
  "failed is definite: nothing was sent, the backend refused it, or it completed above the token threshold. unknown may have been charged: it was interrupted after it could have been sent.");
const requestFields = {
  requestId: z.uuid(), accountId, model: modelId, effort,
  maxOutputTokens: z.number().int().min(1).max(8192),
  state: requestState,
  error: z.string().nullable().describe("Outcome code for a failed or unknown request, such as model_unavailable, codex_rate_limited, infer_http_error:502, infer_output_budget_exceeded:<id>, infer_outcome_unknown:<id> or infer_interrupted."),
  reportedModel: z.string().nullable(),
  usage: usage.nullable(),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
  contentClearedAt: timestamp.nullable().describe("Terminal request payloads were explicitly cleared; identity/digest/outcome/usage remain to prevent redispatch."),
};
export const requestSummary = z.strictObject({
  ...requestFields,
  inputPreview: z.string().max(160),
  textPreview: z.string().max(160).nullable(),
  textChars: z.number().int().nonnegative().nullable(),
});
export const requestRecord = z.strictObject({
  ...requestFields,
  instructions: z.string().max(32_000),
  input: z.string().max(128_000),
  text: z.string().max(128_000).nullable(),
});
export const listInput = z.strictObject({
  limit: z.number().int().min(1).max(50).default(20),
  before: z.number().int().positive().optional().describe("nextBefore from the previous page."),
});
export const listOutput = z.strictObject({ requests: z.array(requestSummary), nextBefore: z.number().int().positive().nullable() });
export const getInput = z.strictObject({ requestId: z.uuid() });

export type Model = z.infer<typeof model>;
export type ModelObservation = z.infer<typeof modelObservation>;
export type StartInput = z.infer<typeof startInput>;
export type RequestState = z.infer<typeof requestState>;
export type RequestRecord = z.infer<typeof requestRecord>;
export type RequestSummary = z.infer<typeof requestSummary>;
export type CompleteInput = z.infer<typeof completeInput>;
export type CompleteOutput = z.infer<typeof completeOutput>;
