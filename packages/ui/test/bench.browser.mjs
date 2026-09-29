/** Standalone local-headless check against an existing production build (NEXT_MODE=dev opts into dev).
 * Pass PLAYWRIGHT_MODULE (absolute module path); this script installs nothing and never builds Next.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { get } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveSocket, socketPath } from "@stack/api";
import { passthrough as pass, transport, authorizeBrowser } from "./browser-fixture.mjs";

const require = createRequire(import.meta.url);
const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed playwright module.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const stateDir = await mkdtemp(join(tmpdir(), "opencode/stack-bench-"));
const env = { ...process.env, STACK_STATE_DIR: stateDir, STACK_WEBSOCKET_PORT: "0", NEXT_TELEMETRY_DISABLED: "1" };
// Fixed far-past timestamps keep SSR and hydration rendering the same coarse relative text.
const fixtureAt = "2020-06-01T12:00:00.000Z";
const op = (name, result) => ({ name, description: name, input: pass, output: pass, async call() { return result; } });
const bots = Array.from({ length: 8 }, (_, i) => ({ id: `bot-${i + 1}`, pid: 100 + i, cwd: "/fixture/project", state: "running", account: "account-1", runningAccount: "account-1", mainThreadId: `thread-${i}`, url: null, recoveryIssue: null, roleRevision: 1, settings: { model: "fixture", reasoningEffort: "medium", sandboxMode: "read-only", approvalPolicy: "never" } }));
const doc = (name, operation) => ({ name, packageName: `@stack/${name}`, description: `${name} fixture description`, events: { changed: "Fixture changed" }, eventScope: { required: true, description: "A current Bot ID", example: "bot-1" }, transports: [transport(socketPath(name, env), [operation], ["changed"], "socket")], operations: [{ name: operation, title: "Read fixture", description: "Read current fixture state", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: { id: { type: "string", description: "Current ID", minLength: 1 } }, required: ["id"], additionalProperties: false }, outputSchema: { oneOf: [{ type: "object", properties: { value: { type: "string" } } }, { type: "null" }], $defs: { complete: { type: "number" } } } }] });
const catalog = [doc("serve", "serve_status"), doc("bots", "bot_status"), doc("auth", "account_list")];
const resourcesFixture = {
  observation: { snapshotId: "snap-1", capturedAt: fixtureAt, ageMs: 400, freshness: "fresh", lastAttemptAt: fixtureAt, error: null,
    source: "darwin_ps", intervalMs: 5_000, staleAfterMs: 14_000, collectionDurationMs: 18,
    coverage: { mode: "server_tree", observedHostProcesses: 512, ownedProcesses: 3, unreadableProcesses: 0, vanishedDuringCollection: 0, retainedProcesses: 0, excludedCollectorProcesses: 1, domains: [] } },
  host: { platform: "darwin", logicalCpuCount: 8, hostname: "fixture-host", arch: "arm64", release: "24.5.0", cpuModel: "Apple M4", uptimeSeconds: 86_400,
    totalMemoryBytes: 16_000_000_000, freeMemoryBytes: 2_000_000_000, loadAverage: [1.5, 1.2, 1.1] },
  capabilities: { rssBytes: true, virtualBytes: true, cpuTimeMs: true, cpuPercent: true, threads: false,
    diskIoBytes: false, openFileDescriptors: false, networkBytes: false, gpu: false, perSessionAllocation: false },
  retention: { maxSamples: 120, maxProcessRecords: 50_000, retainedSamples: 1, oldestAttemptAt: fixtureAt, newestAttemptAt: fixtureAt, droppedSamples: 0 },
  runtime: { pid: 123, nodeVersion: process.version, uptimeSeconds: 60, heapUsedBytes: 24_000_000, heapTotalBytes: 40_000_000, externalBytes: 2_000_000, arrayBuffersBytes: 100_000, eventLoopUtilization: null },
  scope: null,
  scopes: [{ id: "total", kind: "total", name: "Stack", component: null, botId: null, accountId: null, runtimeInstance: null, provider: null, shared: true,
    metrics: { processCount: 3, rssBytes: 120_000_000, virtualBytes: 360_000_000, cpuTimeMs: 2_400, cpuPercent: 4.2, cpuMeasuredProcessCount: 3, threads: null } }],
  processes: [{ id: "process:1:root", subtreeId: "subtree:1:root", pid: 123, ppid: 1, birth: "b1", name: "stack", parentId: null, ancestryParentId: null,
    ownership: "root", component: "server", botId: null, accountId: null, runtimeInstance: null, provider: null, attribution: "component", attributedAt: null,
    cpuIntervalMs: 5_000, cpuStatus: "measured",
    self: { processCount: 1, rssBytes: 40_000_000, virtualBytes: 120_000_000, cpuTimeMs: 800, cpuPercent: 1.4, cpuMeasuredProcessCount: 1, threads: null },
    subtree: { processCount: 3, rssBytes: 120_000_000, virtualBytes: 360_000_000, cpuTimeMs: 2_400, cpuPercent: 4.2, cpuMeasuredProcessCount: 3, threads: null } }],
  page: { offset: 0, limit: 100, total: 1, nextOffset: null },
};
const historyFixture = { scopeId: "total", intervalMs: 5_000, truncated: false, retention: resourcesFixture.retention,
  points: [{ attemptId: "a1", attemptedAt: fixtureAt, snapshotId: "snap-1", capturedAt: fixtureAt, state: "measured", error: null,
    metrics: resourcesFixture.scopes[0].metrics, host: resourcesFixture.host, coverage: resourcesFixture.observation.coverage }] };
const definitions = {
  serve: [
    op("serve_status", { pid: 123, startedAt: fixtureAt, nodeVersion: process.version, indexUrl: "http://127.0.0.1:1", uiUrl: null, inspectorUrl: null, mcpUrls: { bots: "http://127.0.0.1:2/mcp/bots" },
      children: [{ name: "api", pid: 124, running: true, exitCode: null, signal: null, error: null, startedAt: fixtureAt, exitedAt: null },
        { name: "fixture-stopped", pid: null, running: false, exitCode: 1, signal: null, error: "Fixture stopped", startedAt: null, exitedAt: fixtureAt }] }),
    op("serve_resources", resourcesFixture),
    op("serve_resource_history", historyFixture),
  ],
  auth: [op("account_list", { accounts: [{ id: "account-1", enabled: true, removing: false, linkedAccounts: [] }] }), op("account_login_current", { login: null }), op("worker_account_list", { accounts: [] }), op("worker_account_login_current", { logins: [] })],
  bots: [op("bot_list", { bots }), op("bot_defaults_get", bots[0].settings), op("voice_status", { call: null })],
  worker: [op("worker_runtime_list", { runtimes: [] }), op("worker_list", { workers: [] })],
  usage: [op("usage_snapshot", { atMs: Date.parse(fixtureAt), inventoryAtMs: null, inventoryError: null, accounts: [], grokBot: { observedAtMs: null, lastAttemptAtMs: null, fresh: false, error: "not_observed", usage: null } })],
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
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), nextMode, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: uiDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  for (const stream of [next.stdout, next.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-12000); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (next.exitCode !== null) throw new Error(output);
    try { ready = (await fetch(`${origin}/connect/local`)).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  const rebound = await new Promise((resolve, reject) => {
    get(`${origin}/`, { headers: { host: "rebind.example.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(rebound, 403, "UI must reject rebound Hosts before rendering the operator snapshot");
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
  await authorizeBrowser(page, origin, env);
  page.on("pageerror", (error) => issues.push(error.message));
  await page.goto(`${origin}/`);
  await page.getByRole("main", { name: "Open bench" }).waitFor();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  assert.deepEqual(await page.locator("[data-window]:visible").evaluateAll((nodes) => nodes.map((node) => node.dataset.window).sort()), ["bots", "chat"]);
  assert.equal(await page.getByRole("button", { name: "Grid", exact: true }).count(), 0);
  const point = () => page.locator('[data-window="bots"]').evaluate((el) => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y }));
  const samePoint = (a, b) => { assert.ok(Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1, `${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  const initial = await point();
  await page.getByRole("button", { name: "Inspect bot bot-1", exact: true }).click();
  await page.getByRole("region", { name: "Inspector", exact: true }).waitFor();
  const inspector = page.locator('[aria-label="Inspector"] section[aria-label="Inspector"] [data-scroll]');
  await inspector.evaluate((el) => { el.scrollTop = 200; });
  const scroll = await inspector.evaluate((el) => el.scrollTop);
  const apiToggle = page.getByRole("button", { name: "Show API reference", exact: true });
  await apiToggle.click();
  await page.getByRole("heading", { name: "Package API reference", exact: true }).waitFor();
  assert.equal(await apiToggle.getAttribute("aria-pressed"), "true");
  // The toolbar button toggles: a second press closes the reference back to the inspector.
  await apiToggle.click();
  await page.locator("[data-reference]").waitFor({ state: "detached" });
  assert.equal(await apiToggle.getAttribute("aria-pressed"), "false");
  await apiToggle.click();
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
  // Switching benches retains independent cameras and exposes only the selected space.
  await page.getByRole("button", { name: /^Spaces/ }).click();
  await page.getByRole("menuitem", { name: /^System/ }).click();
  await page.locator('[data-window="server"]').waitFor({ state: "visible" });
  assert.ok(new URL(page.url()).pathname.endsWith("/system"));
  assert.ok(await page.locator('[data-window="sampling"]').isVisible());
  assert.equal(await page.locator('[data-window="bots"]').isVisible(), false);
  const systemPoint = await page.locator('[data-window="server"]').boundingBox();
  await page.getByRole("main", { name: "Open bench" }).focus();
  await page.keyboard.press("ArrowRight");
  const systemPanned = await page.locator('[data-window="server"]').boundingBox();
  assert.equal(Math.round(systemPanned.x - systemPoint.x), -64);
  await page.goBack();
  assert.ok(new URL(page.url()).pathname.endsWith("/"));
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  samePoint(initial, await point());
  await page.goForward();
  await page.locator('[data-window="server"]').waitFor({ state: "visible" });
  samePoint(systemPanned, await page.locator('[data-window="server"]').boundingBox());
  await page.goBack();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Inspect bot bot-1", exact: true }).click();
  await page.getByRole("button", { name: /^Spaces/ }).click(); await page.getByRole("menuitem", { name: /^Fleet/ }).click();
  // Chrome interaction contracts the unpinned inspector; the retained inspection is one press away.
  await page.getByRole("button", { name: "Return to inspector", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "bot-1", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();

  // Unpinned by default, the inspector contracts on bench input without dropping the inspection.
  const benchPoint = () => page.evaluate(() => {
    for (const y of [940, 500, 200]) for (const x of [60, 1500, 800]) {
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('[data-canvas="workbench"]') && !el.closest("[data-window],[data-chrome]")) return { x, y };
    }
    return null;
  });
  const clickBench = async () => {
    const spot = await benchPoint();
    if (spot) await page.mouse.click(spot.x, spot.y);
    else await page.getByRole("main", { name: "Open bench" }).dispatchEvent("click");
  };
  await page.getByRole("button", { name: "Inspect bot bot-1", exact: true }).click();
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  await clickBench();
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).searchParams.get("inspect"), "bot:bot-1");
  await page.getByRole("button", { name: "Return to inspector", exact: true }).click();
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  // Keyboard input on the bench contracts too; so does wheel panning.
  await page.getByRole("main", { name: "Open bench" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Return to inspector", exact: true }).click();
  const wheelSpot = await benchPoint();
  if (wheelSpot) { await page.mouse.move(wheelSpot.x, wheelSpot.y); await page.mouse.wheel(0, 60); }
  else await page.getByRole("main", { name: "Open bench" }).dispatchEvent("wheel");
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  // Interacting inside the inspector — even a control that hands focus to the bench — keeps it open.
  await page.getByRole("button", { name: "Return to inspector", exact: true }).click();
  await page.getByRole("button", { name: "Show on bench", exact: true }).click();
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  // Inspecting another record swaps contents without hiding the dock.
  await page.getByRole("button", { name: "Inspect bot bot-2", exact: true }).click();
  await page.getByRole("heading", { name: "bot-2", exact: true }).waitFor();
  // A contracted record's name re-expands the dock instead of deselecting.
  await clickBench();
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Inspect bot bot-2", exact: true }).click();
  await page.getByRole("heading", { name: "bot-2", exact: true }).waitFor();
  // Pinned, the inspector survives bench interaction — and reloads.
  await page.getByRole("button", { name: "Pin inspector", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Pin inspector", exact: true }).getAttribute("aria-pressed"), "true");
  await clickBench();
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole("heading", { name: "bot-2", exact: true }).count(), 1);
  await page.reload();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector('[aria-label="Pin inspector"]')?.getAttribute("aria-pressed") === "true");
  await page.getByRole("heading", { name: "bot-2", exact: true }).waitFor();
  await page.getByRole("button", { name: "Pin inspector", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Pin inspector", exact: true }).getAttribute("aria-pressed"), "false");
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  const bench = page.getByRole("main", { name: "Open bench" });
  await bench.focus();
  const historyLength = await page.evaluate(() => history.length);
  await page.mouse.move(700, 940); await page.mouse.wheel(90, 60);
  assert.equal(await page.evaluate(() => history.length), historyLength);
  await page.getByRole("button", { name: "Show API reference", exact: true }).click();
  await page.getByLabel("Find a package or operation").fill("bot_status");
  await page.locator('[aria-label="Reference search results"]').getByRole("link", { name: "bot_status", exact: true }).click();
  await page.getByRole("heading", { name: "Request templates" }).waitFor();
  const evidence = join(uiDir, ".next", "bench-evidence");
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, "reference-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('[data-dock="right"]').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 390);
  await page.getByRole("button", { name: "Close API reference", exact: true }).click();
  await page.goto(`${origin}/system`);
  await page.locator('[data-window="server"]').waitFor({ state: "visible" });
  await page.screenshot({ path: join(evidence, "system-mobile.png") });
  await page.goto(`${origin}/system?focus=child%3Afixture-stopped&reference=operation%3Abots.bot_status&inspect=bot%3Abot-1`);
  await page.getByRole("heading", { name: "Request templates" }).waitFor();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.getByRole("heading", { name: "bot-1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
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
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("stack.uix.bench.v2.fleet") ?? "{}").layout?.manual?.bots === true);
  await page.reload();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  samePoint(afterDrag, await point());

  // The retained reference width is bounded by the desktop breakpoint's usable bench.
  await page.getByRole("button", { name: "Show API reference", exact: true }).click();
  const referenceSeparator = page.getByRole("separator", { name: "Resize API reference", exact: true });
  await referenceSeparator.focus();
  await page.keyboard.press("End");
  assert.equal(Number(await referenceSeparator.getAttribute("aria-valuenow")), Number(await referenceSeparator.getAttribute("aria-valuemax")));
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.waitForFunction(() => document.querySelector('[aria-label="Resize API reference"]').getAttribute("aria-valuemax") === "660");
  assert.equal(Number(await referenceSeparator.getAttribute("aria-valuemax")), 660);
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
  await page.goto(`${origin}/?inspect=bot%3Abot-1&focus=bot%3Abot-1`);
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
  await page.getByRole("button", { name: "codex-bot-account-1 · assigned", exact: true }).click();
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
  await page.getByRole("button", { name: "Show API reference", exact: true }).click();
  await page.locator('[data-reference]').getByRole("link", { name: "bots", exact: true }).click();
  await page.locator('[data-reference]').getByRole("link", { name: "Read fixture", exact: true }).click();
  await chooseSpace();
  assert.equal(new URL(page.url()).searchParams.get("reference"), "operation:bots.bot_status");
  await page.reload();
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Show API reference", exact: true }).click();
  await page.getByRole("heading", { name: "Request templates" }).waitFor();

  // Reproduce physically overlapping windows without adding temporary production spaces.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("stack.uix.bench.v2.fleet"));
    saved.space = "another-logical-space"; // forces Fleet's direct URL to fit, rather than reuse this camera
    saved.layout.positions.chat = { x: 0, y: 0 };
    saved.layout.positions.bots = { x: 0, y: 0 };
    saved.layout.manual.chat = true;
    saved.layout.manual.bots = true;
    saved.layout.order = ["chat", "bots"];
    localStorage.setItem("stack.uix.bench.v2.fleet", JSON.stringify(saved));
  });
  await page.goto(`${origin}/`);
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  const expectFront = async (id) => page.waitForFunction((target) => {
    const windows = [...document.querySelectorAll('[data-space="fleet"] [data-window]')];
    const front = windows.find((el) => el.dataset.window === target);
    return front && windows.every((el) => el === front || Number(el.style.zIndex) < Number(front.style.zIndex));
  }, id);
  await expectFront("bots");
  await page.locator('[data-window="chat"] button').first().focus();
  await expectFront("chat");
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill("bot-1");
  await page.getByRole("option").filter({ hasText: "bot-1" }).first().click();
  await page.getByRole("dialog", { name: "Jump to", exact: true }).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.matches('[data-canvas="workbench"]'));
  await expectFront("bots");
  // Every space is a closed visual/focus boundary, even at minimum zoom and after panning.
  const expectedWindows = {
    Fleet: ["bots", "chat"], Accounts: ["accounts", "model-catalogs", "usage"],
    Lab: ["call-speech", "inference"],
    System: ["access", "activity", "host", "serve", "packages", "processes", "resources", "sampling"],
    Roles: ["role-editor", "role-instructions", "role-mcp-servers", "role-preview", "role-projects", "role-skills"],
    Inbox: ["notify-detail", "notify-inbox"],
    Signal: ["attention", "attention-changes", "attention-messages", "attention-runs", "signal"],
    Content: ["content-artifacts", "content-documents", "content-editor", "content-library", "content-preview"],
    Workers: ["worker", "worker-runtimes", "workers"],
    Scrape: ["scrape-checks", "scrape-convert", "scrape-extract", "scrape-feeds", "scrape-presets", "scrape-queue", "scrape-status"],
  };
  const switchSpace = async (title) => {
    await page.getByRole("button", { name: /^Spaces/ }).click();
    await page.getByRole("menuitem", { name: new RegExp(`^${title}`) }).click();
    await page.locator(`[data-space="${title.toLowerCase()}"]`).waitFor({ state: "visible" });
  };
  for (const [title, ids] of Object.entries(expectedWindows)) {
    await switchSpace(title);
    const bench = page.getByRole("main", { name: "Open bench" });
    await bench.focus();
    for (let i = 0; i < 7; i++) await page.keyboard.press("-");
    await page.keyboard.press("Shift+ArrowRight");
    assert.deepEqual(await page.locator("[data-window]:visible").evaluateAll((nodes) => nodes.map((n) => n.dataset.window).sort()), ids);
    assert.equal(await page.getByRole("main", { name: "Open bench" }).count(), 1);
    await page.locator('[hidden] [data-window] button').first().evaluate((el) => el.focus());
    assert.equal(await bench.evaluate((el) => document.activeElement === el), true, "hidden controls cannot take focus");
    await page.keyboard.press("f");
  }
  await switchSpace("Lab");
  await page.getByPlaceholder("Ask something").fill("Keep this unsent draft across benches");
  await switchSpace("Fleet");
  await page.getByRole("button", { name: "Collapse Bots", exact: true }).click();
  await switchSpace("Lab");
  assert.equal(await page.getByPlaceholder("Ask something").inputValue(), "Keep this unsent draft across benches");
  await switchSpace("Fleet");
  assert.equal(await page.getByRole("button", { name: "Expand Bots", exact: true }).count(), 1);
  assert.equal(await page.locator('.bench-enter').evaluate((el) => getComputedStyle(el).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("main", { name: "Open bench" }).evaluate((el) => {
    for (const key of ["2", "3", "4", "5"]) el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await page.locator('[data-space="roles"]').waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).pathname, "/roles");
  assert.equal(await page.locator('.bench-enter').evaluate((el) => getComputedStyle(el).animationDuration), "0.15s");
  await page.waitForTimeout(200);
  assert.deepEqual(await page.locator("[data-window]:visible").evaluateAll((nodes) => nodes.map((n) => n.dataset.window).sort()), expectedWindows.Roles);
  await page.screenshot({ path: join(evidence, "isolated-roles-bench.png") });
  // Upgrade a shared-world save without discarding manual layout or its viewed anchor.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("stack.uix.bench.v2.")) localStorage.removeItem(key);
    localStorage.setItem("stack.uix.bench.v1", JSON.stringify({
      space: "fleet", camera: { x: 100, y: 200, k: 0.8 }, anchor: { id: "bots", point: { x: 1000, y: 1000 } },
      layout: { positions: { bots: { x: 123, y: 234 }, accounts: { x: 66, y: 88 } }, manual: { bots: true, accounts: true },
        collapsed: { accounts: true }, sizes: { bots: { width: 500 } }, order: ["bots", "accounts"] },
    }));
  });
  await page.goto(`${origin}/`);
  await page.locator('[data-window="bots"]').waitFor({ state: "visible" });
  samePoint({ x: 900, y: 1000 }, await point());
  await switchSpace("Accounts");
  assert.equal(await page.getByRole("button", { name: "Expand Accounts", exact: true }).count(), 1);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("stack.uix.bench.v2.accounts") ?? "{}").layout?.manual?.accounts === true);
  assert.deepEqual(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("stack.uix.bench.v2.accounts")).layout.positions).sort()), expectedWindows.Accounts);
  assert.deepEqual(issues, []);
  console.log("PASS: isolated spaces at minimum zoom/pan, independent cameras/history, hidden focus exclusion, retained draft/collapse state, reduced motion and rapid navigation, legacy layout migration; desktop/mobile navigation, joint dock sizing/expanded reading, keyboard resize/Escape/focus return, retained inspection/reference, stacking, inspector scroll, pin persistence, schemas, search, deep links and manual placement reload; no page errors.");
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
