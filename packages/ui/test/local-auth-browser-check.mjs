// Production UI bootstrap and ticket lifecycle in disposable state.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node .../local-auth-browser-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalAuth, serveSocket, serveWebSocket, socketPath } from "@agentstack/api";
import { fixtureWorkspace, freePort, ui, z } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "as-local-browser-"));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, AGENTSTACK_UI_PORT: String(port), AGENTSTACK_WEBSOCKET_PORT: "0", NEXT_TELEMETRY_DISABLED: "1" };
const auth = new LocalAuth(env);
let next, browser, socket, gateway;
let output = "";
try {
  socket = await serveSocket({ info: { name: "demo", description: "Fixture", transportDescription: "Fixture", path: socketPath("demo", env) }, context: {},
    operations: [{ name: "read", description: "Fixture read", input: z.strictObject({}), output: z.object({ secret: z.string() }), call: async () => ({ secret: "fixture-only-private-value" }) }] });
  gateway = await serveWebSocket({ env, root: await fixtureWorkspace(dir, ["demo"]), port: 0 });
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [next.stdout, next.stderr]) stream.on("data", data => { output = (output + data).slice(-8000); });
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* readiness */ }
    if (next.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await fetch(`${origin}/`)).status, 401);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage();
  await page.goto(`${origin}/`);
  await page.waitForURL(`${origin}/connect/local`);
  const token = auth.bootstrap(origin, "ui");
  await page.goto(`${origin}/connect/local#${token}`);
  await page.waitForURL(`${origin}/`);
  assert.equal(new URL(page.url()).hash, "");
  const cookie = (await page.context().cookies()).find(cookie => cookie.name === "agentstack_local_ui");
  assert.ok(cookie?.httpOnly); assert.equal(cookie.sameSite, "Strict");
  assert.equal(await page.evaluate(() => document.cookie.includes("agentstack_local_ui")), false);
  assert.equal((await page.request.post(`${origin}/connect/local/session`, { headers: { origin }, data: { token } })).status(), 401);
  const connect = async () => page.evaluate(async url => {
    const response = await fetch("/connect/local/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const { ticket } = await response.json();
    const socket = new WebSocket(url, [`agentstack-local.${ticket}`]);
    window.fixtureSocket = socket;
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const result = new Promise(resolve => { socket.onmessage = event => resolve(JSON.parse(event.data)); });
    socket.send(JSON.stringify({ id: 1, method: "tools/call", params: { package: "demo", name: "read", arguments: {} } }));
    return { ticket, frame: await result };
  }, gateway.url);
  const first = await connect();
  assert.equal(first.frame.result.secret, "fixture-only-private-value");
  assert.equal(await page.evaluate(({ url, ticket }) => new Promise(resolve => {
    const ws = new WebSocket(url, [`agentstack-local.${ticket}`]); ws.onopen = () => { ws.close(); resolve(false); }; ws.onerror = () => resolve(true);
  }), { url: gateway.url, ticket: first.ticket }), true);
  await page.evaluate(() => window.fixtureSocket.close());
  const second = await connect(); assert.notEqual(first.ticket, second.ticket);
  auth.rotate();
  await page.waitForFunction(() => window.fixtureSocket.readyState === WebSocket.CLOSED);
  assert.equal((await page.request.get(`${origin}/`)).status(), 401);
  assert.equal((await page.request.post(`${origin}/connect/local/ticket`, { headers: { origin }, data: {} })).status(), 401);
  await page.goto(`${origin}/connect/local#${auth.bootstrap(origin, "ui")}`);
  await page.waitForURL(`${origin}/`);
  assert.equal((await connect()).frame.result.secret, "fixture-only-private-value");
  console.log(JSON.stringify({ ok: true, assertions: "anonymous SSR rejection, real fragment bootstrap/CSP, HttpOnly cookie, replay rejection, fresh tickets, active revocation and reconnect" }));
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill(); await new Promise(resolve => next.once("exit", resolve)); }
  await gateway?.close(); await socket?.close(); auth.close(); await rm(dir, { recursive: true, force: true });
}
