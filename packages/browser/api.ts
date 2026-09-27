import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { Backend, cleanupSchema } from "./src/backend.js";
import { BrowserSystem } from "./src/system.js";
import { Profiles, profileSchema, bindingSchema } from "./src/profiles.js";

export type BrowserContext = { backend: Backend; system: BrowserSystem; profiles: Profiles };
const sessionInput = z.strictObject({ session: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/) });
const sessionOutput = z.strictObject({
  session: z.string(), profile: z.string(), lease: z.string(), persistent: z.boolean(),
  createdAt: z.string(), state: z.enum(["reserved", "running"]),
  target: z.strictObject({ name: z.string(), backend: z.string() }).nullable(),
});
const sessionOf = (row: Awaited<ReturnType<Backend["get"]>>) => row && ({
  session: row.session, profile: row.profile, lease: row.lease, persistent: row.persistent,
  createdAt: row.createdAt, state: row.target ? "running" as const : "reserved" as const, target: row.target,
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
  name: "browser_profile_list", description: "List durable, exclusively Bot-assigned or retained unassigned browser profiles and their last observed runtime health. Observation connections follow the visible tab; video delivery is not yet verified.",
  input: z.strictObject({}), output: z.strictObject({ profiles: z.array(profileSchema) }), annotations: { readOnlyHint: true },
  async call(ctx: BrowserContext) { return { profiles: ctx.profiles.list() }; },
});
export const browserProfileCreate = operation({
  name: "browser_profile_create", description: "Admit an empty additional durable profile exclusively for an existing Bot, or unassigned. Its supervised browser starts asynchronously; read state for readiness. Never clones or imports sign-ins.",
  input: z.strictObject({ botId: z.string().nullable(), label: z.string().min(1).max(128) }), output: profileSchema,
  async call(ctx: BrowserContext, input) { return ctx.profiles.create(input.botId, input.label); },
});
export const browserProfileDelete = operation({
  name: "browser_profile_delete", description: "Permanently delete an unselected profile and its exact owned VM and volume. Refuses a Bot's default profile; Bot deletion only unassigns it. This discards sign-ins and all stored browser data.",
  input: z.strictObject({ profileId: z.uuid(), confirm: z.literal("delete") }), output: z.strictObject({ deleted: z.literal(true) }), annotations: { destructiveHint: true },
  async call(ctx: BrowserContext, input) { return ctx.profiles.remove(input.profileId); },
});
export const browserControllerList = operation({
  name: "browser_controller_list", description: "Read controller selections and last confirmed bindings. Connected is a timestamped observation, not a liveness guarantee; unknown never asserts the requested profile is actually attached.",
  input: z.strictObject({}), output: z.strictObject({ controllers: z.array(bindingSchema) }), annotations: { readOnlyHint: true },
  async call(ctx: BrowserContext) { return { controllers: ctx.profiles.bindings() }; },
});
export const browserControllerSelect = operation({
  name: "browser_controller_select", description: "Select one exclusively assigned profile for a live Bot's controller session. Serialize native reconnect with its page commands, invalidate old refs, and read back actual CDP binding and active target. An unknown result reports failure without claiming the switch succeeded. Other controllers remain independent.",
  input: z.strictObject({ botId: z.string(), session: sessionInput.shape.session.default("default"), profileId: z.uuid() }), output: bindingSchema,
  async call(ctx: BrowserContext, input, invocation) {
    if (invocation && invocation.botId !== input.botId) throw new Error("controller selection must belong to the invoking Bot");
    return ctx.profiles.select(input.botId, input.session, input.profileId);
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
  source: z.enum(["agentstack", "legacy", "custom"]), running: z.boolean(), issue: z.string().nullable(),
});
const hypemanInstallations = z.strictObject({ installations: z.array(hypemanInstallation) });
export const browserToolStatus = operation({
  name: "agent_browser_status", description: "Read the managed agent-browser version, observed latest release, pending update, observation issue and manual/automatic update policy. No network request.",
  input: z.strictObject({}), output: browserToolOutput,
  annotations: { title: "Agent-browser installation and updates", readOnlyHint: true },
  async call(ctx: BrowserContext) { return ctx.system.browserStatus(); },
});
export const browserToolDetect = operation({
  name: "agent_browser_detect", description: "Detect AgentStack's private agent-browser installation and the legacy AgentStart command without changing either.",
  input: z.strictObject({}), output: z.strictObject({ installations: z.array(z.strictObject({ location: z.string(), version: z.string().nullable(), source: z.enum(["agentstack", "agentstart"]) })) }),
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
  name: "agent_browser_install", description: "Install an exact agent-browser release into AgentStack's private toolchain. Never overwrites an independent global installation.",
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
  name: "agent_browser_uninstall", description: "Disable the AgentStack-managed agent-browser binary without removing a foreign or AgentStart-owned executable.",
  input: z.strictObject({}), output: browserToolOutput,
  annotations: { title: "Uninstall managed agent-browser", destructiveHint: true },
  async call(ctx: BrowserContext) { return ctx.system.uninstallBrowser(); },
});
export const hypemanDetect = operation({
  name: "hypeman_detect", description: "Detect the AgentStack-managed, legacy local Mac, and explicitly configured Hypeman roots. Probes only loopback; never contacts Artbird.",
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
  name: "hypeman_install", description: "Install the checksum-verified local Hypeman release in AgentStack state. Does not select it or modify the legacy Mac installation.",
  input: z.strictObject({}), output: hypemanInstallations,
  annotations: { title: "Install local Hypeman" },
  async call(ctx: BrowserContext) { return { installations: await ctx.system.installHypeman() }; },
});
export const hypemanUninstall = operation({
  name: "hypeman_uninstall", description: "Uninstall only stopped, disabled AgentStack-owned Hypeman with no browser reservations. Its images and state are discarded only after explicit confirmation; independent installations are never removed.",
  input: z.strictObject({ discardData: z.boolean() }), output: hypemanInstallations,
  annotations: { title: "Uninstall local Hypeman", destructiveHint: true },
  async call(ctx: BrowserContext, input) { return { installations: await ctx.system.uninstallHypeman(input.discardData) }; },
});
export const topics = {
  browser_profiles_changed: "Durable browser profiles, health observations or controller bindings changed. Re-read browser_profile_list and browser_controller_list.",
  browser_system_changed: "Installation, update observation, update policy or selected local Hypeman root changed. Re-read agent_browser_status and hypeman_detect.",
  browser_sessions_changed: "A disposable browser reservation changed. Re-read browser_session_list; this does not prove a daemon is still driving it.",
} as const;
export const api: PackageApi<BrowserContext, keyof typeof topics> = {
  operations: [browserStatus, browserProfileList, browserProfileCreate, browserProfileDelete, browserControllerList, browserControllerSelect, browserControllerLaunch, browserControllerClose, browserBotRelease,
    browserSessionGet, browserSessionList, browserSessionClose, browserSessionReconcile,
    browserToolStatus, browserToolDetect, browserToolCheck, browserToolPolicy, browserToolInstall, browserToolAccept, browserToolUninstall,
    hypemanDetect, hypemanLocationSet, hypemanEnable, hypemanInstall, hypemanUninstall],
  events: { topics, start(ctx, publish) {
    ctx.system.onChange = () => publish("browser_system_changed");
    ctx.backend.onChange = () => publish("browser_sessions_changed");
    ctx.profiles.onChange = () => publish("browser_profiles_changed");
    return () => { ctx.system.onChange = undefined; ctx.backend.onChange = undefined; ctx.profiles.onChange = undefined; };
  } },
  async createContext(env) { const system = new BrowserSystem(env); await system.start(); const backend = new Backend(system); const profiles = new Profiles(backend, system, env); await profiles.start(); return { backend, system, profiles }; },
  prepareCloseContext(ctx) { ctx.profiles.prepareClose(); },
  async closeContext(ctx) { await ctx.profiles.close(); await ctx.backend.closeContext(); await ctx.system.close(); },
};
