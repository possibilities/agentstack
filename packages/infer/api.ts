import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { InferService } from "./src/service.js";
import { completeInput, completeOutput, modelsInput, modelsOutput } from "./src/schema.js";
import { InferTraces } from "./src/traces.js";
import { z } from "zod";

export type InferContext = { service: InferService };
export const inferModels = operation({
  name: "infer_models",
  description: "Read the currently picker-visible Codex models and reasoning efforts for an enabled Bot account via app-server model/list. No agent turn or inference is run; discovery does not guarantee direct-backend access.",
  input: modelsInput, output: modelsOutput,
  annotations: { title: "Discover inference models", readOnlyHint: true },
  async call(ctx: InferContext, input) { return ctx.service.models(input.accountId); },
});
export const inferComplete = operation({
  name: "infer_complete",
  description: "Make one experimental, non-agentic Codex subscription request for a visible model/effort on an enabled Bot account. Consumes shared allowance; no retries, tools, agent turn, or Platform API fallback. An interrupted request may have been charged.",
  input: completeInput, output: completeOutput,
  annotations: { title: "Complete one inference", readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  async call(ctx: InferContext, input) { return ctx.service.complete(input); },
});
export const inferTraceRead = operation({
  name: "infer_trace_read", description: "Read a durable inference trace as JSON text chunks: exact input and provider request body, returned text deltas, terminal metadata, usage, timing and failures. Excludes authentication and raw reasoning. Concatenate chunks after complete=true for a stable export.",
  input: z.strictObject({ requestId: z.uuid(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(32_000).default(16_000), revision:z.string().optional() }),
  output: z.strictObject({ text: z.string(), nextOffset: z.number().int(), totalChars: z.number().int(), complete: z.boolean(), revision:z.string() }),
  annotations: { title: "Read inference trace", readOnlyHint: true },
  async call(ctx: InferContext, input) { if (!ctx.service.traces) throw new Error("tracing unavailable"); return ctx.service.traces.read(input.requestId,input.offset,input.limit,input.revision); },
});
export const api: PackageApi<InferContext> = {
  operations: [inferModels, inferComplete, inferTraceRead],
  async createContext(env) { const dir = stateDir(env); return { service: new InferService(dir, undefined, undefined, undefined, new InferTraces(dir)) }; },
  async closeContext(ctx) { ctx.service.traces?.close(); },
};
