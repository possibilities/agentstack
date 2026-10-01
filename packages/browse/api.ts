import { z } from "zod";
import { operation, stateDependencies, stateDependencyInput, stateHash, requireStateOperator, type PackageApi } from "@stack/api";
import { Backend, cleanupSchema } from "./src/backend.js";
import { BrowserSystem } from "./src/system.js";
import { Profiles, profileSchema, bindingSchema } from "./src/profiles.js";
import { handoffSchema, handoffRequestSchema, handoffActionSchema, completionInput } from "./src/handoff.js";
import { egressPolicy } from "@stack/scrape/network";
import { withStateInventory } from "@stack/api";
import { browseStateCategories } from "./src/state-categories.js";
import { BrowseState, browseStateOperations } from "./src/state.js";

export type BrowserContext = { backend: Backend; system: BrowserSystem; profiles: Profiles; state: BrowseState };
export const browseBotDependencies = operation({ name: "browse_bot_dependencies", description: "Inspect Bot-bound profiles, controllers and unresolved human handoffs for a maintenance plan. Close selected controllers and resolve handoffs explicitly first. Profile data and resolved handoff history survive a Bot conversation reset.",
  input: stateDependencyInput, output: stateDependencies, annotations: { readOnlyHint: true },
  async call(ctx: BrowserContext, { botId }, invocation) {
    requireStateOperator(invocation);
    const profiles = ctx.profiles.list().filter(row => row.botId === botId);
    const bindings = ctx.profiles.bindings().filter(row => row.botId === botId);
    const handoffs = ctx.profiles.handoffs(null).filter(row => row.botId === botId && row.state !== "resolved");
    return { revision: stateHash([profiles.map(row => [row.id, row.default]), bindings.map(row => [row.session, row.instance, row.revision, row.state]), handoffs.map(row => [row.id, row.revision])]),
      blockedBy: [...bindings.filter(row => row.state !== "disconnected").map(row => `Close Browser controller ${row.session} before Bot maintenance`),
        ...handoffs.map(row => `Resolve Browser handoff ${row.id} before Bot maintenance`)],
      retained: profiles.map(row => `Browser profile ${row.id}: cookies, site data, tabs and history remain`),
      relationships: profiles.map(row => ({ relation: "profile", package: "browse", kind: "browser-profile", id: row.id })) };
  } });
export const browserResearchAcquire = operation({
  name: "browser_research_acquire", description: "Internal Scrape-only socket admission of a disposable research browser. Installs guest-wide public-only egress plus exact TCP IP/port exceptions before Chrome starts. Never reuses unrestricted or signed-in profiles. Missing firewall support fails closed; guest egress expires after five minutes.",
  input: z.strictObject({ session: z.uuid(), policy: egressPolicy }),
  output: z.strictObject({ cdpUrl: z.string(), cleanup: cleanupSchema, enforcement: z.literal("guest-output-v1") }),
  async call(ctx: BrowserContext, { session, policy }, invocation) {
    if (invocation) throw new Error("research browser requires internal socket authority");
    try { return { ...await ctx.backend.launch(`research-${session}`, false, policy), enforcement: "guest-output-v1" as const }; }
    catch { throw new Error("browser_egress_unverifiable"); }
  },
});
export const browserHandoffRequest = operation({
  name: "browser_handoff_request", description: "Hold the entire own browser profile for human help. Origin is the invoking sanctioned Chat. Subscribe first to browser_handoffs_changed using browser_handoff_completion with this requestId, botId and threadId; inspect the subscribe initial value. Admission immediately fences managed automation; awaiting_human means CDP drained. A pending issue never grants human input.",
  input: handoffRequestSchema, output: handoffSchema,
  annotations: { title: "Request browser handoff", idempotentHint: true },
  async call(ctx: BrowserContext, input, invocation) { return ctx.profiles.requestHandoff(input, invocation); },
});
export const browserHandoffList = operation({
  name: "browser_handoff_list", description: "List durable browser handoffs. Verified Bot callers see only their own Bot; local operators see all. Runtime issues are separate from human outcomes.",
  input: z.strictObject({}), output: z.strictObject({ handoffs: z.array(handoffSchema) }), annotations: { title: "List browser handoffs", readOnlyHint: true },
  async call(ctx: BrowserContext, _input, invocation) { return { handoffs: ctx.profiles.handoffs(await ctx.profiles.caller(invocation)) }; },
});
export const browserHandoffGet = operation({
  name: "browser_handoff_get", description: "Read one own Bot handoff, including pending issues and its revision. Local operators can inspect any handoff. Completion is a human report; reconnect and take a fresh browser snapshot to verify it.",
  input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ handoff: handoffSchema.nullable() }), annotations: { title: "Read browser handoff", readOnlyHint: true },
  async call(ctx: BrowserContext, input, invocation) { return { handoff: ctx.profiles.handoffs(await ctx.profiles.caller(invocation)).find((h) => h.id === input.id) ?? null }; },
});
export const browserHandoffCompletion = operation({
  name: "browser_handoff_completion", description: "Stable completion-only projection for existing MCP event subscriptions. Returns null before request admission and throughout all pending states; resolved returns the durable human result. Subscribe before requesting using the same requestId. Bot/thread arguments must match the invoking Chat; a result in the subscribe initial value is already completed work to inspect, not a future wakeup.",
  input: completionInput, output: z.strictObject({ result: handoffSchema.nullable() }), annotations: { title: "Read browser handback", readOnlyHint: true },
  async call(ctx: BrowserContext, input, invocation) {
    if (invocation) {
      const caller = await ctx.profiles.origin(invocation);
      if (caller.botId !== input.botId || caller.threadId !== input.threadId) throw new Error("completion read belongs to another Chat");
    }
    return { result: ctx.profiles.handoffs(null).find((h) => h.botId === input.botId && h.threadId === input.threadId && h.requestId === input.requestId && h.state === "resolved") ?? null };
  },
});
const handoffActionOutput = z.strictObject({ handoff: handoffSchema, controlUrl: z.string().nullable() });
export const browserHandoffTake = operation({
  name: "browser_handoff_take", description: "Local human operator takes an awaiting handoff. Issues a server-enforced managed Neko input grant. expectedRevision rejects stale input; retry the same requestId and identical arguments after an uncertain response. Closing the viewer never resolves a handoff.",
  input: handoffActionSchema, output: handoffActionOutput, annotations: { title: "Take browser control", idempotentHint: true },
  async call(ctx: BrowserContext, input, invocation) { return ctx.profiles.actHandoff("take", input, invocation); },
});
export const browserHandoffFinish = operation({
  name: "browser_handoff_finish", description: "Local human operator reports completed or skipped, optionally with a note, from awaiting_human or human_controlling. Return revokes input sessions and invalidates agent refs before resolution. Pending returning issues keep automation fenced; retry the exact action to recover. Completed is a report, not automated verification.",
  input: handoffActionSchema.extend({ outcome: z.enum(["completed", "skipped"]), note: z.string().max(4000).optional() }), output: handoffActionOutput, annotations: { title: "Finish browser handoff", idempotentHint: true },
  async call(ctx: BrowserContext, input, invocation) { return ctx.profiles.actHandoff("finish", input, invocation); },
});
export const browserHandoffCancel = operation({
  name: "browser_handoff_cancel", description: "Originating sanctioned Chat cancels its own handoff only before human take. Managed automation resumes only after proven drain, input revocation and controller disconnect. Cancellation cannot discard an unknown pending CDP operation.",
  input: handoffActionSchema, output: handoffActionOutput, annotations: { title: "Cancel browser handoff", idempotentHint: true },
  async call(ctx: BrowserContext, input, invocation) { return ctx.profiles.actHandoff("cancel", input, invocation); },
});
const sessionInput = z.strictObject({ session: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/) });
const sessionOutput = z.strictObject({
  session: z.string(), profile: z.string(), lease: z.string(), persistent: z.boolean(),
  createdAt: z.string(), state: z.enum(["reserved", "running"]),
  egress: egressPolicy.nullable(),
  target: z.strictObject({ name: z.string(), backend: z.string() }).nullable(),
});
const sessionOf = (row: Awaited<ReturnType<Backend["get"]>>) => row && ({
  session: row.session, profile: row.profile, lease: row.lease, persistent: row.persistent,
  createdAt: row.createdAt, state: row.target ? "running" as const : "reserved" as const, target: row.target,
  egress: row.egress ?? null,
});

export const browserSessionGet = operation({
  name: "browser_session_get",
  description: "Read a provider task's durable reservation without launching a browser. Null means no active or failed reservation; a reserved row may represent an incomplete launch.",
  input: sessionInput, output: z.strictObject({ session: sessionOutput.nullable() }),
  annotations: { title: "Inspect browser reservation", readOnlyHint: true },
  async call(ctx: BrowserContext, input) { const row = await ctx.backend.get(input.session); return { session: row?.persistent ? null : sessionOf(row) }; },
});
export const browserSessionList = operation({
  name: "browser_session_list",
  description: "Inspect this provider's durable disposable session reservations, including unfinished launches. This does not prove a daemon still drives a target.",
  input: z.strictObject({}), output: z.strictObject({ sessions: z.array(sessionOutput) }),
  annotations: { title: "List browser reservations", readOnlyHint: true },
  async call(ctx: BrowserContext) { return { sessions: (await ctx.backend.list()).filter((row) => !row.persistent).map((row) => sessionOf(row)!) }; },
});
export const browserSessionClose = operation({
  name: "browser_session_close",
  description: "Internal provider close of the exact disposable target and incarnation in its cleanup receipt. A stale or mismatched receipt cannot close its replacement; failure retains the lease for recovery.",
  input: z.strictObject({ cleanup: cleanupSchema }), output: z.strictObject({ closed: z.literal(true) }),
  annotations: { title: "Close disposable browser", idempotentHint: true, destructiveHint: true },
  async call(ctx: BrowserContext, input) {
    if ((await ctx.backend.list()).find((row) => row.session === input.cleanup.session)?.persistent) throw new Error("durable profiles require browser_profile_delete");
    return ctx.backend.close(input.cleanup);
  },
});
export const browserSessionReconcile = operation({
  name: "browser_session_reconcile",
  description: "Explicitly dispose a failed, unlaunched reservation after verifying its exact lease and all owned Hypeman resources. Completed launches must use their cleanup receipt.",
  input: z.strictObject({ session: z.string().regex(/^ast-[a-f0-9]{28}$/), lease: z.string().regex(/^[a-f0-9]{32}$/) }),
  output: z.strictObject({ closed: z.literal(true) }),
  annotations: { title: "Reconcile failed browser launch", destructiveHint: true },
  async call(ctx: BrowserContext, input) {
    if ((await ctx.backend.list()).find((row) => row.session === input.session)?.persistent) throw new Error("durable profiles require browser_profile_delete");
    return ctx.backend.reconcile(input.session, input.lease);
  },
});
export const browserStatus = operation({
  name: "browser_status",
  description: "Read the provider policy and durable reservation count. This does not probe Hypeman availability or guarantee launch capacity.",
  input: z.strictObject({}), output: z.strictObject({ provider: z.literal("hypeman"), mode: z.literal("durable"), sessions: z.number().int().nonnegative(), profiles: z.number().int().nonnegative() }),
  annotations: { title: "Browser lifecycle status", readOnlyHint: true },
  async call(ctx: BrowserContext) { return { ...await ctx.backend.status(), mode: "durable" as const, profiles: ctx.profiles.list().length }; },
});

export const browserProfileList = operation({
  name: "browser_profile_list", description: "List durable profiles and last observed runtime health. Verified Bot MCP callers see only their own profiles; local operators also see other Bots and retained unassigned profiles. Observation follows the visible tab; delivery is not probed by this read.",
  input: z.strictObject({}), output: z.strictObject({ profiles: z.array(profileSchema) }), annotations: { readOnlyHint: true },
  async call(ctx: BrowserContext, _input, invocation) {
    const caller = await ctx.profiles.caller(invocation);
    return { profiles: ctx.profiles.list().filter((profile) => !caller || profile.botId === caller.botId) };
  },
});
export const browserProfileCreate = operation({
  name: "browser_profile_create", description: "Admit an empty additional durable profile. Verified Bot MCP callers must name their own botId; local operators may name another existing Bot or null for unassigned. Startup is asynchronous; read state for readiness. Never clones or imports sign-ins.",
  input: z.strictObject({ botId: z.string().nullable(), label: z.string().min(1).max(128) }), output: profileSchema,
  async call(ctx: BrowserContext, input, invocation) { return ctx.profiles.create(input.botId, input.label, false, await ctx.profiles.caller(invocation)); },
});
export const browserProfileDelete = operation({
  name: "browser_profile_delete", description: "Permanently delete an unselected profile and its exact owned VM and volume. Verified Bot MCP callers may delete only their own profiles. Refuses an assigned default; Bot deletion only unassigns it. Discards sign-ins and stored browser data.",
  input: z.strictObject({ profileId: z.uuid(), confirm: z.literal("delete") }), output: z.strictObject({ deleted: z.literal(true) }), annotations: { destructiveHint: true },
  async call(ctx: BrowserContext, input, invocation) { return ctx.profiles.remove(input.profileId, await ctx.profiles.caller(invocation)); },
});
export const browserControllerList = operation({
  name: "browser_controller_list", description: "Read controller selections and last confirmed bindings. Verified Bot MCP callers see only their current-launch controllers; local operators see all. Connected is a timestamped observation, not a liveness guarantee; unknown never asserts attachment.",
  input: z.strictObject({}), output: z.strictObject({ controllers: z.array(bindingSchema) }), annotations: { readOnlyHint: true },
  async call(ctx: BrowserContext, _input, invocation) {
    const caller = await ctx.profiles.caller(invocation);
    return { controllers: ctx.profiles.bindings().filter((binding) => !caller || (binding.botId === caller.botId && binding.instance === caller.instance)) };
  },
});
export const browserControllerSelect = operation({
  name: "browser_controller_select", description: "Select one exclusively assigned profile for a live Bot's controller session. Serialize native reconnect with its page commands, invalidate old refs, and read back actual CDP binding and active target. An unknown result reports failure without claiming the switch succeeded. Other controllers remain independent.",
  input: z.strictObject({ botId: z.string(), session: sessionInput.shape.session.default("default"), profileId: z.uuid() }), output: bindingSchema,
  async call(ctx: BrowserContext, input, invocation) {
    return ctx.profiles.select(input.botId, input.session, input.profileId, await ctx.profiles.caller(invocation));
  },
});
export const browserControllerLaunch = operation({
  name: "browser_controller_launch", description: "Internal provider admission under a signed, live Bot launch proof. Return the controller's selected durable profile, defaulting to this Bot's exclusive default. Admission is not proof of connection.",
  input: z.strictObject({ identity: z.string(), session: sessionInput.shape.session }),
  output: z.strictObject({ cdpUrl: z.string(), cleanup: z.strictObject({ controller: z.string(), revision: z.number().int() }) }),
  async call(ctx: BrowserContext, input) { return ctx.profiles.launch(input.identity, input.session); },
});
export const browserControllerClose = operation({
  name: "browser_controller_close", description: "Internal provider disconnect notice for one controller revision. Never deletes, stops, or unassigns its durable browser profile.",
  input: z.strictObject({ controller: z.string(), revision: z.number().int() }), output: z.strictObject({ closed: z.literal(true) }),
  async call(ctx: BrowserContext, input) { return ctx.profiles.disconnected(input.controller, input.revision); },
});
export const browserBotRelease = operation({
  name: "browser_bot_release", description: "Owner-internal Bot deletion/ID-reuse fence: retain all profiles unassigned and disconnect the retired Bot's controllers without deleting browser data.",
  input: z.strictObject({ botId: z.string() }), output: z.strictObject({ released: z.literal(true) }),
  async call(ctx: BrowserContext, input) { return ctx.profiles.releaseBot(input.botId); },
});
const browserToolOutput = z.strictObject({
  installed: z.boolean(), version: z.string().nullable(), location: z.string().nullable(),
  latest: z.string().nullable(), pending: z.string().nullable(), checkedAt: z.string().nullable(),
  checkError: z.string().nullable(), policy: z.enum(["manual", "automatic"]),
});
const hypemanInstallation = z.strictObject({
  root: z.string(), installed: z.boolean(), selected: z.boolean(),
  source: z.enum(["stack", "legacy", "custom"]), running: z.boolean(), issue: z.string().nullable(),
});
const hypemanInstallations = z.strictObject({ installations: z.array(hypemanInstallation) });
export const browserToolStatus = operation({
  name: "agent_browser_status", description: "Read the managed agent-browser version, observed latest release, pending update, observation issue and manual/automatic update policy. No network request.",
  input: z.strictObject({}), output: browserToolOutput,
  annotations: { title: "Agent-browser installation and updates", readOnlyHint: true },
  async call(ctx: BrowserContext) { return ctx.system.browserStatus(); },
});
export const browserToolDetect = operation({
  name: "agent_browser_detect", description: "Detect Stack's private agent-browser installation and the legacy AgentStart command without changing either.",
  input: z.strictObject({}), output: z.strictObject({ installations: z.array(z.strictObject({ location: z.string(), version: z.string().nullable(), source: z.enum(["stack", "agentstart"]) })) }),
  annotations: { title: "Detect agent-browser", readOnlyHint: true },
  async call(ctx: BrowserContext) { return { installations: await ctx.system.browserDetect() }; },
});
export const browserToolCheck = operation({
  name: "agent_browser_check_updates", description: "Query npm's latest stable agent-browser release and refresh pending-update status. Under automatic policy an observed newer release is installed.",
  input: z.strictObject({}), output: browserToolOutput,
  annotations: { title: "Check agent-browser releases" },
  async call(ctx: BrowserContext) { return ctx.system.checkUpdates(); },
});
export const browserToolPolicy = operation({
  name: "agent_browser_update_policy_set", description: "Select manual review or opt-in automatic installation after each periodic release check.",
  input: z.strictObject({ policy: z.enum(["manual", "automatic"]) }), output: browserToolOutput,
  annotations: { title: "Set browser update policy" },
  async call(ctx: BrowserContext, input) { return ctx.system.setUpdatePolicy(input.policy); },
});
export const browserToolInstall = operation({
  name: "agent_browser_install", description: "Install an exact agent-browser release into Stack's private toolchain. Never overwrites an independent global installation.",
  input: z.strictObject({ version: z.string().min(1) }), output: browserToolOutput,
  annotations: { title: "Install agent-browser" },
  async call(ctx: BrowserContext, input) { return ctx.system.installBrowser(input.version); },
});
export const browserToolAccept = operation({
  name: "agent_browser_update_accept", description: "Accept and install the exact current pending release. Reject a stale decision after a newer observation.",
  input: z.strictObject({ version: z.string().min(1) }), output: browserToolOutput,
  annotations: { title: "Accept browser update" },
  async call(ctx: BrowserContext, input) { return ctx.system.acceptUpdate(input.version); },
});
export const browserToolUninstall = operation({
  name: "agent_browser_uninstall", description: "Disable the Stack-managed agent-browser binary without removing a foreign or AgentStart-owned executable.",
  input: z.strictObject({}), output: browserToolOutput,
  annotations: { title: "Uninstall managed agent-browser", destructiveHint: true },
  async call(ctx: BrowserContext) { return ctx.system.uninstallBrowser(); },
});
export const hypemanDetect = operation({
  name: "hypeman_detect", description: "Detect the Stack-managed, legacy local Mac, and explicitly configured Hypeman roots. Probes only loopback; never contacts Artbird.",
  input: z.strictObject({}), output: hypemanInstallations,
  annotations: { title: "Detect local Hypeman", readOnlyHint: true },
  async call(ctx: BrowserContext) { return { installations: await ctx.system.detectHypeman() }; },
});
export const hypemanLocationSet = operation({
  name: "hypeman_location_set", description: "Remember an absolute, nonstandard local Hypeman installation directory for detection; does not enable it.",
  input: z.strictObject({ root: z.string().min(1) }), output: hypemanInstallations,
  annotations: { title: "Set Hypeman search location" },
  async call(ctx: BrowserContext, input) { return { installations: await ctx.system.setHypemanLocation(input.root) }; },
});
export const hypemanEnable = operation({
  name: "hypeman_enable", description: "Select a detected, same-user local Hypeman root for the browser provider, or null to disable it. Refuses non-loopback connection descriptors.",
  input: z.strictObject({ root: z.string().nullable() }), output: hypemanInstallations,
  annotations: { title: "Select local Hypeman" },
  async call(ctx: BrowserContext, input) {
    if (((await ctx.backend.status()).sessions || ctx.profiles.list().length) && input.root !== ctx.system.selectedHypemanRoot() && ctx.system.selectedHypemanRoot() !== null)
      throw new Error("close or reconcile browser reservations before changing local Hypeman");
    return { installations: await ctx.system.enableHypeman(input.root) };
  },
});
export const hypemanInstall = operation({
  name: "hypeman_install", description: "Install the checksum-verified local Hypeman release in Stack state. Does not select it or modify the legacy Mac installation.",
  input: z.strictObject({}), output: hypemanInstallations,
  annotations: { title: "Install local Hypeman" },
  async call(ctx: BrowserContext) { return { installations: await ctx.system.installHypeman() }; },
});
export const hypemanUninstall = operation({
  name: "hypeman_uninstall", description: "Uninstall only stopped, disabled Stack-owned Hypeman with no browser reservations. Its images and state are discarded only after explicit confirmation; independent installations are never removed.",
  input: z.strictObject({ discardData: z.boolean() }), output: hypemanInstallations,
  annotations: { title: "Uninstall local Hypeman", destructiveHint: true },
  async call(ctx: BrowserContext, input) { return { installations: await ctx.system.uninstallHypeman(input.discardData) }; },
});
export const topics = {
  browser_handoffs_changed: "A browser handoff changed. For Chat wakeups subscribe with browser_handoff_completion and the originating botId, threadId and requestId; its stable pending value suppresses intermediate turns.",
  browser_profiles_changed: "Durable browser profiles, health observations or controller bindings changed. Re-read browser_profile_list and browser_controller_list.",
  browser_system_changed: "Installation, update observation, update policy or selected local Hypeman root changed. Re-read agent_browser_status and hypeman_detect.",
  browser_sessions_changed: "A disposable browser reservation changed. Re-read browser_session_list; this does not prove a daemon is still driving it.",
} as const;
const packageApi: PackageApi<BrowserContext, keyof typeof topics> = {
  operations: [...browseStateOperations, browseBotDependencies, browserStatus, browserProfileList, browserProfileCreate, browserProfileDelete, browserControllerList, browserControllerSelect, browserControllerLaunch, browserControllerClose, browserBotRelease,
    browserHandoffRequest, browserHandoffGet, browserHandoffList, browserHandoffCompletion, browserHandoffTake, browserHandoffFinish, browserHandoffCancel,
    browserSessionGet, browserSessionList, browserSessionClose, browserSessionReconcile, browserResearchAcquire,
    browserToolStatus, browserToolDetect, browserToolCheck, browserToolPolicy, browserToolInstall, browserToolAccept, browserToolUninstall,
    hypemanDetect, hypemanLocationSet, hypemanEnable, hypemanInstall, hypemanUninstall],
  events: { topics, start(ctx, publish) {
    ctx.system.onChange = () => publish("browser_system_changed");
    ctx.backend.onChange = () => publish("browser_sessions_changed");
    ctx.profiles.onChange = () => publish("browser_profiles_changed");
    ctx.profiles.onHandoffChange = () => publish("browser_handoffs_changed");
    return () => { ctx.system.onChange = undefined; ctx.backend.onChange = undefined; ctx.profiles.onChange = undefined; ctx.profiles.onHandoffChange = undefined; };
  } },
  async createContext(env) {
    const system = new BrowserSystem(env); await system.start(); const backend = new Backend(system); const profiles = new Profiles(backend, system, env);
    const state = new BrowseState(profiles, backend, env, system.root);
    try { await profiles.start(); return { backend, system, profiles, state }; }
    catch (error) { state.journal.close(); await backend.closeContext(); await system.close(); throw error; }
  },
  prepareCloseContext(ctx) { ctx.profiles.prepareClose(); },
  async closeContext(ctx) { try { await ctx.profiles.close(); } finally { ctx.state?.journal.close(); await ctx.backend.closeContext(); await ctx.system.close(); } },
};
export const api = withStateInventory("browse", browseStateCategories, packageApi);
