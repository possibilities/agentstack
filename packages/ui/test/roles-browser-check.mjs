// Optional rendered check of the Roles space after pnpm test and a ui build. The real Roles API runs
// against a disposable state directory; Bots and Workers are fixtures. No live server or provider calls.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/roles-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as rolesApi } from "../../roles/dist/api.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
// Unix socket paths are short; keep the state directory near the root of the temporary tree.
const dir = await mkdtemp(join("/tmp", "as-roles-ui-"));
const evidence = process.env.ROLES_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
// Nothing of the live Stack environment reaches the fixture: only the disposable state directory is named.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
// bot-1 runs inside a real project directory so trusted-project matching has something to find.
const project = join(dir, "project");
await mkdir(join(project, "src"), { recursive: true });
const bot = (id, roleId, roleRevision, cwd = "/fixture") => ({ id, state: "running", pid: 321, cwd, url: null, account: null, runningAccount: null, mainThreadId: null,
  recoveryIssue: null, roleId, roleRevision, settings: null });
const worker = (phase, roleId, roleRevision) => ({ id: `w-${Math.random().toString(16).slice(2)}`, botId: "bot-1", threadId: "t", accountId: "a", provider: "codex", model: "m", effort: null,
  repo: "/src/stack", cwd: null, branch: null, baseCommit: null, sourceDirty: false, roleId, roleRevision, sessionId: null, runtimeInstance: null, phase,
  currentTurnId: null, issue: null, createdAt: 1, updatedAt: 1, turn: null, pendingPermissions: 0 });
let botList = [bot("bot-1", null, null, join(project, "src")), bot("bot-2", null, null)];
let workerList = [];
const handlers = {
  serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  bot_list: () => ({ bots: botList }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
  // The gateway admits serve only with every operation its manifest selects; this check reads none of them.
  serve_resources: () => { throw new Error("not part of this fixture"); },
  serve_resource_history: () => { throw new Error("not part of this fixture"); },
  worker_list: () => ({ workers: workerList }),
  worker_runtime_list: () => ({ runtimes: [] }),
};
const fixture = (names) => fixtureOperations(names, handlers);
/** Lets the page miss change notices, or lag one write, so stale-revision paths are exercised deterministically. */
const wrapSockets = () => {
  const Native = window.WebSocket;
  window.__wsDrop = false;
  window.__wsDelay = 0;
  window.WebSocket = class extends Native {
    set onmessage(handler) { super.onmessage = handler ? (event) => { if (window.__wsDrop && String(event.data).includes('"events/changed"')) return; handler.call(this, event); } : handler; }
    get onmessage() { return super.onmessage; }
    send(data) { if (window.__wsDelay && typeof data === "string" && data.includes('"fragment_update"')) setTimeout(() => super.send(data), window.__wsDelay); else super.send(data); }
  };
};
const sockets = [];
let websocket, next, browser, rolesServer;
let log = "";
const rolesCall = (name, args = {}) => socketCall(socketPath("roles", env), "tools/call", { name, arguments: args });
let botsSocket, workerSocket;
let failed = false;
let A, B, W;
const snap = (roleId) => rolesCall("role_snapshot", { roleId });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Poll a disposable API until `done` holds; the UI's own writes land asynchronously. */
async function until(read, done, label) {
  let value = await read();
  for (let attempt = 0; !done(value) && attempt < 100; attempt++) { await wait(50); value = await read(); }
  assert.ok(done(value), `timed out waiting for ${label}`);
  return value;
}

try {
  rolesServer = await serveApi({ name: "roles", transport: "socket", env, root });
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["roles", "serve", "bots", "worker", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("roles", rolesApi), doc("bots", botsApi), doc("serve"), doc("worker"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  for (const [name, names, topics] of [["serve", ["serve_status", "serve_resources", "serve_resource_history"], { pids_changed: "Fixture" }], ["bots", ["bot_list", "bot_defaults_get", "voice_status"], botsApi.events.topics],
    ["worker", ["worker_list", "worker_runtime_list"], { workers_changed: "Fixture" }], ["api", ["docs_snapshot"], {}]]) {
    const served = await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixture(names),
      events: { topics, scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } });
    sockets.push(served);
    if (name === "bots") botsSocket = served;
    if (name === "worker") workerSocket = served;
  }
  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), process.env.NEXT_MODE === "dev" ? "dev" : "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1800 || next.exitCode !== null) throw new Error(log);
    await wait(50);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 }, reducedMotion: "reduce" });
  await page.addInitScript(wrapSockets);
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = (name) => page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  const drop = (on) => page.evaluate((value) => { window.__wsDrop = value; }, on);
  await page.goto(`${origin}/roles`);
  const catalogWindow = page.locator('[data-window="role-catalog"]');
  const instructions = page.locator('[data-window="role-instructions"]');
  const editor = page.locator('[data-window="role-editor"]');
  const preview = page.locator('[data-window="role-preview"]');
  const skills = page.locator('[data-window="role-skills"]');
  const servers = page.locator('[data-window="role-mcp-servers"]');
  const projects = page.locator('[data-window="role-projects"]');
  const inspector = page.getByRole("region", { name: "Inspector" });
  const dialog = page.getByRole("alertdialog");
  const roleRow = (name) => catalogWindow.locator('li[data-node^="role:"]').filter({ has: page.getByText(name, { exact: true }) });
  // Editing pans the bench toward the Editor; a click on the Roles window fits the bench first when it has scrolled away.
  const tap = (locator) => locator.click({ timeout: 2_000 }).catch(async () => { await page.getByRole("button", { name: /Fit bench/ }).click(); await locator.click(); });
  const selectRole = (name) => tap(roleRow(name).getByRole("button").first());
  const toast = (text) => page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
  const stackSwitch = (name) => servers.getByRole("switch", { name: `${name} on`, exact: true });

  // A fresh installation provisions Manager as the Bot default and Worker as the Worker default; the page edits the Bot default first.
  const provisioned = await rolesCall("roles_snapshot");
  assert.deepEqual(provisioned.roles.map((role) => [role.name, role.id === provisioned.defaultRoleId, role.id === provisioned.workerDefaultRoleId]),
    [["Manager", true, false], ["Worker", false, true]]);
  W = provisioned.workerDefaultRoleId;
  await roleRow("Manager").getByText("Bot default", { exact: true }).waitFor();
  await roleRow("Worker").getByText("Worker default", { exact: true }).waitFor();
  assert.equal(await roleRow("Manager").getByText("Worker default", { exact: true }).count(), 0, "one default never implies the other");
  await roleRow("Manager").getByText("Editing", { exact: true }).waitFor();
  await catalogWindow.getByText("Bots · Manager · Workers · Worker", { exact: true }).waitFor();
  await catalogWindow.getByText("New Bots use the Bot default “Manager”. A Worker uses the Role it selects, or the Worker default “Worker” when it selects none. Each Make default changes only its own audience.", { exact: false }).waitFor();
  await instructions.getByText("Manager · Bot default · revision 0", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Spaces · Roles" }).waitFor();
  await shot("roles-provisioned");

  // The Bot default offers Make Worker default, and only that; the Worker default offers only Make Bot default.
  await editor.getByText("New Bots use this Role. Workers use it only when they select it; the rest use “Worker”. Edits reach later launches only; running sessions keep their snapshot.", { exact: true }).waitFor();
  assert.equal(await editor.getByRole("button", { name: "Make Bot default" }).count(), 0, "the Bot default is not offered to itself");
  await selectRole("Worker");
  const workerNote = "New Bots use “Manager”, not this Role. It is the Worker default: Workers started without a selected Role use it. Edits reach later launches only; running sessions keep their snapshot.";
  await editor.getByText(workerNote, { exact: true }).waitFor();
  await instructions.getByText("Worker · Worker default · revision 0", { exact: true }).waitFor();
  await instructions.getByText("No instructions", { exact: true }).waitFor();
  await editor.getByRole("button", { name: "Make Bot default" }).waitFor();
  assert.equal(await editor.getByRole("button", { name: "Make Worker default" }).count(), 0, "the Worker default is not offered to itself");
  await tap(roleRow("Worker").getByRole("button", { name: "Worker actions" }));
  assert.notEqual(await page.getByRole("menuitem", { name: /Delete…/ }).getAttribute("data-disabled"), null, "the Worker default's Delete is disabled");
  await page.getByText("Make another Role the Worker default first", { exact: true }).waitFor();
  assert.notEqual(await page.getByRole("menuitem", { name: "Worker default", exact: true }).getAttribute("data-disabled"), null);
  await page.keyboard.press("Escape");
  await rolesCall("role_delete", { roleId: W, expectedRevision: (await rolesCall("roles_snapshot")).revision })
    .then(() => assert.fail("the API accepted deleting the Worker default"), (error) => assert.match(error.message, /cannot delete the Worker default role/));

  // Make Worker default moves only the Worker default: Manager becomes both, and Worker is then an ordinary, deletable Role.
  await selectRole("Manager");
  await editor.getByRole("button", { name: "Make Worker default" }).click();
  await dialog.getByText("Make “Manager” the Worker default?", { exact: true }).waitFor();
  await dialog.getByText("Later Workers started without a selected Role use this Role instead of “Worker”. Workers that select a Role are unaffected, and Bots still use “Manager”. Running Workers keep the snapshot they started with.").waitFor();
  await shot("roles-worker-default-dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal((await rolesCall("roles_snapshot")).workerDefaultRoleId, W, "cancelling changes nothing");
  await editor.getByRole("button", { name: "Make Worker default" }).click();
  await dialog.getByRole("button", { name: "Make default", exact: true }).click();
  await toast("“Manager” is now the Worker default").waitFor();
  const moved = await rolesCall("roles_snapshot");
  assert.deepEqual([moved.defaultRoleId, moved.workerDefaultRoleId], [provisioned.defaultRoleId, provisioned.defaultRoleId], "the Bot default is untouched");
  assert.deepEqual(moved.roles.map((role) => role.revision), provisioned.roles.map((role) => role.revision), "a default switch advances the catalog, not a Role");
  await roleRow("Manager").getByText("Worker default", { exact: true }).waitFor();
  assert.equal(await roleRow("Worker").getByText("Worker default", { exact: true }).count(), 0);
  await catalogWindow.getByText("Bots · Manager · Workers · Manager", { exact: true }).waitFor();
  await instructions.getByText("Manager · Bot and Worker default · revision 0", { exact: true }).waitFor();
  assert.equal(await editor.getByRole("button", { name: /^Make (Bot|Worker) default$/ }).count(), 0, "a Role that is both defaults carries no note");
  await tap(roleRow("Worker").getByRole("button", { name: "Worker actions" }));
  assert.equal(await page.getByRole("menuitem", { name: /Delete…/ }).getAttribute("data-disabled"), null, "a former default can be deleted");
  // Restore it from the row menu.
  await page.getByRole("menuitem", { name: "Make Worker default…" }).click();
  await dialog.getByText("Make “Worker” the Worker default?", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Make default", exact: true }).click();
  await toast("“Worker” is now the Worker default").waitFor();
  assert.equal((await rolesCall("roles_snapshot")).workerDefaultRoleId, W);
  await roleRow("Worker").getByText("Worker default", { exact: true }).waitFor();

  // New role opens a draft in the Editor; the new Role is selected and is neither default.
  await tap(catalogWindow.getByRole("button", { name: "New role", exact: true }));
  const newRole = editor.getByRole("form", { name: "New role" });
  await newRole.waitFor();
  assert.equal(await newRole.getByLabel("Name", { exact: true }).evaluate((el) => el === document.activeElement), true);
  assert.equal(await editor.getByRole("button", { name: "Create role" }).isDisabled(), true, "a name is required");
  await newRole.getByText("A new Role starts empty and is not a launch default. Existing sessions keep their Role.").waitFor();
  await newRole.getByLabel("Name", { exact: true }).fill("Researcher");
  await newRole.getByLabel(/^Description/).fill("Reads sources and reports what they say");
  await newRole.getByLabel("Name", { exact: true }).press("Meta+s");
  const researcher = roleRow("Researcher");
  await researcher.getByText("Editing", { exact: true }).waitFor();
  const first = await rolesCall("roles_snapshot");
  A = first.roles.find((role) => role.name === "Researcher").id;
  assert.deepEqual([first.defaultRoleId, first.workerDefaultRoleId], [provisioned.defaultRoleId, W], "creating a Role changes neither default");
  await editor.getByText("New Bots use “Manager”, not this Role. Workers use it only when they select it; the rest use “Worker”. Edits reach later launches only; running sessions keep their snapshot.", { exact: true }).waitFor();
  // Make it the Bot default through the page; the rest of this check edits the Bot default. The Worker default stays.
  await editor.getByRole("button", { name: "Make Worker default" }).waitFor();
  await editor.getByRole("button", { name: "Make Bot default" }).click();
  await dialog.getByText("Make “Researcher” the Bot default?", { exact: true }).waitFor();
  await dialog.getByText("Later Bot launches use this Role instead of “Manager”. Workers started without a Role still use “Worker”. Running Bots keep what they launched with until restarted; nothing restarts automatically.").waitFor();
  await dialog.getByRole("button", { name: "Make default", exact: true }).click();
  await toast("“Researcher” is now the Bot default").waitFor();
  assert.deepEqual(await rolesCall("roles_snapshot").then((value) => [value.defaultRoleId, value.workerDefaultRoleId]), [A, W]);
  await researcher.getByText("Bot default", { exact: true }).waitFor();
  await roleRow("Worker").getByText("Worker default", { exact: true }).waitFor();
  await instructions.getByText("Researcher · Bot default · revision 0", { exact: true }).waitFor();
  await editor.getByText("Nothing to edit yet", { exact: true }).waitFor();
  await instructions.getByText("No instructions", { exact: true }).waitFor();
  assert.equal(await editor.getByText(/not this Role\./).count(), 0, "the Bot default carries no not-default note");

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
  const rendered = async () => (await rolesCall("role_preview", { roleId: A })).rendered;
  assert.equal(await rendered(), "Write a short plan before acting.\n\nVerify before reporting.\n\nUse plain words.");
  await preview.getByText("Use plain words.", { exact: true }).waitFor();
  assert.deepEqual(await preview.getByRole("list", { name: "Rendered instructions by fragment" }).getByRole("button").allTextContents(), ["Plan first", "Verify", "Plain words"]);
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
  let snapshot = await snap(A);
  for (let attempt = 0; snapshot.categories[0].fragments[0]?.title !== "Plain words" && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = await snap(A);
  }
  assert.deepEqual(snapshot.categories.map((category) => category.fragments.map((fragment) => fragment.title)), [["Plain words", "Plan first", "Verify"], []]);

  // Alt+ArrowDown moves the focused fragment down one place.
  await open("Plain words").focus();
  await page.keyboard.press("Alt+ArrowDown");
  for (let attempt = 0; snapshot.categories[0].fragments[0].title !== "Plan first" && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = await snap(A);
  }
  assert.deepEqual(snapshot.categories[0].fragments.map((fragment) => fragment.title), ["Plan first", "Plain words", "Verify"]);

  // An unsaved edit marks its row; a save elsewhere to the same text is a conflict the person resolves.
  await open("Plan first").click();
  const planForm = editor.getByRole("form", { name: "Edit Plan first" });
  await planForm.getByLabel("Instructions", { exact: true }).fill("Write a short, numbered plan before acting.");
  await row("Plan first").getByRole("img", { name: "Unsaved changes" }).waitFor();
  await editor.getByText("Unsaved changes · ⌘S to save", { exact: true }).waitFor();
  const planId = snapshot.categories[0].fragments[0].id;
  await rolesCall("fragment_update", { roleId: A, expectedRevision: snapshot.revision, id: planId, body: "Plan elsewhere." });
  await editor.getByText("Changed elsewhere", { exact: true }).waitFor();
  assert.equal(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(evidence, "roles-conflict.png"), animations: "disabled" });
  await editor.getByRole("button", { name: "Keep mine", exact: true }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  snapshot = await snap(A);
  assert.equal(snapshot.categories[0].fragments[0].body, "Write a short, numbered plan before acting.");
  // A save made while an unrelated write landed is rebuilt once and still applies.
  await planForm.getByLabel("Title", { exact: true }).fill("Plan before acting");
  await rolesCall("category_update", { roleId: A, expectedRevision: snapshot.revision, id: snapshot.categories[1].id, description: "Voice" });
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
  await instructions.getByText("Off · none of these reach new launches", { exact: true }).waitFor();
  await preview.getByText("Nothing renders", { exact: true }).waitFor();
  await instructions.getByRole("switch", { name: "Working style enabled" }).click();
  await preview.getByText("Use plain words.", { exact: true }).waitFor();

  // Conditions are fragment metadata: they save with the draft, survive unrelated edits, and a fragment that
  // lacks its context is never called Off. The shared preview context changes only what the previews show.
  await open("Plain words").click();
  const plainForm = editor.getByRole("form", { name: "Edit Plain words" });
  await plainForm.getByLabel("Model equals", { exact: true }).fill("foo");
  await plainForm.getByLabel("Harness equals", { exact: true }).fill("codex");
  await plainForm.getByRole("status").filter({ hasText: "Preview context (none): skipped: the context lacks a value these conditions need" }).waitFor();
  await plainForm.getByLabel("Model equals", { exact: true }).press("Meta+s");
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  const plainId = () => snap(A).then((current) => current.categories.flatMap((category) => category.fragments).find((fragment) => fragment.title === "Plain words"));
  assert.deepEqual((await plainId()).conditions, { model: "foo", harness: "codex" });
  await row("Plain words").getByText("model = foo · harness = codex", { exact: true }).waitFor();
  await row("Plain words").getByText("Needs context", { exact: true }).waitFor();
  assert.equal(await row("Plain words").getByText("Off", { exact: true }).count(), 0, "an enabled, unmatched fragment is not called Off");
  await instructions.getByRole("status").filter({ hasText: "1 of 3 fragments render without context" }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-window="role-preview"]')?.textContent?.includes("Use plain words."));
  // An unrelated body edit writes only the body; the API keeps the conditions.
  await plainForm.getByLabel("Instructions", { exact: true }).fill("Use plain, short words.");
  await plainForm.getByLabel("Instructions", { exact: true }).press("Meta+s");
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  assert.deepEqual(await until(plainId, (fragment) => fragment.body === "Use plain, short words.", "the body save").then((fragment) => fragment.conditions), { model: "foo", harness: "codex" });
  // The preview context: a missing value, then a case mismatch, then an exact match.
  await preview.getByLabel("Model", { exact: true }).fill("foo");
  await preview.getByLabel("Harness", { exact: true }).fill("Codex");
  await row("Plain words").getByText("No match", { exact: true }).waitFor();
  await preview.getByLabel("Harness", { exact: true }).fill("codex");
  await preview.getByText("Use plain, short words.", { exact: true }).waitFor();
  await instructions.getByRole("status").filter({ hasText: "2 of 3 fragments render with model = foo · harness = codex" }).waitFor();
  await preview.getByText("stack roles inject Researcher --with-model foo --with-harness codex -- <cli> …", { exact: true }).waitFor();
  await editor.getByRole("status").filter({ hasText: "Preview context (model = foo · harness = codex): renders here" }).waitFor();
  const previewRevision = (await snap(A)).revision;
  await shot("roles-conditions");
  // Another window changes the conditions: the row follows and the preview rereads with the same context.
  await rolesCall("fragment_update", { roleId: A, expectedRevision: previewRevision, id: (await plainId()).id, conditions: { model: "bar" } });
  await row("Plain words").getByText("No match", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-window="role-preview"]')?.textContent?.includes("Use plain, short words."));
  assert.equal((await snap(A)).revision, previewRevision + 1, "changing the preview context never wrote to the Role");
  // Clearing removes every condition with {}.
  await plainForm.getByRole("button", { name: "Clear all" }).click();
  await plainForm.getByLabel("Model equals", { exact: true }).press("Meta+s");
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  assert.deepEqual(await until(plainId, (fragment) => !Object.keys(fragment.conditions).length, "cleared conditions").then((fragment) => fragment.conditions), {});
  await preview.getByText("Use plain, short words.", { exact: true }).waitFor();
  await preview.getByRole("button", { name: "Clear", exact: true }).click();
  await instructions.getByRole("status").filter({ hasText: "2 of 3 fragments render" }).waitFor();

  // Inspection hands back to the editor; the palette finds fragments.
  await instructions.getByRole("button", { name: "Verify actions" }).click();
  await page.getByRole("menuitem", { name: "Inspect record" }).click();
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
  await dialog.getByText("Category isn’t empty", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close" }).click();
  await instructions.getByRole("button", { name: "Verify actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  snapshot = await snap(A);
  assert.deepEqual(snapshot.categories.flatMap((category) => category.fragments.map((fragment) => fragment.title)), ["Plan before acting", "Plain words"]);

  // Skills, MCP servers and trusted projects: list windows, the shared editor and the launch preview.
  await skills.getByText("No skills", { exact: true }).waitFor();
  await skills.getByRole("button", { name: "New skill", exact: true }).click();
  const newSkill = editor.getByRole("form", { name: "New skill" });
  await newSkill.waitFor();
  assert.equal(await newSkill.getByLabel("Name", { exact: true }).evaluate((el) => el === document.activeElement), true);
  await newSkill.getByLabel("Name", { exact: true }).fill("Review Changes");
  assert.equal(await newSkill.getByLabel("Name", { exact: true }).inputValue(), "review-changes", "names are typed as launch names");
  assert.equal(await editor.getByRole("button", { name: "Create skill" }).isDisabled(), true, "a description is required");
  await newSkill.getByLabel(/^Description/).fill("Review a change before reporting it");
  await newSkill.getByLabel("SKILL.md body", { exact: true }).fill("# Review\n\nRun scripts/check.sh.");
  await newSkill.getByRole("button", { name: "New text file" }).click();
  await newSkill.getByLabel("Contents of notes.md").fill("exit 0\n");
  await newSkill.getByLabel("Path of notes.md").fill("scripts/check.sh");
  await newSkill.locator('input[type="file"]').setInputFiles({ name: "logo image.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]) });
  await newSkill.getByText("binary · 6 B").waitFor();
  await editor.getByRole("button", { name: "Create skill" }).click();
  await editor.getByRole("form", { name: "Edit skill review-changes" }).waitFor();
  snapshot = await snap(A);
  assert.deepEqual(snapshot.skills.map((skill) => [skill.name, skill.files.map((file) => file.path)]), [["review-changes", ["scripts/check.sh", "logo-image.png"]]]);
  assert.equal(Buffer.from(snapshot.skills[0].files[0].contentBase64, "base64").toString(), "exit 0\n");
  // The preview follows the editor to the launch view.
  await preview.getByRole("button", { name: /^review-changes/ }).waitFor();
  await skills.getByRole("button", { name: "review-changes actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await editor.getByRole("form", { name: "Edit skill review-changes-copy" }).waitFor();
  await skills.locator('li[data-node^="skill:"]').filter({ hasText: "review-changes-copy" }).getByRole("button", { name: /^review-changes-copy(?! actions)/ }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  for (let attempt = 0; snapshot.skills[0]?.name !== "review-changes-copy" && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = await snap(A);
  }
  assert.deepEqual(snapshot.skills.map((skill) => skill.name), ["review-changes-copy", "review-changes"]);
  await skills.getByRole("switch", { name: "review-changes-copy enabled" }).click();
  await skills.locator('li[data-node^="skill:"]').filter({ hasText: "review-changes-copy" }).getByText("Off", { exact: true }).waitFor();

  // An MCP server cannot take an internal Package API's name; its TOML is shown before saving.
  await servers.getByRole("button", { name: "New MCP server", exact: true }).click();
  const newServer = editor.getByRole("form", { name: "New MCP server" });
  await newServer.getByLabel("Name", { exact: true }).fill("roles");
  await newServer.getByText("A Stack server already uses this name, even while it is switched off").first().waitFor();
  await newServer.getByLabel("Name", { exact: true }).fill("docs");
  await newServer.getByLabel("URL", { exact: true }).fill("https://mcp.example.test/docs");
  await newServer.getByLabel("Bearer token variable · optional").fill("DOCS_TOKEN");
  await newServer.getByText('bearer_token_env_var = "DOCS_TOKEN"').waitFor();
  await editor.getByRole("button", { name: "Create server" }).click();
  const serverForm = editor.getByRole("form", { name: "Edit MCP server docs" });
  await serverForm.waitFor();
  await serverForm.getByRole("button", { name: "stdio" }).click();
  await serverForm.getByLabel("Command line to split").fill(`node "docs server.js" --port 7`);
  await serverForm.getByRole("button", { name: "Split" }).click();
  assert.equal(await serverForm.getByLabel("Command", { exact: true }).inputValue(), "node");
  await serverForm.getByLabel("Name", { exact: true }).press("Meta+s");
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  snapshot = await snap(A);
  assert.equal(snapshot.mcpServers[0].definition, undefined, "ordinary reads remain credential-safe after an editor write");
  assert.deepEqual((await rolesCall("role_editor_snapshot", { roleId: A })).mcpServers[0].definition, { type: "stdio", command: "node", args: ["docs server.js", "--port", "7"] });
  assert.equal((await (await fetch(`${origin}/roles`)).text()).includes("docs server.js"), false, "connection definitions are absent from server-rendered HTML");
  await preview.getByText('command = "node"', { exact: false }).waitFor();
  const launch = await rolesCall("role_launch_preview", { roleId: A, cwds: [join(project, "src")] });
  assert.equal(launch.config, '[mcp_servers.docs]\ncommand = "node"\nargs = ["docs server.js", "--port", "7"]\nenabled = true\n');

  // Trusting a project shows which running Bots launch inside it.
  await projects.getByRole("button", { name: "Trust a project", exact: true }).click();
  const newProject = editor.getByRole("form", { name: "New trusted project" });
  await newProject.getByText("Trust covers the whole project config").waitFor();
  await newProject.getByLabel("Project root", { exact: true }).fill(project);
  await editor.getByRole("button", { name: "Trust project" }).click();
  const canonical = (await snap(A)).trustedProjects[0].path;
  const projectForm = editor.getByRole("form", { name: `Edit trusted project ${canonical}` });
  await projectForm.waitFor();
  await projectForm.getByRole("list", { name: "Bots inside this root" }).getByText("bot-1").waitFor();
  await projects.getByText("1 Bot", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "roles-resources.png"), animations: "disabled" });

  // Inspecting a skill lists its files by path, not bytes; deleting asks first.
  await servers.getByRole("button", { name: "docs actions" }).click();
  await page.getByRole("menuitem", { name: "Inspect record" }).click();
  await inspector.getByText("Role MCP server", { exact: true }).waitFor();
  await inspector.getByRole("button", { name: "Edit in Roles" }).click();
  await page.keyboard.press("Escape");
  await skills.getByRole("button", { name: "review-changes-copy actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await dialog.getByText("Delete skill “review-changes-copy”?", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await projects.getByRole("button", { name: "project actions" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await dialog.getByText(`Stop trusting “${canonical}”?`, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  snapshot = await snap(A);
  assert.deepEqual([snapshot.skills.map((skill) => skill.name), snapshot.trustedProjects.length], [["review-changes"], 0]);

  /* ─── Named Roles ─────────────────────────────────────────────────── */

  const revisionOf = async (id) => (await rolesCall("roles_snapshot")).roles.find((role) => role.id === id).revision;
  const defaultId = async () => (await rolesCall("roles_snapshot")).defaultRoleId;

  // A second Role: a name that differs only in case is refused as a hint before saving; creating it changes nothing else.
  await tap(catalogWindow.getByRole("button", { name: "New role", exact: true }));
  await editor.getByRole("form", { name: "New role" }).waitFor();
  await editor.getByLabel("Name", { exact: true }).fill("researcher");
  await editor.getByText("Another Role already uses this name; letter case is ignored").first().waitFor();
  assert.equal(await editor.getByRole("button", { name: "Create role" }).isDisabled(), true);
  await editor.getByText("A new Role starts empty and is not a launch default. Existing sessions keep their Role.").waitFor();
  await editor.getByLabel("Name", { exact: true }).fill("Reviewer");
  await editor.getByLabel(/^Description/).fill("Reviews changes before they land");
  await editor.getByRole("button", { name: "Create role" }).click();
  await roleRow("Reviewer").getByText("Editing", { exact: true }).waitFor();
  const afterSecond = await rolesCall("roles_snapshot");
  B = afterSecond.roles.find((role) => role.name === "Reviewer").id;
  assert.deepEqual([afterSecond.defaultRoleId, afterSecond.workerDefaultRoleId], [A, W], "creating a Role never changes a default");
  assert.equal(await researcher.getByText("Editing", { exact: true }).count(), 0, "only the selected Role reads as being edited");
  await researcher.getByText("Bot default", { exact: true }).waitFor();
  await instructions.getByText("Reviewer · revision 0", { exact: true }).waitFor();
  await instructions.getByText("No instructions", { exact: true }).waitFor();
  // Editing a Role that is neither default says who receives it, and offers Make Bot default.
  const note = "New Bots use “Researcher”, not this Role. Workers use it only when they select it; the rest use “Worker”. Edits reach later launches only; running sessions keep their snapshot.";
  await editor.getByText(note).waitFor();
  await preview.getByText(note).waitFor();
  await editor.getByRole("button", { name: "Make Bot default" }).waitFor();
  await shot("roles-second-role");

  // Different content in the second Role: nothing of it leaks into the first.
  await instructions.getByRole("button", { name: "New category", exact: true }).click();
  await editor.getByLabel("Title", { exact: true }).fill("Review rules");
  await editor.getByRole("button", { name: "Create category" }).click();
  const rules = instructions.getByRole("listitem", { name: "Category Review rules" });
  await rules.waitFor();
  await addFragment(rules, "Check tests", "Run the tests before approving.");
  await addFragment(rules, "Cite lines", "Cite the line of every finding.");
  assert.equal(await instructions.getByRole("listitem", { name: "Category Working style" }).count(), 0, "the first Role's categories are not shown under the second");
  await preview.getByText("Run the tests before approving.", { exact: true }).waitFor();
  assert.equal((await rolesCall("role_preview", { roleId: B })).rendered, "Run the tests before approving.\n\nCite the line of every finding.");
  assert.doesNotMatch((await rolesCall("role_preview", { roleId: A })).rendered, /Run the tests/, "the first Role's text is its own");

  // Equal revisions across Roles are unrelated: bring the second Role to exactly the first one's revision number.
  const target = await revisionOf(A);
  const category = (await snap(B)).categories[0];
  for (let revision = await revisionOf(B); revision < target; revision++) await rolesCall("category_update", { roleId: B, expectedRevision: revision, id: category.id, title: "Review rules" });
  assert.equal(await revisionOf(B), target);

  // What running Bots launched with, judged by Role identity and revision against the Bot default; open Workers against the Role each captured.
  const stale = "00000000-0000-4000-8000-00000000dead";
  botList = [bot("bot-1", A, target - 3, join(project, "src")), bot("bot-2", B, target), bot("bot-3", A, target), bot("bot-4", null, 5), bot("bot-5", stale, 2)];
  workerList = [worker("idle", A, target), worker("running", A, target - 2), worker("idle", B, target), worker("idle", W, 0), worker("idle", null, 4), worker("idle", stale, 3), worker("closed", A, 1)];
  botsSocket.publish("bots_changed", "bot-1");
  workerSocket.publish("workers_changed");
  const launched = (id) => preview.locator("li").filter({ has: page.getByText(id, { exact: true }) });
  await launched("bot-1").getByText("Older revision", { exact: true }).waitFor();
  await launched("bot-1").getByText(`Researcher r${target - 3}`, { exact: true }).waitFor();
  await launched("bot-2").getByText("Other Role", { exact: true }).waitFor();
  await launched("bot-2").getByText(`Reviewer r${target}`, { exact: true }).waitFor();
  await launched("bot-3").getByText("Current", { exact: true }).waitFor();
  await launched("bot-4").getByText("Unknown", { exact: true }).waitFor();
  await launched("bot-4").getByText("Unknown role r5", { exact: true }).waitFor();
  await launched("bot-5").getByText("Deleted role r2", { exact: true }).waitFor();
  assert.equal(await launched("bot-2").getByText("Current", { exact: true }).count(), 0, "a revision number shared with the default's is not the default's");
  // Reviewer's Worker at r${target} and the Worker default's are current against their own Roles, not "other".
  const workerLine = "6 open Workers · 1 on an older revision of its Role, 1 with a deleted Role, 1 with an unknown legacy Role";
  await preview.getByText(workerLine, { exact: true }).waitFor();
  await launched("bot-2").locator("[title]").first().waitFor();
  assert.equal(await launched("bot-2").locator(`[title="Launched with Reviewer r${target} · restart to use Researcher"]`).count() > 0, true);
  await shot("roles-launched");

  // Switch the default while both Roles hold unsaved edits: neither draft follows the default, and switching back restores it.
  const fragmentRow = (title) => instructions.locator('li[data-node^="fragment:"]').filter({ hasText: title });
  const openFragment = (title) => fragmentRow(title).getByRole("button", { name: new RegExp(`^${title}(?! actions)`) }).click();
  await openFragment("Check tests");
  await editor.getByLabel("Instructions", { exact: true }).fill("Run the tests and the linter before approving.");
  await fragmentRow("Check tests").getByRole("img", { name: "Unsaved changes" }).waitFor();
  await roleRow("Reviewer").getByRole("img", { name: "Unsaved changes" }).waitFor();
  await selectRole("Researcher");
  await instructions.getByText("Researcher · Bot default", { exact: false }).first().waitFor();
  await openFragment("Plain words");
  await editor.getByLabel("Instructions", { exact: true }).fill("Use plain words, always.");
  await roleRow("Researcher").getByRole("img", { name: "Unsaved changes" }).waitFor();
  await selectRole("Reviewer");
  await editor.getByLabel("Instructions", { exact: true }).waitFor();
  assert.equal(await editor.getByLabel("Instructions", { exact: true }).inputValue(), "Run the tests and the linter before approving.", "the draft is restored with its Role");
  await editor.getByText("Unsaved changes · ⌘S to save", { exact: true }).waitFor();
  await editor.getByRole("button", { name: "Make Bot default" }).click();
  await dialog.getByText("Make “Reviewer” the Bot default?", { exact: true }).waitFor();
  await dialog.getByText("Later Bot launches use this Role instead of “Researcher”. Workers started without a Role still use “Worker”. Running Bots keep what they launched with until restarted; nothing restarts automatically.").waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await defaultId(), A, "cancelling changes nothing");
  await editor.getByRole("button", { name: "Make Bot default" }).click();
  await dialog.getByRole("button", { name: "Make default", exact: true }).click();
  await toast("“Reviewer” is now the Bot default").waitFor();
  assert.equal(await defaultId(), B);
  assert.equal(await revisionOf(B), target, "a default switch advances the catalog, not the Role");
  await roleRow("Reviewer").getByText("Bot default", { exact: true }).waitFor();
  assert.equal(await roleRow("Researcher").getByText("Bot default", { exact: true }).count(), 0);
  assert.equal((await rolesCall("roles_snapshot")).workerDefaultRoleId, W, "Make Bot default leaves the Worker default");
  assert.equal(await editor.getByText(/not this Role\./).count(), 0, "the new Bot default carries no note");
  assert.equal(await editor.getByLabel("Instructions", { exact: true }).inputValue(), "Run the tests and the linter before approving.", "the default switch did not retarget the draft");
  await editor.getByText("Unsaved changes · ⌘S to save", { exact: true }).waitFor();
  // Nobody launched differently: the Bot that ran Researcher is now merely "other", and Reviewer's is current.
  await launched("bot-2").getByText("Current", { exact: true }).waitFor();
  await launched("bot-3").getByText("Other Role", { exact: true }).waitFor();
  await launched("bot-1").getByText("Other Role", { exact: true }).waitFor();
  assert.equal(await preview.getByText("Older revision", { exact: true }).count(), 0);
  await preview.getByText(workerLine, { exact: true }).waitFor();
  await launched("bot-3").locator(`[title="Launched with Researcher r${target} · restart to use Reviewer"]`).first().waitFor();
  assert.equal(await preview.getByText(/changed|updated/i).count(), 0, "the copy never claims a running process changed");
  await shot("roles-default-switched");
  // Saving the draft writes to the Role it was made for.
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  assert.equal((await snap(B)).categories[0].fragments[0].body, "Run the tests and the linter before approving.");
  await selectRole("Researcher");
  assert.equal(await editor.getByLabel("Instructions", { exact: true }).inputValue(), "Use plain words, always.", "the other Role's draft is untouched");
  assert.notEqual((await snap(A)).categories.flatMap((item) => item.fragments).find((item) => item.title === "Plain words").body, "Use plain words, always.");
  await editor.getByRole("button", { name: "Revert" }).click();
  await roleRow("Researcher").getByRole("img", { name: "Unsaved changes" }).waitFor({ state: "detached" });
  await editor.getByText("New Bots use “Reviewer”, not this Role. Workers use it only when they select it; the rest use “Worker”. Edits reach later launches only; running sessions keep their snapshot.").waitFor();

  // A write started for one Role and outrun by a change of selection finishes there and touches nothing else.
  await editor.getByLabel("Instructions", { exact: true }).fill("Use plain words, in short sentences.");
  await page.evaluate(() => { window.__wsDelay = 400; });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await selectRole("Reviewer");
  await instructions.getByText("Reviewer · Bot default", { exact: false }).first().waitFor();
  await page.evaluate(() => { window.__wsDelay = 0; });
  await until(() => snap(A), (value) => value.categories.flatMap((item) => item.fragments).some((item) => item.body === "Use plain words, in short sentences."), "the delayed save to land in the first Role");
  await wait(300);
  assert.equal((await snap(B)).categories[0].fragments[0].body, "Run the tests and the linter before approving.", "the second Role is untouched");
  assert.equal(await editor.getByText(/Unsaved changes/).count(), 0);
  await editor.getByRole("form", { name: "Edit Check tests" }).waitFor();
  assert.equal(await editor.getByLabel("Instructions", { exact: true }).inputValue(), "Run the tests and the linter before approving.", "the second Role's Editor shows its own record, not the first Role's");
  await selectRole("Researcher");
  await editor.getByRole("form", { name: "Edit Plain words" }).waitFor();
  await editor.getByText("All changes saved", { exact: true }).waitFor();
  assert.equal(await editor.getByLabel("Instructions", { exact: true }).inputValue(), "Use plain words, in short sentences.");

  // Renaming goes through the Editor. The API's uniqueness refusal is shown when the page did not know of the clash.
  await tap(roleRow("Researcher").getByRole("button", { name: "Researcher actions" }));
  await page.getByRole("menuitem", { name: "Edit details" }).click();
  const details = editor.getByRole("form", { name: "Edit Role Researcher" });
  await details.waitFor();
  await details.getByLabel("Name", { exact: true }).fill("reviewer");
  await details.getByText("Another Role already uses this name; letter case is ignored").first().waitFor();
  assert.equal(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  await drop(true);
  await rolesCall("role_create", { expectedRevision: (await rolesCall("roles_snapshot")).revision, name: "Foo", description: "made elsewhere" });
  await details.getByLabel("Name", { exact: true }).fill("foo");
  assert.equal(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(), false, "the page has not seen Foo");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await details.getByText("Another Role already uses this name; letter case is ignored").last().waitFor();
  assert.equal((await rolesCall("roles_snapshot")).roles.find((role) => role.id === A).name, "Researcher");
  await details.getByLabel("Name", { exact: true }).fill("Research");
  await details.getByLabel(/^Description/).fill("Reads sources and reports what they say, with links");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await until(() => rolesCall("roles_snapshot"), (value) => value.roles.find((role) => role.id === A).name === "Research", "the rename");
  assert.equal(await defaultId(), B, "renaming never changes the default");
  await drop(false);
  await roleRow("Research").getByText("Editing", { exact: true }).waitFor();
  await roleRow("Foo").waitFor();

  // A stale catalog revision commits nothing: the page rereads the catalog and rebuilds the write once.
  await drop(true);
  await rolesCall("role_create", { expectedRevision: (await rolesCall("roles_snapshot")).revision, name: "Third", description: "" });
  assert.equal(await roleRow("Third").count(), 0, "the page missed the change");
  await tap(roleRow("Research").getByRole("button", { name: "Research actions" }));
  await page.getByRole("menuitem", { name: "Make Bot default…" }).click();
  await dialog.getByRole("button", { name: "Make default", exact: true }).click();
  await toast("“Research” is now the Bot default").waitFor();
  assert.equal(await defaultId(), A);
  await roleRow("Third").waitFor();
  assert.deepEqual((await rolesCall("roles_snapshot")).roles.map((role) => role.name), ["Manager", "Worker", "Research", "Reviewer", "Foo", "Third"]);
  await drop(false);
  // A stale Role revision likewise: another client edited this Role, then a switch here is rebuilt and applied.
  await drop(true);
  const working2 = (await snap(A)).categories.find((item) => item.title === "Working style");
  await rolesCall("category_update", { roleId: A, expectedRevision: await revisionOf(A), id: working2.id, description: "Edited elsewhere" });
  await instructions.getByRole("switch", { name: "Working style enabled" }).click();
  await until(() => snap(A), (value) => value.categories.find((item) => item.id === working2.id).enabled === false, "the stale switch to apply");
  assert.equal((await snap(A)).categories.find((item) => item.id === working2.id).description, "Edited elsewhere", "the other client's edit survives");
  await drop(false);
  await instructions.getByRole("switch", { name: "Working style enabled" }).click();
  await instructions.getByText("Edited elsewhere", { exact: false }).first().waitFor();

  /* ─── Internal Stack MCP servers ───────────────────────────────── */

  const internalNames = (await rolesCall("role_internal_mcp_list", { roleId: A })).servers.map((server) => server.name);
  assert.ok(internalNames.length >= 3 && internalNames.includes("roles"), `the repository configures several internal MCP servers: ${internalNames}`);
  const total = internalNames.length;
  const count = (on) => servers.getByText(`${on} of ${total} on`, { exact: true }).first();
  const enabledNow = async (id) => Object.fromEntries((await rolesCall("role_internal_mcp_list", { roleId: id })).servers.map((server) => [server.name, server.enabled]));
  await servers.getByText("Stack servers", { exact: true }).waitFor();
  await count(total).waitFor();
  assert.deepEqual(Object.values(await enabledNow(A)).every(Boolean), true, "every server is on in a newly created Role");
  assert.deepEqual(Object.values(await enabledNow(B)).every(Boolean), true);
  await servers.getByText("Switches apply to later Bot launches and new Workers; running sessions keep their connections. New Stack packages start on.").waitFor();
  await preview.getByRole("button", { name: "Launch", exact: false }).click();
  await preview.getByText(`${total} of ${total} Stack servers on · 1 from the Role`).waitFor();
  // Off for this Role only, and the preview tells enabled from configured.
  await stackSwitch("bots").click();
  await until(() => enabledNow(A), (value) => value.bots === false, "bots to switch off");
  assert.equal((await enabledNow(B)).bots, true, "switches belong to their own Role");
  await count(total - 1).waitFor();
  await servers.locator("li").filter({ has: page.getByText("bots", { exact: true }) }).getByText("Off", { exact: true }).waitFor();
  await preview.getByText(`${total - 1} of ${total} Stack servers on · 1 from the Role`).waitFor();
  assert.equal(await preview.locator('[title="Off for this Role"]').count(), 1);
  assert.deepEqual((await rolesCall("role_launch_preview", { roleId: A })).internalMcpServers.filter((server) => !server.enabled).map((server) => server.name), ["bots"]);
  await shot("roles-internal-off");
  await stackSwitch("bots").click();
  await until(() => enabledNow(A), (value) => value.bots === true, "bots to switch on");
  await count(total).waitFor();
  // All off is allowed, roles included.
  for (const name of internalNames) {
    await stackSwitch(name).click();
    await until(() => enabledNow(A), (value) => value[name] === false, `${name} to switch off`);
  }
  await count(0).waitFor();
  await servers.getByText("Every Stack server is off; later launches receive none of them.").waitFor();
  assert.equal(Object.values(await enabledNow(A)).some(Boolean), false);
  assert.equal(Object.values(await enabledNow(B)).every(Boolean), true, "the default Role is unaffected");
  // A switched-off name is still reserved against an external MCP server.
  await servers.getByRole("button", { name: "New MCP server", exact: true }).click();
  const external = editor.getByRole("form", { name: "New MCP server" });
  await external.getByLabel("Name", { exact: true }).fill("roles");
  await external.getByText("A Stack server already uses this name, even while it is switched off").first().waitFor();
  assert.equal(await editor.getByRole("button", { name: "Create server" }).isDisabled(), true);
  await external.getByRole("button", { name: "Discard", exact: true }).click();
  await shot("roles-internal-all-off");
  // A stale revision: another client changed the Role; a switch here is rebuilt, or skipped when the change was the same one.
  await drop(true);
  await rolesCall("role_internal_mcp_update", { roleId: A, expectedRevision: await revisionOf(A), name: "roles", enabled: true });
  const before = await revisionOf(A);
  await stackSwitch("bots").click();
  await until(() => enabledNow(A), (value) => value.bots === true, "the stale switch to apply after a reread");
  assert.equal((await enabledNow(A)).roles, true, "the other client's change survives");
  assert.equal(await revisionOf(A), before + 1, "one write, after one reread");
  await drop(false);
  await drop(true);
  await rolesCall("role_internal_mcp_update", { roleId: A, expectedRevision: await revisionOf(A), name: "roles", enabled: false });
  const settled = await revisionOf(A);
  await stackSwitch("roles").click();
  await stackSwitch("roles").waitFor();
  await wait(400);
  assert.equal(await revisionOf(A), settled, "the reread already showed the requested state, so nothing more was written");
  assert.equal((await enabledNow(A)).roles, false);
  await drop(false);
  // Restore A's switches and confirm the second Role's independence from the first.
  for (const name of internalNames.filter((item) => item !== "roles" && item !== "bots")) await stackSwitch(name).click();
  await stackSwitch("roles").click();
  await until(() => enabledNow(A), (value) => Object.values(value).every(Boolean), "every switch to return on");
  await selectRole("Reviewer");
  await servers.getByText("Reviewer", { exact: true }).first().waitFor();
  await count(total).waitFor();

  /* ─── Deleting Roles ───────────────────────────────────────────── */

  // The Bot default cannot be deleted, and the menu says why.
  await tap(roleRow("Research").getByRole("button", { name: "Research actions" }));
  const defaultDelete = page.getByRole("menuitem", { name: /Delete…/ });
  assert.notEqual(await defaultDelete.getAttribute("data-disabled"), null, "the default's Delete is disabled");
  await page.getByText("Make another Role the Bot default first", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await defaultId(), A);
  await rolesCall("role_delete", { roleId: A, expectedRevision: (await rolesCall("roles_snapshot")).revision }).then(() => assert.fail("the API accepted deleting the default"), (error) => assert.match(error.message, /cannot delete the default role/));

  // A non-default Role goes with its unsaved edits, after saying what it removes.
  await tap(roleRow("Third").getByRole("button", { name: "Third actions" }));
  await page.getByRole("menuitem", { name: "Edit details" }).click();
  await editor.getByRole("form", { name: "Edit Role Third" }).getByLabel(/^Description/).fill("Draft that will not be kept");
  await roleRow("Third").getByRole("img", { name: "Unsaved changes" }).waitFor();
  await tap(roleRow("Third").getByRole("button", { name: "Third actions" }));
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await dialog.getByText("Delete “Third”?", { exact: true }).waitFor();
  await dialog.getByText("This removes its instructions, skills, MCP servers and trusted projects, and discards its unsaved edits. Bots and Workers that already launched keep their snapshots. This can’t be undone.").waitFor();
  await shot("roles-delete-role");
  await dialog.getByRole("button", { name: "Delete Role" }).click();
  await dialog.waitFor({ state: "hidden" });
  await toast("Deleted “Third”").waitFor();
  assert.deepEqual((await rolesCall("roles_snapshot")).roles.map((role) => role.name), ["Manager", "Worker", "Research", "Reviewer", "Foo"]);
  await roleRow("Third").waitFor({ state: "detached" });
  assert.equal(await roleRow("Research").getByText("Editing", { exact: true }).count(), 1, "deleting your own selected Role selects the default");
  assert.equal(await page.getByText("was deleted in another window").count(), 0, "a deletion made here is not reported as made elsewhere");

  // The selected Role deleted in another window, holding unsaved edits: they are kept readable, not applied elsewhere.
  await selectRole("Foo");
  await tap(roleRow("Foo").getByRole("button", { name: "Foo actions" }));
  await page.getByRole("menuitem", { name: "Edit details" }).click();
  await editor.getByRole("form", { name: "Edit Role Foo" }).getByLabel(/^Description/).fill("Text that must survive");
  await roleRow("Foo").getByRole("img", { name: "Unsaved changes" }).waitFor();
  const foo = (await rolesCall("roles_snapshot")).roles.find((role) => role.name === "Foo").id;
  await rolesCall("role_delete", { roleId: foo, expectedRevision: (await rolesCall("roles_snapshot")).revision });
  await editor.getByText("This Role was deleted in another window", { exact: true }).waitFor();
  await editor.getByText("Text that must survive", { exact: true }).waitFor();
  await editor.getByRole("button", { name: "Copy description text" }).waitFor();
  await catalogWindow.getByText("was deleted in another window. Its unsaved edits are still here.").waitFor();
  await instructions.getByText("Role deleted", { exact: true }).waitFor();
  assert.equal(await defaultId(), A);
  await shot("roles-deleted-elsewhere");
  await editor.getByRole("button", { name: "Discard drafts" }).click();
  await roleRow("Research").getByText("Editing", { exact: true }).waitFor();
  await editor.getByText("This Role was deleted in another window", { exact: true }).waitFor({ state: "detached" });

  // Without edits the page falls back to the default and says so once.
  await rolesCall("role_create", { expectedRevision: (await rolesCall("roles_snapshot")).revision, name: "Ephemeral", description: "" });
  await roleRow("Ephemeral").waitFor();
  await selectRole("Ephemeral");
  await instructions.getByText("Ephemeral · revision 0", { exact: true }).waitFor();
  const ephemeral = (await rolesCall("roles_snapshot")).roles.find((role) => role.name === "Ephemeral").id;
  await rolesCall("role_delete", { roleId: ephemeral, expectedRevision: (await rolesCall("roles_snapshot")).revision });
  await toast("“Ephemeral” was deleted in another window").waitFor();
  await roleRow("Research").getByText("Editing", { exact: true }).waitFor();

  // The viewer remembers which Role it last edited; the default is not what it remembers.
  await selectRole("Reviewer");
  await instructions.getByText("Reviewer · revision", { exact: false }).first().waitFor();
  await page.reload();
  await roleRow("Reviewer").getByText("Editing", { exact: true }).waitFor();
  await roleRow("Research").getByText("Bot default", { exact: true }).waitFor();
  await instructions.getByText("Reviewer · revision", { exact: false }).first().waitFor();

  // Inspecting a Role hands back to the Editor, which selects it; the palette finds Roles and offers New role.
  await tap(roleRow("Research").getByRole("button", { name: "Research actions" }));
  await page.getByRole("menuitem", { name: "Inspect record" }).click();
  await inspector.getByText("Role · Bot default", { exact: true }).waitFor();
  await inspector.getByRole("button", { name: "Edit in Roles" }).click();
  await editor.getByRole("form", { name: "Edit Role Research" }).waitFor();
  await roleRow("Research").getByText("Editing", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill("role reviewer");
  await page.getByRole("option", { name: /Reviewer/ }).first().click();
  await editor.getByRole("form", { name: "Edit Role Reviewer" }).waitFor();
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill("new role");
  await page.getByRole("option", { name: /New role/ }).first().click();
  await editor.getByRole("form", { name: "New role" }).waitFor();
  await editor.getByRole("button", { name: "Discard new role" }).click();
  // The closing checks use the first Role's fragments.
  await selectRole("Research");
  await shot("roles-multirole");

  // "Edit in Roles" revealed the server's window; the palette brings the fragment back into view.
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill("role fragment plain");
  await page.getByRole("option", { name: /Plain words/ }).first().click();
  await editor.getByRole("form", { name: "Edit Plain words" }).waitFor();
  await shot("roles-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("roles-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("roles-mobile");
  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "provisioned Manager and Worker defaults, per-audience notes, Make Worker default from the note and the row menu with its dialog, cancel and delete guard, new Role made Bot default, second Role and case-insensitive name hint, per-Role content, Bot launch comparison by Role identity and revision against the Bot default, Worker comparison against each captured Role, default switch with drafts on both Roles, delayed write outrun by selection, rename and API uniqueness refusal, stale catalog and stale Role and stale internal-switch rebuilds, internal switches per Role and all off, reserved internal names, Bot and Worker default delete refused, delete with drafts, Role deleted elsewhere with and without drafts, remembered selection, Role inspector and palette, category and fragment creation, preview order and segments, launch revisions, switches, cross-category drag, keyboard move, drafts, conflict keep-mine, stale-revision rebuild, search, category off, inspector hand-off, palette, delete guard and delete, skill files and duplicate/reorder/switch, MCP name guard, TOML and stdio split, trusted-project Bot matching, resource inspect and delete, light/dark/mobile" }, null, 2));
} catch (error) {
  failed = true;
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all(sockets.map((socket) => socket.close()));
  await rolesServer?.close();
  // The disposable state directory always goes; a failed run keeps it only when its screenshot lives inside.
  if (!(failed && evidence.startsWith(dir))) await rm(dir, { recursive: true, force: true });
}
