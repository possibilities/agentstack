// Optional rendered check of the Brain space. The real Brain API runs against a disposable state
// directory with an ephemeral share port; a loopback HTTP server stands in for the web, and server
// and discovery are fixtures. No live server, research store or public site is touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/brain-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable. BRAIN_NEXT=start uses a prior `next build`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@agentstack/api";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/tmp", "as-brain-ui-"));
const evidence = process.env.BRAIN_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, AGENTSTACK_BRAIN_SHARE_PORT: "0", NEXT_TELEMETRY_DISABLED: "1" };
delete env.AGENTSTACK_BRAIN_DB;
const { api: brainApi } = await import("../../brain/dist/api.js");
const handlers = { serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }) };
const sockets = [];
let websocket, next, browser, brain, web, page;
let log = "";

try {
  web = createServer((_request, response) => { response.writeHead(404); response.end("missing"); });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${web.address().port}`;

  brain = await serveApi({ name: "brain", transport: "socket", env, root });
  const status = await socketCall(socketPath("brain", env), "tools/call", { name: "brain_status", arguments: {} });
  assert.equal(JSON.stringify(status).includes(join(dir, "brain")), true, "Brain must use the disposable state directory");
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["brain", "serve", "api"]), port: 0 });
  const catalog = [fixtureDoc("brain", brainApi, websocket.url, publishedJsonSchema), fixtureDoc("serve", undefined, websocket.url, publishedJsonSchema), fixtureDoc("api", undefined, websocket.url, publishedJsonSchema)];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names, topics] of [["serve", ["serve_status"], { pids_changed: "Fixture" }], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers), events: { topics } }));
  }
  const nextPort = await port();
  const mode = process.env.BRAIN_NEXT === "start" ? "start" : "dev";
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1200 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 2600, height: 1300 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
  await page.goto(`${origin}/x/brain`);
  const search = page.locator('[data-window="brain-search"]');
  const reader = page.locator('[data-window="brain-reader"]');
  const ingest = page.locator('[data-window="brain-ingest"]');
  const jobs = page.locator('[data-window="brain-jobs"]');
  const sources = page.locator('[data-window="brain-sources"]');
  await page.getByRole("button", { name: "Spaces · Brain" }).waitFor();
  await search.getByText("Nothing indexed yet").waitFor();
  await jobs.getByText("Ingestion worker running").waitFor();
  await jobs.getByText("Nothing needs a decision").waitFor();
  await sources.getByText("No sources", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "brain-empty.png"), animations: "disabled" });

  // Text admission: the row says admitted, then follows the job to completion and offers the document.
  await ingest.getByRole("radio", { name: "Text" }).or(ingest.getByRole("button", { name: "Text", exact: true })).first().click();
  await ingest.getByLabel("Text", { exact: true }).fill("# Quasar field notes\n\nQuasar evidence from the rendered check.\n\n<script>alert(1)</script>");
  await ingest.getByLabel("Title (optional)").fill("Quasar notes");
  await ingest.getByLabel("Tags").fill("astro, check");
  await ingest.getByRole("button", { name: "Submit", exact: true }).click();
  await ingest.getByRole("link", { name: "Admitted as job 1" }).waitFor();
  await ingest.getByText("· completed").waitFor();
  // The index notice reaches the Search overview without a reload.
  await search.getByText("Recent", { exact: true }).waitFor();
  await ingest.getByRole("button", { name: "Read", exact: true }).click();
  await reader.getByRole("heading", { name: "Quasar notes" }).waitFor();
  await reader.getByText("<script>alert(1)</script>", { exact: false }).waitFor();
  await reader.getByText("#astro").waitFor();

  // Search ranks the chunk, marks the match, and opens the Reader at it; Context gathers citations.
  await search.getByLabel("Search collected research").fill("Quasar");
  await search.getByRole("button", { name: "Search", exact: true }).click();
  await search.locator("mark", { hasText: "Quasar" }).first().waitFor();
  await search.getByRole("button", { name: "Quasar notes", exact: true }).click();
  await reader.locator("mark").first().waitFor();
  await search.getByRole("radio", { name: "Context" }).or(search.getByRole("button", { name: "Context", exact: true })).first().click();
  await search.getByText(/1 hits · \d+ of 12,000 characters/).waitFor();
  await page.screenshot({ path: join(evidence, "brain-search-reader.png"), animations: "disabled" });

  // A private URL fails in the worker and lands in Needs attention; excluding it needs a reason.
  await ingest.getByRole("radio", { name: "URL" }).or(ingest.getByRole("button", { name: "URL", exact: true })).first().click();
  await ingest.getByLabel("URL", { exact: true }).fill(`${base}/private.md`);
  await ingest.getByRole("button", { name: "Submit", exact: true }).click();
  await ingest.getByRole("link", { name: "Admitted as job 2" }).waitFor();
  const row = jobs.locator('li[data-node="ingestion-job:2"]');
  await row.waitFor();
  await row.getByRole("button", { name: "Show job 2 details" }).click();
  await row.getByText("Attempts", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "brain-jobs-attention.png"), animations: "disabled" });
  await row.getByRole("button", { name: "Exclude", exact: true }).click();
  await row.getByText("Exclusion needs a reason").waitFor();
  await row.getByLabel(/Reason/).fill("rendered check fixture");
  await row.getByRole("button", { name: "Exclude", exact: true }).click();
  await jobs.getByText("Nothing needs a decision").waitFor();

  // Reveal is a confirmed, audited act, and shows the submitted intent.
  await jobs.getByRole("radio", { name: /^Done/ }).or(jobs.getByRole("button", { name: /^Done/ })).first().click();
  const done = jobs.locator('li[data-node="ingestion-job:1"]');
  await done.getByRole("button", { name: "Show job 1 details" }).click();
  await done.getByRole("button", { name: "Read document 1" }).waitFor();
  await done.getByRole("button", { name: /Reveal content/ }).click();
  await page.getByRole("button", { name: "Reveal and record" }).click();
  await page.getByText(/Quasar evidence from the rendered check/).first().waitFor();
  await page.screenshot({ path: join(evidence, "brain-reveal.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // A source applied through the API appears through the sources notice, and pauses with a reason.
  const manifest = join(dir, "sources.json");
  await writeFile(manifest, JSON.stringify({ schema_version: 1, sources: [{ id: "fixture-feed", version: 1, kind: "blog_feed", display_name: "Fixture feed", enabled: true,
    payload: { feed_url: `${base}/feed.xml` }, schedule: { cadence_seconds: 3600 }, limits: { max_items_per_run: 10, max_pages_per_run: 1 }, collections: [], sensitivity: "public", credential_refs: [] }] }));
  await socketCall(socketPath("brain", env), "tools/call", { name: "sources_apply", arguments: { manifest } });
  const source = sources.locator('li[data-node="research-source:fixture-feed"]');
  await source.getByText("Fixture feed").waitFor();
  await source.getByRole("button", { name: "Preview", exact: true }).click();
  await source.getByText(/Would admit a Run|Not due/).waitFor();
  await source.getByRole("button", { name: "Pause…" }).click();
  await source.getByLabel(/Reason/).fill("rendered check");
  await source.getByRole("button", { name: "Pause", exact: true }).click();
  await source.getByText("Paused: rendered check").waitFor();
  await source.getByRole("button", { name: "Inspect Fixture feed" }).click();
  await page.getByText("Research source · blog_feed").waitFor();
  await page.screenshot({ path: join(evidence, "brain-sources.png"), animations: "disabled" });

  // Deleting from the Reader is confirmed, and the index empties again.
  await reader.getByRole("button", { name: "Delete Quasar notes" }).click();
  await page.getByRole("button", { name: "Delete document" }).click();
  await reader.getByText("Open a document from Search").waitFor();
  await search.getByText("Index changed · run again").waitFor();

  // The palette runs a Brain search from anywhere.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Quasar");
  await page.getByRole("option", { name: /Search Brain for “Quasar”/ }).click();
  await search.getByText("No matching chunks").waitFor();

  assert.deepEqual(errors, []);
  console.log(`brain rendered check passed; evidence in ${evidence}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "brain-failure.png"), animations: "disabled" }).catch(() => {});
  if (page) for (const id of ["brain-ingest", "brain-jobs"]) console.error(`${id}:`, await page.locator(`[data-window="${id}"]`).innerText().catch(() => "unavailable"));
  console.error(log.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  for (const socket of sockets) await socket.close();
  await brain?.close();
  await new Promise((resolve) => web ? web.close(resolve) : resolve());
  if (!process.env.BRAIN_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
