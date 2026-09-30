// Optional rendered check of the Scrape space. The real Scrape API runs against a disposable state
// directory; a loopback HTTP server stands in for the web, and server and discovery are fixtures.
// No live server is touched and no public site is fetched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/scrape-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable. SCRAPE_NEXT=start uses a prior `next build`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketPath } from "@stack/api";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/tmp", "as-scrape-ui-"));
const evidence = process.env.SCRAPE_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
// Scrape resolves its queue directories when its module loads, and the socket below runs in this
// process: point the whole process at the disposable state before importing it, then prove it.
process.env.STACK_STATE_DIR = dir;
const { api: scrapeApi } = await import("../../scrape/dist/api.js");
const { resolveDataHome } = await import("../../scrape/dist/src/queue-paths.js");
const { QUEUE_DIR } = await import("../../scrape/dist/src/queue.js");
assert.equal(resolveDataHome(), join(dir, "scrape"));
assert.equal(QUEUE_DIR, join(dir, "scrape", "queue"), "Scrape must never use a live queue");
const env = { ...process.env, STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const handlers = { serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }) };
const sockets = [];
let websocket, next, browser, scrape, web, page;
let log = "";

const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><link>https://example.com/</link>
<item><title>First entry</title><link>https://example.com/first</link><guid>first</guid><pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>Second entry</title><link>https://example.com/second</link><guid>second</guid><pubDate>Sun, 27 Sep 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

try {
  web = createServer((request, response) => {
    if (request.url === "/page.md") { response.writeHead(200, { "content-type": "text/markdown" }); response.end("# Fixture page\n\nBody with a [link](https://example.com/elsewhere).\n\n<script>alert(1)</script>"); return; }
    response.writeHead(404); response.end("missing");
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${web.address().port}`;

  scrape = await serveApi({ name: "scrape", transport: "socket", env, root });
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["scrape", "serve", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("scrape", scrapeApi), doc("serve"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers), events: { topics } }));
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  const mode = process.env.SCRAPE_NEXT === "start" ? "start" : "dev";
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1200 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 2200, height: 1250 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
  await page.goto(`${origin}/scrape`);
  const extract = page.locator('[data-window="scrape-extract"]');
  const presets = page.locator('[data-window="scrape-presets"]');
  const status = page.locator('[data-window="scrape-status"]');
  const checks = page.locator('[data-window="scrape-checks"]');
  const queue = page.locator('[data-window="scrape-queue"]');
  const feeds = page.locator('[data-window="scrape-feeds"]');
  const convert = page.locator('[data-window="scrape-convert"]');
  await page.getByRole("button", { name: "Spaces · Scrape" }).waitFor();
  await presets.getByRole("button", { name: "Inspect x-tweet" }).waitFor();
  await status.getByText(join(dir, "scrape")).waitFor();
  await queue.getByText("Queue empty", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "scrape-empty.png"), animations: "disabled" });
  // A healthy Scrape (channel open, browser runtime present) raises no attention of its own.
  await page.getByRole("button", { name: "Spaces · Scrape" }).click();
  const item = page.getByRole("menuitem", { name: /Scrape/ });
  console.log("Scrape menu attention:", JSON.stringify(await item.getAttribute("title")), "· other spaces:",
    JSON.stringify(await page.getByRole("menuitem").evaluateAll((items) => items.map((el) => el.getAttribute("title")).filter(Boolean))));
  assert.equal(await item.getAttribute("title"), null);
  await page.keyboard.press("Escape");

  // The preview warns that a claimed host without a matching pattern fails closed.
  const url = extract.getByLabel("URL", { exact: true });
  await url.fill("https://x.com/someone/likes");
  await extract.getByText(/Presets claim x\.com, but none matches this URL/).waitFor();
  await url.fill("https://x.com/someone/status/123");
  await extract.getByRole("link", { name: "x-tweet" }).waitFor();

  // Without consent a private destination is refused and classified; with it, the page renders as
  // untrusted Markdown (raw HTML stays text), and consent clears after the run.
  await url.fill(`${base}/page.md`);
  await extract.getByRole("button", { name: "Run", exact: true }).click();
  await extract.getByRole("button", { name: /127\.0\.0\.1.*page\.md/ }).first().waitFor();
  const refused = await extract.getByRole("alert").or(extract.getByText(/Invalid request|Source unavailable|Provider error|Browser error/)).first().textContent();
  assert.ok(refused, "a refused private fetch shows its failure");
  const consent = extract.getByRole("switch", { name: /Allow browser egress/ });
  await consent.click();
  await extract.getByRole("button", { name: "Run", exact: true }).click();
  await extract.getByRole("heading", { name: "Fixture page" }).waitFor();
  await extract.getByText("<script>alert(1)</script>").waitFor();
  assert.equal(await consent.getAttribute("aria-checked"), "false", "consent clears after each run");
  assert.equal(await extract.getByRole("link", { name: "link" }).getAttribute("target"), "_blank");
  await page.screenshot({ path: join(evidence, "scrape-extract.png"), animations: "disabled" });

  // Queue: submit with consent, see it pending, process it, and find the written file.
  await queue.getByRole("button", { name: "Submit job…" }).click();
  await queue.getByLabel("URL", { exact: true }).fill(`${base}/page.md`);
  const destination = join(dir, "queued.md");
  await queue.getByLabel("Destination file on the Stack machine").fill(destination);
  await queue.getByLabel("Frontmatter (key: value per line)").fill("source: rendered check");
  await queue.getByRole("switch", { name: /Allow browser egress/ }).click();
  await queue.getByRole("button", { name: "Submit", exact: true }).click();
  await queue.getByText(/^Queued/).waitFor();
  // Scrape's own minute drain may process the job before Process now; either way the file is written.
  await queue.getByRole("button", { name: "Process now" }).click();
  await queue.getByText(/written/).waitFor();
  for (let attempt = 0; !existsSync(destination); attempt++) {
    if (attempt > 300) throw new Error("queued job never wrote its destination");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(await readFile(destination, "utf8"), /source: rendered check[\s\S]*# Fixture page/);

  // A direct Markdown 404 fails permanently; the list shows the failed job, which inspects as a job.
  await queue.getByLabel("URL", { exact: true }).fill(`${base}/missing.md`);
  await queue.getByLabel("Destination file on the Stack machine").fill(join(dir, "missing.md"));
  await queue.getByRole("switch", { name: /Allow browser egress/ }).click();
  await queue.getByRole("button", { name: "Submit", exact: true }).click();
  await queue.getByText(/^Queued/).waitFor();
  await queue.getByRole("button", { name: "Process now" }).click();
  await queue.getByText("1 failed", { exact: true }).waitFor();
  await queue.getByRole("button", { name: /Inspect 127\.0\.0\.1.*missing\.md/ }).click();
  await page.getByText("Scrape job · failed").waitFor();
  await page.screenshot({ path: join(evidence, "scrape-queue.png"), animations: "disabled" });
  await queue.getByRole("button", { name: /Inspect 127\.0\.0\.1.*missing\.md/ }).click();

  // Replay proves recorded shapes offline.
  await checks.getByRole("button", { name: "Replay", exact: true }).click();
  await checks.getByText(/\d+ passed · 0 failed/).waitFor();
  // Canaries need explicit consent before they can run.
  assert.equal(await checks.getByRole("button", { name: "Check", exact: true }).isDisabled(), true);
  await checks.getByText("Allow browser egress to run canaries").waitFor();
  await page.screenshot({ path: join(evidence, "scrape-checks.png"), animations: "disabled" });

  // Parse recorded feed content offline; Convert pasted HTML.
  await feeds.getByRole("radio", { name: "Parse recorded" }).or(feeds.getByRole("button", { name: "Parse recorded" })).first().click();
  await feeds.getByLabel("URL the content came from").fill("https://example.com/feed.xml");
  await feeds.getByLabel("Recorded RSS, Atom or HTML").fill(rss);
  await feeds.getByRole("button", { name: "Parse", exact: true }).click();
  await feeds.getByText("First entry", { exact: true }).waitFor();
  await feeds.getByText(/rss · 2 items/).waitFor();
  await convert.getByLabel("HTML", { exact: true }).fill("<h1>Converted</h1><p>Hello <b>there</b></p>");
  await convert.getByRole("button", { name: "Convert", exact: true }).click();
  await convert.getByText(/# Converted/).waitFor();
  await page.screenshot({ path: join(evidence, "scrape-feeds-convert.png"), animations: "disabled" });

  // A preset opens in the inspector from its name and in Extract through Use.
  await presets.getByRole("button", { name: "Inspect deepwiki-wiki-page" }).click();
  await page.getByText(/Scrape preset · official · canary configured/).waitFor();
  const row = presets.locator('[data-node="preset:x-timeline"]');
  await row.getByRole("button", { name: "Use", exact: true }).click();
  assert.equal(await extract.getByLabel("Preset", { exact: true }).inputValue(), "x-timeline");

  assert.deepEqual(errors, []);
  assert.equal(existsSync(join(dir, "scrape", "queue")), true);
  console.log(`scrape rendered check passed; evidence in ${evidence}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "scrape-failure.png"), animations: "disabled" }).catch(() => {});
  if (page) console.error("queue window:", await page.locator('[data-window="scrape-queue"]').innerText().catch(() => "unavailable"));
  console.error(log.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  for (const socket of sockets) await socket.close();
  await scrape?.close();
  await new Promise((resolve) => web ? web.close(resolve) : resolve());
  if (!process.env.SCRAPE_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
