import { z } from "zod";

export const settingValue = z.union([z.string().max(262_144), z.number().finite(), z.boolean(), z.array(z.string().max(4_096)).max(128), z.null()]);
export type SettingValue = z.infer<typeof settingValue>;
export const settingValues = z.record(z.string().min(1).max(200), settingValue);
export type SettingValues = z.infer<typeof settingValues>;
export const backend = z.enum(["codex-app-server", "opencode-codex", "opencode-grok", "devin-acp", "claude-sdk"]);
export type SettingsBackend = z.infer<typeof backend>;
export const settingsSnapshot = z.strictObject({ revision: z.number().int().nonnegative(), values: settingValues,
  source: z.string().describe("Creation provenance, not the origin of every later override."), sourceRevision: z.number().int().nonnegative().nullable(), updatedAt: z.number().int() });
export type SettingsSnapshot = z.infer<typeof settingsSnapshot>;
export const settingsLoaded = settingsSnapshot.extend({ loadedAt: z.number().int() });
export type SettingsLoaded = z.infer<typeof settingsLoaded>;
export const settingsPatch = z.strictObject({ expectedRevision: z.number().int().nonnegative(), requestId: z.uuid(),
  set: settingValues.optional(), reset: z.array(z.string().min(1).max(200)).max(128).optional() });
export type SettingsPatch = z.infer<typeof settingsPatch>;
export const settingEvidence = z.strictObject({ state: z.enum(["known", "native", "unknown"]), value: settingValue.nullable(), source: z.string(), observedAt: z.number().int().nullable() });
export type SettingEvidence = z.infer<typeof settingEvidence>;
export const settingsView = z.strictObject({ backend, saved: settingsSnapshot, defaults: settingsSnapshot.nullable(),
  instance: z.string().nullable(), loaded: settingsLoaded.nullable(),
  fields: z.array(z.strictObject({ key: z.string(), saved: settingEvidence, loaded: settingEvidence, resolved: settingEvidence, effective: settingEvidence,
    pending: z.boolean(), apply: z.enum(["bot-start", "voice-call", "worker-turn"]), maskedBy: z.array(z.string()) })),
  issues: z.array(z.string()) });
export type SettingsView = z.infer<typeof settingsView>;
export const settingsPlan = z.strictObject({ revision: z.number().int().nonnegative(), values: settingValues,
  changes: z.array(z.strictObject({ key: z.string(), beforeSet: z.boolean(), afterSet: z.boolean(), before: settingValue, after: settingValue, apply: z.string() })),
  issues: z.array(z.string()) });
export const settingsReceipt = z.strictObject({ requestId: z.uuid(), revision: z.number().int().nonnegative(), duplicate: z.boolean(), applied: z.literal(false) });
export const settingDefinition = z.strictObject({ key: z.string(), title: z.string(), description: z.string(), group: z.string(),
  schema: z.record(z.string(), z.unknown()), nativeDefault: settingEvidence, applicationDefault: settingEvidence,
  apply: z.enum(["bot-start", "voice-call", "worker-turn"]), stability: z.enum(["native", "experimental"]),
  choices: z.enum(["static", "models", "efforts", "service-tiers", "voices", "native"]), dependencies: z.array(z.string()) });
export const settingsCatalog = z.strictObject({ version: z.literal(1), backend, runtime: z.string().nullable(), sourceRevision: z.string(),
  settings: z.array(settingDefinition), resources: z.array(z.strictObject({ name: z.string(), package: z.string(), operation: z.string() })),
  limitations: z.array(z.string()) });
