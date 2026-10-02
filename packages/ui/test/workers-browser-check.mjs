// Optional rendered check of Worker readers and local state maintenance after pnpm test and a ui build. Worker, auth,
// Bots, server and discovery are fixtures on a disposable state directory; the real Roles API provisions its
// Manager and Worker Roles there. No live server or provider calls.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/workers-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath, StateJournal } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as rolesApi } from "../../roles/dist/api.js";
import { api as workerApi } from "../../worker/dist/api.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
// Unix socket paths are short; keep the state directory near the root of the temporary tree.
const dir = await mkdtemp(join("/private/var/folders/9g/l0rgs8rs2_9__kqn0smr9tnh0000gp/T/opencode", "workers-"));
const evidence = process.env.WORKERS_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
// Nothing of the live Stack environment reaches the fixture: only the disposable state directory is named.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };

const account = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wid = (c) => `${c.repeat(8)}-0000-4000-8000-000000000000`;
const tid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.parse("2026-09-01T00:00:00Z");
const claude = account(3), codex = account(4);
const workerAccounts = [{ id: claude, provider: "claude", enabled: true, ready: true, removing: false, linkedAccounts: [] },
  { id: codex, provider: "codex", enabled: true, ready: true, removing: false, linkedAccounts: [] }];
const session = (id, extra) => ({ id, botId: "bot-1", threadId: "thread-1", accountId: claude, provider: "claude", model: "claude-opus-5-5", effort: "high",
  repo: "/src/stack", cwd: `/state/workers/worktrees/${id}`, branch: `stack-worker-${id}`, baseCommit: "025e608aa1b2c3d4", sourceDirty: false,
  roleRevision: 3, sessionId: "native-session-1", runtimeInstance: account(90), phase: "idle", contentClearedAt: null, currentTurnId: null, issue: null, createdAt: now - 600_000, updatedAt: now - 60_000, ...extra });
const workers = [
  session(wid("a"), { phase: "awaiting_input", currentTurnId: tid(2), updatedAt: now - 5_000 }),
  session(wid("b"), { botId: "_local_operator", accountId: codex, provider: "codex", model: "gpt-6-sol", effort: "medium", repo: "/src/brain", roleRevision: 2 }),
  session(wid("c"), { phase: "needs_recovery", issue: "Server restarted; load the saved session before sending", updatedAt: now - 30_000 }),
  session(wid("d"), { phase: "closed", accountId: codex, provider: "codex", model: "gpt-6-sol", sessionId: "ses_exact_full_root_1234567890", updatedAt: now - 3_600_000 }),
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
// Turn 6 is an event turn: its requestId is the dispatched event receipt's deliveryId. It sorts between
// turns 1 and 2 in the list so turn 2 stays the latest for the summary's existing assertions.
turns[wid("a")].splice(1, 0, turn(6, wid("a"), { requestId: tid(52), prompt: "Deploy finished on main" }));
const transcript = {
  [wid("a")]: [
    entry(1, tid(1), "user", "Fix the flaky scheduler test"),
    entry(2, tid(1), "agent", "I found the race in "), entry(3, tid(1), "agent", "`scheduler.ts` and **fixed** it."),
    entry(4, tid(1), "tool", "Edit src/scheduler.ts · pending"), entry(5, tid(1), "tool", "toolu_edit · completed"),
    entry(6, tid(1), "plan", JSON.stringify([{ content: "Reproduce the race", status: "in_progress", priority: "high" }])),
    entry(7, tid(1), "plan", JSON.stringify([{ content: "Reproduce the race", status: "completed", priority: "high" }, { content: "Add a regression test", status: "pending", priority: "medium" }])),
    entry(8, tid(1), "turn", "stopped · end_turn"),
    entry(9, tid(6), "event", "Deploy finished on main"),
    entry(10, tid(6), "agent", "Noted."),
    entry(11, tid(2), "user", "Also run the full suite"),
    entry(12, tid(2), "tool", "Run pnpm test · pending"),
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
const maintenanceCalls = [], catalogCalls = [];
const journal = new StateJournal(join(dir, "workers.sqlite"), "worker");
const branches = Array.from({ length: 101 }, (_, n) => ({ workerId: account(600 + n), repo: "/src/retained", branch: `stack-worker-${account(600 + n)}`, baseCommit: "025e608aa1b2c3d4", collectedAt: n === 1 ? now : null }));
let branchRevision = 1, changeBranchPage = false, nativeBlocked = false, resetBlocked = false, resetAvailable = false, resetDone = false;
let drained = false, nativeRuntimeBusy = false, transcriptRevision = 0, catalogCleared = false, loseApply = false, omitNativeIds = false, catalogReady;
const nativeIds = "ses_exact_full_root_1234567890, ses_exact_full_descendant_0987654321";

// Retained completion receipts for exact turn requestIds (Bot watches) — delivered, uncertain, observed — and
// event delivery receipts for worker "a": queued/interrupting/cancelled never claim a turn; the dispatched one
// links the event turn; the unknown one reports the fenced interruption. 130 total, so the latest 128 truncate.
const completion = (id, extra = {}) => ({ id, botId: "bot-1", threadId: "thread-1", pkg: "worker", operation: "worker_send",
  recordId: account(101), state: "delivered", lastDeliveredAt: now - 390_000, lastDeliveryKind: "terminal",
  lastError: null, nativeAdmissionUncertain: false, subscriptionPresent: true, ...extra });
const completionReceipts = [
  completion(account(300)),                                     // turn 1 · delivered
  completion(account(301), { recordId: account(102) }),         // turn 2 · delivered
  completion(account(302), { recordId: account(104), state: "unknown", lastDeliveredAt: null, lastDeliveryKind: "terminal",
    lastError: "native_admission_unknown", nativeAdmissionUncertain: true, subscriptionPresent: false }), // turn 4 · uncertain
  completion(account(303), { recordId: account(105), state: "observed", lastDeliveredAt: now - 100_000,
    lastDeliveryKind: null, subscriptionPresent: false }),      // turn 5 · observed
];
const watchCalls = [];
const deliveryReceipt = (deliveryId, state, turnId = null, extra = {}) => ({ deliveryId, workerId: wid("a"), sessionId: "native-session-1",
  state, turnId, issue: null, createdAt: now - 300_000, updatedAt: now - 30_000, ...extra });
const eventReceipts = [
  deliveryReceipt(tid(50), "queued"), deliveryReceipt(tid(51), "interrupting"),
  deliveryReceipt(tid(52), "dispatched", tid(6)),
  deliveryReceipt(tid(53), "unknown", null, { issue: "interruption outcome unknown" }),
  deliveryReceipt(tid(54), "cancelled"),
  ...Array.from({ length: 125 }, (_, n) => deliveryReceipt(`d0000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`, "dispatched")),
];
const planWorker = ({ ids, kind, allowUnmerged = [] }) => {
  assert.ok(ids.length > 0 && ids.length <= 100, "UI never plans empty or oversized IDs");
  assert.ok(allowUnmerged.every((id) => kind === "branch" && ids.includes(id)), "overrides belong only to exact selected branches");
  maintenanceCalls.push(["plan", { ids, kind, allowUnmerged }]);
  const blockedBy = kind === "branch" && ids.some((id) => !allowUnmerged.includes(id)) ? ["Unmerged into the recorded base commit; per-branch unmerged deletion must be explicitly selected"]
    : kind === "git_reset" && resetBlocked ? ["An earlier retained tip exists; preserve/reconcile it explicitly before another reset"]
    : kind === "native_session" && nativeBlocked ? ["Native session purge version has not been scope-verified"] : [];
  return journal.plan({ subject: null, action: `worker_${kind}`, revision: JSON.stringify([kind, ids, allowUnmerged, branchRevision, transcriptRevision]), resources: ids, blockedBy,
    retained: ["Worker/turn identity, admission digests, outcomes including unknown, usage, settings and captured Work context remain",
      "Native credentials/profiles, Signal/Infer/HUD copies, source checkout, remotes and backups remain independent", "Frozen Role resources and minimal maintenance receipts remain; no Worker is reopened or started implicitly",
      ...(kind === "git_reset" ? [`1 commits, 2 changed files; old tip retained at refs/stack/retained/${ids[0]}`] : []),
      ...(kind === "native_session" ? [`Exact native sessions and verified descendants selected: ${omitNativeIds ? "" : nativeIds}`, "Native provider logs, shared caches/instruction blobs, external shares and backups remain"] : []),
      ...(kind === "catalog" ? ["Catalog is account-shared derived state; all sibling views lose the same cached catalog, but sessions/settings remain"] : [])],
    regeneration: [kind === "catalog" ? "Explicit later native catalog discovery can recreate the account cache; cleanup admits no turn" : "New explicit Worker admissions may create new state; closed Workers and cleared unknown turns never replay"] }, { ids, kind, allowUnmerged });
};

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
    if (id === wid("d") && !resetAvailable) throw new Error("the Worker's worktree is no longer available");
    const files = { "src/scheduler.ts": "diff --git a/src/scheduler.ts b/src/scheduler.ts\n--- a/src/scheduler.ts\n+++ b/src/scheduler.ts\n@@ -1,2 +1,2 @@\n-const wait = 0;\n+const wait = await settled();\n",
      "test/scheduler.test.ts": "diff --git a/test/scheduler.test.ts b/test/scheduler.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/test/scheduler.test.ts\n@@ -0,0 +1 @@\n+test(\"no race\");\n" };
    return { workerId: id, branch: `stack-worker-${id}`, baseCommit: "025e608aa1b2c3d4", head: "9f8e7d6c5b4a3210",
      commits: resetDone && id === wid("d") ? [] : [{ sha: "9f8e7d6c5b4a3210", subject: "Fix the scheduler race", at: now - 100_000 }], commitsTruncated: false,
      files: resetDone && id === wid("d") ? [] : [{ path: "src/scheduler.ts", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false },
        { path: "test/scheduler.test.ts", oldPath: null, status: "untracked", additions: null, deletions: null, binary: false }], filesTruncated: false,
      uncommitted: true, path: path ?? null, patch: path ? files[path] : patch ? Object.values(files).join("") : null, truncated: false };
  },
  worker_runtime_list: () => ({ runtimes: [
    { id: claude, provider: "claude", backend: "claude-sdk", processModel: "session", pids: drained ? [] : [process.pid], state: drained ? "stopped" : "running", pid: null, instance: account(90), error: null },
    { id: codex, provider: "codex", backend: "acp", processModel: "account", pids: nativeRuntimeBusy && !drained ? [process.pid] : [], state: nativeRuntimeBusy && !drained ? "running" : "error", pid: null, instance: null, error: "opencode exited (1)" }] }),
  worker_catalog: ({ accountId, refresh }) => {
    catalogCalls.push([accountId, refresh]);
    if (accountId === codex) { catalogReady?.(); catalogReady = undefined; }
    // A cache miss really can trigger native discovery despite refresh:false. The UI must not call it after clear.
    if (accountId === codex && catalogCleared) throw new Error("unexpected post-clear native catalog observation");
    return { accountId, provider: accountId === claude ? "claude" : "codex", observedAt: new Date(now).toISOString(), source: "fixture", runtimeVersion: "1",
      modelConfigId: null, models: [], nativeModelIds: [], stale: false, error: null };
  },
  worker_state_branches: ({ offset = 0, limit = 100, revision }) => {
    if (offset && changeBranchPage) { branchRevision++; changeBranchPage = false; }
    if (revision && revision !== String(branchRevision)) throw new Error("Worker branch inventory changed");
    return { branches: branches.slice(offset, offset + limit), revision: String(branchRevision), nextOffset: offset + limit < branches.length ? offset + limit : null };
  },
  worker_state_plan: planWorker,
  worker_state_receipt_get: ({ requestId }) => ({ receipt: journal.receipt(requestId) }),
  worker_state_clear: (input) => {
    maintenanceCalls.push(["apply", input]);
    const existing = journal.existing(input); if (existing) return existing;
    const { plan, payload } = journal.getPlan(input.planId);
    assert.equal(input.expectedRevision, plan.revision);
    assert.deepEqual(plan.blockedBy, [], "blocked plans cannot reach apply");
    journal.begin(input, plan);
    if (loseApply) { loseApply = false; throw new Error("lost transport response after durable admission"); }
    if (payload.kind === "transcript") {
      const worker = workers.find((row) => row.id === payload.ids[0]);
      worker.contentClearedAt = now + ++transcriptRevision;
      for (const turn of turns[worker.id] ?? []) { turn.prompt = null; turn.contentClearedAt = worker.contentClearedAt; }
      transcript[worker.id] = [];
    }
    if (payload.kind === "git_reset") resetDone = true;
    if (payload.kind === "catalog") catalogCleared = true;
    if (payload.kind === "branch") { for (const id of payload.ids) branches.find((row) => row.workerId === id).collectedAt = now; branchRevision++; }
    const receipt = journal.finish(input.requestId, "completed", payload.ids.map((resource) => ({ resource, outcome: "removed", detail: `Exact ${payload.kind} effect verified` })));
    sockets.get("worker").publish("workers_changed");
    for (const id of payload.ids) sockets.get("worker").publish("worker_changed", id);
    return receipt;
  },
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
  worker_tool_list: ({ id }) => ({ tools: id === wid("a") && !workers[0].contentClearedAt ? [
    { toolCallId: "toolu_edit", turnId: tid(1), firstSeq: 2, lastSeq: 3, title: "Edit src/scheduler.ts", kind: "edit", status: "completed", record: records[1] },
    { toolCallId: "toolu_test", turnId: tid(2), firstSeq: 4, lastSeq: 4, title: "Run pnpm test", kind: "execute", status: "pending", record: record(4, "tool_call", { toolCallId: "toolu_test", title: "Run pnpm test" }) }] : [],
  tasks: id === wid("a") && !workers[0].contentClearedAt ? [{ toolCallId: "toolu_task", sessionId: "child-session-12345", callingSessionId: "native-session-1", toolStatus: "completed", background: false,
    model: { providerID: "anthropic", modelID: "claude-haiku" }, recordSeq: 3, visibility: "task_reference", hierarchyVerified: false, childStatus: "unknown" }] : [], nextSeq: 4, hasMore: false }),
  worker_record_list: ({ id, afterSeq = 0 }) => {
    const page = id === wid("a") && !workers[0].contentClearedAt ? records.filter((item) => item.seq > afterSeq) : [];
    return { entries: page, nextSeq: page.at(-1)?.seq ?? afterSeq, hasMore: false, capture };
  },
  worker_record_read: ({ seq, offset = 0 }) => {
    const text = JSON.stringify(oversized);
    const size = Math.ceil(text.length / 2);
    const data = text.slice(offset, offset + size);
    return { seq, offset, data, nextOffset: offset + data.length, totalChars: text.length, hasMore: offset + data.length < text.length, encoding: "json-utf16" };
  },
  worker_event_list: ({ id }) => ({ receipts: id === wid("a") ? eventReceipts.slice(0, 128) : [], limit: 128, total: id === wid("a") ? eventReceipts.length : 0, truncated: id === wid("a") }),
  worker_turn_observation: ({ botId, threadId, requestId }) => {
    if (botId !== "bot-1" || threadId !== "thread-1") throw new Error("turn observation belongs to another Chat");
    if (requestId === account(101)) return { result: { workerId: wid("a"), turnId: tid(1), requestId, phase: "completed", stopReason: "end_turn", issue: null, workContext: null, contentClearedAt: null }, update: null };
    if (requestId === account(102)) return { result: null, update: { workerId: wid("a"), turnId: tid(2), requestId, phase: "awaiting_input",
      pending: Array.from({ length: 8 }, (_, n) => ({ permissionId: account(400 + n), optionCount: 2 })), pendingCount: 12, pendingTruncated: true } };
    if (requestId === account(104)) return { result: { workerId: wid("c"), turnId: tid(4), requestId, phase: "unknown", stopReason: null,
      issue: "Turn outcome is unknown after server restart", workContext: null, contentClearedAt: null }, update: null };
    if (requestId === account(105)) return { result: { workerId: wid("d"), turnId: tid(5), requestId, phase: "completed", stopReason: "end_turn", issue: null,
      workContext: null, contentClearedAt: now - 3_500_000 }, update: null };
    return { result: null, update: null };
  },
  serve_completion_list: (args) => {
    watchCalls.push(args);
    const rows = completionReceipts.filter((row) => (!args.package || row.pkg === args.package) && (!args.operation || row.operation === args.operation)
      && (!args.recordId || row.recordId === args.recordId) && (!args.botId || row.botId === args.botId) && (!args.threadId || row.threadId === args.threadId) && (!args.state || row.state === args.state));
    const nextOffset = (args.offset ?? 0) + (args.limit ?? 100) < rows.length ? (args.offset ?? 0) + (args.limit ?? 100) : null;
    return { completions: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)), revision: "watch-1", total: rows.length, nextOffset, truncated: nextOffset !== null };
  },
  serve_subscription_list: () => ({ subscriptions: [], revision: "0", nextOffset: null }),
  serve_occurrence_list: () => ({ subscriptions: [], revision: "0", nextOffset: null }),
  serve_completion_get: ({ id }) => {
    const receipt = completionReceipts.find((row) => row.id === id) ?? null;
    const link = receipt?.id === account(301) ? { kind: "worker", workerId: wid("a"), turnId: tid(2) } : null;
    return { receipt, linkStatus: link ? "resolved" : "missing", link };
  },
  worker_detail: ({ id }) => ({ worker: workers.find((item) => item.id === id), observedSettings: turns[id]?.at(-1)?.observedSettings ?? null, metadata: workers.find((item) => item.id === id)?.contentClearedAt ? [] : [records[0]], capture,
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
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  const definitions = { serve: serve.names, auth: ["account_list", "worker_account_list", "account_login_current", "worker_account_login_current"],
    bots: botsApi.operations.map((operation) => operation.name), worker: workerApi.operations.map((operation) => operation.name), api: ["docs_snapshot"] };
  const topics = { serve: serve.topics, auth: { accounts_changed: "Fixture", worker_accounts_changed: "Fixture", login_changed: "Fixture", worker_login_changed: "Fixture" }, bots: botsApi.events.topics, worker: workerApi.events.topics, api: {} };
  // Catalog docs without a manifest still name the fixture socket's served operations so exposure checks work.
  const servedDoc = (name) => ({ ...fixtureDoc(name, undefined, websocket.url, publishedJsonSchema), events: topics[name],
    transports: [{ type: "websocket", description: "Fixture", supported: true, subscriptions: true, endpoint: websocket.url, operations: definitions[name], events: Object.keys(topics[name]), routes: [] }] });
  const catalog = [doc("worker", workerApi), doc("bots", botsApi), doc("roles", rolesApi), servedDoc("auth"), servedDoc("serve"), servedDoc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names] of Object.entries(definitions)) {
    sockets.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers),
      events: { topics: topics[name], scope: name === "bots" || name === "worker" ? { valid: () => true, description: "Fixture", example: "id" } : undefined } }));
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  const origin = `http://127.0.0.1:${nextPort}`;
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), process.env.NEXT_MODE === "dev" ? "dev" : "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log.slice(-8000));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydration|Minified React error #418|cannot be a descendant/i.test(message.text())) errors.push(message.text().slice(0, 2000)); });
  // Capture the exact operations the page calls so forbidden writes and watch arguments are auditable.
  const sentCalls = [];
  page.on("websocket", (ws) => ws.on("framesent", (frame) => {
    try { const message = JSON.parse(String(frame.payload)); if (message.method === "tools/call") sentCalls.push(message.params); } catch { /* non-JSON frame */ }
  }));
  await page.goto(`${origin}/workers`);
  const list = page.locator('[data-window="workers"]');
  const worker = page.locator('[data-window="worker"]');
  const runtimes = page.locator('[data-window="worker-runtimes"]');
  const row = (text) => list.locator("[data-worker]").filter({ hasText: text });
  const press = async (button) => { await button.focus(); await page.keyboard.press("Enter"); };
  const open = async (scope, title) => {
    const detail = scope.locator("details").filter({ has: page.locator("summary", { hasText: title }) }).first();
    if (!(await detail.evaluate((element) => element.open))) await press(detail.locator("summary"));
    return detail;
  };
  const shot = (name, scope = worker) => scope.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });

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
  assert.equal(await worker.getByText(/^Content cleared/).count(), 0, "uncleared transcript has no cleared marker");
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
  // A delivered subscription event is its own bubble — labelled, untrusted, never a human task.
  await worker.getByText("Deploy finished on main", { exact: true }).waitFor();
  await worker.getByText("Event", { exact: true }).waitFor();
  // The captured Role is compared with that same Role: this Worker selected Researcher, which has been edited since.
  const roleChip = worker.getByTitle(/^Started with Researcher r/);
  await roleChip.getByText(`Researcher r${researcher.revision} · now r${edited.revision}`, { exact: true }).waitFor();
  assert.equal(await roleChip.getAttribute("title"), `Started with Researcher r${researcher.revision}; Researcher is now r${edited.revision}. This Worker keeps its r${researcher.revision} snapshot, including through recovery. New Workers without a selected Role use “${workerDefault.name}”. Editing a Role never changes a running Worker.`);
  await page.screenshot({ path: join(evidence, "worker-conversation.png"), animations: "disabled" });

  // A progress notice scoped to this Worker continues the transcript from its last sequence.
  transcript[wid("a")].push(entry(13, tid(2), "agent", "All 412 tests passed."));
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
  await worker.getByText("not associated", { exact: true }).first().waitFor();

  // Event receipts carry no payload; states are disclosed, never retried; the fenced interruption warns.
  await worker.getByText(/130 receipts\. Receipts carry no payload/).waitFor();
  await worker.getByText(/Only the latest 128 of 130 are inspectable/).waitFor();
  await worker.locator(`[data-event-receipt="${tid(50)}"]`).getByText("Queued").waitFor();
  await worker.locator(`[data-event-receipt="${tid(51)}"]`).getByText("Interrupting").waitFor();
  await worker.locator(`[data-event-receipt="${tid(54)}"]`).getByText("Cancelled").waitFor();
  const unknownDelivery = worker.locator(`[data-event-receipt="${tid(53)}"]`);
  await unknownDelivery.getByText("Unknown", { exact: true }).waitFor();
  await unknownDelivery.getByText("interruption outcome unknown").waitFor();
  await worker.getByText(/Automatic event input to this Worker is fenced/).waitFor();
  assert.equal(await worker.getByRole("button", { name: /Retry|Rearm|Resend/i }).count(), 0, "event receipts have no replay controls");

  // The dispatched receipt links its event turn; focus highlights that exact turn.
  await worker.locator(`[data-event-receipt="${tid(52)}"]`).getByRole("button", { name: `turn ${tid(6).slice(0, 8)}` }).click();
  const eventTurn = worker.locator(`[data-turn-id="${tid(6)}"]`);
  await worker.locator(`[data-turn-id="${tid(6)}"][aria-current="true"]`).waitFor();
  await eventTurn.getByText("Event turn", { exact: true }).waitFor();
  await eventTurn.getByText("Event input · untrusted observation, not a human task").waitFor();
  await eventTurn.getByText(/Delivery Dispatched/).waitFor();
  assert.equal(await eventTurn.getByRole("button", { name: "Bot watch" }).count(), 0, "an event turn carries no request watch");

  // A linked turn focus from System's subscription detail takes the highlight and clears the receipt-clicked
  // one; clicking a receipt's turn afterward still wins over the now-stale linked focus.
  await page.goto(`${origin}/system`);
  const subs = page.locator('[data-window="subscriptions"]');
  await subs.waitFor();
  await subs.getByRole("button", { name: "History", exact: true }).click();
  const historyRow = subs.locator(`[data-receipt="${account(301)}"]`);
  await historyRow.getByRole("button", { name: "Details" }).click();
  await historyRow.getByText(/Linked — Resolved to the exact domain record/).waitFor();
  await historyRow.getByRole("button", { name: `Worker aaaaaaaa · turn ${tid(2).slice(0, 8)}` }).click();
  await worker.locator(`[data-turn-id="${tid(2)}"][aria-current="true"]`).waitFor();
  assert.equal(await worker.locator(`[data-turn-id="${tid(6)}"][aria-current="true"]`).count(), 0, "a linked focus clears the receipt-clicked one");
  await worker.locator(`[data-event-receipt="${tid(52)}"]`).getByRole("button", { name: `turn ${tid(6).slice(0, 8)}` }).click();
  await worker.locator(`[data-turn-id="${tid(6)}"][aria-current="true"]`).waitFor();
  assert.equal(await worker.locator(`[data-turn-id="${tid(2)}"][aria-current="true"]`).count(), 0, "an explicit receipt focus outranks a stale linked focus");
  // The detour may have remounted the list; reopen the collapsed closed-Worker rows.
  if (await row("stack · dddddd").count() === 0) await list.getByRole("button", { name: /Closed/ }).click();

  // Turn 1's watch: the exact receipt, then the exact request's completed observation — never the latest turn.
  const turn1 = worker.locator(`[data-turn-id="${tid(1)}"]`);
  await turn1.getByRole("button", { name: "Bot watch" }).click();
  await turn1.locator(`[data-receipt="${account(300)}"]`).getByText("Delivered").waitFor();
  await turn1.getByText(/Terminal admission acknowledged/).waitFor();
  await turn1.getByText("Completion", { exact: true }).waitFor();
  await turn1.getByText("Completed · end_turn", { exact: true }).waitFor();
  // A follow-up worker_send can come from a different Chat of the same Bot, so the watch filter is Bot-only.
  assert.deepEqual(watchCalls.find((call) => call.recordId === account(101)), { package: "worker", recordId: account(101), limit: 100, botId: "bot-1" });

  // Turn 2's watch: active observation with bounded pending permission metadata, 8 of 12, no answering control.
  const turn2 = worker.locator(`[data-turn-id="${tid(2)}"]`);
  await turn2.getByRole("button", { name: "Bot watch" }).click();
  await turn2.getByText("Attention", { exact: true }).waitFor();
  await turn2.getByText("12 pending permissions").waitFor();
  assert.equal(await turn2.locator("li").filter({ hasText: /permission / }).count(), 8, "only the bounded eight pending entries render");
  await turn2.getByText(/Showing 8 of 12\. Full options are in the Worker summary/).waitFor();
  for (const name of [/allow/i, /deny/i, /answer/i]) assert.equal(await turn2.getByRole("button", { name }).count(), 0, `no ${name} in a turn watch`);
  await page.screenshot({ path: join(evidence, "worker-turn-watch.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await shot("worker-turn-watch-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 430, height: 900 }); await shot("worker-turn-watch-narrow");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await turn2.getByRole("button", { name: "Bot watch" }).click();
  await turn1.getByRole("button", { name: "Bot watch" }).click();
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

  // Watches stay truthful per turn: an uncertain admission is frozen, an observed one is settled,
  // and an operator-started turn has no Bot watch at all. Nothing here answers or retries anything.
  await worker.getByRole("tab", { name: "Turns" }).click();
  const turn4 = worker.locator(`[data-turn-id="${tid(4)}"]`);
  await turn4.getByRole("button", { name: "Bot watch" }).click();
  await turn4.locator(`[data-receipt="${account(302)}"]`).getByText("Unknown", { exact: true }).waitFor();
  await turn4.getByText(/Native admission is uncertain\. Delivery is frozen/).waitFor();
  await turn4.getByText("Completion", { exact: true }).waitFor();
  await turn4.getByRole("region", { name: "Bot watch" }).getByText(/Turn outcome is unknown after server restart/).waitFor();
  assert.equal(await turn4.getByRole("button", { name: /Retry|Rearm|Resend/i }).count(), 0);
  await turn4.getByRole("button", { name: "Bot watch" }).click();

  await row("stack · dddddd").click();
  await worker.getByRole("tab", { name: "Turns" }).click();
  const turn5 = worker.locator(`[data-turn-id="${tid(5)}"]`);
  await turn5.getByRole("button", { name: "Bot watch" }).click();
  await turn5.locator(`[data-receipt="${account(303)}"]`).getByText("Observed").waitFor();
  await turn5.getByText("Watch retired").waitFor();
  await turn5.getByText("Turn content cleared").waitFor();
  await turn5.getByRole("button", { name: "Bot watch" }).click();

  await row("brain · bbbbbb").click();
  await worker.getByRole("tab", { name: "Turns" }).click();
  await worker.getByText("No event deliveries recorded.").waitFor();
  const turn3 = worker.locator(`[data-turn-id="${tid(3)}"]`);
  await turn3.getByRole("button", { name: "Bot watch" }).click();
  await turn3.getByText("No Bot watch requested").waitFor();
  await turn3.getByText(/watches its exact request by default/).waitFor();
  assert.equal(await turn3.getByText("Completion", { exact: true }).count(), 0, "no receipt reads no observation");
  await turn3.getByRole("button", { name: "Bot watch" }).click();
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

  // --- Local owner maintenance. Lifecycle operations still fail if reached.
  await list.getByLabel("Started by").selectOption("");
  await list.getByRole("button", { name: /Closed/ }).click();
  await row("stack · dddddd").click();
  await worker.getByRole("tab", { name: "Changes" }).click();
  const reset = await open(worker, "Maintenance");
  await reset.getByText(/All uncommitted tracked changes and index state are lost/).waitFor();
  resetAvailable = true; resetBlocked = true;
  sockets.get("worker").publish("worker_changed", wid("d"));
  await worker.getByText("Fix the scheduler race", { exact: true }).waitFor();
  await press(reset.getByRole("button", { name: "Prepare reset worktree" }));
  await reset.getByText(/An earlier retained tip exists/).waitFor();
  assert.equal(await reset.getByRole("button", { name: "Reset worktree", exact: true }).isDisabled(), true);
  await shot("worker-reset-blocked-light");
  resetBlocked = false;
  await press(reset.getByRole("button", { name: "Discard plan" }));
  await press(reset.getByRole("button", { name: "Prepare reset worktree" }));
  await reset.getByText(`1 commits, 2 changed files; old tip retained at refs/stack/retained/${wid("d")}`, { exact: true }).waitFor();
  await reset.getByText("Native credentials/profiles, Signal/Infer/HUD copies, source checkout, remotes and backups remain independent", { exact: true }).waitFor();
  await shot("worker-reset-plan-light");
  await page.emulateMedia({ colorScheme: "dark" }); await shot("worker-reset-plan-dark");
  await press(reset.getByRole("button", { name: "Reset worktree", exact: true }));
  await reset.getByText("Completed for the declared scope only.").waitFor();
  await worker.getByText("No changes against the base commit", { exact: true }).waitFor();

  // Native scope comes from the owner's plan, not the abbreviated Worker record.
  await worker.getByRole("tab", { name: "Session" }).click();
  const native = await open(worker, "Purge native session");
  assert.equal(await native.getByRole("button", { name: "Prepare purge native session" }).isDisabled(), true, "enabled account blocks prepare");
  workerAccounts[1].enabled = false;
  nativeRuntimeBusy = true;
  sockets.get("auth").publish("worker_accounts_changed");
  sockets.get("worker").publish("workers_changed");
  await native.getByText("Met: Account disabled, not removing, and provider matches", { exact: true }).waitFor();
  await native.getByText("Not met: No active account runtime observed", { exact: true }).waitFor();
  assert.equal(await native.getByRole("button", { name: "Prepare purge native session" }).isDisabled(), true, "live runtime still blocks prepare");
  drained = true;
  sockets.get("worker").publish("workers_changed");
  await native.getByText("Met: No active account runtime observed", { exact: true }).waitFor();
  nativeBlocked = true;
  await press(native.getByRole("button", { name: "Prepare purge native session" }));
  await native.getByText("Native session purge version has not been scope-verified", { exact: true }).waitFor();
  assert.equal(await native.getByRole("button", { name: "Purge native session", exact: true }).isDisabled(), true);
  await shot("worker-native-blocked-dark");
  nativeBlocked = false;
  await press(native.getByRole("button", { name: "Discard plan" }));
  omitNativeIds = true;
  await press(native.getByRole("button", { name: "Prepare purge native session" }));
  await native.getByText("The plan discloses no exact native IDs. Purge is unavailable.", { exact: true }).waitFor();
  assert.equal(await native.getByRole("button", { name: "Purge native session", exact: true }).isDisabled(), true, "missing authoritative native IDs fails closed");
  assert.equal(await native.getByRole("region", { name: "Exact native purge IDs" }).count(), 0, "record native ID is not substituted");
  await press(native.getByRole("button", { name: "Discard plan" }));
  omitNativeIds = false;
  await press(native.getByRole("button", { name: "Prepare purge native session" }));
  await native.getByRole("region", { name: "Exact native purge IDs" }).getByText(`Exact native sessions and verified descendants selected: ${nativeIds}`, { exact: true }).waitFor();
  assert.equal(await native.getByRole("button", { name: "Purge native session", exact: true }).isDisabled(), false);
  await native.getByRole("region", { name: "Exact native purge IDs" }).scrollIntoViewIfNeeded();
  await page.emulateMedia({ colorScheme: "light" }); await shot("worker-native-plan-light");
  await page.emulateMedia({ colorScheme: "dark" }); await shot("worker-native-plan-dark");
  const previewGrip = worker.locator('span[title^="Resize"]').first(), previewEdge = await previewGrip.boundingBox();
  await page.mouse.move(previewEdge.x + previewEdge.width / 2, previewEdge.y + previewEdge.height / 2); await page.mouse.down();
  await page.mouse.move(previewEdge.x - 250, previewEdge.y + previewEdge.height / 2, { steps: 8 }); await page.mouse.up();
  assert.ok((await worker.boundingBox()).width < 400, "native preview is actually narrow");
  assert.ok(await worker.locator("[data-scroll]").last().evaluate((body) => body.scrollWidth <= body.clientWidth), "full native IDs reflow without horizontal overflow");
  await native.getByRole("region", { name: "Exact native purge IDs" }).scrollIntoViewIfNeeded();
  await page.emulateMedia({ colorScheme: "light" }); await shot("worker-native-plan-narrow");
  loseApply = true;
  await press(native.getByRole("button", { name: "Purge native session", exact: true }));
  await native.getByText("Running. Read this receipt again to observe it.").waitFor();
  const nativeApply = maintenanceCalls.filter(([name]) => name === "apply").at(-1)[1];
  journal.finish(nativeApply.requestId, "unknown", [{ resource: wid("d"), outcome: "unknown", detail: "Native absence/sibling/credential preservation could not be verified" }]);
  await press(native.getByRole("button", { name: "Read receipt again" }));
  await native.getByText("Unknown. The owner cannot say what happened. Inspect the exact resources; this request will not run again.").waitFor();
  for (const name of ["Prepare a new plan", "Close receipt", "Send identical request"]) assert.equal(await native.getByRole("button", { name }).count(), 0);
  const appliesBeforeReload = maintenanceCalls.filter(([name]) => name === "apply").length;
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("stack.uix.workers.v1"))[0].workerId), wid("d"));
  await page.reload();
  await worker.getByRole("heading", { name: /stack · dddddd/ }).waitFor();
  assert.deepEqual(errors, [], "persisted Worker selection restores after reload without hydration errors");
  await list.getByRole("button", { name: /Closed/ }).click();
  await worker.getByRole("tab", { name: "Session" }).click();
  const recovered = worker.locator("details").filter({ has: page.locator("summary", { hasText: "Purge native session" }) });
  await recovered.getByRole("region", { name: "worker receipt unknown" }).waitFor();
  assert.equal(await recovered.evaluate((element) => element.open), true);
  assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`stack.state-flow.worker:native_session:${id}`)).input.requestId, wid("d")), nativeApply.requestId);
  assert.equal(maintenanceCalls.filter(([name]) => name === "apply").length, appliesBeforeReload);
  for (const name of ["Prepare a new plan", "Close receipt", "Send identical request"]) assert.equal(await recovered.getByRole("button", { name }).count(), 0);

  // Resize the real card; full IDs and preconditions must not create horizontal overflow.
  const grip = worker.locator('span[title^="Resize"]').first(), edge = await grip.boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await page.mouse.down();
  await page.mouse.move(edge.x - 250, edge.y + edge.height / 2, { steps: 8 }); await page.mouse.up();
  assert.ok((await worker.boundingBox()).width < 400);
  assert.ok(await worker.locator("[data-scroll]").last().evaluate((body) => body.scrollWidth <= body.clientWidth), "no narrow horizontal overflow");
  await recovered.getByRole("region", { name: "worker receipt unknown" }).scrollIntoViewIfNeeded();
  await shot("worker-native-unknown-narrow");

  // Recorded claims survive Worker removal; collected claims cannot be selected or adopted.
  const retained = await open(list, "Maintenance");
  await retained.getByRole("checkbox", { name: `Select branch Worker ${branches[0].workerId}`, exact: true }).waitFor();
  assert.equal(await retained.getByRole("checkbox", { name: `Select branch Worker ${branches[1].workerId}`, exact: true }).isDisabled(), true);
  await retained.getByText(/collected — retired claim/).first().waitFor();
  changeBranchPage = true;
  await press(retained.getByRole("button", { name: "Load more branches" }));
  await list.getByText("The observation changed while paging; showing the first page again.").waitFor();
  await press(retained.getByRole("button", { name: "Load more branches" }));
  await retained.getByRole("checkbox", { name: `Select branch Worker ${branches[100].workerId}`, exact: true }).waitFor();
  const choose = retained.getByRole("checkbox", { name: `Select branch Worker ${branches[0].workerId}`, exact: true });
  await choose.focus(); await page.keyboard.press("Space");
  await press(retained.getByRole("button", { name: "Prepare collecting 1 branches" }));
  await retained.getByText(/Unmerged into the recorded base commit/).waitFor();
  assert.deepEqual(maintenanceCalls.filter(([name]) => name === "plan").at(-1)[1].allowUnmerged, []);
  assert.equal(await retained.getByRole("button", { name: "Collect these branches" }).isDisabled(), true);
  const consent = retained.getByRole("checkbox", { name: `Allow unmerged collection for ${branches[0].branch}`, exact: true });
  assert.equal(await consent.isDisabled(), true, "consent freezes with the plan");
  await press(retained.getByRole("button", { name: "Discard plan" }));
  await consent.focus(); await page.keyboard.press("Space");
  await choose.focus(); await page.keyboard.press("Space"); await page.keyboard.press("Space");
  assert.equal(await consent.isChecked(), false, "deselecting revokes consent instead of inferring it on reselect");
  await consent.focus(); await page.keyboard.press("Space");
  await press(retained.getByRole("button", { name: "Prepare collecting 1 branches" }));
  assert.deepEqual(maintenanceCalls.filter(([name]) => name === "plan").at(-1)[1].allowUnmerged, [branches[0].workerId]);
  await page.emulateMedia({ colorScheme: "light" }); await shot("worker-branches-plan-light", list);
  await press(retained.getByRole("button", { name: "Collect these branches" }));
  await retained.getByText("Completed for the declared scope only.").waitFor();
  assert.equal(await choose.isDisabled(), true);

  // Clearing from another Worker window invalidates an expanded chunked Records reader.
  workers[0].phase = "closed"; workers[0].currentTurnId = null;
  sockets.get("worker").publish("workers_changed"); sockets.get("worker").publish("worker_changed", wid("a"));
  await row("stack · aaaaaa").dispatchEvent("click");
  await press(worker.getByRole("tab", { name: "Records" }));
  await press(worker.getByRole("button", { name: /tool_call_update/ }));
  await press(worker.getByRole("button", { name: "Load full record" }));
  await worker.getByText("all tests passed", { exact: true }).waitFor();
  await press(worker.getByRole("button", { name: "New Worker window" }));
  const cleanup = page.locator('[data-window="worker-2"]');
  await cleanup.getByRole("heading", { name: /stack · aaaaaa/ }).waitFor();
  await press(cleanup.getByRole("tab", { name: "Session" }));
  const clear = await open(cleanup, "Clear transcript");
  await press(clear.getByRole("button", { name: "Prepare clear transcript" }));
  await clear.getByText("Worker/turn identity, admission digests, outcomes including unknown, usage, settings and captured Work context remain", { exact: true }).waitFor();
  await press(clear.getByRole("button", { name: "Clear transcript", exact: true }));
  await clear.getByText("Completed for the declared scope only.").waitFor();
  await worker.getByText(/^Content cleared/).waitFor();
  assert.equal(await worker.getByText("all tests passed", { exact: true }).count(), 0, "expanded chunk cache is discarded");
  await press(worker.getByRole("tab", { name: "Conversation" }));
  await worker.getByText(/^Content cleared/).waitFor();
  assert.equal(await worker.getByText("Fix the flaky scheduler test", { exact: true }).count(), 0);
  await press(worker.getByRole("tab", { name: "Turns" }));
  await worker.getByText("Prompt cleared", { exact: true }).first().waitFor();
  await worker.getByRole("link", { name: /Work 55555555/ }).first().waitFor();
  await press(clear.getByRole("button", { name: "Close receipt" }));
  assert.equal(await clear.getByRole("button", { name: "Prepare clear transcript" }).isDisabled(), true);
  await shot("worker-transcript-cleared-light", cleanup);
  await press(cleanup.getByRole("button", { name: "Close Worker window" }));

  // Catalog invalidation must not implicitly regenerate a cache or launch native discovery, including after reload.
  const reenabledCatalog = new Promise((resolve) => { catalogReady = resolve; });
  workerAccounts[1].enabled = true;
  sockets.get("auth").publish("worker_accounts_changed");
  await reenabledCatalog;
  await row("brain · bbbbbb").dispatchEvent("click");
  await press(worker.getByRole("tab", { name: "Session" }));
  const modelCache = await open(worker, "Clear model catalog");
  const catalogBefore = catalogCalls.filter(([id]) => id === codex).length;
  await press(modelCache.getByRole("button", { name: "Prepare clear model catalog" }));
  await modelCache.getByText(/Catalog is account-shared derived state/).waitFor();
  await press(modelCache.getByRole("button", { name: "Clear model catalog", exact: true }));
  await modelCache.getByText("Completed for the declared scope only.").waitFor();
  await list.getByRole("button", { name: "Refresh branches" }).waitFor();
  assert.equal(catalogCalls.filter(([id]) => id === codex).length, catalogBefore, "no cache-miss observation follows clear");
  await page.reload();
  await row("brain · bbbbbb").waitFor();
  assert.equal(catalogCalls.filter(([id]) => id === codex).length, catalogBefore, "catalog hold survives reload");

  // Seed through the same Worker journal, not a mock receipt getter. Partial external effects stay inspection-only.
  const partialPlan = planWorker({ ids: [branches[2].workerId], kind: "branch", allowUnmerged: [branches[2].workerId] });
  const partialInput = { planId: partialPlan.id, expectedRevision: partialPlan.revision, requestId: crypto.randomUUID() };
  journal.begin(partialInput, partialPlan);
  journal.finish(partialInput.requestId, "partial", [{ resource: branches[2].workerId, outcome: "unknown", detail: "Inspect exact branch claim; admitted external effect was not verified" }]);
  await page.evaluate((input) => localStorage.setItem("stack.state-flow.worker:branch:ids", JSON.stringify({ input, at: Date.now() })), partialInput);
  await page.reload();
  const partial = list.getByRole("region", { name: "worker receipt partial" });
  await row("brain · bbbbbb").waitFor();
  // The list can mount before its channel opens. A failed recovery read is uncertain, never an apply retry.
  const readPartial = list.getByRole("button", { name: "Read receipt", exact: true });
  if (await readPartial.count()) await press(readPartial);
  await partial.waitFor();
  assert.equal(await partial.locator("xpath=ancestor::details").evaluate((element) => element.open), true);
  for (const name of ["Prepare a new plan", "Close receipt", "Send identical request", "Collect these branches"]) assert.equal(await list.getByRole("button", { name, exact: true }).count(), 0);
  await page.emulateMedia({ colorScheme: "dark" }); await partial.scrollIntoViewIfNeeded(); await shot("worker-branches-partial-dark", list);

  // Exposure is an independent selection: a plan without apply is not a usable maintenance control.
  const docWorker = catalog.find((doc) => doc.name === "worker");
  docWorker.transports[0].operations = docWorker.transports[0].operations.filter((name) => name !== "worker_state_clear");
  const plansBeforeHidden = maintenanceCalls.filter(([name]) => name === "plan").length;
  await page.reload();
  await row("brain · bbbbbb").click();
  await press(worker.getByRole("tab", { name: "Session" }));
  await worker.getByText(/Coverage partial/).waitFor();
  assert.equal(await worker.locator("details").count(), 0, "missing apply exposure hides Session maintenance");
  assert.equal(await list.getByRole("heading", { name: "Retained branches", exact: true }).count(), 0);
  assert.equal(maintenanceCalls.filter(([name]) => name === "plan").length, plansBeforeHidden);

  assert.deepEqual(writes, []);
  assert.equal(sentCalls.some((params) => params.package === "worker" && params.name === "worker_respond"), false, "no permission answer ever left the page");
  assert.deepEqual(errors, []);
  console.log(`workers browser check passed; evidence in ${evidence}`);
} finally {
  await browser?.close();
  next?.kill();
  await websocket?.close();
  for (const socket of sockets.values()) await socket.close();
  await rolesServer?.close();
  journal.close();
  if (!process.env.WORKERS_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
