import { record } from "./acp.js";

export type ModelChoice = { id: string; name: string; efforts: string[]; effortConfigId: string | null };
export type Catalog = { accountId: string; provider: "codex" | "grok" | "devin"; observedAt: string; source: string;
  runtimeVersion: string; modelConfigId: string | null; models: ModelChoice[]; nativeModelIds: string[]; stale: boolean; error: string | null };

type Option = { id: string; category?: string; name: string; values: Array<{ value: string; name: string }> };

function optionValues(input: unknown): Array<{ value: string; name: string }> {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry: unknown) => {
    if (!record(entry)) return [];
    if (typeof entry.value === "string" && typeof entry.name === "string") return [{ value: entry.value, name: entry.name }];
    return optionValues(entry.options);
  });
}

export function optionsOf(result: unknown): Option[] {
  if (!record(result)) return [];
  if (Array.isArray(result.configOptions)) return result.configOptions.flatMap((entry: unknown) => {
    if (!record(entry) || entry.type !== "select" || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
    return [{ id: entry.id, category: typeof entry.category === "string" ? entry.category : undefined,
      name: entry.name, values: optionValues(entry.options) }];
  });
  // ACP's older model selector is an account/session-bound source, but provides no effort choices.
  if (record(result.models) && Array.isArray(result.models.availableModels)) return [{
    id: "model", category: "model", name: "Model", values: result.models.availableModels.flatMap((entry: unknown) =>
      record(entry) && typeof entry.modelId === "string" ? [{ value: entry.modelId, name: typeof entry.name === "string" ? entry.name : entry.modelId }] : []),
  }];
  return [];
}

export function currentOption(result: unknown, id: string): string | null {
  if (!record(result) || !Array.isArray(result.configOptions)) return null;
  const option = result.configOptions.find((entry: unknown) => record(entry) && entry.id === id);
  return record(option) && typeof option.currentValue === "string" ? option.currentValue : null;
}

export function modelOption(options: Option[]): Option | undefined {
  return options.find((item) => item.category === "model") ?? options.find((item) => item.id === "model");
}

export function effortOption(options: Option[]): Option | undefined {
  return options.find((item) => item.category === "thought_level") ?? options.find((item) => item.id === "effort");
}

export function nativeDevinModels(value: unknown): string[] {
  if (!record(value) || !Array.isArray(value.families)) return [];
  return value.families.flatMap((family: unknown) => record(family) && Array.isArray(family.variants)
    ? family.variants.flatMap((variant: unknown) => record(variant) && typeof variant.model_uid === "string" ? [variant.model_uid] : []) : []);
}
