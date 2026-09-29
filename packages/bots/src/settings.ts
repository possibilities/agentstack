import { z } from "zod";
import { operation, botInstance, operatorInvocation } from "@stack/api";
import { catalog, codexSchema, settingsCatalog, settingsPatch, settingsPlan, settingsReceipt, settingsView, settingsState, settingValue, evidence } from "@stack/settings";
import type { BotsContext } from "../api.js";
import { chatRpc } from "./chats.js";
import { installedRuntimeVersion } from "./runtime.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const target = z.strictObject({ id: id.optional().describe("Bot ID; omit to select defaults copied into future Bots.") });
const edit = settingsPatch.extend({ id: id.optional() });
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function at(value: unknown, key: string): unknown {
  const root = object(value);
  return Object.hasOwn(root, key) ? root[key] : key.split(".").reduce<unknown>((next, part) => object(next)[part], root);
}
function selected(ctx: BotsContext, id?: string) { return id ? ctx.supervisor.settingsSnapshot(id) : ctx.store.managed.get("bot-defaults")!; }
function subject(id?: string) { return id ? `bot:${id}` : "bot-defaults"; }

/** Report only setting names. Native argument values can contain secrets. */
function masking(args: readonly string[], key: string): string[] {
  const found = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const config = arg === "-c" || arg === "--config" ? args[++i] : arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c") ? arg.slice(2) : null;
    if (config) {
      const name = config.split("=", 1)[0].trim().replaceAll('"', "").replaceAll("'", "");
      if (key === name || key.startsWith(`${name}.`) || name.startsWith(`${key}.`)) found.add("Saved launch argument");
    }
    if (key.startsWith("features.") && (arg === "--enable" || arg === "--disable" || arg.startsWith("--enable=") || arg.startsWith("--disable="))) {
      const name = arg.includes("=") ? arg.split("=")[1] : args[++i];
      if (name?.split(",").some((feature) => key === `features.${feature}` || key.startsWith(`features.${feature}.`))) found.add("Saved feature argument");
    }
    if (arg === "--profile" || arg === "-p" || arg.startsWith("--profile=")) found.add("Saved native profile may override this value");
  }
  return [...found];
}

export const botSettingsCatalog = operation({ name: "bot_settings_catalog", description: "Discover managed Codex Bot and voice settings, value schemas, native-default uncertainty, dependencies and application boundaries. No process or call starts. Native schemas and runtime catalogs remain versioned evidence, not account eligibility.",
  input: z.strictObject({}), output: settingsCatalog, annotations: { title: "Bot settings catalog", readOnlyHint: true },
  async call(ctx: BotsContext) {
    const value = catalog("codex-app-server", await installedRuntimeVersion());
    const defaults = selected(ctx);
    for (const field of value.settings) field.applicationDefault = evidence(defaults.values, field.key, "Saved defaults for future Bots", defaults.updatedAt);
    return value;
  } });

export const botSettingsRead = operation({ name: "bot_settings_read", description: "Read saved, process-loaded and call-loaded settings. Omit id for future-Bot defaults. observe reads native configuration and its origins from the exact running Bot without starting a turn; configuration resolution is distinct from effective thread behavior.",
  input: target.extend({ observe: z.boolean().optional() }), output: settingsView, annotations: { title: "Inspect Bot settings", readOnlyHint: true },
  async call(ctx: BotsContext, { id, observe }) {
    const saved = selected(ctx, id);
    const bot = id ? ctx.supervisor.list().find((bot) => bot.id === id)! : null;
    const url = bot?.state === "running" && !bot.recoveryIssue ? bot.url : null;
    const loaded = id && url ? ctx.store.managed.loaded(subject(id), url) : null;
    const view = settingsState("codex-app-server", saved, id ? selected(ctx) : null, loaded, url ? botInstance(url) : null);
    const observed = id && url ? ctx.supervisor.observedSettings(id) : null;
    for (const field of view.fields) {
      if (id) field.maskedBy = masking(ctx.supervisor.settingsArgs(id), field.key);
      if (observed && Object.hasOwn(observed.values, field.key)) field.effective = evidence(observed.values, field.key, "Native main-thread settings", observed.observedAt);
      if (field.key.startsWith("voice.")) {
        const call = id ? ctx.voice.settings(id) : null;
        field.loaded = evidence(call?.values ?? null, field.key, "Submitted on the active voice call", call?.loadedAt ?? null);
        field.pending = call ? JSON.stringify(saved.values[field.key]) !== JSON.stringify(call.values[field.key]) : Object.hasOwn(saved.values, field.key);
      }
    }
    if (!id) view.issues.push("These defaults are copied at Bot creation. Existing Bots keep their saved snapshots.");
    if (observe && url && bot) {
      try {
        const response = await chatRpc(url, "config/read", { includeLayers: true, cwd: bot.cwd });
        if (ctx.supervisor.list().find((item) => item.id === id)?.url !== url) throw new Error("instance changed");
        const config = object(response.config), origins = object(response.origins);
        const now = Date.now();
        for (const field of view.fields) {
          if (field.key.startsWith("voice.")) continue;
          const value = settingValue.safeParse(at(config, field.key));
          if (value.success) {
            const origin = object(origins[field.key]);
            const source = object(origin.name).type;
            field.resolved = evidence({ [field.key]: value.data }, field.key, typeof source === "string" ? `Native config: ${source}` : "Native config/read", now);
            if (Object.hasOwn(saved.values, field.key) && JSON.stringify(saved.values[field.key]) !== JSON.stringify(value.data)) field.maskedBy.push("Native configuration differs from saved selection");
          }
        }
      } catch { view.issues.push("Native configuration unavailable or runtime changed; no effective values inferred."); }
    }
    return view;
  } });

export const botSettingsPreview = operation({ name: "bot_settings_preview", description: "Validate an atomic settings patch and show changes and application boundaries without saving. Omit id for future-Bot defaults. reset omits named overrides and restores native resolution; no prompt, feature or voice policy is added implicitly.",
  input: edit, output: settingsPlan, annotations: { title: "Preview Bot settings", readOnlyHint: true },
  async call(ctx: BotsContext, { id, ...input }) {
    selected(ctx, id);
    const plan = ctx.store.managed.preview(subject(id), "codex-app-server", input);
    if (id) for (const change of plan.changes) if (masking(ctx.supervisor.settingsArgs(id), change.key).length) plan.issues.push(`${change.key} may be masked by saved launch arguments`);
    plan.issues.push("Native model availability, managed requirements and resumed-thread overrides are checked by Codex at use time; inspect runtime options and resolved values.");
    return plan;
  } });

export const botSettingsPatch = operation({ name: "bot_settings_patch", description: "Operator-only: atomically save a revision-fenced settings edit; requestId retries return the original receipt. Omit id for future-Bot defaults. Saving never restarts a Bot or call. Agent settings load on the next start; voice fields on the next explicit call. reset removes overrides.",
  input: edit, output: settingsReceipt, annotations: { title: "Save Bot settings", idempotentHint: true },
  async call(ctx: BotsContext, { id, ...input }, invocation) {
    if (!operatorInvocation(invocation)) throw new Error("Managed settings writes are operator-only");
    if (id) return ctx.supervisor.patchSettings(id, input);
    const receipt = ctx.store.managed.patch("bot-defaults", "codex-app-server", input);
    ctx.store.onDefaultsChange?.();
    return receipt;
  } });

export const botSettingsApply = operation({ name: "bot_settings_apply", description: "Operator-only: start a stopped Bot with the exact saved settings revision. Uses its assigned account and existing main thread. A running Bot is refused; stop it through lifecycle controls first. Lost responses require a settings/status read, never an automatic restart.",
  input: z.strictObject({ id, expectedRevision: z.number().int().nonnegative() }), output: z.strictObject({ id, revision: z.number().int(), status: z.literal("loaded") }),
  annotations: { title: "Load saved Bot settings" }, async call(ctx: BotsContext, { id, expectedRevision }, invocation) {
    if (!operatorInvocation(invocation)) throw new Error("Managed settings application is operator-only");
    await ctx.supervisor.applySettings(id, expectedRevision);
    return { id, revision: expectedRevision, status: "loaded" as const };
  } });

const discoveryPart = <T extends z.ZodType>(data: T) => z.strictObject({ available: z.boolean(), data: data.nullable(), issue: z.string().nullable() });
const nativeModels = z.array(z.looseObject({ id: z.string(), model: z.string(), displayName: z.string(),
  supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: z.string(), description: z.string() })), defaultReasoningEffort: z.string(),
  serviceTiers: z.array(z.looseObject({ id: z.string(), name: z.string(), description: z.string() })).optional(), isDefault: z.boolean() }));
const nativeVoices = z.strictObject({ voices: z.looseObject({ v1: z.array(z.string()), v2: z.array(z.string()), defaultV1: z.string(), defaultV2: z.string() }) });
const nativeFeatures = z.array(z.looseObject({ name: z.string(), enabled: z.boolean(), defaultEnabled: z.boolean(), stage: z.string() }));
const nativeRequirements = z.record(z.string(), z.unknown());
export const botSettingsOptions = operation({ name: "bot_settings_options", description: "Read native model/effort/service-tier, voice, experimental-feature and managed-requirement catalogs from an existing Bot. No thread, inference or media starts. Partial failures are labelled. Returned native choices/defaults are compatibility evidence, not successful-use claims.",
  input: z.strictObject({ id }), output: z.strictObject({ instance: z.string(), observedAt: z.number().int(), models: discoveryPart(nativeModels), voices: discoveryPart(nativeVoices), features: discoveryPart(nativeFeatures), requirements: discoveryPart(nativeRequirements) }),
  annotations: { title: "Discover native Bot options", readOnlyHint: true },
  async call(ctx: BotsContext, { id }) {
    selected(ctx, id);
    const bot = ctx.supervisor.list().find((bot) => bot.id === id)!;
    if (bot.state !== "running" || !bot.url || bot.recoveryIssue) throw new Error("Native discovery requires a verified running Bot");
    const url = bot.url;
    const read = async <T extends z.ZodType>(method: string, schema: T, paged = false): Promise<{ available: boolean; data: z.output<T> | null; issue: string | null }> => {
      try {
        let cursor: string | null = null;
        const rows: unknown[] = [];
        for (let page = 0; page < 10; page++) {
          const result = await chatRpc(url, method, paged ? { cursor, limit: 100 } : {});
          if (!paged) {
            // Requirements can include authored instructions, paths and provider definitions. Expose only constraints relevant to the editor.
            if (method === "configRequirements/read" && !Object.hasOwn(result, "requirements")) throw new Error("invalid requirements");
            if (method === "configRequirements/read" && result.requirements === null) return { available: true, data: null, issue: null };
            const raw = method === "configRequirements/read" ? object(result.requirements) : result;
            const data = method === "configRequirements/read" ? Object.fromEntries(Object.entries(raw).filter(([key]) => ["allowedApprovalPolicies", "allowedApprovalsReviewers", "allowedSandboxModes", "allowedPermissionProfiles", "defaultPermissions", "allowedWebSearchModes", "featureRequirements", "models"].includes(key))) : raw;
            return { available: true, data: schema.parse(data), issue: null };
          }
          if (!Array.isArray(result.data)) throw new Error("invalid catalog");
          rows.push(...result.data);
          if (!result.nextCursor) return { available: true, data: schema.parse(rows), issue: null };
          if (typeof result.nextCursor !== "string" || result.nextCursor === cursor) throw new Error("invalid cursor");
          cursor = result.nextCursor;
        }
        throw new Error("catalog exceeds page bound");
      } catch { return { available: false, data: null, issue: `Native ${method} unavailable or invalid` }; }
    };
    const [models, voices, features, requirements] = await Promise.all([read("model/list", nativeModels, true), read("thread/realtime/listVoices", nativeVoices), read("experimentalFeature/list", nativeFeatures, true), read("configRequirements/read", nativeRequirements)]);
    if (ctx.supervisor.list().find((item) => item.id === id)?.url !== url) throw new Error("Bot instance changed during discovery; reread");
    return { instance: botInstance(url), observedAt: Date.now(), models, voices, features, requirements };
  } });

export const botSettingsNativeSchema = operation({ name: "bot_settings_native_schema", description: "Read the complete pinned native Codex configuration schema for discovery. This includes settings owned elsewhere or not managed by Stack. Use bot_settings_catalog for editable keys; native schema presence is not proof of runtime/account availability.",
  input: z.strictObject({}), output: z.strictObject({ revision: z.string(), schema: z.record(z.string(), z.unknown()) }),
  annotations: { title: "Native Codex settings schema", readOnlyHint: true }, async call() { return codexSchema; } });

export const botSettingsOperations = [botSettingsCatalog, botSettingsRead, botSettingsPreview, botSettingsPatch, botSettingsApply, botSettingsOptions, botSettingsNativeSchema];
