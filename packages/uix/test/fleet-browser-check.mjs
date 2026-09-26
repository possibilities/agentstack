// Optional rendered smoke check after pnpm test. No live owner or provider calls.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/fleet-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedJsonSchema, serveSocket, serveWebSocket, socketPath } from "@agentstack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { ChatUploads } from "../../bots/dist/src/chats.js";
import { api as usageApi } from "../../usage/dist/api.js";
import { api as workersApi } from "../../workers/dist/api.js";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const uix = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(uix));
const base = process.env.TMPDIR ?? "/tmp";
const dir = await mkdtemp(join(base, "agentstack-fleet-browser-"));
const evidence = process.env.FLEET_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const botAccounts = [{ id: id(1), enabled: true, removing: false, linkedAccounts: [] }, { id: id(2), enabled: false, removing: false, linkedAccounts: [] }, { id: id(6), enabled: true, removing: false, linkedAccounts: [] }];
const workerAccounts = ["codex", "grok", "devin"].map((provider, index) => ({ id: id(index + 3), provider, enabled: true, ready: true, removing: false, linkedAccounts: [] }));
let defaults = { model: "gpt-6-sol", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" };
const bot = (name, state = "stopped") => ({ id: name, state, pid: state === "running" ? 321 : null, cwd: "/fixture/private/workspace", url: null,
  account: id(1), runningAccount: state === "running" ? id(1) : null, mainThreadId: id(10), recoveryIssue: null, roleRevision: 1, settings: defaults });
let bots = [bot("bot-1", "running"), bot("bot-2")];
let stamp = Date.now();
const observation = { observedAtMs: stamp, lastAttemptAtMs: stamp, fresh: true, error: null };
const usage = { atMs: stamp, inventoryAtMs: stamp, inventoryError: null, accounts: [
  { ...botAccounts[0], scope: "bot", provider: "codex", ready: true, ...observation, usage: { planType: "Pro", limitReached: false, resetCreditsAvailable: 2, resetCreditExpirations: ["2026-10-01"], lanes: [{ id: "primary", title: "Standard", windows: [{ role: "primary", label: "5 hours", windowSeconds: 18000, usedPercent: 24, remainingPercent: 76, resetsAt: "2026-09-26T00:00:00Z", limitName: null, meteredFeature: null }] }] } },
  { ...workerAccounts[1], scope: "worker", ...observation, fresh: false, error: "provider_unavailable", usage: { subscriptionTier: "SuperGrok", included: { usedPercent: 50, remainingPercent: 50, periodType: "monthly", periodStart: "2026-09-01", resetsAt: "2026-10-01", allocatedUsd: 300 }, prepaidBalanceUsd: 12.5, paygEnabled: false, paygUsedUsd: 10, paygCapUsd: 50, paygRemainingUsd: 40 } },
  { ...workerAccounts[2], scope: "worker", ...observation, usage: { planLabel: "Pro", billing: "monthly", dailyRemainingPercent: null, weeklyRemainingPercent: 55, dailyResetsAt: null, weeklyResetsAt: "2026-09-28", periodStart: "2026-09-01", periodEnd: "2026-10-01", promptCreditsMonthly: 100, promptCreditsAvailable: 72, weeklyQuotaHidden: false, displayName: "Fixture" } },
], grokBot: { ...observation, usage: { usedPercent: 33, periodStart: "2026-09-01", resetsAt: "2026-10-01", hasAvailableUsage: true, planLabel: "Grok Bot", fundingPlan: null, onDemandEligible: true, onDemandEnabled: false, trial: false, teamSeat: false } } };
const calls = [];
const uploads = new ChatUploads(dir);
let interruptChunk = true;
const chunkWritten = Promise.withResolvers();
const releaseChunk = Promise.withResolvers();
let chatReadGate;
const activeCall = { sessionId: id(30), botId: "bot-1", threadId: id(10), phase: "connected" };
const passthrough = { parse: (value) => value };
const served = new Map();
let websocket, next, browser;
let log = "";
const mutations = new Set(["bot_start", "bot_stop", "bot_assign", "bot_remove"]);
const handlers = {
  owner_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, docsUrl: null, indexUrl: null, uixUrl: null, inspectorUrl: null }),
  account_list: () => ({ accounts: botAccounts }), worker_account_list: () => ({ accounts: workerAccounts }),
  account_login_current: () => ({ login: null }), worker_account_login_current: () => ({ logins: [] }),
  bot_list: () => ({ bots }), bot_defaults_get: () => defaults, voice_status: () => ({ call: activeCall }),
  voice_speak: ({ sessionId }) => ({ sessionId, status: "submitted" }),
  bot_defaults_set: (input) => { defaults = { ...defaults, ...input }; served.get("bots").publish("defaults_changed"); return defaults; },
  bot_start: (input) => { let item = bots.find((bot) => bot.id === input.id); if (!item) { item = bot(input.id ?? "bot-3"); bots.push(item); } Object.assign(item, { state: "running", pid: 456, account: input.account, runningAccount: input.account, cwd: input.cwd ?? item.cwd, settings: { ...item.settings, ...input.settings } }); return item; },
  bot_stop: (input) => { const item = bots.find((bot) => bot.id === input.id); Object.assign(item, { state: "stopped", pid: null, runningAccount: null }); return item; },
  bot_assign: (input) => { const item = bots.find((bot) => bot.id === input.id); item.account = input.account; return item; },
  bot_remove: (input) => { bots = bots.filter((bot) => bot.id !== input.id); return input; },
  usage_snapshot: () => ({ ...usage, atMs: ++stamp }),
  worker_list: () => ({ workers: [] }), worker_runtime_list: () => ({ runtimes: workerAccounts.map((account) => ({ id: account.id, provider: account.provider, state: "running", instance: id(20), pid: 100, error: null })) }),
  worker_catalog: ({ accountId }) => ({ accountId, provider: workerAccounts.find((account) => account.id === accountId).provider, observedAt: new Date().toISOString(), source: "acp-session", runtimeVersion: "2.1.0", modelConfigId: "model", models: [{ id: "model-native-1", name: "Native model one", efforts: ["low", "medium", "high"], effortConfigId: "effort" }], nativeModelIds: accountId === id(5) ? ["devin-native-model"] : [], stale: false, error: null }),
  chat_list: async ({ botId }) => { await chatReadGate?.promise; return { chats: [{ botId, threadId: id(10), parentThreadId: null, title: "Main thread fixture", cwd: "/fixture", createdAt: "2026-09-25", updatedAt: "2026-09-25", messageCount: 2 }] }; },
  chat_send: () => ({ turn: { id: "fixture-turn", status: "inProgress" } }),
  chat_enqueue: (input) => ({ ...input, state: "pending", turnId: null, issue: null }),
  chat_upload_start: ({ botId, id, name, bytes, sha256 }) => uploads.start(botId, id, name, bytes, sha256),
  chat_upload_status: ({ botId, id }) => uploads.status(botId, id),
  chat_upload_chunk: async ({ botId, id, offset, data }) => {
    const receipt = await uploads.append(botId, id, offset, data);
    if (interruptChunk) { chunkWritten.resolve(); await releaseChunk.promise; interruptChunk = false; throw new Error("Fixture acknowledgement interrupted after writing bytes"); }
    return receipt;
  },
  chat_upload_finish: ({ botId, id }) => uploads.finish(botId, id),
};
function operations(names, api) {
  return names.map((name) => ({ name, description: name, input: api?.operations.find((operation) => operation.name === name)?.input ?? passthrough, output: passthrough,
    async call(_, input) { calls.push({ name, input }); const value = await handlers[name](input); if (mutations.has(name)) served.get("bots").publish("bots_changed", input.id ?? value.id); return value; } }));
}
async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
try {
  websocket = await serveWebSocket({ env, root, port: 0 });
  const catalog = Object.entries({ bots: botsApi, usage: usageApi, workers: workersApi }).map(([name, api]) => ({ name, packageName: `@agentstack/${name}`, description: `${name} fixture`, events: api.events.topics, eventScope: null,
    transports: [{ type: "websocket", description: "Isolated fixture", supported: true, subscriptions: true, endpoint: websocket.urls[name] }],
    operations: api.operations.map((operation) => ({ name: operation.name, title: operation.annotations?.title ?? null, description: operation.description, annotations: operation.annotations ?? {}, inputSchema: publishedJsonSchema(operation.input), outputSchema: publishedJsonSchema(operation.output) })) }));
  for (const name of ["auth", "owner", "api"]) catalog.push({ name, packageName: `@agentstack/${name}`, description: "Fixture", events: {}, eventScope: null, operations: [], transports: [{ type: "websocket", endpoint: websocket.urls[name], supported: true, subscriptions: true, description: "Fixture" }] });
  handlers.docs_snapshot = () => ({ packages: catalog });
  const definitions = { owner: ["owner_status"], auth: ["account_list", "worker_account_list", "account_login_current", "worker_account_login_current"], bots: Object.keys(handlers).filter((name) => /^(bot_|voice_|chat_)/.test(name)), usage: ["usage_snapshot"], workers: ["worker_list", "worker_runtime_list", "worker_catalog"], api: ["docs_snapshot"] };
  const topics = { owner: { pids_changed: "Fixture" }, auth: Object.fromEntries(["accounts_changed", "worker_accounts_changed", "login_changed", "worker_login_changed"].map((name) => [name, "Fixture"])), bots: botsApi.events.topics, workers: workersApi.events.topics, usage: usageApi.events.topics, api: {} };
  for (const [name, names] of Object.entries(definitions)) served.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: operations(names, name === "bots" ? botsApi : undefined), events: { topics: topics[name], scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
  const nextPort = await port();
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: uix, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("agentstack.uix.canvas.v3", JSON.stringify({ spaces: { fleet: { mode: "grid" } } })));
  await page.goto(`${origin}/x/fleet`);
  await page.getByText("Native model one", { exact: true }).first().waitFor();
  await page.screenshot({ path: join(evidence, "fleet-light.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Create Bot", exact: true }).click();
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByRole("button", { name: "Create and start" }).isDisabled(), true);
  await dialog.getByLabel("Codex Bot account").selectOption(id(1));
  await dialog.getByLabel("Bot ID (optional)").fill("smoke-bot");
  await dialog.getByText("Launch settings and arguments", { exact: true }).click();
  await dialog.getByLabel("Model", { exact: true }).fill("fixture-model");
  await dialog.getByLabel("Extra arguments (JSON)").fill("not json");
  await dialog.getByRole("button", { name: "Create and start" }).click();
  await dialog.getByText(/Launch arguments must be a JSON array/).waitFor();
  assert.equal(calls.filter((call) => call.name === "bot_start").length, 0);
  await dialog.getByLabel("Extra arguments (JSON)").fill("[]");
  await page.screenshot({ path: join(evidence, "create-bot.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Create and start" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(calls.find((call) => call.name === "bot_start").input, { id: "smoke-bot", account: id(1), settings: { model: "fixture-model" }, args: [] });
  const card = page.locator('[data-node="bot:smoke-bot"]');
  await card.getByRole("button", { name: "Bot tools", exact: true }).click();
  await dialog.getByLabel("Operation", { exact: true }).selectOption("voice_speak");
  await dialog.getByLabel("text", { exact: true }).fill("Must not reach another Bot");
  assert.equal(await dialog.getByRole("button", { name: "Speak on voice call", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByLabel("sessionId", { exact: true }).inputValue(), "");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await card.getByRole("button", { name: "Stop…", exact: true }).click();
  await dialog.getByRole("button", { name: "Stop Bot", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await card.getByRole("button", { name: "Start…", exact: true }).waitFor();
  await card.getByRole("button", { name: "Assign account…", exact: true }).click();
  await dialog.getByLabel("Codex Bot account").selectOption(id(6));
  await dialog.getByRole("button", { name: "Assign account", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await card.getByRole("button", { name: "Start…", exact: true }).click();
  assert.equal(await dialog.getByLabel("Codex Bot account").inputValue(), id(6));
  await dialog.getByRole("button", { name: "Start Bot", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(calls.filter((call) => call.name === "bot_start").at(-1).input, { id: "smoke-bot", account: id(6) });
  await card.getByRole("button", { name: "Stop…", exact: true }).click();
  await dialog.getByRole("button", { name: "Stop Bot", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await card.getByRole("button", { name: "Bot tools", exact: true }).click();
  await dialog.getByLabel("Operation", { exact: true }).selectOption("chat_list");
  chatReadGate = Promise.withResolvers();
  await dialog.getByRole("button", { name: "Read", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"] select')?.disabled);
  assert.equal(await dialog.getByLabel("limit (optional)", { exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "pending operation cannot be dismissed");
  chatReadGate.resolve();
  await dialog.getByText("Main thread fixture", { exact: true }).waitFor();
  assert.deepEqual(calls.find((call) => call.name === "chat_list").input, { botId: "smoke-bot", limit: 25, offset: 0 });
  served.get("bots").publish("chats_changed", "smoke-bot");
  await dialog.getByText("This snapshot may be out of date after a Bot notice or reconnection. Re-read the relevant operation.", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "bot-tools.png"), animations: "disabled" });
  await dialog.getByLabel("Operation", { exact: true }).selectOption("chat_enqueue");
  await dialog.getByLabel("input", { exact: true }).fill('[{"type":"text","text":"Queue while stopped"}]');
  await dialog.getByRole("button", { name: "Queue chat message", exact: true }).click();
  await dialog.getByText("pending", { exact: true }).waitFor();
  assert.equal(calls.find((call) => call.name === "chat_enqueue").input.botId, "smoke-bot");
  await dialog.getByText("Upload a file to this Bot", { exact: true }).click();
  const content = Buffer.alloc(300_000, "u");
  await dialog.getByLabel("File (up to 20 MB)").setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: content });
  await dialog.getByRole("button", { name: "Upload file", exact: true }).click();
  await chunkWritten.promise;
  const uploadId = calls.find((call) => call.name === "chat_upload_start").input.id;
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await card.getByRole("button", { name: "Bot tools", exact: true }).click();
  await dialog.getByText("Upload a file to this Bot", { exact: true }).click();
  await dialog.getByText(uploadId, { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("File (up to 20 MB)").isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: /Upload file$/ }).isDisabled({ timeout: 2_000 }), true);
  releaseChunk.resolve();
  await dialog.getByText(/Fixture acknowledgement interrupted/).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await card.getByRole("button", { name: "Bot tools", exact: true }).click();
  await dialog.getByText("Upload a file to this Bot", { exact: true }).click();
  await dialog.getByText(uploadId, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Resume upload", exact: true }).click();
  await dialog.getByRole("button", { name: "Copy verified upload path", exact: true }).waitFor();
  const uploaded = await uploads.status("smoke-bot", uploadId);
  assert.deepEqual(await readFile(uploaded.path), content);
  assert.deepEqual(calls.filter((call) => call.name === "chat_upload_chunk").map((call) => call.input.offset), [0, 262_144]);
  assert.equal(calls.filter((call) => call.name === "chat_send").length, 0, "upload never sends a message");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await card.getByRole("button", { name: "Bot tools", exact: true }).click();
  await dialog.getByText("Upload a file to this Bot", { exact: true }).click();
  await dialog.getByText(uploaded.path, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Upload file", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await card.getByRole("button", { name: "Remove…", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove Bot", exact: true }).click();
  await card.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Bot defaults", exact: true }).click();
  await dialog.getByLabel("Model", { exact: true }).fill("future-bot-model");
  await dialog.getByRole("button", { name: "Save defaults", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(defaults.model, "future-bot-model");
  assert.equal(bots.find((bot) => bot.id === "bot-1").settings.model, "gpt-6-sol");
  await page.locator('[data-node="bot:bot-1"]').getByRole("button", { name: "Bot tools", exact: true }).click();
  await dialog.getByLabel("Operation", { exact: true }).selectOption("voice_speak");
  assert.equal(await dialog.getByLabel("sessionId", { exact: true }).getAttribute("readonly"), "");
  await dialog.getByLabel("text", { exact: true }).fill("Fixture speech");
  await dialog.getByRole("button", { name: "Speak on voice call", exact: true }).click();
  await dialog.getByText("submitted", { exact: true }).waitFor();
  assert.deepEqual(calls.find((call) => call.name === "voice_speak").input, { sessionId: activeCall.sessionId, text: "Fixture speech" });
  activeCall.sessionId = id(31);
  served.get("bots").publish("voice_changed");
  await dialog.getByRole("button", { name: "Use current connected call", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Speak on voice call", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Use current connected call", exact: true }).click();
  await dialog.getByRole("button", { name: "Speak on voice call", exact: true }).click();
  await dialog.getByText(id(31), { exact: true }).waitFor();
  assert.equal(calls.filter((call) => call.name === "voice_speak").at(-1).input.sessionId, id(31));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const usageWindow = page.locator('[data-window="usage"]');
  await usageWindow.getByLabel("Filter usage").fill("grok-1");
  await usageWindow.getByText("Monthly allocation", { exact: true }).waitFor();
  assert.match(await usageWindow.innerText(), /\$300\.00/);
  await usageWindow.getByRole("button", { name: "Inspect grok-1 usage", exact: true }).click();
  await page.getByRole("complementary", { name: "Inspector" }).getByText("allocatedUsd", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await usageWindow.getByLabel("Filter usage").fill("stale");
  await usageWindow.getByRole("button", { name: "Inspect grok-1 usage", exact: true }).waitFor();
  assert.equal(await usageWindow.getByRole("button", { name: "Inspect codex-1 usage", exact: true }).count(), 0);
  await usageWindow.getByLabel("Filter usage").fill("");
  const models = page.locator('[data-window="model-catalogs"]');
  await models.getByLabel("Find models").fill("no-such-model");
  await models.getByText("No matching models", { exact: true }).waitFor();
  await models.getByLabel("Find models").fill("devin");
  await models.getByRole("button", { name: "Refresh catalog" }).click();
  await models.getByRole("button", { name: "Refresh catalog" }).waitFor();
  assert.ok(calls.some((call) => call.name === "worker_catalog" && call.input.refresh === true && call.input.accountId === id(5)));
  await models.getByLabel("Find models").fill("");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "fleet-dark.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, "fleet-mobile.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Create Bot", exact: true }).click();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, "mobile dialog fits the viewport");
  await page.screenshot({ path: join(evidence, "create-mobile.png"), animations: "disabled" });
  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "live discovery defaults, catalog filters/refresh, usage inspection/status filters, create validation/payload, stop/assign/restart/remove/defaults, scoped history/speech, stopped queue admission, interrupted upload reopening/resume, light/dark/mobile", actions: calls.filter((call) => mutations.has(call.name)) }, null, 2));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
  throw error;
} finally {
  chatReadGate?.resolve();
  releaseChunk.resolve();
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all([...served.values()].map((socket) => socket.close()));
  if (process.env.FLEET_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
