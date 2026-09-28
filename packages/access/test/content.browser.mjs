// Optional real-browser contract check. Uses only disposable state and loopback fixtures.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node test/content.browser.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { serveHttp } from "@agentstack/api";
import { AccessStore } from "../dist/src/store.js";
import { handler } from "../dist/src/ingress.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = mkdtempSync(join(tmpdir(), "access-content-browser-"));
const store = new AccessStore(root);
const servers = [];
let browser;
try {
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
  const path = `/a/example/v/${"a".repeat(64)}/`;
  const hits = [];
  const backend = await serveHttp({ host: "127.0.0.1", port: 0, handle(request) {
    const name = new URL(request.url).pathname;
    hits.push(name);
    if (name === `${path}app.js`) return new Response("document.querySelector('#result').textContent='Script loaded'; fetch('/a/other/').then(()=>document.body.dataset.leak='yes').catch(()=>document.body.dataset.leak='no');", { headers: { "content-type": "text/javascript" } });
    if (name === `${path}style.css`) return new Response("#result { color: rgb(0, 100, 0); }", { headers: { "content-type": "text/css" } });
    return new Response('<!doctype html><title>Artifact fixture</title><link rel="stylesheet" href="style.css"><p id="result">Waiting</p><script src="app.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  servers.push(backend);
  const requests = [];
  const artifactHandler = handler({ store, env: { AGENTSTACK_CONTENT_ARTIFACT_PORT: String(backend.port) }, origin: "artifacts", verify: async () => {} });
  const ingress = await serveHttp({ host: "127.0.0.1", port: 0, tls, forceCloseConnections: true,
    async handle(request, peer) {
      const response = await artifactHandler(request, peer);
      requests.push({ path: new URL(request.url).pathname, cookie: request.headers.has("cookie"), status: response.status });
      return response;
    } });
  servers.push(ingress);
  const redemptionSecret = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "Browser fixture", kind: "browser", scopes: ["content:read"], redemptionSecret });
  store.approve(pairing.id, pairing.code, true);
  const credential = store.redeem(pairing.id, redemptionSecret);
  const token = store.refresh(credential.refreshToken, randomUUID(), "content");
  const principal = store.authorize(token.accessToken, "content", "content:read");
  const handoff = store.handoff(principal, path, "artifacts");
  browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const origin = `https://127.0.0.1:${ingress.port}`;
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const failures = [];
  page.on("console", message => { if (message.type() === "error") failures.push(message.text()); });
  page.on("requestfailed", request => failures.push([request.url(), request.failure()?.errorText]));
  page.on("response", response => { if (response.status() >= 400) failures.push([response.url(), response.status()]); });
  await page.goto(`${origin}/session#${handoff.handoff}`);
  await page.waitForURL(url => url.pathname.startsWith("/view/") && url.pathname.endsWith(path));
  await page.waitForFunction(() => document.querySelector("#result")?.textContent === "Script loaded", undefined, { timeout: 5000 }).catch(error => {
    throw new Error(`Artifact script did not load: ${JSON.stringify({ failures, requests })}`, { cause: error });
  });
  assert.equal(await page.locator("#result").evaluate(el => getComputedStyle(el).color), "rgb(0, 100, 0)");
  await page.waitForFunction(() => document.body.dataset.leak === "no");
  assert.ok(!hits.includes("/a/other/"), "sandbox CSP blocks cross-resource fetch");
  store.revoke("credential", credential.credentialId);
  assert.equal((await page.reload()).status(), 401);
  console.log("Content browser handoff, bundle assets, CSP isolation and revocation passed.");
} finally {
  await browser?.close();
  await Promise.all(servers.map(server => server.close()));
  store.close();
  rmSync(root, { recursive: true, force: true });
}
