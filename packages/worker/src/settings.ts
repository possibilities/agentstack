import { z } from "zod";
import { operation, operatorInvocation } from "@stack/api";
import { catalog, evidence, settingsCatalog, settingsPatch, settingsPlan, settingsReceipt, settingsView, settingsState } from "@stack/settings";
import type { WorkersContext } from "../api.js";
import { workerSettingsBackend } from "./manager.js";

const provider = z.enum(["codex", "devin", "claude"]);
const target = z.strictObject({ id: z.uuid().optional(), provider: provider.optional() })
  .refine((value) => (value.id === undefined) !== (value.provider === undefined), "Select exactly one Worker id or defaults provider");
const edit = z.strictObject({ target, patch: settingsPatch });

export const workerSettingsCatalog = operation({ name: "worker_settings_catalog", description: "Discover managed Worker settings for a provider/backend. Codex Workers use OpenCode ACP, Devin uses ACP and Claude uses its SDK. Use worker_catalog with an account for native model and dependent effort choices. No session starts.",
  input: z.strictObject({ provider }), output: settingsCatalog, annotations: { title: "Worker settings catalog", readOnlyHint: true },
  async call(ctx: WorkersContext, { provider }) {
    const value = catalog(workerSettingsBackend(provider));
    const defaults = ctx.manager.ledger.settings.get(`worker-defaults:${provider}`)!;
    for (const field of value.settings) field.applicationDefault = evidence(defaults.values, field.key, "Saved defaults for future Workers", defaults.updatedAt);
    return value;
  } });

export const workerSettingsRead = operation({ name: "worker_settings_read", description: "Read provider defaults or one Worker's saved, loaded and natively observed selections. Defaults apply only to new Workers. Worker reads retain Bot ownership and exact self-read checks. Missing native observations remain unknown.",
  input: target, output: settingsView, annotations: { title: "Inspect Worker settings", readOnlyHint: true },
  async call(ctx: WorkersContext, input, invocation) {
    if (input.id) return ctx.manager.readSettings(input.id, invocation);
    const saved = ctx.manager.ledger.settings.get(`worker-defaults:${input.provider}`)!;
    return settingsState(workerSettingsBackend(input.provider!), saved, null, null, null);
  } });

export const workerSettingsPreview = operation({ name: "worker_settings_preview", description: "Validate a revision-fenced Worker settings patch without saving. Select a provider for future-Worker defaults or an owned Worker ID. Runtime model/effort compatibility is checked on admission or explicit application, against that account's catalog.",
  input: edit, output: settingsPlan, annotations: { title: "Preview Worker settings", readOnlyHint: true },
  async call(ctx: WorkersContext, { target, patch }, invocation) {
    return settingsPlan.parse(target.id ? await ctx.manager.patchSettings(target.id, patch, invocation, true)
      : ctx.manager.ledger.settings.preview(`worker-defaults:${target.provider}`, workerSettingsBackend(target.provider!), patch));
  } });

export const workerSettingsPatch = operation({ name: "worker_settings_patch", description: "Save an atomic revision-fenced Worker settings edit with an idempotent requestId. Provider defaults are operator-only and affect new Workers only; owned Worker edits apply at the next follow-up or explicit idle application. Saving starts no turn or process. Reset retains an existing session's native selection.",
  input: edit, output: settingsReceipt, annotations: { title: "Save Worker settings", idempotentHint: true },
  async call(ctx: WorkersContext, { target, patch }, invocation) {
    if (target.id) return settingsReceipt.parse(await ctx.manager.patchSettings(target.id, patch, invocation));
    if (!operatorInvocation(invocation)) throw new Error("Worker defaults are operator-only");
    const result = ctx.manager.ledger.settings.patch(`worker-defaults:${target.provider}`, workerSettingsBackend(target.provider!), patch);
    ctx.manager.onChange?.();
    return result;
  } });

export const workerSettingsApply = operation({ name: "worker_settings_apply", description: "Apply the exact saved settings revision to the exact idle Worker runtime without sending a prompt. Native acknowledgements establish loaded selections, not inference. On failure the outcome may be unknown and requires inspection/recovery; no automatic retry.",
  input: z.strictObject({ id: z.uuid(), expectedRevision: z.number().int().nonnegative(), expectedInstance: z.uuid() }),
  output: z.strictObject({ id: z.uuid(), revision: z.number().int(), status: z.literal("loaded") }), annotations: { title: "Apply Worker settings" },
  async call(ctx: WorkersContext, { id, expectedRevision, expectedInstance }, invocation) { return ctx.manager.applySettings(id, expectedRevision, expectedInstance, invocation); } });

export const workerSettingsOperations = [workerSettingsCatalog, workerSettingsRead, workerSettingsPreview, workerSettingsPatch, workerSettingsApply];
