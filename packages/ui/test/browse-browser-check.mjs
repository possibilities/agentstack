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
import { publishedJsonSchema, serveSocket, serveWebSocket, socketPath } from "@stack/api";
import { anyObject, fixtureDoc, freePort as port, gatewayRoot, ui, z, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/tmp", "as-browse-ui-"));
const evidence = process.env.BROWSE_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const { api: browseApi } = await import("../../browse/dist/api.js");
const served = new Map(), calls = [];
let websocket, next, browser, neko, page, log = "";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
let nekoBase = "";
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
  browser_handoff_completion: () => ({ result: null }),
  browser_controller_select: () => { throw new Error("the UI must not select controllers"); },
  browser_handoff_take: (input) => act("take", input),
  browser_handoff_finish: (input) => act("finish", input),
  browser_profile_create: (input) => {
    const profile = { id: uuid(100 + state.profiles.length), botId: input.botId, label: input.label, default: false, createdAt: iso(), state: "starting", error: null, observedAt: null, cdpUrl: null, observation: null };
    state.profiles.push(profile); publish("browser_profiles_changed"); return profile;
  },
  browser_profile_delete: (input) => {
    assert.equal(input.confirm, "delete");
    state.profiles = state.profiles.filter((item) => item.id !== input.profileId); publish("browser_profiles_changed"); return { deleted: true };
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

  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  const definitions = { browse: Object.keys(handlers).filter((name) => name.startsWith("browser_") || name.startsWith("agent_browser_") || name.startsWith("hypeman_")),
    serve: serve.names, bots: ["bot_list", "bot_defaults_get", "voice_status"], api: ["docs_snapshot"] };
  const topics = { browse: browseApi.events.topics, serve: serve.topics, bots: botsApi.events.topics, api: {} };
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, Object.keys(definitions)), port: 0 });
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
    if (attempt > 1200 || next.exitCode !== null) throw new Error(log);
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

  // Profiles: grouped, failed shown with its error, default not deletable, unassigned deletable by name.
  await profiles.getByText("CDP readiness exceeded 35s").waitFor();
  await profiles.getByRole("button", { name: "More for default" }).click();
  await page.getByRole("menuitem", { name: "A Bot's default profile can't be deleted" }).waitFor();
  await page.keyboard.press("Escape");
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

  // Inspecting a handoff shows its record and links.
  await handoffs.getByRole("button", { name: /Inspect Sign in to GitHub/ }).click();
  await page.getByText(/Browser handoff · Completed · reported/).waitFor();

  // The b key reaches Browse from another space.
  await page.goto(`${origin}/fleet`);
  await page.locator('[data-window="bots"]').waitFor();
  await page.keyboard.press("b");
  await page.waitForURL(/\/browse/);

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
