// Optional rendered auth check. Isolated fixture sockets; no live server/provider calls.
// After pnpm test: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/auth-browser-check.mjs
// UI_AUTH_NEXT_MODE=dev uses Next dev without a production build. CHROME_BIN overrides local Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveSocket, serveWebSocket, socketPath, StateJournal } from "@stack/api";
import { fixtureWorkspace, anyObject, transport, z, authorizeBrowser, fixtureServerId, seedRecovery } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const ui = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(ui));
const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "stack-auth-browser-"));
const evidence = process.env.AUTH_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const providers = ["codex", "devin", "claude"];
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const accounts = providers.map((provider, index) => ({ id: id(index + 1), provider, enabled: true, ready: false, removing: false, linkedAccounts: [] }));
const authUrls = {
  codex: "https://auth.openai.com/codex/device",
  devin: "https://windsurf.com/devin/account/login?state=fixture-long-state-for-copy-verification&code_challenge=fixture",
  claude: "https://claude.ai/oauth/authorize?state=fixture-claude-sign-in",
};
let serial = 10;
const attempts = new Map();
function newAttempt(account) {
  const needsCode = account.provider === "devin" || account.provider === "claude";
  const attempt = { id: id(serial++), account: account.id, provider: account.provider, status: "pending", authUrl: authUrls[account.provider],
    userCode: needsCode ? null : `${account.provider.toUpperCase()}-CODE`, needsCode, error: null };
  attempts.set(attempt.id, attempt);
  return attempt;
}
accounts.forEach(newAttempt);
const botAttempt = { id: id(100), account: null, targetAccount: null, status: "pending", authUrl: authUrls.codex, userCode: "BOT-CODE", error: null };
const served = new Map();
const calls = [];
const cacheJournal = new StateJournal(join(dir, "cache-state.sqlite"), "auth");
let cacheDraining = true, cacheClears = 0, runtimeLive = false, retainedWorker = false;
let websocket, next, browser, submitGate, submitEntered;
let log = "";
const current = (provider) => [...attempts.values()].findLast((attempt) => attempt.provider === provider);
const publish = () => served.get("auth").publish("worker_login_changed");
const handlers = {
  worker_account_cache_plan: ({ accountId }) => cacheJournal.plan({ subject: { kind: "worker-account", id: accountId }, action: "account_cache_clear", revision: `cache-${cacheClears}`,
    resources: ["cache/opencode/models.json"], blockedBy: cacheDraining ? ["Catalog teardown is still draining"] : [],
    retained: ["Credentials, keychains, native sessions and sibling accounts"], regeneration: ["Explicit later model discovery may recreate models.json"] }, { accountId }),
  worker_account_cache_clear: (input) => {
    const existing = cacheJournal.existing(input); if (existing) return existing;
    const { plan } = cacheJournal.getPlan(input.planId);
    cacheJournal.begin(input, plan); cacheClears++;
    const receipt = cacheJournal.finish(input.requestId, "completed", [{ resource: "cache/opencode/models.json", outcome: "removed", detail: "Pure model-list cache cleared" }]);
    served.get("auth").publish("worker_accounts_changed"); return receipt;
  },
  auth_state_receipt_get: ({ requestId }) => ({ receipt: cacheJournal.receipt(requestId) }),
  serve_status: () => ({ serverId: fixtureServerId, pid: process.pid, startedAt: new Date().toISOString(), nodeVersion: process.version, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  account_list: () => ({ accounts: [] }),
  account_login_current: () => ({ login: botAttempt }),
  worker_account_list: () => ({ accounts }),
  worker_account_login_current: () => ({ logins: [...attempts.values()].filter((attempt) => attempt.status === "pending") }),
  worker_account_login_status: ({ id }) => attempts.get(id),
  worker_account_login_start: ({ id: accountId, provider }) => {
    let account = accounts.find((account) => account.id === accountId);
    if (!account) { account = { id: id(serial++), provider, enabled: true, ready: false, removing: false, linkedAccounts: [] }; accounts.push(account); }
    const previous = [...attempts.values()].findLast((attempt) => attempt.account === account.id);
    if (previous) previous.status = "failed";
    return newAttempt(account);
  },
  worker_account_set_enabled: ({ id, enabled }) => { const account = accounts.find((item) => item.id === id); account.enabled = enabled; return account; },
  worker_account_remove: ({ id }) => { accounts.splice(accounts.findIndex((account) => account.id === id), 1); for (const [key, attempt] of attempts) if (attempt.account === id) attempts.delete(key); return { id }; },
  worker_account_login_submit: async ({ id }) => {
    submitEntered?.resolve();
    await submitGate?.promise;
    const attempt = attempts.get(id);
    Object.assign(attempt, { needsCode: false, error: null });
    return attempt;
  },
  worker_account_login_cancel: ({ id }) => { const attempt = attempts.get(id); Object.assign(attempt, { status: "failed", needsCode: false, error: "Sign-in cancelled." }); return attempt; },
  bot_list: () => ({ bots: [] }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
  worker_list: () => ({ workers: retainedWorker ? [{ id: id(500), accountId: accounts[0].id, provider: "codex", phase: "needs_recovery", repo: "/fixture/stack", cwd: "/fixture/worker", botId: null, threadId: null,
    model: "fixture", effort: "medium", branch: null, baseCommit: null, sourceDirty: false, roleId: null, roleRevision: null, sessionId: "retained-native", runtimeInstance: null, currentTurnId: null,
    issue: null, createdAt: Date.now() - 10000, updatedAt: Date.now() - 10000, turn: null, pendingPermissions: 0 }] : [] }),
  worker_runtime_list: () => ({ runtimes: runtimeLive ? [{ id: accounts[0].id, provider: "codex", backend: "acp", processModel: "account", pids: [123], state: "running", pid: 123, instance: id(501), error: null }] : [] }),
  usage_snapshot: () => ({ atMs: Date.now(), inventoryAtMs: Date.now(), inventoryError: null, accounts: [] }),
};
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
try {
   const definitions = { serve: ["serve_status"], auth: Object.keys(handlers).filter((name) => /^(account_|worker_account_|auth_state_)/.test(name)),
    bots: ["bot_list", "bot_defaults_get", "voice_status"], worker: ["worker_list", "worker_runtime_list"], usage: ["usage_snapshot"], api: ["docs_snapshot"] };
  websocket = await serveWebSocket({ env, root: await fixtureWorkspace(dir, Object.keys(definitions)), port: 0 });
  const topics = { auth: Object.fromEntries(["accounts_changed", "worker_accounts_changed", "login_changed", "worker_login_changed"].map((name) => [name, "Fixture"])), worker: { workers_changed: "Fixture" } };
  handlers.docs_snapshot = () => ({ packages: Object.keys(definitions).map((name) => ({ name, packageName: `@stack/${name}`, description: "Auth fixture", events: topics[name] ?? {}, eventScope: null, operations: [],
    transports: [transport(websocket.url, definitions[name], Object.keys(topics[name] ?? {}))] })) });
  for (const [name, names] of Object.entries(definitions)) {
    served.set(name, await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
      operations: names.map((name) => ({ name, description: name, input: anyObject, output: z.any(), async call(_, input) { calls.push({ name, input }); return handlers[name](input); } })),
      events: { topics: topics[name] ?? {} } }));
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  const mode = process.env.UI_AUTH_NEXT_MODE === "dev" ? "dev" : "start";
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; });
  next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (Date.now() > deadline || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const desktopViewport = { width: 1440, height: 1200 };
  const context = await browser.newContext({ viewport: desktopViewport, reducedMotion: "reduce", colorScheme: "light" });
  const externalRequests = [], popups = [], navigations = [], errors = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  await authorizeBrowser(page, origin, env);
  context.on("page", (popup) => popups.push(popup.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.authFixture = { copies: [], opens: [] };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.authFixture.copies.push(text); } } });
    window.open = (...args) => { window.authFixture.opens.push(args); return null; };
  });
  // Worker accounts live on the Accounts bench; hidden benches lay out at zero size.
  await page.goto(`${origin}/accounts`);
  // Keep Next's development badge out of evidence; production has no such overlay.
  if (mode === "dev") await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url()); });
  const card = (provider) => page.locator(`[data-node="worker-account:${accounts.find((account) => account.provider === provider).id}"]`);
  const reveal = async (panel) => {
    // Inspect an off-camera card without native scrolling; explicit reveal owns the camera.
    const inspect = panel.getByRole("button", { name: /^Inspect / });
    // The name toggles inspection; a card still inspected from a prior step must stay selected.
    if (await inspect.getAttribute("aria-pressed") !== "true") {
      await inspect.evaluate((element) => element.focus({ preventScroll: true }));
      await page.keyboard.press("Enter");
    }
    await page.getByRole("button", { name: "Show on bench", exact: true }).click();
    const close = page.getByRole("button", { name: "Close inspector", exact: true });
    if (await close.isVisible()) await close.click();
    await page.locator('[data-dock="right"]').waitFor({ state: "hidden" });
    const highlight = panel.locator(":scope > .animate-ui-flash");
    await highlight.waitFor({ state: "attached" });
    await highlight.waitFor({ state: "detached" });
    await page.waitForFunction((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= window.innerWidth + 1;
    }, await panel.elementHandle()).catch(async (error) => {
      throw new Error(`Card reveal did not fit: ${JSON.stringify(await panel.boundingBox())}`, { cause: error });
    });
  };
  const devin = card("devin");
  const devinAccount = accounts.find((account) => account.provider === "devin");
  const input = () => devin.getByRole("textbox", { name: "Code from Devin", exact: true });
  const submit = () => devin.getByRole("button", { name: "Submit code", exact: true });
  await input().waitFor();
  for (const provider of providers) {
    const panel = card(provider);
    await reveal(panel);
    await panel.getByRole("button", { name: "Copy link", exact: true }).click();
    assert.equal(await page.evaluate(() => window.authFixture.copies.at(-1)), authUrls[provider]);
    assert.equal(await panel.locator("code").getAttribute("title"), authUrls[provider], "full URL remains inspectable");
    if (current(provider).userCode) {
      await panel.getByRole("button", { name: "Copy one-time code", exact: true }).click();
      assert.equal(await page.evaluate(() => window.authFixture.copies.at(-1)), current(provider).userCode);
    }
    assert.equal(await panel.getByRole("timer").count(), 1);
    assert.equal(await panel.getByRole("button", { name: "Cancel", exact: true }).isEnabled(), true);
  }
  const botPanel = page.locator('[data-node="login"]');
  await reveal(botPanel);
  await botPanel.getByRole("button", { name: "Copy link", exact: true }).click();
  assert.equal(await page.evaluate(() => window.authFixture.copies.at(-1)), botAttempt.authUrl);
  await botPanel.getByRole("button", { name: "Copy one-time code", exact: true }).click();
  assert.equal(await page.evaluate(() => window.authFixture.copies.at(-1)), botAttempt.userCode);
  await reveal(devin);
  assert.equal(await submit().isDisabled(), true, "empty code cannot be submitted");
  await input().fill("   ");
  assert.equal(await submit().isDisabled(), true, "whitespace cannot be submitted");
  await input().fill("");
  await input().evaluate((element) => element.blur());
  await page.waitForFunction(() => document.querySelectorAll("[data-sonner-toast]").length === 0);
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const provider of providers) {
      await reveal(card(provider));
      await card(provider).screenshot({ path: join(evidence, `${provider}-${theme}.png`), animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const provider of providers) {
      const panel = card(provider);
      await reveal(panel);
      const bounds = await panel.boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391, `${provider} fits narrow viewport`);
      const content = await panel.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      assert.ok(content.scroll <= content.client, `${provider} content does not overflow: ${JSON.stringify(content)}`);
      await panel.screenshot({ path: join(evidence, `${provider}-${theme}-narrow.png`), animations: "disabled" });
    }
  }
  await page.setViewportSize(desktopViewport);
  await input().fill("  returned-devin-code  ");
  await input().focus();
  await page.waitForFunction((accountId) => {
    const timer = document.querySelector(`[data-node="worker-account:${accountId}"] [role="timer"]`);
    return timer && timer.textContent !== "0:00";
  }, devinAccount.id);
  assert.equal(await input().evaluate((element) => element === document.activeElement), true, "timer updates preserve input focus");
  submitGate = Promise.withResolvers();
  submitEntered = Promise.withResolvers();
  await input().press("Enter");
  await submitEntered.promise;
  await devin.getByText("Submitting code…", { exact: true }).waitFor();
  assert.equal(await input().isDisabled(), true);
  assert.equal(await submit().isDisabled(), true);
  assert.deepEqual(calls.filter((call) => call.name === "worker_account_login_submit").at(-1).input, { id: current("devin").id, code: "returned-devin-code" });
  submitGate.reject(new Error("Fixture submission unavailable. Try again."));
  await devin.getByRole("alert").getByText("Fixture submission unavailable. Try again.", { exact: true }).waitFor();
  assert.equal(await input().inputValue(), "  returned-devin-code  ", "request failure preserves draft for retry");
  assert.equal(await submit().isEnabled(), true);
  submitGate = null;
  await submit().click();
  await input().waitFor({ state: "hidden" });
  await devin.getByRole("status").getByText("Waiting for sign-in", { exact: true }).waitFor();
  assert.notEqual(await devin.getByRole("timer").innerText(), "0:00", "submission does not restart timer");
  Object.assign(current("devin"), { needsCode: true, error: "The code was rejected. Paste a new code from Devin." });
  publish();
  await input().waitFor();
  assert.equal(await input().inputValue(), "", "provider retry has an empty code field");
  assert.equal(await input().getAttribute("aria-invalid"), "true");
  await devin.getByRole("alert").getByText(current("devin").error, { exact: true }).waitFor();
  await input().fill("stale-attempt-code");
  current("devin").status = "failed";
  const replacement = newAttempt(devinAccount);
  publish();
  await page.locator(`#worker-signin-code-${replacement.id}`).waitFor();
  assert.equal(await input().inputValue(), "", "new attempt resets draft");
  assert.equal(await input().getAttribute("aria-invalid"), "false");
  await input().fill("cancelled-code");
  await devin.getByRole("button", { name: "Cancel", exact: true }).click();
  await devin.getByText("Sign-in cancelled.", { exact: true }).waitFor();
  await devin.getByRole("button", { name: "Try again", exact: true }).click();
  await input().waitFor();
  assert.equal(await input().inputValue(), "", "Try again resets draft");
  await input().fill("accepted-code");
  await submit().click();
  await input().waitFor({ state: "hidden" });
  Object.assign(current("devin"), { status: "complete", needsCode: false });
  devinAccount.ready = true;
  publish();
  served.get("auth").publish("worker_accounts_changed");
  await devin.getByText("Signed in", { exact: true }).waitFor();
  await devin.getByRole("button", { name: "Dismiss", exact: true }).click();
  await devin.getByText("Signed in", { exact: true }).waitFor({ state: "hidden" });
  // Claude shares the same code-paste operation, with multiple account IDs kept separate.
  const claude = card("claude");
  const firstClaudeId = accounts.find((account) => account.provider === "claude").id;
  await reveal(claude);
  const claudeInput = claude.getByRole("textbox", { name: "Code from Claude", exact: true });
  await claudeInput.fill("first-claude-draft");
  await page.locator('[data-window="accounts"]').getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Claude", exact: true }).click();
  const secondAttempt = current("claude");
  assert.notEqual(secondAttempt.account, firstClaudeId);
  assert.deepEqual(calls.filter((call) => call.name === "worker_account_login_start").at(-1).input, { provider: "claude" });
  const secondClaude = page.locator(`[data-node="worker-account:${secondAttempt.account}"]`);
  await secondClaude.getByRole("button", { name: "Inspect worker account claude-worker-account-2", exact: true }).waitFor();
  await reveal(secondClaude);
  const secondInput = secondClaude.getByRole("textbox", { name: "Code from Claude", exact: true });
  await secondInput.fill("  second-claude-code  ");
  await secondInput.press("Enter");
  await secondInput.waitFor({ state: "hidden" });
  assert.deepEqual(calls.filter((call) => call.name === "worker_account_login_submit").at(-1).input, { id: secondAttempt.id, code: "second-claude-code" });
  assert.equal(await claudeInput.inputValue(), "first-claude-draft", "submitting the second account preserves the first account's draft");
  Object.assign(secondAttempt, { status: "complete", needsCode: false });
  accounts.find((account) => account.id === secondAttempt.account).ready = true;
  publish();
  served.get("auth").publish("worker_accounts_changed");
  await secondClaude.getByText("Signed in", { exact: true }).waitFor();
  await secondClaude.getByRole("button", { name: "Dismiss", exact: true }).click();
  await secondClaude.getByRole("button", { name: "claude-worker-account-2 actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign in again", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("heading", { name: "Sign in again to claude-worker-account-2?", exact: true }).waitFor();
  assert.match(await confirm.innerText(), /Its runtime stops|Stops its runtime/);
  assert.doesNotMatch(await confirm.innerText(), /ACP/);
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await secondClaude.getByRole("button", { name: "claude-worker-account-2 actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
  await secondClaude.getByText("Disabled", { exact: true }).waitFor();
  assert.deepEqual(calls.filter((call) => call.name === "worker_account_set_enabled").at(-1).input, { id: secondAttempt.account, enabled: false });
  await secondClaude.getByRole("button", { name: "Enable", exact: true }).click();
  await secondClaude.getByText("Disabled", { exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(calls.filter((call) => call.name === "worker_account_set_enabled").at(-1).input, { id: secondAttempt.account, enabled: true });
  await secondClaude.getByRole("button", { name: "claude-worker-account-2 actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove…", exact: true }).click();
  assert.match(await confirm.innerText(), /Its runtime stops|Stops its runtime/);
  await confirm.getByRole("button", { name: "Remove account", exact: true }).click();
  await secondClaude.waitFor({ state: "hidden" });
  assert.deepEqual(calls.filter((call) => call.name === "worker_account_remove").at(-1).input, { id: secondAttempt.account });
  assert.equal(await claudeInput.inputValue(), "first-claude-draft", "removing the second account leaves the first sign-in intact");
  assert.deepEqual(await page.evaluate(() => window.authFixture.opens), [], "no browser opening attempted");
  assert.deepEqual(popups, [], "no popup created");
  assert.deepEqual(navigations, [], "auth actions do not navigate");
  const codexAccount = accounts.find((account) => account.provider === "codex");
  const codex = card("codex");
  await codex.getByRole("button", { name: /^Inspect worker account/ }).evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  const inspector = page.getByRole("region", { name: "Inspector" });
  const cache = inspector.locator("details").filter({ hasText: "model cache" });
  await cache.locator("summary").click();
  assert.equal(await cache.getByRole("button", { name: "Prepare model cache clearing" }).isDisabled(), true);
  codexAccount.enabled = false;
  runtimeLive = true; retainedWorker = true; served.get("worker").publish("workers_changed");
  Object.assign(current("codex"), { status: "complete", needsCode: false }); publish();
  served.get("auth").publish("worker_accounts_changed");
  await cache.getByText("Not met: no active account runtime", { exact: true }).waitFor();
  assert.equal(await cache.getByRole("button", { name: "Prepare model cache clearing" }).isDisabled(), true);
  runtimeLive = false; served.get("worker").publish("workers_changed");
  await cache.getByText("Observed: no active account runtime", { exact: true }).waitFor();
  // A retained needs-recovery Worker is not a live process and does not require transcript/session removal.
  await cache.getByRole("button", { name: "Prepare model cache clearing" }).click();
  await cache.getByText("Catalog teardown is still draining").waitFor();
  assert.equal(await cache.getByRole("button", { name: "Clear model cache", exact: true }).isDisabled(), true);
  cacheDraining = false;
  await cache.getByRole("button", { name: "Prepare a new plan" }).click();
  await cache.getByText("Credentials, keychains, native sessions and sibling accounts", { exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: "light" }); await inspector.screenshot({ path: join(evidence, "cache-plan-light.png") });
  await page.emulateMedia({ colorScheme: "dark" }); await inspector.screenshot({ path: join(evidence, "cache-plan-dark.png") });
  await cache.getByRole("button", { name: "Clear model cache", exact: true }).click();
  await cache.getByText("Completed for the declared scope only.").waitFor();
  assert.equal(cacheClears, 1);
  assert.deepEqual(calls.filter((call) => /worker_(?:runtime_stop|close|cancel|start)/.test(call.name)), [], "cache cleanup never drains or launches");
  const cp = handlers.worker_account_cache_plan({ accountId: codexAccount.id });
  const input_ = { planId: cp.id, expectedRevision: cp.revision, requestId: crypto.randomUUID() };
  cacheJournal.begin(input_, cp); cacheJournal.finish(input_.requestId, "unknown", [{ resource: "cache/opencode/models.json", outcome: "unknown", detail: "Interrupted cache clearing" }]);
  await seedRecovery(page, origin, `auth:account_cache:${codexAccount.id}`, input_);
  await page.reload();
  const inspectCodex = codex.getByRole("button", { name: /^Inspect worker account/ });
  if (await inspectCodex.getAttribute("aria-pressed") !== "true") {
    await inspectCodex.evaluate((element) => element.focus({ preventScroll: true })); await page.keyboard.press("Enter");
  }
  await cache.getByText(input_.requestId, { exact: true }).waitFor();
  // The persisted inspector can mount before its socket reconnects. Recovery stays uncertain until the operator
  // explicitly reads the same request's receipt; it must not resend cache clearing.
  await cache.getByText("Met: sign-in idle", { exact: true }).waitFor();
  const readReceipt = cache.getByRole("button", { name: "Read receipt", exact: true });
  if (await readReceipt.isVisible()) await readReceipt.click();
  await cache.getByRole("region", { name: "auth receipt unknown" }).waitFor();
  assert.equal(await cache.getByRole("button", { name: "Send identical request" }).count(), 0);
  assert.equal(cacheClears, 1);
  await page.setViewportSize({ width: 390, height: 844 }); await inspector.screenshot({ path: join(evidence, "cache-unknown-narrow.png") });
  assert.deepEqual(externalRequests, [], "no external HTTP or navigation requests");
  assert.deepEqual(errors, [], "no uncaught application errors");
  console.log(JSON.stringify({ ok: true, mode, evidence, assertions: "exact Worker/Bot URL and code copies; no opens/popups/navigation/external requests; empty/busy/error/retry/approval/cancel/restart/complete states; independent Claude create/submit/re-sign-in/disable/enable/remove; attempt draft reset; timer and focus; light/dark/narrow" }, null, 2));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true, animations: "disabled" }).catch(() => undefined);
  console.error(log);
  throw error;
} finally {
  submitGate?.resolve();
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all([...served.values()].map((socket) => socket.close()));
  cacheJournal.close();
  if (process.env.AUTH_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
