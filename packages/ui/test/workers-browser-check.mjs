// Optional rendered check of the read-only Workers space after pnpm test and a ui build. Worker, auth,
// Bots, server and discovery are fixtures on a disposable state directory; the real Roles API provisions its
// Manager and Worker Roles there. No live server or provider calls.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/workers-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as rolesApi } from "../../roles/dist/api.js";
import { api as workerApi } from "../../worker/dist/api.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
// Unix socket paths are short; keep the state directory near the root of the temporary tree.
const dir = await mkdtemp(join("/tmp", "as-workers-ui-"));
const evidence = process.env.WORKERS_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
// Nothing of the live Stack environment reaches the fixture: only the disposable state directory is named.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };

const account = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wid = (c) => `${c.repeat(8)}-0000-4000-8000-000000000000`;
const tid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.now();
const claude = account(3), codex = account(4);
const workerAccounts = [{ id: claude, provider: "claude", enabled: true, ready: true, removing: false, linkedAccounts: [] },
  { id: codex, provider: "codex", enabled: true, ready: true, removing: false, linkedAccounts: [] }];
const session = (id, extra) => ({ id, botId: "bot-1", threadId: "thread-1", accountId: claude, provider: "claude", model: "claude-opus-5-5", effort: "high",
  repo: "/src/stack", cwd: `/state/workers/worktrees/${id}`, branch: `stack-worker-${id}`, baseCommit: "025e608aa1b2c3d4", sourceDirty: false,
  roleRevision: 3, sessionId: "native-session-1", runtimeInstance: account(90), phase: "idle", currentTurnId: null, issue: null, createdAt: now - 600_000, updatedAt: now - 60_000, ...extra });
const workers = [
  session(wid("a"), { phase: "awaiting_input", currentTurnId: tid(2), updatedAt: now - 5_000 }),
  session(wid("b"), { botId: "_local_operator", accountId: codex, provider: "codex", model: "gpt-6-sol", effort: "medium", repo: "/src/brain", roleRevision: 2 }),
  session(wid("c"), { phase: "needs_recovery", issue: "Server restarted; load the saved session before sending", updatedAt: now - 30_000 }),
  session(wid("d"), { phase: "closed", updatedAt: now - 3_600_000 }),
];
const turn = (n, workerId, extra) => ({ id: tid(n), workerId, phase: "completed", stopReason: "end_turn", issue: null, requestId: account(100 + n),
  prompt: "Fix the flaky scheduler test", requestedModel: "claude-opus-5-5", requestedEffort: "high",
  observedSettings: { model: "claude-opus-5-5", effort: "high", mode: "default", at: now, recordSeq: 1 }, dispatchedAt: now - 500_000, dispatchedPromptSeq: 2,
  createdAt: now - 500_001, updatedAt: now - 400_000, ...extra });
const workItem = "55555555-0000-4000-8000-000000000001";
const turns = {
  // The latest turn was admitted for a HUD Work item; the earlier one was not associated.
  [wid("a")]: [turn(1, wid("a")), turn(2, wid("a"), { phase: "awaiting_input", stopReason: null, prompt: "Also run the full suite",
    workContext: { workItemId: workItem, scopeRevision: 2, source: "explicit" },
    observedSettings: { model: "claude-sonnet-5", effort: "high", mode: "default", at: now, recordSeq: 9 }, updatedAt: now - 5_000 })],
  [wid("b")]: [turn(3, wid("b"), { requestedModel: "gpt-6-sol", requestedEffort: "medium", observedSettings: null })],
  [wid("c")]: [turn(4, wid("c"), { phase: "unknown", stopReason: null, issue: "Turn outcome is unknown after server restart" })],
  [wid("d")]: [turn(5, wid("d"))],
};
const entry = (seq, turnId, kind, text) => ({ seq, workerId: wid("a"), turnId, kind, text, at: now - 500_000 + seq * 1_000 });
const transcript = {
  [wid("a")]: [
    entry(1, tid(1), "user", "Fix the flaky scheduler test"),
    entry(2, tid(1), "agent", "I found the race in "), entry(3, tid(1), "agent", "`scheduler.ts` and **fixed** it."),
    entry(4, tid(1), "tool", "Edit src/scheduler.ts · pending"), entry(5, tid(1), "tool", "toolu_edit · completed"),
    entry(6, tid(1), "plan", JSON.stringify([{ content: "Reproduce the race", status: "in_progress", priority: "high" }])),
    entry(7, tid(1), "plan", JSON.stringify([{ content: "Reproduce the race", status: "completed", priority: "high" }, { content: "Add a regression test", status: "pending", priority: "medium" }])),
    entry(8, tid(1), "turn", "stopped · end_turn"),
    entry(9, tid(2), "user", "Also run the full suite"),
    entry(10, tid(2), "tool", "Run pnpm test · pending"),
  ],
};
const record = (seq, kind, data, extra = {}) => ({ seq, workerId: wid("a"), turnId: tid(1), kind, source: "live", at: now - 400_000 + seq, data, dataChars: JSON.stringify(data ?? {}).length, oversized: false, ...extra });
const oversized = { sessionUpdate: "tool_call_update", content: [{ type: "text", text: "x".repeat(40) }], rawOutput: { lines: 4096, tail: "all tests passed" } };
const records = [record(1, "session/new", { sessionId: "native-session-1" }), record(2, "tool_call", { toolCallId: "toolu_edit", title: "Edit src/scheduler.ts", status: "pending" }),
  record(3, "tool_call_update", null, { oversized: true, dataChars: JSON.stringify(oversized).length })];
const capture = { records: 3, retainedChars: 4_000, droppedRecords: 2, lastObservedAt: now - 5_000, maxRecords: 5_000, maxChars: 4_000_000, truncated: true };
const permission = { id: account(50), workerId: wid("a"), turnId: tid(2), acpRequestId: 7, kind: "permission", title: "Run pnpm test", runtimeInstance: account(90),
  toolCallId: "toolu_test", recordSeq: 4, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "deny-once", name: "Deny", kind: "reject_once" }], state: "pending" };
const summary = ({ prompt, ...rest }) => ({ ...rest, promptChars: prompt?.length ?? null });
const writes = [];

const handlers = {
  serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  account_list: () => ({ accounts: [] }),
  worker_account_list: () => ({ accounts: workerAccounts }),
  account_login_current: () => ({ login: null }),
  worker_account_login_current: () => ({ logins: [] }),
  bot_list: () => ({ bots: [{ id: "bot-1", state: "running", pid: 321, cwd: "/fixture/workspace", url: null, account: null, runningAccount: null, mainThreadId: "thread-1", recoveryIssue: null, roleRevision: 3, settings: null }] }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
  worker_list: () => ({ workers: workers.map((worker) => {
    const last = turns[worker.id]?.at(-1);
    return { ...worker, turn: last ? { id: last.id, phase: last.phase, stopReason: last.stopReason, issue: last.issue, dispatchedAt: last.dispatchedAt, createdAt: last.createdAt, updatedAt: last.updatedAt } : null,
      pendingPermissions: worker.phase === "awaiting_input" ? 1 : 0 };
  }) }),
  worker_diff: ({ id, path, patch }) => {
    if (id === wid("d")) throw new Error("the Worker's worktree is no longer available");
    const files = { "src/scheduler.ts": "diff --git a/src/scheduler.ts b/src/scheduler.ts\n--- a/src/scheduler.ts\n+++ b/src/scheduler.ts\n@@ -1,2 +1,2 @@\n-const wait = 0;\n+const wait = await settled();\n",
      "test/scheduler.test.ts": "diff --git a/test/scheduler.test.ts b/test/scheduler.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/test/scheduler.test.ts\n@@ -0,0 +1 @@\n+test(\"no race\");\n" };
    return { workerId: id, branch: `stack-worker-${id}`, baseCommit: "025e608aa1b2c3d4", head: "9f8e7d6c5b4a3210",
      commits: [{ sha: "9f8e7d6c5b4a3210", subject: "Fix the scheduler race", at: now - 100_000 }], commitsTruncated: false,
      files: [{ path: "src/scheduler.ts", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false },
        { path: "test/scheduler.test.ts", oldPath: null, status: "untracked", additions: null, deletions: null, binary: false }], filesTruncated: false,
      uncommitted: true, path: path ?? null, patch: path ? files[path] : patch ? Object.values(files).join("") : null, truncated: false };
  },
  worker_runtime_list: () => ({ runtimes: [
    { id: claude, provider: "claude", backend: "claude-sdk", processModel: "session", pids: [process.pid], state: "running", pid: null, instance: account(90), error: null },
    { id: codex, provider: "codex", backend: "acp", processModel: "account", pids: [], state: "error", pid: null, instance: null, error: "opencode exited (1)" }] }),
  worker_catalog: ({ accountId }) => ({ accountId, provider: accountId === claude ? "claude" : "codex", observedAt: new Date(now).toISOString(), source: "fixture", runtimeVersion: "1",
    modelConfigId: null, models: [], nativeModelIds: [], stale: false, error: null }),
  worker_status: ({ id }) => {
    const worker = workers.find((item) => item.id === id);
    return { worker, turn: turns[id]?.length ? summary(turns[id].at(-1)) : null, pending: worker.phase === "awaiting_input" ? [permission] : [] };
  },
  worker_read: ({ id, afterSeq = 0, limit = 20 }) => {
    const all = (transcript[id] ?? []).filter((item) => item.seq > afterSeq);
    const page = all.slice(0, limit);
    return { entries: page, nextSeq: page.at(-1)?.seq ?? afterSeq, hasMore: all.length > page.length };
  },
  worker_turn_list: ({ id }) => ({ turns: turns[id] ?? [], nextId: null, hasMore: false }),
  worker_tool_list: ({ id }) => ({ tools: id === wid("a") ? [
    { toolCallId: "toolu_edit", turnId: tid(1), firstSeq: 2, lastSeq: 3, title: "Edit src/scheduler.ts", kind: "edit", status: "completed", record: records[1] },
    { toolCallId: "toolu_test", turnId: tid(2), firstSeq: 4, lastSeq: 4, title: "Run pnpm test", kind: "execute", status: "pending", record: record(4, "tool_call", { toolCallId: "toolu_test", title: "Run pnpm test" }) }] : [],
  tasks: id === wid("a") ? [{ toolCallId: "toolu_task", sessionId: "child-session-12345", callingSessionId: "native-session-1", toolStatus: "completed", background: false,
    model: { providerID: "anthropic", modelID: "claude-haiku" }, recordSeq: 3, visibility: "task_reference", hierarchyVerified: false, childStatus: "unknown" }] : [], nextSeq: 4, hasMore: false }),
  worker_record_list: ({ id, afterSeq = 0 }) => {
    const page = id === wid("a") ? records.filter((item) => item.seq > afterSeq) : [];
    return { entries: page, nextSeq: page.at(-1)?.seq ?? afterSeq, hasMore: false, capture };
  },
  worker_record_read: ({ seq, offset = 0 }) => {
    const text = JSON.stringify(oversized);
    const size = Math.ceil(text.length / 2);
    const data = text.slice(offset, offset + size);
    return { seq, offset, data, nextOffset: offset + data.length, totalChars: text.length, hasMore: offset + data.length < text.length, encoding: "json-utf16" };
  },
  worker_detail: ({ id }) => ({ worker: workers.find((item) => item.id === id), observedSettings: turns[id]?.at(-1)?.observedSettings ?? null, metadata: [records[0]], capture,
    freshness: { connected: true, stale: false, readAt: now, reason: null },
    subagents: { coverage: "partial", hierarchyAvailable: false, childTranscriptsAvailable: false, reason: "The native runtime reports task references only." } }),
};
// The gateway admits serve only with every operation its manifest selects; this check reads none of the resource ones.
handlers.serve_resources = handlers.serve_resource_history = () => { throw new Error("not part of this fixture"); };
// Any Worker write reaching the fixture is a failure of the read-only contract.
for (const name of ["worker_start", "worker_send", "worker_respond", "worker_cancel", "worker_resume", "worker_close", "worker_remove", "worker_account_drain"])
  handlers[name] = (input) => { writes.push(name, input); throw new Error("read-only UI must not write"); };
const sockets = new Map();
let websocket, next, browser, rolesServer;
let log = "";

try {
  // Workers capture Roles by ID. The provisioned catalog has a Bot default and a separate Worker default; a third
  // Role is selected explicitly and edited after one Worker captured it.
  rolesServer = await serveApi({ name: "roles", transport: "socket", env, root });
  const rolesCall = (name, args = {}) => socketCall(socketPath("roles", env), "tools/call", { name, arguments: args });
  let roleCatalog = await rolesCall("roles_snapshot");
  assert.notEqual(roleCatalog.defaultRoleId, roleCatalog.workerDefaultRoleId, "a fresh catalog provisions separate Bot and Worker defaults");
  const workerDefault = roleCatalog.roles.find((role) => role.id === roleCatalog.workerDefaultRoleId);
  roleCatalog = await rolesCall("role_create", { expectedRevision: roleCatalog.revision, name: "Researcher" });
  const researcher = roleCatalog.roles.find((role) => role.name === "Researcher");
  const edited = await rolesCall("role_update", { roleId: researcher.id, expectedRevision: researcher.revision, description: "Reads sources" });
  Object.assign(workers[0], { roleId: researcher.id, roleRevision: researcher.revision });
  Object.assign(workers[1], { roleId: researcher.id, roleRevision: edited.revision });
  Object.assign(workers[2], { roleId: workerDefault.id, roleRevision: workerDefault.revision });
  Object.assign(workers[3], { roleId: account(77), roleRevision: 4 });

  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["worker", "auth", "serve", "bots", "roles", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("worker", workerApi), doc("bots", botsApi), doc("roles", rolesApi), doc("auth"), doc("serve"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  const definitions = { serve: serve.names, auth: ["account_list", "worker_account_list", "account_login_current", "worker_account_login_current"],
    bots: ["bot_list", "bot_defaults_get", "voice_status"], worker: workerApi.operations.map((operation) => operation.name), api: ["docs_snapshot"] };
  const topics = { serve: serve.topics, auth: { accounts_changed: "Fixture", worker_accounts_changed: "Fixture" }, bots: botsApi.events.topics, worker: workerApi.events.topics, api: {} };
  for (const [name, names] of Object.entries(definitions)) {
    sockets.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers),
      events: { topics: topics[name], scope: name === "bots" || name === "worker" ? { valid: () => true, description: "Fixture", example: "id" } : undefined } }));
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  const origin = `http://127.0.0.1:${nextPort}`;
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/workers`);
  const list = page.locator('[data-window="workers"]');
  const worker = page.locator('[data-window="worker"]');
  const runtimes = page.locator('[data-window="worker-runtimes"]');
  const row = (text) => list.locator("[data-worker]").filter({ hasText: text });

  // The list groups by what needs a look; closed Workers start collapsed.
  await row("stack · aaaaaa").waitFor();
  await list.getByText("Needs attention· 2").or(list.getByRole("button", { name: /Needs attention/ })).first().waitFor();
  await row("stack · aaaaaa").getByText("Waiting for its Bot to answer a permission request").waitFor();
  await row("brain · bbbbbb").getByText("Operator", { exact: true }).waitFor();
  await row("brain · bbbbbb").getByText("Idle · last turn completed · end_turn").waitFor();
  assert.equal(await row("stack · dddddd").count(), 0, "closed Workers start collapsed");
  await list.getByRole("button", { name: /Closed/ }).click();
  await row("stack · dddddd").waitFor();
  await worker.getByText("No Worker selected", { exact: true }).waitFor();
  await runtimes.getByText("opencode exited (1)", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Spaces · Workers" }).waitFor();
  await page.screenshot({ path: join(evidence, "workers-list.png"), animations: "disabled" });

  // Choosing shows the conversation: joined agent text as markdown, collapsed tool updates, the latest plan.
  await row("stack · aaaaaa").click();
  await worker.getByRole("heading", { name: /stack · aaaaaa/ }).waitFor();
  await worker.getByText("Fix the flaky scheduler test", { exact: true }).waitFor();
  await worker.locator("strong", { hasText: "fixed" }).waitFor();
  await worker.getByText("Edit src/scheduler.ts", { exact: true }).waitFor();
  assert.equal(await worker.getByText("toolu_edit", { exact: true }).count(), 0, "a bare tool call ID is named from the tool list");
  await worker.getByRole("list", { name: "Plan" }).getByText("Add a regression test").waitFor();
  assert.equal(await worker.getByRole("list", { name: "Plan" }).count(), 1, "plan updates collapse to the latest");
  // The pending permission is shown with its options, but nothing here answers it.
  await worker.getByText("Run pnpm test", { exact: true }).first().waitFor();
  await worker.getByText("Waiting for its Bot to answer · tool toolu_test").waitFor();
  await worker.getByText("Allow once", { exact: true }).waitFor();
  for (const name of [/allow/i, /deny/i, /^send/i, /cancel/i, /resume/i, /^close$/i, /remove/i]) {
    assert.equal(await worker.getByRole("button", { name }).count(), 0, `no ${name} control in a read-only Worker window`);
  }
  assert.equal(await worker.locator("textarea, input[type=text]").count(), 0, "no composer");
  await worker.getByText("observed claude-sonnet-5 · high").waitFor();
  // The captured Role is compared with that same Role: this Worker selected Researcher, which has been edited since.
  const roleChip = worker.getByTitle(/^Started with Researcher r/);
  await roleChip.getByText(`Researcher r${researcher.revision} · now r${edited.revision}`, { exact: true }).waitFor();
  assert.equal(await roleChip.getAttribute("title"), `Started with Researcher r${researcher.revision}; Researcher is now r${edited.revision}. This Worker keeps its r${researcher.revision} snapshot, including through recovery. New Workers without a selected Role use “${workerDefault.name}”. Editing a Role never changes a running Worker.`);
  await page.screenshot({ path: join(evidence, "worker-conversation.png"), animations: "disabled" });

  // A progress notice scoped to this Worker continues the transcript from its last sequence.
  transcript[wid("a")].push(entry(11, tid(2), "agent", "All 412 tests passed."));
  sockets.get("worker").publish("worker_progress", wid("a"));
  await worker.getByText("All 412 tests passed.").waitFor();

  // Changes read the retained worktree through worker_diff; a file opens its patch.
  await worker.getByRole("tab", { name: "Changes" }).click();
  await worker.getByText("Fix the scheduler race", { exact: true }).waitFor();
  await worker.getByText("uncommitted", { exact: true }).waitFor();
  await worker.getByRole("button", { name: /src\/scheduler\.ts/ }).click();
  await worker.getByText("+const wait = await settled();", { exact: true }).waitFor();
  await worker.getByRole("button", { name: "Show all changes" }).click();
  await worker.getByText('+test("no race");', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "worker-changes.png"), animations: "disabled" });

  // Turns, tools, records and session metadata.
  await worker.getByRole("tab", { name: "Turns" }).click();
  await worker.getByText("Also run the full suite", { exact: true }).waitFor();
  await worker.getByText("claude-sonnet-5 · high · default", { exact: true }).waitFor();
  // Each turn's captured Work context links to its HUD item, the landing space; an unassociated turn says so.
  const workLinks = worker.getByRole("link", { name: /Work 55555555/ });
  await workLinks.first().waitFor();
  assert.equal(await workLinks.count(), 2, "the summary's latest turn and that turn's row both link the item");
  assert.equal(await workLinks.first().getAttribute("href"), `/?focus=${encodeURIComponent(`work-item:${workItem}`)}`);
  await worker.getByText("not associated", { exact: true }).waitFor();
  await worker.getByRole("tab", { name: "Tools" }).click();
  await worker.getByText("The parent link is unverified and the child’s status is unknown.", { exact: false }).waitFor();
  await worker.getByRole("button", { name: /Run pnpm test/ }).click();
  await worker.getByText("toolu_test · records 4–4").waitFor();
  await worker.getByRole("tab", { name: "Records" }).click();
  await worker.getByText(/Capture limit reached: 2 records dropped/).waitFor();
  await worker.getByRole("button", { name: /tool_call_update/ }).click();
  await worker.getByRole("button", { name: "Load full record" }).click();
  await worker.getByText("all tests passed", { exact: true }).waitFor();
  await worker.getByRole("tab", { name: "Session" }).click();
  await worker.getByText(/Coverage partial\. The native runtime reports task references only\./).waitFor();
  const roleRows = worker.locator("section").filter({ has: page.getByRole("heading", { name: "Role", exact: true }) });
  await roleRows.getByText(`Researcher r${researcher.revision}`, { exact: true }).waitFor();
  await roleRows.getByText(`r${edited.revision} · older revision`, { exact: true }).waitFor();
  await roleRows.getByText(workerDefault.name, { exact: true }).waitFor();
  await roleRows.getByText(/Recovery reuses this snapshot, and follow-up turns cannot change it\./).waitFor();
  assert.equal(await roleRows.locator("button:not([aria-label^='Copy']), select, input, [role=combobox]").count(), 0, "the Role section offers no Role control");
  await page.screenshot({ path: join(evidence, "worker-session.png"), animations: "disabled" });

  // A Role selected explicitly and still current is ordinary, not a warning, though it is not the Worker default.
  await row("brain · bbbbbb").click();
  const selected = worker.getByTitle(/^Started with Researcher r/);
  await selected.getByText(`Researcher r${edited.revision}`, { exact: true }).waitFor();
  assert.doesNotMatch(await selected.getAttribute("class"), /warning/, "a selected non-default Role is not flagged");
  await worker.getByRole("tab", { name: "Session" }).click();
  await roleRows.getByText(`r${edited.revision} · current revision`, { exact: true }).waitFor();

  // A Worker whose last turn is unknown says so; its Bot recovers it. It started with the Worker default.
  await row("stack · cccccc").click();
  await worker.getByText(/Turn outcome is unknown after server restart/).waitFor();
  await worker.getByTitle(/It is also the current Worker default\./).getByText(`${workerDefault.name} r${workerDefault.revision}`, { exact: true }).waitFor();
  await worker.getByRole("tab", { name: "Session" }).click();
  await roleRows.getByText(`${workerDefault.name} · this Role`, { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "worker-role.png"), animations: "disabled" });
  // A removed worktree reads as an error in Changes, not a crash.
  await row("stack · dddddd").click();
  await worker.getByTitle(/^Started with a Role deleted since, at r4\./).getByText("Deleted role r4", { exact: true }).waitFor();
  await worker.getByRole("tab", { name: "Changes" }).click();
  await worker.getByText("the Worker's worktree is no longer available", { exact: false }).waitFor();
  await worker.getByRole("tab", { name: "Conversation" }).click();
  await row("stack · cccccc").click();

  // A second window keeps its own Worker while the primary follows the list.
  await worker.getByRole("button", { name: "New Worker window" }).click();
  const second = page.locator('[data-window="worker-2"]');
  await second.getByRole("heading", { name: /stack · cccccc/ }).waitFor();
  // Opening a window pans the camera to it; the list row is still the control, just off-screen.
  await row("brain · bbbbbb").dispatchEvent("click");
  await worker.getByRole("heading", { name: /brain · bbbbbb/ }).waitFor();
  await second.getByRole("heading", { name: /stack · cccccc/ }).waitFor();
  await second.getByRole("button", { name: "Close Worker window" }).click();
  await second.waitFor({ state: "detached" });

  // The title inspects the record, which lists only read operations and hands back to the Worker window.
  await worker.getByRole("button", { name: "Inspect brain · bbbbbb" }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("button", { name: "Show in Worker window" }).waitFor();
  await inspector.getByText("worker_status", { exact: true }).waitFor();
  assert.equal(await inspector.getByText("worker_send", { exact: true }).count(), 0, "write operations are not offered");
  await page.keyboard.press("Escape");

  // The Bot filter narrows the list; ⌘K finds Workers.
  await list.getByLabel("Started by").selectOption("_local_operator");
  assert.equal(await list.locator("[data-worker]").count(), 1);
  await list.getByLabel("Started by").selectOption("");
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder("Jump to a bot, account, operation…").fill("brain bbbbbb");
  await page.getByRole("option", { name: /brain · bbbbbb/ }).waitFor();
  await page.keyboard.press("Escape");

  // Fleet's Bot card links to its Workers, filtered to that Bot.
  await page.goto(`${origin}/fleet`);
  await page.locator('[data-window="bots"]').getByRole("link", { name: /3 Workers/ }).click();
  await page.getByRole("button", { name: "Spaces · Workers" }).waitFor();
  await list.locator("[data-worker]").first().waitFor();
  assert.equal(await list.getByLabel("Started by").inputValue(), "bot-1");
  assert.equal(await list.locator("[data-worker]").count(), 2, "bot-1's open Workers; its closed one stays collapsed");

  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(`workers browser check passed; evidence in ${evidence}`);
} finally {
  await browser?.close();
  next?.kill();
  await websocket?.close();
  for (const socket of sockets.values()) await socket.close();
  await rolesServer?.close();
  if (!process.env.WORKERS_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
