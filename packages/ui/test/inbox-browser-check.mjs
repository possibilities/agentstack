// Optional rendered check of the Inbox space after pnpm test and a ui build. The real notify API runs
// against a disposable state directory; server, Bots and discovery are fixtures. No live server.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/inbox-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as notifyApi } from "../../notify/dist/api.js";
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
let websocket, next, browser, notify;
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
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["bots", ["bot_list", "bot_defaults_get", "voice_status"], botsApi.events.topics], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixture(names),
      events: { topics, scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  const origin = `http://127.0.0.1:${nextPort}`;
  const plain = await call("notification_send", { title: "Brain ingestion stranded", message: "2 submitted links **never** became searchable.", source: "stack.brain.doctor", open: `${origin}/lab` });
  const question = await call("notification_send", { title: "Merge the release branch?", subtitle: "All checks passed", message: "The branch is ready. Choose one.", source: "ci", actions: ["Ship", "Hold"] });
  const prompt = await call("notification_send", { title: "Name the new Bot", message: "It needs a short name.", source: "ci", reply: "A short name" });
  const progress = await call("notification_send", { title: "Deploy", message: "25%", source: "ci", group: "deploy:web" });
  const done = await call("notification_send", { title: "Deploy finished", message: "100%", source: "ci", group: "deploy:web" });

  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
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

  assert.deepEqual(errors, []);
  console.log(`inbox browser check passed; evidence in ${evidence}`);
} finally {
  await browser?.close();
  next?.kill();
  await websocket?.close();
  for (const socket of sockets) await socket.close();
  await notify?.close();
  if (!process.env.INBOX_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
