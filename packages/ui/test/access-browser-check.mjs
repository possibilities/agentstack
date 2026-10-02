// Isolated Access UI acceptance check; no live server, client state, or external traffic.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node test/access-browser-check.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveSocket, serveWebSocket, socketPath, StateJournal } from "@stack/api";
import { fixtureWorkspace, passthrough, transport, authorizeBrowser, fixtureServerId, seedRecovery } from "./browser-fixture.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const ui = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(ui));
const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "stack-access-browser-"));
const evidence = process.env.ACCESS_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const now = Date.now();
const data = {
  serverId: "00000000-0000-4000-8000-000000000001",
  clients: [{ id: "device", label: "My phone", kind: "android", created: now, revoked: null },
    { id: "extension", label: "Work Chrome", kind: "chrome", created: now, revoked: null },
    { id: "remote", label: "Remote browser", kind: "browser", created: now, revoked: null },
    { id: "mystery", label: "Mystery client", kind: "tablet", created: now, revoked: null },
    { id: "laptop", label: "Laptop", kind: "desktop", created: now, revoked: null }],
  pairings: [{ id: "request", code: "ORCHID-GLASS-673428", label: "New phone", kind: "android", scopes: ["brain:share", "brain:status", "content:read"], created: now, expires: now + 600000, state: "pending" },
    { id: "browser-request", code: "AMBER-RIVER-118204", label: "Browser request", kind: "browser", scopes: ["ui:view", "access:enroll"], created: now, expires: now + 600000, state: "pending" },
    { id: "expired", code: "EXPIRED-CODE", label: "Old request", kind: "chrome", scopes: ["brain:share"], created: now - 10000, expires: now - 1, state: "pending" }],
  grants: [{ id: "grant", client_id: "device", network: "tailnet", scopes: ["brain:share", "brain:status"], operations: [], created: now, revoked: null, revision: 1, enrollment_id: null, sponsor_credential_id: null },
    { id: "cloud", client_id: "device", network: "public-cloud", scopes: [], operations: ["content.document_get"], created: now, revoked: null, revision: 1, enrollment_id: null, sponsor_credential_id: null },
    { id: "sponsor-grant", client_id: "extension", network: "tailnet", scopes: ["access:enroll", "brain:share"], operations: [], created: now, revoked: null, revision: 3, enrollment_id: null, sponsor_credential_id: null },
    { id: "browser-grant", client_id: "remote", network: "tailnet", scopes: ["access:enroll", "ui:view"], operations: [], created: now, revoked: null, revision: 1, enrollment_id: null, sponsor_credential_id: null },
    { id: "mystery-grant", client_id: "mystery", network: "tailnet", scopes: ["brain:share"], operations: [], created: now, revoked: null, revision: 1, enrollment_id: null, sponsor_credential_id: null },
    { id: "enrolled-grant", client_id: "laptop", network: "tailnet", scopes: ["brain:share"], operations: [], created: now, revoked: null, revision: 1, enrollment_id: "enrollment", sponsor_credential_id: "sponsor-credential" },
    { id: "local-enrolled-grant", client_id: "laptop", network: "tailnet", scopes: ["content:read"], operations: [], created: now, revoked: null, revision: 1, enrollment_id: "local-enrollment", sponsor_credential_id: null }],
  invitations: [], enrollments: [],
  credentials: [{ id: "credential", client_id: "device", grant_id: "grant", generation: 2, created: now, expires: now + 600000, revoked: null },
    { id: "old-credential", client_id: "device", grant_id: "grant", generation: 1, created: now - 20000, expires: now - 1, revoked: null },
    { id: "sponsor-credential", client_id: "extension", grant_id: "sponsor-grant", generation: 1, created: now, expires: now + 600000, revoked: null }],
  audit: [], uiSessions: [], ingress: { host: "100.64.0.1", port: 8787, artifactPort: 8788, uiPort: 8789 },
};
const served = new Map(), calls = [], errors = [], external = [];
const historyJournal = new StateJournal(join(dir, "access-state.sqlite"), "access");
const historyRows = (kind) => data[kind === "ui_sessions" ? "uiSessions" : kind === "expired_pairings" ? "pairings" : "invitations"];
const historyRevision = ({ kind, ids }) => JSON.stringify(historyRows(kind).filter((row) => ids.includes(row.id)));
let websocket, next, browser, log = "", failUpdate = true, failSnapshot = false;
const publish = () => served.get("access").publish("access_changed");
const handlers = {
  access_history_plan: (selection) => historyJournal.plan({ subject: null, action: `history_${selection.kind}`, revision: historyRevision(selection), resources: selection.ids,
    blockedBy: historyRows(selection.kind).filter((row) => selection.ids.includes(row.id) && row.expires > Date.now()).map((row) => `${row.id}: active/unexpired authority cannot be retired; revocation is separate`),
    retained: ["Server/client/grant/credential identity and revocations", "Enrollment/Share receipts and minimal replay digests", "Device cookies, outboxes and backups"], regeneration: [] }, selection),
  access_history_clear: (input) => {
    const prior = historyJournal.existing(input); if (prior) return prior;
    const { plan, payload } = historyJournal.getPlan(input.planId);
    assert.equal(plan.revision, historyRevision(payload)); assert.deepEqual(plan.blockedBy, []);
    historyJournal.begin(input, plan);
    const key = payload.kind === "ui_sessions" ? "uiSessions" : payload.kind === "expired_pairings" ? "pairings" : "invitations";
    data[key] = data[key].filter((row) => !payload.ids.includes(row.id));
    const receipt = historyJournal.finish(input.requestId, "completed", payload.ids.map((resource) => ({ resource, outcome: "removed", detail: "Expired metadata cleared; replay evidence retained" })));
    publish(); return receipt;
  },
  access_state_receipt_get: ({ requestId }) => ({ receipt: historyJournal.receipt(requestId) }),
  access_snapshot: () => { if (failSnapshot) throw new Error("Fixture snapshot unavailable"); return data; },
  pairing_decide: (input) => { data.pairings.find((item) => item.id === input.id).state = input.approve ? "approved" : "denied"; publish(); return { approved: input.approve }; },
  grant_update: (input) => {
    if (failUpdate) throw new Error("Fixture permission update failed");
    const grant = data.grants.find((item) => item.id === input.id);
    assert.equal(input.expectedRevision, grant.revision);
    Object.assign(grant, { scopes: input.scopes, operations: input.operations, revision: grant.revision + 1 });
    publish(); return { id: grant.id, revision: grant.revision };
  },
  access_revoke: (input) => { data[`${input.kind}s`].find((item) => item.id === input.id).revoked = Date.now(); publish(); return { revoked: true }; },
  serve_status: () => ({ serverId: fixtureServerId, pid: process.pid, startedAt: new Date().toISOString(), nodeVersion: process.version, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  account_list: () => ({ accounts: [] }), account_login_current: () => ({ login: null }),
  worker_account_list: () => ({ accounts: [] }), worker_account_login_current: () => ({ logins: [] }),
  bot_list: () => ({ bots: [] }), bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }), worker_list: () => ({ workers: [] }), worker_runtime_list: () => ({ runtimes: [] }),
  usage_snapshot: () => ({ atMs: now, inventoryAtMs: now, inventoryError: null, accounts: [] }),
};
try {
  const definitions = { access: ["access_snapshot", "pairing_decide", "grant_update", "access_revoke", "access_history_plan", "access_history_clear", "access_state_receipt_get"], serve: ["serve_status"],
    auth: ["account_list", "account_login_current", "worker_account_list", "worker_account_login_current"], bots: ["bot_list", "bot_defaults_get", "voice_status"],
    worker: ["worker_list", "worker_runtime_list"], usage: ["usage_snapshot"], api: ["docs_snapshot"] };
  websocket = await serveWebSocket({ env, root: await fixtureWorkspace(dir, Object.keys(definitions)), port: 0 });
  const topics = { access: { access_changed: "Fixture" } };
  handlers.docs_snapshot = () => ({ packages: Object.keys(definitions).map((name) => ({ name, packageName: `@stack/${name}`, description: "Access fixture", events: topics[name] ?? {}, eventScope: null, operations: [],
    transports: [transport(websocket.url, definitions[name], Object.keys(topics[name] ?? {}))] })) });
  for (const [name, names] of Object.entries(definitions)) served.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
    operations: names.map((name) => ({ name, description: name, input: passthrough, output: passthrough, async call(_, input) { calls.push({ name, input }); return handlers[name](input); } })), events: { topics: topics[name] ?? {} } }));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${port}`;
  await new Promise((resolve) => server.close(resolve));
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), process.env.UI_ACCESS_NEXT_MODE === "dev" ? "dev" : "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${port}`, deadline = Date.now() + 90000;
  for (;;) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch {}
    if (Date.now() > deadline || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce", colorScheme: "light" });
  await context.route("**/*", (route) => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/system?focus=access-pairing:request`);
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  const pairing = page.locator('[data-node="access-pairing:request"]');
  const grant = page.locator('[data-node="access-grant:grant"]');
  const client = page.locator('[data-node="access-client:device"]');
  const reveal = async (panel) => {
    const inspect = panel.getByRole("button", { name: /^Inspect / });
    if (await inspect.getAttribute("aria-pressed") !== "true") { await inspect.evaluate((element) => element.focus({ preventScroll: true })); await page.keyboard.press("Enter"); }
    await page.getByRole("button", { name: "Show on bench", exact: true }).click();
    const close = page.getByRole("button", { name: "Close inspector", exact: true });
    if (await close.isVisible()) await close.click();
    await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
    await panel.locator(":scope > .animate-ui-flash").waitFor({ state: "attached" });
    await panel.locator(":scope > .animate-ui-flash").waitFor({ state: "detached" });
  };
  await pairing.getByText("ORCHID-GLASS-673428").waitFor();
  await page.getByText("Manual pairing approvals", { exact: true }).waitFor();
  assert.equal(await page.getByText("EXPIRED-CODE").count(), 0);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await reveal(pairing);
    await pairing.screenshot({ path: join(evidence, `approval-${theme}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await reveal(pairing);
  assert.ok(await pairing.evaluate((element) => element.scrollWidth <= element.clientWidth), "approval content fits narrow width");
  await pairing.screenshot({ path: join(evidence, "approval-narrow.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await reveal(pairing);
  await pairing.getByRole("switch", { name: "Read Content" }).click();
  await pairing.getByRole("button", { name: "Approve matching code", exact: true }).click();
  await pairing.waitFor({ state: "hidden" });
  assert.deepEqual(calls.find((call) => call.name === "pairing_decide").input, { id: "request", code: "ORCHID-GLASS-673428", approve: true, scopes: ["brain:share", "brain:status"] });
  // A browser pairing's requested enrollment scope is shown but cannot be approved.
  const browserPairing = page.locator('[data-node="access-pairing:browser-request"]');
  await reveal(browserPairing);
  const pairingEnroll = browserPairing.getByRole("switch", { name: /^Enroll other devices/ });
  assert.equal(await pairingEnroll.isChecked(), false); assert.equal(await pairingEnroll.isDisabled(), true);
  await browserPairing.getByRole("button", { name: "Approve matching code", exact: true }).click();
  await browserPairing.waitFor({ state: "hidden" });
  assert.deepEqual(calls.filter((call) => call.name === "pairing_decide").at(-1).input, { id: "browser-request", code: "AMBER-RIVER-118204", approve: true, scopes: ["ui:view"] });
  await reveal(grant);
  await grant.getByRole("button", { name: "Edit permissions", exact: true }).click();
  assert.equal(await grant.getByRole("switch", { name: /^Enroll other devices/ }).isDisabled(), false, "android may sponsor");
  await grant.getByRole("switch", { name: "Read Content" }).click();
  await grant.getByRole("button", { name: "Save permissions", exact: true }).click();
  await grant.getByRole("alert").getByText("Fixture permission update failed", { exact: true }).waitFor();
  assert.equal(await grant.getByRole("switch", { name: "Read Content" }).isChecked(), true, "failed update preserves draft");
  failUpdate = false;
  await grant.getByRole("button", { name: "Save permissions", exact: true }).click();
  await grant.getByRole("button", { name: "Edit permissions", exact: true }).waitFor();
  assert.deepEqual(calls.filter((call) => call.name === "grant_update").at(-1).input, { id: "grant", expectedRevision: 1, scopes: ["brain:share", "brain:status", "content:read"], operations: [] });
  await grant.screenshot({ path: join(evidence, "grant-updated.png"), animations: "disabled" });
  // Unknown kinds are never offered enrollment.
  const mystery = page.locator('[data-node="access-grant:mystery-grant"]');
  await reveal(mystery);
  await mystery.getByRole("button", { name: "Edit permissions", exact: true }).click();
  await mystery.getByRole("switch", { name: "Read Content", exact: true }).waitFor();
  assert.equal(await mystery.getByRole("switch", { name: /^Enroll other devices/ }).count(), 0);
  await mystery.getByRole("button", { name: "Cancel", exact: true }).click();
  // A stored browser enrollment scope stays visible as ineffective, survives other edits, and can be removed but not restored.
  const browserGrant = page.locator('[data-node="access-grant:browser-grant"]');
  await reveal(browserGrant);
  await browserGrant.getByText(/no effect for browser clients/).waitFor();
  await browserGrant.getByRole("button", { name: "Edit permissions", exact: true }).click();
  const browserEnroll = browserGrant.getByRole("switch", { name: /^Enroll other devices.*no effect for browser clients/ });
  assert.equal(await browserEnroll.isChecked(), true); assert.equal(await browserEnroll.isDisabled(), false);
  await browserGrant.getByRole("switch", { name: "Control remote UI", exact: true }).click();
  await browserGrant.getByRole("button", { name: "Save permissions", exact: true }).click();
  await browserGrant.getByRole("button", { name: "Edit permissions", exact: true }).waitFor();
  assert.deepEqual(calls.filter((call) => call.name === "grant_update").at(-1).input.scopes, ["access:enroll", "ui:view", "ui:control"]);
  await browserGrant.getByRole("button", { name: "Edit permissions", exact: true }).click();
  await browserEnroll.click();
  assert.equal(await browserGrant.getByRole("switch", { name: /^Enroll other devices/ }).isDisabled(), true);
  await browserGrant.getByRole("button", { name: "Save permissions", exact: true }).click();
  await browserGrant.getByRole("button", { name: "Edit permissions", exact: true }).waitFor();
  assert.deepEqual(calls.filter((call) => call.name === "grant_update").at(-1).input.scopes, ["ui:view", "ui:control"]);
  assert.equal(await browserGrant.getByText(/Enroll other devices/).count(), 0);
  // Sponsor grants explain revision fencing and revocation reach.
  const sponsorGrant = page.locator('[data-node="access-grant:sponsor-grant"]');
  await reveal(sponsorGrant);
  await sponsorGrant.getByRole("button", { name: "Edit permissions", exact: true }).click();
  await sponsorGrant.getByText(/invalidates outstanding enrollment approvals/).waitFor();
  await sponsorGrant.screenshot({ path: join(evidence, "sponsor-grant-edit.png"), animations: "disabled" });
  await sponsorGrant.getByRole("button", { name: "Cancel", exact: true }).click();
  await sponsorGrant.getByRole("button", { name: /^Revoke grant/ }).click();
  await page.getByRole("alertdialog").getByText(/must be revoked separately/).waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await grant.getByRole("button", { name: /^Revoke grant/ }).click();
  assert.equal(await page.getByRole("alertdialog").getByText(/must be revoked separately/).count(), 0, "non-sponsor grant omits enrollment note");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  // Sponsor provenance links to the sponsoring credential; missing provenance adds no link.
  const enrolled = page.locator('[data-node="access-grant:enrolled-grant"]');
  await enrolled.getByRole("button", { name: /^Inspect / }).click();
  const inspector = page.locator('[data-dock="right"]');
  await inspector.getByText("sponsor-credential").first().waitFor();
  await inspector.screenshot({ path: join(evidence, "sponsor-provenance.png"), animations: "disabled" });
  await inspector.getByRole("button", { name: "Sponsor credential", exact: true }).click();
  await page.locator('[data-node="access-credential:sponsor-credential"] > .animate-ui-flash').waitFor({ state: "attached" });
  await page.locator('[data-node="access-grant:local-enrolled-grant"]').getByRole("button", { name: /^Inspect / }).click();
  await inspector.getByText("local-enrollment").first().waitFor();
  assert.equal(await inspector.getByRole("button", { name: "Sponsor credential", exact: true }).count(), 0);
  assert.equal(await page.getByText(/manually paired/i).count(), 0);
  await page.getByRole("button", { name: "Close inspector", exact: true }).click();
  assert.match(await page.locator('[data-node="access-credential:old-credential"]').innerText(), /Expired/);
  assert.match(await page.locator('[data-node="access-grant:cloud"]').innerText(), /Foundation only/);
  await reveal(client);
  await client.getByRole("button", { name: "Revoke client My phone", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("heading", { name: "Revoke client?", exact: true }).waitFor();
  assert.equal(calls.filter((call) => call.name === "access_revoke").length, 0);
  await dialog.screenshot({ path: join(evidence, "revoke-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(calls.filter((call) => call.name === "access_revoke").length, 0);
  await client.getByRole("button", { name: "Revoke client My phone", exact: true }).click();
  await dialog.getByRole("button", { name: "Revoke client", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator('[data-node="access-credential:credential"]').getByText("Blocked by client", { exact: true }).waitFor();
  assert.equal(await grant.getByRole("button", { name: "Edit permissions", exact: true }).isDisabled(), true);
  assert.deepEqual(calls.filter((call) => call.name === "access_revoke").at(-1).input, { kind: "client", id: "device" });
  const expiredSession = "00000000-0000-4000-8000-000000000101", expiredInvite = "00000000-0000-4000-8000-000000000102";
  data.uiSessions = [{ id: expiredSession, credential_id: "credential", expires: now - 1 }, { id: "active-session", credential_id: "credential", expires: now + 600000 }];
  data.invitations = [{ id: expiredInvite, kind: "chrome", scopes: ["brain:share"], created: now - 10000, expires: now - 1, revoked: null, request_id: null },
    { id: "active-invite", kind: "chrome", scopes: [], created: now, expires: now + 600000, revoked: now, request_id: null }];
  publish();
  const accessWindow = page.locator('[data-window="access"]');
  const history = accessWindow.getByRole("heading", { name: "Expired history", exact: true }).locator("../..");
  const groups = [["ui_sessions", "Expired UI sessions", expiredSession], ["expired_pairings", "Expired pairings", "expired"], ["expired_invitations", "Expired invitations", expiredInvite]];
  for (const [kind, title, id_] of groups) {
    const scope = history.locator("details").filter({ hasText: title });
    await scope.locator("summary").evaluate((element) => element.focus({ preventScroll: true })); await page.keyboard.press("Enter");
    await scope.getByRole("checkbox", { name: `Select ${kind} ${id_}` }).check();
    assert.equal(await scope.getByRole("checkbox").count(), 1, "only expired metadata is selectable");
    if (kind === "ui_sessions") {
      data.uiSessions[0].expires = now + 600000;
      await scope.getByRole("button", { name: `Prepare clearing 1 ${title.toLowerCase()}` }).click();
      await scope.getByText(`${id_}: active/unexpired authority cannot be retired; revocation is separate`).waitFor();
      assert.equal(await scope.getByRole("button", { name: `Clear these ${title.toLowerCase()}` }).isDisabled(), true);
      data.uiSessions[0].expires = now - 1;
      publish();
      await scope.getByRole("button", { name: "Prepare a new plan" }).click();
    } else await scope.getByRole("button", { name: `Prepare clearing 1 ${title.toLowerCase()}` }).click();
    await scope.getByText("Enrollment/Share receipts and minimal replay digests", { exact: true }).waitFor();
    assert.equal(await scope.getByRole("checkbox").first().isDisabled(), true);
    if (kind === "ui_sessions") {
      await page.emulateMedia({ colorScheme: "light" }); await history.screenshot({ path: join(evidence, "history-plan-light.png") });
      await page.emulateMedia({ colorScheme: "dark" }); await history.screenshot({ path: join(evidence, "history-plan-dark.png") });
    }
    await scope.getByRole("button", { name: `Clear these ${title.toLowerCase()}` }).click();
    await scope.getByText("Completed for the declared scope only.").waitFor();
    assert.equal(historyRows(kind).some((row) => row.id === id_), false);
  }
  assert.equal(data.clients.find((row) => row.id === "device").revoked !== null, true, "clearing never undoes revocation");
  assert.equal(data.uiSessions.length, 1); assert.equal(data.invitations.length, 1, "unexpired revoked invitations stay");
  const recovered = handlers.access_history_plan({ kind: "ui_sessions", ids: ["active-session"] });
  const recoverInput = { planId: recovered.id, expectedRevision: recovered.revision, requestId: crypto.randomUUID() };
  historyJournal.begin(recoverInput, recovered); historyJournal.finish(recoverInput.requestId, "unknown", [{ resource: "active-session", outcome: "unknown", detail: "Unknown history result" }]);
  await seedRecovery(page, origin, "access:history:ui_sessions", recoverInput);
  await page.reload();
  await history.getByRole("region", { name: "access receipt unknown" }).waitFor();
  await accessWindow.locator("summary", { hasText: "Audit retention" }).evaluate((element) => element.focus({ preventScroll: true })); await page.keyboard.press("Enter");
  await accessWindow.getByText("observed rows can exceed 1,000", { exact: false }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await history.screenshot({ path: join(evidence, "history-unknown-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 1100 });
  failSnapshot = true;
  publish();
  await page.getByRole("alert").getByText(/Access read failed: Fixture snapshot unavailable/).waitFor();
  assert.equal(await client.getByRole("button", { name: "Revoke client My phone", exact: true }).isDisabled(), true);
  failSnapshot = false;
  data.clients = []; data.grants = []; data.credentials = []; data.pairings = [];
  publish();
  await page.getByText("No paired clients", { exact: true }).waitFor();
  for (const title of ["No pending manual pairings", "No grants", "No credentials", "No access activity"]) assert.equal(await page.getByText(title, { exact: true }).count(), 1);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ ok: true, evidence, assertions: "expiry; scoped approval; kind-aware enrollment scope (browser pairing, unknown, stored browser scope kept/removed); sponsor revision and revocation notes; sponsor provenance link; grant revision/update/error/retry; client revoke confirm/cancel; dependent credential status; snapshot error/stale/empty; inspector routing; light/dark/narrow; no external requests or hydration errors" }, null, 2));
} catch (error) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  console.error(log, { errors, external }); throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close(); await Promise.all([...served.values()].map((socket) => socket.close()));
  historyJournal.close();
  if (process.env.ACCESS_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
