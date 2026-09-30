import { operation, stateDir, type PackageApi } from "@stack/api";
import { InferService } from "./src/service.js";
import { completeInput, completeOutput, discoverInput, getInput, listInput, listOutput, modelListInput, modelListOutput, modelObservation, modelsInput, modelsOutput, requestRecord, startInput } from "./src/schema.js";
import { InferTraces } from "./src/traces.js";
import { z } from "zod";
import { withStateInventory, requireStateOperator, statePlan, stateApplyInput, stateReceipt } from "@stack/api";
import { inferStateCategories } from "./src/state-categories.js";

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
export const inferModelList = operation({
  name: "infer_model_list",
  description: "Read cached model discovery for Bot accounts: models and efforts, observation time, the last discovery error, and whether discovery is running. Never starts discovery or inference. infer_models, infer_discover and each request's own fresh check refresh it.",
  input: modelListInput, output: modelListOutput,
  annotations: { title: "Read cached inference models", readOnlyHint: true },
  async call(ctx: InferContext, input) { return { accounts: ctx.service.modelList(input.accountId) }; },
});
export const inferDiscover = operation({
  name: "infer_discover",
  description: "Start discovering an enabled Bot account's models in the background through an isolated app-server model/list, and return at once. No thread, turn or inference. Coalesces with a discovery already running; read infer_model_list after infer_changed.",
  input: discoverInput, output: modelObservation,
  annotations: { title: "Discover inference models", readOnlyHint: false, idempotentHint: true },
  async call(ctx: InferContext, input) { return ctx.service.refreshModels(input.accountId); },
});
export const inferStart = operation({
  name: "infer_start",
  description: "Admit the same request as infer_complete into the durable ledger and return its running record at once, instead of waiting. The requestId is required; resending identical input returns the recorded run and never dispatches twice. Read infer_request_get after infer_changed for the outcome.",
  input: startInput, output: requestRecord,
  annotations: { title: "Start one inference", readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  async call(ctx: InferContext, input) { return ctx.service.start(input); },
});
export const inferRequestList = operation({
  name: "infer_request_list",
  description: "Page the durable inference request ledger, newest first, with state, outcome code, usage and short previews. It includes requests from infer_complete and infer_start. Read infer_request_get for full input and output, or infer_trace_read for dispatch evidence.",
  input: listInput, output: listOutput,
  annotations: { title: "List inference requests", readOnlyHint: true },
  async call(ctx: InferContext, input) { return ctx.service.list(input.limit, input.before); },
});
export const inferRequestGet = operation({
  name: "infer_request_get",
  description: "Read one inference request from the durable ledger with its full instructions, input, output text, usage, reported model and outcome.",
  input: getInput, output: requestRecord,
  annotations: { title: "Read inference request", readOnlyHint: true },
  async call(ctx: InferContext, input) { return ctx.service.get(input.requestId); },
});
export const topics = { infer_changed: "An inference request or cached model discovery changed. Re-read infer_request_list, infer_model_list, or the request you follow." } as const;
const packageApi: PackageApi<InferContext, keyof typeof topics> = {
  operations: [inferModels, inferModelList, inferDiscover, inferComplete, inferStart, inferRequestList, inferRequestGet, inferTraceRead,
    operation({ name: "infer_history_plan", description: "Preview payload clearing for up to 100 exact terminal inference IDs. Running requests block cleanup; unknown remains unknown. IDs/digests, model/account, usage and outcomes remain so retries cannot charge again. Signal and source copies are separate.",
      input: z.strictObject({ requestIds: z.array(z.uuid()).min(1).max(100) }), output: statePlan,
      async call(ctx: InferContext, { requestIds }, invocation) { requireStateOperator(invocation); if (!ctx.service.traces) throw new Error("tracing unavailable"); return ctx.service.traces.historyPlan(requestIds); } }),
    operation({ name: "infer_history_clear", description: "Atomically clear the exact planned terminal request bodies and trace events together with a durable cleanup receipt. Identities/digests and outcomes remain. An identical request-ID retry returns the receipt; inference admission with the original ID cannot dispatch again.",
      input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
      async call(ctx: InferContext, input, invocation) { requireStateOperator(invocation); if (!ctx.service.traces) throw new Error("tracing unavailable"); const result = ctx.service.traces.historyClear(input); ctx.service.onChange?.(); return result; } }),
    operation({ name: "infer_state_receipt_get", description: "Read one durable inference payload-cleanup receipt. Minimal receipts remain even when content is cleared.",
      input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: { readOnlyHint: true },
      async call(ctx: InferContext, { requestId }, invocation) { requireStateOperator(invocation); if (!ctx.service.traces) throw new Error("tracing unavailable"); return { receipt: ctx.service.traces.maintenance.receipt(requestId) }; } }),
  ],
  events: { topics, start(ctx, publish) {
    ctx.service.onChange = () => publish("infer_changed");
    return () => { ctx.service.onChange = undefined; };
  } },
  async createContext(env) { const dir = stateDir(env); return { service: new InferService(dir, undefined, undefined, undefined, new InferTraces(dir)) }; },
  prepareCloseContext(ctx) { ctx.service.prepareClose(); },
  async closeContext(ctx) { await ctx.service.close(); },
};
export const api = withStateInventory("infer", inferStateCategories, packageApi);
