import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { InferService } from "./src/service.js";
import { completeInput, completeOutput, modelsInput, modelsOutput } from "./src/schema.js";

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
export const api: PackageApi<InferContext> = {
  operations: [inferModels, inferComplete],
  async createContext(env) { return { service: new InferService(stateDir(env)) }; },
  async closeContext() {},
};
