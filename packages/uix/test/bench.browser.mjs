/** Standalone local-headless check against an existing production build (NEXT_MODE=dev opts into dev).
 * Pass PLAYWRIGHT_MODULE (absolute module path); this script installs nothing and never builds Next.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveSocket, socketPath } from "@agentstack/api";

const require = createRequire(import.meta.url);
const uixDir = dirname(dirname(fileURLToPath(import.meta.url)));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed playwright module.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const stateDir = await mkdtemp(join(tmpdir(), "opencode/agentstack-bench-"));
const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_WEBSOCKET_PORT: "0", NEXT_TELEMETRY_DISABLED: "1" };
const pass = { parse: (value) => value };
const op = (name, result) => ({ name, description: name, input: pass, output: pass, async call() { return result; } });
const bots = Array.from({ length: 8 }, (_, i) => ({ id: `bot-${i + 1}`, pid: 100 + i, cwd: "/fixture/project", state: "running", account: "account-1", runningAccount: "account-1", mainThreadId: `thread-${i}`, url: null, recoveryIssue: null, roleRevision: 1, settings: { model: "fixture", reasoningEffort: "medium", sandboxMode: "read-only", approvalPolicy: "never" } }));
const doc = (name, operation) => ({ name, packageName: `@agentstack/${name}`, description: `${name} fixture description`, events: { changed: "Fixture changed" }, eventScope: { required: true, description: "A current Bot ID", example: "bot-1" }, transports: [{ type: "socket", supported: true, subscriptions: true, endpoint: socketPath(name, env), description: "Fixture Unix socket" }], operations: [{ name: operation, title: "Read fixture", description: "Read current fixture state", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: { id: { type: "string", description: "Current ID", minLength: 1 } }, required: ["id"], additionalProperties: false }, outputSchema: { oneOf: [{ type: "object", properties: { value: { type: "string" } } }, { type: "null" }], $defs: { complete: { type: "number" } } } }] });
const catalog = [doc("owner", "owner_status"), doc("bots", "bot_status"), doc("auth", "account_list")];
const definitions = {
  owner: [op("owner_status", { pid: 123, indexUrl: "http://127.0.0.1:1", uixUrl: null, inspectorUrl: null, mcpUrls: { bots: "http://127.0.0.1:2/mcp/bots" }, children: [{ name: "api", pid: 124, running: true, exitCode: null, signal: null, error: null }, { name: "fixture-stopped", pid: null, running: false, exitCode: 1, signal: null, error: "Fixture stopped" }] })],
  auth: [op("account_list", { accounts: [{ id: "account-1", enabled: true, removing: false, linkedAccounts: [] }] }), op("account_login_current", { login: null }), op("worker_account_list", { accounts: [] }), op("worker_account_login_current", { logins: [] })],
  bots: [op("bot_list", { bots }), op("bot_defaults_get", bots[0].settings), op("voice_status", { call: null })],
  workers: [op("worker_runtime_list", { runtimes: [] }), op("worker_list", { workers: [] })],
  usage: [op("usage_snapshot", { atMs: Date.now(), inventoryAtMs: null, inventoryError: null, accounts: [], grokBot: { observedAtMs: null, lastAttemptAtMs: null, fresh: false, error: "not_observed", usage: null } })],
  api: [op("docs_snapshot", { packages: catalog })],
};
let next, browser;
const served = [];
let output = "";
const issues = [];
try {
  for (const [name, operations] of Object.entries(definitions)) served.push(await serveSocket({ info: { name, description: name, transportDescription: "fixture", path: socketPath(name, env) }, context: {}, operations }));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const nextMode = process.env.NEXT_MODE ?? "start";
  assert.ok(nextMode === "start" || nextMode === "dev", "NEXT_MODE must be start or dev");
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), nextMode, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: uixDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  for (const stream of [next.stdout, next.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-12000); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (next.exitCode !== null) throw new Error(output);
    try { ready = (await fetch(`${origin}/x`)).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => issues.push(error.message));
  await page.goto(`${origin}/x`);
  await page.getByRole("main", { name: "Open bench" }).waitFor();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  assert.deepEqual(await page.locator("[data-window]").evaluateAll((nodes) => nodes.map((node) => node.dataset.window).sort()), ["accounts", "bots", "model-catalogs", "usage", "worker-accounts"]);
  assert.equal(await page.getByRole("button", { name: "Grid", exact: true }).count(), 0);
  const point = () => page.locator('[data-window="bots"]').evaluate((el) => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y }));
  const samePoint = (a, b) => { assert.ok(Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1, `${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  const initial = await point();
  await page.getByRole("button", { name: "Inspect bot bot-1", exact: true }).click();
  await page.getByRole("region", { name: "Inspector", exact: true }).waitFor();
  const inspector = page.locator('[aria-label="Inspector"] section[aria-label="Inspector"] [data-scroll]');
  await inspector.evaluate((el) => { el.scrollTop = 200; });
  const scroll = await inspector.evaluate((el) => el.scrollTop);
  await page.getByRole("button", { name: "Open API reference", exact: true }).click();
  await page.getByRole("heading", { name: "Package API reference", exact: true }).waitFor();
  samePoint(initial, await point());
  await page.locator('[data-reference]').getByRole("link", { name: "bots", exact: true }).click();
  await page.locator('[data-reference]').getByRole("link", { name: "Read fixture", exact: true }).click();
  await page.getByRole("heading", { name: "Request templates" }).waitFor();
  assert.ok(page.url().includes("reference=operation%3Abots.bot_status"));
  assert.equal(await page.getByText("websocket", { exact: true }).count(), 0);
  await page.getByText("Complete output JSON Schema", { exact: true }).click();
  assert.ok((await page.getByLabel("Output schema", { exact: true }).innerText()).includes('"$defs"'));
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  assert.equal(await inspector.evaluate((el) => el.scrollTop), scroll);
  assert.equal(await page.getByRole("heading", { name: "bot-1", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Inspect bot bot-1", exact: true }).evaluate((el) => el === document.activeElement), true);
  await page.getByRole("button", { name: "Open System dock", exact: true }).click();
  await page.getByRole("heading", { name: "System", exact: true }).waitFor();
  samePoint(initial, await point());
  const resize = page.getByRole("separator", { name: "Resize System", exact: true });
  const width = Number(await resize.getAttribute("aria-valuenow"));
  await resize.focus(); await page.keyboard.press("ArrowRight");
  assert.equal(Number(await resize.getAttribute("aria-valuenow")), width + 16);
  samePoint(initial, await point());
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("heading", { name: "System", exact: true }).isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "Open System dock", exact: true }).evaluate((el) => el === document.activeElement), true);
  samePoint(initial, await point());
  await page.goBack();
  await page.getByRole("heading", { name: "System", exact: true }).waitFor();
  samePoint(initial, await point());
  await page.getByRole("button", { name: "Close System dock", exact: true }).click();
  await page.getByRole("button", { name: "Inspect bot bot-1", exact: true }).click();
  await page.getByRole("button", { name: /^Spaces/ }).click(); await page.getByRole("menuitem", { name: /^Fleet/ }).click();
  assert.equal(await page.getByRole("heading", { name: "bot-1", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  const bench = page.getByRole("main", { name: "Open bench" });
  await bench.focus();
  const historyLength = await page.evaluate(() => history.length);
  await page.mouse.move(700, 940); await page.mouse.wheel(90, 60);
  assert.equal(await page.evaluate(() => history.length), historyLength);
  await page.getByRole("button", { name: "Open API reference", exact: true }).click();
  await page.getByLabel("Find a package or operation").fill("bot_status");
  await page.locator('[aria-label="Reference search results"]').getByRole("link", { name: "bot_status", exact: true }).click();
  await page.getByRole("heading", { name: "Request templates" }).waitFor();
  const evidence = join(uixDir, ".next", "bench-evidence");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, "reference-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('[data-dock="right"]').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 390);
  await page.getByRole("button", { name: "Close API reference", exact: true }).click();
  await page.getByRole("button", { name: "Open System dock", exact: true }).click();
  assert.equal(await page.locator('[data-dock="left"]').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 390);
  await page.screenshot({ path: join(evidence, "system-mobile.png") });
  await page.getByRole("button", { name: "Close System dock", exact: true }).click();
  await page.goto(`${origin}/x/fleet?system=child%3Afixture-stopped&reference=operation%3Abots.bot_status&inspect=bot%3Abot-1`);
  await page.getByRole("heading", { name: "Request templates" }).waitFor();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  await page.getByRole("button", { name: "Close System dock", exact: true }).click();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: /^Spaces/ }).click(); await page.getByRole("menuitem", { name: /^Fleet/ }).click();
  const windowHeader = await page.locator('[data-window="bots"] header').boundingBox();
  const beforeDrag = await point();
  await page.mouse.move(windowHeader.x + 30, windowHeader.y + 25);
  // Alt places freely, so the window tracks the pointer exactly instead of snapping to the grid.
  await page.keyboard.down("Alt");
  await page.mouse.down(); await page.mouse.move(windowHeader.x + 80, windowHeader.y + 65); await page.mouse.up();
  await page.keyboard.up("Alt");
  const afterDrag = await point();
  assert.ok(Math.abs(afterDrag.x - beforeDrag.x - 50) < 1 && Math.abs(afterDrag.y - beforeDrag.y - 40) < 1, `drag ${JSON.stringify(beforeDrag)} -> ${JSON.stringify(afterDrag)}`);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("agentstack.uix.bench.v1") ?? "{}").layout?.manual?.bots === true);
  await page.reload();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  samePoint(afterDrag, await point());

  // Retained width preferences must be jointly constrained at the desktop breakpoint.
  await page.getByRole("button", { name: "Open System dock", exact: true }).click();
  await page.getByRole("separator", { name: "Resize System", exact: true }).focus();
  await page.keyboard.press("End");
  assert.equal(Number(await page.getByRole("separator", { name: "Resize System", exact: true }).getAttribute("aria-valuenow")), 520);
  await page.getByRole("button", { name: "Open API reference", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.waitForFunction(() => document.querySelector('[aria-label="Resize System"]').getAttribute("aria-valuemax") === "340");
  const systemSeparator = page.getByRole("separator", { name: "Resize System", exact: true });
  const referenceSeparator = page.getByRole("separator", { name: "Resize API reference", exact: true });
  assert.equal(Number(await systemSeparator.getAttribute("aria-valuemax")), 340);
  assert.equal(Number(await systemSeparator.getAttribute("aria-valuenow")), 340);
  assert.equal(Number(await referenceSeparator.getAttribute("aria-valuemax")), 320);
  await page.getByRole("button", { name: "Expand reading mode", exact: true }).click();
  for (const width of [900, 1100, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => document.querySelector('[data-canvas="workbench"]').clientWidth === 240);
    const chromeFits = await page.locator('header[data-chrome]').evaluate((el) => el.scrollWidth <= el.clientWidth);
    assert.ok(chromeFits, `bench controls overflow at ${width}px with both docks`);
    assert.equal(await referenceSeparator.getAttribute("aria-valuenow"), await referenceSeparator.getAttribute("aria-valuemax"));
    if (width === 900) await page.screenshot({ path: join(evidence, "joint-docks-900.png") });
  }

  // Spatial navigation on mobile hides overlays, not retained inspection or reference state.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/x/fleet?inspect=bot%3Abot-1&focus=bot%3Abot-1`);
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Show on bench", exact: true }).click();
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).searchParams.get("inspect"), "bot:bot-1");
  assert.equal(new URL(page.url()).searchParams.get("surface"), "bench");
  assert.equal(await page.getByRole("button", { name: "Inspect bot bot-1", exact: true }).getAttribute("aria-pressed"), "true");
  await page.screenshot({ path: join(evidence, "mobile-show-on-bench.png") });
  await page.goBack();
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  await page.goForward();
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Return to inspector", exact: true }).click();
  await page.getByRole("button", { name: "codex-1 · assigned", exact: true }).click();
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).searchParams.get("focus"), "account:account-1");
  assert.equal(new URL(page.url()).searchParams.get("inspect"), "bot:bot-1");
  await page.getByRole("button", { name: "Return to inspector", exact: true }).click();
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  const chooseSpace = async () => {
    await page.keyboard.press("Meta+k");
    await page.getByRole("combobox").fill("Fleet");
    await page.getByRole("option").filter({ hasText: "Fleet" }).first().click();
    await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  };
  await chooseSpace();
  assert.equal(new URL(page.url()).searchParams.get("inspect"), "bot:bot-1");
  await page.getByRole("button", { name: "Open API reference", exact: true }).click();
  await page.locator('[data-reference]').getByRole("link", { name: "bots", exact: true }).click();
  await page.locator('[data-reference]').getByRole("link", { name: "Read fixture", exact: true }).click();
  await chooseSpace();
  assert.equal(new URL(page.url()).searchParams.get("reference"), "operation:bots.bot_status");
  await page.reload();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open API reference", exact: true }).click();
  await page.getByRole("heading", { name: "Request templates" }).waitFor();

  // Reproduce physically overlapping windows without adding temporary production spaces.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("agentstack.uix.bench.v1"));
    saved.space = "another-logical-space"; // forces Fleet's direct URL to fit, rather than reuse this camera
    saved.layout.positions.accounts = { x: 0, y: 0 };
    saved.layout.positions.bots = { x: 0, y: 0 };
    saved.layout.manual.accounts = true;
    saved.layout.manual.bots = true;
    saved.layout.order = [...saved.layout.order.filter((id) => id !== "accounts" && id !== "bots"), "accounts", "bots"];
    localStorage.setItem("agentstack.uix.bench.v1", JSON.stringify(saved));
  });
  await page.goto(`${origin}/x/fleet`);
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  const expectFront = async (id) => page.waitForFunction((target) => {
    const windows = [...document.querySelectorAll("[data-window]")];
    const front = windows.find((el) => el.dataset.window === target);
    return front && windows.every((el) => el === front || Number(el.style.zIndex) < Number(front.style.zIndex));
  }, id);
  await expectFront("bots");
  await page.getByRole("button", { name: "Inspect account codex-1", exact: true }).focus();
  await expectFront("accounts");
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill("bot-1");
  await page.getByRole("option").filter({ hasText: "bot-1" }).first().click();
  await page.getByRole("dialog", { name: "Jump to", exact: true }).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.matches('[data-canvas="workbench"]'));
  await expectFront("bots");
  assert.deepEqual(issues, []);
  console.log("PASS: headless desktop/mobile navigation, joint dock sizing/expanded reading, camera compensation, keyboard resize/Escape/focus return, retained mobile inspection/reference, keyboard/navigation stacking, inspector scroll restoration, schemas, search, history, deep links, manual placement reload; no page errors.");
  console.log(`Screenshots: ${evidence}`);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await browser?.close();
  if (next?.pid) {
    try { process.kill(-next.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (next.exitCode === null && next.signalCode === null) await new Promise((resolve) => next.once("exit", resolve));
  }
  await Promise.allSettled(served.map((s) => s.close()));
  await rm(stateDir, { recursive: true, force: true });
}
