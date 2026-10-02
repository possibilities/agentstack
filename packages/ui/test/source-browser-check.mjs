// Optional rendered check of the Source space. The real Source API runs against a disposable state directory with an
// ephemeral loopback intake; signed webhook requests reach it over HTTP exactly as GitHub's would, and server and
// discovery are fixtures. No live server, receiver, secret or public hook is touched.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/source-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable. SOURCE_NEXT=start uses a prior `next build`.
// SOURCE_EVIDENCE_DIR keeps screenshots. The state directory is short on purpose: Unix socket paths are limited to ~104 bytes on macOS.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { AccessStore } from "../../access/dist/src/store.js";
import { startRemoteUi } from "../../access/dist/src/remote-ui.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp("/tmp/m7a-");
const evidence = process.env.SOURCE_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const maxBytes = 25 * 1024 * 1024;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, STACK_GITHUB_PORT: "0",
  STACK_GITHUB_MAX_PAYLOAD_BYTES: String(maxBytes), NEXT_TELEMETRY_DISABLED: "1" };
const { api: sourceApi } = await import("../../source/dist/api.js");
const handlers = { serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }) };
const sockets = [];
let owner, websocket, next, browser, page, remote, accessStore, log = "";
const call = (name, args = {}) => socketCall(socketPath("source", env), "tools/call", { name, arguments: args });
const activate = async (locator) => { await locator.focus(); await locator.press("Enter"); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const issuePayload = (number, extra = {}, issue = {}) => ({ action: "opened", repository: { id: 3, full_name: "owner/project", owner: { login: "owner" } }, sender: { login: "human" },
  issue: { id: 1000 + number, number, title: `Issue ${number}`, html_url: `https://example.test/issues/${number}`, state: "open", locked: false, milestone: null, labels: ["bug"], ...issue }, ...extra });

// Light, dark and narrow evidence. A window cannot be narrower than its registration on the bench, so the narrow frame temporarily
// sets the window to a phone-sized width (as a person resizing it would) and asserts nothing inside it overflows sideways.
const captures = async (locator, name) => {
  await page.emulateMedia({ colorScheme: "light" });
  await locator.screenshot({ path: join(evidence, `${name}-light.png`), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await locator.screenshot({ path: join(evidence, `${name}-dark.png`), animations: "disabled" });
  const frame = locator.locator("xpath=ancestor-or-self::section[@data-window]");
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.evaluate((el) => { el.dataset.restore = el.style.width; el.style.width = "360px"; });
  await locator.screenshot({ path: join(evidence, `${name}-narrow.png`), animations: "disabled" });
  const overflowing = await frame.evaluate((el) => [...el.querySelectorAll("*")].filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible" && node.clientWidth > 0
    && !node.closest("pre,[data-slot=native-select-wrapper],button,[class*=truncate],svg") && node.scrollWidth > el.clientWidth).map((node) => `${node.tagName}.${String(node.className).slice(0, 60)}`));
  assert.deepEqual(overflowing, [], `${name} overflows at a narrow width`);
  await frame.evaluate((el) => { el.style.width = el.dataset.restore; });
  await page.setViewportSize({ width: 2600, height: 1300 });
  await page.emulateMedia({ colorScheme: "light" });
};

try {
  owner = await serveApi({ name: "source", transport: "socket", env, root });
  const status0 = await call("github_status");
  assert.equal(status0.latestSequence, 0);
  assert.equal(status0.payloads.maxBytes, maxBytes, "the disposable owner carries the smallest legal byte budget");

  const create = async (label, target, publicOrigin) => {
    const endpoint = await call("github_endpoint_create", { id: randomUUID(), label, target, publicOrigin });
    const { secret } = await call("github_endpoint_secret_reveal", { id: endpoint.id, reveal: true });
    return { endpoint, secret };
  };
  const repo = await create("Product repository", { kind: "repository", repository: "owner/project" }, "https://hooks.example.com");
  const org = await create("Acme organization", { kind: "organization", organization: "acme" }, null);
  const app = await create("Integration app", { kind: "app" }, "https://hooks.example.com");
  await call("github_endpoint_update", { id: org.endpoint.id, expectedRevision: org.endpoint.revision, enabled: false });
  const send = async ({ endpoint, secret }, event, payload, options = {}) => {
    const { ingress } = await call("github_status");
    const raw = options.raw ?? JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${ingress.port}${endpoint.path}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": options.deliveryId ?? randomUUID(),
      "x-github-hook-id": "17", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` }, body: raw });
  };
  const accepted = async (...args) => { const response = await send(...args); assert.equal(response.status, 202, await response.clone().text()); return (await response.json()).sequence; };

  // 60 arrivals across events, one with hostile text: markup, a script, a markdown link and a javascript: URL.
  const hostile = "<script>window.__xss=1;alert(1)</script> [click me](javascript:alert(2)) <img src=x onerror=\"window.__xss=2\">";
  let last = 0;
  for (let number = 1; number <= 56; number++) {
    const event = number % 5 === 0 ? "pull_request" : number % 7 === 0 ? "push" : "issues";
    const payload = event === "push" ? { ref: "refs/heads/main", after: "a".repeat(40), repository: { id: 3, full_name: "owner/project" }, sender: { login: "pusher" } }
      : event === "pull_request" ? { action: "opened", number, pull_request: { id: 2000 + number, number, title: `Change ${number}`, html_url: `https://example.test/pull/${number}`, state: "open", merged: false }, repository: { id: 3, full_name: "owner/project" }, sender: { login: "contributor" } }
      : issuePayload(number, {}, number === 3 ? { title: hostile, locked: number % 2 === 0 } : { locked: number % 2 === 0 });
    last = await accepted(repo, event, payload);
  }
  const hostileSequence = 3;
  await accepted(repo, "ping", { zen: "Keep it logically awesome.", hook_id: 17, repository: { id: 3, full_name: "owner/project" } });
  await accepted(app, "future_payload", { arbitrary: "a future event this catalog does not list", note: "kept" });
  const unicode = "héllo 🐙 ".repeat(30_000); // 270,000 characters: nine chunks, more than the reader draws
  const bigSequence = await accepted(app, "future_payload", { arbitrary: unicode });
  last = await accepted(repo, "issues", issuePayload(99, { action: "closed" }));
  const before = await call("github_status");
  assert.ok(before.latestSequence >= 60, `seeded ${before.latestSequence} deliveries`);

  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["source", "serve", "api"]), port: 0 });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  const servedDoc = (name, names, topics) => ({ ...fixtureDoc(name, undefined, websocket.url, publishedJsonSchema), events: topics,
    transports: [{ type: "websocket", description: "Fixture", supported: true, subscriptions: true, endpoint: websocket.url, operations: names, events: Object.keys(topics), routes: [] }] });
  const catalog = [fixtureDoc("source", sourceApi, websocket.url, publishedJsonSchema), servedDoc("serve", serve.names, serve.topics), servedDoc("api", ["docs_snapshot"], {})];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers), events: { topics } }));
  }
  const nextPort = await port();
  const remotePort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  // The same Next serves the local page and the remote UI's proxied pages, as the remote check does.
  Object.assign(env, { STACK_UI_PORT: String(nextPort), STACK_ACCESS_UI_PORT: String(remotePort), STACK_ACCESS_UI_ORIGIN: `https://127.0.0.1:${remotePort}` });
  const mode = process.env.SOURCE_NEXT === "start" ? "start" : "dev";
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1200 || next.exitCode !== null) throw new Error(log.slice(-4000));
    await pause(100);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 2600, height: 1300 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
  const sent = [];
  page.on("websocket", (ws) => ws.on("framesent", (frame) => {
    try { const message = JSON.parse(String(frame.payload)); if (message.method === "tools/call") sent.push(message.params); } catch { /* non-JSON frame */ }
  }));
  const listCalls = () => sent.filter((item) => item.name === "github_delivery_list").map((item) => item.arguments);

  await page.goto(`${origin}/source`);
  const receivers = page.locator('[data-window="source-receivers"]');
  const catalogWindow = page.locator('[data-window="source-catalog"]');
  const ledger = page.locator('[data-window="source-deliveries"]');
  const reader = page.locator('[data-window="source-delivery"]');
  await page.getByRole("button", { name: "Spaces · Source" }).waitFor();
  const rows = ledger.locator('li[data-node^="github-delivery:"]');
  const snapshot = ledger.getByText(/^Snapshot through #\d+$/);

  // Receivers: intake and capacity in words, then each receiver as separate facts, never one "Connected".
  await receivers.getByText(/^127\.0\.0\.1:\d+$/).waitFor();
  await receivers.getByText("Space available", { exact: true }).waitFor();
  await receivers.getByRole("meter", { name: "Retained bodies" }).waitFor();
  assert.equal(await receivers.getByRole("article").count(), 3);
  const repoCard = receivers.locator(`li[data-node="github-receiver:${repo.endpoint.id}"]`);
  const orgCard = receivers.locator(`li[data-node="github-receiver:${org.endpoint.id}"]`);
  await repoCard.getByText("owner/project", { exact: true }).waitFor();
  await orgCard.getByText("Disabled", { exact: true }).first().waitFor();
  await repoCard.getByText(/^\d+ ?m? ?ago$|just now|\d+s ago/).first().waitFor();
  await activate(orgCard.getByRole("button", { name: "Setup facts" }));
  const facts = orgCard.getByRole("list", { name: "Five separate facts" });
  await facts.waitFor();
  for (const [title, word] of [["Local configuration", "Disabled"], ["Public prerequisite", "Origin not set"], ["Remote configuration", "No managed hook recorded"], ["Request receipt", "None read here"], ["Signed arrival", "None observed"]]) {
    const item = facts.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) }).first();
    await item.getByText(word, { exact: true }).waitFor();
  }
  assert.equal(await receivers.getByText("Connected", { exact: false }).count(), 0, "no single 'Connected' claim");
  await orgCard.getByText("public_https_origin_unset", { exact: false }).count();
  await orgCard.getByText(/no public HTTPS origin is set/i).waitFor();
  await orgCard.getByText("Setup steps").click();
  await orgCard.getByText("Publish the webhook path on a public HTTPS origin").waitFor();
  assert.equal(await receivers.locator('a[href^="http"]').count(), 0, "setup URLs are text, never links");
  assert.equal(await receivers.getByRole("button", { name: /reveal|rotate|create|apply|ping|redeliver/i }).count(), 0, "no setup mutation controls in phase 1");
  await activate(orgCard.getByRole("button", { name: "Setup facts" }));
  await activate(repoCard.getByRole("button", { name: "Setup facts" }));
  await repoCard.getByText("Origin set", { exact: true }).waitFor();
  await repoCard.getByText("Delivery observed", { exact: true }).waitFor();
  await captures(receivers, "source-receivers");
  await activate(repoCard.getByRole("button", { name: "Setup facts" }));

  // Ledger: oldest first under a pinned watermark; one page at a time.
  await snapshot.waitFor();
  const through = Number((await snapshot.textContent()).match(/#(\d+)/)[1]);
  assert.equal(through, before.latestSequence);
  await ledger.getByText("25 loaded", { exact: true }).waitFor();
  await ledger.getByText("More to read", { exact: true }).waitFor();
  assert.equal(await rows.count(), 25);
  assert.equal(await rows.first().getAttribute("data-node"), "github-delivery:1", "oldest first");
  const first = listCalls()[0];
  assert.deepEqual([first.after, first.through, first.limit], [0, undefined, 25], "the first page asks for no watermark");
  await page.screenshot({ path: join(evidence, "source-observe-full.png"), animations: "disabled" });

  // Keyboard: rows are reachable and arrow keys move between them; Enter opens the reader.
  const open = (n) => ledger.getByRole("button", { name: new RegExp(`^Open delivery ${n},`) });
  await open(1).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Open delivery 2,")), true);
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Open delivery 25,")), true);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await reader.getByText("#3", { exact: true }).first().waitFor();

  // Concurrent arrivals: announced, never moving the page being read; the watermark stays pinned until asked.
  const arrivalA = await accepted(repo, "issues", issuePayload(101));
  const arrivalB = await accepted(repo, "push", { ref: "refs/heads/main", after: "b".repeat(40), repository: { id: 3, full_name: "owner/project" }, sender: { login: "pusher" } });
  await ledger.getByText("New arrivals available").waitFor();
  assert.equal(await rows.count(), 25, "loaded rows do not change");
  assert.equal(Number((await snapshot.textContent()).match(/#(\d+)/)[1]), through, "the snapshot watermark does not move");
  await ledger.getByText(`newest is #${arrivalB}`, { exact: false }).waitFor();
  assert.equal(await ledger.getByRole("button", { name: "Continue to the newest" }).isDisabled(), true, "an unfinished snapshot cannot continue yet");
  await page.screenshot({ path: join(evidence, "source-new-arrivals.png"), animations: "disabled" });
  const more = ledger.getByRole("button", { name: "Read next page" });
  await more.click();
  await ledger.getByText("50 loaded", { exact: true }).waitFor();
  await more.click();
  await ledger.getByText("End of snapshot", { exact: true }).waitFor();
  assert.equal(await rows.count(), through, "the snapshot ends at its pinned watermark; the two arrivals are not in it");
  const calls = listCalls();
  assert.deepEqual(calls.slice(0, 3).map((item) => [item.after, item.through]), [[0, undefined], [25, through], [50, through]], "exclusive cursor, pinned through");
  assert.equal(await more.count(), 0, "no further page once the snapshot ends");
  await ledger.getByRole("button", { name: "Continue to the newest" }).click();
  await ledger.getByText(`Snapshot through #${arrivalB}`, { exact: true }).waitFor();
  assert.equal(await rows.count(), through + 2);
  assert.equal(await ledger.getByText("New arrivals available").count(), 0);
  assert.deepEqual(listCalls().at(-1), { after: through, limit: 25, filter: {} }, "extension continues from the old watermark and asks for the newest");

  // Filters: a changed filter is a fresh session; scalar types are kept on the wire, filter values stay out of the URL.
  await ledger.getByRole("button", { name: "Filters", exact: false }).click();
  const form = ledger.getByRole("form", { name: "Delivery filters" });
  await form.getByLabel("Events").fill("issues");
  await form.locator("summary").click();
  await form.getByRole("button", { name: "Add predicate" }).click();
  await form.getByLabel("Predicate 1 JSON Pointer path").fill("/issue/locked");
  await form.getByLabel("Predicate 1 value type").selectOption("boolean");
  await form.getByLabel("Predicate 1 value", { exact: true }).fill("false");
  await form.getByRole("button", { name: "Add predicate" }).click();
  await form.getByLabel("Predicate 2 JSON Pointer path").fill("/issue/milestone");
  await form.getByLabel("Predicate 2 value type").selectOption("null");
  await form.getByRole("button", { name: "Apply filter" }).click();
  await ledger.getByText(/^Snapshot through #\d+$/).waitFor();
  await ledger.getByText("End of snapshot", { exact: true }).waitFor();
  const filtered = listCalls().filter((item) => item.filter?.events);
  assert.deepEqual(filtered[0], { after: 0, limit: 25, filter: { events: ["issues"], predicates: [{ path: "/issue/locked", op: "equals", value: false }, { path: "/issue/milestone", op: "equals", value: null }] } });
  assert.equal(typeof filtered[0].filter.predicates[0].value, "boolean");
  assert.strictEqual(filtered[0].filter.predicates[1].value, null);
  const filteredRows = await rows.evaluateAll((items) => items.map((item) => Number(item.getAttribute("data-node").split(":")[1])));
  assert.ok(filteredRows.length > 10 && filteredRows.every((sequence) => sequence % 2 === 1 || sequence === 99 || sequence > 56), `only unlocked issues remain: ${filteredRows.join(",")}`);
  assert.equal(new URL(page.url()).search.includes("locked"), false, "filter values never enter the URL");
  assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes("locked")), false, "nor browser storage");
  await form.getByLabel("Predicate 1 value type").selectOption("string");
  await form.getByRole("button", { name: "Apply filter" }).click();
  await ledger.getByText("No delivery matches this filter").waitFor();
  assert.equal(listCalls().at(-1).filter.predicates[0].value, "false", "the string \"false\" is not the boolean");
  await ledger.getByText("All fields", { exact: false }).count();
  await form.getByRole("button", { name: "Clear filter" }).click();
  await ledger.getByText("25 loaded", { exact: true }).waitFor();
  await ledger.getByRole("button", { name: "Filters", exact: false }).click();

  // Delivery reader: a hostile body is escaped text; chunks load on request; the digest is verified after reconstruction.
  await open(hostileSequence).click();
  await reader.getByText("#3 · issues.opened", { exact: false }).first().waitFor();
  await reader.getByText(/Issue 3|<script>/).first().waitFor();
  await reader.getByText("<script>window.__xss=1;alert(1)</script>", { exact: false }).first().waitFor();
  await reader.getByRole("link", { name: /Product repository/ }).waitFor();
  await reader.getByText(/Event, delivery and hook headers are observed metadata/).waitFor();
  await reader.getByText("Not verified: the digest is checked only after the whole body is loaded.").count();
  await reader.getByRole("button", { name: "Read original body" }).click();
  const text = reader.locator("[data-payload-text]");
  await text.waitFor();
  assert.match(await text.textContent(), /<script>window\.__xss=1;alert\(1\)<\/script> \[click me\]\(javascript:alert\(2\)\) <img src=x onerror=/);
  await reader.getByText(/Digest verified\./).waitFor();
  assert.equal(await reader.locator("script, img, iframe, object, embed, a[href^='javascript'], a[href^='data']").count(), 0, "payload text creates no active element");
  assert.equal(await reader.locator('a[href]').evaluateAll((links) => links.every((link) => link.getAttribute("href").startsWith("/") || link.getAttribute("href").includes("?focus="))), true, "the only links are in-app navigation");
  assert.equal(await page.evaluate(() => window.__xss), undefined, "no payload script or handler ran");
  await reader.getByText("Untrusted content").waitFor();
  await captures(reader, "source-delivery-hostile");

  // A body longer than one chunk loads in bounded chunks; the digest is checked only when it is whole.
  // The delivery is not in the loaded page, so it is opened by link.
  await page.goto(`${origin}/source?focus=${encodeURIComponent(`github-delivery:${bigSequence}`)}`);
  await reader.getByText(`#${bigSequence} · future_payload`, { exact: false }).first().waitFor();
  await reader.getByText("not in catalog").first().waitFor();
  await reader.getByRole("button", { name: "Read original body" }).click();
  await reader.getByText(/32,000 of [\d,]+ characters/).waitFor();
  await reader.getByText("Not verified: the digest is checked only after the whole body is loaded.").waitFor();
  assert.equal(await reader.getByText("Digest verified.", { exact: false }).count(), 0, "a partial body is never verified");
  await reader.getByRole("button", { name: "Load next chunk" }).click();
  await reader.getByText(/64,000 of [\d,]+ characters/).waitFor();
  await reader.getByRole("button", { name: "Load the rest" }).click();
  await reader.getByText("Digest verified.", { exact: false }).waitFor();
  await reader.getByText(/Showing the first 200,000 characters/).waitFor();
  const payloadOffsets = sent.filter((item) => item.name === "github_delivery_payload" && item.arguments.sequence === bigSequence).map((item) => item.arguments.offset);
  assert.deepEqual(payloadOffsets.slice(0, 4), [0, 32_000, 64_000, 96_000], "chunks are read at contiguous offsets of the declared size");
  assert.ok(sent.filter((item) => item.name === "github_delivery_payload").every((item) => item.arguments.limit === 32_000));
  await captures(reader, "source-delivery-large");

  // Deep link to a delivery outside any loaded page: the page loads only the first ledger page, yet the reader has the exact record.
  const deep = hostileSequence + 53; // #56 is beyond the first 25 rows of a fresh session
  await page.goto(`${origin}/source?focus=${encodeURIComponent(`github-delivery:${deep}`)}`);
  await reader.getByText(`#${deep} ·`, { exact: false }).first().waitFor();
  assert.equal(await ledger.locator(`li[data-node="github-delivery:${deep}"]`).count(), 0, "the ledger's first page does not hold it");
  assert.ok(sent.some((item) => item.name === "github_delivery_get" && item.arguments.sequence === deep), "its summary was read on its own");
  await page.goto(`${origin}/source?focus=${encodeURIComponent("github-delivery:99999")}`);
  await reader.getByText("Delivery #99999 does not exist").waitFor();
  // An inspector link resolves it too.
  await page.goto(`${origin}/source`);
  await ledger.getByText("25 loaded", { exact: true }).waitFor();
  await ledger.getByRole("button", { name: "Inspect delivery 7" }).click();
  await page.getByRole("heading", { name: /#7 issues\.opened|#7 push/ }).first().waitFor();
  await page.getByRole("button", { name: "Open in the Delivery reader" }).click();
  await reader.getByText("#7 ·", { exact: false }).first().waitFor();
  await page.getByRole("button", { name: "Close inspector" }).click().catch(() => {});

  // Payload maintenance: exact rows → plan → apply → receipt; summaries stay and the rows say "Original cleared".
  const status = async () => (await call("github_status"));
  const usedBefore = (await status()).payloads;
  const maintenance = ledger.locator("details").filter({ has: page.locator("summary", { hasText: "Maintenance" }) });
  await activate(maintenance.locator("summary"));
  await maintenance.getByText("0 chosen").waitFor();
  assert.equal(await maintenance.getByRole("button", { name: "Prepare clearing original payloads" }).isDisabled(), true, "nothing chosen, nothing to prepare");
  await ledger.getByRole("checkbox", { name: "Choose delivery 1 for payload clearing" }).check();
  await ledger.getByRole("checkbox", { name: "Choose delivery 2 for payload clearing" }).check();
  await maintenance.getByText("2 chosen").waitFor();
  await activate(maintenance.getByRole("button", { name: "Prepare clearing original payloads" }));
  const plan = maintenance.getByRole("region", { name: /source plan payload_clear/ });
  await plan.waitFor();
  await plan.getByText("1", { exact: true }).first().waitFor();
  assert.equal(await ledger.getByRole("checkbox", { name: "Choose delivery 3 for payload clearing" }).isDisabled(), true, "the choice freezes while a plan is shown");
  await captures(maintenance, "source-payload-plan");
  await activate(maintenance.getByRole("button", { name: "Clear original payloads", exact: true }));
  await maintenance.getByRole("region", { name: /source receipt completed/ }).waitFor();
  await ledger.locator('li[data-node="github-delivery:1"]').getByText("Original cleared", { exact: true }).waitFor();
  await ledger.locator('li[data-node="github-delivery:2"]').getByText("Original cleared", { exact: true }).waitFor();
  assert.equal((await call("github_delivery_get", { sequence: 1 })).payloadClearedAt !== null, true);
  assert.ok((await call("github_delivery_list", {})).entries.length > 0, "summaries remain");
  assert.equal((await status()).payloads.count, usedBefore.count - 2);
  await captures(maintenance, "source-payload-receipt");
  await activate(maintenance.getByRole("button", { name: "Close receipt" }));
  await ledger.getByRole("checkbox", { name: /Delivery 1 payload already cleared/ }).waitFor();

  // Cleanup invalidation: a reader holding a loaded body is replaced by the cleared marker when another operator clears it.
  await open(4).click();
  await reader.getByRole("button", { name: "Read original body" }).click();
  await reader.locator("[data-payload-text]").waitFor();
  const plan4 = await call("github_history_plan", { sequences: [4] });
  await call("github_history_clear", { planId: plan4.id, expectedRevision: plan4.revision, requestId: randomUUID() });
  await reader.getByText("Original payload cleared", { exact: false }).first().waitFor();
  assert.equal(await reader.locator("[data-payload-text]").count(), 0, "the loaded text is discarded");
  await ledger.locator('li[data-node="github-delivery:4"]').getByText("Original cleared", { exact: true }).waitFor();
  await activate(maintenance.locator("summary"));

  // Capacity: reaching the byte budget means intake is refused (507), stated plainly, and clearing the two big bodies recovers it.
  const usage = (await status()).payloads;
  const remaining = usage.maxBytes - usage.bytes;
  const fillerBytes = Math.floor((remaining - 1) / 2);
  const filler = (bytes) => JSON.stringify({ arbitrary: "x".repeat(bytes - 16) });
  const fillA = await accepted(app, "future_payload", null, { raw: filler(fillerBytes) });
  const fillB = await accepted(app, "future_payload", null, { raw: filler(remaining - fillerBytes) });
  const full = await status();
  assert.equal(full.payloads.bytes, full.payloads.maxBytes, "the budget is exactly spent");
  await receivers.getByText("Full · intake refused", { exact: true }).waitFor();
  await receivers.getByText(/507 github_storage_full/).first().waitFor();
  await ledger.getByText("Full · intake refused", { exact: true }).waitFor();
  const refusedBefore = (await call("github_endpoint_get", { id: app.endpoint.id })).rejected;
  const refused = await send(app, "future_payload", { arbitrary: "no room" });
  assert.equal(refused.status, 507);
  await receivers.locator(`li[data-node="github-receiver:${app.endpoint.id}"]`).getByText("github_storage_full", { exact: true }).waitFor();
  assert.equal((await call("github_endpoint_get", { id: app.endpoint.id })).rejected, refusedBefore + 1);
  await receivers.getByText(/does not retrieve deliveries GitHub could not make/).first().waitFor();
  await captures(receivers, "source-capacity-full");
  await page.screenshot({ path: join(evidence, "source-capacity-full-bench.png"), animations: "disabled" });
  // The newest arrivals include the two fillers; continue to them, choose them and clear.
  await ledger.getByRole("button", { name: "Fresh snapshot" }).click();
  await ledger.getByText(`Snapshot through #${fillB}`, { exact: true }).waitFor();
  await ledger.getByRole("button", { name: "Read next page" }).click();
  await ledger.getByRole("button", { name: "Read next page" }).click();
  await ledger.getByText("End of snapshot", { exact: true }).waitFor();
  await activate(maintenance.locator("summary"));
  await ledger.getByRole("checkbox", { name: `Choose delivery ${fillA} for payload clearing` }).check();
  await ledger.getByRole("checkbox", { name: `Choose delivery ${fillB} for payload clearing` }).check();
  await activate(maintenance.getByRole("button", { name: "Prepare clearing original payloads" }));
  await maintenance.getByRole("region", { name: /source plan payload_clear/ }).waitFor();
  await activate(maintenance.getByRole("button", { name: "Clear original payloads", exact: true }));
  await maintenance.getByRole("region", { name: /source receipt completed/ }).waitFor();
  await receivers.getByText(/Space available|Refused a delivery/).first().waitFor();
  assert.equal(await receivers.getByText("Full · intake refused").count(), 0, "clearing frees the budget");
  await receivers.getByText("Refused a delivery", { exact: true }).waitFor();
  assert.equal((await send(app, "future_payload", { arbitrary: "now it fits" })).status, 202);
  await receivers.getByText("Space available", { exact: true }).waitFor();
  await activate(maintenance.getByRole("button", { name: "Close receipt" }));

  // Catalog: variants, hook types and search; a schema loads one chunk at a time and never claims to validate.
  await catalogWindow.getByText(/\d+ of \d+ events/).waitFor();
  await catalogWindow.getByLabel("Search events and actions").fill("review_requested");
  await catalogWindow.getByRole("button", { name: /^pull_request/ }).first().click();
  await catalogWindow.getByText("review_requested", { exact: true }).first().waitFor();
  await catalogWindow.getByRole("button", { name: "Inspect schema" }).click();
  await catalogWindow.getByText(/\d[\d,]* of [\d,]+ characters/).waitFor();
  await catalogWindow.getByText(/it is not used to reject anything that arrives/).waitFor();
  await catalogWindow.getByLabel("Hook type").selectOption("marketplace");
  await catalogWindow.getByText(/\d+ of \d+ events/).waitFor();
  await catalogWindow.getByLabel("Search events and actions").fill("");
  await catalogWindow.getByLabel("Variant").selectOption("ghes-3.19");
  await catalogWindow.getByText(/\d+ of \d+ events/).waitFor();
  assert.ok(sent.some((item) => item.name === "github_event_catalog" && item.arguments.variant === "ghes-3.19"), "a GHES variant is read from its own pinned bundle");
  await catalogWindow.getByLabel("Variant").selectOption("api.github.com");
  await catalogWindow.getByLabel("Hook type").selectOption("");
  await catalogWindow.getByLabel("Search events and actions").fill("issues");
  await catalogWindow.getByRole("button", { name: /^issues/ }).first().click();
  await captures(catalogWindow, "source-catalog");

  // Remote: an Access-authenticated viewer reads all four windows and nothing mutates, maintenance is not offered, and even control scope
  // gains no Source mutation. The local-only reads (setup is a read; secrets and maintenance are not) are fenced at the gateway.
  const remoteOrigin = `https://127.0.0.1:${remotePort}`;
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  accessStore = new AccessStore(dir);
  remote = await startRemoteUi({ store: accessStore, env, host: "127.0.0.1", port: remotePort, root: await gatewayRoot(dir, ["source", "serve", "api"]), verify: async () => {} }, tls);
  const secret = randomBytes(32).toString("base64url");
  const pairing = accessStore.pair({ requestId: randomUUID(), label: "Source check", kind: "browser", scopes: ["ui:view"], redemptionSecret: secret });
  accessStore.approve(pairing.id, pairing.code, true);
  const credential = accessStore.redeem(pairing.id, secret);
  const session = accessStore.startUi(credential.refreshToken, randomUUID());
  const remoteContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 2600, height: 1300 }, reducedMotion: "reduce" });
  await remoteContext.addCookies([{ name: "__Host-stack_ui", value: session.accessToken, url: remoteOrigin, secure: true, httpOnly: true, sameSite: "Strict" },
    { name: "__Host-stack_ui_refresh", value: session.refreshToken, url: remoteOrigin, secure: true, httpOnly: true, sameSite: "Strict" }]);
  const remotePage = await remoteContext.newPage();
  remotePage.setDefaultTimeout(60_000);
  const remoteErrors = [];
  remotePage.on("pageerror", (error) => remoteErrors.push(error.message));
  const remoteResponse = await remotePage.goto(`${remoteOrigin}/source`);
  assert.equal(remoteResponse.status(), 200, `remote UI answered ${remoteResponse.status()}`);
  await remotePage.locator('[data-remote-scope="view"]').waitFor({ timeout: 20_000 }).catch(async (error) => {
    await remotePage.screenshot({ path: join(evidence, "source-remote-failure.png"), animations: "disabled" }).catch(() => {});
    throw new Error(`${error.message}\n${(await remotePage.locator("body").innerText()).slice(0, 600)}\nconsole/page errors: ${remoteErrors.join(" | ")}`);
  });
  const rReceivers = remotePage.locator('[data-window="source-receivers"]'), rLedger = remotePage.locator('[data-window="source-deliveries"]');
  const rReader = remotePage.locator('[data-window="source-delivery"]'), rCatalog = remotePage.locator('[data-window="source-catalog"]');
  await rReceivers.getByText(/^127\.0\.0\.1:\d+$/).waitFor();
  await rReceivers.getByRole("article").first().waitFor();
  await rLedger.getByText(/^Snapshot through #\d+$/).waitFor();
  await rLedger.getByRole("button", { name: /^Open delivery 3,/ }).click();
  await rReader.getByRole("button", { name: "Read original body" }).click();
  await rReader.locator("[data-payload-text]").waitFor();
  await rReader.getByText(/Digest verified\./).waitFor();
  await rCatalog.getByText(/\d+ of \d+ events/).waitFor();
  const rOrg = rReceivers.locator(`li[data-node="github-receiver:${org.endpoint.id}"]`);
  await activate(rOrg.getByRole("button", { name: "Setup facts" }));
  await rOrg.getByText("Public prerequisite").waitFor();
  assert.equal(await remotePage.locator("summary", { hasText: "Maintenance" }).count(), 0, "a remote viewer is not offered payload maintenance");
  assert.equal(await remotePage.getByRole("checkbox").count(), 0, "no choose-for-clearing controls");
  assert.equal(await remotePage.getByRole("button", { name: /Clear original payloads|Prepare clearing/ }).count(), 0);
  const remoteCalls = (calls) => remotePage.evaluate((list) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.origin.replace(/^https:/, "wss:")}/websocket`);
    const results = [];
    ws.onopen = () => list.forEach(([pkg, name, args], index) => ws.send(JSON.stringify({ id: index + 1, method: "tools/call", params: { package: pkg, name, arguments: args } })));
    ws.onmessage = (event) => { results.push(JSON.parse(event.data)); if (results.length === list.length) { resolve(results.sort((a, b) => a.id - b.id)); ws.close(); } };
    ws.onerror = () => reject(new Error("remote socket failed"));
  }), calls);
  const zero = "00000000-0000-4000-8000-000000000001";
  const fenced = [["source", "github_history_plan", { sequences: [1] }], ["source", "github_history_clear", { planId: zero, expectedRevision: "x", requestId: zero }],
    ["source", "github_state_receipt_get", { requestId: zero }], ["source", "github_endpoint_secret_reveal", { id: org.endpoint.id, reveal: true }],
    ["source", "github_endpoint_update", { id: org.endpoint.id, expectedRevision: 1, enabled: true }], ["source", "github_hook_list", { endpointId: org.endpoint.id }],
    ["source", "github_watch_create", { id: randomUUID(), label: "Remote", filter: {} }], ["source", "github_auth_status", {}]];
  for (const result of await remoteCalls(fenced)) assert.ok(result.error, `the remote gateway refuses ${JSON.stringify(result)}`);
  const allowed = await remoteCalls([["source", "github_status", {}], ["source", "github_delivery_get", { sequence: 3 }], ["source", "github_setup_read", { id: org.endpoint.id }]]);
  for (const result of allowed) assert.ok(!result.error, `a read-only Source operation is available remotely: ${JSON.stringify(result.error)}`);
  const grant = accessStore.inventory().grants.find((entry) => entry.client_id === credential.clientId);
  accessStore.updateGrant(grant.id, 1, ["ui:view", "ui:control"], []);
  await remotePage.locator('[data-remote-scope="control"]').waitFor();
  // The gateway fences open connections when a grant changes; let them reconnect before looking.
  await rLedger.getByText(/^Snapshot through #\d+$/).waitFor();
  await rReceivers.getByRole("img", { name: "Live" }).first().waitFor();
  assert.equal(await remotePage.locator("summary", { hasText: "Maintenance" }).count(), 0, "control scope still offers no Source maintenance");
  for (const result of await remoteCalls(fenced)) assert.ok(result.error, "control scope gains no Source mutation: the source package has no remote mutation allowlist");
  await remotePage.screenshot({ path: join(evidence, "source-remote-readonly.png"), animations: "disabled" });
  assert.deepEqual(remoteErrors, [], `remote page errors: ${remoteErrors.join(" | ")}`);

  await page.screenshot({ path: join(evidence, "source-bench-final.png"), animations: "disabled" });
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  console.log("source browser check passed");
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "source-failure.png"), animations: "disabled" }).catch(() => {});
  console.error(error);
  console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  next?.kill("SIGTERM");
  await remote?.close().catch(() => {});
  accessStore?.close();
  await websocket?.close().catch(() => {});
  for (const socket of sockets) await socket.close().catch(() => {});
  await owner?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
