// Optional rendered check of the Inbox space after pnpm test and a uix build. The real notify API runs
// against a disposable state directory; owner, Bots and discovery are fixtures. No live owner.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/inbox-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@agentstack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as notifyApi } from "../../notify/dist/api.js";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const uix = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(uix));
// Unix socket paths are short; keep the state directory near the root of the temporary tree.
const dir = await mkdtemp(join("/tmp", "as-inbox-ui-"));
const evidence = process.env.INBOX_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const handlers = {
  owner_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uixUrl: null, inspectorUrl: null }),
  bot_list: () => ({ bots: [] }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
};
// The gateway lists fixture schemas, so they must be real zod schemas; uix itself has no zod dependency.
const { z } = await import(pathToFileURL(createRequire(join(root, "packages", "api", "package.json")).resolve("zod")).href);
const fixture = (names) => names.map((name) => ({ name, description: name, input: z.looseObject({}), output: z.any(), async call() { return handlers[name](); } }));
async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
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
  // The gateway admits a connection only when every package it configures is live, so it sees the served ones alone.
  const gateway = join(dir, "gateway");
  for (const name of ["notify", "owner", "bots", "api"]) {
    await mkdir(join(gateway, "packages", name), { recursive: true });
    await copyFile(join(root, "packages", name, "api.yaml"), join(gateway, "packages", name, "api.yaml"));
  }
  websocket = await serveWebSocket({ env, root: gateway, port: 0 });
  const doc = (name, api) => ({ name, packageName: `@agentstack/${name}`, description: `${name} fixture`, events: api?.events?.topics ?? {}, eventScope: null,
    transports: [{ type: "websocket", description: "Isolated fixture", supported: true, subscriptions: true, endpoint: websocket.url }],
    operations: (api?.operations ?? []).map((operation) => ({ name: operation.name, title: operation.annotations?.title ?? null, description: operation.description,
      annotations: operation.annotations ?? {}, inputSchema: publishedJsonSchema(operation.input), outputSchema: publishedJsonSchema(operation.output) })) });
  const catalog = [doc("notify", notifyApi), doc("bots", botsApi), doc("owner"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names, topics] of [["owner", ["owner_status"], { pids_changed: "Fixture" }], ["bots", ["bot_list", "bot_defaults_get", "voice_status"], botsApi.events.topics], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixture(names),
      events: { topics, scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
  }
  const nextPort = await port();
  const origin = `http://127.0.0.1:${nextPort}`;
  const plain = await call("notification_send", { title: "Brain ingestion stranded", message: "2 submitted links **never** became searchable.", source: "agentstack.brain.doctor", open: `${origin}/x/lab` });
  const question = await call("notification_send", { title: "Merge the release branch?", subtitle: "All checks passed", message: "The branch is ready. Choose one.", source: "ci", actions: ["Ship", "Hold"] });
  const prompt = await call("notification_send", { title: "Name the new Bot", message: "It needs a short name.", source: "ci", reply: "A short name" });
  const progress = await call("notification_send", { title: "Deploy", message: "25%", source: "ci", group: "deploy:web" });
  const done = await call("notification_send", { title: "Deploy finished", message: "100%", source: "ci", group: "deploy:web" });

  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: uix, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/x/inbox`);
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
  assert.equal(new URL(popup.url()).pathname, "/x/lab");
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
