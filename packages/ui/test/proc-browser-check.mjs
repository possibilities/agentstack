// Optional rendered check of the Proc space. The real Proc API runs against a disposable state
// directory seeded through ProcStore; server, auth, worker, bots, usage and discovery are fixtures.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/proc-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable. PROC_NEXT=start uses a prior `next build`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as procApi } from "../../proc/dist/api.js";
import { ProcStore } from "../../proc/dist/src/store.js";
import { authorizeBrowser, fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
// Unix socket paths are short; keep the state directory near the root of the temporary tree.
const dir = await mkdtemp(join("/tmp", "as-proc-ui-"));
const evidence = process.env.PROC_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };

const botAuthority = (botId) => ({ kind: "bot", botId, mainThreadId: `main-${botId}`, threadId: `thread-${botId}` });
const operatorActor = { kind: "operator" };
const legacyActor = { kind: "legacy_unknown" };
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const msAgo = (ms) => now - ms;
const apiAction = { type: "api", package: "notify", operation: "notify_push", input: {} };
const processAction = (args, env) => ({ type: "process", process: { command: "/bin/echo", args, cwd: "/tmp", env, timeoutMs: null, retainOutput: true } });
const seedIds = { bot: "11111111-0000-4000-8000-000000000001", legacy: "11111111-0000-4000-8000-000000000002", blocked: "11111111-0000-4000-8000-000000000003" };
const seedExecutions = ["11111111-0000-4000-8000-000000000010", "11111111-0000-4000-8000-000000000011", "11111111-0000-4000-8000-000000000012"];

// Seed the Proc store directly: a Bot-owned due schedule with history, a legacy unattributed one
// that needs reauthorization, and a blocked one whose Bot was removed.
const seed = new ProcStore(join(dir, "proc"));
seed.createSchedule(seedIds.bot, { label: "Bot nightly sync", action: apiAction, firstAt: new Date(now + 3_600_000).toISOString(), everyMs: 7_200_000, enabled: true }, botAuthority("bot-1"));
seed.createSchedule(seedIds.legacy, { label: "Legacy reminder", action: processAction(["remember"], { LEGACY_KEY: "oldvalue" }), firstAt: ago(86_400_000), everyMs: null, enabled: false }, operatorActor);
seed.db.prepare("UPDATE schedules SET authority=NULL, created_by=?, edited_by=?, blocked_reason='legacy_reauthorization_required', next_at=NULL WHERE id=?")
  .run(JSON.stringify(legacyActor), JSON.stringify(legacyActor), seedIds.legacy);
seed.createSchedule(seedIds.blocked, { label: "Bot-gone wakeup", action: apiAction, firstAt: ago(3_600_000), everyMs: 3_600_000, enabled: true }, botAuthority("bot-gone"));
seed.db.prepare("UPDATE schedules SET blocked_reason='bot_removed', retry_at=NULL, next_at=NULL WHERE id=?").run(seedIds.blocked);
const insertExecution = seed.db.prepare("INSERT INTO executions (id,schedule_id,due_at,state,started_at,finished_at,authority,action,result,error,process_id) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)");
const seedAuthority = JSON.stringify(botAuthority("bot-1"));
const seedAction = JSON.stringify(apiAction);
insertExecution.run(seedExecutions[0], seedIds.bot, msAgo(3 * 3_600_000), "completed", ago(3 * 3_600_000), ago(3 * 3_600_000 - 30_000), seedAuthority, seedAction, JSON.stringify({ sent: true }), null);
insertExecution.run(seedExecutions[1], seedIds.bot, msAgo(2 * 3_600_000), "failed", ago(2 * 3_600_000), ago(2 * 3_600_000 - 20_000), seedAuthority, seedAction, null, "call_outcome_unknown");
insertExecution.run(seedExecutions[2], seedIds.bot, msAgo(3_600_000), "unknown", ago(3_600_000), ago(3_600_000 - 10_000), seedAuthority, seedAction, null, "dispatch_interrupted");

const handlers = {
  serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  serve_resource_history: () => ({ snapshots: [], nextCursor: null }),
  serve_resources: () => ({ observation: { snapshotId: null, capturedAt: null, ageMs: null, freshness: "unavailable", lastAttemptAt: null, error: "server_missing", source: "unsupported", intervalMs: 5_000, staleAfterMs: 15_000, collectionDurationMs: null, coverage: null },
    host: null, capabilities: { rssBytes: false, virtualBytes: false, cpuTimeMs: false, cpuPercent: false, threads: false, diskIoBytes: false, openFileDescriptors: false, networkBytes: false, gpu: false, perSessionAllocation: false },
    retention: { maxSamples: 0, maxProcessRecords: 0, retainedSamples: 0, oldestAttemptAt: null, newestAttemptAt: null, droppedSamples: 0 }, runtime: null,
    scopes: [], processes: [], page: { offset: 0, limit: 100, total: 0, nextOffset: null } }),
  account_list: () => ({ accounts: [] }), worker_account_list: () => ({ accounts: [] }),
  account_login_current: () => ({ login: null }), worker_account_login_current: () => ({ logins: [] }),
  bot_list: () => ({ bots: [{ id: "bot-1", state: "running", pid: 321, cwd: "/fixture/workspace", url: null, account: null, runningAccount: null, mainThreadId: "main-bot-1", recoveryIssue: null, roleRevision: null, settings: null }] }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
  chat_list: () => ({ chats: [] }),
  chat_thread_read: () => ({ messages: [] }),
  worker_list: () => ({ workers: [] }), worker_runtime_list: () => ({ runtimes: [] }),
  usage_snapshot: () => ({ atMs: now, inventoryAtMs: now, inventoryError: null, accounts: [] }),
};
const sockets = new Map();
let websocket, next, browser, proc;
let log = "";
const call = (name, arguments_) => socketCall(socketPath("proc", env), "tools/call", { name, arguments: arguments_ });

try {
  proc = await serveApi({ name: "proc", transport: "socket", env, root });
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["proc", "serve", "auth", "worker", "bots", "usage", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("proc", procApi), doc("bots", botsApi), doc("serve"), doc("auth"), doc("worker"), doc("usage"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  const definitions = { serve: serve.names, auth: ["account_list", "worker_account_list", "account_login_current", "worker_account_login_current"],
    worker: ["worker_list", "worker_runtime_list"], bots: ["bot_list", "bot_defaults_get", "voice_status", "chat_list", "chat_thread_read"], usage: ["usage_snapshot"], api: ["docs_snapshot"] };
  const topics = { serve: serve.topics,
    auth: { accounts_changed: "Fixture", login_changed: "Fixture", worker_accounts_changed: "Fixture", worker_login_changed: "Fixture" },
    worker: { workers_changed: "Fixture" }, bots: botsApi.events.topics, usage: { usage_changed: "Fixture" }, api: {} };
  for (const [name, names] of Object.entries(definitions)) {
    sockets.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
      operations: fixtureOperations(names, handlers), events: { topics: topics[name], scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  const mode = process.env.PROC_NEXT === "start" ? "start" : "dev";
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 2400 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Operator fixtures through the real API: a secret-bearing schedule, a schedule to remove,
  // a noisy failed run, a long-lived run for Stop, and a run that keeps no output.
  // Enabled so it runs once at startup — the execution record carries the captured env for the masking checks.
  const secret = await call("proc_schedule_create", { label: "Secret keeper", firstAt: ago(60_000), everyMs: null, enabled: true,
    action: { type: "process", process: { command: "/bin/echo", args: ["hello"], cwd: "/tmp", env: { API_TOKEN: "s3cret" }, timeoutMs: null, retainOutput: true } } });
  const removable = await call("proc_schedule_create", { label: "Drop me", firstAt: ago(60_000), everyMs: null, enabled: false,
    action: processAction(["drop"], { DROP_KEY: "dropvalue" }) });
  // 300 lines so the ~200-line tail leaves exactly one page of earlier output.
  const noisy = await call("proc_run_start", { requestId: randomUUID(), label: "Noisy lines",
    process: { command: "/bin/sh", args: ["-c", "for i in $(seq 1 150); do echo line $i; echo err $i >&2; done; exit 3"], cwd: "/tmp", timeoutMs: 60_000, retainOutput: true } });
  const sleeper = await call("proc_run_start", { requestId: randomUUID(), label: "Long sleep",
    process: { command: "/bin/sleep", args: ["600"], cwd: "/tmp", timeoutMs: null, retainOutput: true } });
  const forgotten = await call("proc_run_start", { requestId: randomUUID(), label: "Forgotten output",
    process: { command: "/bin/sh", args: ["-c", "echo once; echo twice >&2"], cwd: "/tmp", timeoutMs: 60_000, retainOutput: false } });
  await call("proc_run_join", { id: noisy.id, waitMs: 30_000 });
  await call("proc_run_join", { id: forgotten.id, waitMs: 30_000 });
  // The secret schedule runs its one shot on startup; wait for its execution record.
  for (let attempt = 0; attempt < 50; attempt++) {
    const { executions } = await call("proc_execution_list", { id: secret.id, limit: 10 });
    if (executions.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 2600, height: 1300 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`${origin}/proc`);
  const schedules = page.locator('[data-window="proc-schedules"]');
  const schedule = page.locator('[data-window="proc-schedule"]');
  const runs = page.locator('[data-window="proc-runs"]');
  const run = page.locator('[data-window="proc-run"]');
  const timeline = page.locator('[data-window="proc-timeline"]');
  const row = (text) => schedules.locator('[data-node^="proc-schedule:"]').filter({ hasText: text });

  // The list groups by what needs a person: the legacy and Bot-gone schedules, then upcoming.
  await page.getByRole("button", { name: "Spaces · Proc" }).waitFor();
  await schedules.getByText("Legacy reminder").waitFor();
  await schedules.getByText("Bot-gone wakeup").waitFor();
  await schedules.getByRole("button", { name: /Needs you/ }).waitFor();
  await schedules.getByRole("button", { name: /Upcoming/ }).waitFor();
  await row("Bot nightly sync").waitFor();
  // Off starts collapsed; the idle operator schedules hide there.
  assert.equal(await row("Secret keeper").count(), 0, "idle schedules start collapsed under Off");
  await schedules.getByRole("button", { name: /Off/ }).click();
  await row("Secret keeper").waitFor();
  await page.screenshot({ path: join(evidence, "proc-schedules.png"), animations: "disabled" });

  // Schedule detail: the secret's name shows but its value never renders before Reveal.
  await row("Secret keeper").click();
  await schedule.getByRole("heading", { name: "Secret keeper" }).waitFor();
  await schedule.getByText("API_TOKEN").waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes("s3cret"), "the secret value must not render before Reveal");
  await schedule.getByRole("button", { name: "Reveal" }).first().click();
  await schedule.getByText("s3cret").waitFor();
  await schedule.getByRole("button", { name: "Hide" }).first().click();
  assert.ok(!(await schedule.innerText()).includes("s3cret"), "Hide masks the value again");

  // Inspecting the schedule or one of its executions never leaks env values.
  await schedule.getByRole("button", { name: "Inspect Secret keeper" }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByText("action", { exact: true }).waitFor();
  await inspector.getByText("••••••").first().waitFor();
  assert.ok(!(await inspector.innerText()).includes("s3cret"), "the inspector masks schedule env values");
  await page.screenshot({ path: join(evidence, "proc-inspector.png"), animations: "disabled" });
  const executionRow = schedule.locator('[data-node^="proc-execution:"]').first();
  await executionRow.waitFor();
  await executionRow.getByRole("button", { name: /Inspect execution/ }).click();
  await inspector.getByText("processId").waitFor();
  assert.ok(!(await inspector.innerText()).includes("s3cret"), "the inspector masks execution env values");

  // Enable then Disable on the same schedule (one-shot API schedule to avoid launching a process).
  await row("Drop me").click();
  await schedule.getByRole("heading", { name: "Drop me" }).waitFor();
  await schedule.getByRole("button", { name: "Enable…" }).click();
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await schedule.getByText("Enabled", { exact: true }).waitFor();
  await schedule.getByRole("button", { name: "Disable…" }).click();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await schedule.getByText("Disabled", { exact: true }).waitFor();
  // Removing keeps a tombstone under Removed.
  await schedule.getByRole("button", { name: "Remove…" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await schedules.getByRole("button", { name: /Removed/ }).waitFor();
  await schedules.getByRole("button", { name: /Removed/ }).click();
  await row("Drop me").waitFor();

  // Reauthorization keeps the reviewed disabled state and clears the legacy flag.
  await row("Legacy reminder").click();
  await schedule.getByRole("heading", { name: "Legacy reminder" }).waitFor();
  await schedule.getByRole("button", { name: "Reauthorize…" }).click();
  await page.getByRole("button", { name: "Reauthorize", exact: true }).click();
  await schedule.getByText("Disabled", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "proc-schedule-detail.png"), animations: "disabled" });

  // Runs group by state: the sleeper runs, the noisy run needs a look, the rest finish.
  await runs.locator('section[aria-label="Running"]').getByText("Long sleep").waitFor();
  await runs.locator('section[aria-label="Needs a look"]').getByText("Noisy lines").waitFor();
  await runs.getByRole("button", { name: /Finished/ }).waitFor();

  // The Run window tails the last ~200 lines; backscroll reaches the beginning; stderr is marked.
  await runs.locator('[data-node^="proc-run:"]').filter({ hasText: "Noisy lines" }).click();
  await run.getByRole("heading", { name: "Noisy lines" }).waitFor();
  await run.getByText("line 150", { exact: true }).waitFor();
  assert.ok((await run.innerText()).includes("err 150"), "stderr lines render");
  // Backscroll reaches the beginning in one page.
  await run.getByRole("button", { name: /Load earlier lines/ }).click();
  await run.getByText("line 1", { exact: true }).waitFor();
  await run.getByLabel("Stream").selectOption("stderr");
  await run.getByText("err 2", { exact: true }).waitFor();
  assert.equal(await run.getByRole("log").getByText("line 3", { exact: true }).count(), 0, "stderr filter drops stdout lines");
  await run.getByLabel("Stream").selectOption("");
  await page.screenshot({ path: join(evidence, "proc-run-output.png"), animations: "disabled" });

  // A run that keeps no output says so, and stopping the sleeper reaches Stopped.
  await runs.getByRole("button", { name: /Finished/ }).click();
  await runs.locator('[data-node^="proc-run:"]').filter({ hasText: "Forgotten output" }).click();
  await run.getByText(/doesn't keep output after it exits/).waitFor();
  await runs.locator('[data-node^="proc-run:"]').filter({ hasText: "Long sleep" }).click();
  await run.getByRole("heading", { name: "Long sleep" }).waitFor();
  await run.getByRole("button", { name: "Stop…" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await run.getByText("Stopped", { exact: true }).waitFor();

  // Timeline: seeded executions render as marks; clicking one opens its schedule's execution.
  await timeline.locator(`[data-node="proc-execution:${seedExecutions[1]}"]`).waitFor();
  await timeline.locator(`[data-node="proc-execution:${seedExecutions[1]}"]`).click();
  await schedule.getByRole("heading", { name: "Bot nightly sync" }).waitFor();
  await schedule.locator(`[data-node="proc-execution:${seedExecutions[1]}"]`).waitFor();
  await page.screenshot({ path: join(evidence, "proc-timeline.png"), animations: "disabled" });

  // The Spaces menu carries Proc's human attention items; reauthorization clears the legacy one.
  await page.getByRole("button", { name: "Spaces · Proc" }).click();
  const procItem = page.locator('[role=menuitem][aria-current="location"]');
  await procItem.waitFor();
  const title = await procItem.getAttribute("title");
  assert.ok(title, "the Proc space flags attention in the Spaces menu");
  assert.ok(!title.includes("Legacy reminder needs reauthorization"), `reauthorized legacy clears the flag: ${title}`);
  assert.ok(title.includes("Its Bot was removed"), `the blocked Bot schedule still flags: ${title}`);
  await page.keyboard.press("Escape");

  // The Fleet Bot card links its schedule count into a filtered Schedules list.
  await page.goto(`${origin}/fleet`);
  await page.getByRole("link", { name: /schedule/ }).first().waitFor();
  await page.getByRole("link", { name: /1 schedule/ }).first().click();
  await schedules.getByText("Bot nightly sync").waitFor();
  assert.ok(!(await schedules.innerText()).includes("Legacy reminder"), "the Bot filter hides operator and legacy schedules");

  // Dark and narrow captures.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "proc-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.screenshot({ path: join(evidence, "proc-narrow.png"), animations: "disabled" });

  assert.equal(consoleErrors.filter((text) => /cannot be a descendant|hydration/i.test(text)).length, 0,
    `no invalid-nesting or hydration console errors: ${consoleErrors.join(" | ")}`);

  assert.deepEqual(errors, []);
  console.log(`proc rendered check passed; evidence in ${evidence}`);
} catch (error) {
  if (browser) {
    const pages = browser.contexts()[0]?.pages() ?? [];
    for (const page of pages) await page.screenshot({ path: join(evidence, "proc-failure.png"), animations: "disabled" }).catch(() => {});
    for (const page of pages) for (const id of ["proc-schedules", "proc-schedule", "proc-runs", "proc-run", "proc-timeline"]) console.error(`${id}:`, await page.locator(`[data-window="${id}"]`).innerText().catch(() => "unavailable"));
  }
  console.error(log.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  for (const socket of sockets.values()) await socket.close();
  await proc?.close();
  seed.db.close();
  if (!process.env.PROC_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
