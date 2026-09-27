// Optional rendered check of the Roles space after pnpm test and a uix build. The real Roles API runs
// against a disposable state directory; Bots are a fixture. No live owner or provider calls.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/roles-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@agentstack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as rolesApi } from "../../roles/dist/api.js";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const uix = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(uix));
// Unix socket paths are short; keep the state directory near the root of the temporary tree.
const dir = await mkdtemp(join("/tmp", "as-roles-ui-"));
const evidence = process.env.ROLES_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const passthrough = { parse: (value) => value };
const bot = (id, roleRevision) => ({ id, state: "running", pid: 321, cwd: "/fixture", url: null, account: null, runningAccount: null, mainThreadId: null,
  recoveryIssue: null, roleRevision, settings: null });
const handlers = {
  owner_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uixUrl: null, inspectorUrl: null }),
  bot_list: () => ({ bots: [bot("bot-1", 0), bot("bot-2", 5)] }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
};
const fixture = (names) => names.map((name) => ({ name, description: name, input: passthrough, output: passthrough, async call() { return handlers[name](); } }));
async function port() { const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value; }
const sockets = [];
let websocket, next, browser, roles;
let log = "";
const rolesCall = (name, args = {}) => socketCall(socketPath("roles", env), "tools/call", { name, arguments: args });

try {
  roles = await serveApi({ name: "roles", transport: "socket", env, root });
  websocket = await serveWebSocket({ env, root, port: 0 });
  const doc = (name, api) => ({ name, packageName: `@agentstack/${name}`, description: `${name} fixture`, events: api?.events?.topics ?? {}, eventScope: null,
    transports: [{ type: "websocket", description: "Isolated fixture", supported: true, subscriptions: true, endpoint: websocket.url }],
    operations: (api?.operations ?? []).map((operation) => ({ name: operation.name, title: operation.annotations?.title ?? null, description: operation.description,
      annotations: operation.annotations ?? {}, inputSchema: publishedJsonSchema(operation.input), outputSchema: publishedJsonSchema(operation.output) })) });
  const catalog = [doc("roles", rolesApi), doc("bots", botsApi), doc("owner"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names, topics] of [["owner", ["owner_status"], { pids_changed: "Fixture" }], ["bots", ["bot_list", "bot_defaults_get", "voice_status"], botsApi.events.topics], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixture(names),
      events: { topics, scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
  }
  const nextPort = await port();
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: uix, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 100 || next.exitCode !== null) throw new Error(log);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/x/roles`);
  const instructions = page.locator('[data-window="role-instructions"]');
  const editor = page.locator('[data-window="role-editor"]');
  const preview = page.locator('[data-window="role-preview"]');
  await instructions.getByText("No instructions", { exact: true }).waitFor();
  await editor.getByText("Nothing to edit yet", { exact: true }).waitFor();
  await preview.getByText("Nothing renders", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Spaces · Roles" }).waitFor();
  await page.screenshot({ path: join(evidence, "roles-empty.png"), animations: "disabled" });

  // A new category is a draft in the editor until it is created; its title starts focused.
  await instructions.getByRole("button", { name: "New category", exact: true }).click();
  await editor.getByRole("form", { name: "New category" }).waitFor();
  assert.equal(await editor.getByLabel("Title", { exact: true }).evaluate((el) => el === document.activeElement), true);
  assert.equal(await editor.getByRole("button", { name: "Create category" }).isDisabled(), true, "a title is required");
  await editor.getByLabel("Title", { exact: true }).fill("Working style");
  await editor.getByLabel("Description", { exact: true }).fill("How Bots approach their work");
  await editor.getByLabel("Title", { exact: true }).press("Meta+s");
  await editor.getByRole("form", { name: "Edit Working style" }).waitFor();
  const working = instructions.getByRole("listitem", { name: "Category Working style" });
  await working.waitFor();

  const addFragment = async (card, title, body, description = "") => {
    await card.getByRole("button", { name: "Add fragment", exact: true }).click();
    const form = editor.getByRole("form", { name: "New fragment" });
    await form.waitFor();
    await form.getByLabel("Title", { exact: true }).fill(title);
    if (description) await form.getByLabel("Description", { exact: true }).fill(description);
    await form.getByLabel("Instructions", { exact: true }).fill(body);
    await editor.getByRole("button", { name: "Create fragment" }).click();
    await editor.getByRole("form", { name: `Edit ${title}` }).waitFor();
  };
  await addFragment(working, "Plan first", "Write a short plan before acting.", "Keeps plans short");
  await addFragment(working, "Verify", "Verify before reporting.");
  await instructions.getByRole("button", { name: "New category", exact: true }).click();
  await editor.getByLabel("Title", { exact: true }).fill("Tone");
  await editor.getByRole("button", { name: "Create category" }).click();
  const tone = instructions.getByRole("listitem", { name: "Category Tone" });
  await tone.waitFor();
  await addFragment(tone, "Plain words", "Use plain words.");
  const rendered = async () => (await rolesCall("role_preview")).rendered;
  assert.equal(await rendered(), "Write a short plan before acting.\n\nVerify before reporting.\n\nUse plain words.");
  await preview.getByText("Use plain words.", { exact: true }).waitFor();
  assert.deepEqual(await preview.getByRole("list", { name: "Rendered instructions by fragment" }).getByRole("button").allTextContents(), ["Plan first", "Verify", "Plain words"]);
  // Five writes in, bot-2 launched with this Role and bot-1 with the empty one.
  await preview.getByText("Older role", { exact: true }).waitFor();
  await preview.getByText("Current", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "roles-filled.png"), animations: "disabled" });

  // Switches apply at once and the preview follows.
  await instructions.getByRole("switch", { name: "Verify enabled" }).click();
  await page.waitForFunction(() => !document.querySelector('[data-window="role-preview"]')?.textContent?.includes("Verify before reporting."));
  assert.equal(await rendered(), "Write a short plan before acting.\n\nUse plain words.");
  const row = (title) => instructions.locator('li[data-node^="fragment:"]').filter({ hasText: title });
  const open = (title) => row(title).getByRole("button", { name: new RegExp(`^${title}(?! actions)`) });
  await row("Verify").getByText("Off", { exact: true }).waitFor();

  // Drag a fragment across categories, above "Plan first".
  await row("Plain words").dragTo(row("Plan first"), { targetPosition: { x: 40, y: 4 } });
  let snapshot = await rolesCall("role_snapshot");
  for (let attempt = 0; snapshot.categories[0].fragments[0]?.title !== "Plain words" && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = await rolesCall("role_snapshot");
  }
  assert.deepEqual(snapshot.categories.map((category) => category.fragments.map((fragment) => fragment.title)), [["Plain words", "Plan first", "Verify"], []]);

  // Alt+ArrowDown moves the focused fragment down one place.
  await open("Plain words").focus();
  await page.keyboard.press("Alt+ArrowDown");
  for (let attempt = 0; snapshot.categories[0].fragments[0].title !== "Plan first" && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = await rolesCall("role_snapshot");
  }
  assert.deepEqual(snapshot.categories[0].fragments.map((fragment) => fragment.title), ["Plan first", "Plain words", "Verify"]);

  // An unsaved edit marks its row; a save elsewhere to the same text is a conflict the person resolves.
  await open("Plan first").click();
  const planForm = editor.getByRole("form", { name: "Edit Plan first" });
  await planForm.getByLabel("Instructions", { exact: true }).fill("Write a short, numbered plan before acting.");
  await row("Plan first").getByRole("img", { name: "Unsaved changes" }).waitFor();
  await editor.getByText("Unsaved changes · ⌘S to save", { exact: true }).waitFor();
  const planId = snapshot.categories[0].fragments[0].id;
  await rolesCall("fragment_update", { expectedRevision: snapshot.revision, id: planId, body: "Plan elsewhere." });
  await editor.getByText("Changed elsewhere", { exact: true }).waitFor();
  assert.equal(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(evidence, "roles-conflict.png"), animations: "disabled" });
  await editor.getByRole("button", { name: "Keep mine", exact: true }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  snapshot = await rolesCall("role_snapshot");
  assert.equal(snapshot.categories[0].fragments[0].body, "Write a short, numbered plan before acting.");
  // A save made while an unrelated write landed is rebuilt once and still applies.
  await planForm.getByLabel("Title", { exact: true }).fill("Plan before acting");
  await rolesCall("category_update", { expectedRevision: snapshot.revision, id: snapshot.categories[1].id, description: "Voice" });
  await planForm.getByLabel("Title", { exact: true }).press("Meta+s");
  await editor.getByRole("form", { name: "Edit Plan before acting" }).waitFor();
  await editor.getByText("All changes saved", { exact: true }).waitFor();

  // Search filters by title, description or text.
  await instructions.getByLabel("Search instructions").fill("plain");
  await instructions.getByText("1 matching fragment", { exact: true }).waitFor();
  assert.equal(await instructions.locator('li[data-node^="fragment:"]').count(), 1);
  await instructions.getByRole("button", { name: "Clear search" }).click();
  assert.equal(await instructions.locator('li[data-node^="fragment:"]').count(), 3);

  // A disabled category keeps its fragments out of launches.
  await instructions.getByRole("switch", { name: "Working style enabled" }).click();
  await instructions.getByText("Off · none of these reach new Bots", { exact: true }).waitFor();
  await preview.getByText("Nothing renders", { exact: true }).waitFor();
  await instructions.getByRole("switch", { name: "Working style enabled" }).click();
  await preview.getByText("Use plain words.", { exact: true }).waitFor();

  // Inspection hands back to the editor; the palette finds fragments.
  await instructions.getByRole("button", { name: "Verify actions" }).click();
  await page.getByRole("menuitem", { name: "Inspect record" }).click();
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByText("Instruction fragment", { exact: true }).waitFor();
  await inspector.getByRole("button", { name: "Edit in Roles" }).click();
  await editor.getByRole("form", { name: "Edit Verify" }).waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill("role fragment plain");
  await page.getByRole("option", { name: /Plain words/ }).first().click();
  await editor.getByRole("form", { name: "Edit Plain words" }).waitFor();

  // Deleting asks first; a category with fragments cannot be deleted.
  await instructions.getByRole("button", { name: "Working style actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText("Category isn’t empty", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close" }).click();
  await instructions.getByRole("button", { name: "Verify actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  snapshot = await rolesCall("role_snapshot");
  assert.deepEqual(snapshot.categories.flatMap((category) => category.fragments.map((fragment) => fragment.title)), ["Plan before acting", "Plain words"]);
  await open("Plain words").click();
  await page.screenshot({ path: join(evidence, "roles-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(evidence, "roles-dark.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, "roles-mobile.png"), animations: "disabled" });
  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "empty states, category and fragment creation, preview order and segments, launch revisions, switches, cross-category drag, keyboard move, drafts, conflict keep-mine, stale-revision rebuild, search, category off, inspector hand-off, palette, delete guard and delete, light/dark/mobile" }, null, 2));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all(sockets.map((socket) => socket.close()));
  await roles?.close();
  if (!process.env.ROLES_EVIDENCE_DIR) await rm(dir, { recursive: true, force: true });
}
