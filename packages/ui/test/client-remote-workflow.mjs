// Client browser -> authenticated ingress -> REAL Client host -> REAL TLS Access
// owner. Only external network provenance/status and platform content are fixtures.
// No live tailnet, platform, service registration, camera or binary-file inspection.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serveHttp, serveSocket, socketPath } from "@stack/api";
import { api as accessApi } from "@stack/access";
import { encodeQr, decodeQr } from "@stack/access/enrollment-protocol";
import { createEnrollmentIntent, signEnrollmentRedemption } from "@stack/access/enrollment-client";
import { startClientUi } from "../bin/launcher.mjs";
import { freePort, z } from "./browser-fixture.mjs";
import { captureVariants, settleForCapture } from "./client-local-workflow.mjs";

const { handler } = await import(new URL("./src/ingress.js", import.meta.resolve("@stack/access")));
const { startRemoteUi } = await import(new URL("./src/remote-ui.js", import.meta.resolve("@stack/access")));
const owner = (context, name, input) => {
  const operation = accessApi.operations.find(operation => operation.name === name);
  return operation.call(context, operation.input.parse(input));
};
const mutating = new Set(["client_pair_begin", "client_pair_redeem", "client_enrollment_begin", "client_enrollment_accept", "client_enrollment_redeem", "client_connection_open", "client_connection_forget", "client_intent_forget"]);

/** Test-only DNS routing over actual loopback TLS. Exact Host remains the declared
 * .test authority; self-signed TLS trust is relaxed only for these fixtures. */
function tlsFetch(url, init = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port: target.port, path: target.pathname + target.search, method: init.method ?? "GET", rejectUnauthorized: false,
      headers: { ...Object.fromEntries(new Headers(init.headers)), host: target.host } }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(key, item);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on("error", reject); request.end(init.body);
  });
}

async function platformFixture(base, name, tls) {
  const root = join(base, name), replacementRoot = join(base, `${name}x`);
  const context = await accessApi.createContext({ STACK_STATE_DIR: root });
  const replacement = await accessApi.createContext({ STACK_STATE_DIR: replacementRoot });
  const devicePort = await freePort(), uiPort = await freePort();
  const deviceOrigin = `https://platform-${name}.test:${devicePort}`, uiOrigin = `https://platform-${name}.test:${uiPort}`;
  const env = { STACK_STATE_DIR: root, STACK_ACCESS_HOST: "127.0.0.1", STACK_ACCESS_PORT: String(devicePort), STACK_ACCESS_UI_PORT: String(uiPort), STACK_ACCESS_ORIGIN: deviceOrigin, STACK_ACCESS_UI_ORIGIN: uiOrigin };
  // Context startup stays inert (no service-owned ingress); direct trusted-local
  // owner operations use the same declared origins as the disposable TLS ingress.
  context.env = env;
  replacement.env = { ...env, STACK_STATE_DIR: replacementRoot };
  let active = context;
  const peers = [], calls = [];
  const verify = async peer => { peers.push(peer); }; // Same explicit provenance stand-in as Access TLS tests.
  // A mapped-loopback bind is still strictly local, while the application's
  // logical .test Host is validated by Access (as a real tailnet bind would be).
  // The generic 127.0.0.1 listener otherwise allows only loopback Host values.
  const bind = "::ffff:127.0.0.1";
  const device = await serveHttp({ host: bind, port: devicePort, tls, forceCloseConnections: true, handle(request, peer) {
    calls.push({ path: new URL(request.url).pathname, method: request.method }); // Never a body or capability.
    return handler({ store: active.store, origin: "documents", env, verify })(request, peer);
  } });
  let writes = 0;
  const sockets = [];
  for (const pkg of ["notify", "proc"]) {
    const directory = join(root, "packages", pkg); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "api.yaml"), `name: ${pkg}\ndescription: Disposable policy fixture.\nsocket:\n  description: Fixture.\nwebsocket:\n  operations: all\n  events: []\n  description: Fixture.\n`);
    sockets.push(await serveSocket({ info: { name: pkg, description: "Fixture", transportDescription: "Fixture", path: socketPath(pkg, env) }, context: {},
      operations: [{ name: pkg === "notify" ? "notification_counts" : "schedule_list", description: "Read fixture", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), annotations: { readOnlyHint: true }, call: async () => ({ ok: true }) },
        { name: pkg === "notify" ? "notification_dismiss" : "schedule_create", description: "Mutation fixture", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), call: async () => { writes++; return { ok: true }; } }] }));
  }
  const remote = await startRemoteUi({ store: context.store, env, host: bind, port: uiPort, root, verify,
    fetchBackend: async () => new Response(`<html><h1>Disposable platform ${name}</h1><p>Policy fixture, not a live Canvas.</p></html>`, { headers: { "content-type": "text/html" } }) }, tls);
  return { context, env, deviceOrigin, uiOrigin, calls, peers, get writes() { return writes; }, replace(value) { active = value ? replacement : context; },
    close: async () => { await remote.close(); await device.close(); for (const socket of sockets) await socket.close(); await accessApi.closeContext(context); await accessApi.closeContext(replacement); } };
}

async function capture(page, evidence, name, checkHeader) {
  for (const [scheme, width] of [["light", 1200], ["dark", 1200], ["light", 390]]) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" }); await page.setViewportSize({ width, height: 900 });
    await settleForCapture(page); await checkHeader(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no narrow overflow`);
    const unreadable = await page.locator("main button").evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().width > 0 && button.scrollWidth > button.clientWidth + 2).map(button => button.textContent));
    assert.deepEqual(unreadable, [], `${name}: controls not clipped`);
    const clippedValues = await page.locator("main textarea[readonly], main input[readonly]").evaluateAll(inputs => inputs.filter(input => input.clientWidth === 0 || input.scrollWidth > input.clientWidth + 2 || input.scrollHeight > input.clientHeight + 2).map(input => input.getAttribute("aria-label")));
    assert.deepEqual(clippedValues, [], `${name}: exact selectable values readable without clipping`);
    assert.deepEqual(await page.evaluate(() => window.remoteCsp), [], `${name}: no CSP violations`);
  }
  await captureVariants(page, evidence, name);
}

export async function checkRemoteWorkflow({ browser, base, evidence, pass, checkHeader }) {
  const commands = join(base, "remote-bin"); await mkdir(commands);
  const statusLog = join(base, "peer-status.log");
  // External Tailscale status fixture. The real Client CLI parser runs; no real
  // tailscaled or peer is contacted, and the executable accepts status only.
  await writeFile(join(commands, "tailscale"), `#!/bin/sh\n[ "$1" = status ] && [ "$2" = --json ] || exit 9\necho status >> '${statusLog}'\necho '{"BackendState":"Running","Peer":{"fixture":{"ID":"peer-a","DNSName":"platform-a.test.","TailscaleIPs":["100.80.0.2"],"Online":true}}}'\n`, { mode: 0o700 });
  const cert = join(base, "remote-cert.pem"), key = join(base, "remote-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const tls = { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") }; // Text PEM, never a binary read.
  const originalFetch = globalThis.fetch, oldPath = process.env.PATH;
  let a, b, client, context;
  let losePath = "", lostReplies = 0;
  try {
    a = await platformFixture(base, "a", tls); b = await platformFixture(base, "b", tls);
    const destinations = new Set([a.deviceOrigin, a.uiOrigin, b.deviceOrigin, b.uiOrigin]);
    globalThis.fetch = async (url, init) => {
      const target = new URL(url);
      if (!destinations.has(target.origin)) {
        assert.equal(target.hostname, "127.0.0.1", "fixture refuses all external destinations");
        return originalFetch(url, init);
      }
      const result = await tlsFetch(url, init);
      if (target.pathname === losePath) { losePath = ""; lostReplies++; await result.body?.cancel(); throw new Error("lost_fixture_reply"); }
      return result;
    };
    process.env.PATH = `${commands}:${oldPath}`;
    client = await startClientUi({ root: join(base, "r"), port: 0, open: false });
    context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
    await context.route("**/*", route => {
      const target = new URL(route.request().url());
      return target.hostname === "127.0.0.1" || destinations.has(target.origin) ? route.continue() : route.abort();
    });
    const page = await context.newPage(), calls = [], errors = [], violations = [], storageFailures = [];
    page.on("pageerror", () => errors.push("pageerror"));
    page.on("console", message => { if (message.type() === "error" && /Content Security Policy/.test(message.text())) violations.push("csp"); });
    await page.addInitScript(() => { window.remoteCsp = []; document.addEventListener("securitypolicyviolation", event => window.remoteCsp.push(event.violatedDirective)); });
    await page.route("**/api/client/rpc", async route => {
      const input = route.request().postDataJSON(); calls.push(input);
      if (input.input.requestId) {
        try {
          const persisted = await page.evaluate(({ operation, input }) => Object.keys(localStorage).filter(key => key.includes(".remote.v1.")).some(key => {
            const record = JSON.parse(localStorage.getItem(key)); return record.operation === operation && JSON.stringify(record.input) === JSON.stringify(input);
          }), input);
          assert.ok(persisted, "UUID and exact input exist before requestId-bearing HTTP dispatch");
        } catch { storageFailures.push(input.operation); }
      }
      await route.continue();
    });
    const actionCount = () => calls.filter(call => mutating.has(call.operation)).length;
    const bootstrap = await client.host.call("client_ui_connect", {}); await page.goto(bootstrap.url); await page.waitForURL(`${client.origin}/client`);
    await page.getByRole("link", { name: "Connect manually", exact: true }).click();
    await page.getByRole("button", { name: "Inspect origin", exact: true }).waitFor();
    assert.equal(calls.filter(call => call.operation === "client_tailnet_peers").length, 0);
    for (const value of ["platform-a.test", "http://platform-a.test", `${a.deviceOrigin}/`, `${a.deviceOrigin}/path`]) {
      await page.getByLabel("Exact HTTPS device origin").fill(value); assert.ok(await page.getByRole("button", { name: "Inspect origin", exact: true }).isDisabled());
    }
    await page.getByRole("button", { name: "Show peer hints" }).click();
    await page.getByText("Peer online", { exact: true }).waitFor();
    await capture(page, evidence, "tailnet-peers", checkHeader);
    const beforeHints = actionCount(), networkBeforeHints = a.calls.length;
    await page.getByRole("button", { name: "Use peer hostname" }).click();
    assert.equal(await page.getByLabel("Exact HTTPS device origin").inputValue(), "https://platform-a.test");
    assert.equal(actionCount(), beforeHints); assert.equal(a.calls.length, networkBeforeHints);
    assert.equal((await readFile(statusLog, "utf8")).trim(), "status");
    pass("peer hints are explicit local status, labelled peers, fill-only and never probe/pair");

    await page.getByLabel("Exact HTTPS device origin").fill(a.deviceOrigin);
    a.env.STACK_ACCESS_ORIGIN = `https://wrong.test:${new URL(a.deviceOrigin).port}`;
    const inspectRefusal = page.waitForResponse(response => response.url().endsWith("/api/client/rpc") && response.request().postDataJSON()?.operation === "client_connection_inspect");
    await page.getByRole("button", { name: "Inspect origin", exact: true }).click();
    const refusal = await (await inspectRefusal).json();
    assert.equal(refusal.error, "connection_host_refused", "exact-origin rejection retains the bounded Access reason");
    await page.getByText("The target Access configuration refuses this exact device Host/origin.", { exact: false }).waitFor();
    assert.equal((await client.host.call("client_connection_list", {})).pending.pairings.length, 0);
    a.env.STACK_ACCESS_ORIGIN = a.deviceOrigin;
    await page.getByRole("button", { name: "Inspect origin", exact: true }).click();
    await page.getByLabel("Installation ID", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Installation ID", { exact: true }).inputValue(), a.context.store.serverId);
    assert.ok(await page.getByRole("button", { name: "Request approval", exact: true }).isDisabled());
    await capture(page, evidence, "manual-inspect-confirm", checkHeader);
    await page.getByLabel("Connection label").fill("Manual platform A");
    await page.getByLabel("I confirm this installation ID and every destination origin above").check();
    await page.getByRole("button", { name: "Request approval", exact: true }).click();
    await page.getByLabel("Complete approval code").waitFor();
    const manual = (await client.host.call("client_connection_list", {})).pending.pairings[0];
    assert.equal(await page.getByLabel("Complete approval code").inputValue(), manual.receipt.code);
    await page.getByLabel("Complete approval code").focus(); await page.keyboard.press("ControlOrMeta+A");
    assert.equal(await page.getByLabel("Complete approval code").evaluate(input => input.selectionEnd - input.selectionStart), 16, "complete approval code selects by keyboard");
    assert.equal(manual.receipt.code.length, 16);
    await capture(page, evidence, "manual-approval-code", checkHeader);
    const beforeReload = actionCount(); await page.reload(); await page.getByLabel("Complete approval code").waitFor();
    assert.equal(actionCount(), beforeReload, "reload does not redeem or replay pairing");
    await page.getByRole("button", { name: "Approved? Connect", exact: true }).click();
    await page.getByText("Approval is still pending.", { exact: false }).waitFor();
    await owner(a.context, "pairing_decide", { id: manual.receipt.id, code: manual.receipt.code, approve: true, scopes: ["ui:view"] });
    await page.getByRole("button", { name: "Approved? Connect", exact: true }).click();
    await page.getByRole("link", { name: "View saved connection" }).waitFor();
    await page.getByRole("link", { name: "View saved connection" }).click();
    await page.getByRole("button", { name: "Open platform", exact: true }).waitFor();
    const manualConnection = (await client.host.call("client_connection_list", {})).connections[0];
    await capture(page, evidence, "connection-detail", checkHeader);
    pass("manual exact-origin refusal, descriptor confirmation, full selectable approval code, trusted-local owner approval and deliberate redemption");

    // A completed real refresh with its answer lost: owner pendingOpen stays, and
    // exact recovery survives reload without a new native refresh generation.
    losePath = "/v1/access/refresh";
    const lostOpenAnswer = page.waitForResponse(response => response.url().endsWith("/api/client/rpc") && response.request().postDataJSON()?.operation === "client_connection_open");
    await page.getByRole("button", { name: "Open platform", exact: true }).click();
    assert.equal((await lostOpenAnswer).status(), 502);
    await page.getByRole("heading", { name: "Saved Open recovery" }).waitFor();
    const pendingOpen = (await client.host.call("client_connection_list", {})).connections.find(row => row.id === manualConnection.id).pendingOpen;
    assert.ok(pendingOpen); assert.equal(lostReplies, 1);
    const firstOpen = calls.filter(call => call.operation === "client_connection_open").at(-1);
    assert.equal(firstOpen.input.requestId, pendingOpen);
    await capture(page, evidence, "pending-open-recovery", checkHeader);
    const opensBeforeReload = calls.filter(call => call.operation === "client_connection_open").length;
    await page.reload(); await page.getByRole("button", { name: "Resume pending Open" }).waitFor();
    assert.equal(calls.filter(call => call.operation === "client_connection_open").length, opensBeforeReload);
    assert.ok(await page.getByRole("button", { name: "Resume pending Open" }).isDisabled());
    // Even when browser metadata is lost, the listed host UUID is authoritative.
    await page.evaluate(id => { for (const key of Object.keys(localStorage)) if (key.endsWith(id) || localStorage.getItem(key) === id) localStorage.removeItem(key); }, pendingOpen);
    await page.reload(); await page.getByRole("button", { name: "Resume pending Open" }).waitFor();
    assert.equal(calls.filter(call => call.operation === "client_connection_open").length, opensBeforeReload);
    await page.getByRole("button", { name: "Inspect current connection" }).click();
    const openedPage = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Resume pending Open" }).click();
    const viewer = await openedPage; await viewer.getByRole("heading", { name: "Disposable platform a" }).waitFor();
    assert.equal(new URL(viewer.url()).origin, a.uiOrigin); assert.equal(new URL(viewer.url()).hash, "");
    const retriedOpen = calls.filter(call => call.operation === "client_connection_open").at(-1);
    assert.deepEqual(retriedOpen.input, firstOpen.input);
    assert.equal((await client.host.call("client_connection_list", {})).connections.find(row => row.id === manualConnection.id).pendingOpen, null);
    assert.equal(a.context.store.inventory().credentials.filter(row => row.client_id === manualConnection.clientId).length, 1);
    assert.equal((await viewer.evaluate(async () => (await (await fetch("/connect/me")).json()).data)).scopes.join(), "ui:view");
    assert.ok(!await viewer.evaluate(() => document.cookie.includes("stack_ui")));
    const policy = await viewer.evaluate(async origin => {
      const ws = new WebSocket(`${origin.replace("https:", "wss:")}/websocket`);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("ws_fixture_failed")); });
      let id = 0;
      const call = (method, pkg, name) => new Promise(resolve => { const request = ++id; ws.onmessage = event => { const result = JSON.parse(event.data); if (result.id === request) resolve(result); }; ws.send(JSON.stringify({ id: request, method, params: { package: pkg, ...(name ? { name, arguments: {} } : {}) } })); });
      const read = await call("tools/call", "notify", "notification_counts"), write = await call("tools/call", "notify", "notification_dismiss"), local = await call("tools/call", "proc", "schedule_list");
      ws.close(); return { read, write, local };
    }, a.uiOrigin);
    assert.equal(policy.read.result.ok, true); assert.match(policy.write.error.message, /not available/); assert.match(policy.local.error.message, /not available/); assert.equal(a.writes, 0);
    await viewer.close();
    pass("lost real TLS refresh answer retains pendingOpen; reload inert; same UUID/input recovers independent HttpOnly view-only viewer and remote Proc/write restrictions");

    // Repeat a consumed handoff, then a NEW deliberate Open. The UI must not re-pair.
    const consumed = await client.host.call("client_connection_open", firstOpen.input);
    assert.equal((await tlsFetch(`${a.uiOrigin}/connect/device`, { method: "POST", headers: { origin: a.uiOrigin, "content-type": "application/json" }, body: JSON.stringify({ handoff: new URL(consumed.url).hash.slice(1) }) })).status, 401);
    await page.getByRole("button", { name: "Open platform", exact: true }).waitFor();
    const freshViewer = page.waitForEvent("popup"); await page.getByRole("button", { name: "Open platform", exact: true }).click();
    const fresh = await freshViewer; await fresh.getByRole("heading", { name: "Disposable platform a" }).waitFor(); await fresh.close();
    assert.notEqual(calls.filter(call => call.operation === "client_connection_open").at(-1).input.requestId, pendingOpen);
    assert.equal(calls.filter(call => call.operation === "client_pair_begin").length, 1);
    pass("consumed handoff is refused by Access; new explicit Open uses a new UUID without re-pairing");

    await page.goto(`${client.origin}/client/phone`);
    await page.getByLabel("Connection label").fill("Phone platform B");
    await page.getByRole("button", { name: "Make offline request" }).click();
    await page.getByRole("img", { name: "Offline desktop request QR" }).waitFor();
    const enrollment = (await client.host.call("client_connection_list", {})).pending.enrollments[0];
    const requestCall = calls.filter(call => call.operation === "client_enrollment_begin").at(-1);
    const request = await client.host.call("client_enrollment_begin", requestCall.input);
    assert.equal(request.id, enrollment.id);
    await capture(page, evidence, "phone-request-qr", checkHeader);
    await page.emulateMedia({ colorScheme: "dark" });
    const rendered = await page.getByRole("img", { name: "Offline desktop request QR" }).evaluate(svg => {
      const side = svg.viewBox.baseVal.width, rect = svg.querySelector("rect"), path = svg.querySelector("path");
      return { side, quietZone: svg.getAttribute("data-quiet-zone"), white: getComputedStyle(rect).fill, black: getComputedStyle(path).fill, modules: path.getAttribute("d") };
    });
    const matrix = await client.host.call("client_qr_render", { text: request.text });
    assert.equal(rendered.quietZone, "4"); assert.equal(rendered.side, matrix.size + 8);
    assert.equal(rendered.white, "rgb(255, 255, 255)"); assert.equal(rendered.black, "rgb(0, 0, 0)");
    const modules = [...rendered.modules.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(match => [Number(match[1]), Number(match[2])]);
    assert.equal(modules.length, matrix.rows.reduce((count, row) => count + [...row].filter(value => value === "1").length, 0));
    assert.ok(modules.every(([x, y]) => x >= 4 && y >= 4 && x < matrix.size + 4 && y < matrix.size + 4));

    // Real phone-kind device seeded via invitation/proof, not a copied credential
    // fixture. The sponsor's authenticated device APIs inspect and approve.
    const phoneIntent = await createEnrollmentIntent({ kind: "android", label: "Disposable sponsor phone", scopes: ["access:enroll", "ui:view"] });
    const secret = Buffer.alloc(32, 7).toString("base64url");
    const invitation = await owner(b.context, "enrollment_invite_create", { requestId: randomUUID(), secret, kind: "android", scopes: ["access:enroll", "ui:view"], expiresAt: Date.now() + 600_000 });
    const send = async (path, body, token) => {
      const response = await tlsFetch(`${b.deviceOrigin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-stack-server-id": b.context.store.serverId, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      assert.equal(response.status, 200); return (await response.json()).data;
    };
    const claimed = await send("/v1/access/enrollment/claim", { inviteId: invitation.invitation.id, secret, request: encodeQr(phoneIntent.request) });
    const phoneReceipt = claimed.receipt;
    const phone = await send("/v1/access/enrollment/redeem", { id: phoneReceipt.id, requestHash: phoneReceipt.requestHash, redemptionSecret: phoneIntent.redemptionSecret, signature: await signEnrollmentRedemption(phoneIntent, phoneReceipt) });
    const sponsor = await send("/v1/access/refresh", { refreshToken: phone.refreshToken, requestId: randomUUID(), audience: "access" });
    await send("/v1/access/enrollment/inspect", { request: request.text }, sponsor.accessToken);
    const approved = await send("/v1/access/enrollment/approve", { request: request.text, scopes: ["ui:view"] }, sponsor.accessToken);
    await page.getByLabel("Returned phone receipt").fill("https://never-navigate.example/path");
    await page.getByRole("button", { name: "Preview receipt" }).click();
    await page.getByText("The receipt does not match", { exact: false }).waitFor();
    assert.equal(calls.filter(call => call.operation === "client_enrollment_accept").length, 0);
    await page.getByLabel("Returned phone receipt").fill(approved.qr.text);
    await page.getByRole("button", { name: "Preview receipt" }).click();
    await page.getByRole("heading", { name: "Receipt destination", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Device origin", { exact: true }).inputValue(), b.deviceOrigin);
    assert.ok(await page.getByRole("button", { name: "Accept confirmed receipt" }).isDisabled());
    await capture(page, evidence, "phone-receipt-preview", checkHeader);
    await page.getByLabel("I confirm this installation ID, destination and approved permissions").check();
    await page.getByRole("button", { name: "Accept confirmed receipt" }).click();
    await page.getByRole("button", { name: "Connect to confirmed platform" }).waitFor();
    // Acceptance is not redemption, and its destination is not inferred on reload.
    assert.equal((await client.host.call("client_connection_list", {})).connections.length, 1);
    const phoneReloadCount = actionCount(); await page.reload();
    await page.getByText("A receipt is saved on the host", { exact: false }).waitFor();
    assert.equal(actionCount(), phoneReloadCount);
    await page.getByRole("button", { name: "Inspect current records" }).click();
    await page.getByRole("button", { name: "Show saved request QR" }).click();
    await page.getByRole("img", { name: "Offline desktop request QR" }).waitFor();
    await page.getByLabel("Returned phone receipt").fill(approved.qr.text); await page.getByRole("button", { name: "Preview receipt" }).click();
    await page.getByLabel("I confirm this installation ID, destination and approved permissions").check(); await page.getByRole("button", { name: "Accept confirmed receipt" }).click();
    await page.getByRole("button", { name: "Connect to confirmed platform" }).click();
    await page.getByRole("link", { name: "View saved connection" }).waitFor();
    const two = (await client.host.call("client_connection_list", {})).connections;
    assert.equal(two.length, 2); assert.equal(new Set(two.map(row => row.connection.serverId)).size, 2);
    await page.getByRole("link", { name: "Connections", exact: true }).click();
    await page.getByRole("heading", { name: "Manual platform A", exact: true }).waitFor(); await page.getByRole("heading", { name: "Phone platform B", exact: true }).waitFor();
    await capture(page, evidence, "connections-two-destinations", checkHeader);
    pass("local QR matrix has dark-theme black/white contrast and exact quiet zone; real invited phone approves via TLS; paste decode previews before confirmation/acceptance; saved receipt recovery is explicit; two distinct platforms retained");

    // Changed identity is a REAL replacement owner at the SAME device origin.
    await page.goto(`${client.origin}/client/connections/${manualConnection.id}`); await page.getByRole("button", { name: "Open platform", exact: true }).waitFor();
    a.replace(true); const refreshBefore = a.calls.filter(call => call.path === "/v1/access/refresh").length;
    await page.getByRole("button", { name: "Open platform", exact: true }).click();
    await page.getByText("The server identity or advertised destinations changed.", { exact: false }).waitFor();
    assert.equal(a.calls.filter(call => call.path === "/v1/access/refresh").length, refreshBefore, "credentials never sent to replaced owner");
    assert.equal((await client.host.call("client_connection_list", {})).connections.find(row => row.id === manualConnection.id).connection.serverId, a.context.store.serverId);
    await capture(page, evidence, "changed-identity", checkHeader); a.replace(false);
    await page.getByRole("button", { name: "Inspect current connection" }).click();
    const recoveredViewer = page.waitForEvent("popup"); await page.getByRole("button", { name: "Resume pending Open" }).click(); const recovered = await recoveredViewer;
    await recovered.getByRole("heading", { name: "Disposable platform a" }).waitFor(); await recovered.close();
    pass("real owner replacement at the same origin refuses changed identity before sending credentials; pinned identity not overwritten");

    // Five-minute retry limit: advance the real owner's clock after an actual
    // lost refresh. No fake admission or synthetic pendingOpen is installed.
    losePath = "/v1/access/refresh";
    const lostLateAnswer = page.waitForResponse(response => response.url().endsWith("/api/client/rpc") && response.request().postDataJSON()?.operation === "client_connection_open");
    await page.getByRole("button", { name: "Open platform", exact: true }).click(); assert.equal((await lostLateAnswer).status(), 502); await page.getByRole("heading", { name: "Saved Open recovery" }).waitFor();
    const originalNow = a.context.store.now; a.context.store.now = () => Date.now() + 300_001;
    const expiredOpenAnswer = page.waitForResponse(response => response.url().endsWith("/api/client/rpc") && response.request().postDataJSON()?.operation === "client_connection_open");
    await page.getByRole("button", { name: "Inspect current connection" }).click(); await page.getByRole("button", { name: "Resume pending Open" }).click();
    assert.equal((await (await expiredOpenAnswer).json()).error, "unauthorized", "Access cleanup expires the real refresh retry record; do not infer a more specific refusal");
    await page.getByText("Access did not authorize this request.", { exact: false }).waitFor();
    await capture(page, evidence, "expired-open-retry-window", checkHeader); a.context.store.now = originalNow;
    const recoveredAfterClock = page.waitForEvent("popup"); await page.getByRole("button", { name: "Inspect current connection" }).click(); await page.getByRole("button", { name: "Resume pending Open" }).click();
    const afterClock = await recoveredAfterClock; await afterClock.getByRole("heading", { name: "Disposable platform a" }).waitFor(); await afterClock.close();

    // Revision is captured at review, then the REAL owner increments it with Open.
    await page.getByRole("button", { name: "Forget connection…" }).click(); await page.getByRole("heading", { name: "Forget locally?" }).waitFor();
    await capture(page, evidence, "forget-confirm", checkHeader);
    const beforeRevision = (await client.host.call("client_connection_list", {})).connections.find(row => row.id === manualConnection.id).revision;
    await client.host.call("client_connection_open", { id: manualConnection.id, requestId: randomUUID() });
    await page.getByRole("button", { name: "Confirm local removal" }).click();
    await page.getByText("The record changed since you reviewed it.", { exact: false }).waitFor();
    assert.ok((await client.host.call("client_connection_list", {})).connections.some(row => row.id === manualConnection.id));
    assert.equal(calls.filter(call => call.operation === "client_connection_forget").at(-1).input.expectedRevision, beforeRevision);
    await page.getByRole("button", { name: "Forget connection…" }).click(); await page.getByRole("button", { name: "Confirm local removal" }).click();
    await page.getByRole("heading", { name: "Connection forgotten locally" }).waitFor();
    assert.equal((await client.host.call("client_connection_list", {})).connections.length, 1);
    assert.ok(a.context.store.inventory().credentials.every(row => row.revoked === null));
    pass("five-minute native recovery limit is surfaced without reset/re-pair; stale Forget revision rereads and requires new confirmation; local removal never revokes Access");

    const phoneConnection = two.find(row => row.connection.serverId === b.context.store.serverId);
    const grant = b.context.store.inventory().grants.find(row => row.client_id === phoneConnection.clientId);
    await owner(b.context, "access_revoke", { kind: "grant", id: grant.id });
    await page.goto(`${client.origin}/client/connections/${phoneConnection.id}`); await page.getByRole("button", { name: "Open platform", exact: true }).waitFor();
    await page.getByRole("button", { name: "Open platform", exact: true }).click();
    await page.getByText("Access refused this credential:", { exact: false }).waitFor();
    await capture(page, evidence, "grant-revoked", checkHeader);
    pass("trusted-local real Access grant revocation is surfaced truthfully; saved connection stays distinct from live permission");

    // Storage failure blocks dispatch at the actual browser/owner boundary.
    await page.goto(`${client.origin}/client/phone`); await page.getByLabel("Connection label").fill("Storage blocked");
    await page.evaluate(() => { window.originalStorageSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.includes(".remote.v1.")) throw new Error("fixture_storage_full"); return window.originalStorageSet.call(this, key, value); }; });
    const blockedBefore = actionCount(); await page.getByRole("button", { name: "Make offline request" }).click();
    await page.getByText("Recovery storage is unavailable or changed.", { exact: false }).waitFor();
    assert.equal(actionCount(), blockedBefore);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageSet; });
    pass("browser persistence failure prevents requestId-bearing dispatch; journals are root/destination qualified and verified before every dispatch");

    // Install the clock before navigation so the screen's interval is owned by it.
    await page.clock.install({ time: Date.now() });
    await page.goto(`${client.origin}/client/phone`); await page.getByLabel("Connection label").fill("Expired phone request"); await page.getByRole("button", { name: "Make offline request" }).click();
    await page.getByRole("img", { name: "Offline desktop request QR" }).waitFor();
    const expiryCall = calls.filter(call => call.operation === "client_enrollment_begin").at(-1), expiredRequest = await client.host.call("client_enrollment_begin", expiryCall.input);
    const beforeExpiry = actionCount(); await page.clock.setSystemTime(Date.now() + 600_001); await page.clock.runFor(1001);
    await page.getByRole("alert").getByText("Request expired", { exact: true }).waitFor();
    assert.equal(await page.getByRole("img", { name: "Offline desktop request QR" }).count(), 0); assert.ok(await page.getByRole("button", { name: "Preview receipt" }).isDisabled());
    assert.equal(actionCount(), beforeExpiry);
    const originalDate = Date.now; Date.now = () => originalDate() + 600_001;
    try { await assert.rejects(client.host.call("client_qr_render", { text: expiredRequest.text }), /enrollment_expired_or_clock_skew/); }
    finally { Date.now = originalDate; }
    await capture(page, evidence, "phone-request-expired", checkHeader);
    await page.getByRole("button", { name: "Forget pending intent…" }).click(); await page.getByRole("button", { name: "Confirm local removal" }).click();
    await page.getByText("Intent forgotten locally.", { exact: false }).waitFor();
    assert.ok(!(await client.host.call("client_connection_list", {})).pending.enrollments.some(row => row.id === expiryCall.input.requestId));
    await assert.rejects(client.host.call("client_enrollment_begin", expiryCall.input), /intent_abandoned/);
    await page.clock.setSystemTime(Date.now());
    pass("expired real QR intent is hidden/blocked, never renewed; exact pending intent Forget abandons its UUID on the real owner");

    // Review only safe projections and journals, never SQLite bytes or secrets.
    const journals = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("stack.client.")).map(key => ({ key, value: localStorage.getItem(key) })));
    const rootNamespace = `stack.client.stack_client_ui_${createHash("sha256").update(client.root).digest("hex").slice(0, 24)}.`;
    assert.ok(journals.every(row => row.key.startsWith(rootNamespace)));
    assert.ok(!/refreshToken|redemptionSecret|privateKey|accessToken|\/connect\/device#/.test(JSON.stringify(journals)));
    assert.deepEqual(storageFailures, []); assert.deepEqual(errors, []); assert.deepEqual(violations, []); assert.deepEqual(await page.evaluate(() => window.remoteCsp), []);
    const loopback = address => ["127.0.0.1", "::ffff:127.0.0.1"].includes(address);
    assert.ok([...a.peers, ...b.peers].every(peer => loopback(peer.remoteAddress) && loopback(peer.localAddress) && peer.remotePort > 0));
    if (evidence) await writeFile(join(evidence, "remote-workflow-check.json"), JSON.stringify({ ok: true, pageErrors: errors, cspViolations: violations, exactInputBeforeDispatch: true, lostReplies, distinctPlatforms: 2,
      tlsKernelPeers: true, externalNetwork: false, liveTailnetVerified: false, serviceRegistration: false, cameraUsed: false, fakes: ["Self-signed loopback TLS + fixture DNS/Host routing and TLS trust", "Access direct-tailnet verifier stand-in", "Tailscale status PATH executable", "Minimal notify/proc Package API sockets and remote platform HTML", "Lost network refresh answers after real Access mutation", "Browser recovery metadata loss and storage write failure", "Browser/owner clocks for expiry"] }, null, 2));
    pass("remote workflows hydrate without page/CSP errors, credentials/capability URLs absent from browser storage, real TLS kernel peers recorded");
  } finally {
    await context?.close(); await client?.close(); await b?.close(); await a?.close();
    globalThis.fetch = originalFetch; process.env.PATH = oldPath;
  }
}

// Focused executable entry for diagnosis; the full Client check also runs this
// module together with the existing M8a/M8b security and local workflows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = await mkdtemp("/private/tmp/s8r-"), home = join(base, "home"), evidence = process.env.CLIENT_EVIDENCE_DIR;
  await mkdir(home); if (evidence) await mkdir(evidence, { recursive: true });
  const oldHome = process.env.HOME, oldManifest = process.env.STACK_CLIENT_RELEASE_MANIFEST;
  process.env.HOME = home; delete process.env.STACK_CLIENT_RELEASE_MANIFEST;
  let browser;
  try {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--host-resolver-rules=MAP *.test 127.0.0.1", "--no-proxy-server"] });
    await checkRemoteWorkflow({ browser, base, evidence, pass: label => console.log(`PASS ${label}`), checkHeader: async page => assert.equal(await page.locator("header").count(), 1) });
  } finally {
    await browser?.close(); await rm(base, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldManifest === undefined) delete process.env.STACK_CLIENT_RELEASE_MANIFEST; else process.env.STACK_CLIENT_RELEASE_MANIFEST = oldManifest;
    console.log("PASS focused remote workflow resources released");
  }
}
