// Optional rendered check of owner maintenance in existing spaces after pnpm test (and a ui build, or NEXT_MODE=dev):
// Signal captured content, correlated and Lab Infer payloads, Inbox dismissed content, Content storage, Xcom in
// System and the System State owner links. The real notify API runs on a disposable state directory; Signal, Infer,
// Content and Xcom are fixture sockets whose plans, applies and receipts go through the real StateJournal.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/domain-state-browser-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath, StateJournal } from "@stack/api";
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
  infer_model_list: () => ({ accounts: [] }),
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
let websocket, next, browser, notify;
let log = "";
let failed = false;
try {
  notify = await serveApi({ name: "notify", transport: "socket", env, root });
  const notifyCall = (name, args = {}) => socketCall(socketPath("notify", env), "tools/call", { name, arguments: args });
  const names = ["serve", "api", "notify", "signal", "infer", "content", "xcom"];
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
  await socketFor("infer", ["infer_request_list", "infer_model_list", "infer_history_plan", "infer_history_clear", "infer_state_receipt_get"]);
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
  page.on("pageerror", (error) => errors.push(error.message));
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

  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "owner gaps and links; Xcom pause observed until drained, explicit reimport/author choices, exact post removal; Signal pause required, draining read blocks, replan and whole-scope clear advancing generation; correlated Infer clear as separate selection; Lab running and cleared requests unselectable, lost response recovered from same receipt; Inbox real notify clear keeps outcome and open record; Content stage revision refusal, referenced blob unselectable, partial receipt kept uncertain" }, null, 2));
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
  for (const item of [signal, infer, content, xcom]) item.owner.journal.close();
  if (!(failed && evidence.startsWith(dir))) await rm(dir, { recursive: true, force: true });
}
