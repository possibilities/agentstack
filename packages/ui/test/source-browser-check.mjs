// Optional rendered check of the Source space (observe, then watches). The real Source API runs against a disposable state directory with an
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
import { DatabaseSync } from "node:sqlite";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath, StateJournal } from "@stack/api";
import { AccessStore } from "../../access/dist/src/store.js";
import { startRemoteUi } from "../../access/dist/src/remote-ui.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp("/tmp/m7b-");
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
  // The shared fixture drops occurrence-source declarations; the real discovery carries them, and the Watches window links to that reference section.
  for (const operation of catalog[0].operations) {
    const declared = sourceApi.operations.find((candidate) => candidate.name === operation.name)?.eventSource;
    if (declared) operation.eventSource = declared;
  }
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
  // Notices can be held back, then released, so a check can act while this tab has not yet heard about another consumer's change. Replies are never held.
  const hold = { on: false, held: [], ws: null };
  await page.routeWebSocket((url) => url.pathname.endsWith("/websocket"), (ws) => {
    const server = ws.connectToServer();
    hold.ws = ws;
    server.onMessage((message) => { if (hold.on && typeof message === "string" && message.includes('"events/changed"')) hold.held.push(message); else ws.send(message); });
    ws.onMessage((message) => server.send(message));
  });
  const release = () => { hold.on = false; for (const message of hold.held.splice(0)) hold.ws?.send(message); };
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

  // ===================================================================================================================
  // Watches (phase 2): definitions, frozen creation, the not-pinned inbox, explicit review and acknowledgement.
  // ===================================================================================================================
  const watchesWindow = page.locator('[data-window="source-watches"]');
  const watchCalls = (name) => sent.filter((item) => item.name === name).map((item) => item.arguments);
  const ackCalls = () => watchCalls("github_watch_acknowledge");
  const cardFor = (watchId) => watchesWindow.locator(`li[data-node="github-watch:${watchId}"]`);
  const ownerWatch = async (watchId) => (await call("github_watch_list")).watches.find((item) => item.id === watchId);
  const dialogCaptures = async (name) => {
    const dialog = page.getByRole("alertdialog");
    await page.emulateMedia({ colorScheme: "light" });
    await dialog.screenshot({ path: join(evidence, `${name}-light.png`), animations: "disabled" });
    await page.emulateMedia({ colorScheme: "dark" });
    await dialog.screenshot({ path: join(evidence, `${name}-dark.png`), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.screenshot({ path: join(evidence, `${name}-narrow.png`), animations: "disabled" });
    assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `${name} has no horizontal overflow at a narrow width`);
    await page.setViewportSize({ width: 2600, height: 1300 });
    await page.emulateMedia({ colorScheme: "light" });
  };
  const head = (await call("github_status")).latestSequence;

  await page.goto(`${origin}/source`);
  await watchesWindow.getByText("No watches", { exact: true }).waitFor();
  await watchesWindow.getByText(/Polling, native admission and Worker intake never advance the consumption cursor/).waitFor();
  assert.deepEqual(ackCalls(), [], "viewing the empty space acknowledges nothing");
  await captures(watchesWindow, "source-watches-empty");

  // Create from now, taking the Deliveries filter: the form shows the filter, the review shows the exact request, and nothing is sent by reviewing.
  await ledger.getByText(/^Snapshot through #\d+$/).waitFor();
  await ledger.getByRole("button", { name: "Filters", exact: false }).click();
  const ledgerForm = ledger.getByRole("form", { name: "Delivery filters" });
  await ledgerForm.getByLabel("Events").fill("pull_request");
  await ledgerForm.getByRole("button", { name: "Apply filter" }).click();
  await ledger.getByText("End of snapshot", { exact: true }).waitFor();
  await watchesWindow.getByRole("button", { name: "New watch" }).click();
  const createForm = watchesWindow.getByRole("form", { name: "New watch" });
  assert.equal(await createForm.getByRole("button", { name: "From current ledger filter" }).isEnabled(), true);
  await createForm.getByRole("button", { name: "From current ledger filter" }).click();
  assert.equal(await createForm.getByLabel("Events").inputValue(), "pull_request", "the ledger's filter is the watch's draft");
  await createForm.getByLabel("Label", { exact: true }).fill("Pull requests");
  assert.equal(await createForm.getByRole("radio", { name: /^Now \(default\)/ }).isChecked(), true, "start now is the default");
  await captures(createForm, "source-watch-create-edit");
  await createForm.getByRole("button", { name: "Review definition" }).click();
  const requestText = createForm.getByLabel("Exact github_watch_create request");
  await createForm.locator("summary", { hasText: "Exact request" }).click();
  await requestText.waitFor();
  const nowInput = JSON.parse(await requestText.textContent());
  assert.deepEqual(nowInput, { filter: { events: ["pull_request"] }, id: nowInput.id, label: "Pull requests", start: "now" });
  await createForm.getByText(/Starts now: the owner fixes the start/).waitFor();
  assert.equal(watchCalls("github_watch_create").length, 0, "reviewing creates nothing");
  assert.equal((await call("github_watch_list")).watches.length, 0);
  await captures(createForm, "source-watch-create-review");
  await activate(createForm.getByRole("button", { name: "Create watch" }));
  await watchesWindow.getByText(/Created .Pull requests/).waitFor();
  assert.deepEqual(watchCalls("github_watch_create"), [nowInput], "exactly the reviewed request was sent");
  const nowWatch = await ownerWatch(nowInput.id);
  assert.equal(nowWatch.startAfter, head, "start now: after the newest arrival");
  assert.equal(nowWatch.acknowledgedThrough, head);
  assert.deepEqual(nowWatch.filter, { events: ["pull_request"] });
  await activate(watchesWindow.getByRole("button", { name: "Done" }));
  await ledgerForm.getByRole("button", { name: "Clear filter" }).click();
  await ledger.getByText("25 loaded", { exact: true }).waitFor();

  // Create with a backfill and a payload predicate: an impossible start is refused before anything is sent, the review warns about cleared bodies, and
  // the delivery whose body was cleared (#1) cannot match the predicate.
  for (let n = 120; n < 132; n++) await accepted(repo, "issues", issuePayload(n, {}, { locked: false }));
  const newest = (await call("github_status")).latestSequence;
  await watchesWindow.getByRole("button", { name: "New watch" }).click();
  await createForm.getByLabel("Label", { exact: true }).fill("Unlocked issues");
  await createForm.getByLabel("Events").fill("issues");
  await createForm.locator("summary", { hasText: "Advanced" }).click();
  await createForm.getByRole("button", { name: "Add predicate" }).click();
  await createForm.getByLabel("Predicate 1 JSON Pointer path").fill("/issue/locked");
  await createForm.getByLabel("Predicate 1 value type").selectOption("boolean");
  await createForm.getByLabel("Predicate 1 value", { exact: true }).fill("false");
  await createForm.getByRole("radio", { name: /Backfill after sequence N/ }).check();
  await createForm.getByRole("textbox", { name: "Backfill after sequence" }).fill(String(newest + 5));
  await createForm.getByRole("button", { name: "Review definition" }).click();
  await createForm.getByRole("alert").getByText(/beyond the newest arrival/).waitFor();
  assert.equal(watchCalls("github_watch_create").length, 1, "an impossible start is refused before anything is sent");
  await createForm.getByRole("textbox", { name: "Backfill after sequence" }).fill("0");
  await createForm.getByRole("button", { name: "Review definition" }).click();
  await createForm.locator("summary", { hasText: "Exact request" }).click();
  const backfillInput = JSON.parse(await requestText.textContent());
  assert.deepEqual(backfillInput.filter, { events: ["issues"], predicates: [{ op: "equals", path: "/issue/locked", value: false }] });
  assert.strictEqual(backfillInput.filter.predicates[0].value, false, "the boolean false stays a boolean");
  assert.strictEqual(backfillInput.start, 0);
  await createForm.getByText(/Backfills from after #0/).waitFor();
  await createForm.getByRole("list", { name: "Cautions" }).getByText(/cannot match a payload predicate against a delivery whose original payload was cleared/).waitFor();
  await captures(createForm, "source-watch-backfill-review");
  await activate(createForm.getByRole("button", { name: "Create watch" }));
  await watchesWindow.getByText(/Created .Unlocked issues/).waitFor();
  const issuesId = backfillInput.id;
  assert.deepEqual(watchCalls("github_watch_create").at(-1), backfillInput);
  const issuesWatch = await ownerWatch(issuesId);
  assert.equal(issuesWatch.startAfter, 0);
  await activate(watchesWindow.getByRole("button", { name: "Done" }));
  const issuesCard = cardFor(issuesId);
  const prCard = cardFor(nowInput.id);
  await issuesCard.getByText("Notifications on", { exact: true }).waitFor();
  const issuesRead = await call("github_watch_read", { id: issuesId, limit: 1 });
  assert.ok(issuesRead.pending > 25, `the backfill matched ${issuesRead.pending} retained deliveries, more than one page`);
  await issuesCard.getByLabel("Consumption").getByText(String(issuesRead.pending), { exact: true }).waitFor();
  await prCard.getByLabel("Consumption").getByText("0", { exact: true }).waitFor();
  await captures(watchesWindow, "source-watches-list");

  // The inbox is the oldest pending page from the owner's cursor, not a pinned snapshot: no `through` is ever sent; arrivals are announced
  // and loaded only on request; the loaded rows never move.
  // Creating a watch selects it: its inbox is already open (reading it acknowledges nothing).
  await issuesCard.getByRole("button", { name: "Close inbox" }).waitFor();
  const inboxRows = issuesCard.locator("li[data-entry]");
  await inboxRows.first().waitFor();
  await issuesCard.getByText("Not a pinned snapshot.").waitFor();
  const entriesNow = () => inboxRows.evaluateAll((items) => items.map((item) => Number(item.getAttribute("data-entry"))));
  const page0 = await entriesNow();
  assert.ok(page0.length > 0 && page0.length <= 25, `first page: ${page0.length} entries`);
  assert.equal(page0[0], 3, "#1 matched in the filter but its body was cleared, so a payload predicate never matched it; #2 is locked");
  assert.equal(await issuesCard.locator('li[data-entry="1"]').count(), 0);
  assert.deepEqual(page0, [...page0].sort((a, b) => a - b), "oldest first");
  const firstRead = watchCalls("github_watch_read").find((item) => item.id === issuesId && item.limit === 25);
  assert.deepEqual(firstRead, { id: issuesId, limit: 25 }, "the first read asks for the owner's cursor: no after, no through");
  const arrival1 = await accepted(repo, "issues", issuePayload(201, {}, { locked: false }));
  const arrival2 = await accepted(repo, "issues", issuePayload(202, {}, { locked: false }));
  await issuesCard.getByText("New matches arrived").waitFor();
  assert.deepEqual(await entriesNow(), page0, "loaded rows do not move when matches arrive");
  const expectedAfters = [];
  const nextPage = issuesCard.getByRole("button", { name: "Load next page" });
  for (let guard = 0; guard < 8; guard++) {
    if (await nextPage.isDisabled()) break;
    const loaded = await entriesNow();
    expectedAfters.push(loaded.at(-1));
    await nextPage.click();
    await inboxRows.nth(loaded.length).waitFor();
  }
  const all = await entriesNow();
  assert.deepEqual(all.slice(-2), [arrival1, arrival2], "the two arrivals are appended below what was already read");
  assert.deepEqual(all, [...all].sort((a, b) => a - b));
  const tailReads = watchCalls("github_watch_read").filter((item) => item.id === issuesId && item.limit === 25 && item.after !== undefined).map((item) => item.after);
  assert.deepEqual(tailReads.slice(0, expectedAfters.length), expectedAfters, "each page continues after the last entry loaded");
  assert.ok(watchCalls("github_watch_read").every((item) => !("through" in item)), "the owner offers no pin for a watch read, and none is sent");
  assert.deepEqual(ackCalls(), [], "paging acknowledges nothing");
  assert.equal((await ownerWatch(issuesId)).acknowledgedThrough, 0);
  await captures(watchesWindow, "source-watch-inbox");

  // Reloading the page, opening an inbox and navigating never acknowledge.
  await page.reload();
  await activate(issuesCard.getByRole("button", { name: "Open inbox" }));
  await inboxRows.first().waitFor();
  await page.goto(`${origin}/source?focus=${encodeURIComponent(`github-watch:${issuesId}`)}`);
  await inboxRows.first().waitFor();
  assert.deepEqual(ackCalls(), [], "reload, navigation and links acknowledge nothing");
  assert.equal((await ownerWatch(issuesId)).acknowledgedThrough, 0);

  // Review by keyboard: tick one entry, open another's details, mark through a third. Acknowledging names the whole range and the entries
  // marked without opening their details, and nothing moves until it is confirmed.
  const reviewed = await entriesNow();
  const [a, b, c, d] = reviewed;
  const entry = (n) => issuesCard.locator(`li[data-entry="${n}"]`);
  const acknowledgeButton = issuesCard.getByRole("button", { name: /^Acknowledge through/ });
  assert.equal(await acknowledgeButton.isDisabled(), true, "nothing is reviewed yet");
  const markA = entry(a).getByRole("checkbox", { name: `Entry ${a} reviewed` });
  await markA.focus();
  await markA.press("Space");
  assert.equal(await markA.isChecked(), true);
  assert.equal(await acknowledgeButton.isDisabled(), false);
  await activate(entry(b).getByRole("button", { name: "Details" }));
  await entry(b).getByText(`Open delivery #${b} in the reader`).waitFor();
  await activate(entry(c).getByRole("button", { name: "Mark through here" }));
  assert.equal(await entry(b).getByRole("checkbox").isChecked(), true, "marking through also marks the entries between");
  assert.equal(await entry(d).getByRole("checkbox").isChecked(), false);
  await issuesCard.getByText(new RegExp(`Reviewed #${a} to #${c} · 3 of \\d+ loaded entries`)).waitFor();
  await issuesCard.getByText(/2 of these were marked without opening their details/).waitFor();
  await captures(watchesWindow, "source-watch-review");
  await activate(issuesCard.getByRole("button", { name: `Acknowledge through #${c}…` }));
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText(`Acknowledge through #${c}?`).waitFor();
  const dialogText = await dialog.textContent();
  assert.match(dialogText, new RegExp(`from #0 to #${c}, covering 3 entries: #${a}, #${b}, #${c}`));
  assert.match(dialogText, new RegExp(`2 entries were marked reviewed without opening their details and will be acknowledged anyway: #${a}, #${c}`));
  assert.match(dialogText, /stay pending/);
  assert.match(dialogText, /compare-and-set/);
  await dialogCaptures("source-watch-acknowledge-confirm");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.deepEqual(ackCalls(), [], "cancelling acknowledges nothing");
  assert.equal((await ownerWatch(issuesId)).acknowledgedThrough, 0);
  await activate(issuesCard.getByRole("button", { name: `Acknowledge through #${c}…` }));
  await activate(page.getByRole("alertdialog").getByRole("button", { name: `Acknowledge through #${c}`, exact: true }));
  await issuesCard.getByText(new RegExp(`Acknowledged through #${c} · 3 entries`)).waitFor();
  assert.deepEqual(ackCalls(), [{ id: issuesId, through: c, expectedAcknowledgedThrough: 0 }], "one acknowledgement, compare-and-set against the cursor the rows were read from");
  assert.equal((await ownerWatch(issuesId)).acknowledgedThrough, c);
  await inboxRows.first().waitFor();
  assert.equal((await entriesNow())[0], d, "the inbox was read again from the new cursor");
  assert.equal(await issuesCard.locator('input[type="checkbox"]:checked').count(), 0, "no mark survives a reread");
  await issuesCard.getByText(new RegExp(`Acknowledged through #${c} · 3 entries`)).scrollIntoViewIfNeeded();
  await captures(watchesWindow, "source-watch-acknowledged");

  // A cursor moved by another consumer while notices are held back: the confirmed request is refused (compare-and-set), the inbox is read again from
  // the owner's cursor, every mark is cleared, and nothing is retried.
  const next2 = await entriesNow();
  const [e, f, g] = next2;
  await activate(entry(f).getByRole("button", { name: "Mark through here" }));
  await issuesCard.getByText(new RegExp(`Reviewed #${e} to #${f} · 2 of`)).waitFor();
  await activate(issuesCard.getByRole("button", { name: `Acknowledge through #${f}…` }));
  await page.getByRole("alertdialog").getByText(`Acknowledge through #${f}?`).waitFor();
  hold.on = true;
  await call("github_watch_acknowledge", { id: issuesId, through: e, expectedAcknowledgedThrough: c });
  await page.getByRole("alertdialog").getByRole("button", { name: `Acknowledge through #${f}`, exact: true }).click();
  await issuesCard.getByText("Nothing was acknowledged.").waitFor();
  release();
  assert.deepEqual(ackCalls().at(-1), { id: issuesId, through: f, expectedAcknowledgedThrough: c }, "the stale request named the cursor it was reviewed against");
  assert.equal(ackCalls().length, 2, "the refusal is not retried");
  assert.equal((await ownerWatch(issuesId)).acknowledgedThrough, e, "the other consumer's cursor stands; this window did not move it");
  await issuesCard.getByText(new RegExp(`it is now #${e}`)).waitFor();
  assert.equal((await entriesNow())[0], f, "the rows are those pending at the cursor as it is now");
  assert.equal(await issuesCard.locator('input[type="checkbox"]:checked').count(), 0, "review starts over");
  assert.equal(await acknowledgeButton.isDisabled(), true, "nothing can be acknowledged until it is reviewed again");
  await issuesCard.getByText("Nothing was acknowledged.").scrollIntoViewIfNeeded();
  await captures(watchesWindow, "source-watch-conflict");
  await issuesCard.getByRole("button", { name: "Dismiss" }).click();

  // The cursor moving while a mark is held (with notices flowing) replaces the rows and clears the mark; this window acknowledges nothing.
  await activate(entry(f).getByRole("button", { name: "Mark through here" }));
  await call("github_watch_acknowledge", { id: issuesId, through: f, expectedAcknowledgedThrough: e });
  await issuesCard.getByText(new RegExp(`The acknowledged cursor moved from #${e} to #${f}`)).waitFor();
  assert.equal(await issuesCard.locator('input[type="checkbox"]:checked').count(), 0);
  assert.equal(ackCalls().length, 2, "only the one request this window made");
  assert.equal((await entriesNow())[0], g);
  await issuesCard.getByRole("button", { name: "Dismiss" }).click();

  // Notifications off still capture matches; label edits use the configuration revision, and a stale one is refused.
  await activate(prCard.getByRole("button", { name: "Open inbox" }));
  await prCard.getByText("Nothing is pending.", { exact: false }).waitFor();
  const prSettings = prCard.locator("details").filter({ has: page.locator("summary", { hasText: "Definition and settings" }) });
  await activate(prSettings.locator("summary"));
  await prSettings.getByText("Notifications / occurrence polling", { exact: true }).waitFor();
  assert.equal(await prSettings.getByRole("button", { name: /New watch from this filter/ }).isVisible(), true);
  await prSettings.getByText(/A filter is never edited: a different filter is a new watch/).waitFor();
  await activate(prSettings.getByRole("button", { name: "Turn off" }));
  await prCard.getByText("Notifications off", { exact: true }).first().waitFor();
  const paused = await ownerWatch(nowInput.id);
  assert.equal(paused.enabled, false);
  assert.equal(paused.revision, nowWatch.revision + 1);
  assert.equal(paused.acknowledgedThrough, nowWatch.acknowledgedThrough, "configuration changes never touch the consumption cursor");
  assert.deepEqual(watchCalls("github_watch_update").at(-1), { id: nowInput.id, expectedRevision: nowWatch.revision, enabled: false });
  await prCard.getByText(/Notifications and occurrence polling are off for this watch\. Matching deliveries are still captured/).waitFor();
  const prSequence = await accepted(repo, "pull_request", { action: "opened", number: 301, pull_request: { id: 2301, number: 301, title: "Change 301", html_url: "https://example.test/pull/301", state: "open", merged: false },
    repository: { id: 3, full_name: "owner/project" }, sender: { login: "human" } });
  assert.equal((await call("github_watch_read", { id: nowInput.id, limit: 5 })).pending, 1, "a disabled watch still captured the match");
  await prCard.getByText(/1 pending entry arrived after this inbox was read/).waitFor();
  await prCard.getByRole("button", { name: "Load next page" }).click();
  await prCard.locator(`li[data-entry="${prSequence}"]`).waitFor();
  assert.deepEqual(ackCalls().length, 2, "a captured match is not acknowledged");
  await captures(watchesWindow, "source-watch-disabled-captures");
  const labelInput = prSettings.getByRole("textbox", { name: "Label" });
  hold.on = true;
  await call("github_watch_update", { id: nowInput.id, expectedRevision: paused.revision, label: "Pull requests (elsewhere)" });
  await labelInput.fill("Pull requests, reviewed");
  await prSettings.getByRole("button", { name: "Save label" }).click();
  await prSettings.getByText(/changed elsewhere since it was shown/).waitFor();
  release();
  assert.equal((await ownerWatch(nowInput.id)).label, "Pull requests (elsewhere)", "the stale edit did not overwrite");
  await prCard.getByText("Pull requests (elsewhere)", { exact: true }).first().waitFor();
  await labelInput.fill("Pull requests, reviewed");
  await prSettings.getByRole("button", { name: "Save label" }).click();
  await prCard.getByText("Pull requests, reviewed", { exact: true }).first().waitFor();
  const relabeled = await ownerWatch(nowInput.id);
  assert.equal(relabeled.label, "Pull requests, reviewed");
  assert.equal(relabeled.acknowledgedThrough, nowWatch.acknowledgedThrough);
  await activate(prSettings.getByRole("button", { name: "Turn on" }));
  await prCard.getByText("Notifications on", { exact: true }).first().waitFor();
  assert.equal((await ownerWatch(nowInput.id)).enabled, true);

  // Copyable examples carry this watch's ID, never an acknowledgement, and no wake or target action exists; the semantics are the reference's.
  await activate(issuesCard.getByRole("button", { name: "Open inbox" }));
  const issuesExamples = issuesCard.locator("details").filter({ has: page.locator("summary", { hasText: "Use from an agent" }) });
  await activate(issuesExamples.locator("summary"));
  const subscribeExample = JSON.parse(await issuesExamples.getByLabel("events_subscribe example", { exact: true }).textContent());
  assert.deepEqual(subscribeExample, { topic: "github_watches_changed", scope: `watch:${issuesId}`, readOperation: "github_watch_read", readArguments: { id: issuesId } });
  assert.match(await issuesExamples.getByLabel("events/poll example", { exact: true }).textContent(), new RegExp(`"id": "${issuesId}"[\\s\\S]*"cursor": null|"cursor": null[\\s\\S]*"id": "${issuesId}"`));
  assert.match(await issuesExamples.getByLabel("events_listen example", { exact: true }).textContent(), /"policy": "native"/);
  await issuesExamples.getByText(/never acknowledge an entry/).waitFor();
  assert.equal(await watchesWindow.getByRole("button", { name: /wake|target|attach|subscribe to/i }).count(), 0, "no operator wake or target action");
  await captures(watchesWindow, "source-watch-examples");
  await issuesExamples.getByRole("link", { name: "github_watch_events" }).click();
  await page.getByRole("heading", { name: "Occurrence source" }).waitFor();
  await page.getByText(/events_listen/).first().waitFor();
  await page.keyboard.press("Escape");

  // Remove retires the exact watch's ID after an exact confirmation, and does not touch attached subscriptions.
  await activate(prCard.getByRole("button", { name: "Open inbox" }));
  await activate(prSettings.locator("summary"));
  await activate(prSettings.getByRole("button", { name: "Remove watch…" }));
  const removeDialog = page.getByRole("alertdialog");
  await removeDialog.getByText("Remove this watch?").waitFor();
  await removeDialog.getByText(nowInput.id).waitFor();
  await removeDialog.getByText(/does not remove Stack subscriptions attached to it/).waitFor();
  const removeButton = removeDialog.getByRole("button", { name: "Remove watch", exact: true });
  assert.equal(await removeButton.isDisabled(), true, "the exact watch must be confirmed");
  await removeDialog.getByRole("textbox", { name: /First eight characters/ }).fill("00000000");
  assert.equal(await removeButton.isDisabled(), true, "another watch's prefix does not confirm this one");
  await removeDialog.getByRole("textbox", { name: /First eight characters/ }).fill(nowInput.id.slice(0, 8));
  await dialogCaptures("source-watch-remove-confirm");
  await removeButton.click();
  await prCard.waitFor({ state: "detached" });
  assert.deepEqual(watchCalls("github_watch_remove"), [{ id: nowInput.id }]);
  await assert.rejects(call("github_watch_get", { id: nowInput.id }), /github_watch_not_found/);
  assert.equal((await call("github_watch_list")).watches.some((item) => item.id === nowInput.id), false);
  await assert.rejects(call("github_watch_create", nowInput), /github_watch_id_conflict/, "a retired ID cannot be recreated");
  await captures(watchesWindow, "source-watches-after-remove");

  // M7a follow-up: a clear request left unconfirmed is listed whatever is chosen now, and only its receipt is ever read.
  await page.goto(`${origin}/source`);
  await ledger.getByText("25 loaded", { exact: true }).waitFor();
  const db = new DatabaseSync(join(dir, "github", "github.sqlite"));
  const journal = new StateJournal(db, "source");
  const unknownPlan = await call("github_history_plan", { sequences: [10] });
  const unknownInput = { planId: unknownPlan.id, expectedRevision: unknownPlan.revision, requestId: randomUUID() };
  journal.begin(unknownInput, unknownPlan);
  journal.finish(unknownInput.requestId, "unknown", [{ resource: "10", outcome: "unknown", detail: "Fixture interrupted admission; inspect the original request" }]);
  const fnv = (text) => { let value = 0x811c9dc5; for (let index = 0; index < text.length; index++) { value ^= text.charCodeAt(index); value = Math.imul(value, 0x01000193) >>> 0; } return value.toString(16); };
  const slot = `stack.state-flow.source:history:${fnv("10")}`;
  await page.evaluate(([key, input]) => localStorage.setItem(key, JSON.stringify({ input, at: Date.now() })), [slot, unknownInput]);
  const clearsBefore = watchCalls("github_history_clear").length;
  await page.reload();
  await ledger.getByText("25 loaded", { exact: true }).waitFor();
  const pendingRequests = ledger.getByRole("region", { name: "Unconfirmed clear requests" });
  await pendingRequests.waitFor();
  await pendingRequests.getByRole("region", { name: "source receipt unknown" }).waitFor();
  assert.equal(await ledger.getByText("0 chosen").count() > 0 || await ledger.getByText(/\d+ chosen/).count() > 0, true, "maintenance opened itself for the unconfirmed request");
  assert.equal(await pendingRequests.getByRole("button", { name: /Prepare|Send identical|Clear original payloads/ }).count(), 0, "a stale request is never re-planned or resent");
  const chooseOther = ledger.getByRole("checkbox", { name: "Choose delivery 5 for payload clearing" });
  await chooseOther.focus();
  await chooseOther.press("Space");
  await ledger.getByText("1 chosen").waitFor();
  await pendingRequests.waitFor();
  await captures(ledger.locator("details").filter({ has: page.locator("summary", { hasText: "Maintenance" }) }), "source-payload-pending-request");
  await activate(pendingRequests.getByRole("button", { name: /^Read receipt/ }));
  await pendingRequests.getByRole("region", { name: "source receipt unknown" }).waitFor();
  assert.equal(watchCalls("github_history_clear").length, clearsBefore, "reading a receipt clears nothing");
  await activate(pendingRequests.getByRole("button", { name: "Forget this request" }));
  await pendingRequests.waitFor({ state: "detached" });
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), slot), null, "forgetting drops the saved request");
  assert.equal((await call("github_state_receipt_get", { requestId: unknownInput.requestId })).receipt.status, "unknown", "the owner's receipt is untouched");
  journal.close(); db.close();
  await page.goto(`${origin}/source`);
  await watchesWindow.getByRole("button", { name: "Open inbox" }).first().waitFor();

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
  // Watches read on a remote session (definitions, counts, inbox entries) and nothing about them can be changed or acknowledged.
  const issuesNow = await ownerWatch(issuesId);
  const rWatches = remotePage.locator('[data-window="source-watches"]');
  const rIssues = rWatches.locator(`li[data-node="github-watch:${issuesId}"]`);
  await rIssues.waitFor();
  await rIssues.getByLabel("Consumption").getByText(`#${issuesNow.acknowledgedThrough}`, { exact: true }).first().waitFor();
  assert.equal(await rWatches.getByRole("button", { name: "New watch" }).count(), 0, "a remote viewer cannot create a watch");
  await activate(rIssues.getByRole("button", { name: "Open inbox" }));
  await rIssues.locator("li[data-entry]").first().waitFor();
  await rIssues.getByText("Not a pinned snapshot.").waitFor();
  await rIssues.getByText(/Read-only connection: reviewing and acknowledging are local operator actions/).waitFor();
  const rControls = rWatches.getByRole("button", { name: /Acknowledge|Mark through here|Turn on|Turn off|Save label|Remove watch|New watch from this filter/ });
  assert.equal(await rControls.count(), 0, "no watch mutation control is offered remotely");
  assert.equal(await rWatches.getByRole("checkbox").count(), 0, "no review marks remotely: nothing can be acknowledged");
  assert.equal(await rWatches.getByRole("textbox", { name: "Label" }).count(), 0);
  await rIssues.locator("summary", { hasText: "Definition and settings" }).click();
  await rIssues.getByText(/A filter is never edited: a different filter is a new watch/).waitFor();
  await remotePage.screenshot({ path: join(evidence, "source-watches-remote-readonly.png"), animations: "disabled" });
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
    ["source", "github_watch_create", { id: randomUUID(), label: "Remote", filter: {} }], ["source", "github_auth_status", {}],
    ["source", "github_watch_update", { id: issuesId, expectedRevision: issuesNow.revision, enabled: false }],
    ["source", "github_watch_acknowledge", { id: issuesId, through: issuesNow.acknowledgedThrough, expectedAcknowledgedThrough: issuesNow.acknowledgedThrough }],
    ["source", "github_watch_remove", { id: issuesId }]];
  for (const result of await remoteCalls(fenced)) assert.ok(result.error, `the remote gateway refuses ${JSON.stringify(result)}`);
  const allowed = await remoteCalls([["source", "github_status", {}], ["source", "github_delivery_get", { sequence: 3 }], ["source", "github_setup_read", { id: org.endpoint.id }],
    ["source", "github_watch_list", {}], ["source", "github_watch_get", { id: issuesId }], ["source", "github_watch_read", { id: issuesId, limit: 1 }]]);
  for (const result of allowed) assert.ok(!result.error, `a read-only Source operation is available remotely: ${JSON.stringify(result.error)}`);
  const grant = accessStore.inventory().grants.find((entry) => entry.client_id === credential.clientId);
  accessStore.updateGrant(grant.id, 1, ["ui:view", "ui:control"], []);
  await remotePage.locator('[data-remote-scope="control"]').waitFor();
  // The gateway fences open connections when a grant changes; let them reconnect before looking.
  await rLedger.getByText(/^Snapshot through #\d+$/).waitFor();
  await rReceivers.getByRole("img", { name: "Live" }).first().waitFor();
  assert.equal(await remotePage.locator("summary", { hasText: "Maintenance" }).count(), 0, "control scope still offers no Source maintenance");
  assert.equal(await rWatches.getByRole("button", { name: /Acknowledge|Mark through here|Turn on|Turn off|Save label|Remove watch|New watch/ }).count(), 0, "control scope offers no watch mutation either");
  for (const result of await remoteCalls(fenced)) assert.ok(result.error, "control scope gains no Source mutation: the source package has no remote mutation allowlist");
  await remotePage.screenshot({ path: join(evidence, "source-remote-readonly.png"), animations: "disabled" });
  assert.deepEqual(remoteErrors, [], `remote page errors: ${remoteErrors.join(" | ")}`);

  await page.screenshot({ path: join(evidence, "source-bench-final.png"), animations: "disabled" });
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  console.log("source browser check passed");
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, "source-failure.png"), animations: "disabled" }).catch(() => {});
  if (page) console.error((await page.locator('[data-window="source-deliveries"]').innerText().catch(() => "")).slice(0, 1500));
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
