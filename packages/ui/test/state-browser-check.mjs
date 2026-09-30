// Optional rendered check of System's State and Subscriptions windows after pnpm test (and a ui build, or NEXT_MODE=dev).
// A fixture serve socket answers the state reads from a disposable state directory; no live Server or state is touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/state-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable; STATE_EVIDENCE_DIR keeps the screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveSocket, serveWebSocket, socketPath } from "@stack/api";
import { api as serveApi } from "../../serve/dist/api.js";
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
  serve_subscription_remove({ id, expectedRevision }) {
    removals.push({ id, expectedRevision });
    const row = subscriptions.find((item) => item.id === id);
    if (!row) return { id, removed: false };
    if (row.revision !== expectedRevision) throw new Error("subscription revision changed; inspect it again");
    subscriptions = subscriptions.filter((item) => item.id !== id);
    return { id, removed: true };
  },
};

const sockets = [];
let websocket, next, browser, serveSock;
let log = "";
let failed = false;
try {
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["serve", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("serve", serveApi), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["api", ["docs_snapshot"], {}]]) {
    const socket = await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers),
      events: { topics } });
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

  await page.emulateMedia({ colorScheme: "dark" });
  await shot("state-dark", state);
  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "mixed owner availability with a visible gap, nullable and measured bytes, drill-down action note, stale-page restart, inspector, explicit per-owner measurement, argument reveal only on drill-down, stale-revision removal refused then exact removal, serve_state_changed refresh, dark" }, null, 2));
} catch (error) {
  failed = true;
  const page = browser?.contexts()[0]?.pages()[0];
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
