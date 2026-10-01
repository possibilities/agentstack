import { z } from "zod";
import { CodexToolsDiagnostics, operation, operatorInvocation, withLocalAuth, localOrigin, type PackageApi, type InvocationContext } from "@stack/api";
import { statusSource, type StatusSource } from "./src/status.js";
import { ResourceMonitor } from "./src/resources/monitor.js";
import { serverResourcesInput, serverResourcesOutput, serverResourceHistoryInput, serverResourceHistoryOutput } from "./src/resources/schema.js";
import { serverStateOperations } from "./src/state.js";
import { withStateInventory } from "@stack/api";
import { serverStateCategories } from "./src/state-categories.js";
import { mcpEventRelayInput, relayMcpEvent, workspaceRoot } from "@stack/api";
import { DeveloperService } from "./src/developer/service.js";
import { serveSettings, harnessReleases } from "./src/developer/schema.js";

const childStatusSchema = z.object({
  name: z.string().describe("Required child name."),
  pid: z.number().int().nullable().describe("Process id while running, otherwise null."),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable().describe("Spawn failure message, if any."),
  startedAt: z.iso.datetime().nullable().describe("Time the child's spawn event fired; null if it never spawned."),
  exitedAt: z.iso.datetime().nullable().describe("Time the child exited or its spawn failed; null while running."),
});

export type ServerContext = {
  source: StatusSource;
  resources: ResourceMonitor;
  codexTools: CodexToolsDiagnostics;
  developer: DeveloperService;
  env?: NodeJS.ProcessEnv;
};

const at = z.iso.datetime().nullable().describe("When this observation was recorded; null when it has not been checked since the server started.");
const problem = z.object({
  code: z.enum(["runtime_missing", "config_invalid", "plugin_unavailable", "browser_module_missing", "no_browser", "multiple_browsers", "approval_required", "probe_failed", "probe_timeout"]),
  message: z.string().describe("What was observed, without paths, credentials or raw runtime output."),
  recovery: z.string().describe("The next useful step."),
}).nullable();
const codexToolsStatus = z.object({
  checking: z.object({ startedAt: z.iso.datetime(), chromeBrowser: z.boolean() }).nullable().describe("The check in progress, if any. Observations below are from the previous check until it finishes."),
  checkedAt: at.describe("When the last check finished, successfully or not."),
  runtime: z.object({
    state: z.enum(["not_checked", "found", "missing", "invalid"]),
    source: z.enum(["override", "standalone", "chatgpt-app", "codex-app"]).nullable().describe("Which runtime candidate was selected, from STACK_CODEX_TOOLS_BIN or the desktop installations."),
    checkedAt: at, problem,
  }).describe("The selected desktop installation's tool runtime."),
  connections: z.array(z.object({
    name: z.string().describe("Stable connection key, as in Role MCP switches."),
    title: z.string(), description: z.string(), upstream: z.string().describe("The upstream Codex source this bridge forwards to."),
    catalog: z.object({
      state: z.enum(["not_checked", "available", "unavailable", "failed"]).describe("available means the upstream catalog listed the connection; it does not prove a consumer connected, an app or site is approved, or Computer History is recording. failed means the check itself failed."),
      checkedAt: at, tools: z.number().int().nullable().describe("Tools this bridge exposes when available."),
      evidence: z.string().nullable().describe("What was actually observed."), problem,
    }),
    browser: z.object({
      state: z.enum(["not_checked", "connected", "none", "multiple", "failed"]).describe("connected means the Chrome extension listed exactly one Chrome browser. Only a check with chromeBrowser asks."),
      checkedAt: at, evidence: z.string().nullable(), problem,
    }).nullable().describe("Chrome only; null for other connections."),
  })),
});

export const serverLocalConnect = operation({
  name: "serve_local_connect", description: "Private-socket-only operator bootstrap. Mint a 60-second single-use browser capability, bound to the exact local UI or Inspector origin. The returned fragment URL is a secret; never log or put it in discovery. The CLI opens it directly. An explicit UI origin is allowed only for the configured development WebSocket origin.",
  input: z.strictObject({ target: z.enum(["ui", "inspector"]).default("ui"), origin: z.string().optional() }),
  output: z.strictObject({ url: z.string(), expiresInSeconds: z.literal(60) }),
  async call(ctx: ServerContext, input, invocation) {
    if (invocation) throw new Error("local bootstrap requires private socket authority");
    const env = ctx.env ?? process.env;
    const origin = input.origin ?? `http://127.0.0.1:${input.target === "ui" ? env.STACK_UI_PORT ?? 8745 : env.STACK_INSPECTOR_PORT ?? 6274}`;
    localOrigin(origin);
    if (input.origin && !(input.target === "ui" && input.origin === env.STACK_WEBSOCKET_ORIGIN)) throw new Error("development origin is not configured");
    const token = withLocalAuth(env, auth => auth.bootstrap(origin, input.target));
    return { url: `${origin}/connect/local#${token}`, expiresInSeconds: 60 as const };
  },
});
export const serverLocalRevoke = operation({
  name: "serve_local_revoke", description: "Private-socket-only local revocation. Rotates external HTTP and private stdio operator credentials and deletes browser sessions, bootstraps and WebSocket tickets. Active connections and offline opted reads are fenced. Existing pipes never renew credentials; relaunch native operator clients. Remote Access grants and signed Bot/Worker identities are independent.",
  input: z.strictObject({}), output: z.strictObject({ revoked: z.literal(true) }),
  async call(ctx: ServerContext, _input, invocation) {
    if (invocation) throw new Error("local revocation requires private socket authority");
    withLocalAuth(ctx.env ?? process.env, auth => auth.rotate());
    return { revoked: true as const };
  },
});

export const serverStatus = operation({
  name: "serve_status",
  description: "Read the server process, its start time and runtime, its local URLs, and each required child's status: pid, running, start/exit times, exit code, signal, and spawn error.",
  input: z.strictObject({}),
  output: z.object({
    pid: z.number().int().describe("Server process id."),
    startedAt: z.iso.datetime().describe("Time the server process started."),
    nodeVersion: z.string().describe("Node.js version string of the server process."),
    indexUrl: z.string().nullable().describe("Loopback UI entry URL for the Fleet bench while the server runs it."),
    uiUrl: z.string().nullable().describe("Loopback UI canvas URL at / while the server runs it."),
    inspectorUrl: z.string().nullable().describe("Loopback Inspector URL while the server runs it."),
    mcpUrls: z.record(z.string(), z.string()).describe("External-consumer loopback HTTP MCP URLs by fleet connection name. Internal launches use stdio."),
    children: z.array(childStatusSchema),
  }),
  annotations: { title: "Server status", readOnlyHint: true },
  async call(ctx: ServerContext) {
    return ctx.source.snapshot();
  },
});

export const serverMcpEvent = operation({
  name: "serve_mcp_event", description: "Private-socket-only generated MCP event relay to the sole subscription owner. Independently verifies the signed Bot launch and sanctioned per-call thread. Never exposed through MCP or WebSocket.",
  input: mcpEventRelayInput, output: z.record(z.string(), z.unknown()),
  async call(ctx: ServerContext, input, invocation) {
    if (invocation) throw new Error("MCP event relay requires the private socket");
    if (!ctx.source.subscriptions) throw new Error("subscription owner is unavailable");
    return await relayMcpEvent(ctx.source.subscriptions, input, workspaceRoot(import.meta.dirname), ctx.env ?? process.env) as Record<string, unknown>;
  },
});

export const serverCodexTools = operation({
  name: "serve_codex_tools",
  description: "Read cached observations of the Codex tool bridges: the selected desktop runtime, each upstream catalog and Chrome's last browser discovery. Reading starts nothing. They describe the installation, not whether a Bot or Worker connected or can answer approvals, and reset when the server restarts.",
  input: z.strictObject({}), output: codexToolsStatus,
  annotations: { title: "Codex tools status", readOnlyHint: true },
  async call(ctx: ServerContext) { return ctx.codexTools.snapshot(); },
});

export const serverCodexToolsCheck = operation({
  name: "serve_codex_tools_check",
  description: "Start one bounded check and return on admission; codex_tools_changed follows. A temporary app-server lists upstream catalogs on an ephemeral thread, starts no model turn, cancels any approval and exits. chromeBrowser also lists Chrome extension browsers without reading a page. A request during a check joins it. A failed check replaces earlier results.",
  input: z.strictObject({ chromeBrowser: z.boolean().default(false).describe("Also ask the Chrome extension which Chrome browsers are connected.") }),
  output: z.object({ admitted: z.boolean().describe("False when a check was already running."), status: codexToolsStatus }),
  annotations: { title: "Check Codex tools", openWorldHint: true },
  async call(ctx: ServerContext, input) { return ctx.codexTools.check(input); },
});

export const serverResources = operation({
  name: "serve_resources",
  description: "Read cached CPU, memory and process-tree observations for Stack, components, Bots, accounts, observed Worker runtimes or individual processes/subtrees. Pin snapshotId when paging. Costs overlap across scope kinds; RSS is not unique RAM. Unknown/expired IDs are errors. No collection is triggered by a read.",
  input: serverResourcesInput, output: serverResourcesOutput,
  annotations: { title: "Server resource snapshot", readOnlyHint: true },
  async call(ctx: ServerContext, input) { return ctx.resources.resources(input); },
});

export const serverResourceHistory = operation({
  name: "serve_resource_history",
  description: "Read bounded in-memory resource history for one returned scope ID (default total), oldest first. Failed attempts are explicit gaps, absent scopes are null, retention may shorten under process pressure. Shared runtimes cannot allocate costs to Worker sessions or chats.",
  input: serverResourceHistoryInput, output: serverResourceHistoryOutput,
  annotations: { title: "Server resource history", readOnlyHint: true },
  async call(ctx: ServerContext, input) { return ctx.resources.history(input); },
});

function requireDeveloperOperator(invocation?: InvocationContext): void {
  if (!operatorInvocation(invocation)) throw new Error("developer controls require local operator authority");
}

export const serverSettingsRead = operation({
  name: "serve_settings_read",
  description: "Read durable global Server settings without starting work. developerMode defaults to false. These settings are independent of Bot and Worker managed runtime settings.",
  input: z.strictObject({}), output: serveSettings,
  annotations: { title: "Server settings", readOnlyHint: true },
  async call(ctx: ServerContext, _input, invocation) { requireDeveloperOperator(invocation); return ctx.developer.settings(); },
});

export const serverSettingsUpdate = operation({
  name: "serve_settings_update",
  description: "Save and apply developerMode at its exact observed revision. Enabling schedules a due upstream release check; disabling aborts and fences checks and recurrence while retaining the cache. A stale revision fails; read settings before retrying. An unchanged value at the current revision is a no-op.",
  input: z.strictObject({ developerMode: z.boolean(), expectedRevision: z.number().int().nonnegative() }), output: serveSettings,
  annotations: { title: "Update server settings" },
  async call(ctx: ServerContext, input, invocation) { requireDeveloperOperator(invocation); return ctx.developer.update(input); },
});

export const serverHarnessReleases = operation({
  name: "serve_harness_releases",
  description: "Read cached public upstream releases for OpenCode, Codex, Claude Code and Devin CLI. Refuses while developer mode is disabled. Starts no network or processes. Last good versions survive failure and restart with explicit stale/error state. Changes are observed channel differences, not upgrade verdicts or comparisons to installed, SDK or Stack fork versions.",
  input: z.strictObject({}), output: harnessReleases,
  annotations: { title: "Harness releases", readOnlyHint: true },
  async call(ctx: ServerContext, _input, invocation) { requireDeveloperOperator(invocation); return ctx.developer.snapshot(); },
});

export const serverHarnessReleasesCheck = operation({
  name: "serve_harness_releases_check",
  description: "Admit a public upstream check and return immediately; concurrent calls join with admitted false. Requires developer mode. Automatic checks run every six hours; missed intervals coalesce. Fixed channels have 15-second/256-KiB limits. Per-harness failures retain last good values. No installed-version probes, upgrades, installs, authentication, browsers or model turns.",
  input: z.strictObject({}), output: z.strictObject({ admitted: z.boolean(), startedAt: z.iso.datetime().describe("Start of the admitted or already-running check. Read serve_harness_releases for outcomes.") }),
  annotations: { title: "Check harness releases", openWorldHint: true },
  async call(ctx: ServerContext, _input, invocation) { requireDeveloperOperator(invocation); return ctx.developer.check(); },
});

export const topics = {
  serve_state_changed: "Durable operator-managed subscription state changed. Refresh serve_subscription_list and affected state inventories; no payloads are included.",
  pids_changed: "Published when the set of owned child process ids changes.",
  codex_tools_changed: "Published when a Codex tools check starts or finishes. Refresh serve_codex_tools.",
  resources_changed: "Published after a resource sampling attempt, including failures. Refresh serve_resources or serve_resource_history; notices carry no metrics.",
  serve_settings_changed: "Global Server settings changed. Refresh serve_settings_read; disabling developer mode makes release reads and checks unavailable.",
  harness_releases_changed: "A release check started, advanced, finished or was interrupted. Refresh serve_harness_releases only while developer mode is enabled; notices carry no observations.",
} as const;

export type ServerTopic = keyof typeof topics;

const packageApi: PackageApi<ServerContext, ServerTopic> = {
  operations: [...serverStateOperations, serverStatus, serverCodexTools, serverCodexToolsCheck, serverResources, serverResourceHistory, serverLocalConnect, serverLocalRevoke, serverMcpEvent,
    serverSettingsRead, serverSettingsUpdate, serverHarnessReleases, serverHarnessReleasesCheck],
  events: {
    topics,
    start(ctx: ServerContext, publish: (topic: ServerTopic) => void) {
      ctx.source.onChange = () => publish("pids_changed");
      ctx.source.onStateChange = () => publish("serve_state_changed");
      ctx.resources.onChange = () => publish("resources_changed");
      ctx.codexTools.onChange = () => publish("codex_tools_changed");
      ctx.developer.onSettingsChange = () => publish("serve_settings_changed");
      ctx.developer.onReleasesChange = () => publish("harness_releases_changed");
      return () => {
        ctx.source.onChange = undefined;
        ctx.source.onStateChange = undefined;
        ctx.resources.onChange = undefined;
        ctx.codexTools.onChange = undefined;
        ctx.developer.onSettingsChange = undefined;
        ctx.developer.onReleasesChange = undefined;
      };
    },
  },
  async createContext(env) {
    const developer = new DeveloperService(env);
    const resources = new ResourceMonitor({ roots: () => statusSource.resourceRoots(), env });
    resources.start();
    developer.start();
    return { source: statusSource, resources, codexTools: new CodexToolsDiagnostics(env), developer, env };
  },
  async closeContext(ctx) {
    await Promise.all([ctx.resources.close(), ctx.codexTools.close(), ctx.developer.close()]);
    ctx.source.detach();
  },
};
export const api = withStateInventory("serve", serverStateCategories, packageApi);
