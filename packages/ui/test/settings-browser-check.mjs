// Optional rendered check of the managed settings editors (ADR 0128/0130) after pnpm test and a ui build.
// Bots, Worker, auth, server and discovery are fixtures on a disposable state directory, but every settings
// document lives in the real @stack/settings store there, so saves have real revision fences and receipts.
// No live server, provider, process start or call.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/settings-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable; SETTINGS_EVIDENCE_DIR keeps screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { publishedJsonSchema, serveSocket, serveWebSocket, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as workerApi } from "../../worker/dist/api.js";
import { SettingsStore, catalog, codexSchema, evidence, settingsState } from "../../settings/dist/src/index.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/tmp", "as-settings-ui-"));
const evidenceDir = process.env.SETTINGS_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidenceDir, { recursive: true });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };

const now = Date.now();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const claude = uuid(3);
const idleWorker = uuid(10), busyWorker = uuid(11), runtime = uuid(90);
const settings = new SettingsStore(new DatabaseSync(join(dir, "settings.db")));
settings.seed("bot-defaults", { model: "gpt-6-sol", model_reasoning_effort: "medium", sandbox_mode: "danger-full-access", approval_policy: "never" }, "Stack baseline");
// bot-1 has a known native null, an explicit false and an explicit empty list: each must render distinctly from Unset.
settings.seed("bot:bot-1", { model: "gpt-6-sol", model_reasoning_effort: "medium", sandbox_mode: "danger-full-access", "voice.prompt": null,
  "voice.includeStartupContext": false, "sandbox_workspace_write.writable_roots": [], "agents.default_subagent_model": "gpt-5-retired" }, "Copied from defaults", 0);
settings.markLoaded("bot:bot-1", "inst-bot-1", settings.get("bot:bot-1"));
settings.seed("bot:bot-2", { model: "gpt-6-sol" }, "Copied from defaults", 0);
for (const provider of ["codex", "grok", "devin", "claude"]) settings.seed(`worker-defaults:${provider}`, {}, "Empty provider defaults");
for (const id of [idleWorker, busyWorker]) {
  settings.seed(`worker:${id}`, { model: "claude-opus-5-5", effort: "high" }, "Saved Worker selection");
  settings.markLoaded(`worker:${id}`, runtime, settings.get(`worker:${id}`));
}

const bots = [
  { id: "bot-1", state: "running", pid: 321, cwd: "/fixture/one", url: "ws://fixture/bot-1", account: "account-1", runningAccount: "account-1", mainThreadId: "thread-1", recoveryIssue: null, roleId: null, roleRevision: null, settings: { model: "gpt-6-sol", reasoningEffort: "medium", sandboxMode: "danger-full-access" } },
  { id: "bot-2", state: "stopped", pid: null, cwd: "/fixture/two", url: null, account: "account-1", runningAccount: null, mainThreadId: "thread-2", recoveryIssue: null, roleId: null, roleRevision: null, settings: { model: "gpt-6-sol" } },
];
const session = (id, phase) => ({ id, botId: "bot-1", threadId: "thread-1", accountId: claude, provider: "claude", model: "claude-opus-5-5", effort: "high",
  repo: "/src/stack", cwd: `/state/workers/${id}`, branch: null, baseCommit: null, sourceDirty: false, roleId: null, roleRevision: null,
  sessionId: "native-session", runtimeInstance: runtime, phase, currentTurnId: null, issue: null, createdAt: now - 60_000, updatedAt: now - 1_000 });
const workers = [session(idleWorker, "idle"), session(busyWorker, "running")];
const writes = [];
let loseNextBotAck = false;
let sockets;

const subject = (id) => id ? `bot:${id}` : "bot-defaults";
const botView = ({ id }) => {
  const saved = settings.get(subject(id));
  if (!saved) throw new Error("unknown Bot");
  const bot = bots.find((item) => item.id === id);
  const running = bot?.state === "running";
  const view = settingsState("codex-app-server", saved, id ? settings.get("bot-defaults") : null, running ? settings.loaded(subject(id), `inst-${id}`) : null, running ? `inst-${id}` : null);
  for (const field of view.fields) {
    if (field.key.startsWith("voice.")) {
      field.loaded = evidence(null, field.key, "Submitted on the active voice call");
      field.pending = Object.hasOwn(saved.values, field.key);
    }
    // The resumed main thread kept a different model: effective evidence may disagree with saved and loaded.
    if (id === "bot-1" && field.key === "model") { field.effective = evidence({ model: "gpt-6-luna" }, "model", "Native main-thread settings", now); field.resolved = evidence({ model: "gpt-6-sol" }, "model", "Native config: user", now); }
  }
  if (!id) view.issues.push("These defaults are copied at Bot creation. Existing Bots keep their saved snapshots.");
  return view;
};
const botEdit = (input, mode) => {
  const { id, ...patch } = input;
  if (mode === "preview") return { ...settings.preview(subject(id), "codex-app-server", patch), issues: ["Native model availability is checked by Codex at use time."] };
  writes.push(["bot_settings_patch", input]);
  const receipt = settings.patch(subject(id), "codex-app-server", patch);
  if (id) sockets.get("bots").publish("bots_changed", id); else sockets.get("bots").publish("defaults_changed");
  // A lost acknowledgement: the write committed, the reply never arrives.
  if (loseNextBotAck) { loseNextBotAck = false; throw new Error("connection closed"); }
  return receipt;
};
const workerView = ({ id, provider }) => {
  if (provider) return settingsState(provider === "claude" ? "claude-sdk" : "opencode-codex", settings.get(`worker-defaults:${provider}`), null, null, null);
  const worker = workers.find((item) => item.id === id);
  const view = settingsState("claude-sdk", settings.get(`worker:${id}`), settings.get("worker-defaults:claude"), settings.loaded(`worker:${id}`, runtime), runtime);
  for (const field of view.fields) field.effective = evidence({ model: worker.model, effort: worker.effort }, field.key, "Native Worker observation", now);
  view.issues.push("Reset removes a saved selection. Existing sessions retain their native selection until explicitly changed; it does not recreate the session.");
  return view;
};
const workerSubject = (target) => target.id ? `worker:${target.id}` : `worker-defaults:${target.provider}`;
const backendOf = (target) => target.provider && target.provider !== "claude" ? "opencode-codex" : "claude-sdk";

const handlers = {
  serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  serve_resources: () => { throw new Error("not part of this fixture"); }, serve_resource_history: () => { throw new Error("not part of this fixture"); },
  account_list: () => ({ accounts: [{ id: "account-1", enabled: true, removing: false, linkedAccounts: [] }] }),
  worker_account_list: () => ({ accounts: [{ id: claude, provider: "claude", enabled: true, ready: true, removing: false, linkedAccounts: [] }] }),
  account_login_current: () => ({ login: null }), worker_account_login_current: () => ({ logins: [] }),
  bot_list: () => ({ bots }), bot_defaults_get: () => ({ model: "gpt-6-sol" }), voice_status: () => ({ call: null }),
  bot_settings_catalog: () => {
    const value = catalog("codex-app-server", "fixture-runtime");
    const defaults = settings.get("bot-defaults");
    for (const field of value.settings) field.applicationDefault = evidence(defaults.values, field.key, "Saved defaults for future Bots", defaults.updatedAt);
    return value;
  },
  bot_settings_read: botView,
  bot_settings_preview: (input) => botEdit(input, "preview"),
  bot_settings_patch: (input) => botEdit(input, "patch"),
  bot_settings_apply: ({ id, expectedRevision }) => {
    writes.push(["bot_settings_apply", { id, expectedRevision }]);
    const bot = bots.find((item) => item.id === id);
    if (bot.state !== "stopped" || settings.get(subject(id)).revision !== expectedRevision) throw new Error("refused");
    Object.assign(bot, { state: "running", url: `ws://fixture/${id}`, runningAccount: bot.account });
    settings.markLoaded(subject(id), `inst-${id}`, settings.get(subject(id)));
    sockets.get("bots").publish("bots_changed", id);
    return { id, revision: expectedRevision, status: "loaded" };
  },
  bot_settings_options: ({ id }) => ({ instance: `inst-${id}`, observedAt: now,
    models: { available: true, issue: null, data: [
      { id: "sol", model: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })), serviceTiers: [{ id: "priority", name: "Priority", description: "Faster" }] },
      { id: "luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "max"].map((reasoningEffort) => ({ reasoningEffort, description: "" })) }] },
    voices: { available: false, data: null, issue: "Native thread/realtime/listVoices unavailable or invalid" },
    features: { available: true, issue: null, data: [{ name: "memories", enabled: false, defaultEnabled: false, stage: "beta" }] },
    requirements: { available: true, issue: null, data: null } }),
  bot_settings_native_schema: () => codexSchema,
  worker_runtime_list: () => ({ runtimes: [{ id: claude, provider: "claude", backend: "claude-sdk", processModel: "session", pids: [], state: "running", pid: null, instance: runtime, error: null }] }),
  worker_list: () => ({ workers: workers.map((worker) => ({ ...worker, turn: null, pendingPermissions: 0 })) }),
  worker_status: ({ id }) => ({ worker: workers.find((item) => item.id === id), turn: null, pending: [] }),
  worker_catalog: ({ accountId }) => ({ accountId, provider: "claude", observedAt: new Date(now).toISOString(), source: "fixture", runtimeVersion: "1", modelConfigId: "model",
    models: [{ id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "high", "max"], effortConfigId: "effort" }, { id: "claude-haiku-4-5", name: "Haiku 4.5", efforts: [], effortConfigId: null }],
    nativeModelIds: [], stale: false, error: null }),
  worker_settings_catalog: ({ provider }) => {
    const value = catalog(provider === "claude" ? "claude-sdk" : "opencode-codex");
    const defaults = settings.get(`worker-defaults:${provider}`);
    for (const field of value.settings) field.applicationDefault = evidence(defaults.values, field.key, "Saved defaults for future Workers", defaults.updatedAt);
    return value;
  },
  worker_settings_read: workerView,
  worker_settings_preview: ({ target, patch }) => settings.preview(workerSubject(target), backendOf(target), patch),
  worker_settings_patch: ({ target, patch }) => {
    writes.push(["worker_settings_patch", { target, patch }]);
    const receipt = settings.patch(workerSubject(target), backendOf(target), patch);
    if (target.id) sockets.get("worker").publish("worker_changed", target.id);
    sockets.get("worker").publish("workers_changed");
    return receipt;
  },
  worker_settings_apply: (input) => {
    writes.push(["worker_settings_apply", input]);
    const worker = workers.find((item) => item.id === input.id);
    if (worker.phase !== "idle" || input.expectedInstance !== worker.runtimeInstance) throw new Error("Settings application requires the exact idle native Worker session");
    const snapshot = settings.get(`worker:${input.id}`);
    settings.markLoaded(`worker:${input.id}`, runtime, snapshot);
    Object.assign(worker, { model: snapshot.values.model ?? worker.model, effort: snapshot.values.effort ?? worker.effort });
    sockets.get("worker").publish("worker_changed", input.id);
    return { id: input.id, revision: snapshot.revision, status: "loaded" };
  },
};
// Anything that would start work, send a prompt or touch a call is a failure of the save/apply separation.
for (const name of ["bot_start", "bot_stop", "voice_dial", "voice_hangup", "worker_start", "worker_send", "worker_cancel", "worker_close", "bot_defaults_set"])
  handlers[name] = (input) => { writes.push([name, input]); throw new Error(`${name} must not be called`); };

let websocket, next, browser, failurePage;
let log = "";
sockets = new Map();
try {
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["worker", "auth", "serve", "bots", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  handlers.docs_snapshot = () => ({ packages: [doc("worker", workerApi), doc("bots", botsApi), doc("auth"), doc("serve"), doc("api")] });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  const definitions = { serve: serve.names, auth: ["account_list", "worker_account_list", "account_login_current", "worker_account_login_current"],
    bots: botsApi.operations.map((operation) => operation.name), worker: workerApi.operations.map((operation) => operation.name), api: ["docs_snapshot"] };
  const topics = { serve: serve.topics, auth: { accounts_changed: "Fixture", worker_accounts_changed: "Fixture" }, bots: botsApi.events.topics, worker: workerApi.events.topics, api: {} };
  for (const [name, names] of Object.entries(definitions)) {
    const answered = Object.fromEntries(names.map((operation) => [operation, handlers[operation] ?? (() => { throw new Error(`${operation} is not part of this fixture`); })]));
    sockets.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, answered),
      events: { topics: topics[name], scope: name === "bots" || name === "worker" ? { valid: () => true, description: "Fixture", example: "id" } : undefined } }));
  }
  const nextPort = await port();
  const origin = `http://127.0.0.1:${nextPort}`;
  env.STACK_WEBSOCKET_ORIGIN = origin;
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  failurePage = page;
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = (name) => page.screenshot({ path: join(evidenceDir, `${name}.png`) });
  const count = (name) => writes.filter(([op]) => op === name).length;

  // --- A running Bot: opening and browsing writes nothing, and evidence stays truthful.
  await page.goto(`${origin}/fleet`);
  const botsWindow = page.locator('[data-window="bots"]');
  await botsWindow.getByRole("button", { name: "bot-1 actions" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const dialog = page.getByRole("dialog", { name: "bot-1 settings" });
  await dialog.getByText("Saved revision").waitFor();
  await dialog.getByText("Models").waitFor();
  await dialog.getByText("unavailable").first().waitFor();
  const group = (name) => dialog.getByRole("button", { name: new RegExp(`^${name}`) });
  const field = (title) => dialog.getByRole("group", { name: title, exact: true });
  await group("Model").click();
  // Saved, loaded, resolved and main-thread evidence can disagree; each is labelled.
  const model = field("Model");
  await model.getByText("Observed on main thread").waitFor();
  assert.equal(await model.locator("dd").nth(3).innerText(), "gpt-6-luna");
  // A saved model discovery no longer offers stays selected and labelled.
  await group("Subagents").click();
  const subagentModel = field("Subagent model");
  assert.equal(await subagentModel.getByRole("combobox").inputValue(), "gpt-5-retired");
  await subagentModel.getByText("Not offered by current discovery; kept as entered.").waitFor();
  await group("Permissions").click();
  assert.match(await field("Writable roots").innerText(), /\[\] \(empty list\)/, "an explicit empty list is not Unset");
  await group("Voice").first().click();
  await group("Voice instructions").click();
  assert.match(await field("Voice prompt replacement").innerText(), /Saved\s+null/, "a native null is not Unset");
  assert.match(await field("Startup context").innerText(), /Saved\s+false/);
  await dialog.getByText("No connected call with this Bot").waitFor();
  await dialog.locator("summary", { hasText: "Native configuration reference" }).click();
  await dialog.getByRole("textbox", { name: "Search native settings" }).fill("model_verbosity");
  await dialog.getByText("managed").first().waitFor();
  assert.equal(writes.length, 0, "opening, browsing and inspecting the schema write nothing");
  await shot("bot-settings-browse");

  // --- Edit: a context budget, an effort from the selected model's native choices, and a prompt reset.
  await group("Context").click();
  const context_ = field("Context window");
  await context_.getByRole("radio", { name: "Set", exact: true }).check();
  await context_.getByRole("textbox").fill("");
  await context_.getByText("Enter a number or choose Unset.").waitFor();
  await context_.getByRole("textbox").fill("120000");
  await field("Model").getByRole("combobox").selectOption("gpt-6-luna");
  const effort = field("Reasoning effort");
  await effort.getByRole("combobox").selectOption("max");
  await field("Voice prompt replacement").getByRole("radio", { name: "Unset", exact: true }).check();
  await dialog.getByText("4 changes not saved").waitFor();
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await dialog.getByText("Native model availability is checked by Codex at use time.").waitFor();
  await shot("bot-settings-review");
  await dialog.getByRole("button", { name: "Save 4 changes" }).click();
  await dialog.getByText("Saved revision 1").waitFor();
  const saved = settings.get("bot:bot-1").values;
  assert.equal(saved.model_context_window, 120000);
  assert.equal(saved.model_reasoning_effort, "max");
  assert.equal(Object.hasOwn(saved, "voice.prompt"), false, "reset omits the prompt rather than saving null");
  assert.deepEqual(writes.at(-1)[1].reset, ["voice.prompt"]);
  assert.equal(bots[0].state, "running", "saving never restarts");
  await field("Context window").getByText(/pending · next start/).waitFor();

  // --- Another writer changes the document during an edit: the draft is kept for review, not overwritten.
  await field("Context window").getByRole("textbox").fill("64000");
  settings.patch("bot:bot-1", "codex-app-server", { expectedRevision: 1, requestId: crypto.randomUUID(), set: { web_search: "cached" } });
  sockets.get("bots").publish("bots_changed", "bot-1");
  await dialog.getByText(/Saved settings changed to revision 2 while you were editing revision 1/).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Review changes" }).isDisabled(), true);
  assert.equal(await field("Context window").getByRole("textbox").inputValue(), "64000", "the draft survives the conflict");
  await dialog.getByRole("button", { name: "Keep my edits on revision 2" }).click();

  // --- A lost acknowledgement: the retry reuses the exact request, so there is one saved change.
  await dialog.getByRole("button", { name: "Review changes" }).click();
  loseNextBotAck = true;
  await dialog.getByRole("button", { name: "Save 1 change" }).click();
  await dialog.getByText(/Save outcome unknown/).waitFor();
  await shot("bot-settings-uncertain");
  const lost = writes.at(-1)[1];
  await dialog.getByRole("button", { name: "Retry same save" }).click();
  await dialog.getByText("Saved revision 3").waitFor();
  assert.deepEqual(writes.at(-1)[1], lost, "the retry sends the identical payload and request ID");
  assert.equal(settings.get("bot:bot-1").revision, 3, "one saved change despite two sends");
  await dialog.getByText("No unsaved changes").waitFor();
  await page.keyboard.press("Escape");

  // --- A stopped Bot starts only by the explicit action, at the exact saved revision.
  await botsWindow.getByRole("button", { name: "bot-2 actions" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const stopped = page.getByRole("dialog", { name: "bot-2 settings" });
  await stopped.getByText("Available while the Bot runs verified.").waitFor();
  await stopped.getByRole("button", { name: "Start with saved settings" }).click();
  await stopped.getByText(/^Running\./).waitFor();
  assert.deepEqual(writes.filter(([op]) => op === "bot_settings_apply").map(([, input]) => input), [{ id: "bot-2", expectedRevision: 0 }]);
  await page.keyboard.press("Escape");

  // --- Defaults for new Bots: future scope, no pending or apply, and a reference Bot for suggestions.
  await botsWindow.getByRole("button", { name: "Bot defaults" }).click();
  const defaults = page.getByRole("dialog", { name: "Defaults for new Bots" });
  await defaults.getByText("Copied into new Bots when they are created.").first().waitFor();
  assert.equal(await defaults.getByText(/pending ·/).count(), 0);
  assert.equal(await defaults.getByRole("button", { name: "Start with saved settings" }).count(), 0);
  await defaults.getByRole("combobox", { name: "Reference Bot for native choices" }).selectOption("bot-1");
  await defaults.getByText("From bot-1").waitFor();
  await defaults.getByRole("button", { name: /^Features/ }).click();
  const memories = defaults.getByRole("group", { name: "memories", exact: true });
  await memories.getByText("disabled · default off · beta").waitFor();
  await memories.getByRole("radio", { name: "On", exact: true }).check();
  await defaults.getByRole("button", { name: "Review changes" }).click();
  await defaults.getByRole("button", { name: "Save 1 change" }).click();
  await defaults.getByText("No unsaved changes").waitFor();
  assert.equal(settings.get("bot-defaults").values["features.memories"], true);
  assert.equal(Object.hasOwn(settings.get("bot:bot-1").values, "features.memories"), false, "defaults are copied, never inherited");
  // Closing with unsaved edits asks first.
  await memories.getByRole("radio", { name: "Unset", exact: true }).check();
  await page.keyboard.press("Escape");
  await defaults.getByText("Discard unsaved settings edits?").waitFor();
  await defaults.getByRole("button", { name: "Discard and close" }).click();
  await defaults.waitFor({ state: "detached" });

  // --- Narrow layout keeps identity and save state visible.
  await page.setViewportSize({ width: 390, height: 844 });
  await botsWindow.getByRole("button", { name: "bot-1 actions" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  await page.getByRole("dialog", { name: "bot-1 settings" }).getByText("No unsaved changes").waitFor();
  await shot("bot-settings-narrow");
  const overflow = await page.evaluate(() => document.querySelector('[role="dialog"]').scrollWidth - document.querySelector('[role="dialog"]').clientWidth);
  assert.ok(overflow <= 1, `the dialog does not scroll sideways (${overflow}px)`);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1500, height: 1000 });

  // --- Workers: save during a turn changes only the saved snapshot; Apply needs the exact idle runtime.
  await page.goto(`${origin}/workers`);
  const list = page.locator('[data-window="workers"]');
  const workerWindow = page.locator('[data-window="worker"]');
  await list.locator(`[data-worker="${busyWorker}"]`).click();
  await workerWindow.getByRole("tab", { name: "Settings" }).click();
  await workerWindow.getByText("Available when idle; the Worker is running.").waitFor();
  assert.equal(await workerWindow.getByRole("button", { name: "Apply saved settings" }).isDisabled(), true);
  const workerEffort = workerWindow.getByRole("group", { name: "Reasoning effort", exact: true });
  await workerEffort.getByRole("combobox").selectOption("max");
  await workerWindow.getByRole("button", { name: "Review changes" }).click();
  await workerWindow.getByRole("button", { name: "Save 1 change" }).click();
  await workerWindow.getByText("No unsaved changes").waitFor();
  assert.equal(settings.get(`worker:${busyWorker}`).values.effort, "max");
  assert.equal(count("worker_send"), 0);

  await list.locator(`[data-worker="${idleWorker}"]`).click();
  await workerWindow.getByRole("tab", { name: "Settings" }).click();
  const workerModel = workerWindow.getByRole("group", { name: "Model", exact: true });
  await workerModel.getByRole("combobox").selectOption("claude-haiku-4-5");
  // The effort saved for Opus is not offered by Haiku: it stays visible rather than being replaced.
  assert.equal(await workerEffort.getByRole("textbox").inputValue(), "high");
  await workerEffort.getByText("Current discovery offers no choices here; kept as entered.").waitFor();
  await workerEffort.getByRole("radio", { name: "Unset", exact: true }).check();
  await workerEffort.getByText("Unset removes the saved override; the current session keeps its native selection.").waitFor();
  await workerWindow.getByRole("button", { name: "Review changes" }).click();
  await workerWindow.getByRole("button", { name: "Save 2 changes" }).click();
  await workerWindow.getByText("No unsaved changes").waitFor();
  await workerWindow.getByText(/2 saved selections not yet submitted/).waitFor();
  await shot("worker-settings");
  await workerWindow.getByRole("button", { name: "Apply saved settings" }).click();
  await workerWindow.getByText("Nothing saved is waiting for this runtime.").waitFor();
  assert.deepEqual(writes.filter(([op]) => op === "worker_settings_apply").map(([, input]) => input), [{ id: idleWorker, expectedRevision: 1, expectedInstance: runtime }]);

  // --- Provider defaults: empty until chosen, suggestions from a reference account, copied not inherited.
  await list.getByRole("button", { name: "Defaults for new Workers" }).click();
  const workerDefaults = page.getByRole("dialog", { name: "Defaults for new Workers" });
  await workerDefaults.getByRole("radio", { name: "Claude", exact: true }).check();
  const defaultModel = workerDefaults.getByRole("group", { name: "Model", exact: true });
  assert.match(await defaultModel.innerText(), /Saved\s+Unset/);
  await defaultModel.getByRole("radio", { name: "Set", exact: true }).check();
  await defaultModel.getByRole("combobox").selectOption("claude-opus-5-5");
  await workerDefaults.getByRole("button", { name: "Review changes" }).click();
  await workerDefaults.getByRole("button", { name: "Save 1 change" }).click();
  await workerDefaults.getByText("No unsaved changes").waitFor();
  assert.deepEqual(settings.get("worker-defaults:claude").values, { model: "claude-opus-5-5" });
  await shot("worker-defaults");

  const forbidden = writes.filter(([op]) => !["bot_settings_patch", "bot_settings_apply", "worker_settings_patch", "worker_settings_apply"].includes(op));
  assert.deepEqual(forbidden, [], "no start, stop, prompt, call or legacy defaults write");
  assert.deepEqual(errors, []);
  console.log(`settings browser check passed; evidence in ${evidenceDir}`);
} catch (error) {
  await failurePage?.screenshot({ path: join(evidenceDir, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  next?.kill();
  await websocket?.close();
  for (const socket of sockets.values()) await socket.close();
  if (!process.env.SETTINGS_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
