import type { BotSettingsOptions, JsonSchema, SettingEvidence, SettingValue, SettingsCatalog, SettingsPatch, SettingsSnapshot, SettingsView, WorkerAccount, WorkerCatalog } from "./types";

/**
 * Managed settings (ADR 0128) in the browser: which document an editor targets, how a draft
 * distinguishes omission from explicit values, and how evidence is worded. Pure; the store reads
 * and the canvas renders.
 */

export type WorkerProvider = WorkerAccount["provider"];
export const workerProviders: WorkerProvider[] = ["codex", "devin", "claude"];

/** A settings document. Defaults documents are copied into new instances; they are not live inheritance. */
export type SettingsTarget =
  | { kind: "bot"; id: string }
  | { kind: "bot-defaults" }
  | { kind: "worker"; id: string }
  | { kind: "worker-defaults"; provider: WorkerProvider };

export function settingsKey(target: SettingsTarget): string {
  switch (target.kind) {
    case "bot": return `bot:${target.id}`;
    case "bot-defaults": return "bot-defaults";
    case "worker": return `worker:${target.id}`;
    case "worker-defaults": return `worker-defaults:${target.provider}`;
  }
}

export function isDefaultsTarget(target: SettingsTarget): boolean {
  return target.kind === "bot-defaults" || target.kind === "worker-defaults";
}

export function settingsPackage(target: SettingsTarget): "bots" | "worker" {
  return target.kind === "bot" || target.kind === "bot-defaults" ? "bots" : "worker";
}

/** Exact receipt target: omitted Bot ID means future-Bot defaults, never all Bots. */
export function settingsReceiptTarget(target: SettingsTarget): { id?: string; provider?: WorkerProvider } {
  switch (target.kind) {
    case "bot": case "worker": return { id: target.id };
    case "bot-defaults": return {};
    case "worker-defaults": return { provider: target.provider };
  }
}

/** Keep invalid/empty buffers visible instead of silently rounding or clamping a retention window. */
export function receiptRetentionDays(text: string): number | null {
  if (!text.trim()) return null;
  const days = Number(text);
  return Number.isSafeInteger(days) && days >= 7 && days <= 3650 ? days : null;
}

/** The catalog a target's editable keys come from. Worker catalogs are per provider. */
export function catalogKey(target: SettingsTarget, provider?: WorkerProvider): string | null {
  if (settingsPackage(target) === "bots") return "bots";
  const selected = target.kind === "worker-defaults" ? target.provider : provider;
  return selected ? `worker:${selected}` : null;
}

export type SettingsRequest = { pkg: "bots" | "worker"; name: string; args: Record<string, unknown> };

/** Bot instance reads also observe native configuration from a verified running process; that starts no turn. */
export function readRequest(target: SettingsTarget): SettingsRequest {
  switch (target.kind) {
    case "bot": return { pkg: "bots", name: "bot_settings_read", args: { id: target.id, observe: true } };
    case "bot-defaults": return { pkg: "bots", name: "bot_settings_read", args: {} };
    case "worker": return { pkg: "worker", name: "worker_settings_read", args: { id: target.id } };
    case "worker-defaults": return { pkg: "worker", name: "worker_settings_read", args: { provider: target.provider } };
  }
}

export function catalogRequest(key: string): SettingsRequest {
  return key === "bots" ? { pkg: "bots", name: "bot_settings_catalog", args: {} }
    : { pkg: "worker", name: "worker_settings_catalog", args: { provider: key.slice("worker:".length) } };
}

/** Bot edits are flat; Worker edits nest the target and the patch. Preview and patch take the same arguments. */
export function editRequest(target: SettingsTarget, patch: SettingsPatch, mode: "preview" | "patch"): SettingsRequest {
  switch (target.kind) {
    case "bot": return { pkg: "bots", name: `bot_settings_${mode}`, args: { id: target.id, ...patch } };
    case "bot-defaults": return { pkg: "bots", name: `bot_settings_${mode}`, args: { ...patch } };
    case "worker": return { pkg: "worker", name: `worker_settings_${mode}`, args: { target: { id: target.id }, patch } };
    case "worker-defaults": return { pkg: "worker", name: `worker_settings_${mode}`, args: { target: { provider: target.provider }, patch } };
  }
}

/** One field's editing intent. Absence means unchanged; `invalid` holds a buffer that cannot be sent yet. */
export type FieldDraft = { kind: "set"; value: SettingValue } | { kind: "reset" } | { kind: "invalid"; raw: string; error: string };
export type SettingsDraft = Record<string, FieldDraft>;

export function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameDraft(a: FieldDraft | undefined, b: FieldDraft | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The minimal patch a draft means against a saved document: a set equal to the saved value and a reset of an
 * omitted key are no-ops. Invalid buffers are reported rather than sent.
 */
export function buildPatch(draft: SettingsDraft, saved: SettingsSnapshot, requestId: string): { patch: SettingsPatch; invalid: string[] } {
  const set: Record<string, SettingValue> = {};
  const reset: string[] = [];
  const invalid: string[] = [];
  for (const [key, field] of Object.entries(draft)) {
    const present = Object.hasOwn(saved.values, key);
    if (field.kind === "invalid") invalid.push(key);
    else if (field.kind === "reset") { if (present) reset.push(key); }
    else if (!present || !sameValue(saved.values[key], field.value)) set[key] = field.value;
  }
  return { patch: { expectedRevision: saved.revision, requestId, ...(Object.keys(set).length ? { set } : {}), ...(reset.length ? { reset } : {}) }, invalid };
}

export function patchSize(patch: SettingsPatch): number {
  return Object.keys(patch.set ?? {}).length + (patch.reset?.length ?? 0);
}

/** The document the draft would save, for local explanation only; the server validates. */
export function candidateValues(saved: SettingsSnapshot, draft: SettingsDraft): Record<string, SettingValue> {
  const values = { ...saved.values };
  for (const [key, field] of Object.entries(draft)) {
    if (field.kind === "reset") delete values[key];
    else if (field.kind === "set") values[key] = field.value;
  }
  return values;
}

export const settingsByteLimit = 128_000;

export function settingsBytes(values: Record<string, SettingValue>): number {
  return new TextEncoder().encode(JSON.stringify(values)).length;
}

/** Local explanations of rules the server enforces. They never rewrite a value. */
export function draftIssues(saved: SettingsSnapshot, draft: SettingsDraft): string[] {
  const issues: string[] = [];
  const values = candidateValues(saved, draft);
  if (Object.hasOwn(values, "sandbox_mode") && Object.hasOwn(values, "default_permissions"))
    issues.push("Sandbox and permission profile are mutually exclusive: reset one of them in the same save.");
  const bytes = settingsBytes(values);
  if (bytes > settingsByteLimit) issues.push(`The saved document would be ${bytes.toLocaleString()} bytes; the limit is ${settingsByteLimit.toLocaleString()}.`);
  for (const [key, field] of Object.entries(draft)) if (field.kind === "invalid") issues.push(`${key}: ${field.error}`);
  return issues;
}

/** After a save settles, drop only the draft entries that attempt carried; edits made while it was in flight stay. */
export function settleDraft(current: SettingsDraft, attempted: SettingsDraft): SettingsDraft {
  return Object.fromEntries(Object.entries(current).filter(([key, field]) => !sameDraft(field, attempted[key])));
}

/** Keys another writer changed since the draft's baseline, which the draft also edits. */
export function conflictKeys(baseline: Record<string, SettingValue>, current: Record<string, SettingValue>, draft: SettingsDraft): string[] {
  return Object.keys(draft).filter((key) => Object.hasOwn(baseline, key) !== Object.hasOwn(current, key) || !sameValue(baseline[key], current[key]));
}

export type Control =
  | { kind: "boolean" }
  | { kind: "enum"; values: string[] }
  | { kind: "number"; integer: boolean; min: number | null; exclusiveMin: number | null; max: number | null }
  | { kind: "string"; nullable: boolean; minLength: number; maxLength: number | null; multiline: boolean }
  | { kind: "list"; maxItems: number | null; itemMaxLength: number | null; pattern: string | null }
  | { kind: "unknown" };

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** How to edit a value, from the catalog's JSON Schema rather than a copied key inventory. */
export function controlFor(schema: JsonSchema): Control {
  const nullable = Array.isArray(schema.anyOf) && schema.anyOf.some((part) => part.type === "null");
  const base = nullable ? schema.anyOf!.find((part) => part.type !== "null") ?? {} : schema;
  if (base.type === "boolean") return { kind: "boolean" };
  if (Array.isArray(base.enum) && base.enum.every((value) => typeof value === "string")) return { kind: "enum", values: base.enum as string[] };
  if (base.type === "integer" || base.type === "number")
    return { kind: "number", integer: base.type === "integer", min: num(base.minimum), exclusiveMin: num(base.exclusiveMinimum), max: num(base.maximum) };
  if (base.type === "string") {
    const maxLength = num(base.maxLength);
    return { kind: "string", nullable, minLength: num(base.minLength) ?? 0, maxLength, multiline: maxLength === null || maxLength > 4_096 };
  }
  if (base.type === "array" && base.items?.type === "string")
    return { kind: "list", maxItems: num(base.maxItems), itemMaxLength: num(base.items.maxLength), pattern: typeof base.items.pattern === "string" ? base.items.pattern : null };
  return { kind: "unknown" };
}

/** An editing buffer as a field draft. An empty number is invalid, never zero; list lines keep their exact text. */
export function parseInput(control: Control, raw: string): FieldDraft {
  const invalid = (error: string): FieldDraft => ({ kind: "invalid", raw, error });
  switch (control.kind) {
    case "number": {
      if (!raw.trim()) return invalid("Enter a number or choose Unset.");
      const value = Number(raw);
      if (!Number.isFinite(value)) return invalid("Not a number.");
      if (control.integer && !Number.isInteger(value)) return invalid("Must be a whole number.");
      if (control.min !== null && value < control.min) return invalid(`Must be at least ${control.min}.`);
      if (control.exclusiveMin !== null && value <= control.exclusiveMin) return invalid(`Must be greater than ${control.exclusiveMin}.`);
      if (control.max !== null && value > control.max) return invalid(`Must be at most ${control.max}.`);
      return { kind: "set", value };
    }
    case "list": {
      const items = raw.split("\n").filter((line) => line.length > 0);
      if (control.maxItems !== null && items.length > control.maxItems) return invalid(`At most ${control.maxItems} entries.`);
      const pattern = control.pattern ? new RegExp(control.pattern) : null;
      const bad = items.find((item) => (pattern && !pattern.test(item)) || (control.itemMaxLength !== null && item.length > control.itemMaxLength));
      if (bad !== undefined) return invalid(pattern ? `Each entry must match ${control.pattern}: ${bad}` : `Entry too long: ${bad.slice(0, 40)}`);
      return { kind: "set", value: items };
    }
    case "string": {
      if (raw.length < control.minLength) return invalid(control.minLength === 1 ? "Enter a value or choose Unset." : `At least ${control.minLength} characters.`);
      if (control.maxLength !== null && raw.length > control.maxLength) return invalid(`At most ${control.maxLength.toLocaleString()} characters.`);
      return { kind: "set", value: raw };
    }
    default: return { kind: "set", value: raw };
  }
}

/** An editing buffer for a value, the inverse of `parseInput`. */
export function inputText(value: SettingValue | undefined): string {
  if (Array.isArray(value)) return value.join("\n");
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Values are shown literally, so empty string, empty list, false and null stay distinct from each other and from Unset. */
export function formatValue(value: SettingValue): string {
  if (value === null) return "null";
  if (value === "") return "\"\" (empty)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "[] (empty list)";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export type EvidenceText = { text: string; state: SettingEvidence["state"] };

/** `native` means that layer omits the key, not what the runtime chose; `unknown` means nothing usable was observed. */
export function describeEvidence(evidence: SettingEvidence, unset = "Unset", unknown = "Not observed"): EvidenceText {
  if (evidence.state === "known") return { text: formatValue(evidence.value), state: "known" };
  if (evidence.state === "native") return { text: unset, state: "native" };
  return { text: unknown, state: "unknown" };
}

type Field = SettingsView["fields"][number];
type Definition = SettingsCatalog["settings"][number];

export const boundaryTitle: Record<Field["apply"], string> = { "bot-start": "Next start", "voice-call": "Next call", "worker-turn": "Next follow-up or idle application" };

/** Evidence rows worth showing for one field of one target, labelled for where they came from. */
export function evidenceRows(target: SettingsTarget, field: Field | undefined, definition: Definition): Array<{ label: string; evidence: SettingEvidence; unset: string; unknown?: string }> {
  const rows: Array<{ label: string; evidence: SettingEvidence; unset: string; unknown?: string }> = [];
  const defaults = isDefaultsTarget(target);
  if (field && !defaults) {
    const loaded = field.apply === "voice-call" ? "Loaded for this call" : field.apply === "bot-start" ? "Loaded at start" : "Submitted to this Worker";
    rows.push({ label: loaded, evidence: field.loaded, unset: "Omitted" });
    if (field.apply === "bot-start") rows.push({ label: "Native configuration", evidence: field.resolved, unset: "Not reported" });
    if (field.apply !== "voice-call") rows.push({ label: field.apply === "bot-start" ? "Observed on main thread" : "Observed in Worker", evidence: field.effective, unset: "Not reported" });
  }
  rows.push({ label: "Native default", evidence: definition.nativeDefault, unset: "Native default", unknown: "Depends on native resolution" });
  if (!defaults) rows.push({ label: settingsPackage(target) === "bots" ? "Default for new Bots" : "Default for new Workers", evidence: definition.applicationDefault, unset: "Unset" });
  return rows;
}

export type Choice = { value: string; label: string; detail?: string };

type NativeModel = NonNullable<BotSettingsOptions["models"]["data"]>[number];

/** The model an effort or tier choice depends on: the draft's, else the native default model when discovery names one. */
function botModel(options: BotSettingsOptions, values: Record<string, SettingValue>, key: string): { model: NativeModel | null; fallback: boolean } {
  const models = options.models.data ?? [];
  const chosen = values[key];
  if (typeof chosen === "string") return { model: models.find((model) => model.model === chosen || model.id === chosen) ?? null, fallback: false };
  return { model: models.find((model) => model.isDefault) ?? null, fallback: true };
}

/** Native Bot choices from live discovery: null when discovery cannot say, empty when it offers none. */
export function botChoices(definition: Definition, options: BotSettingsOptions | null, values: Record<string, SettingValue>): Choice[] | null {
  if (!options) return null;
  switch (definition.choices) {
    case "models":
      if (!options.models.available) return null;
      return (options.models.data ?? []).map((model) => ({ value: model.model, label: model.displayName || model.model, detail: model.isDefault ? "native default" : undefined }));
    case "efforts": {
      const dependency = definition.dependencies[0] ?? "model";
      const { model, fallback } = botModel(options, values, dependency);
      if (!model) return null;
      return model.supportedReasoningEfforts.map((effort) => ({ value: effort.reasoningEffort, label: effort.reasoningEffort,
        detail: [effort.reasoningEffort === model?.defaultReasoningEffort ? "model default" : null, fallback ? `for ${model?.model}` : null].filter(Boolean).join(" · ") || undefined }));
    }
    case "service-tiers": {
      const { model } = botModel(options, values, "model");
      if (!model) return null;
      return (model.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name || tier.id, detail: tier.description || undefined }));
    }
    case "voices": {
      const voices = options.voices.data?.voices;
      if (!voices) return null;
      const seen = new Set<string>();
      const out: Choice[] = [];
      for (const [list, fallback, family] of [[voices.v2, voices.defaultV2, "v2"], [voices.v1, voices.defaultV1, "v1"]] as const) {
        for (const voice of list) {
          if (seen.has(voice)) continue;
          seen.add(voice);
          out.push({ value: voice, label: voice, detail: voice === fallback ? `${family} default` : family });
        }
      }
      return out;
    }
    default: return null;
  }
}

/** Native Worker choices from an account catalog. Efforts follow the draft's model, else the fallback model. */
export function workerChoices(definition: Definition, catalog: WorkerCatalog | null, values: Record<string, SettingValue>, fallbackModel: string | null): Choice[] | null {
  if (!catalog) return null;
  if (definition.choices === "models") return catalog.models.map((model) => ({ value: model.id, label: model.name || model.id }));
  if (definition.choices === "efforts") {
    const selected = typeof values.model === "string" ? values.model : fallbackModel;
    const model = catalog.models.find((entry) => entry.id === selected);
    if (!model) return null;
    return model.efforts.map((effort) => ({ value: effort, label: effort, detail: typeof values.model === "string" ? undefined : `for ${model.id}` }));
  }
  return null;
}

/** Worker Apply needs fresh evidence of the exact idle session this view describes. */
export function workerApplyBlock(worker: { phase: string; sessionId: string | null; runtimeInstance: string | null } | null, view: SettingsView | null): string | null {
  if (!worker || !view) return "Reading Worker state…";
  if (worker.phase === "closed" || worker.phase === "failed") return "This Worker has no runtime to apply to.";
  if (worker.phase !== "idle") return `Available when idle; the Worker is ${worker.phase.replaceAll("_", " ")}.`;
  if (!worker.sessionId || !worker.runtimeInstance) return "No native session is loaded.";
  if (view.instance !== worker.runtimeInstance) return "The settings read is from another runtime; waiting for a fresh read.";
  return null;
}
