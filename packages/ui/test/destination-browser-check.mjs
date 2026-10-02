// Optional rendered check of Canvas destination isolation (ADR 0167) after pnpm test and a ui build. Platform roots are
// disposable state directories; each runs the real notify API behind fixture serve/bots/discovery sockets and its own
// `next start` on the SAME origin and port, one after another, so a single browser context shares one localStorage across them.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/destination-browser-check.mjs
// DESTINATION_EVIDENCE_DIR keeps a JSON inventory of the keys each phase left. CHROME_BIN may override local Chrome. No live server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as notifyApi } from "../../notify/dist/api.js";
import { destinationKey, fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture, seedRecovery } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const evidence = process.env.DESTINATION_EVIDENCE_DIR ?? await mkdtemp(join("/tmp", "di-evidence-"));
await mkdir(evidence, { recursive: true });

const idA = "7f3c1d52-9a64-4be1-8c0a-2d5e6f708192";
const idB = "0b9a4c1e-5d27-4f83-a1b6-93c70e2d8f45";
const nextPort = await port();
// Every platform keeps the same gateway endpoint too: Compose drafts are endpoint-pinned, so only the destination can separate them.
const gatewayPort = await port();
const origin = `http://127.0.0.1:${nextPort}`;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition, what) => { for (let attempt = 0; attempt < 200 && !condition(); attempt++) await settle(50); assert.ok(condition(), what); };

/** One platform root: its own state directory, real notify API, fixtures, and a Next server on the shared origin. */
async function startPlatform(label, serverId) {
  const dir = await mkdtemp(join("/tmp", `di-${label}-`));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir,
    NEXT_TELEMETRY_DISABLED: "1", STACK_WEBSOCKET_ORIGIN: origin, STACK_UI_PORT: String(nextPort) };
  const handlers = {
    serve_status: () => ({ serverId, pid: process.pid, startedAt: new Date().toISOString(), nodeVersion: process.version, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
    bot_list: () => ({ bots: [] }),
    bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
    voice_status: () => ({ call: null }),
  };
  const sockets = [];
  const notify = await serveApi({ name: "notify", transport: "socket", env, root });
  const websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["notify", "serve", "bots", "api"]), port: gatewayPort });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("notify", notifyApi), doc("bots", botsApi), doc("serve"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["bots", botsApi.operations.map((operation) => operation.name), botsApi.events.topics], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(name === "serve" ? serve.names : names, handlers),
      events: { topics, scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
  }
  const notification = await socketCall(socketPath("notify", env), "tools/call", { name: "notification_send", arguments: { title: `Notice from ${label}`, message: `Held by platform ${label}.`, source: "fixture" } });
  let log = "";
  const next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log = (log + chunk).slice(-12_000); }); next.stderr.on("data", (chunk) => { log = (log + chunk).slice(-12_000); });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 200 || next.exitCode !== null) throw new Error(log.split("\n").slice(-40).join("\n"));
    await settle(50);
  }
  return {
    label, env, notification,
    async stop() {
      if (next.exitCode === null) { const exited = once(next, "exit"); next.kill(); await exited; }
      await websocket.close();
      for (const socket of sockets) await socket.close();
      await notify.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
let platform = null;
try {
  // One context, one page: the same browser storage serves every platform that answers at this origin.
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydrat|did not match|#418|#423|#425/i.test(message.text())) problems.push(message.text()); });
  const receiptReads = [];
  await page.routeWebSocket(/\/websocket/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request.method === "tools/call" && request.params?.name === "notify_state_receipt_get") receiptReads.push(request.params.arguments.requestId);
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });

  const storage = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map((name) => [name, localStorage.getItem(name)])));
  const owned = (all, id) => Object.fromEntries(Object.entries(all).filter(([name]) => name.startsWith(destinationKey(origin, "", { serverId: id }))));
  const compose = page.locator('[data-window="notify-compose"]');
  const title = compose.getByLabel("Title", { exact: true });
  const pin = page.getByRole("button", { name: "Pin inspector", exact: true });
  const inboxWindow = page.locator('[data-window="notify-inbox"]');
  const point = () => inboxWindow.evaluate((element) => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y }));
  const open = async (current) => {
    await authorizeBrowser(page, origin, current.env);
    await page.goto(`${origin}/inbox?inspect=notification:${current.notification.id}`);
    await inboxWindow.waitFor();
    await inboxWindow.locator("[data-notification]").first().waitFor();
  };
  // The Inbox's payload-clearing flow keeps its request under `notify:history`; showing it shows whether a saved request was recovered.
  const showClearFlow = async () => {
    await inboxWindow.getByRole("radio", { name: "Dismissed" }).or(inboxWindow.getByRole("button", { name: "Dismissed", exact: true })).click();
    await inboxWindow.getByRole("button", { name: /^Select to clear content/ }).click();
  };
  const readSaved = async () => {
    await inboxWindow.getByText("Result not confirmed").waitFor();
    await inboxWindow.getByRole("button", { name: "Read receipt", exact: true }).click();
    await until(() => receiptReads.includes(requestA.requestId), "the saved request is read back by its own id");
    assert.ok(receiptReads.every((id) => id === requestA.requestId), `only the destination's own request is ever dispatched: ${receiptReads}`);
  };
  const leave = async () => { await page.goto("about:blank"); await platform.stop(); platform = null; };
  const requestA = { planId: randomUUID(), expectedRevision: "rev-a", requestId: randomUUID() };
  const legacyRequest = { planId: randomUUID(), expectedRevision: "rev-legacy", requestId: randomUUID() };
  const legacy = {
    "stack.state-flow.notify:history": JSON.stringify({ input: legacyRequest, at: 1 }), "stack.uix.bench.v1": JSON.stringify({ space: "inbox", layout: { positions: { "notify-inbox": { x: 7, y: 7 } }, manual: { "notify-inbox": true } } }),
    "stack.uix.inspector.v1": JSON.stringify({ pinned: true }), "stack.uix.docks.v1": JSON.stringify({ inspector: 900 }), "stack.worker-catalog-held.v1": JSON.stringify(["legacy"]),
  };
  const report = {};

  // ---- Platform A: arrange, pin, draft and leave an unconfirmed request; also seed unqualified legacy records ----
  platform = await startPlatform("a", idA);
  await open(platform);
  await title.waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-window="notify-compose"] input')?.disabled);
  const home = await point();
  await title.fill("Draft for A");
  await pin.click();
  assert.equal(await pin.getAttribute("aria-pressed"), "true");
  const header = await inboxWindow.locator("header").boundingBox();
  await page.mouse.move(header.x + 40, header.y + 20);
  await page.keyboard.down("Alt");
  await page.mouse.down(); await page.mouse.move(header.x + 130, header.y + 70, { steps: 4 }); await page.mouse.up();
  await page.keyboard.up("Alt");
  const moved = await point();
  assert.ok(Math.abs(moved.x - home.x) > 20, `the window moved ${JSON.stringify(home)} -> ${JSON.stringify(moved)}`);
  const prefixA = destinationKey(origin, "", { serverId: idA });
  await page.waitForFunction(([name, window]) => JSON.parse(localStorage.getItem(name) ?? "{}").layout?.manual?.[window] === true, [`${prefixA}uix.bench.v2.inbox`, "notify-inbox"]);
  await page.waitForFunction((name) => localStorage.getItem(name) !== null, `${prefixA}uix.inspector.v1`);
  await page.waitForFunction((prefix) => Object.keys(localStorage).some((name) => name.startsWith(`${prefix}uix.notify-compose.v1.`)), prefixA);
  await seedRecovery(page, origin, "notify:history", requestA, { serverId: idA });
  await page.evaluate((records) => { for (const [name, value] of Object.entries(records)) localStorage.setItem(name, value); }, legacy);
  await page.reload();
  await inboxWindow.waitFor();
  await showClearFlow();
  await readSaved();
  let all = await storage();
  assert.ok(Object.keys(all).every((name) => name.startsWith("stack.destination.") || name in legacy), `only namespaced keys (and the seeded legacy ones) exist: ${Object.keys(all)}`);
  const aKeys = Object.keys(owned(all, idA));
  for (const name of ["uix.bench.v2.inbox", "uix.inspector.v1", "state-flow.notify:history"]) assert.ok(aKeys.includes(`${prefixA}${name}`), `${name} is stored under A`);
  assert.ok(aKeys.some((name) => name.startsWith(`${prefixA}uix.notify-compose.v1.`)), "the Compose draft is stored under A");
  for (const [name, value] of Object.entries(legacy)) assert.equal(all[name], value, `${name} is untouched`);
  report.afterA = Object.keys(all);
  const snapshotA = owned(all, idA);
  assert.deepEqual(problems, [], "no hydration or page errors on platform A");
  await leave();

  // ---- Platform B: another root at the same origin sees none of it ----
  platform = await startPlatform("b", idB);
  receiptReads.length = 0;
  await open(platform);
  await title.waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-window="notify-compose"] input')?.disabled);
  await settle(1200);
  assert.equal(await title.inputValue(), "", "A's draft is not B's");
  assert.equal(await pin.getAttribute("aria-pressed"), "false", "A's inspector pin is not B's");
  assert.ok(Math.abs((await point()).x - home.x) < 2 && Math.abs((await point()).y - home.y) < 2, "A's bench arrangement is not B's");
  // Pin first: an unpinned inspector contracts on any other interaction with the bench.
  await pin.click();
  const prefixB = destinationKey(origin, "", { serverId: idB });
  await page.waitForFunction((name) => JSON.parse(localStorage.getItem(name) ?? "{}").pinned === true, `${prefixB}uix.inspector.v1`);
  await title.fill("Draft for B");
  await page.waitForFunction((prefix) => Object.keys(localStorage).some((name) => name.startsWith(`${prefix}uix.notify-compose.v1.`)), prefixB);
  await showClearFlow();
  await inboxWindow.getByRole("button", { name: /^Prepare clearing/ }).waitFor();
  assert.equal(await inboxWindow.getByText("Result not confirmed").count(), 0, "A's unconfirmed request is not B's");
  assert.deepEqual(receiptReads, [], "nothing stored for A or in legacy form is dispatched to B");
  all = await storage();
  assert.deepEqual(owned(all, idA), snapshotA, "B never read, wrote, merged or removed anything of A's");
  for (const [name, value] of Object.entries(legacy)) assert.equal(all[name], value, `${name} is still untouched`);
  assert.ok(Object.keys(owned(all, idB)).length >= 2, "B keeps its own state under its own namespace");
  report.afterB = Object.keys(all);
  assert.deepEqual(problems, [], "no hydration or page errors on platform B");
  await leave();

  // ---- A server that has not named itself: nothing is read, written or recovered ----
  platform = await startPlatform("unnamed", null);
  receiptReads.length = 0;
  const kept = all;
  await open(platform);
  await inboxWindow.locator("[data-notification]").first().waitFor();
  await page.getByText(/Waiting for the server to name itself/).first().waitFor();
  await settle(1200);
  const before = await storage();
  assert.deepEqual(before, kept, "loading under an unnamed destination wrote nothing");
  assert.equal(await title.isDisabled(), true, "Compose cannot be used, so nothing is sent without a place to record it");
  await pin.click();
  const unnamedHeader = await inboxWindow.locator("header").boundingBox();
  await page.mouse.move(unnamedHeader.x + 40, unnamedHeader.y + 20);
  await page.keyboard.down("Alt");
  await page.mouse.down(); await page.mouse.move(unnamedHeader.x + 90, unnamedHeader.y + 50, { steps: 3 }); await page.mouse.up();
  await page.keyboard.up("Alt");
  await settle(1500);
  assert.deepEqual(await storage(), before, "an unnamed destination writes nothing");
  await showClearFlow();
  await inboxWindow.getByRole("button", { name: /^Prepare clearing/ }).waitFor();
  assert.equal(await inboxWindow.getByText("Result not confirmed").count(), 0, "and recovers nothing");
  assert.deepEqual(receiptReads, [], "nor reads any stored request back");
  assert.deepEqual(problems, [], "no hydration or page errors with no identity");
  await leave();

  // ---- A again: the same installation restores exactly what it saved, and reads its own request back ----
  platform = await startPlatform("a-again", idA);
  receiptReads.length = 0;
  await open(platform);
  await title.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-window="notify-compose"] input')?.value === "Draft for A");
  await page.waitForFunction(() => document.querySelector('[aria-label="Pin inspector"]')?.getAttribute("aria-pressed") === "true");
  await showClearFlow();
  await readSaved();
  const restored = await point();
  assert.ok(Math.abs(restored.x - moved.x) < 2 && Math.abs(restored.y - moved.y) < 2, `A's arrangement is restored ${JSON.stringify(moved)} -> ${JSON.stringify(restored)}`);
  assert.deepEqual(problems, [], "no hydration or page errors on A again");
  report.final = Object.keys(await storage());
  await writeFile(join(evidence, "destination-keys.json"), JSON.stringify({ origin, idA, idB, legacy: Object.keys(legacy), ...report }, null, 2));
  console.log(`destination isolation check passed; evidence in ${evidence}`);
} finally {
  await browser.close();
  await platform?.stop();
}
