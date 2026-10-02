// Optional rendered check of System's State and Subscriptions windows, the Server window's Stack settings, the
// developer-only Developer window and the State window's read-only installation factory-reset disclosure, after
// pnpm test (and a ui build, or NEXT_MODE=dev). A fixture serve socket answers the state reads, global settings
// (with real revision fences) and harness release snapshots from a disposable state directory; no live Server,
// state or network release channel is touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/state-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable; STATE_EVIDENCE_DIR keeps the screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveSocket, serveWebSocket, socketPath } from "@stack/api";
import { api as serveApi } from "../../serve/dist/api.js";
import { api as workerApi } from "../../worker/dist/api.js";
import { authorizeBrowser, fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, serveFixture, ui } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/tmp", "as-state-ui-"));
const evidence = process.env.STATE_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const at = new Date().toISOString();
const category = (owner, id, extra = {}) => ({ id: `${owner}:${id}`, ownerPackage: owner, subject: null, kind: "storage", authority: "authoritative", location: "server",
  ownership: "stack", revision: `${owner}-${id}-r1`, observedAt: at, coverage: "partial", items: null, bytes: null, sensitivity: "content", relationships: [],
  reads: [{ package: owner, operation: `${owner}_state_read`, arguments: {} }], actions: [], retention: "Kept until an owner operation removes it.", regeneration: "Not regenerated.", issues: [], ...extra });
const inventory = () => [
  category("bots", "workspaces", { kind: "workspace", coverage: "complete", bytes: 18_874_368, items: 3,
    reads: [{ package: "bots", operation: "bots_state_read", arguments: {} }, { package: "bots", operation: "bot_workspace_list", arguments: {} }],
    actions: [{ package: "bots", operation: "bot_state_plan", arguments: {}, blockedBy: ["Select an exact resource through the linked read and satisfy the operation's lifecycle/revision contract"] }],
    retention: "Ledger-owned workspaces remain until an exact workspace_clear plan is applied.", regeneration: "The next Bot turn recreates an empty workspace." }),
  category("bots", "logs", { kind: "history", coverage: "partial", issues: ["Storage scan bounded at 2000 entries; bytes are unmeasured for this category"] }),
  category("serve", "subscriptions", { kind: "configuration", authority: "authoritative", sensitivity: "content",
    relationships: [{ relation: "automatic-input", package: "serve", kind: "subscription", id: "00000000-0000-4000-8000-0000000000a1" }] }),
  category("usage", "observations", { kind: "cache", ownership: "shared", sensitivity: "ordinary", issues: ["Shared database bytes are not allocated to logical owners"] }),
  category("auth", "credentials", { kind: "credentials", sensitivity: "credential", location: "external", ownership: "external" }),
  // Mirrors the factory-reset declaration in packages/serve/src/state-categories.ts after the shared stateCategories mapping.
  category("serve", "factory-reset", { kind: "runtime", authority: "receipt", sensitivity: "ordinary", coverage: "partial",
    reads: [{ package: "serve", operation: "serve_factory_reset_plan", arguments: {} },
      { package: "serve", operation: "serve_factory_reset_receipt_get", arguments: {} }],
    actions: ["serve_factory_reset_clear", "serve_factory_reset_recover", "serve_factory_reset_fence_release"].map((operation) => ({
      package: "serve", operation, arguments: {}, blockedBy: ["Select an exact resource through the linked read and satisfy the operation's lifecycle/revision contract"] })),
    retention: "Private sibling factory-control ledger keeps content-free reset receipts/digests/generation fences outside erased active state. Source/retained Git, device/Canvas/Client copies and external configuration/backups remain independent.",
    regeneration: "Exact whole-installation admission shuts down owned work and stays stopped/fenced. Only completed-generation release permits a later explicit start/new Access identity; unknown effects never resume.",
    issues: ["Private socket only, no MCP/WebSocket/remote/UI reset. Sibling control bytes and external copies are unmeasured. Independent writers must be quiesced explicitly."] }),
];
const owners = [{ package: "auth", available: true, issue: null }, { package: "bots", available: true, issue: null }, { package: "serve", available: true, issue: null },
  { package: "usage", available: true, issue: null }, { package: "xcom", available: false, issue: "Owner unavailable or does not implement the current inventory contract" }];
let observation = 1;
const lists = [];
const subscription = (id, extra = {}) => ({ id, botId: "alpha", threadId: "019a5e6c-5a7e-7f00-9f3a-4c1d2b3a4f10", instance: "main", pkg: "notify", topic: "notify_changed",
  scope: null, readOperation: "notification_list", state: "active", lastDeliveredAt: Date.now() - 90_000, revision: "rev-1", ...extra });
let subscriptions = [subscription("00000000-0000-4000-8000-0000000000a1"),
  subscription("00000000-0000-4000-8000-0000000000a2", { pkg: "brain", topic: "jobs_changed", readOperation: "jobs_list", state: "error", lastDeliveredAt: null, scope: "ingest" })];
const removals = [];

// Retained completion history: 105 receipts over two 100-row pages, all six states, both delivery kinds,
// one unknown (uncertain) and one cancelled-after-uncertain receipt, active and retired watches.
const startedAt = Date.now() - 3_600_000;
const wid = (c) => `${c.repeat(8)}-0000-4000-8000-000000000000`;
const workerId = wid("a"), turnOld = "10000000-0000-4000-8000-000000000001", turnLatest = "10000000-0000-4000-8000-000000000002";
const receipt = (id, extra = {}) => ({ id, botId: "alpha", threadId: "019a5e6c-5a7e-7f00-9f3a-4c1d2b3a4f10", pkg: "usage", operation: "usage_snapshot",
  recordId: `d0000000-0000-4000-8000-${id.slice(-12)}`, state: "pending", lastDeliveredAt: null, lastDeliveryKind: null, lastError: null,
  nativeAdmissionUncertain: false, subscriptionPresent: true, ...extra });
const workerReceipt = receipt("00000000-0000-4000-8000-0000000000f1", { pkg: "worker", operation: "worker_start",
  recordId: "e0000000-0000-4000-8000-000000000011", state: "delivered", lastDeliveredAt: startedAt + 30_000, lastDeliveryKind: "terminal" });
const notifyReceipt = receipt("00000000-0000-4000-8000-0000000000f2", { pkg: "notify", operation: "notification_send",
  recordId: "e0000000-0000-4000-8000-000000000012", state: "delivered", lastDeliveredAt: startedAt + 60_000, lastDeliveryKind: "terminal", subscriptionPresent: false });
const brainReceipt = receipt("00000000-0000-4000-8000-0000000000f3", { pkg: "brain", operation: "submit",
  recordId: "e0000000-0000-4000-8000-000000000013", state: "delivered", lastDeliveredAt: startedAt + 90_000, lastDeliveryKind: "terminal" });
const unsupportedReceipt = receipt("00000000-0000-4000-8000-0000000000f4", { pkg: "xcom", operation: "xcom_posts_refresh",
  recordId: "e0000000-0000-4000-8000-000000000014", state: "error", lastDeliveryKind: "terminal" });
const unknownReceipt = receipt("00000000-0000-4000-8000-0000000000f5", { pkg: "notify", operation: "notification_send",
  recordId: "e0000000-0000-4000-8000-000000000015", state: "unknown", lastDeliveredAt: startedAt + 10_000, lastDeliveryKind: "update",
  lastError: "native_admission_unknown", nativeAdmissionUncertain: true });
const cancelledUncertainReceipt = receipt("00000000-0000-4000-8000-0000000000f6", { pkg: "notify", operation: "notification_send",
  recordId: "e0000000-0000-4000-8000-000000000016", state: "cancelled", lastDeliveryKind: "terminal",
  lastError: "native_admission_unknown", nativeAdmissionUncertain: true, subscriptionPresent: false });
const bulkStates = ["pending", "error", "observed", "delivered", "cancelled"];
const receipts = [
  workerReceipt, notifyReceipt, brainReceipt, unsupportedReceipt, unknownReceipt, cancelledUncertainReceipt,
  ...Array.from({ length: 99 }, (_, n) => receipt(`f0000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`, {
    state: bulkStates[n % 5], lastDeliveredAt: n % 2 ? startedAt + n * 1_000 : null, lastDeliveryKind: n % 2 ? "update" : "terminal",
    subscriptionPresent: n % 4 !== 0 })),
];
let historyRevision = 1, historyUnavailable = false;
const historyCalls = [];

// Typed occurrence subscriptions: one Bot Chat target, one Worker target, receipts across every delivery state.
const delivery = (id, eventId, state, boundary, error = null) => ({ id, eventId, state, boundary, error });
const botOccurrence = "00000000-0000-4000-8000-0000000000b1", workerOccurrence = "00000000-0000-4000-8000-0000000000b2";
let occurrences = [
  { id: botOccurrence, target: { kind: "bot", botId: "alpha", threadId: "019a5e6c-5a7e-7f00-9f3a-4c1d2b3a4f10", instance: "main" },
    pkg: "xcom", name: "posts", policy: "native", cursor: "fixture-cursor-bot", truncated: false, revision: "o1", receiptCount: 3, receiptsTruncated: false,
    arguments: { account: "fixture-args-bot" }, lastError: null,
    deliveries: [delivery("00000000-0000-4000-8000-00000000d011", "evt-bot-3", "pending", null),
      delivery("00000000-0000-4000-8000-00000000d012", "evt-bot-2", "admitted", "native_admission"),
      delivery("00000000-0000-4000-8000-00000000d013", "evt-bot-1", "unknown", null, "fixture-delivery-error-bot")] },
  { id: workerOccurrence, target: { kind: "worker", workerId, sessionId: "native-session-1", instance: "instance-1" },
    pkg: "github", name: "pull_requests", policy: "interrupt", cursor: "fixture-cursor-worker", truncated: true, revision: "o1", receiptCount: 1, receiptsTruncated: false,
    arguments: { repository: "fixture-args-marker-worker" }, lastError: "fixture-last-error-worker",
    deliveries: [delivery("00000000-0000-4000-8000-00000000d021", "evt-worker-1", "admitted", "worker_inbox")] },
];

// One Worker with two turns; the linked admission targets the older turn, never the latest.
const worker = { id: workerId, botId: "alpha", threadId: "019a5e6c-5a7e-7f00-9f3a-4c1d2b3a4f10", accountId: "00000000-0000-4000-8000-000000000003",
  provider: "codex", model: "gpt-6-sol", effort: "high", repo: "/src/stack", cwd: `${dir}/worktrees/${workerId}`, branch: "stack-worker-check",
  baseCommit: "025e608aa1b2", sourceDirty: false, roleRevision: 1, sessionId: "native-session-1", runtimeInstance: "00000000-0000-4000-8000-000000000090",
  phase: "idle", contentClearedAt: null, currentTurnId: null, issue: null, createdAt: startedAt, updatedAt: startedAt + 500_000 };
const workerTurn = (id, n) => ({ id, workerId, phase: "completed", stopReason: "end_turn", issue: null,
  requestId: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`, prompt: `Turn ${n} prompt`, requestedModel: "gpt-6-sol", requestedEffort: "high",
  observedSettings: null, dispatchedAt: startedAt + n * 100_000, dispatchedPromptSeq: n, createdAt: startedAt + n * 100_000, updatedAt: startedAt + n * 100_000 + 5_000 });
const turns = [workerTurn(turnOld, 1), workerTurn(turnLatest, 2)];
const turnSummary = ({ prompt, ...rest }) => ({ ...rest, promptChars: prompt?.length ?? null });

// Developer mode (ADR 0138). Settings carry real revision fences; release reads and checks refuse while it is off.
const started = Date.now();
const iso = (offset) => new Date(started + offset).toISOString();
const hour = 3_600_000;
let devSettings = { developerMode: false, revision: 0, updatedAt: null };
let settingsGate = null;
const devCalls = [];
const settingsUpdates = [];
const harness = (id, title, sourceUrl, packageName, extra = {}) => ({ id, title, sourceUrl, packageName, channel: packageName ? "npm-latest" : "devin-current",
  version: null, previousVersion: null, changedAt: null, lastAttemptAt: null, lastCompletedAt: null, lastSuccessAt: null, outcome: "not_checked", error: null,
  freshness: "unobserved", staleReason: null, ...extra });
const opencode = (extra) => harness("opencode", "OpenCode", "https://registry.npmjs.org/@opencode/cli/latest", "@opencode/cli", extra);
const codex = (extra) => harness("codex", "Codex", "https://registry.npmjs.org/@openai/codex/latest", "@openai/codex", extra);
const claude = (extra) => harness("claude", "Claude Code", "https://registry.npmjs.org/@anthropic-ai/claude-code/latest", "@anthropic-ai/claude-code", extra);
const devin = (extra) => harness("devin", "Devin CLI", "https://static.devin.ai/cli/current/manifest.json", null, extra);
const checked = (at, extra) => ({ lastAttemptAt: at, lastCompletedAt: at, ...extra });
const observed = (version, at, extra) => checked(at, { version, lastSuccessAt: at, outcome: "succeeded", freshness: "fresh", ...extra });
const problem = (code, message) => ({ code, message });
const unreachable = problem("network_error", "The public release channel could not be reached.");
const rateLimited = problem("rate_limited", "The public release channel rate-limited the check. Retry later or wait for the next scheduled check.");
const invalid = problem("invalid_response", "The release response was not valid JSON with the expected identity and release version.");
const releases = (observations, extra = {}) => ({ checking: null, intervalMs: 21_600_000, timeoutMs: 15_000, maxResponseBytes: 262_144,
  lastAttemptAt: iso(-2 * hour), lastCompletedAt: iso(-2 * hour), nextCheckAt: iso(4 * hour), cacheError: null, observations, ...extra });
const changed = { previousVersion: "2.0.13", changedAt: iso(-2 * hour) };
// Retained from an earlier session: a never-checked source, a baseline, a channel change and a source never reached.
let harnessSnapshot = releases([opencode(), codex(observed("0.50.0", iso(-2 * hour))), claude(observed("2.0.14", iso(-2 * hour), changed)),
  devin(checked(iso(-2 * hour), { outcome: "failed", error: unreachable }))]);
// Mid-check after Check now: one source checking, one failure that keeps its last good value, one first-time failure.
const midCheck = (at) => releases([opencode({ lastAttemptAt: at, outcome: "checking" }),
  codex(observed("0.50.0", iso(-2 * hour), { lastAttemptAt: at, lastCompletedAt: at, outcome: "failed", error: rateLimited, freshness: "stale", staleReason: "check_failed" })),
  claude(observed("2.0.14", iso(-2 * hour), { ...changed, lastAttemptAt: at, outcome: "checking" })),
  devin(checked(at, { outcome: "failed", error: invalid }))], { checking: { startedAt: at }, lastAttemptAt: at, nextCheckAt: new Date(Date.parse(at) + 6 * hour).toISOString() });
const finished = (at, done) => releases([opencode(observed("1.4.2", done, { lastAttemptAt: at })), midCheck(at).observations[1],
  claude(observed("2.0.14", done, { ...changed, lastAttemptAt: at })), midCheck(at).observations[3]],
  { lastAttemptAt: at, lastCompletedAt: done, nextCheckAt: new Date(Date.parse(at) + 6 * hour).toISOString() });
let admitted = null;

const handlers = {
  serve_state_list(args) {
    lists.push(args);
    const revision = `inventory-${observation}`;
    if (args.revision && args.revision !== revision) throw new Error("aggregate inventory changed; restart paging");
    const selected = args.owners ?? owners.map((owner) => owner.package);
    const rows = inventory().filter((row) => selected.includes(row.ownerPackage)).map((row) => args.measure && row.id === "bots:logs" ? { ...row, bytes: 262_144, coverage: "complete", issues: [] } : row);
    return { entries: rows.slice(args.offset, args.offset + 3), revision, observedAt: at, nextOffset: args.offset + 3 < rows.length ? args.offset + 3 : null,
      owners: owners.filter((owner) => selected.includes(owner.package)) };
  },
  serve_subscription_list(args) {
    const rows = subscriptions.filter((row) => (!args.botId || row.botId === args.botId) && (!args.package || row.pkg === args.package));
    return { subscriptions: rows.slice(args.offset, args.offset + args.limit), revision: rows.map((row) => row.revision).join(","), nextOffset: null };
  },
  serve_subscription_get({ id }) {
    const row = subscriptions.find((item) => item.id === id);
    return { subscription: row ? { ...row, readArguments: { limit: 20, filter: { source: "ci" } }, lastError: row.state === "error" ? "jobs_list: brain socket unavailable" : null } : null };
  },
  serve_completion_list(args) {
    historyCalls.push(args);
    if (historyUnavailable) throw new Error("server subscription owner unavailable");
    const revision = `history-${historyRevision}`;
    if (args.revision && args.revision !== revision) throw new Error("completion observation changed; restart paging");
    const rows = receipts.filter((row) => (!args.botId || row.botId === args.botId) && (!args.package || row.pkg === args.package) && (!args.state || row.state === args.state));
    const nextOffset = args.offset + args.limit < rows.length ? args.offset + args.limit : null;
    return { completions: rows.slice(args.offset, args.offset + args.limit), revision, total: rows.length, nextOffset, truncated: nextOffset !== null };
  },
  serve_completion_get({ id }) {
    const found = receipts.find((row) => row.id === id) ?? null;
    if (!found) return { receipt: null, link: null, linkStatus: "not_found" };
    if (id === workerReceipt.id) return { receipt: found, link: { kind: "worker", requestId: found.recordId, workerId, turnId: turnOld }, linkStatus: "resolved" };
    if (id === notifyReceipt.id) return { receipt: found, link: { kind: "notify", notificationId: found.recordId }, linkStatus: "resolved" };
    if (id === brainReceipt.id) return { receipt: found, link: null, linkStatus: "unavailable" };
    return { receipt: found, link: null, linkStatus: "unsupported" };
  },
  serve_occurrence_list(args) {
    const rows = occurrences.map(({ arguments: _args, lastError: _error, deliveries: _deliveries, ...row }) => row)
      .filter((row) => (!args.botId || row.target.kind === "bot" && row.target.botId === args.botId) && (!args.package || row.pkg === args.package));
    const revision = JSON.stringify(occurrences.map((row) => [row.id, row.revision]));
    if (args.revision && args.revision !== revision) throw new Error("occurrence inventory changed; restart paging");
    return { subscriptions: rows.slice(args.offset, args.offset + args.limit), revision, nextOffset: args.offset + args.limit < rows.length ? args.offset + args.limit : null };
  },
  serve_occurrence_get({ id }) {
    return { subscription: occurrences.find((row) => row.id === id) ?? null };
  },
  worker_list: () => ({ workers: [{ ...worker, turn: turnSummary(turns.at(-1)), pendingPermissions: 0 }] }),
  worker_runtime_list: () => ({ runtimes: [] }),
  worker_status: ({ id }) => ({ worker: id === workerId ? worker : null, turn: turnSummary(turns.at(-1)), pending: [] }),
  worker_read: () => ({ entries: [], nextSeq: 0, hasMore: false }),
  worker_turn_list: () => ({ turns, nextId: null, hasMore: false }),
  async serve_settings_read() {
    devCalls.push("serve_settings_read");
    await settingsGate?.promise;
    return { ...devSettings };
  },
  serve_settings_update(args) {
    settingsUpdates.push(args);
    if (args.expectedRevision !== devSettings.revision) throw new Error("serve_settings_revision_conflict: read settings before retrying");
    if (args.developerMode === devSettings.developerMode) return { ...devSettings };
    devSettings = { developerMode: args.developerMode, revision: devSettings.revision + 1, updatedAt: new Date().toISOString() };
    setTimeout(() => serveSock.publish("serve_settings_changed"), 0);
    return { ...devSettings };
  },
  serve_harness_releases() {
    devCalls.push("serve_harness_releases");
    if (!devSettings.developerMode) throw new Error("developer_mode_disabled");
    return harnessSnapshot;
  },
  serve_harness_releases_check() {
    devCalls.push("serve_harness_releases_check");
    if (!devSettings.developerMode) throw new Error("developer_mode_disabled");
    if (!admitted) {
      admitted = new Date().toISOString();
      harnessSnapshot = midCheck(admitted);
      // Like the server, the start notice goes out with admission; the reply says only that it was admitted.
      setTimeout(() => serveSock.publish("harness_releases_changed"), 0);
      return { admitted: true, startedAt: admitted };
    }
    return { admitted: false, startedAt: admitted };
  },
  serve_subscription_remove({ id, expectedRevision }) {
    removals.push({ id, expectedRevision });
    const row = subscriptions.find((item) => item.id === id) ?? occurrences.find((item) => item.id === id);
    if (!row) return { id, removed: false };
    if (row.revision !== expectedRevision) throw new Error("subscription revision changed; inspect it again");
    subscriptions = subscriptions.filter((item) => item.id !== id);
    occurrences = occurrences.filter((item) => item.id !== id);
    return { id, removed: true };
  },
};
// Every other Worker operation stays unobserved: the check exercises list, status, transcript and turn reads only.
for (const name of workerApi.operations.map((operation) => operation.name)) handlers[name] ??= () => { throw new Error(`${name} is not observed in this fixture`); };

const sockets = [];
let websocket, next, browser, serveSock;
let log = "";
let failed = false;
try {
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["serve", "api", "worker"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("serve", serveApi), doc("worker", workerApi), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["worker", workerApi.operations.map((operation) => operation.name), workerApi.events.topics], ["api", ["docs_snapshot"], {}]]) {
    const socket = await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers),
      events: { topics, ...(name === "worker" ? { scope: { valid: () => true, description: "Fixture", example: "id" } } : {}) } });
    sockets.push(socket);
    if (name === "serve") serveSock = socket;
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), process.env.NEXT_MODE === "dev" ? "dev" : "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1800 || next.exitCode !== null) throw new Error(log);
    await wait(50);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 }, reducedMotion: "reduce" });
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = (name, locator) => (locator ?? page).screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  /** Pan the bench so a window is centered, then show it at 100% for a legible element screenshot. */
  const frame = async (target, locator, space = "system") => {
    const box = await locator.boundingBox();
    const size = target.viewportSize();
    await target.locator(`[data-canvas="workbench"][data-space="${space}"]`).evaluate((main, delta) => main.dispatchEvent(new WheelEvent("wheel", { deltaX: delta.x, deltaY: delta.y, bubbles: true, cancelable: true })),
      { x: box.x + box.width / 2 - size.width / 2, y: box.y + Math.min(box.height, size.height - 160) / 2 - size.height / 2 });
    await target.getByRole("button", { name: "Actual size" }).click();
  };
  const framedShot = async (target, name, locator) => { await frame(target, locator); await locator.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" }); };
  await page.goto(`${origin}/system`);
  const state = page.locator('[data-window="state"]');
  const subs = page.locator('[data-window="subscriptions"]');
  const inspector = page.getByRole("region", { name: "Inspector" });
  await page.getByRole("button", { name: /Fit bench/ }).click().catch(() => undefined);

  // Populated, with an unavailable owner kept as a gap and unmeasured bytes named as such.
  await state.getByRole("region", { name: "bots state" }).waitFor();
  await state.getByRole("region", { name: "xcom state" }).getByText("A gap, not an empty store", { exact: false }).waitFor();
  await state.getByText("Owner unavailable or does not implement the current inventory contract").waitFor();
  assert.equal(await state.getByText("unmeasured", { exact: true }).count(), 2, "only the loaded partial categories read as unmeasured");
  await state.getByText("18 MiB", { exact: false }).first().waitFor();
  await state.getByText("5 owners, 1 unavailable", { exact: false }).waitFor();
  await state.getByRole("button", { name: /Load more \(from 3\)/ }).waitFor();
  assert.deepEqual(lists[0], { measure: false, offset: 0, limit: 100 }, "the first read measures nothing");
  await shot("state-populated", state);

  // Details: drill-down actions name no resource; relationships link to the subscription record.
  await state.getByRole("button", { name: "Show bots:workspaces details" }).click();
  await state.getByText("Choose an exact resource in the owner’s view first", { exact: false }).waitFor();
  await state.getByText("Ledger-owned workspaces remain until an exact workspace_clear plan is applied.").waitFor();
  await shot("state-details", state);

  // A continuation after the observation changed restarts paging and says so.
  observation = 2;
  await state.getByRole("button", { name: /Load more/ }).click();
  await state.getByText("The inventory changed while paging", { exact: false }).waitFor();
  assert.equal(lists.at(-2).revision, "inventory-1");
  assert.equal(lists.at(-1).offset, 0);
  await state.getByRole("button", { name: /Load more \(from 3\)/ }).click();
  await state.getByRole("region", { name: "usage state" }).getByText("observations").waitFor();
  await state.getByRole("region", { name: "serve state" }).waitFor();
  await state.getByRole("button", { name: "Show serve:factory-reset details" }).waitFor();
  assert.equal(await state.getByRole("button", { name: /Load more/ }).count(), 0, "the second page ends paging");

  // Inspect a category: the inspector shows its record and the owner links.
  await state.getByRole("button", { name: "Inspect usage:observations state" }).click();
  await inspector.getByText("Owner state · cache", { exact: false }).waitFor();
  await shot("state-inspector");
  await state.getByRole("button", { name: "Inspect usage:observations state" }).click();

  // Explicit measurement for one owner.
  await state.getByLabel("Owner").selectOption("bots");
  await state.getByRole("switch", { name: "Measure storage" }).click();
  await state.getByText("256 KiB", { exact: false }).waitFor();
  assert.deepEqual(lists.at(-1), { owners: ["bots"], measure: true, offset: 0, limit: 100 });
  assert.equal(await state.getByRole("region", { name: "xcom state" }).count(), 0);
  await shot("state-measured", state);

  // Subscriptions: listed without arguments; arguments only on explicit reveal.
  await subs.getByText("notify.notify_changed").waitFor();
  assert.equal(await subs.getByText("filter", { exact: false }).count(), 0, "read arguments are not listed");
  await subs.getByRole("button", { name: "Reveal arguments" }).nth(1).click();
  await subs.getByText("jobs_list: brain socket unavailable").waitFor();
  await subs.getByText("Read arguments · may be sensitive").waitFor();
  await shot("subscriptions-revealed", subs);
  await subs.getByRole("button", { name: "Hide arguments" }).click();

  // A subscription that changed after it was chosen is refused by revision and the list re-reads.
  const dialog = page.getByRole("alertdialog");
  await subs.getByRole("button", { name: "Remove…" }).first().click();
  await dialog.getByText("Input Codex already admitted cannot be recalled", { exact: false }).waitFor();
  await shot("subscriptions-remove");
  subscriptions[0] = { ...subscriptions[0], revision: "rev-2" };
  await dialog.getByRole("button", { name: "Remove subscription" }).click();
  await dialog.getByText("subscription revision changed", { exact: false }).waitFor();
  assert.deepEqual(removals.at(-1), { id: "00000000-0000-4000-8000-0000000000a1", expectedRevision: "rev-1" });
  await dialog.getByText("changed since you chose it", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Choosing it again uses the current revision.
  await subs.getByRole("button", { name: "Remove…" }).first().click();
  await dialog.getByRole("button", { name: "Remove subscription" }).click();
  await page.getByText("Removed subscription notify.notify_changed").waitFor();
  assert.deepEqual(removals.at(-1), { id: "00000000-0000-4000-8000-0000000000a1", expectedRevision: "rev-2" });
  await subs.getByText("notify.notify_changed").waitFor({ state: "detached" });

  // serve_state_changed re-reads subscriptions.
  subscriptions.push(subscription("00000000-0000-4000-8000-0000000000a3", { pkg: "hud", topic: "hud_changed", readOperation: "work_tree" }));
  serveSock.publish("serve_state_changed");
  await subs.getByText("hud.hud_changed").waitFor();
  await shot("subscriptions", subs);

  // History: an unreachable owner is an unavailable state, never an empty page.
  historyUnavailable = true;
  await subs.getByRole("button", { name: "History", exact: true }).click();
  await subs.getByText("Completion history unavailable").waitFor();
  await subs.getByText("server subscription owner unavailable", { exact: false }).waitFor();
  assert.equal(await subs.getByText(/No retained|No receipts match/).count(), 0, "a failed read is never empty history");
  await shot("subscriptions-history-unavailable", subs);
  historyUnavailable = false;
  await subs.getByRole("button", { name: "Refresh subscriptions" }).click();
  await subs.getByText(/Showing 100 of 105 retained receipts · more on later pages/).waitFor();
  assert.deepEqual(historyCalls.at(-1), { offset: 0, limit: 100 }, "the first page passes no filters and the contract's largest page");
  await shot("subscriptions-history", subs);

  // A changed observation mid-paging restarts instead of mixing revisions; the next page then lands.
  historyRevision = 2;
  await subs.getByRole("button", { name: /Load more \(from 100\)/ }).click();
  await subs.getByText("History changed while paging", { exact: false }).waitFor();
  assert.equal(historyCalls.at(-2).revision, "history-1", "the stale continuation was refused");
  assert.equal(historyCalls.at(-1).offset, 0, "paging restarted from the first page");
  await subs.getByRole("button", { name: /Load more \(from 100\)/ }).click();
  await subs.getByText(/Showing 105 of 105 retained receipts/).waitFor();
  assert.equal(await subs.getByRole("button", { name: /Load more/ }).count(), 0, "the last page ends paging");

  // Filters are passed exactly.
  await subs.getByLabel("State").selectOption("unknown");
  await subs.getByText(/Showing 1 of 1 retained receipt/).waitFor();
  assert.equal(historyCalls.at(-1).state, "unknown");
  await subs.getByLabel("State").selectOption("");
  await subs.getByText(/Showing 100 of 105 retained receipts/).waitFor();

  // An uncertain receipt names the uncertainty and offers no unsafe action.
  const completionRow = (id) => subs.locator(`[data-receipt="${id}"]`);
  await completionRow(unknownReceipt.id).getByText(/Update admission outcome uncertain · Earlier admission acknowledged/).waitFor();
  await completionRow(unknownReceipt.id).getByRole("note").getByText(/Delivery is frozen/).waitFor();
  for (const button of await completionRow(unknownReceipt.id).getByRole("button").all()) {
    const name = `${await button.innerText()} ${await button.getAttribute("aria-label") ?? ""}`;
    assert.doesNotMatch(name, /retry|redeliver|resend|rearm|approve|acknowledge|mark/i, `unsafe action ${name}`);
  }
  await completionRow(cancelledUncertainReceipt.id).getByText(/Cancelled after an uncertain native admission/).waitFor();

  // Exact detail: resolved links navigate, unavailable/unsupported owners say so plainly.
  await completionRow(workerReceipt.id).getByRole("button", { name: "Details" }).click();
  await completionRow(workerReceipt.id).getByText("Linked — Resolved to the exact domain record", { exact: false }).waitFor();
  const workerTurnLink = completionRow(workerReceipt.id).getByRole("button", { name: `Worker aaaaaaaa · turn ${turnOld.slice(0, 8)}` });
  await workerTurnLink.waitFor();
  await shot("subscriptions-history-detail", subs);
  await completionRow(notifyReceipt.id).getByRole("button", { name: "Details" }).click();
  await completionRow(notifyReceipt.id).getByRole("link", { name: /Notification e0000000/ }).waitFor();
  await completionRow(brainReceipt.id).getByRole("button", { name: "Details" }).click();
  await completionRow(brainReceipt.id).getByText("Owner unavailable", { exact: false }).waitFor();
  await completionRow(unsupportedReceipt.id).getByRole("button", { name: "Details" }).click();
  await completionRow(unsupportedReceipt.id).getByText("Linking not supported", { exact: false }).waitFor();

  await page.emulateMedia({ colorScheme: "dark" });
  await shot("subscriptions-history-dark", subs);
  await page.emulateMedia({ colorScheme: "light" });

  // Occurrences: receipts count toward the row but arguments, errors and the cursor value stay hidden until Inspect.
  await subs.getByRole("button", { name: "Occurrences", exact: true }).click();
  await subs.getByText("xcom.posts").waitFor();
  await subs.getByText("github.pull_requests").waitFor();
  for (const marker of ["fixture-args-marker-worker", "fixture-last-error-worker", "fixture-cursor-worker", "fixture-args-bot", "fixture-cursor-bot", "fixture-delivery-error-bot"])
    assert.equal(await subs.getByText(marker, { exact: false }).count(), 0, `${marker} hidden before inspection`);
  const occurrenceRow = (id) => subs.locator(`[data-occurrence="${id}"]`);
  await occurrenceRow(workerOccurrence).getByText("cursor held", { exact: true }).waitFor();
  await occurrenceRow(workerOccurrence).getByText("source truncated").waitFor();
  await occurrenceRow(workerOccurrence).getByText("interrupt · cancels before follow-up").waitFor();
  await occurrenceRow(botOccurrence).getByText("native · start-or-steer").waitFor();
  await shot("subscriptions-occurrences", subs);

  await occurrenceRow(workerOccurrence).getByRole("button", { name: "Inspect…" }).click();
  await occurrenceRow(workerOccurrence).getByText("fixture-args-marker-worker", { exact: false }).waitFor();
  await occurrenceRow(workerOccurrence).getByText("fixture-last-error-worker").waitFor();
  await occurrenceRow(workerOccurrence).getByText("fixture-cursor-worker").waitFor();
  await occurrenceRow(workerOccurrence).getByText("Admitted · Worker inbox").waitFor();
  await occurrenceRow(workerOccurrence).getByText("1 of 1 receipts shown").waitFor();
  await occurrenceRow(botOccurrence).getByRole("button", { name: "Inspect…" }).click();
  await occurrenceRow(botOccurrence).getByText("Admitted · native").waitFor();
  await occurrenceRow(botOccurrence).getByText("fixture-delivery-error-bot").waitFor();
  await occurrenceRow(botOccurrence).getByText("3 of 3 receipts shown").waitFor();
  await shot("subscriptions-occurrences-inspected", subs);

  // An intent-revision change drops the open inspection; the other row's stays open on its unchanged revision.
  occurrences.find((row) => row.id === workerOccurrence).revision = "o2";
  serveSock.publish("serve_state_changed");
  await occurrenceRow(workerOccurrence).getByText("Source arguments", { exact: false }).waitFor({ state: "detached" });
  assert.equal(await subs.getByText("fixture-args-marker-worker", { exact: false }).count(), 0, "dropped on revision change");
  await occurrenceRow(botOccurrence).getByText("fixture-args-bot", { exact: false }).waitFor();

  // Removal at the exact intent revision; a stale choice is refused and re-chosen at the current one.
  await occurrenceRow(botOccurrence).getByRole("button", { name: "Remove…" }).click();
  await dialog.getByText(/fences future intake only/).waitFor();
  await dialog.getByText(/Bot Chat alpha/).waitFor();
  await shot("subscriptions-occurrence-remove", subs);
  occurrences.find((row) => row.id === botOccurrence).revision = "o3";
  await dialog.getByRole("button", { name: "Remove occurrence subscription" }).click();
  await dialog.getByText("subscription revision changed", { exact: false }).waitFor();
  assert.deepEqual(removals.at(-1), { id: botOccurrence, expectedRevision: "o1" });
  await dialog.getByText("changed since you chose it", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await occurrenceRow(botOccurrence).getByRole("button", { name: "Remove…" }).click();
  await dialog.getByRole("button", { name: "Remove occurrence subscription" }).click();
  await page.getByText("Removed occurrence subscription xcom.posts").waitFor();
  assert.deepEqual(removals.at(-1), { id: botOccurrence, expectedRevision: "o3" });
  await occurrenceRow(botOccurrence).waitFor({ state: "detached" });

  await page.emulateMedia({ colorScheme: "dark" });
  await shot("subscriptions-occurrences-dark", subs);
  await page.emulateMedia({ colorScheme: "light" });

  // Narrow: both list views stay usable at the smallest width.
  await frame(page, subs);
  const subsGrip = subs.locator('span[title="Resize Subscriptions"]').first();
  const subsEdge = await subsGrip.boundingBox();
  const subsGripY = Math.min(subsEdge.y + subsEdge.height / 2, (page.viewportSize()?.height ?? 0) - 24);
  await page.mouse.move(subsEdge.x + subsEdge.width / 2, subsGripY);
  await page.mouse.down();
  await page.mouse.move(subsEdge.x - 320, subsGripY, { steps: 6 });
  await page.mouse.up();
  assert.ok((await subs.boundingBox()).width < 352, "resized narrow");
  await shot("subscriptions-occurrences-narrow", subs);
  await subs.getByRole("button", { name: "History", exact: true }).click();
  await subs.getByText(/Showing 100 of 105 retained receipts/).waitFor();
  await shot("subscriptions-history-narrow", subs);
  await subsGrip.dblclick();

  // The resolved Worker link opens the exact turn, not the latest one.
  await completionRow(workerReceipt.id).getByRole("button", { name: "Details" }).click();
  await workerTurnLink.waitFor();
  await workerTurnLink.click();
  const workerWin = page.locator('[data-window="worker"]');
  await workerWin.waitFor();
  assert.equal(new URL(page.url()).pathname, "/workers", "the link navigates to the Workers space");
  const turnsTab = workerWin.locator('[role="tab"]').filter({ hasText: "Turns" });
  await workerWin.locator(`article[data-turn-id="${turnOld}"]`).waitFor();
  assert.equal(await turnsTab.getAttribute("aria-selected"), "true", "the Turns view is selected");
  assert.equal(await workerWin.locator(`article[data-turn-id="${turnOld}"]`).getAttribute("aria-current"), "true", "the linked turn is current");
  assert.equal(await workerWin.locator(`article[data-turn-id="${turnOld}"]`).getByText(/Linked turn · 10000000/).count(), 1);
  assert.equal(await workerWin.locator(`article[data-turn-id="${turnLatest}"]`).getAttribute("aria-current"), null, "the latest turn is not focused");
  await frame(page, workerWin, "workers");
  await shot("worker-linked-turn", workerWin);
  await page.goto(`${origin}/system`);
  await subs.getByText("hud.hud_changed").waitFor();

  await page.emulateMedia({ colorScheme: "dark" });
  await shot("state-dark", state);
  assert.ok(!devCalls.includes("serve_harness_releases"), "a page with developer mode off never reads releases");
  await page.close();

  // The factory-reset category's read-only disclosure, on a fresh local page at 2x so the evidence is legible.
  const factory = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  await authorizeBrowser(factory, origin, env);
  factory.on("pageerror", (error) => errors.push(error.message));
  await factory.goto(`${origin}/system?focus=state`);
  const fstate = factory.locator('[data-window="state"]');
  const resetRow = fstate.locator('article[data-node="state-entry:serve:factory-reset"]');
  for (let attempt = 0; !(await resetRow.count()); attempt++) {
    assert.ok(attempt < 5, "the serve:factory-reset row never paged in");
    await fstate.getByRole("button", { name: /Load more/ }).click({ timeout: 5_000 }).catch(() => undefined);
    await resetRow.waitFor({ timeout: 2_000 }).catch(() => undefined);
  }
  await resetRow.getByRole("button", { name: "Show serve:factory-reset details" }).click();
  const disclosure = resetRow.locator("details");
  const summary = disclosure.locator("summary");
  await summary.getByText("Installation factory reset").waitFor();
  assert.equal(await disclosure.getAttribute("open"), null, "the disclosure stays collapsed until chosen");
  assert.equal(await disclosure.getByText("Cold commands · after shutdown").first().isVisible(), false, "a collapsed disclosure shows none of its content");
  await framedShot(factory, "factory-reset-collapsed", resetRow);

  // The disclosure opens by keyboard and keeps its read-only contract.
  await summary.focus();
  await factory.keyboard.press("Enter");
  for (const text of ["Clears, after verified teardown", "Keeps", "Refused", "During and after", "Plan and clear · private socket",
    "Cold commands · after shutdown", "not erased", "<state>.retained-git/<requestId>/vault", "stack.state-flow.*", "stack.uix.browse.intent.*"]) {
    await disclosure.getByText(text, { exact: false }).first().waitFor();
  }

  // Drift guard: the cold commands and the plan request are verbatim from docs/state-control.md and the wire frame.
  const stateDoc = await readFile(new URL("../../../docs/state-control.md", import.meta.url), "utf8");
  for (const label of ["receipt read command", "recovery command", "fence release command"]) {
    const command = (await disclosure.locator(`pre[aria-label="${label}"]`).innerText()).trim();
    assert.ok(stateDoc.split("\n").includes(command), `the ${label} drifts from docs/state-control.md`);
  }
  assert.deepEqual(JSON.parse(await disclosure.locator('pre[aria-label="plan request"]').innerText()),
    { id: 1, method: "tools/call", params: { name: "serve_factory_reset_plan", arguments: { scope: "installation" } } });
  const copies = await disclosure.locator("button").all();
  assert.ok(copies.length > 0, "the disclosure offers copy buttons");
  for (const button of copies) assert.ok((await button.getAttribute("aria-label"))?.startsWith("Copy "), "every disclosure button only copies");
  await framedShot(factory, "factory-reset-light", resetRow);
  await factory.emulateMedia({ colorScheme: "dark" });
  await framedShot(factory, "factory-reset-dark", resetRow);
  await factory.emulateMedia({ colorScheme: "light" });

  // Narrow: the whole State window, including owner-group headers, reflows without horizontal overflow.
  await frame(factory, fstate);
  const stateGrip = fstate.locator('span[title="Resize State"]').first();
  const stateEdge = await stateGrip.boundingBox();
  // The opened disclosure stretches the window past the viewport, so press the grip inside the viewport.
  const gripY = Math.min(stateEdge.y + stateEdge.height / 2, (factory.viewportSize()?.height ?? 0) - 24);
  await factory.mouse.move(stateEdge.x + stateEdge.width / 2, gripY);
  await factory.mouse.down();
  await factory.mouse.move(stateEdge.x - 320, gripY, { steps: 6 });
  await factory.mouse.up();
  assert.ok((await fstate.boundingBox()).width < 352, "resized narrow");
  assert.ok(await fstate.locator("[data-scroll]").evaluate((el) => el.scrollWidth <= el.clientWidth), "the State window has no horizontal overflow");
  assert.ok(await disclosure.evaluate((el) => el.scrollWidth <= el.clientWidth), "the disclosure has no horizontal overflow");
  for (const pre of await disclosure.locator("pre[aria-label]").all())
    assert.ok(await pre.evaluate((el) => el.scrollWidth <= el.clientWidth), `the "${await pre.getAttribute("aria-label")}" pre has no horizontal overflow`);
  const [disclosureBox, scrollBox] = await Promise.all([disclosure.boundingBox(), fstate.locator("[data-scroll]").boundingBox()]);
  assert.ok(disclosureBox.x + disclosureBox.width <= scrollBox.x + scrollBox.width + 1, "the disclosure stays inside the window's scroll body");
  await framedShot(factory, "factory-reset-narrow", fstate);
  await stateGrip.dblclick();
  await factory.close();

  // Developer mode, on a fresh local page at 2x so the evidence is legible.
  const dev = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  await authorizeBrowser(dev, origin, env);
  dev.on("pageerror", (error) => errors.push(error.message));
  const server = dev.locator('[data-window="server"]');
  const developer = dev.locator('[data-window="developer"]');
  const toggle = server.getByRole("switch", { name: "Developer mode" });
  const releaseReads = () => devCalls.filter((name) => name === "serve_harness_releases").length;

  // Unknown until this connection reads the setting: disabled, with no thumb position implying a value.
  settingsGate = Promise.withResolvers();
  await dev.goto(`${origin}/system?focus=developer`);
  await server.getByText("Reading the current setting…").waitFor();
  assert.equal(await toggle.isDisabled(), true, "no save is possible before a read");
  assert.equal(await toggle.getAttribute("data-unknown"), "");
  await framedShot(dev, "developer-settings-unknown", server);
  settingsGate.resolve();
  settingsGate = null;

  // Off by default. A link naming the window reveals nothing, and nothing reads releases.
  await server.getByText("Off by default").waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.equal(await toggle.isDisabled(), false);
  assert.equal(await developer.count(), 0, "a deep link does not reveal the Developer window while off");
  assert.equal(releaseReads(), 0);
  assert.deepEqual(settingsUpdates, [], "nothing is saved on mount");
  await framedShot(dev, "developer-settings-off", server);

  // An explicit keyboard toggle saves at the read revision and reveals the window with the retained observations.
  await toggle.focus();
  await dev.keyboard.press("Space");
  await developer.waitFor();
  assert.deepEqual(settingsUpdates, [{ developerMode: true, expectedRevision: 0 }]);
  await server.getByText(/^On · saved/).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await developer.getByText("Changed upstream").waitFor();
  await developer.getByText(/^was 2\.0\.13 · 2h/).waitFor();
  await developer.getByText("Not checked", { exact: true }).waitFor();
  await developer.getByText("Observed", { exact: true }).waitFor();
  await developer.getByText("Failed", { exact: true }).waitFor();
  await developer.getByText(unreachable.message).waitFor();
  await developer.getByText("Checks every 6 h · 15 s timeout per source", { exact: false }).waitFor();
  const link = developer.getByRole("link", { name: "Claude Code release channel, opens in a new tab" });
  assert.equal(await link.getAttribute("href"), "https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noreferrer");
  assert.doesNotMatch(await developer.innerText(), /update available|\binstalled\b|up to date/i, "no installed-version verdicts");
  assert.equal(await developer.getByRole("button", { name: /install|upgrade/i }).count(), 0, "and no install or upgrade action");
  await framedShot(dev, "developer-settings-on", server);
  await framedShot(dev, "developer-light", developer);
  // It joins the Server column below Packages; nothing else moves.
  await dev.getByRole("button", { name: /Fit bench/ }).click();
  await dev.screenshot({ path: join(evidence, "developer-bench.png"), animations: "disabled" });

  // Check now returns on admission; the started check's progress arrives through the event-driven read.
  const checkNow = developer.getByRole("button", { name: "Check now" });
  await checkNow.click();
  await developer.getByText(/^Check started/).waitFor();
  await developer.getByText("Stale · check failed").waitFor();
  await developer.getByText(rateLimited.message).waitFor();
  await developer.getByText("Checking…").first().waitFor();
  assert.equal(await checkNow.isDisabled(), true, "Check now waits while a check runs");
  assert.equal(devCalls.filter((name) => name === "serve_harness_releases_check").length, 1);
  await framedShot(dev, "developer-checking", developer);
  harnessSnapshot = finished(admitted, new Date().toISOString());
  serveSock.publish("harness_releases_changed");
  await developer.getByText(/^Last check finished/).waitFor();
  await developer.getByText("1.4.2").waitFor();
  assert.equal(await checkNow.isDisabled(), false);

  await dev.emulateMedia({ colorScheme: "dark" });
  await framedShot(dev, "developer-dark", developer);
  await framedShot(dev, "developer-settings-dark", server);
  await dev.emulateMedia({ colorScheme: "light" });

  // Narrow: the four columns reflow to two lines per harness without horizontal overflow.
  await frame(dev, developer);
  const grip = developer.locator('span[title="Resize Developer"]').first();
  const edge = await grip.boundingBox();
  await dev.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await dev.mouse.down();
  await dev.mouse.move(edge.x - 70, edge.y + edge.height / 2, { steps: 6 });
  await dev.mouse.up();
  assert.ok((await developer.boundingBox()).width < 352, "resized narrow");
  assert.equal(await developer.locator("li[aria-hidden]").isVisible(), false, "the column header gives way to two-line rows");
  assert.ok(await developer.locator("[data-scroll]").evaluate((body) => body.scrollWidth <= body.clientWidth), "no horizontal overflow");
  await framedShot(dev, "developer-narrow", developer);
  await grip.dblclick();

  // A save at a revision another client has since replaced is refused once, the current value is shown, nothing retries.
  devSettings = { developerMode: true, revision: devSettings.revision + 2, updatedAt: new Date().toISOString() };
  await frame(dev, server);
  await toggle.click();
  await server.getByText("Changed elsewhere — showing the current value. Try again if you still want to change it.").waitFor();
  assert.deepEqual(settingsUpdates.at(-1), { developerMode: false, expectedRevision: 1 });
  assert.equal(settingsUpdates.length, 2, "no automatic retry with the newer revision");
  await server.getByText(/^On · saved/).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await framedShot(dev, "developer-settings-conflict", server);

  // Turning it off here, now at the current revision, removes the window and stops release reads at once.
  await toggle.click();
  await developer.waitFor({ state: "detached" });
  assert.deepEqual(settingsUpdates.at(-1), { developerMode: false, expectedRevision: 3 });
  await server.getByText(/^Off · saved/).waitFor();
  const offReads = releaseReads();
  serveSock.publish("harness_releases_changed");
  await wait(300);
  assert.equal(releaseReads(), offReads, "no release reads while off");
  await toggle.click();
  await developer.getByText("1.4.2").waitFor();

  // Another client turns it off while keyboard focus is in the window: it leaves, focus returns to the bench, reads stop.
  await checkNow.focus();
  devSettings = { developerMode: false, revision: devSettings.revision + 1, updatedAt: new Date().toISOString() };
  serveSock.publish("serve_settings_changed");
  await developer.waitFor({ state: "detached" });
  await dev.waitForFunction(() => document.activeElement?.getAttribute("data-canvas") === "workbench");
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  const reads = releaseReads();
  serveSock.publish("harness_releases_changed");
  await wait(400);
  assert.equal(releaseReads(), reads, "no release reads after developer mode is off");

  // A reload with the window's layout remembered still shows nothing while off.
  await dev.goto(`${origin}/system?focus=developer`);
  await server.getByText(/^Off · saved/).waitFor();
  await wait(300);
  assert.equal(await developer.count(), 0);
  assert.equal(releaseReads(), reads);

  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "mixed owner availability with a visible gap, nullable and measured bytes, drill-down action note, stale-page restart, inspector, explicit per-owner measurement, argument reveal only on drill-down, stale-revision removal refused then exact removal, serve_state_changed refresh, dark; history unavailable never renders as empty, revision restart mid-paging then completion, exact state filter, uncertainty wording with no unsafe controls, exact detail with resolved/unavailable/unsupported link statuses, Worker link opens the exact linked turn on /workers, dark and narrow; occurrence markers hidden until Inspect then dropped on intent-revision change, exact revision-fenced removal refused stale then exact, dark and narrow; factory-reset disclosure collapsed until keyboard-opened, read-only content with doc-pinned cold commands and copy-only buttons, dark and narrow without overflow; developer mode unknown before read, off by default with no release reads or deep-link reveal, keyboard enable at the read revision, retained not-checked/observed/changed/failed rows, source links, Check now admission through event-driven read with checking and stale-after-failure, dark, narrow reflow, refused stale-revision save without retry, remote disable removing the window and returning focus, no reads after disable or reload" }, null, 2));
} catch (error) {
  failed = true;
  const page = browser?.contexts().flatMap((context) => context.pages()).at(-1);
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
  if (log) console.error(log.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all(sockets.map((socket) => socket.close()));
  if (!(failed && evidence.startsWith(dir))) await rm(dir, { recursive: true, force: true });
}
