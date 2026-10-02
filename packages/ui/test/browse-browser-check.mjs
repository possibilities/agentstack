// Optional rendered check of the Browse space. A fixture browse socket follows the real operation
// contracts (schemas and descriptions come from the built browse package), and a loopback HTTP
// server stands in for the managed Neko viewer. No live server, browser profile or Hypeman is touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/browse-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable. BROWSE_NEXT=start uses a prior `next build`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { api as botsApi } from "../../bots/dist/api.js";
import { publishedJsonSchema, serveSocket, serveWebSocket, socketPath, StateJournal } from "@stack/api";
import { anyObject, fixtureDoc, freePort as port, gatewayRoot, ui, z, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/private/var/folders/9g/l0rgs8rs2_9__kqn0smr9tnh0000gp/T/opencode", "browse-"));
const evidence = process.env.BROWSE_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const { api: browseApi } = await import("../../browse/dist/api.js");
const served = new Map(), calls = [];
let websocket, next, browser, neko, page, log = "";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const journal = new StateJournal(join(dir, "browse-maintenance.sqlite"), "browse");
let volumeRevision = 1, changeVolumePage = false, volumeUnavailable = false;
let volumes = Array.from({ length: 101 }, (_, n) => ({ id: `volume-${n}`, name: `stack-profile-fixture-${n}`, providerRevision: "fixture-provider",
  tags: { "dev.stack.role": "durable-profile", "dev.stack.session": `fixture-${n}`, "dev.stack.lease": "a".repeat(32) },
  blockedBy: n === 1 ? ["Volume is referenced by a Browser session receipt (including incomplete/disposable leases)"] : n === 2 ? ["Volume is mounted by a provider instance"] : [] }));
const maintenancePlan = (kind, input) => {
  const resources = input.ids ?? input.volumeIds ?? [input.profileId];
  assert.ok(resources.length && resources.length <= 100, "no empty maintenance selection");
  const profile = state.profiles.find((row) => row.id === input.profileId);
  return journal.plan({ subject: profile ? { kind: "profile", id: profile.id } : null, action: `browser_${kind}`, revision: JSON.stringify([kind, input, volumeRevision, profile?.generation]),
    resources: [...resources, ...(profile ? ["provider-instance-exact-123", "provider-volume-exact-456"] : [])],
    blockedBy: profile?.id === uuid(1) ? ["Stop and verify the assigned Bot before profile maintenance", "Close all selected/uncertain controllers before profile maintenance"] : [],
    retained: ["Other profiles, foreign/occupied volumes, external copies/backups and other owners' history remain", "Minimal plan/receipt and handoff admission digests remain; unknown effects never retry",
      "Scoped cache means CacheStorage only; HTTP browser cache and persisted navigation history are unsupported and never silently widened"],
    regeneration: [kind === "reset" ? "Fresh exact provider volume/instance; explicit later sign-in required" : "Later browser activity may recreate data; no navigation or sign-in admitted"] }, { kind, ...input });
};
const maintenanceClear = (input) => {
  const old = journal.existing(input); if (old) return old;
  const { plan, payload } = journal.getPlan(input.planId);
  assert.equal(input.expectedRevision, plan.revision); assert.deepEqual(plan.blockedBy, []);
  journal.begin(input, plan);
  if (payload.kind === "handoff") {
    for (const id of payload.ids) Object.assign(handoff(id), { message: "", note: null, issue: null, contentClearedAt: iso(), requestDigest: "retained-digest", revision: handoff(id).revision + 1 });
    publish("browser_handoffs_changed");
  } else if (payload.kind === "reset") {
    state.profiles.find((row) => row.id === payload.profileId).generation++;
    publish("browser_profiles_changed");
  } else if (payload.kind === "volume") { volumes = volumes.filter((row) => !payload.volumeIds.includes(row.id)); volumeRevision++; }
  return journal.finish(input.requestId, "completed", plan.resources.map((resource) => ({ resource, outcome: "removed", detail: "Fixture owner effect recorded" })));
};
const seedUnknown = (kind, input, status = "unknown") => {
  const plan = maintenancePlan(kind, input);
  const apply = { planId: plan.id, expectedRevision: plan.revision, requestId: crypto.randomUUID() };
  journal.begin(apply, plan);
  journal.finish(apply.requestId, status, [{ resource: "provider-volume-leftover-exact-789", outcome: "retained", detail: "Provider resource remains; inspect before release" }, { resource: "provider-instance-uncertain-exact-012", outcome: "unknown", detail: "Absence not verified" }]);
  return apply;
};
let nekoBase = "";
// Retained Bot-watch receipt for the waiting handoff's exact request; the resolved sibling never asked.
const watchCalls = [];
let watchUnavailable = false;
const completionReceipts = [
  { id: uuid(70), botId: "bot-1", threadId: "thread-1", pkg: "browse", operation: "browser_handoff_request", recordId: uuid(60),
    state: "delivered", lastDeliveredAt: Date.now() - 60_000, lastDeliveryKind: "terminal", lastError: null, nativeAdmissionUncertain: false, subscriptionPresent: true },
];
const state = {
  profiles: [],
  controllers: [],
  handoffs: [],
  receipts: new Map(),
  tool: { installed: true, version: "0.38.1", location: "/fixture/agent-browser", latest: "0.38.1", pending: null, checkedAt: iso(-60_000), checkError: null, policy: "manual" },
  hypeman: [{ root: "/fixture/hypeman", installed: true, selected: true, source: "stack", running: true, issue: null }],
};
const publish = (topic) => served.get("browse").publish(topic);
const handoff = (id) => state.handoffs.find((item) => item.id === id);
function act(kind, input) {
  const item = handoff(input.id);
  if (!item) throw new Error("unknown browser handoff");
  const digest = JSON.stringify({ kind, ...input });
  const receipt = state.receipts.get(`${item.id}:${input.requestId}`);
  if (receipt && receipt !== digest) throw new Error("handoff action requestId conflicts with existing intent");
  if (!receipt && input.expectedRevision !== item.revision) throw new Error("stale handoff revision");
  if (receipt) return { handoff: item, controlUrl: item.state === "human_controlling" ? `${nekoBase}/control/` : null };
  state.receipts.set(`${item.id}:${input.requestId}`, digest);
  if (kind === "take") {
    if (item.state !== "awaiting_human") throw new Error("handoff is not awaiting human control");
    Object.assign(item, { state: "human_controlling", revision: item.revision + 1 });
  } else {
    Object.assign(item, { state: "resolved", outcome: input.outcome, note: input.note ?? null, resolvedAt: iso(), revision: item.revision + 2 });
  }
  publish("browser_handoffs_changed");
  return { handoff: item, controlUrl: kind === "take" ? `${nekoBase}/control/` : null };
}
const handlers = {
  browser_status: () => ({ provider: "hypeman", mode: "durable", sessions: 0, profiles: state.profiles.length }),
  browser_profile_list: () => ({ profiles: state.profiles }),
  browser_controller_list: () => ({ controllers: state.controllers }),
  browser_handoff_list: () => ({ handoffs: state.handoffs }),
  browser_handoff_get: (input) => ({ handoff: handoff(input.id) ?? null }),
  browser_handoff_completion: (input) => {
    const found = state.handoffs.find((item) => item.requestId === input.requestId && item.botId === input.botId && item.threadId === input.threadId);
    return { result: found && found.state === "resolved" ? found : null };
  },
  serve_completion_list: (args) => {
    watchCalls.push(args);
    if (watchUnavailable) throw new Error("server subscription owner unavailable");
    const rows = completionReceipts.filter((row) => (!args.package || row.pkg === args.package) && (!args.operation || row.operation === args.operation)
      && (!args.recordId || row.recordId === args.recordId) && (!args.botId || row.botId === args.botId) && (!args.threadId || row.threadId === args.threadId) && (!args.state || row.state === args.state));
    const nextOffset = (args.offset ?? 0) + (args.limit ?? 100) < rows.length ? (args.offset ?? 0) + (args.limit ?? 100) : null;
    return { completions: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)), revision: "watch-1", total: rows.length, nextOffset, truncated: nextOffset !== null };
  },
  serve_completion_get: ({ id }) => {
    const found = completionReceipts.find((row) => row.id === id) ?? null;
    return found ? { receipt: found, link: { kind: "browse", requestId: found.recordId, handoffId: uuid(50) }, linkStatus: "resolved" } : { receipt: null, link: null, linkStatus: "not_found" };
  },
  browser_controller_select: () => { throw new Error("the UI must not select controllers"); },
  browser_handoff_take: (input) => act("take", input),
  browser_handoff_finish: (input) => act("finish", input),
  browser_profile_create: (input) => {
    const profile = { id: uuid(100 + state.profiles.length), botId: input.botId, label: input.label, default: false, generation: 0, maintenanceRequestId: null, createdAt: iso(), state: "starting", error: null, observedAt: null, cdpUrl: null, observation: null };
    state.profiles.push(profile); publish("browser_profiles_changed"); return profile;
  },
  browser_profile_delete: (input) => {
    assert.equal(input.confirm, "delete");
    state.profiles = state.profiles.filter((item) => item.id !== input.profileId); publish("browser_profiles_changed"); return { deleted: true };
  },
  browser_profile_reset_plan: (input) => maintenancePlan("reset", input),
  browser_site_data_plan: (input) => { assert.ok(input.origins.length); assert.ok(input.categories.length); assert.ok(input.categories.every((category) => ["cookies", "storage", "cache"].includes(category))); return maintenancePlan("site", input); },
  browser_handoff_history_plan: (input) => maintenancePlan("handoff", input),
  browser_volume_plan: (input) => maintenancePlan("volume", input),
  browser_profile_reset_clear: maintenanceClear, browser_site_data_clear: maintenanceClear,
  browser_handoff_history_clear: maintenanceClear, browser_volume_clear: maintenanceClear,
  browse_state_receipt_get: ({ requestId }) => ({ receipt: journal.receipt(requestId) }),
  browse_state_read: () => { throw new Error("Browse state inventory is not observed in this fixture"); },
  browse_state_fence_release: ({ profileId, requestId, expectedGeneration }) => {
    const profile = state.profiles.find((row) => row.id === profileId);
    assert.equal(profile.maintenanceRequestId, requestId); assert.equal(profile.generation, expectedGeneration);
    assert.ok(["unknown", "partial", "completed"].includes(journal.receipt(requestId).status));
    profile.maintenanceRequestId = null; publish("browser_profiles_changed"); return { released: true };
  },
  browser_volume_list: ({ offset = 0, limit = 100, revision }) => {
    if (volumeUnavailable) throw new Error("Provider inventory unavailable");
    if (offset && changeVolumePage) { volumeRevision++; changeVolumePage = false; }
    if (revision && revision !== String(volumeRevision)) throw new Error("Volume inventory changed; restart paging");
    return { volumes: volumes.slice(offset, offset + limit), revision: String(volumeRevision), nextOffset: offset + limit < volumes.length ? offset + limit : null };
  },
  agent_browser_status: () => state.tool,
  agent_browser_detect: () => ({ installations: [{ location: "/fixture/agent-browser", version: "0.38.1", source: "stack" }] }),
  agent_browser_check_updates: () => { Object.assign(state.tool, { latest: "0.39.0", pending: "0.39.0", checkedAt: iso() }); publish("browser_system_changed"); return state.tool; },
  agent_browser_update_accept: (input) => { assert.equal(input.version, "0.39.0"); Object.assign(state.tool, { version: "0.39.0", pending: null }); publish("browser_system_changed"); return state.tool; },
  agent_browser_update_policy_set: (input) => { state.tool.policy = input.policy; publish("browser_system_changed"); return state.tool; },
  agent_browser_install: () => state.tool, agent_browser_uninstall: () => state.tool,
  hypeman_detect: () => ({ installations: state.hypeman }),
  hypeman_location_set: () => ({ installations: state.hypeman }), hypeman_enable: () => ({ installations: state.hypeman }),
  hypeman_install: () => ({ installations: state.hypeman }), hypeman_uninstall: () => ({ installations: state.hypeman }),
  serve_status: () => ({ pid: process.pid, startedAt: iso(), nodeVersion: process.version, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  bot_list: () => ({ bots: ["bot-1", "bot-2"].map((id) => ({ id, state: "running", pid: 321, cwd: "/fixture/workspace", url: null, account: null, runningAccount: null, mainThreadId: null, recoveryIssue: null, roleRevision: 1, settings: null })) }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
};

try {
  // The Neko stand-in: an observer page and a control page, each with an input to type into.
  neko = createServer((request, response) => {
    const control = request.url?.startsWith("/control/");
    response.writeHead(request.url?.startsWith("/observe/") || control ? 200 : 404, { "content-type": "text/html" });
    response.end(`<!doctype html><title>neko</title><body style="background:#123;color:#fff"><h1>${control ? "Control fixture" : "Observe fixture"}</h1><input id="k" aria-label="guest input"></body>`);
  });
  await new Promise((resolve) => neko.listen(0, "127.0.0.1", resolve));
  nekoBase = `http://127.0.0.1:${neko.address().port}`;
  state.profiles = [
    { id: uuid(1), botId: "bot-1", label: "default", default: true, createdAt: iso(-3_600_000), state: "ready", error: null, observedAt: iso(-5_000), cdpUrl: "http://127.0.0.1:1", observation: { url: `${nekoBase}/observe/?readOnly=1`, udpPort: 1, follows: "visible-tab", verified: false } },
    { id: uuid(2), botId: "bot-1", label: "research", default: false, createdAt: iso(-1_800_000), state: "failed", error: "CDP readiness exceeded 35s", observedAt: iso(-5_000), cdpUrl: null, observation: null },
    { id: uuid(3), botId: null, label: "retired", default: false, createdAt: iso(-86_400_000), state: "ready", error: null, observedAt: iso(-5_000), cdpUrl: null, observation: { url: `${nekoBase}/observe/?readOnly=1`, udpPort: 1, follows: "visible-tab", verified: false } },
  ];
  state.profiles.forEach((row) => Object.assign(row, { generation: 0, maintenanceRequestId: null }));
  state.controllers = [
    { botId: "bot-1", instance: "launch-a", session: "default", profileId: uuid(1), actualProfileId: uuid(1), targetId: "T1", cdpUrl: null, state: "connected", revision: 2, observedAt: iso(-10_000), error: null },
    { botId: "bot-1", instance: "launch-a", session: "research", profileId: uuid(2), actualProfileId: uuid(1), targetId: null, cdpUrl: null, state: "unknown", revision: 3, observedAt: iso(-10_000), error: "reconnect result unknown" },
  ];
  state.handoffs = [
    { id: uuid(50), profileId: uuid(1), botId: "bot-1", threadId: "thread-1", instance: "launch-a", requestId: uuid(60), targetId: "T1", targetStatus: "present", message: "Sign in to GitHub and approve MFA.\nI'll continue once you're done.",
      state: "awaiting_human", outcome: null, note: null, revision: 2, createdAt: iso(-120_000), resolvedAt: null, issue: null, quiesced: true },
    { id: uuid(51), profileId: uuid(3), botId: "bot-2", threadId: "thread-2", instance: "launch-b", requestId: uuid(61), targetId: null, targetStatus: "unspecified", message: "Accept cookies",
      state: "resolved", outcome: "skipped", note: "Not needed", revision: 5, createdAt: iso(-7_200_000), resolvedAt: iso(-7_000_000), issue: null, quiesced: true },
  ];
  state.handoffs.forEach((row) => Object.assign(row, { contentClearedAt: null, requestDigest: null }));

  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  // The bots WebSocket manifest selects explicit names: the fixture socket must serve every selected
  // operation for the gateway to admit the page. Unobserved ones still throw if the UI ever calls them.
  const unobserved = (name) => () => { throw new Error(`${name} is not observed in this fixture`); };
  for (const op of botsApi.operations) handlers[op.name] ??= unobserved(op.name);
  const definitions = { browse: Object.keys(handlers).filter((name) => name.startsWith("browser_") || name.startsWith("browse_state_") || name.startsWith("agent_browser_") || name.startsWith("hypeman_")),
    serve: serve.names, bots: botsApi.operations.map((op) => op.name), api: ["docs_snapshot"] };
  const topics = { browse: browseApi.events.topics, serve: serve.topics, bots: botsApi.events.topics, api: {} };
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, Object.keys(definitions), ["bots"]), port: 0 });
  const catalog = [fixtureDoc("browse", browseApi, websocket.url, publishedJsonSchema), ...["serve", "bots", "api"].map((name) => ({ ...fixtureDoc(name, null, websocket.url, publishedJsonSchema), events: topics[name],
    transports: [{ type: "websocket", description: "Fixture", supported: true, subscriptions: true, endpoint: websocket.url, operations: definitions[name], events: Object.keys(topics[name]), routes: [] }] }))];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names] of Object.entries(definitions)) served.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
    operations: names.map((operation) => ({ name: operation, description: operation, input: anyObject, output: z.any(), async call(_ctx, input) { calls.push({ name: operation, input }); return handlers[operation](input); } })),
    // The page subscribes each Bot's scoped chat topics, so bots needs its real topics and a scope.
    events: { topics: topics[name], scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));

  const nextPort = await port();
  // The gateway admits only the page origin it serves.
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), process.env.BROWSE_NEXT === "start" ? "start" : "dev", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1200 || next.exitCode !== null) throw new Error(log.slice(-4000));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 2400, height: 1300 }, reducedMotion: "reduce" });
  page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });

  // Fleet links a Bot waiting on a person to its handoff, in Browse.
  await page.goto(`${origin}/fleet`);
  const help = page.locator('[data-window="bots"]').getByRole("link", { name: /Waiting on you in the browser/ });
  await help.waitFor();
  await help.click();
  await page.waitForURL(/\/browse/);
  const handoffs = page.locator('[data-window="browse-handoffs"]');
  const viewer = page.locator('[data-window="browse-viewer"]');
  const profiles = page.locator('[data-window="browse-profiles"]');
  const controllers = page.locator('[data-window="browse-controllers"]');
  const toolchain = page.locator('[data-window="browse-toolchain"]');
  const inspector = page.getByRole("region", { name: "Inspector" });
  await handoffs.getByText("A Bot is waiting for you").waitFor();
  await handoffs.getByText("Requested tab found").waitFor();

  // Attention names the waiting Bot and the failed profile.
  await page.getByRole("button", { name: "Spaces · Browse" }).click();
  const menu = page.getByRole("menuitem", { name: /Browse/ });
  const attention = await menu.getAttribute("title");
  assert.match(attention ?? "", /bot-1 needs browser help/);
  assert.match(attention ?? "", /research browser failed/);
  await page.keyboard.press("Escape");

  // Watching shows the observer, labelled as unverified.
  await handoffs.getByRole("button", { name: "Watch" }).click();
  await viewer.getByText("bot-1 asks:").waitFor();
  const frame = viewer.locator("iframe");
  assert.match(await frame.getAttribute("src"), /\/observe\//);
  await page.frameLocator('[data-window="browse-viewer"] iframe').getByText("Observe fixture").waitFor();
  await page.screenshot({ path: join(evidence, "browse-waiting.png"), animations: "disabled" });

  // Take control: the viewer switches to the grant, and the grant never reaches storage.
  await handoffs.getByRole("button", { name: "Take control" }).click();
  await viewer.getByText(/You have control\. Closing this window/).waitFor();
  assert.match(await viewer.locator("iframe").getAttribute("src"), /\/control\/$/);
  const takes = calls.filter((call) => call.name === "browser_handoff_take");
  assert.equal(takes.length, 1);
  assert.equal(takes[0].input.expectedRevision, 2);
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  assert.ok(!stored.includes("/control/"), "the control grant is never stored");

  // Typing inside the guest never reaches the bench's space shortcuts.
  const guest = page.frameLocator('[data-window="browse-viewer"] iframe').getByLabel("guest input");
  await guest.click();
  await page.keyboard.type("1b0");
  assert.match(page.url(), /\/browse/);
  assert.equal(await guest.inputValue(), "1b0");
  await page.screenshot({ path: join(evidence, "browse-control.png"), animations: "disabled" });

  // A reload loses the in-memory grant; Reopen repeats this page's exact take.
  await page.reload();
  await handoffs.getByRole("button", { name: "Reopen control" }).click();
  await viewer.getByText(/You have control\. Closing this window/).waitFor();
  const reopen = calls.filter((call) => call.name === "browser_handoff_take");
  assert.equal(reopen.length, 2);
  assert.deepEqual(reopen[1].input, reopen[0].input, "Reopen resends the identical take");

  // Finish from the viewer with a note; the viewer returns to observing.
  await viewer.getByLabel("Note for the Bot").fill("Signed in; MFA approved");
  await viewer.getByRole("button", { name: "Completed", exact: true }).click();
  await viewer.getByText("Live view · follows the visible tab · delivery not verified").waitFor();
  const finish = calls.find((call) => call.name === "browser_handoff_finish");
  assert.deepEqual({ outcome: finish.input.outcome, note: finish.input.note, expectedRevision: finish.input.expectedRevision }, { outcome: "completed", note: "Signed in; MFA approved", expectedRevision: 3 });
  await handoffs.getByText("Nothing waiting. Bots ask here when a page needs a person.").waitFor();
  await handoffs.getByRole("button", { name: "Show 2" }).click();
  await handoffs.getByText(/Completed · reported/).waitFor();
  // History rows carry the exact Chat thread and request id for correlation.
  await handoffs.locator('[title="Thread thread-1"]').waitFor();
  await handoffs.locator(`[title="Request ${uuid(61)}"]`).waitFor();

  // Profiles: grouped, failed shown with its error, default not deletable, unassigned deletable by name.
  await profiles.getByText("CDP readiness exceeded 35s").waitFor();
  await profiles.getByRole("button", { name: "More for default" }).click();
  await page.getByRole("menuitem", { name: "A Bot's default profile can't be deleted" }).waitFor();
  await page.keyboard.press("Escape");
  // Profile plans disclose blockers and retained copies without taking lifecycle actions.
  await profiles.getByRole("button", { name: "More for default" }).click();
  await page.getByRole("menuitem", { name: "Reset profile…" }).click();
  let maintenance = page.getByRole("dialog");
  await maintenance.getByRole("button", { name: "Prepare reset profile", exact: true }).click();
  await maintenance.getByText("Stop and verify the assigned Bot before profile maintenance", { exact: true }).waitFor();
  assert.equal(await maintenance.getByRole("button", { name: "Reset profile", exact: true }).isDisabled(), true);
  await maintenance.getByText("Other profiles, foreign/occupied volumes, external copies/backups and other owners' history remain", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "browse-reset-blocked-light.png"), animations: "disabled" });
  await maintenance.getByRole("button", { name: "Close dialog" }).click();
  // A failed/non-ready profile cannot prepare site data, and this UI never starts it to make it ready.
  await profiles.getByRole("button", { name: "More for research" }).click();
  await page.getByRole("menuitem", { name: "Clear site data…" }).click();
  await page.getByRole("dialog").getByText("The exact running profile CDP must be ready. Planning never starts or navigates a browser.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Prepare clear site data", exact: true }).isDisabled(), true);
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();

  await profiles.getByRole("button", { name: "More for retired" }).click();
  await page.getByRole("menuitem", { name: "Clear site data…" }).click();
  maintenance = page.getByRole("dialog");
  const prepareSite = maintenance.getByRole("button", { name: "Prepare clear site data", exact: true });
  assert.equal(await prepareSite.isDisabled(), true);
  await maintenance.getByLabel("Exact origins (one per line)").fill("https://name:secret@example.com/path");
  await maintenance.getByLabel("cookies", { exact: true }).check();
  assert.equal(await prepareSite.isDisabled(), true);
  assert.equal(calls.filter((call) => call.name === "browser_site_data_plan").length, 0);
  await maintenance.getByLabel("Exact origins (one per line)").fill("https://example.com\nhttp://localhost:8080");
  await maintenance.getByLabel("cache", { exact: true }).check();
  assert.equal(await maintenance.getByRole("checkbox").count(), 3, "history is not an offered category");
  await prepareSite.click();
  await maintenance.getByRole("button", { name: "Clear site data", exact: true }).waitFor();
  assert.equal(await maintenance.getByLabel("Exact origins (one per line)").isDisabled(), true);
  assert.deepEqual(calls.find((call) => call.name === "browser_site_data_plan").input, { profileId: uuid(3), origins: ["http://localhost:8080", "https://example.com"], categories: ["cookies", "cache"] });
  await page.screenshot({ path: join(evidence, "browse-site-plan-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "browse-site-plan-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.screenshot({ path: join(evidence, "browse-site-plan-narrow.png"), animations: "disabled" });
  assert.deepEqual(await maintenance.evaluate((element) => [...element.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1).map((child) => ({ tag: child.tagName, text: child.textContent.slice(0, 100), width: child.getBoundingClientRect().width })).slice(0, 10)), [], "narrow dialog does not overflow");
  await page.setViewportSize({ width: 2400, height: 1300 });
  await page.emulateMedia({ colorScheme: "light" });
  await maintenance.getByRole("button", { name: "Clear site data", exact: true }).click();
  await maintenance.getByRole("region", { name: "browse receipt completed" }).waitFor();
  await maintenance.getByRole("button", { name: "Close dialog" }).click();

  await profiles.getByRole("button", { name: "More for retired" }).click();
  await page.getByRole("menuitem", { name: "Reset profile…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Prepare reset profile", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset profile", exact: true }).click();
  await page.getByRole("dialog").getByRole("region", { name: "browse receipt completed" }).waitFor();
  assert.equal(state.profiles.find((row) => row.id === uuid(3)).generation, 1);
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();

  // Recover from real owner journal receipts, not a fabricated UI state. No new plan or resend.
  const resetUnknown = seedUnknown("reset", { profileId: uuid(2) });
  state.profiles.find((row) => row.id === uuid(2)).maintenanceRequestId = resetUnknown.requestId;
  const siteUnknown = seedUnknown("site", { profileId: uuid(3), origins: ["https://example.com"], categories: ["storage"] }, "partial");
  await page.evaluate(({ resetUnknown, siteUnknown, research, retired }) => {
    localStorage.setItem(`stack.state-flow.browse:reset:${research}`, JSON.stringify({ input: resetUnknown, at: Date.now() }));
    localStorage.setItem(`stack.state-flow.browse:site:${retired}`, JSON.stringify({ input: siteUnknown, at: Date.now() }));
  }, { resetUnknown, siteUnknown, research: uuid(2), retired: uuid(3) });
  const plansBeforeRecovery = calls.filter((call) => /_(plan|clear)$/.test(call.name)).length;
  await page.reload();
  const fence = profiles.getByRole("region", { name: "Maintenance fence research" });
  await fence.getByRole("region", { name: "browse receipt unknown" }).waitFor();
  await fence.getByRole("list", { name: "Exact remaining or uncertain resources" }).getByText(/provider-volume-leftover-exact-789/).waitFor();
  await fence.screenshot({ path: join(evidence, "browse-fence-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await fence.screenshot({ path: join(evidence, "browse-fence-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await profiles.getByRole("button", { name: "More for research" }).click();
  await page.getByRole("menuitem", { name: "Reset profile…" }).click();
  maintenance = page.getByRole("dialog");
  await maintenance.getByRole("region", { name: "browse receipt unknown" }).waitFor();
  assert.equal(await maintenance.getByRole("button", { name: /Send identical|Prepare a new|Close receipt/ }).count(), 0);
  await maintenance.getByRole("button", { name: "Read receipt again" }).click();
  await maintenance.getByRole("region", { name: "browse receipt unknown" }).waitFor();
  await page.screenshot({ path: join(evidence, "browse-reset-recovery-light.png"), animations: "disabled" });
  await maintenance.getByRole("button", { name: "Close dialog" }).click();
  await profiles.getByRole("button", { name: "More for retired" }).click();
  await page.getByRole("menuitem", { name: "Clear site data…" }).click();
  maintenance = page.getByRole("dialog");
  await maintenance.getByRole("region", { name: "browse receipt partial" }).waitFor();
  assert.equal(await maintenance.getByRole("button", { name: /Send identical|Prepare a new|Close receipt/ }).count(), 0);
  assert.equal(calls.filter((call) => /_(plan|clear)$/.test(call.name)).length, plansBeforeRecovery);
  await maintenance.getByRole("button", { name: "Close dialog" }).click();
  await fence.getByRole("button", { name: "Release fence…" }).click();
  // A changed generation cannot be acknowledged under an older confirmation.
  state.profiles.find((row) => row.id === uuid(2)).generation++;
  publish("browser_profiles_changed");
  await page.getByRole("dialog").getByRole("alert").getByText(/generation changed/).waitFor();
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Release fence", exact: true }).isDisabled(), true);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await fence.getByRole("button", { name: "Release fence…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Release fence", exact: true }).click();
  await fence.waitFor({ state: "detached" });
  assert.deepEqual(calls.find((call) => call.name === "browse_state_fence_release").input, { profileId: uuid(2), requestId: resetUnknown.requestId, expectedGeneration: 1 });
  assert.equal(journal.receipt(resetUnknown.requestId).status, "unknown");

  // History only selects resolved retained content, and refreshes the existing reader on redaction.
  await handoffs.getByRole("button", { name: "Show 2" }).click();
  const historyMaintenance = handoffs.locator("details");
  await historyMaintenance.locator("summary").click();
  await historyMaintenance.getByLabel(`Select handoff ${uuid(51)}`).check();
  await historyMaintenance.getByRole("button", { name: "Prepare clearing 1 handoff bodies" }).click();
  assert.equal(await historyMaintenance.getByLabel(`Select handoff ${uuid(51)}`).isDisabled(), true);
  await historyMaintenance.getByRole("button", { name: "Clear handoff content", exact: true }).click();
  await historyMaintenance.getByRole("region", { name: "browse receipt completed" }).waitFor();
  await historyMaintenance.getByText(/^Content cleared/).waitFor();
  assert.equal(await historyMaintenance.getByText("Not needed", { exact: true }).count(), 0);
  assert.equal(await historyMaintenance.getByLabel(`Select handoff ${uuid(51)}`).isDisabled(), true);
  assert.equal(handoff(uuid(51)).outcome, "skipped");
  await historyMaintenance.screenshot({ path: join(evidence, "browse-handoff-cleared-light.png"), animations: "disabled" });
  await historyMaintenance.getByRole("button", { name: "Close receipt" }).click();
  await historyMaintenance.locator("summary").click();

  // A cleared resolved handoff keeps its exact identity and truthfully reports the absent watch.
  await handoffs.getByRole("button", { name: /Inspect Handoff content cleared/ }).click();
  await inspector.getByText("Handoff content cleared", { exact: true }).first().waitFor();
  await inspector.getByText("thread-2", { exact: true }).first().waitFor();
  await inspector.getByText("No Bot watch requested").waitFor();
  await inspector.getByText(/this view cannot subscribe/).waitFor();
  assert.equal(await inspector.getByText(/The human reported/).count(), 0, "no receipt means no completion read at all");
  await inspector.getByRole("button", { name: "Close inspector" }).click();

  // Exact owned volumes page independently; provider failure is not an empty inventory.
  const volumeMaintenance = toolchain.locator("details");
  await volumeMaintenance.locator("summary").click();
  assert.equal(await volumeMaintenance.getByLabel("Select volume volume-1", { exact: true }).isDisabled(), true);
  assert.equal(await volumeMaintenance.getByLabel("Select volume volume-2", { exact: true }).isDisabled(), true);
  changeVolumePage = true;
  await volumeMaintenance.getByRole("button", { name: "Load more volumes" }).click();
  await volumeMaintenance.getByText("The inventory changed while paging; showing the first page again.").waitFor();
  await volumeMaintenance.getByRole("button", { name: "Load more volumes" }).click();
  await volumeMaintenance.getByLabel("Select volume volume-100", { exact: true }).waitFor();
  await volumeMaintenance.getByLabel("Select volume volume-100", { exact: true }).check();
  await volumeMaintenance.getByRole("button", { name: "Prepare collecting 1 volumes" }).click();
  await volumeMaintenance.getByRole("button", { name: "Collect these volumes" }).click();
  await volumeMaintenance.getByRole("region", { name: "browse receipt completed" }).waitFor();
  assert.equal(volumes.some((row) => row.id === "volume-100"), false);
  await volumeMaintenance.getByRole("button", { name: "Close receipt" }).click();
  volumeUnavailable = true;
  await volumeMaintenance.getByRole("button", { name: "Refresh volumes" }).click();
  await volumeMaintenance.getByRole("alert").getByText(/Provider inventory unavailable/).waitFor();
  assert.equal(await volumeMaintenance.getByText("No verified owned volumes.", { exact: true }).count(), 0);
  volumeUnavailable = false;
  await volumeMaintenance.getByRole("button", { name: "Refresh volumes" }).click();
  await volumeMaintenance.getByRole("alert").waitFor({ state: "detached" });
  const volumeUnknown = seedUnknown("volume", { volumeIds: ["volume-0"] });
  await page.evaluate((input) => localStorage.setItem("stack.state-flow.browse:volume:ids", JSON.stringify({ input, at: Date.now() })), volumeUnknown);
  const volumeApplies = calls.filter((call) => call.name === "browser_volume_clear").length;
  await page.reload();
  await volumeMaintenance.getByRole("region", { name: "browse receipt unknown" }).waitFor();
  assert.equal(await volumeMaintenance.getByRole("button", { name: /Send identical|Prepare a new|Close receipt/ }).count(), 0);
  assert.equal(await volumeMaintenance.getByLabel("Select volume volume-0", { exact: true }).isDisabled(), true);
  await volumeMaintenance.getByRole("button", { name: "Read receipt again" }).click();
  await volumeMaintenance.getByRole("region", { name: "browse receipt unknown" }).waitFor();
  assert.equal(calls.filter((call) => call.name === "browser_volume_clear").length, volumeApplies);
  await page.screenshot({ path: join(evidence, "browse-maintenance-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "browse-maintenance-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.screenshot({ path: join(evidence, "browse-maintenance-narrow.png"), animations: "disabled" });
  await page.setViewportSize({ width: 2400, height: 1300 });
  await page.emulateMedia({ colorScheme: "light" });
  await handoffs.getByRole("button", { name: "Show 2" }).click();
  assert.equal(calls.some((call) => ["bot_stop", "bot_start", "browser_controller_close", "browser_controller_select", "browser_ensure"].includes(call.name)), false);
  await profiles.getByRole("button", { name: "More for retired" }).click();
  await page.getByRole("menuitem", { name: "Delete profile…" }).click();
  const confirm = page.getByRole("alertdialog");
  const remove = confirm.getByRole("button", { name: "Delete profile" });
  assert.equal(await remove.isDisabled(), true);
  await confirm.getByLabel("Profile name").fill("retired");
  await remove.click();
  await confirm.waitFor({ state: "hidden" });
  await profiles.getByText("retired", { exact: true }).waitFor({ state: "detached" });
  await profiles.getByRole("button", { name: "New profile…" }).click();
  await profiles.getByLabel("Server").selectOption("bot-2");
  await profiles.getByLabel("Label").fill("shopping");
  await profiles.getByRole("button", { name: "Create", exact: true }).click();
  await profiles.getByRole("button", { name: "Inspect profile shopping" }).waitFor();
  assert.deepEqual(calls.find((call) => call.name === "browser_profile_create").input, { botId: "bot-2", label: "shopping" });

  // Controllers are read-only observations; a selection that differs from the actual one is flagged.
  await controllers.getByText("reconnect result unknown").waitFor();
  await controllers.getByText(/^actual/).waitFor();
  assert.equal(await controllers.getByRole("button", { name: /select/i }).count(), 0);

  // Toolchain: check, then accept the exact pending release.
  await toolchain.getByRole("button", { name: "Check now" }).click();
  await toolchain.getByText("Update available:").waitFor();
  await toolchain.getByRole("button", { name: "Install 0.39.0" }).click();
  await toolchain.getByText("Update available:").waitFor({ state: "detached" });
  assert.deepEqual(calls.find((call) => call.name === "agent_browser_update_accept").input, { version: "0.39.0" });
  await page.screenshot({ path: join(evidence, "browse-operator.png"), animations: "disabled" });

  // Inspecting a handoff shows its record and links — plus its exact Bot watch and the human report.
  await handoffs.getByRole("button", { name: /Inspect Sign in to GitHub/ }).click();
  await inspector.getByText(/Browser handoff · Completed · reported/).waitFor();
  await inspector.locator('[data-bot-watch="browse"]').waitFor();
  await inspector.locator(`[data-receipt="${uuid(70)}"]`).getByText("Delivered").waitFor();
  await inspector.getByText(/Terminal admission acknowledged/).waitFor();
  await inspector.getByText("The human reported Completed. A report, not verified browser state; the Bot verifies with a fresh snapshot.").waitFor();
  await inspector.getByText("thread-1", { exact: true }).first().waitFor();
  assert.deepEqual(watchCalls.find((call) => call.recordId === uuid(60)), { package: "browse", recordId: uuid(60), limit: 100, botId: "bot-1", threadId: "thread-1" });
  assert.deepEqual(calls.find((call) => call.name === "browser_handoff_completion").input, { botId: "bot-1", threadId: "thread-1", requestId: uuid(60) });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "browse-handoff-watch-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(evidence, "browse-handoff-watch-light.png"), animations: "disabled" });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.screenshot({ path: join(evidence, "browse-handoff-watch-narrow.png"), animations: "disabled" });
  await page.setViewportSize({ width: 2400, height: 1300 });

  // A failed watch read is unavailable, never an empty watch; the subscriptions notice re-reads it.
  watchUnavailable = true;
  served.get("serve").publish("serve_subscriptions_changed");
  await inspector.getByText(/Bot watch unavailable: server subscription owner unavailable/).waitFor();
  assert.equal(await inspector.getByText("No Bot watch requested").count(), 0);
  watchUnavailable = false;
  served.get("serve").publish("serve_subscriptions_changed");
  await inspector.locator(`[data-receipt="${uuid(70)}"]`).getByText("Delivered").waitFor();
  await inspector.getByRole("button", { name: "Close inspector" }).click();

  // The b key reaches Browse from another space.
  await page.goto(`${origin}/fleet`);
  await page.locator('[data-window="bots"]').waitFor();
  await page.keyboard.press("b");
  await page.waitForURL(/\/browse/);

  // A running or absent receipt never authorizes release, even though the exact fence is visible.
  const runningPlan = maintenancePlan("reset", { profileId: uuid(2) });
  const runningInput = { planId: runningPlan.id, expectedRevision: runningPlan.revision, requestId: crypto.randomUUID() };
  journal.begin(runningInput, runningPlan);
  state.profiles.find((row) => row.id === uuid(2)).maintenanceRequestId = runningInput.requestId;
  publish("browser_profiles_changed");
  await fence.getByRole("region", { name: "browse receipt running" }).waitFor();
  assert.equal(await fence.getByRole("button", { name: "Release fence…" }).isDisabled(), true);
  state.profiles.find((row) => row.id === uuid(2)).maintenanceRequestId = crypto.randomUUID();
  publish("browser_profiles_changed");
  await fence.getByText("No receipt available; release is unavailable.", { exact: true }).waitFor();
  assert.equal(await fence.getByRole("button", { name: "Release fence…" }).isDisabled(), true);

  // Consumer gating follows each independently selected apply/receipt operation, not just the plan.
  const browseTransport = catalog.find((doc) => doc.name === "browse").transports[0];
  browseTransport.operations = browseTransport.operations.filter((name) => name !== "browser_profile_reset_clear");
  await page.reload();
  await profiles.getByRole("button", { name: "More for default" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Reset profile…" }).count(), 0);
  await page.getByRole("menuitem", { name: "Clear site data…" }).waitFor();
  await page.keyboard.press("Escape");
  browseTransport.operations = browseTransport.operations.filter((name) => name !== "browse_state_receipt_get");
  await page.reload();
  await profiles.getByRole("button", { name: "More for default" }).click();
  await page.getByRole("menu").waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "Reset profile…" }).count(), 0);
  assert.equal(await page.getByRole("menuitem", { name: "Clear site data…" }).count(), 0);
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await handoffs.getByRole("button", { name: "Show 2" }).click();
  assert.equal(await handoffs.locator("details").count(), 0);
  assert.equal(await toolchain.locator("details").count(), 0);

  assert.deepEqual(errors, []);
  console.log(`browse rendered check passed; evidence in ${evidence}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "browse-failure.png"), animations: "disabled" }).catch(() => {});
  console.error(log.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  for (const socket of served.values()) await socket.close();
  await new Promise((resolve) => neko ? neko.close(resolve) : resolve());
  if (!process.env.BROWSE_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
