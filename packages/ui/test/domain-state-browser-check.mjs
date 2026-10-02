// Optional rendered check of owner maintenance in existing spaces after pnpm test (and a ui build, or NEXT_MODE=dev):
// Signal captured content, correlated and Lab Infer payloads, Inbox dismissed content, Content storage, Xcom in
// System, the System State owner links, HUD Work history, Proc removed-schedule redaction and the Lab Infer model
// catalog clear. The real notify, hud and proc APIs run on a disposable state directory (Worker and Bot answers for
// HUD dependencies are fixture sockets); Signal, Infer, Content and Xcom are fixture sockets whose plans, applies and
// receipts go through the real StateJournal.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/domain-state-browser-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath, StateJournal } from "@stack/api";
import { ProcStore } from "../../proc/dist/src/store.js";
import { authorizeBrowser, fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, serveFixture, ui } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/tmp", "as-domain-state-"));
const evidence = process.env.DOMAIN_STATE_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const at = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/** Plans, applies and receipts through the real journal; `effect` returns outcomes, or `{ status, outcomes }`. */
function journalOwner(name) {
  const journal = new StateJournal(join(dir, `${name}-state.sqlite`), name);
  return {
    journal,
    plan(action, selection, preview) {
      return journal.plan({ subject: null, action, revision: preview.revision ?? JSON.stringify(selection), resources: preview.resources, blockedBy: preview.blockedBy ?? [],
        retained: preview.retained ?? [], regeneration: preview.regeneration ?? [] }, selection);
    },
    apply(input, current, effect) {
      const existing = journal.existing(input); if (existing) return existing;
      const { plan, payload } = journal.getPlan(input.planId);
      if (plan.revision !== input.expectedRevision || current(payload) !== plan.revision) throw new Error("state changed; prepare a new plan");
      if (plan.blockedBy.length) throw new Error(plan.blockedBy.join("; "));
      journal.begin(input, plan);
      const result = effect(payload);
      return Array.isArray(result) ? journal.finish(input.requestId, "completed", result) : journal.finish(input.requestId, result.status, result.outcomes);
    },
    receipt: ({ requestId }) => ({ receipt: journal.receipt(requestId) }),
  };
}

// Signal: processing on, a source read still draining.
const signal = { owner: journalOwner("signal"), draining: true, status: { contentGeneration: 1, enabled: true, activatedAt: Date.now() - 60_000, baselined: true,
  settings: { model: "gpt-fixture", reasoningEffort: "low", accountId: null, revision: 1 }, lastScan: Date.now(), lastInference: null, sourceErrors: [], jobs: [], messages: 42, runs: 7, changeSeq: 1 } };
// Infer: two terminal requests and one still running.
const request = (id, state, text) => ({ requestId: id, contentClearedAt: null, accountId: uuid(), model: "gpt-fixture", effort: "low", maxOutputTokens: 256, state, error: state === "failed" ? "rate_limited" : null,
  reportedModel: null, usage: state === "running" ? null : { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: null }, createdAt: at(), finishedAt: state === "running" ? null : at(),
  inputPreview: `prompt ${text}`, textPreview: state === "completed" ? `answer ${text}` : null, textChars: 12 });
const infer = { owner: journalOwner("infer"), requests: [request(uuid(), "completed", "one"), request(uuid(), "failed", "two"), request(uuid(), "running", "three")] };
const correlated = uuid();
infer.requests.push(request(correlated, "completed", "signal"));
// Content: one finalized and one staging upload; one referenced and one unreferenced blob under "ab".
const content = { owner: journalOwner("content"), stages: [{ id: uuid(), bytes: 2048, received: 2048, digest: "ab".padEnd(64, "1"), blob: "ab".padEnd(64, "1"), createdAt: at(), revision: "stage-r1" },
  { id: uuid(), bytes: 4096, received: 1024, digest: "cd".padEnd(64, "2"), blob: null, createdAt: at(), revision: "stage-r1" }],
  blobs: [{ digest: "ab".padEnd(64, "1"), bytes: 2048, items: [{ id: uuid(), revision: 3 }] }, { digest: "ab".padEnd(64, "3"), bytes: 512, items: [] }] };
// Xcom: scanning, not paused; the sync finishes a few reads after pausing.
const xcom = { owner: journalOwner("xcom"), paused: false, running: true, finishAfter: 0,
  posts: [1, 2, 3].map((n) => ({ tweet_id: `17000000000000000${n}`, author_id: `a${n}`, author_handle: `author${n}`, created_at: at(), archived_at: at(), source_uri: `https://x.com/i/${n}`, content: `Post number ${n}`, article_title: null })) };
const xcomStatus = () => {
  if (xcom.paused && xcom.running && --xcom.finishAfter <= 0) xcom.running = false;
  return { database: "fixture", auto_sync: true, paused: xcom.paused, tweets: xcom.posts.length, articles: 0, unfetched_articles: 1, unavailable_articles: 0, users: 3,
    sync: { running: xcom.running, mode: xcom.running ? "head" : null, started_at: null, last_finished_at: null, last_error: null, pages: 0, new_posts: 0, new_articles: 0 },
    head: { started_at: null, cursor: "c1", pages: 1, last_start: null, stop_reason: null }, backfill: { started_at: null, cursor: null, pages: 0, last_start: null, stop_reason: null } };
};

// Proc: removed schedules seeded into the owner's store before the real API opens it. One holds a secret-bearing
// definition, one is Brain-protected (the plan refuses it), one has an unknown receipt left by an earlier session, and
// one is still active (no maintenance is offered for it).
const procIds = { removed: uuid(), brain: uuid(), unknown: uuid(), active: uuid() };
const procSeed = new ProcStore(join(dir, "proc"));
const processSpec = (label, enabled) => ({ label, firstAt: new Date(Date.now() - 3_600_000).toISOString(), everyMs: null, enabled,
  action: { type: "process", process: { command: "/bin/echo", args: ["--token", "s3cret-arg"], cwd: "/tmp/removed-cwd", env: { API_TOKEN: "s3cret-env" }, timeoutMs: null, retainOutput: true } } });
procSeed.createSchedule(procIds.removed, processSpec("Nightly sync", false));
procSeed.createSchedule(procIds.brain, { label: "Brain source wake-up", firstAt: new Date(Date.now() - 3_600_000).toISOString(), everyMs: null, enabled: false,
  action: { type: "api", package: "notify", operation: "notification_send", input: { title: "brain-input" } } });
procSeed.createSchedule(procIds.unknown, processSpec("Old backup", false));
procSeed.createSchedule(procIds.active, processSpec("Still scheduled", false));
for (const id of [procIds.removed, procIds.brain, procIds.unknown]) procSeed.removeSchedule(id, 1);
procSeed.db.prepare("UPDATE schedules SET system=1 WHERE id=?").run(procIds.brain);
const unknownPlan = procSeed.historyPlan("schedule_definition", [procIds.unknown]);
const unknownInput = { planId: unknownPlan.id, expectedRevision: unknownPlan.revision, requestId: uuid() };
procSeed.maintenance.begin(unknownInput, unknownPlan);
procSeed.maintenance.finish(unknownInput.requestId, "unknown", [{ resource: procIds.unknown, outcome: "unknown", detail: "Fixture: the owner cannot say whether the redaction ran" }]);

// HUD: work and Worker/Bot answers for its dependency checks. The real HUD API owns the plans, tombstones and receipts.
const hudIds = { epic: uuid(), design: uuid(), spike: uuid(), build: uuid(), pilot: uuid() };
const hudWorker = { open: true, id: "22222222-0000-4000-8000-000000000001", turn: "44444444-0000-4000-8000-000000000001" };
// Stable timestamps: the owner binds the plan to what the Worker reports, so a moving clock would stale every plan.
const hudStarted = Date.now() - 60_000;
const hudAdmission = () => ({ sequence: 1, workerId: hudWorker.id, turnId: hudWorker.turn, context: { workItemId: hudIds.build, scopeRevision: 1, source: "explicit" }, botId: "bot-1", threadId: "main-bot-1",
  accountId: "33333333-0000-4000-8000-000000000001", provider: "codex", model: "gpt-fixture", effort: "medium", workerPhase: hudWorker.open ? "running" : "closed",
  turnPhase: hudWorker.open ? "running" : "completed", current: true, createdAt: hudStarted, updatedAt: hudStarted });
// Infer: two Bot accounts, each with a cached model catalog; `discoveries` records every explicit or implicit discovery.
const inferAccounts = [uuid(), uuid()];
const inferModelsFixture = [{ id: "gpt-fixture", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"] }];
const inferCatalog = { observed: new Map(inferAccounts.map((accountId) => [accountId, { accountId, models: inferModelsFixture, observedAt: at(), discovering: false, error: null }])), discoveries: [], clears: [] };

const publishers = {};
const handlers = {
  attention_status: () => signal.status,
  attention_control: ({ enabled }) => { signal.status = { ...signal.status, enabled, changeSeq: signal.status.changeSeq + 1 }; publishers.signal?.("signal_changed"); return signal.status; },
  attention_history_plan: () => {
    if (signal.status.enabled) throw new Error("Pause Signal processing before planning content cleanup");
    return signal.owner.plan("history_clear", { scope: "all-captured-content" }, { revision: `g${signal.status.contentGeneration}`, resources: ["42 captured messages", "cross-conversation context copies", "source-read blobs"],
      blockedBy: signal.draining ? ["A source read is still draining; wait for it to finish"] : [], retained: ["Message revision suppression", "Source cursors", "Infer correlation IDs"] });
  },
  attention_history_clear: (input) => {
    const receipt = signal.owner.apply(input, () => `g${signal.status.contentGeneration}`, () => { signal.status = { ...signal.status, contentGeneration: signal.status.contentGeneration + 1, messages: 0, changeSeq: signal.status.changeSeq + 1 };
      return [{ resource: "captured content", outcome: "removed", detail: "All captured messages and blobs cleared" }]; });
    publishers.signal?.("signal_changed");
    return receipt;
  },
  signal_state_receipt_get: (input) => signal.owner.receipt(input),
  attention_infer_requests: () => ({ requestIds: [correlated], nextOffset: null }),
  infer_request_list: () => ({ requests: infer.requests }),
  infer_model_list: () => ({ accounts: [...inferCatalog.observed.values()] }),
  infer_discover: ({ accountId }) => {
    inferCatalog.discoveries.push(accountId);
    inferCatalog.observed.set(accountId, { accountId, models: inferModelsFixture, observedAt: at(), discovering: false, error: null });
    queueMicrotask(() => publishers.infer?.("infer_changed"));
    return inferCatalog.observed.get(accountId);
  },
  infer_catalog_clear: (input) => {
    inferCatalog.clears.push(input);
    const cleared = input.accountIds ?? [...inferCatalog.observed.keys()];
    for (const accountId of cleared) inferCatalog.observed.delete(accountId);
    queueMicrotask(() => publishers.infer?.("infer_changed"));
    return { cleared };
  },
  account_list: () => ({ accounts: inferAccounts.map((id) => ({ id, enabled: true, removing: false, linkedAccounts: [] })) }), worker_account_list: () => ({ accounts: [] }),
  account_login_current: () => ({ login: null }), worker_account_login_current: () => ({ logins: [] }),
  worker_work_list: ({ workItemId }) => ({ entries: workItemId === hudIds.build ? [hudAdmission()] : [], nextCursor: null }),
  chat_records: () => ({ records: [] }),
  bot_list: () => ({ bots: [{ id: "bot-1", state: "running", pid: 321, cwd: "/fixture/workspace", url: null, account: null, runningAccount: null, mainThreadId: "main-bot-1", recoveryIssue: null, roleRevision: null, settings: null }] }),
  infer_history_plan: ({ requestIds }) => infer.owner.plan("history_clear", { requestIds }, { revision: JSON.stringify(requestIds.map((id) => infer.requests.find((row) => row.requestId === id)?.contentClearedAt ?? null)),
    resources: requestIds.map((id) => `request ${id}`), blockedBy: requestIds.filter((id) => infer.requests.find((row) => row.requestId === id)?.state === "running").map((id) => `Request ${id} is still running`),
    retained: ["Request identity, account, model, usage and outcome"] }),
  infer_history_clear: (input) => {
    const receipt = infer.owner.apply(input, (payload) => JSON.stringify(payload.requestIds.map((id) => infer.requests.find((row) => row.requestId === id)?.contentClearedAt ?? null)), (payload) => {
      infer.requests = infer.requests.map((row) => payload.requestIds.includes(row.requestId) ? { ...row, contentClearedAt: at(), inputPreview: "", textPreview: null } : row);
      return payload.requestIds.map((id) => ({ resource: id, outcome: "removed", detail: "Payload cleared" }));
    });
    publishers.infer?.("infer_changed");
    return receipt;
  },
  infer_state_receipt_get: (input) => infer.owner.receipt(input),
  blob_stage_list: () => ({ stages: content.stages, nextOffset: null }),
  blob_stage_abort: ({ id, expectedRevision }) => {
    const stage = content.stages.find((row) => row.id === id);
    if (stage && stage.revision !== expectedRevision) throw new Error("upload stage revision changed; read it again");
    content.stages = content.stages.filter((row) => row.id !== id);
    publishers.content?.("content_changed");
    return { id, aborted: true };
  },
  content_blob_list: ({ prefix }) => {
    const rows = content.blobs.filter((blob) => blob.digest.startsWith(prefix));
    return { entries: rows.map((blob) => ({ path: `${prefix}/${blob.digest}`, type: "file", bytes: blob.bytes, modifiedAt: at(), revision: blob.digest })), revision: "blobs-r1", nextOffset: null,
      references: rows.map((blob) => ({ digest: blob.digest, items: blob.items, stages: content.stages.filter((stage) => stage.blob === blob.digest).map((stage) => ({ id: stage.id })) })) };
  },
  content_storage_plan: ({ digests }) => content.owner.plan("collection_blobs", { digests }, { resources: digests.map((digest) => `blob ${digest}`), retained: ["Vault Git history, named Artifacts, remotes and backups"] }),
  content_storage_collect: (input) => content.owner.apply(input, (payload) => JSON.stringify(payload), (payload) => ({ status: "partial",
    outcomes: payload.digests.map((digest) => ({ resource: digest, outcome: "unknown", detail: "Removal interrupted; inspect .stack-clear quarantine" })) })),
  content_state_receipt_get: (input) => content.owner.receipt(input),
  xcom_status: xcomStatus,
  xcom_control: ({ paused }) => { xcom.paused = paused; if (paused) xcom.finishAfter = 2; return { paused, running: xcom.running }; },
  xcom_list: () => ({ results: xcom.posts, next_offset: null }),
  xcom_articles_pending: () => ({ results: [{ tweet_id: "1700000000000000099", author_id: "a9", author_handle: "author9", created_at: at(), archived_at: at(), title: "An unavailable article", attempted_at: at(), error: "not_found", source_uri: "https://x.com/i/99" }], next_offset: null }),
  xcom_history_plan: (selection) => {
    if (!xcom.paused || xcom.running) throw new Error("Pause Xcom and wait for the sync to finish");
    return xcom.owner.plan(selection.kind, selection, { revision: JSON.stringify(xcom.posts.map((post) => post.tweet_id)), resources: selection.ids ?? [selection.scan],
      retained: ["Authors shared with other posts"], regeneration: selection.kind === "posts" && selection.reimport === "allow" ? ["A later scan may archive these posts again"] : [] });
  },
  xcom_history_clear: (input) => xcom.owner.apply(input, () => JSON.stringify(xcom.posts.map((post) => post.tweet_id)), (payload) => {
    if (payload.kind === "posts") xcom.posts = xcom.posts.filter((post) => !payload.ids.includes(post.tweet_id));
    return (payload.ids ?? [payload.scan]).map((id) => ({ resource: id, outcome: "removed", detail: "Source, raw, article and search rows cleared together" }));
  }),
  xcom_state_receipt_get: (input) => xcom.owner.receipt(input),
  serve_state_list: () => ({ entries: [], revision: "owners", observedAt: at(), nextOffset: null,
    owners: ["brain", "worker", "xcom"].map((name) => ({ package: name, available: true, issue: null })) }),
  serve_subscription_list: () => ({ subscriptions: [], revision: "none", nextOffset: null }),
};

/** Turn the first apply response for `action` into a transport error: the request ran, but its answer was lost. */
const loseResponse = () => {
  const Native = window.WebSocket;
  window.__lose = null;
  window.WebSocket = class extends Native {
    set onmessage(handler) {
      super.onmessage = handler ? (event) => {
        const lose = window.__lose;
        if (lose && typeof event.data === "string" && event.data.includes(`"action":"${lose}"`) && event.data.includes('"planId"')) {
          const message = JSON.parse(event.data);
          if (message.result?.status) { window.__lose = null; window.__lost = message.result.requestId;
            return handler.call(this, new MessageEvent("message", { data: JSON.stringify({ id: message.id, error: { message: "fixture: response lost in transit" } }) })); }
        }
        handler.call(this, event);
      } : handler;
    }
    get onmessage() { return super.onmessage; }
  };
};

const sockets = [];
let websocket, next, browser, notify, hud, proc;
let log = "";
let failed = false;
try {
  notify = await serveApi({ name: "notify", transport: "socket", env, root });
  hud = await serveApi({ name: "hud", transport: "socket", env, root });
  proc = await serveApi({ name: "proc", transport: "socket", env, root });
  // The HUD owner reads these two directly from their sockets for its dependency checks; the gateway does not select them.
  for (const [name, operations] of [["worker", ["worker_work_list"]], ["bots", ["bot_list", "chat_records"]]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(operations, handlers) }));
  }
  const notifyCall = (name, args = {}) => socketCall(socketPath("notify", env), "tools/call", { name, arguments: args });
  const names = ["serve", "api", "notify", "signal", "infer", "content", "xcom", "auth", "hud", "proc"];
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, names), port: 0 });
  const doc = async (name) => fixtureDoc(name, name === "api" ? null : (await import(`../../${name}/dist/api.js`)).api, websocket.url, publishedJsonSchema);
  const catalog = await Promise.all(names.map(doc));
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  const topicsOf = async (name) => (await import(`../../${name}/dist/api.js`)).api.events?.topics ?? {};
  const socketFor = async (name, operations) => {
    const topics = name === "serve" ? serve.topics : name === "api" ? {} : await topicsOf(name);
    const socket = await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
      operations: fixtureOperations(operations, handlers), events: { topics } });
    publishers[name] = (topic) => socket.publish(topic);
    sockets.push(socket);
  };
  await socketFor("serve", serve.names);
  await socketFor("api", ["docs_snapshot"]);
  await socketFor("signal", ["attention_status", "attention_control", "attention_history_plan", "attention_history_clear", "signal_state_receipt_get", "attention_infer_requests"]);
  await socketFor("infer", ["infer_request_list", "infer_model_list", "infer_discover", "infer_catalog_clear", "infer_history_plan", "infer_history_clear", "infer_state_receipt_get"]);
  await socketFor("auth", ["account_list", "worker_account_list", "account_login_current", "worker_account_login_current"]);
  await socketFor("content", ["blob_stage_list", "blob_stage_abort", "content_blob_list", "content_storage_plan", "content_storage_collect", "content_state_receipt_get"]);
  // Xcom selects explicit WebSocket operations, so the fixture answers each (reads it does not model fail explicitly).
  const xcomNames = ["xcom_state_read", "xcom_status", "xcom_list", "xcom_get", "xcom_users", "xcom_articles_pending", "xcom_control", "xcom_history_plan", "xcom_history_clear", "xcom_state_receipt_get"];
  for (const name of xcomNames) handlers[name] ??= () => { throw new Error(`${name} is not observed in this fixture`); };
  await socketFor("xcom", xcomNames);

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
  const page = await browser.newPage({ viewport: { width: 2400, height: 1500 }, reducedMotion: "reduce" });
  await page.addInitScript(loseResponse);
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(`${error.message} (${page.url()})`));
  const shot = (name, locator) => (locator ?? page).screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  const go = async (space) => { await page.goto(`${origin}/${space}`); await page.getByRole("button", { name: /Fit bench/ }).click().catch(() => undefined); };
  const completed = (scope) => scope.getByText("Completed for the declared scope only.");

  // System State: unsupported coverage is stated, and each owner links to its controls.
  await go("system");
  const state = page.locator('[data-window="state"]');
  await state.getByText("In-place Git reset, native-session reset or purge", { exact: false }).waitFor();
  await state.getByRole("region", { name: "worker state" }).getByRole("button", { name: "Open in Workers" }).waitFor();
  await shot("state-owner-links", state);

  // Xcom: pausing observes the running sync until it drains; post removal needs explicit choices.
  const xw = page.locator('[data-window="xcom-state"]');
  await xw.getByText("Syncing head").waitFor();
  await xw.getByText("Pause Xcom first.").waitFor();
  await xw.getByRole("switch", { name: "Admit Xcom scans" }).click();
  await xw.getByText("Paused", { exact: true }).waitFor({ timeout: 15_000 });
  await xw.getByRole("checkbox").nth(0).check();
  await xw.getByRole("checkbox").nth(1).check();
  assert.equal(await xw.getByRole("button", { name: "Prepare removing 2 posts" }).isDisabled(), true, "reimport and author handling have no defaults");
  await xw.getByRole("radio", { name: "Keep them out of the archive" }).check();
  await xw.getByRole("radio", { name: "Keep their records" }).check();
  await xw.getByRole("button", { name: "Prepare removing 2 posts" }).click();
  await xw.getByRole("button", { name: "Remove these posts" }).click();
  await completed(xw).waitFor();
  assert.deepEqual(xcom.posts.map((post) => post.tweet_id), ["170000000000000003"]);
  await shot("xcom", xw);

  // Signal: processing must be paused; a draining read blocks the plan; a new plan then clears the whole scope.
  await go("signal");
  const sw = page.locator('[data-window="signal"]');
  const captured = sw.getByText("Captured content", { exact: true });
  await captured.waitFor();
  await sw.getByText("Pause interpretation first.", { exact: false }).waitFor();
  await sw.getByRole("switch", { name: "Interpret new messages" }).click();
  await sw.getByRole("button", { name: "Prepare captured-content clear" }).click();
  await sw.getByText("A source read is still draining; wait for it to finish").waitFor();
  assert.equal(await sw.getByRole("button", { name: "Clear captured content" }).isDisabled(), true, "a blocked plan cannot apply");
  await shot("signal-blocked", sw);
  signal.draining = false;
  await sw.getByRole("button", { name: "Prepare a new plan" }).click();
  await sw.getByRole("button", { name: "Clear captured content" }).click();
  await completed(sw).waitFor();
  await sw.getByText("Content generation 2", { exact: false }).waitFor();
  await sw.getByRole("button", { name: "Close receipt" }).click();
  // Correlated Infer payloads are a separate, explicit Infer selection.
  await sw.getByRole("button", { name: "Correlated Infer requests…" }).click();
  await sw.getByRole("checkbox", { name: correlated }).check();
  await sw.getByRole("button", { name: "Prepare clearing 1 Infer request" }).click();
  await sw.getByRole("button", { name: "Clear these payloads" }).click();
  await completed(sw).waitFor();
  assert.ok(infer.requests.find((row) => row.requestId === correlated).contentClearedAt);
  await shot("signal-cleared", sw);

  // Lab Infer: running requests cannot be selected; a lost apply response is recovered from the same request's receipt.
  await go("lab");
  const lw = page.locator('[data-window="inference"]');
  await lw.getByRole("button", { name: "Select to clear" }).click();
  const [first, second, running] = infer.requests;
  assert.equal(await lw.getByRole("checkbox", { name: `Select request ${running.requestId}` }).isDisabled(), true);
  assert.equal(await lw.getByRole("checkbox", { name: `Select request ${correlated}` }).isDisabled(), true, "already cleared");
  await lw.getByRole("checkbox", { name: `Select request ${first.requestId}` }).check();
  await lw.getByRole("checkbox", { name: `Select request ${second.requestId}` }).check();
  await lw.getByRole("button", { name: "Prepare clearing 2 requests" }).click();
  await page.evaluate(() => { window.__lose = "history_clear"; });
  await lw.getByRole("button", { name: "Clear these payloads" }).click();
  await completed(lw).waitFor();
  const lost = await page.evaluate(() => window.__lost);
  assert.ok(lost);
  await lw.getByText(lost).waitFor();
  await lw.getByText("Content cleared · admission receipt retained").first().waitFor();
  await shot("lab-infer-lost-response", lw);

  // Inbox (real notify API): only dismissed notifications with content are selectable; clearing keeps the outcome.
  const sent = [];
  for (const title of ["Deploy finished", "Review ready", "Still open"]) sent.push(await notifyCall("notification_send", { title, message: `${title} body`, source: "ci" }));
  await notifyCall("notification_dismiss", { id: sent[0].id, outcome: "closed" });
  await notifyCall("notification_dismiss", { id: sent[1].id, outcome: "closed" });
  await go("inbox");
  const iw = page.locator('[data-window="notify-inbox"]');
  await iw.getByRole("radio", { name: "Dismissed" }).or(iw.getByRole("button", { name: "Dismissed" })).first().click();
  await iw.getByRole("button", { name: "Select to clear content…" }).click();
  await iw.getByRole("checkbox", { name: "Select Deploy finished" }).check();
  await iw.getByRole("checkbox", { name: "Select Review ready" }).check();
  await iw.getByRole("button", { name: "Prepare clearing 2 notifications" }).click();
  await iw.getByRole("button", { name: "Clear this content" }).click();
  await completed(iw).waitFor();
  await iw.getByText("Content cleared").first().waitFor();
  const cleared = await notifyCall("notification_get", { id: sent[0].id });
  assert.ok(cleared.contentClearedAt, "the owner cleared the content");
  assert.equal(cleared.outcome, "closed", "the original outcome is kept");
  assert.equal((await notifyCall("notification_get", { id: sent[2].id })).title, "Still open", "an open notification is untouched");
  await shot("inbox-cleared", iw);

  // Content storage: a stage changed after it was chosen is refused; a referenced blob cannot be selected; a partial result stays uncertain.
  await go("content");
  const cw = page.locator('[data-window="content-storage"]');
  await cw.getByRole("list", { name: "Upload stages" }).getByText("finalized").waitFor();
  await cw.getByRole("button", { name: `Retire stage ${content.stages[0].id}` }).click();
  content.stages[0] = { ...content.stages[0], revision: "stage-r2" };
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Retire stage" }).click();
  await dialog.getByText("upload stage revision changed", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(content.stages.length, 2, "nothing was retired");
  await cw.getByRole("combobox", { name: "Digest prefix" }).selectOption("ab");
  assert.equal(await cw.getByRole("checkbox", { name: `Select blob ${content.blobs[0].digest}` }).isDisabled(), true, "a referenced blob cannot be selected");
  await cw.getByRole("checkbox", { name: `Select blob ${content.blobs[1].digest}` }).check();
  await cw.getByRole("button", { name: "Prepare collecting 1 blob" }).click();
  await cw.getByRole("button", { name: "Collect these blobs" }).click();
  await cw.getByText("Partial. Some resources were not processed as planned.", { exact: false }).waitFor();
  await cw.getByText("Removal interrupted; inspect .stack-clear quarantine").waitFor();
  await shot("content-partial", cw);

  // HUD Work history. The real HUD API owns plans, tombstones and receipts; Workers and Bots answer its dependency checks.
  const hudCall = (name, args) => socketCall(socketPath("hud", env), "tools/call", { name, arguments: args });
  await hudCall("work_batch", { requestId: uuid(), changes: [
    { action: "create", id: hudIds.epic, title: "Ship maintenance", objective: "Epic objective body", state: "active" },
    { action: "create", id: hudIds.design, parentId: hudIds.epic, order: 0, title: "Design the controls", objective: "Design objective body", state: "review" },
    { action: "create", id: hudIds.spike, parentId: hudIds.design, order: 0, title: "Spike the plan", objective: "Spike objective body", state: "active" },
    { action: "create", id: hudIds.build, parentId: hudIds.epic, order: 10, title: "Build the windows", objective: "Build objective body", state: "active" },
    { action: "create", id: hudIds.pilot, title: "Pilot with a live Chat", objective: "Pilot objective body", state: "planned" },
  ] });
  await hudCall("work_note_add", { requestId: uuid(), id: hudIds.spike, expectedRevision: 1, kind: "result", body: "Spike findings: the secret-body of this result" });
  await hudCall("work_focus_set", { requestId: uuid(), target: { botId: "bot-1", mainThreadId: "main-bot-1", threadId: "main-bot-1" }, expectedRevision: 0, workItemId: hudIds.pilot });
  await go("");
  const tree = page.locator('[data-window="hud-work"]');
  const item = page.locator('[data-window="hud-item"]');
  const timeline = page.locator('[data-window="hud-timeline"]');
  const treeRow = (id) => tree.locator(`[data-node="work-item:${id}"]`);
  const pick = (id, title) => treeRow(id).getByRole("button", { name: new RegExp(`^(Planned|Active|Blocked|Waiting|Paused|Review|Completed|Cancelled) ${title}`) }).click();
  const maintenance = (scope) => scope.locator("summary", { hasText: "Maintenance" });
  const openMaintenance = async (scope) => { const summary = maintenance(scope); if (!(await scope.locator("details[open]").count())) await summary.click(); };

  // A leaf's journal bodies: the plan names the exact item and the retained copies; nothing is chosen for the operator.
  await pick(hudIds.spike, "Spike the plan");
  await timeline.getByText("Spike findings: the secret-body of this result").waitFor();
  await item.getByText("Spike objective body").waitFor();
  await openMaintenance(item);
  assert.equal(await item.getByRole("button", { name: /^Prepare clearing/ }).isDisabled(), true, "the scope is explicit: nothing is clearable until it is chosen");
  await item.getByText("Choose what to clear.").waitFor();
  await item.getByRole("radio", { name: "Journal bodies" }).check();
  await item.getByRole("button", { name: "Prepare clearing 1 item" }).click();
  await item.getByText("Exact resources", { exact: false }).waitFor();
  await item.getByText(`work:${hudIds.spike}`).waitFor();
  await item.getByRole("region", { name: "hud plan journal_bodies" }).getByText("Worker-captured Work context", { exact: false }).waitFor();
  await shot("hud-plan-preview", item);
  await item.getByRole("button", { name: "Clear these journals" }).click();
  await completed(item).waitFor();
  await timeline.getByText("Journal bodies, references and edit values cleared").waitFor();
  assert.ok(!(await timeline.innerText()).includes("secret-body"), "the cleared body is gone from the reader and replaced by a marker");
  await timeline.getByText("Content cleared", { exact: false }).first().waitFor();
  await item.getByText("Spike objective body").waitFor();
  assert.equal((await hudCall("work_get", { id: hudIds.spike })).objective, "Spike objective body", "journal-only clearing keeps the current item");
  await shot("hud-journal-cleared", timeline);
  await item.getByRole("button", { name: "Close receipt" }).click();

  // A tombstone alone is refused until its children are cleared or selected together; a Worker admission still blocks the subtree.
  await pick(hudIds.epic, "Ship maintenance");
  await item.getByText("Epic objective body").waitFor();
  await openMaintenance(item);
  await item.getByRole("radio", { name: "Item and journal (permanent tombstone)" }).check();
  await item.getByText("A tombstone needs them cleared first or selected together.", { exact: false }).waitFor();
  await item.getByRole("button", { name: "Prepare clearing 1 item" }).click();
  await item.getByText(/Clear child .* first or explicitly select it in this batch/).first().waitFor();
  assert.equal(await item.getByRole("button", { name: "Tombstone these items" }).isDisabled(), true, "a blocked plan cannot apply");
  await shot("hud-plan-blocked", item);
  await item.getByRole("button", { name: "Discard plan" }).click();
  await item.getByRole("radio", { name: "This item and its subtree" }).check();
  await item.getByText("Selects 4 items: this item and its descendants.").waitFor();
  await item.getByRole("button", { name: "Prepare clearing 4 items" }).click();
  await item.getByText(`Close Worker ${hudWorker.id}; admission ${hudWorker.turn} holds Work ${hudIds.build}`).waitFor();
  assert.equal(await item.getByRole("button", { name: "Tombstone these items" }).isDisabled(), true);
  await shot("hud-subtree-blocked", item);
  // The Worker closes; a new plan is an explicit decision, and applying it tombstones exactly the subtree.
  hudWorker.open = false;
  await item.getByRole("button", { name: "Prepare a new plan" }).click();
  await item.getByText("Exact resources", { exact: false }).waitFor();
  assert.equal(await item.getByText("Blocked by").count(), 0);
  await item.getByRole("button", { name: "Tombstone these items" }).click();
  await completed(item).waitFor();
  await item.getByText("Cleared work.", { exact: false }).waitFor();
  await treeRow(hudIds.epic).getByText("Content cleared").waitFor();
  assert.equal(await item.getByRole("button", { name: "Edit title" }).count(), 0, "a tombstone can't be edited");
  const tombstone = await hudCall("work_get", { id: hudIds.epic });
  assert.equal(tombstone.title, "[cleared]");
  assert.equal(tombstone.state, "active", "semantic state is retained, and clearing never completes work");
  assert.equal((await hudCall("work_get", { id: hudIds.pilot })).title, "Pilot with a live Chat", "work outside the selection is untouched");
  await shot("hud-tombstoned", item);
  await item.getByRole("button", { name: "Close receipt" }).click();

  // Live Chat focus blocks a plan; the control never pre-filters or clears it.
  await pick(hudIds.pilot, "Pilot with a live Chat");
  await item.getByText("Pilot objective body").waitFor();
  await openMaintenance(item);
  await item.getByRole("radio", { name: "Journal bodies" }).check();
  await item.getByRole("button", { name: "Prepare clearing 1 item" }).click();
  await item.getByText("Clear live Chat focus bot-1/main-bot-1 before Work maintenance").waitFor();
  await item.getByRole("button", { name: "Discard plan" }).click();

  // Proc: only a removed schedule offers redaction; the owner's plan refuses a Brain-protected one.
  await go("proc");
  const schedules = page.locator('[data-window="proc-schedules"]');
  const detail = page.locator('[data-window="proc-schedule"]');
  await schedules.getByRole("button", { name: /^Removed/ }).click();
  const scheduleRow = (id) => schedules.locator(`[data-schedule="${id}"]`);
  await scheduleRow(procIds.removed).click();
  await detail.getByText("s3cret-arg").waitFor();
  await openMaintenance(detail);
  await detail.getByText("a digest of the original definition stay", { exact: false }).waitFor();
  await detail.getByRole("button", { name: "Prepare redaction" }).click();
  await detail.getByText("Exact resources", { exact: false }).waitFor();
  await detail.getByText("Captured execution actions, results, argv summaries and output are independent selections", { exact: false }).waitFor();
  await shot("proc-plan-preview", detail);
  await detail.getByRole("button", { name: "Redact this definition" }).click();
  await completed(detail).waitFor();
  await detail.getByText("Arguments, environment and working directory cleared", { exact: false }).waitFor();
  await detail.getByText("Redacted", { exact: false }).first().waitFor();
  const digestRow = detail.locator("dt", { hasText: "Spec digest" });
  await digestRow.waitFor();
  assert.ok(!(await detail.innerText()).includes("s3cret"), "redacted arguments and environment are gone from the reader");
  const redacted = await socketCall(socketPath("proc", env), "tools/call", { name: "proc_schedule_get", arguments: { id: procIds.removed, includeRemoved: true } });
  assert.deepEqual([redacted.action.process.args, redacted.action.process.env, redacted.label, Boolean(redacted.specDigest)], [[], undefined, "Nightly sync", true], "the label and digest stay");
  await shot("proc-redacted", detail);
  await detail.getByRole("button", { name: "Close receipt" }).click();
  await scheduleRow(procIds.brain).click();
  await detail.getByText("brain-input").waitFor({ state: "attached" }).catch(() => undefined);
  await openMaintenance(detail);
  await detail.getByRole("button", { name: "Prepare redaction" }).click();
  await detail.getByText("Protected Brain schedules remain Brain-controlled").waitFor();
  await shot("proc-protected-refused", detail);
  await detail.getByRole("button", { name: "Cancel" }).click();

  // An unknown receipt left by an earlier session returns after a reload, inside a disclosure that opens itself.
  // A persisted schedule selection renders "Reading schedule…" on the client where the server rendered "Choose a schedule" (an
  // existing Proc hydration difference this change does not touch), so keep only the recovery slots across this load.
  await page.evaluate(([key, input]) => {
    for (const name of Object.keys(localStorage)) if (!name.startsWith("stack.state-flow.")) localStorage.removeItem(name);
    localStorage.setItem(key, JSON.stringify({ input, at: Date.now() }));
  }, [`stack.state-flow.proc:schedule_definition:${procIds.unknown}`, unknownInput]);
  await go("proc");
  await schedules.getByRole("button", { name: /^Removed/ }).click();
  await scheduleRow(procIds.unknown).click();
  await detail.getByText("Unknown. The owner cannot say what happened.", { exact: false }).waitFor();
  await detail.getByText("Fixture: the owner cannot say whether the redaction ran").waitFor();
  assert.equal(await detail.locator("details[open]").count(), 1, "the retained receipt is never hidden behind a closed disclosure");
  await shot("proc-unknown-recovered", detail);
  // An active schedule has no maintenance: removal comes first and is a separate decision.
  await schedules.getByRole("button", { name: /^Off/ }).click();
  await scheduleRow(procIds.active).click();
  await detail.getByText("Still scheduled").first().waitFor();
  assert.equal(await maintenance(detail).count(), 0);

  // Lab Infer catalog: a direct, memory-only eviction with an inline two-step confirm; nothing rediscovers by itself.
  await go("lab");
  const inference = page.locator('[data-window="inference"]');
  await inference.getByLabel("Account", { exact: true }).selectOption({ index: 1 });
  await inference.getByText("1 model", { exact: false }).waitFor();
  assert.deepEqual(inferCatalog.discoveries, [], "a cached catalog is not discovered again");
  await openMaintenance(inference);
  assert.equal(await inference.getByRole("button", { name: "Clear model catalog…" }).isDisabled(), true, "the scope is explicit");
  await inference.getByRole("radio", { name: /^This account/ }).check();
  await inference.getByRole("button", { name: "Clear model catalog…" }).click();
  await inference.getByRole("group", { name: "Confirm clearing the model catalog" }).waitFor();
  assert.deepEqual(inferCatalog.clears, [], "the first step clears nothing");
  await shot("infer-catalog-confirm", inference);
  await inference.getByRole("button", { name: "Clear catalog" }).press("Enter"); // the bench chrome overlaps the window's lower edge
  await inference.getByText("Cleared model observations for 1 account.", { exact: false }).waitFor();
  assert.deepEqual(inferCatalog.clears, [{ accountIds: [inferAccounts[0]] }]);
  assert.equal(inferCatalog.observed.has(inferAccounts[1]), true, "the other account's catalog stays");
  await inference.getByText("Model catalog cleared. Nothing is discovered until you choose Discover models.").waitFor();
  // Re-selecting accounts after a clear never discovers; only the explicit control does.
  await inference.getByLabel("Account", { exact: true }).selectOption({ index: 2 });
  await inference.getByLabel("Account", { exact: true }).selectOption({ index: 1 });
  await wait(400);
  assert.deepEqual(inferCatalog.discoveries, [], "no discovery after a clear, even on re-selection");
  await shot("infer-catalog-cleared", inference);
  await inference.getByRole("button", { name: "Discover models", exact: true }).click();
  await inference.getByText("1 model", { exact: false }).waitFor();
  assert.deepEqual(inferCatalog.discoveries, [inferAccounts[0]], "the explicit control discovers exactly once");
  await inference.getByRole("button", { name: "Dismiss" }).click();
  await inference.getByRole("radio", { name: /^All accounts/ }).check();
  await inference.getByRole("button", { name: "Clear model catalog…" }).click();
  await inference.getByRole("button", { name: "Clear catalog" }).press("Enter"); // the bench chrome overlaps the window's lower edge
  await inference.getByText("Cleared model observations for 2 accounts.", { exact: false }).waitFor();
  assert.deepEqual(inferCatalog.clears.at(-1), {}, "all accounts omit the account list");
  assert.equal(inferCatalog.observed.size, 0);

  // Narrow and dark renderings of the new controls.
  await go("");
  await pick(hudIds.pilot, "Pilot with a live Chat");
  await openMaintenance(item);
  await item.getByRole("radio", { name: "Item and journal (permanent tombstone)" }).check();
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("hud-maintenance-dark", item);
  await page.emulateMedia({ colorScheme: "light" });
  // Narrow: resize the window by its grip; the maintenance copy and radios reflow without horizontal overflow.
  const narrow = async (scope, name) => {
    const grip = scope.locator('span[title^="Resize"]').first();
    const edge = await grip.boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge.x - 150, edge.y + edge.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.ok((await scope.boundingBox()).width < 400, `${name} resized narrow`);
    assert.ok(await scope.locator("[data-scroll]").evaluate((body) => body.scrollWidth <= body.clientWidth), `${name} has no horizontal overflow`);
    await shot(`${name}-narrow`, scope);
  };
  await narrow(item, "hud-maintenance");
  await page.evaluate(() => { for (const name of Object.keys(localStorage)) if (!name.startsWith("stack.state-flow.")) localStorage.removeItem(name); });
  await go("proc");
  await schedules.getByRole("button", { name: /^Removed/ }).click();
  await scheduleRow(procIds.unknown).click();
  await narrow(detail, "proc-maintenance");

  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "HUD journal-body plan with retained copies, explicit scope, tombstone refused until children are selected, Worker and live-Chat blockers shown by the plan, subtree tombstone with markers and read-only item, Proc removed-schedule redaction with digest and cleared markers, protected schedule refused by the plan, unknown receipt recovered after reload in a self-opening disclosure, active schedule offers no maintenance, Lab catalog clear with scope choice, inline confirm and count and no implicit rediscovery, dark and narrow; owner gaps and links; Xcom pause observed until drained, explicit reimport/author choices, exact post removal; Signal pause required, draining read blocks, replan and whole-scope clear advancing generation; correlated Infer clear as separate selection; Lab running and cleared requests unselectable, lost response recovered from same receipt; Inbox real notify clear keeps outcome and open record; Content stage revision refusal, referenced blob unselectable, partial receipt kept uncertain" }, null, 2));
} catch (error) {
  failed = true;
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
  if (log) console.error(log.slice(-3000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all(sockets.map((socket) => socket.close()));
  await notify?.close();
  await hud?.close();
  await proc?.close();
  procSeed.db.close();
  for (const item of [signal, infer, content, xcom]) item.owner.journal.close();
  if (!(failed && evidence.startsWith(dir))) await rm(dir, { recursive: true, force: true });
}
