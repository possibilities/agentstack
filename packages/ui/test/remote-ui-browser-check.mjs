// Rendered remote UI check. All sockets, TLS listeners, state and Next live in
// this disposable worktree fixture; provenance is injected as in Access tests.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node packages/ui/test/remote-ui-browser-check.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serveApi, serveHttp, socketCall, socketPath } from "@agentstack/api";
import { AccessStore } from "../../access/dist/src/store.js";
import { handler } from "../../access/dist/src/ingress.js";
import { startRemoteUi } from "../../access/dist/src/remote-ui.js";
import { freePort, gatewayRoot, root, ui } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "agentstack-remote-ui-"));
const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
const [documentBackend, artifactBackend, documentPort, artifactPort, remotePort, nextPort] = ports;
const origin = `https://127.0.0.1:${remotePort}`;
const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1",
  AGENTSTACK_CONTENT_PORT: String(documentBackend), AGENTSTACK_CONTENT_ARTIFACT_PORT: String(artifactBackend),
  AGENTSTACK_ACCESS_PORT: String(documentPort), AGENTSTACK_ACCESS_ARTIFACT_PORT: String(artifactPort),
  AGENTSTACK_ACCESS_UI_PORT: String(remotePort), AGENTSTACK_ACCESS_UI_ORIGIN: origin, AGENTSTACK_UI_PORT: String(nextPort) };
const contentCall = (name, args = {}) => socketCall(socketPath("content", env), "tools/call", { name, arguments: args });
const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
const tls = { key: await readFile(key), cert: await readFile(cert) };
const store = new AccessStore(dir);
const servers = [];
let browser, next, page, log = "";
try {
  servers.push(await serveApi({ name: "content", transport: "socket", env, root }));
  const verify = async () => {}; // Simulated Tailscale status/self/whois; production never injects this.
  servers.push(await serveHttp({ host: "127.0.0.1", port: documentPort, tls, handle: handler({ store, env, origin: "documents", verify }), forceCloseConnections: true }));
  servers.push(await serveHttp({ host: "127.0.0.1", port: artifactPort, tls, handle: handler({ store, env, origin: "artifacts", verify }), forceCloseConnections: true }));
  servers.push(await startRemoteUi({ store, env, host: "127.0.0.1", port: remotePort,
    root: await gatewayRoot(dir, ["content"]), verify }, tls));
  const document = await contentCall("new", { title: "Remote note" });
  const bytes = Buffer.from("remote item bytes");
  const item = await contentCall("item_put", { collection: null, name: "remote.txt", kind: "document", mediaType: "text/plain", content: bytes.toString("utf8") });
  const site = Buffer.from(`<!doctype html><title>Remote artifact</title><h1>Artifact ready</h1><script>window.fetchBlocked=true;fetch(${JSON.stringify(`${origin}/connect/me`)}).then(()=>window.fetchBlocked=false).catch(()=>{})</script>`);
  const digest = createHash("sha256").update(site).digest("hex");
  const staged = await contentCall("blob_stage_start", { bytes: site.length, digest });
  await contentCall("blob_stage_chunk", { id: staged.id, offset: 0, base64: site.toString("base64") });
  await contentCall("blob_stage_finish", { id: staged.id });
  const artifact = await contentCall("artifact_publish", { name: "remote-page", kind: "page", files: [{ name: "index.html", blob: digest }] });
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)],
    { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", chunk => { log += chunk; }); next.stderr.on("data", chunk => { log += chunk; });
  for (let attempt = 0;; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${nextPort}/connect/local`)).ok) break; } catch { /* readiness */ }
    if (attempt > 200 || next.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const redemptionSecret = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "Browser check", kind: "browser", scopes: ["ui:view", "content:read"], redemptionSecret });
  store.approve(pairing.id, pairing.code, true);
  const credential = store.redeem(pairing.id, redemptionSecret);
  const session = store.startUi(credential.refreshToken, randomUUID());
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const pairingContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const pairingPage = await pairingContext.newPage();
  await pairingPage.goto(`${origin}/connect`);
  await pairingPage.getByLabel("Browser label").fill("Plain browser check");
  await pairingPage.getByRole("button", { name: "Request approval" }).click();
  await pairingPage.getByText(/Compare approval code:/).waitFor();
  const persisted = await pairingPage.evaluate(() => JSON.parse(localStorage.getItem("agentstack-pairing")));
  assert.match(persisted.redemptionSecret, /^[A-Za-z0-9_-]{43}$/);
  const pendingPairing = store.inventory().pairings.find(entry => entry.id === persisted.id);
  assert.equal(pendingPairing.state, "pending");
  store.approve(persisted.id, pendingPairing.code, true, ["ui:view"]);
  await pairingPage.getByRole("button", { name: "Approved? Connect" }).click();
  await pairingPage.waitForURL(`${origin}/x`);
  assert.equal(await pairingPage.evaluate(() => localStorage.getItem("agentstack-pairing")), null, "redemption secret cleared after admission");
  await pairingContext.close();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1800, height: 1050 } });
  await context.addCookies([{ name: "__Host-agentstack_ui", value: session.accessToken, url: origin, secure: true, httpOnly: true, sameSite: "Strict" },
    { name: "__Host-agentstack_ui_refresh", value: session.refreshToken, url: origin, secure: true, httpOnly: true, sameSite: "Strict" }]);
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const response = await page.goto(`${origin}/x/content`);
  assert.equal(response.status(), 200);
  await page.locator('[data-remote-scope="view"]').waitFor();
  const preview = page.locator('[data-window="content-preview"]');
  const documents = page.locator('[data-window="content-documents"]');
  await documents.getByText("Remote note", { exact: true }).first().waitFor();
  assert.equal(await documents.getByRole("button", { name: "New document" }).isDisabled(), true, "view-only editor has a disabled create control");
  assert.match(await documents.getByRole("button", { name: "New document" }).getAttribute("title"), /ui:control/);
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.origin.replace(/^https:/, "wss:")}/websocket`);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "tools/call", params: { package: "content", name: "new", arguments: { title: "Forbidden remote mutation" } } }));
    ws.onmessage = event => { resolve(JSON.parse(event.data)); ws.close(); };
    ws.onerror = () => reject(new Error("remote socket failed"));
  }));
  assert.match(result.error.message, /not available over websocket/, "view-only grant cannot call a mutating operation");
  await documents.getByRole("button", { name: /Remote note/ }).first().click();
  await preview.getByRole("button", { name: "Open page" }).waitFor();
  const documentTab = context.waitForEvent("page");
  await preview.getByRole("button", { name: "Open page" }).click();
  const openedDocument = await documentTab;
  await openedDocument.waitForURL(new RegExp(`/d/${document.slug}$`));
  assert.match(await openedDocument.locator("body").innerText(), /Remote note/);
  await openedDocument.close();
  const library = page.locator('[data-window="content-library"]');
  await library.getByRole("button", { name: /remote.txt/ }).first().click();
  await preview.getByRole("button", { name: "Open" }).waitFor();
  const itemTab = context.waitForEvent("page");
  await preview.getByRole("button", { name: "Open" }).click();
  const openedItem = await itemTab;
  await openedItem.waitForURL(new RegExp(`/view/.*?/c/${item.id}`));
  assert.match(await openedItem.locator("body").innerText(), /remote item bytes/);
  await openedItem.close();
  const artifacts = page.locator('[data-window="content-artifacts"]');
  await artifacts.getByRole("button", { name: "Show remote-page versions" }).click();
  await artifacts.getByRole("button", { name: /remote-page/ }).nth(1).click();
  await preview.getByRole("button", { name: "Open this version" }).waitFor();
  const artifactTab = context.waitForEvent("page");
  await preview.getByRole("button", { name: "Open this version" }).click();
  const openedArtifact = await artifactTab;
  await openedArtifact.getByText("Artifact ready").waitFor();
  assert.match(openedArtifact.url(), new RegExp(`/view/.*?/a/remote-page/v/${artifact.version}/`));
  assert.equal(await openedArtifact.evaluate(() => { try { window.localStorage.setItem("sandbox-test", "1"); return false; } catch { return true; } }), true,
    "artifact script has no same-origin storage authority");
  assert.equal(await openedArtifact.evaluate(() => window.fetchBlocked), true, "artifact script cannot call the remote UI origin");
  const grant = store.inventory().grants.find(entry => entry.client_id === credential.clientId);
  store.updateGrant(grant.id, 1, ["ui:view", "ui:control", "content:read"], []);
  await page.locator('[data-remote-scope="control"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-window="content-documents"] button')].some(button => button.textContent?.includes("New document") && !button.disabled));
  assert.equal(await documents.getByRole("button", { name: "New document" }).isEnabled(), true);
  store.updateGrant(grant.id, 2, ["ui:view", "content:read"], []);
  await page.locator('[data-remote-scope="view"]').waitFor();
  assert.equal(await documents.getByRole("button", { name: "New document" }).isDisabled(), true);
  store.revoke("credential", credential.credentialId);
  const afterRevoke = await context.request.get(`${origin}/x/content`);
  assert.equal(afterRevoke.status(), 401, "revoked browser cookie cannot load a new UI page");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, assertions: "plain-browser persisted-secret pairing and local approval, remote TLS session, UI hydration, read-only/control UI transitions, refused WebSocket mutation, revocation, document/item/immutable artifact one-use handoffs, opaque artifact origin", state: dir }));
} finally {
  await browser?.close();
  if (next) { next.kill("SIGTERM"); await new Promise(resolve => next.once("exit", resolve)); }
  for (const server of servers.reverse()) await server.close();
  store.close(); await rm(dir, { recursive: true, force: true });
}
