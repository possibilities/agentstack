import { z } from "zod";
import type { SettingEvidence, SettingsBackend, SettingValues } from "./schema.js";

export const CODEX_REVISION = "3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c";
const text = z.string().min(1).max(1_024);
const prompt = z.string().max(262_144);
const tokens = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const effort = z.string().min(1).max(64);
type Definition = { title: string; description: string; group: string; schema: z.ZodType; choices?: "models" | "efforts" | "service-tiers" | "voices" | "native";
  experimental?: boolean; dependencies?: string[] };
const item = (title: string, description: string, group: string, schema: z.ZodType, rest: Partial<Definition> = {}): Definition => ({ title, description, group, schema, ...rest });
export const botDefinitions: Record<string, Definition> = {
  model: item("Model", "Native model identifier. Availability and default depend on the runtime and account.", "Model", text, { choices: "models" }),
  model_reasoning_effort: item("Reasoning effort", "Native reasoning effort; choices depend on the selected model.", "Model", effort, { choices: "efforts", dependencies: ["model"] }),
  service_tier: item("Service tier", "Explicit native service tier. No Fast feature or model policy is enabled implicitly.", "Model", text, { choices: "service-tiers", dependencies: ["model", "features.fast_mode"] }),
  model_context_window: item("Context window", "Requested token budget. Codex owns the model limit and usable headroom.", "Context", tokens),
  model_auto_compact_token_limit: item("Auto-compaction threshold", "Native token threshold; independent of the requested context window.", "Context", tokens),
  model_auto_compact_token_limit_scope: item("Compaction threshold scope", "Apply the native threshold to full context or tokens after the carried prefix.", "Context", z.enum(["total", "body_after_prefix"])),
  model_reasoning_summary: item("Reasoning summaries", "Native reasoning-summary preference; support depends on the model.", "Model", z.enum(["auto", "concise", "detailed", "none"])),
  model_verbosity: item("Verbosity", "Native response text verbosity; support depends on the model.", "Model", z.enum(["low", "medium", "high"])),
  sandbox_mode: item("Sandbox", "Native sandbox mode. Mutually exclusive with a named permission profile.", "Permissions", z.enum(["read-only", "workspace-write", "danger-full-access"]), { dependencies: ["default_permissions"] }),
  approval_policy: item("Approval policy", "Native approval policy. Stack never answers an approval through settings.", "Permissions", z.enum(["untrusted", "on-failure", "on-request", "never"])),
  approvals_reviewer: item("Approval reviewer", "Native reviewer routing, subject to managed requirements.", "Permissions", z.enum(["user", "auto_review", "guardian_subagent"]), { experimental: true }),
  default_permissions: item("Permission profile", "Name of a native built-in or managed permission profile; no profile is synthesized.", "Permissions", text, { choices: "native", dependencies: ["sandbox_mode"] }),
  "sandbox_workspace_write.network_access": item("Workspace network access", "Native workspace-write sandbox network policy.", "Permissions", z.boolean(), { dependencies: ["sandbox_mode"] }),
  "sandbox_workspace_write.writable_roots": item("Writable roots", "Explicit absolute roots for the native workspace-write sandbox.", "Permissions", z.array(z.string().startsWith("/").max(4_096)).max(128), { dependencies: ["sandbox_mode"] }),
  web_search: item("Web search", "Native search mode. This does not configure Role MCP search tools.", "Tools", z.enum(["disabled", "cached", "indexed", "live"])),
  "agents.enabled": item("Native subagents", "Native multi-agent tools. Enabled multi_agent_v2 takes precedence.", "Subagents", z.boolean(), { dependencies: ["features.multi_agent_v2.enabled"] }),
  "agents.default_subagent_model": item("Subagent model", "Native default for children whose spawn request does not choose a model. Not a Stack Worker default.", "Subagents", text, { choices: "models" }),
  "agents.default_subagent_reasoning_effort": item("Subagent effort", "Native default for children without a spawn effort selection.", "Subagents", effort, { choices: "efforts", dependencies: ["agents.default_subagent_model"] }),
  "agents.max_concurrent_threads_per_session": item("Concurrent child threads", "Native concurrency limit; V2-specific selection can override it.", "Subagents", tokens, { dependencies: ["features.multi_agent_v2.max_concurrent_threads_per_session"] }),
  "features.multi_agent_v2.enabled": item("Multi-agent V2", "Explicitly select the native V2 backend; unset retains native selection.", "Subagents", z.boolean(), { experimental: true }),
  "features.multi_agent_v2.max_concurrent_threads_per_session": item("V2 child concurrency", "Native V2-specific thread limit.", "Subagents", tokens, { experimental: true, dependencies: ["features.multi_agent_v2.enabled"] }),
  "features.multi_agent_v2.expose_spawn_agent_model_overrides": item("Child model overrides", "Native V2 spawn model/effort controls. Does not install delegation instructions.", "Subagents", z.boolean(), { experimental: true, dependencies: ["features.multi_agent_v2.enabled"] }),
  ...Object.fromEntries(["hooks", "js_repl", "memories", "chronicle", "fast_mode"].map((name) => [`features.${name}`, item(name.replaceAll("_", " "), "Explicit native feature selection. Unset follows Codex; enabled does not install external resources.", "Features", z.boolean(), { experimental: true })])),
  "features.context_management.experimental_mode": item("Experimental context management", "Explicit native experimental mode. No context budget is selected implicitly.", "Context", z.boolean(), { experimental: true }),
  "voice.voice": item("Voice", "Native voice identifier from thread/realtime/listVoices. Catalog compatibility is not audible confirmation.", "Voice", text, { choices: "voices" }),
  "voice.model": item("Realtime model", "Explicit native realtime model. Ordinary working-agent models are not a realtime model catalog.", "Voice", text, { choices: "native" }),
  "voice.prompt": item("Voice prompt replacement", "Native replacement: a string replaces the prompt, null explicitly clears the configured replacement, reset omits the field. Empty remains an intentional empty string. No append emulation.", "Voice instructions", prompt.nullable()),
  "voice.realtimeStartInstructions": item("Call-start instructions", "Optional native instructions to the working agent when realtime starts. Unset adds nothing.", "Voice instructions", prompt),
  "voice.realtimeEndInstructions": item("Call-end instructions", "Optional native instructions to the working agent when realtime ends. Unset adds nothing.", "Voice instructions", prompt),
  "voice.includeStartupContext": item("Startup context", "Native startup context switch. Unset is omitted; Stack does not reproduce AgentVoice's false default or append-slot behavior.", "Voice", z.boolean()),
  "voice.delegationAckFiller": item("Delegation acknowledgement", "Native speech filler selection; unset follows the native service.", "Voice", z.boolean()),
  "voice.flushTranscriptTailOnSessionEnd": item("Flush transcript tail", "Native end-of-call transcript delivery; may result in working-agent activity after hangup. Unset follows Codex.", "Voice", z.boolean()),
  "voice.codexResponseHandoffMode": item("Response handoff", "Native orchestrator response handoff mode; no client-managed handoff implementation.", "Voice advanced", z.enum(["thinking", "commentary", "bemTags"])),
  "voice.codexResponsesAsItems": item("Responses as items", "Native response-item delivery selection.", "Voice advanced", z.boolean()),
  "voice.codexResponseItemPrefix": item("Response item prefix", "Explicit prefix for native response items.", "Voice advanced", prompt),
};
const workerDefinitions: Record<string, Definition> = {
  model: item("Model", "Account-bound native Worker model. When no saved default exists, worker_start requires an explicit selection.", "Model", z.string().min(1).max(200), { choices: "models" }),
  effort: item("Reasoning effort", "Account/model-bound effort. Required at admission when the native catalog offers effort choices.", "Model", effort, { choices: "efforts", dependencies: ["model"] }),
};
export function definitions(backend: SettingsBackend) { return backend === "codex-app-server" ? botDefinitions : workerDefinitions; }
export function application(key: string, backend: SettingsBackend): "bot-start" | "voice-call" | "worker-turn" {
  return backend !== "codex-app-server" ? "worker-turn" : key.startsWith("voice.") ? "voice-call" : "bot-start";
}
export function evidence(values: SettingValues | null, key: string, source: string, at: number | null = null): SettingEvidence {
  return values === null ? { state: "unknown", value: null, source, observedAt: at }
    : Object.hasOwn(values, key) ? { state: "known", value: values[key], source, observedAt: at }
    : { state: "native", value: null, source, observedAt: at };
}
export function catalog(backend: SettingsBackend, runtime: string | null = null) {
  return { version: 1 as const, backend, runtime, sourceRevision: backend === "codex-app-server" ? CODEX_REVISION : "account-runtime-catalog",
    settings: Object.entries(definitions(backend)).map(([key, def]) => ({ key, title: def.title, description: def.description, group: def.group,
      schema: z.toJSONSchema(def.schema) as Record<string, unknown>, nativeDefault: nativeDefault(key, backend),
      applicationDefault: evidence({}, key, "No Stack override"), apply: application(key, backend), stability: def.experimental || key.startsWith("voice.") ? "experimental" as const : "native" as const,
      choices: def.choices ?? "static" as const, dependencies: def.dependencies ?? [] })),
    resources: [{ name: "Instructions, skills, MCP servers and trusted projects", package: "roles", operation: "role_launch_preview" }],
    limitations: ["Defaults are copied at creation, not live inheritance. Reset removes an override and restores native resolution.",
      "A settings document is limited to 128000 UTF-8 JSON bytes so saved, loaded and default evidence fit in one transport response.",
      "Loaded means submitted at the named boundary; it does not prove native effective behavior.",
      ...(backend === "codex-app-server" ? ["Voice transport remains WebRTC v3/audio. No automatic reconnect, history replay, synthetic child returns, or AgentVoice prompt policy.",
        "Native config and feature discovery do not prove account eligibility. Resumed threads can retain settings independent of process configuration."]
        : ["Codex Workers use OpenCode ACP; they do not accept Codex app-server settings. Permission requests retain their native workflow."])] };
}

function nativeDefault(key: string, backend: SettingsBackend): SettingEvidence {
  // Documented by the pinned protocol/config declarations, rather than a personal client profile.
  const known: SettingValues = { "agents.enabled": true, approvals_reviewer: "user", "voice.includeStartupContext": true,
    "voice.flushTranscriptTailOnSessionEnd": false, "voice.codexResponseHandoffMode": "thinking" };
  return backend === "codex-app-server" && Object.hasOwn(known, key) ? evidence(known, key, `Codex protocol/config ${CODEX_REVISION}`)
    : evidence(null, key, "Native runtime/model resolution; inspect runtime options and native schema");
}
export function validateValues(backend: SettingsBackend, values: SettingValues): SettingValues {
  const defs = definitions(backend);
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(defs, key)) throw new Error(`Unsupported setting: ${key}`);
    const parsed = defs[key].schema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid value for setting: ${key}`);
  }
  if (Object.hasOwn(values, "sandbox_mode") && Object.hasOwn(values, "default_permissions")) throw new Error("sandbox_mode and default_permissions are mutually exclusive");
  if (Buffer.byteLength(JSON.stringify(values)) > 128_000) throw new Error("Settings document exceeds 128000 UTF-8 JSON bytes");
  return values;
}
export function nativeArgs(values: SettingValues): string[] {
  return Object.entries(values).filter(([key]) => !key.startsWith("voice.")).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
export function voiceParams(values: SettingValues): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("voice.")).map(([key, value]) => [key.slice(6), value]));
}
