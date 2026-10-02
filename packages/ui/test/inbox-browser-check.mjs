// Optional rendered check of the Inbox space after pnpm test and a ui build. The real notify API runs
// against a disposable state directory; server, Bots and discovery are fixtures. No live server.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/inbox-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as notifyApi } from "../../notify/dist/api.js";
import { AccessStore } from "../../access/dist/src/store.js";
import { startRemoteUi } from "../../access/dist/src/remote-ui.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
// Unix socket paths are short; keep the state directory near the root of the temporary tree.
const dir = await mkdtemp(join("/tmp", "as-inbox-ui-"));
const evidence = process.env.INBOX_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const handlers = {
  serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  bot_list: () => ({ bots: [] }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
};
const fixture = (names) => fixtureOperations(names, handlers);
const sockets = [];
let websocket, next, browser, notify, remoteUi, accessStore;
let log = "";
const call = (name, args = {}) => socketCall(socketPath("notify", env), "tools/call", { name, arguments: args });
const settle = async (id, check) => {
  let record = await call("notification_get", { id });
  for (let attempt = 0; !check(record) && attempt < 60; attempt++) { await new Promise((resolve) => setTimeout(resolve, 50)); record = await call("notification_get", { id }); }
  assert.ok(check(record), JSON.stringify(record));
  return record;
};

try {
  notify = await serveApi({ name: "notify", transport: "socket", env, root });
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["notify", "serve", "bots", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("notify", notifyApi), doc("bots", botsApi), doc("serve"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["bots", botsApi.operations.map(operation => operation.name), botsApi.events.topics], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixture(names),
      events: { topics, scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  const origin = `http://127.0.0.1:${nextPort}`;
  env.STACK_UI_PORT = String(nextPort);
  const plain = await call("notification_send", { title: "Brain ingestion stranded", message: "2 submitted links **never** became searchable.", source: "stack.brain.doctor", open: `${origin}/lab` });
  const question = await call("notification_send", { title: "Merge the release branch?", subtitle: "All checks passed", message: "The branch is ready. Choose one.", source: "ci", actions: ["Ship", "Hold"] });
  const prompt = await call("notification_send", { title: "Name the new Bot", message: "It needs a short name.", source: "ci", reply: "A short name" });
  const progress = await call("notification_send", { title: "Deploy", message: "25%", source: "ci", group: "deploy:web" });
  const done = await call("notification_send", { title: "Deploy finished", message: "100%", source: "ci", group: "deploy:web" });

  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log = (log + chunk).slice(-12_000); }); next.stderr.on("data", (chunk) => { log = (log + chunk).slice(-12_000); });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log.split("\n").slice(-40).join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  // Drop an actual send response after the real owner has committed, not a mocked send result.
  const sends = [];
  let loseNextAck = false;
  await page.routeWebSocket(/\/websocket/, socket => {
    const server = socket.connectToServer();
    let lostId = null;
    socket.onMessage(message => {
      const request = JSON.parse(String(message));
      if (request.method === "tools/call" && request.params?.package === "notify" && request.params.name === "notification_send") {
        sends.push(request.params.arguments);
        if (loseNextAck) { lostId = request.id; loseNextAck = false; }
      }
      server.send(message);
    });
    server.onMessage(message => {
      const response = JSON.parse(String(message));
      if (lostId !== null && response.id === lostId) { lostId = null; socket.close(); server.close(); return; }
      socket.send(message);
    });
  });
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/inbox`);
  const inbox = page.locator('[data-window="notify-inbox"]');
  const detail = page.locator('[data-window="notify-detail"]');
  const row = (title) => inbox.locator("[data-notification]").filter({ hasText: title });
  await row("Merge the release branch?").waitFor();
  await detail.getByText("Choose a notification", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Spaces · Inbox" }).waitFor();
  // Four are open: the earlier Deploy notice was replaced by its group.
  assert.equal((await inbox.locator("h2").textContent()).replace(/\s+/g, ""), "Inbox4");
  assert.equal(await row("Deploy").count(), 1, "the replaced notice is not open");
  await row("Merge the release branch?").getByText("Question", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "inbox-open.png"), animations: "disabled" });

  // Choosing shows it without dismissing it; an action answers and dismisses once.
  await row("Merge the release branch?").click();
  await detail.getByText("The branch is ready. Choose one.", { exact: true }).waitFor();
  assert.equal((await call("notification_get", { id: question.id })).dismissedAt, null, "selection never dismisses");
  await page.screenshot({ path: join(evidence, "inbox-question.png"), animations: "disabled" });
  await detail.getByRole("button", { name: "Ship", exact: true }).click();
  await settle(question.id, (record) => record.outcome === "action" && record.response === "Ship");
  await detail.getByText("Chose “Ship”", { exact: true }).waitFor();
  await row("Merge the release branch?").waitFor({ state: "detached" });

  // A reply is sent with ⌘Enter and shown back.
  await row("Name the new Bot").click();
  const reply = detail.getByPlaceholder("A short name");
  await reply.fill("Atlas");
  await reply.press("Meta+Enter");
  await settle(prompt.id, (record) => record.outcome === "replied" && record.response === "Atlas");
  await detail.getByText("Replied", { exact: true }).waitFor();
  await detail.getByText("Atlas", { exact: true }).waitFor();

  // Opening the link opens it and records the click-through.
  await row("Brain ingestion stranded").click();
  await detail.locator("strong", { hasText: "never" }).waitFor();
  const [popup] = await Promise.all([context.waitForEvent("page"), detail.getByRole("link", { name: "Open link" }).click()]);
  await popup.waitForLoadState();
  assert.equal(new URL(popup.url()).pathname, "/lab");
  await popup.close();
  await settle(plain.id, (record) => record.outcome === "opened");

  // Arrow keys move the selection; D dismisses the focused row as closed.
  const later = await call("notification_send", { title: "Backup complete", message: "Nightly backup finished.", source: "backup" });
  await row("Backup complete").waitFor();
  await row("Backup complete").focus();
  await page.keyboard.press("ArrowDown");
  await detail.getByText("100%", { exact: true }).waitFor();
  await page.keyboard.press("d");
  await settle(done.id, (record) => record.outcome === "closed");

  // Dismissed shows outcomes; the replaced notice explains itself.
  await inbox.getByRole("radio", { name: "Dismissed" }).or(inbox.getByRole("button", { name: "Dismissed", exact: true })).click();
  await row("Deploy").filter({ hasText: "25%" }).click();
  await detail.getByText("A newer notification in its group took its place.", { exact: true }).waitFor();
  assert.equal((await call("notification_get", { id: progress.id })).outcome, "replaced");
  await page.screenshot({ path: join(evidence, "inbox-dismissed.png"), animations: "disabled" });

  // The title inspects the record, and the inspector hands back to the Inbox.
  await detail.getByRole("button", { name: "Inspect Notification" }).click();
  await page.getByRole("button", { name: "Open in Inbox" }).waitFor();
  await page.keyboard.press("Escape");

  // Dismiss all asks first, then closes every open notification.
  await inbox.getByRole("radio", { name: "Open" }).or(inbox.getByRole("button", { name: "Open", exact: true })).click();
  await row("Backup complete").waitFor();
  await inbox.getByRole("button", { name: "Dismiss all…" }).click();
  await page.getByRole("alertdialog").getByText("Dismiss 1 open notification?", { exact: true }).waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "Dismiss all" }).click();
  await settle(later.id, (record) => record.outcome === "closed");
  await inbox.getByText("No open notifications", { exact: true }).waitFor();
  assert.equal((await call("notification_counts")).open, 0);
  await page.screenshot({ path: join(evidence, "inbox-empty.png"), animations: "disabled" });

  // ⌘K finds loaded notifications.
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder("Jump to a bot, account, operation…").fill("release branch");
  await page.getByRole("option", { name: /Merge the release branch\?/ }).waitFor();
  await page.keyboard.press("Escape");

  // Compose is reached by the header action. A UUID exists on the first edit and survives reload.
  const compose = page.locator('[data-window="notify-compose"]');
  const revealCompose = async () => {
    await page.goto(`${origin}/inbox?focus=notification-compose`);
    await compose.getByLabel("Title", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-window="notify-compose"] input')?.disabled);
  };
  const savedDraft = () => page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith("stack.uix.notify-compose.v1."));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  });
  const storedRecord = async () => { const draft = await savedDraft(); return call("notification_get", { id: draft.id }); };
  const nextDraft = async () => { await revealComposeSent(); await compose.getByRole("button", { name: "New notification", exact: true }).focus(); await page.keyboard.press("Enter"); };
  const revealComposeSent = async () => {
    await page.goto(`${origin}/inbox?focus=notification-compose`);
    await compose.getByText("Sent — stored", { exact: true }).waitFor();
  };
  const kind = name => compose.getByRole("radio", { name, exact: true }).or(compose.getByRole("button", { name, exact: true }));
  const send = async () => { await compose.getByRole("button", { name: "Send notification", exact: true }).focus(); await page.keyboard.press("Enter"); await compose.getByText("Sent — stored", { exact: true }).waitFor(); };
  await inbox.getByRole("button", { name: "New notification", exact: true }).click();
  await compose.getByLabel("Title", { exact: true }).fill("Operator notice");
  const firstDraft = await savedDraft();
  assert.match(firstDraft.id, /^[0-9a-f-]{36}$/);
  await compose.getByLabel("Message", { exact: true }).fill("A stored notice is not approval.");
  await revealCompose();
  assert.equal((await savedDraft()).id, firstDraft.id);
  assert.equal(await compose.getByLabel("Message", { exact: true }).inputValue(), "A stored notice is not approval.");
  await send();
  const notice = await storedRecord();
  assert.deepEqual(notice.actions, []); assert.equal(notice.reply, null); assert.equal(notice.dismissedAt, null);
  await detail.getByText("A stored notice is not approval.", { exact: true }).waitFor();

  // Question choices are schema-bounded and unique; optional content is sent only when declared.
  await nextDraft();
  await compose.getByLabel("Title", { exact: true }).fill("Operator question");
  await compose.getByLabel("Message", { exact: true }).fill("Choose deliberately.");
  await kind("Question").click();
  await compose.getByLabel("Choice 1", { exact: true }).fill("Proceed");
  await compose.getByRole("button", { name: "Add choice", exact: true }).click();
  await compose.getByLabel("Choice 2", { exact: true }).fill("Proceed");
  await compose.getByRole("button", { name: "Send notification", exact: true }).focus(); await page.keyboard.press("Enter");
  await compose.getByText("Answer choices must be unique.", { exact: true }).waitFor();
  const beforeChoices = sends.length;
  await compose.getByLabel("Choice 2", { exact: true }).fill("Wait");
  for (let index = 3; index <= 8; index++) {
    await compose.getByRole("button", { name: "Add choice", exact: true }).click();
    await compose.getByLabel(`Choice ${index}`, { exact: true }).fill(`Option ${index}`);
  }
  assert.equal(await compose.getByRole("button", { name: "Add choice", exact: true }).isDisabled(), true);
  for (let index = 8; index >= 3; index--) await compose.getByRole("button", { name: `Remove choice ${index}`, exact: true }).click();
  await compose.getByLabel("Subtitle (optional)", { exact: true }).fill("Operator-authored");
  await compose.getByLabel("Source (optional)", { exact: true }).fill("operator");
  await compose.getByLabel("Open URL (optional)", { exact: true }).fill(`${origin}/inbox`);
  await send();
  assert.equal(sends.length, beforeChoices + 1, "invalid choices never dispatch");
  const sentQuestion = await storedRecord();
  assert.deepEqual(sentQuestion.actions, ["Proceed", "Wait"]); assert.equal(sentQuestion.reply, null);
  assert.equal(sentQuestion.source, "operator"); assert.equal(sentQuestion.subtitle, "Operator-authored"); assert.equal(sentQuestion.open, `${origin}/inbox`);

  await nextDraft();
  await compose.getByLabel("Title", { exact: true }).fill("Operator reply prompt");
  await compose.getByLabel("Message", { exact: true }).fill("What should we name it?");
  await kind("Reply prompt").click();
  await compose.getByLabel("Reply placeholder", { exact: true }).fill("A short name");
  await send();
  const sentPrompt = await storedRecord();
  assert.equal(sentPrompt.reply, "A short name"); assert.deepEqual(sentPrompt.actions, []);

  // Group replacement is disclosed before sending and is not an answer. Capture the actual form in each appearance.
  await nextDraft();
  await compose.getByLabel("Title", { exact: true }).fill("Release decision");
  await compose.getByLabel("Message", { exact: true }).fill("Ready for an explicit choice. Storing this prompt does not approve the release.");
  await kind("Question").click();
  await compose.getByLabel("Choice 1", { exact: true }).fill("Release");
  await compose.getByRole("button", { name: "Add choice", exact: true }).click();
  await compose.getByLabel("Choice 2", { exact: true }).fill("Hold");
  await compose.getByLabel("Group (optional)", { exact: true }).fill("operator:release");
  await compose.getByText(/Sending with this group replaces its open predecessor/).waitFor();
  await compose.getByText(/No Bot watch \(operator send\)/).waitFor();
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(evidence, "compose-light.png"), animations: "disabled" });
  await compose.screenshot({ path: join(evidence, "compose-form-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "compose-dark.png"), animations: "disabled" });
  await compose.screenshot({ path: join(evidence, "compose-form-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, "compose-narrow.png"), animations: "disabled" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "narrow page has no horizontal overflow");
  await page.setViewportSize({ width: 1400, height: 1000 });
  await send();
  const predecessor = await storedRecord();
  await nextDraft();
  await compose.getByLabel("Title", { exact: true }).fill("Replacement notice");
  await compose.getByLabel("Message", { exact: true }).fill("New status, not an answer.");
  await compose.getByLabel("Group (optional)", { exact: true }).fill("operator:release");
  await send();
  assert.equal((await call("notification_get", { id: predecessor.id })).outcome, "replaced");
  assert.equal((await call("notification_get", { id: predecessor.id })).response, null);

  // An acknowledgement lost AFTER storage freezes every field. Reload keeps the exact same ID and input.
  await nextDraft();
  await compose.getByLabel("Title", { exact: true }).fill("Lost acknowledgement");
  await compose.getByLabel("Message", { exact: true }).fill("Retry this exact intent.");
  await compose.getByLabel("Group (optional)", { exact: true }).fill("operator:uncertain");
  const unknownId = (await savedDraft()).id;
  loseNextAck = true;
  await compose.getByRole("button", { name: "Send notification", exact: true }).focus(); await page.keyboard.press("Enter");
  await compose.getByText("Send outcome uncertain", { exact: true }).waitFor();
  assert.equal((await call("notification_get", { id: unknownId })).title, "Lost acknowledgement");
  const originalInput = sends.at(-1);
  const newer = await call("notification_send", { title: "Newer uncertain status", message: "Do not replace me on retry.", group: "operator:uncertain" });
  assert.equal(await compose.getByLabel("Title", { exact: true }).isDisabled(), true);
  assert.equal(await kind("Reply prompt").isDisabled(), true);
  const beforeReload = sends.length;
  await page.goto(`${origin}/inbox?focus=notification-compose`);
  await compose.getByText("Send outcome uncertain", { exact: true }).waitFor();
  assert.equal(sends.length, beforeReload, "reload never auto-retries");
  assert.equal((await savedDraft()).id, unknownId);
  assert.deepEqual((await savedDraft()).input, originalInput);
  await compose.getByRole("button", { name: "Retry identical send", exact: true }).focus(); await page.keyboard.press("Enter");
  await compose.getByText("Sent — stored", { exact: true }).waitFor();
  assert.deepEqual(sends.at(-1), originalInput);
  assert.equal((await call("notification_list", { limit: 25 })).entries.filter(item => item.id === unknownId).length, 1);
  assert.equal((await call("notification_get", { id: unknownId })).outcome, "replaced");
  assert.equal((await call("notification_get", { id: newer.id })).dismissedAt, null, "an identical ID retry never replaces a newer group member");

  // Changing uncertain intent requires the explicit discard dialog; cancelling it keeps the old retry key.
  await nextDraft();
  await compose.getByLabel("Title", { exact: true }).fill("Uncertain to discard");
  await compose.getByLabel("Message", { exact: true }).fill("This may already exist.");
  loseNextAck = true;
  await compose.getByRole("button", { name: "Send notification", exact: true }).focus(); await page.keyboard.press("Enter");
  await compose.getByText("Send outcome uncertain", { exact: true }).waitFor();
  const discardedId = (await savedDraft()).id;
  await compose.getByRole("button", { name: "Discard draft…", exact: true }).click();
  const discardDialog = page.getByRole("alertdialog");
  await discardDialog.getByText("Discard uncertain draft?", { exact: true }).waitFor();
  await discardDialog.getByRole("button", { name: "Keep draft", exact: true }).click();
  assert.equal((await savedDraft()).id, discardedId);
  assert.equal(await compose.getByLabel("Message", { exact: true }).isDisabled(), true);
  await compose.getByRole("button", { name: "Discard draft…", exact: true }).click();
  await discardDialog.getByRole("button", { name: "Discard draft", exact: true }).click();
  await compose.getByLabel("Title", { exact: true }).fill("Changed intent");
  await compose.getByLabel("Message", { exact: true }).fill("Only after explicit discard.");
  assert.notEqual((await savedDraft()).id, discardedId);
  assert.equal((await call("notification_get", { id: discardedId })).dismissedAt, null, "discard cannot recall or dismiss the stored notification");
  await send();
  assert.ok(sends.every(input => !("subscribe" in input)), "all operator sends omit subscription");

  // The schema/exposure is live: removing send hides the header action and prevents a draft from dispatching.
  const notifyDoc = catalog.find(doc => doc.name === "notify");
  const exposedOperations = notifyDoc.transports[0].operations;
  notifyDoc.transports[0].operations = exposedOperations.filter(name => name !== "notification_send");
  await page.goto(`${origin}/inbox?focus=notification-compose`);
  await compose.getByText("Notification sending is not exposed on this server’s WebSocket.", { exact: true }).waitFor();
  assert.equal(await inbox.getByRole("button", { name: "New notification", exact: true }).count(), 0);
  assert.equal(await compose.getByRole("button", { name: "Send notification", exact: true }).count(), 0);
  notifyDoc.transports[0].operations = exposedOperations;

  // Draft persistence is a send precondition, not optional arrangement storage. No write when storage fails.
  const slotKey = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith("stack.uix.notify-compose.v1.")));
  await nextDraft();
  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("stack.uix.notify-compose.v1.")) throw new Error("fixture storage failure"); return window.originalSetItem.call(this, key, value); };
  });
  await compose.getByLabel("Title", { exact: true }).fill("Unpersisted intent");
  await compose.getByLabel("Message", { exact: true }).fill("Must not dispatch.");
  const beforeStorageFailure = sends.length;
  await compose.getByRole("button", { name: "Send notification", exact: true }).focus(); await page.keyboard.press("Enter");
  await compose.getByText("fixture storage failure", { exact: true }).waitFor();
  assert.equal(sends.length, beforeStorageFailure);
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem; });

  // A damaged recovery slot cannot silently allocate a fresh intent; explicit discard is still required.
  await page.evaluate(key => localStorage.setItem(key, "{broken"), slotKey);
  await page.goto(`${origin}/inbox?focus=notification-compose`);
  await compose.locator('[data-slot="alert-description"]').waitFor();
  assert.equal(await compose.getByLabel("Title", { exact: true }).isDisabled(), true);
  assert.equal(await compose.getByRole("button", { name: "Send notification", exact: true }).isDisabled(), true);
  assert.equal(sends.length, beforeStorageFailure);
  await compose.getByRole("button", { name: "Discard draft…", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard draft", exact: true }).click();
  assert.equal(await compose.getByLabel("Title", { exact: true }).isEnabled(), true);

  // Exercise actual Access-authenticated remote discovery and scope, not a guessed local-only flag.
  const remotePort = await port();
  const remoteOrigin = `https://127.0.0.1:${remotePort}`;
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  accessStore = new AccessStore(dir);
  remoteUi = await startRemoteUi({ store: accessStore, env: { ...env, STACK_ACCESS_UI_ORIGIN: remoteOrigin }, host: "127.0.0.1", port: remotePort,
    root: await gatewayRoot(dir, ["notify", "serve", "bots", "api"]), verify: async () => {} }, { key: await readFile(key), cert: await readFile(cert) });
  const secret = randomBytes(32).toString("base64url");
  const pairing = accessStore.pair({ requestId: randomUUID(), label: "Inbox fixture", kind: "browser", scopes: ["ui:view"], redemptionSecret: secret });
  accessStore.approve(pairing.id, pairing.code, true);
  const credential = accessStore.redeem(pairing.id, secret);
  const session = accessStore.startUi(credential.refreshToken, randomUUID());
  const remoteContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1000 } });
  await remoteContext.addCookies([{ name: "__Host-stack_ui", value: session.accessToken, url: remoteOrigin, secure: true, httpOnly: true, sameSite: "Strict" },
    { name: "__Host-stack_ui_refresh", value: session.refreshToken, url: remoteOrigin, secure: true, httpOnly: true, sameSite: "Strict" }]);
  const remotePage = await remoteContext.newPage(); remotePage.setDefaultTimeout(15_000);
  await remotePage.goto(`${remoteOrigin}/inbox`);
  await remotePage.locator('[data-remote-scope="view"]').waitFor();
  await remotePage.locator('[data-window="notify-inbox"] [data-notification]').first().waitFor();
  assert.equal(await remotePage.locator('[data-window="notify-compose"]').count(), 0, "view-only remote has no Compose");
  assert.equal(await remotePage.getByRole("button", { name: "New notification", exact: true }).count(), 0);
  const grant = accessStore.inventory().grants.find(item => item.client_id === credential.clientId);
  accessStore.updateGrant(grant.id, 1, ["ui:view", "ui:control"], []);
  await remotePage.locator('[data-remote-scope="control"]').waitFor();
  // The current Access control allowlist deliberately does not offer notification_send, even with control.
  // Do not expand remote backend authority as a side effect of this UI milestone.
  await remotePage.goto(`${remoteOrigin}/inbox?focus=notification-compose`);
  await remotePage.locator('[data-remote-scope="control"]').waitFor();
  await remotePage.locator('[data-window="notify-inbox"] [data-notification]').first().waitFor();
  assert.equal(await remotePage.locator('[data-window="notify-compose"]').count(), 0, "control without live send exposure has no Compose");
  assert.equal(await remotePage.getByRole("button", { name: "New notification", exact: true }).count(), 0);
  await remoteContext.close();

  assert.deepEqual(errors, []);
  console.log(`inbox browser check passed; evidence in ${evidence}`);
} finally {
  await browser?.close();
  next?.kill();
  await websocket?.close();
  await remoteUi?.close();
  accessStore?.close();
  for (const socket of sockets) await socket.close();
  await notify?.close();
  await rm(dir, { recursive: true, force: true });
}
