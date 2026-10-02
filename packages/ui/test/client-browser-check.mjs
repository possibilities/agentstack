// Production HTTP/security + headless renderer check. No live platform or GUI.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CLIENT_EVIDENCE_DIR=/scratch/... node test/client-browser-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { LocalAuth, serveSocket, socketCall } from "@stack/api";
import { startClientHost } from "@stack/client";
import { startClientUi } from "../bin/launcher.mjs";
import { freePort, ui, z } from "./browser-fixture.mjs";
import { checkLocalWorkflow, checkNoTrustedRelease, settleForCapture } from "./client-local-workflow.mjs";

const evidence = process.env.CLIENT_EVIDENCE_DIR;
const base = await mkdtemp("/private/tmp/s8-"); // macOS Unix socket paths must stay short.
const root = join(base, "c"), platformRoot = join(base, "p"), otherRoot = join(base, "o");
await mkdir(join(base, "home"));
// homedir() in child processes points to a disposable home; no service mutation is called.
const oldHome = process.env.HOME;
const oldReleaseManifest = process.env.STACK_CLIENT_RELEASE_MANIFEST;
// Never import an operator's pinned release configuration into a disposable test.
delete process.env.STACK_CLIENT_RELEASE_MANIFEST;
process.env.HOME = join(base, "home");
let client, platform, browser, other, fixture, sentinel, cli;
let accessContext, accessApi;
const authorities = [];
const checks = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const authAt = root => { const auth = new LocalAuth({ STACK_STATE_DIR: root }); authorities.push(auth); return auth; };
const cookieAt = (auth, origin, name) => `${name}=${auth.redeem(auth.bootstrap(origin, "ui"), origin, "ui").token}`;
const headers = (cookie, origin) => ({ cookie, origin, "content-type": "application/json" });
const rpc = (origin, cookie, operation, input = {}, extra = {}) => fetch(`${origin}/api/client/rpc`, {
  method: "POST", headers: { ...headers(cookie, origin), ...extra }, body: JSON.stringify({ operation, input }), redirect: "manual",
});
const response = async (url, init) => { const r = await fetch(url, { ...init, redirect: "manual" }); await r.body?.cancel(); return r; };
const expectStatus = async (status, url, init) => assert.equal((await response(url, init)).status, status);
const rawStatus = (url, headers) => new Promise((resolve, reject) => {
  const request = httpRequest(url, { headers }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
  request.once("error", reject); request.end();
});
async function checkHeader(page) {
  assert.equal(await page.getByRole("banner", { includeHidden: true }).count(), 1, "exactly one banner landmark");
  assert.equal(await page.locator("header").count(), 1, "exactly one header element");
  const geometry = await page.evaluate(() => {
    const header = document.querySelector("header"), main = document.querySelector("main");
    const banner = header.getBoundingClientRect();
    const overlaps = [];
    const texts = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    while (texts.nextNode()) {
      if (!texts.currentNode.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(texts.currentNode);
      for (const rect of range.getClientRects()) {
        if (rect.width && rect.height && rect.top < banner.bottom && rect.bottom > banner.top && rect.left < banner.right && rect.right > banner.left)
          overlaps.push(texts.currentNode.textContent.trim().slice(0, 80));
      }
    }
    return { scrollY, width: innerWidth, height: innerHeight, headerPosition: getComputedStyle(header).position, overlaps: overlaps.slice(0, 10) };
  });
  assert.deepEqual(geometry.overlaps, [], `header must not cover content: ${JSON.stringify(geometry)}`);
}
async function nextPlatform(port) {
  const require = createRequire(import.meta.url);
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: ui, env: { ...process.env, STACK_UI_MODE: "platform", STACK_STATE_DIR: platformRoot, STACK_CLIENT_STATE_DIR: root, STACK_WEBSOCKET_PORT: "0", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null) throw new Error("platform_fixture_start_failed");
    try { if ((await response(`http://127.0.0.1:${port}/connect/local`)).ok) return child; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill(); throw new Error("platform_fixture_readiness_timeout");
}

try {
  const opened = [];
  client = await startClientUi({ root, port: 0, navigation: { openClientSurface(url) { opened.push(url); } } });
  const { origin } = client;
  const auth = authAt(root);
  const cookieName = `stack_client_ui_${createHash("sha256").update(client.root).digest("hex").slice(0, 24)}`;
  const home = await client.host.call("client_snapshot", {});
  assert.equal(home.installation, null);
  assert.equal(home.service.ready, false);
  assert.equal(opened.length, 1);
  assert.ok(new URL(opened[0]).hash.length === 44, "parent opens a capability without printing it");
  pass("launcher cold start without any platform installation/socket");
  await expectStatus(401, `${origin}/client`);
  await expectStatus(401, `${origin}/client/local`);
  await expectStatus(401, `${origin}/client?_rsc=unauthenticated`, { headers: { rsc: "1" } });
  await expectStatus(401, `${origin}/_next/static/does-not-exist.js`);
  await expectStatus(401, `${origin}/api/client/events`);
  assert.equal((await rpc(origin, "", "client_snapshot")).status, 401);
  await expectStatus(401, `${origin}/client`, { headers: { authorization: `Bearer ${auth.credential()}` } });
  await expectStatus(401, `${origin}/client`, { headers: { cookie: "__Host-stack_ui=access-session-is-not-client-authority" } });
  pass("anonymous page, RSC, assets, RPC and SSE rejected");

  const token = new URL(opened[0]).hash.slice(1);
  const exchange = await fetch(`${origin}/connect/local/session`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith(`${cookieName}=`));
  assert.ok(exchange.headers.get("set-cookie").includes("HttpOnly; SameSite=Strict"));
  assert.ok(!(await exchange.text()).includes(cookie.split("=")[1]), "session never appears in JSON");
  await expectStatus(401, `${origin}/connect/local/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const authenticated = await fetch(`${origin}/client`, { headers: { cookie } });
  assert.equal(authenticated.status, 200);
  const html = await authenticated.text();
  const csp = authenticated.headers.get("content-security-policy");
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.ok(csp.includes("connect-src 'self'") && csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'none'") && csp.includes("base-uri 'none'"));
  assert.ok(!csp.includes("unsafe-eval") && !/script-src[^;]*unsafe-inline/.test(csp));
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.ok(scripts.length > 0 && scripts.every(script => script[1].includes(`nonce="${nonce}"`)), "all Next scripts share the response nonce");
  assert.equal(authenticated.headers.get("cache-control"), "no-store");
  assert.equal(authenticated.headers.get("referrer-policy"), "no-referrer");
  assert.equal(authenticated.headers.get("x-content-type-options"), "nosniff");
  assert.ok(![...authenticated.headers.keys()].some(name => name.startsWith("x-stack-") || name.startsWith("x-middleware-")), "ingress assertions never reach browser response headers");
  const rsc = await fetch(`${origin}/client?_rsc=authenticated`, { headers: { cookie, rsc: "1" } });
  assert.equal(rsc.status, 200); await rsc.body?.cancel();
  const asset = html.match(/src="([^" ]+\/_next\/static\/[^" ]+\.js|\/_next\/static\/[^" ]+\.js)"/)?.[1];
  assert.ok(asset, "production HTML references a script asset");
  await expectStatus(200, new URL(asset, origin), { headers: { cookie } });
  await expectStatus(401, new URL(asset, origin));
  await expectStatus(303, `${origin}/`, { headers: { cookie } });
  await expectStatus(404, `${origin}/fleet`, { headers: { cookie } });
  await expectStatus(404, `${origin}/connect/local/ticket`, { method: "POST", headers: headers(cookie, origin), body: "{}" });
  pass("one-use exchange, root cookie, nonce CSP, security headers, protected RSC/assets and disabled Canvas");

  assert.equal(await rawStatus(`${origin}/client`, { cookie, host: new URL(origin).host.replace("127.0.0.1", "localhost") }), 403);
  await expectStatus(403, `${origin}/client`, { headers: { cookie, origin: "http://evil.example" } });
  assert.equal((await rpc(origin, cookie, "client_snapshot", {}, { origin: "http://evil.example" })).status, 403);
  await expectStatus(403, `${origin}/api/client/rpc`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"operation":"client_snapshot","input":{}}' });
  for (const [name, value] of Object.entries({
    forwarded: "for=127.0.0.1", "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "http", "x-forwarded-for": "127.0.0.1",
    "x-stack-remote-ui": "1", "x-stack-client-proof": "0".repeat(64), "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy", "x-nextjs-data": "1",
  })) await expectStatus(403, `${origin}/client`, { headers: { cookie, [name]: value } });
  await expectStatus(403, `${origin}/connect/local`, { headers: { "x-forwarded-host": new URL(origin).host } });
  pass("exact Host/Origin and raw forwarded/internal header refusal, including matching forged values");

  const foreignAuth = authAt(otherRoot);
  await expectStatus(401, `${origin}/client`, { headers: { cookie: cookieAt(foreignAuth, origin, cookieName) } });
  const platformAuth = authAt(platformRoot);
  await expectStatus(401, `${origin}/client`, { headers: { cookie: cookieAt(platformAuth, origin, "stack_local_ui") } });
  await expectStatus(401, `${origin}/client`, { headers: { cookie: cookieAt(platformAuth, origin, cookieName) } });
  const pPort = await freePort(), pOrigin = `http://127.0.0.1:${pPort}`;
  platform = await nextPlatform(pPort);
  await expectStatus(401, `${pOrigin}/client`, { headers: { cookie } });
  await expectStatus(401, `${pOrigin}/client`, { headers: { cookie: cookieAt(auth, pOrigin, "stack_local_ui") } });
  const pCookie = cookieAt(platformAuth, pOrigin, "stack_local_ui");
  const explanation = await fetch(`${pOrigin}/client`, { headers: { cookie: pCookie } });
  assert.equal(explanation.status, 200);
  assert.ok((await explanation.text()).includes("Stack Client UI runs independently"));
  await expectStatus(404, `${pOrigin}/api/client/events`, { headers: { cookie: pCookie } });
  assert.equal((await rpc(pOrigin, pCookie, "client_snapshot")).status, 404);
  await expectStatus(200, `${pOrigin}/`, { headers: { cookie: pCookie } });
  pass("wrong-root and both cross-mode cookies denied, including renamed cookies; platform Canvas still renders");

  const snapshotRead = await rpc(origin, cookie, "client_snapshot");
  assert.equal(snapshotRead.status, 200);
  assert.equal((await snapshotRead.json()).output.installation, null);
  assert.equal((await rpc(origin, cookie, "client_ui_connect")).status, 403);
  assert.equal((await rpc(origin, cookie, "serve_status")).status, 403);
  assert.equal((await rpc(origin, cookie, "__proto__")).status, 403);
  assert.equal((await rpc(origin, cookie, "client_snapshot", { socket: "other" })).status, 400);
  assert.equal((await rpc(origin, cookie, "client_platform_start", { requestId: "not-a-uuid" })).status, 400);
  await expectStatus(400, `${origin}/api/client/rpc`, { method: "POST", headers: headers(cookie, origin), body: JSON.stringify({ operation: "client_snapshot", input: {}, method: "tools/list" }) });
  await expectStatus(400, `${origin}/api/client/rpc`, { method: "POST", headers: headers(cookie, origin), body: "x".repeat(65_537) });
  pass("allowlisted typed RPC refuses bootstrap, arbitrary methods, extra fields, invalid and oversized inputs");

  const abort = new AbortController();
  const sse = await fetch(`${origin}/api/client/events`, { headers: { cookie }, signal: abort.signal });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const readEvent = async () => {
    const value = await Promise.race([reader.read(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("event_timeout")), 5000); timer.unref(); })]);
    return value.done ? "closed" : new TextDecoder().decode(value.value);
  };
  assert.ok((await readEvent()).includes("event: ready"));
  await client.host.call("client_platform_configure", { expectedRevision: 0, configuration: { ports: { ui: 19001 } } });
  const notice = await readEvent();
  assert.ok(notice.includes("event: client_changed"));
  assert.ok(!notice.includes("19001") && !notice.includes("configuration"));
  const db = new DatabaseSync(join(root, "local-auth", "authority.sqlite3"));
  db.prepare("UPDATE capabilities SET expires=? WHERE digest=?").run(Date.now() - 1, createHash("sha256").update(cookie.split("=")[1]).digest("hex")); db.close();
  assert.ok((await readEvent()).includes("event: session_expired"));
  assert.equal((await reader.read()).done, true);
  await expectStatus(401, `${origin}/client`, { headers: { cookie } });
  await expectStatus(401, `${origin}/api/client/events`, { headers: { cookie } });
  abort.abort();
  pass("SSE subscribes before ready, carries no state, and closes at session expiry");

  // Real host-owned enrollment and retained connection projections, not UI mocks.
  await client.host.call("client_enrollment_begin", { requestId: randomUUID(), label: "Phone setup pending", scopes: ["ui:view"] });
  const requireClient = createRequire(import.meta.resolve("@stack/client"));
  const accessUrl = pathToFileURL(requireClient.resolve("@stack/access"));
  ({ api: accessApi } = await import(accessUrl));
  const { handler } = await import(new URL("./src/ingress.js", accessUrl));
  accessContext = await accessApi.createContext({ STACK_STATE_DIR: join(base, "a") });
  const remoteOrigin = "https://fixture.example:8943";
  const peer = { remoteAddress: "100.80.0.2", localAddress: "100.80.0.1", remotePort: 1234 };
  const route = handler({ store: accessContext.store, origin: "documents", env: { STACK_ACCESS_HOST: peer.localAddress,
    STACK_ACCESS_ORIGIN: remoteOrigin, STACK_ACCESS_UI_ORIGIN: "https://fixture.example:8945" }, verify: async () => {} });
  const network = globalThis.fetch;
  try {
    // In-memory transport to the REAL owner admission/approval/credential code.
    // This is only a display fixture, not proof of tailnet provenance/TLS.
    globalThis.fetch = async (url, init) => {
      if (new URL(url).origin !== remoteOrigin) return network(url, init);
      const request = new Request(url, init); request.headers.set("host", new URL(url).host);
      return route(request, peer);
    };
    const descriptor = await client.host.call("client_connection_inspect", { origin: remoteOrigin });
    for (const label of ["Saved laptop platform", "Second saved connection"]) {
      const requestId = randomUUID();
      const admission = await client.host.call("client_pair_begin", { requestId, label, connection: descriptor, scopes: ["ui:view"] });
      accessContext.store.approve(admission.receipt.id, admission.receipt.code, true);
      await client.host.call("client_pair_redeem", { id: requestId });
    }
  } finally { globalThis.fetch = network; }
  const { remoteUiHandler } = await import(new URL("./src/remote-ui.js", accessUrl));
  const viewerSecret = "A".repeat(43);
  const viewerPair = accessContext.store.pair({ requestId: randomUUID(), label: "Remote policy fixture", kind: "browser", scopes: ["ui:view"], redemptionSecret: viewerSecret });
  accessContext.store.approve(viewerPair.id, viewerPair.code, true);
  const viewer = accessContext.store.startUi(accessContext.store.redeem(viewerPair.id, viewerSecret).refreshToken, randomUUID());
  const remoteUiOrigin = "https://fixture.example:8945";
  let forwarded = 0;
  const remoteUi = remoteUiHandler({ store: accessContext.store, env: { STACK_STATE_DIR: join(base, "a"), STACK_ACCESS_UI_ORIGIN: remoteUiOrigin }, host: "100.80.0.1", port: 8945,
    verify: async () => {}, fetchBackend: async () => { forwarded++; throw new Error("unexpected_forward"); } });
  const remoteRequest = (path, method = "GET") => new Request(`${remoteUiOrigin}${path}`, {
    method, headers: { host: new URL(remoteUiOrigin).host, origin: remoteUiOrigin, cookie: `__Host-stack_ui=${viewer.accessToken}` },
  });
  assert.equal((await remoteUi(remoteRequest("/connect/me"), peer)).status, 200, "fixture viewer authority is valid before the path gate");
  for (const [path, method] of [["/client", "GET"], ["/client/local", "GET"], ["/api/client/events", "GET"], ["/api/client/rpc", "POST"]])
    assert.equal((await remoteUi(remoteRequest(path, method), peer)).status, 404);
  assert.equal(forwarded, 0);
  pass("valid Access viewer cannot reach Client pages/RPC/SSE; remote allowlist remains closed");
  const { ClientState } = await import(new URL("./state.js", import.meta.resolve("@stack/client")));
  const retained = new ClientState(root);
  // An owner-ledger fixture for read-only rendering of an unknown job; never
  // claims that an install/service command actually ran or completed.
  const unknownJob = randomUUID();
  retained.admit(unknownJob, "client_install", { requestId: unknownJob });
  retained.progress(unknownJob, "interrupted", "unknown", "host_interrupted");
  retained.close();

  if (process.env.PLAYWRIGHT_MODULE) {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [], violations = [];
    page.on("pageerror", () => errors.push("pageerror"));
    await page.addInitScript(() => {
      window.clientCspViolations = [];
      document.addEventListener("securitypolicyviolation", event => window.clientCspViolations.push({ directive: event.violatedDirective,
        blocked: event.blockedURI === "inline" || event.blockedURI === "eval" ? event.blockedURI : new URL(event.blockedURI, location.origin).pathname,
        source: event.sourceFile ? new URL(event.sourceFile).pathname : "", line: event.lineNumber }));
    });
    const bootstrap = await client.host.call("client_ui_connect", {});
    await page.goto(bootstrap.url);
    await page.waitForURL(`${origin}/client`);
    await page.getByText("No local platform installed.", { exact: false }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.ok(!await page.evaluate(() => document.cookie.includes("stack_client_ui_")));
    assert.equal(errors.length, 0);
    violations.push(...await page.evaluate(() => window.clientCspViolations));
    assert.deepEqual(violations, []);
    await page.getByText("Phone setup pending", { exact: true }).waitFor();
    await page.getByText("Saved laptop platform", { exact: true }).waitFor();
    await page.getByText("Second saved connection", { exact: true }).waitFor();
    await page.getByText("Outcome unknown", { exact: true }).waitFor();
    assert.ok(!(await page.content()).match(/refreshToken|redemptionSecret|privateKey/));
    // Exercise scrolling even without capture output; a full-page capture alone
    // cannot detect sticky header occlusion on short viewports.
    const layouts = [];
    for (const colorScheme of ["light", "dark"]) for (const width of [1200, 390]) for (const height of [900, 360]) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height });
      const bottom = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      for (let y = 0; y < bottom + height / 2; y += height / 2) {
        await page.evaluate(y => scrollTo(0, y), Math.min(y, bottom));
        await checkHeader(page);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "home reflows without overflow");
      layouts.push({ colorScheme, width, height, singleBanner: true, headerOcclusion: false, overflow: false });
      for (const label of ["Saved laptop platform", "Second saved connection"]) {
        const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
        const url = card.getByText(remoteUiOrigin, { exact: true });
        const note = card.getByText("Saved — not a live connection.", { exact: true });
        assert.equal(await url.count(), 1, "Platform UI URL has its own text element");
        assert.equal(await note.count(), 1, "saved status is separate from the URL");
        const urlBox = await url.boundingBox(), noteBox = await note.boundingBox();
        assert.ok(noteBox.y >= urlBox.y + urlBox.height, "saved status appears below the Platform UI URL");
      }
    }
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      for (const [label, colorScheme, width] of [["light", "light", 1200], ["dark", "dark", 1200], ["narrow", "light", 390]]) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => scrollTo(0, 0));
        await checkHeader(page);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "home reflows without overflow");
        await settleForCapture(page);
        await page.screenshot({ path: join(evidence, `home-${label}.png`), fullPage: true });
        await checkHeader(page);
      }
      await page.reload();
      await page.getByText("Phone setup pending", { exact: true }).waitFor();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.textContent), "Skip to connections");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await writeFile(join(evidence, "render-check.json"), JSON.stringify({ pageErrors: errors, cspViolations: violations, localStorageEntries: 0, fragmentErased: true, keyboardSkipLink: true, narrowOverflow: false, layouts }, null, 2));
    }
    await checkNoTrustedRelease(page, client, pass, evidence);
    await checkLocalWorkflow({ browser, base, evidence, pass, checkHeader });
    auth.rotate();
    await page.getByText("Client session expired.", { exact: false }).waitFor();
    await page.getByText("Phone setup pending", { exact: true }).waitFor();
    await checkHeader(page);
    if (evidence) { await settleForCapture(page); await page.screenshot({ path: join(evidence, "home-last-good-expired.png"), fullPage: true }); }
    pass("real fragment exchange, CSP hydration, no browser secrets, retained states, single unoccluding header, separate URL/status, light/dark/narrow/short/keyboard and last-good expiry");
    await browser.close(); browser = null;
  }

  // A deliberately malformed private response must not reach authenticated HTTP.
  const outputCookie = cookieAt(auth, origin, cookieName);
  await client.host.close();
  fixture = await serveSocket({ info: { name: "client", description: "Invalid output fixture", transportDescription: "Fixture", path: join(root, "client.sock") }, context: {},
    operations: [{ name: "client_snapshot", description: "Invalid fixture", input: z.strictObject({}), output: z.unknown(), call: async () => ({ privateToken: "must-not-leave-socket" }) }] });
  const invalidOutput = await rpc(origin, outputCookie, "client_snapshot");
  assert.equal(invalidOutput.status, 502);
  const invalidText = await invalidOutput.text();
  assert.ok(!invalidText.includes("must-not-leave-socket"));
  assert.equal(JSON.parse(invalidText).uncertain, true);
  await fixture.close(); fixture = null;
  pass("invalid socket outputs are withheld and reported uncertain after dispatch");

  // Parent close is deliberately independent of the managed platform's socket.
  sentinel = createServer(socket => { socket.resume(); socket.end("platform-still-running"); });
  const sentinelPath = join(root, "platform", "state", "sockets", "serve.sock");
  await mkdir(join(sentinelPath, ".."), { recursive: true });
  await new Promise(resolve => sentinel.listen(sentinelPath, resolve));
  await client.close(); client = null;
  await access(sentinelPath);
  assert.ok(sentinel.listening);
  await assert.rejects(access(join(root, "client.sock")));
  pass("launcher closes its UI/host and leaves the platform socket untouched");

  let cliOutput = "";
  cli = spawn(process.execPath, [join(ui, "bin", "stack-ui.mjs"), "--root", root, "--port", "0", "--no-open"], { cwd: ui, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cli_readiness_timeout")), 15_000);
    const append = data => {
      cliOutput = (cliOutput + data).slice(-8000);
      if (cliOutput.includes("Stack Client UI ready")) { clearTimeout(timer); resolve(); }
    };
    cli.stdout.on("data", append); cli.stderr.on("data", append);
    cli.once("exit", () => { clearTimeout(timer); reject(new Error("cli_start_failed")); });
  });
  const beforeSignal = await socketCall(join(root, "client.sock"), "tools/call", { name: "client_snapshot", arguments: {} });
  assert.equal(beforeSignal.version, 1);
  const cliExit = once(cli, "exit");
  cli.kill("SIGTERM");
  assert.equal((await cliExit)[0], 0);
  await assert.rejects(access(join(root, "client.sock")));
  assert.ok(sentinel.listening);
  const afterSignal = new ClientState(root);
  try { assert.deepEqual(afterSignal.jobs().map(job => ({ ...job })), beforeSignal.jobs, "launcher exit must not admit install/start/stop/login jobs"); }
  finally { afterSignal.close(); }
  assert.ok(!cliOutput.includes("#") && !cliOutput.includes("stack_client_ui_"));
  pass("real launcher bin SIGTERM cleans its host/child, logs no capability, admits no service jobs and leaves platform socket running");

  await assert.rejects(startClientUi({ root: join(base, "n"), port: 0,
    navigation: { openClientSurface(url) { throw new Error(url); } } }), /^Error: navigation_open_failed$/);
  await assert.rejects(access(join(base, "n", "client.sock")));
  pass("failed navigation sanitizes capability-bearing errors and releases the owned host");

  other = await startClientHost({ root: otherRoot });
  const liveCookie = cookieAt(foreignAuth, origin, "stack_local_ui");
  await assert.rejects(startClientUi({ root: otherRoot, port: 0, open: false }), /client_host_busy/);
  foreignAuth.session(liveCookie.split("=")[1], origin, "ui");
  assert.equal((await other.call("client_snapshot", {})).version, 1);
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  try { await assert.rejects(startClientUi({ root: join(base, "busy"), port: occupied.address().port, open: false }), /client_ui_port_busy/); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
  pass("foreign host owner and occupied UI port refuse startup without rotating live authority");
} finally {
  await browser?.close();
  await fixture?.close();
  // The fixture deliberately closed the host early; avoid a second backend close.
  if (client) { try { await client.close(); } catch {} }
  await other?.close();
  if (accessContext) await accessApi.closeContext(accessContext);
  if (sentinel) await new Promise(resolve => sentinel.close(resolve));
  if (platform && platform.exitCode === null) { platform.kill(); await once(platform, "exit"); }
  if (cli && cli.exitCode === null && cli.signalCode === null) { cli.kill(); await once(cli, "exit"); }
  for (const auth of authorities) auth.close();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldReleaseManifest === undefined) delete process.env.STACK_CLIENT_RELEASE_MANIFEST; else process.env.STACK_CLIENT_RELEASE_MANIFEST = oldReleaseManifest;
  await rm(base, { recursive: true, force: true });
  console.log("PASS all owned processes, sockets and disposable roots released");
}
if (evidence) await writeFile(join(evidence, "client-check.json"), JSON.stringify({ ok: true, checks, renderer: !!process.env.PLAYWRIGHT_MODULE, disposableRoots: base, resourcesReleased: true }, null, 2));
