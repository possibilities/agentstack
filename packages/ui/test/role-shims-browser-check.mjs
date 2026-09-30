// Optional rendered check of the Roles space's Shims window after pnpm test (and a ui build, or NEXT_MODE=dev).
// The real Roles API runs against a disposable state directory and command directory; nothing is installed on PATH.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/role-shims-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { api as rolesApi } from "../../roles/dist/api.js";
import { fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, ui, authorizeBrowser, serveFixture } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join("/tmp", "as-shims-ui-"));
const bin = join(dir, "bin");
await mkdir(bin);
const evidence = process.env.SHIMS_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
// Nothing of the live Stack environment reaches the fixture: only the disposable directories are named.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, STACK_INSTALL_BIN_DIR: bin, NEXT_TELEMETRY_DISABLED: "1" };
const handlers = {
  serve_status: () => ({ pid: process.pid, children: [], mcpUrls: {}, indexUrl: null, uiUrl: null, inspectorUrl: null }),
  bot_list: () => ({ bots: [] }),
  bot_defaults_get: () => ({ model: "fixture", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" }),
  voice_status: () => ({ call: null }),
  serve_resources: () => { throw new Error("not part of this fixture"); },
  serve_resource_history: () => { throw new Error("not part of this fixture"); },
  worker_list: () => ({ workers: [] }),
  worker_runtime_list: () => ({ runtimes: [] }),
};
/** Lets the page miss change notices, so a stale revision reaches the server deterministically. */
const wrapSockets = () => {
  const Native = window.WebSocket;
  window.__wsDrop = false;
  window.WebSocket = class extends Native {
    set onmessage(handler) { super.onmessage = handler ? (event) => { if (window.__wsDrop && String(event.data).includes('"events/changed"')) return; handler.call(this, event); } : handler; }
    get onmessage() { return super.onmessage; }
  };
};
const sockets = [];
let websocket, next, browser, rolesServer;
let log = "";
let failed = false;
const rolesCall = (name, args = {}) => socketCall(socketPath("roles", env), "tools/call", { name, arguments: args });
const listed = async (name) => (await rolesCall("role_shim_list")).shims.find((shim) => shim.name === name) ?? null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, done, label) {
  let value = await read();
  for (let attempt = 0; !done(value) && attempt < 100; attempt++) { await wait(50); value = await read(); }
  assert.ok(done(value), `timed out waiting for ${label}`);
  return value;
}

// Whitespace, quotes, leading dashes, `#` and a second -- on the native side, which must all survive exactly.
const expected = ["default", "--with-harness", "opencode", "--with-model", "astra", "--", "opencode", "--model", "openai/gpt-6-astra#medium", "--yolo", "it's \"q\"", "  sp  ", "--", "-dash"];

try {
  rolesServer = await serveApi({ name: "roles", transport: "socket", env, root });
  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["roles", "serve", "bots", "worker", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const catalog = [doc("roles", rolesApi), doc("bots", botsApi), doc("serve"), doc("worker"), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture(handlers);
  Object.assign(handlers, serve.handlers);
  for (const [name, names, topics] of [["serve", serve.names, serve.topics], ["bots", ["bot_list", "bot_defaults_get", "voice_status"], botsApi.events.topics],
    ["worker", ["worker_list", "worker_runtime_list"], { workers_changed: "Fixture" }], ["api", ["docs_snapshot"], {}]]) {
    sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: fixtureOperations(names, handlers),
      events: { topics, scope: name === "bots" ? { valid: () => true, description: "Fixture", example: "bot-1" } : undefined } }));
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
  const tap = (locator) => locator.click({ timeout: 2_000 }).catch(async () => { await page.getByRole("button", { name: /Fit bench/ }).click(); await locator.click(); });
  await page.goto(`${origin}/roles`);
  const shims = page.locator('[data-window="role-shims"]');
  const inspector = page.getByRole("region", { name: "Inspector" });
  const dialog = page.getByRole("alertdialog");
  const row = (name) => shims.locator(`li[data-node="role-shim:${name}"]`);
  const status = shims.getByRole("status");
  const token = (list, index) => shims.getByRole("textbox", { name: `${list} ${index}`, exact: true });
  const add = async (list, values) => {
    for (const value of values) {
      await shims.getByRole("button", { name: `Add ${list.toLowerCase().replace(/s$/, "")}` }).click();
      const count = await shims.getByRole("list", { name: list }).getByRole("textbox").count();
      await token(list, count).fill(value);
    }
  };
  const preview = shims.getByLabel("Shim command preview");

  // Empty, with the real command directory and the PATH explanation.
  await shims.getByText("No Role shims", { exact: true }).waitFor();
  await shims.getByText(bin, { exact: true }).first().waitFor();
  await shims.getByText("must be on your PATH", { exact: false }).waitFor();
  await shot("shims-empty");

  // Create the complex vector token by token; the preview quotes exactly what a shell would need.
  await tap(shims.getByRole("button", { name: "Create shim" }));
  await shims.getByLabel("Command name").fill("opencode-astra");
  await add("Stack arguments", ["--with-harness", "opencode", "--with-model", "astra"]);
  await shims.getByLabel("Native harness").selectOption("opencode");
  await add("Native arguments", ["--model", "openai/gpt-6-astra#medium", "--yolo", "it's \"q\"", "  sp  ", "--", "-dash"]);
  await shims.getByText("The catalog default when it runs", { exact: false }).waitFor();
  assert.equal(await preview.textContent(), `stack roles inject default --with-harness opencode --with-model astra -- opencode --model 'openai/gpt-6-astra#medium' --yolo 'it'"'"'s "q"' '  sp  ' -- -dash "$@"`);
  await shot("shims-new");
  await shims.getByRole("button", { name: "Install" }).click();
  await shims.getByText("Installed as shown", { exact: true }).waitFor();
  const installed = await until(() => listed("opencode-astra"), Boolean, "the created shim");
  assert.deepEqual(installed.args, expected, "the created vector reaches the API token for token");
  await row("opencode-astra").waitFor();

  // Edit on the native side only: move a token, change another. The Stack side and the boundary stay put.
  await shims.getByRole("button", { name: "Move native arguments 3 up" }).click();
  await token("Native arguments", 5).fill("  sp2  ");
  await shims.getByRole("button", { name: "Save" }).click();
  await shims.getByText("Installed as shown", { exact: true }).waitFor();
  const edited = await until(() => listed("opencode-astra"), (shim) => shim.revision !== installed.revision, "the edited shim");
  assert.deepEqual(edited.args, ["default", "--with-harness", "opencode", "--with-model", "astra", "--", "opencode", "--model", "--yolo", "openai/gpt-6-astra#medium", "it's \"q\"", "  sp2  ", "--", "-dash"]);

  // A -- among the Stack arguments would move the boundary, so it blocks saving rather than being re-parsed.
  await token("Stack arguments", 5).fill("--");
  await status.getByText("cannot appear among the Stack arguments", { exact: false }).waitFor();
  assert.equal(await shims.getByRole("button", { name: "Save" }).isDisabled(), true);
  await shims.getByRole("button", { name: "Revert" }).click();

  // Stale: another writer replaces it while this page misses the notice. The save is refused and nothing is overwritten.
  await drop(true);
  await add("Native arguments", ["--print-logs"]);
  await rolesCall("role_shim_update", { name: "opencode-astra", expectedRevision: edited.revision, args: ["--", "codex"] });
  await shims.getByRole("button", { name: "Save" }).click();
  await shims.getByText("changed since it was listed", { exact: false }).waitFor();
  await shims.getByText("Changed elsewhere", { exact: true }).waitFor();
  assert.deepEqual((await listed("opencode-astra")).args, ["--", "codex"], "a stale save wrote nothing");
  await shot("shims-stale");
  await shims.getByRole("button", { name: "Use installed" }).click();
  assert.equal(await preview.textContent(), 'stack roles inject -- codex "$@"');
  await drop(false);

  // Collision: a command the page did not install is never replaced.
  const foreignPath = join(bin, "claude2");
  await writeFile(foreignPath, "#!/bin/sh\necho mine\n");
  await chmod(foreignPath, 0o755);
  await tap(shims.getByRole("button", { name: "New shim" }));
  await shims.getByLabel("Command name").fill("claude2");
  await shims.getByLabel("Native harness").selectOption("claude");
  await shims.getByRole("button", { name: "Install" }).click();
  await shims.getByText(`A command already exists at ${foreignPath}`, { exact: false }).waitFor();
  assert.equal(await readFile(foreignPath, "utf8"), "#!/bin/sh\necho mine\n");
  await shims.getByLabel("Command name").fill("stack");
  await status.getByText("is Stack or a native harness command", { exact: false }).waitFor();
  await shims.getByRole("button", { name: "Close shim editor" }).click();

  // Foreign: a shim edited outside Stack is no longer Stack-owned; saving over it is refused and the file is kept.
  const current = await listed("opencode-astra");
  await tap(row("opencode-astra").getByRole("button").first());
  await appendFile(current.path, "# hand edit\n");
  const handEdited = await readFile(current.path, "utf8");
  await add("Native arguments", ["--print-logs"]);
  await shims.getByRole("button", { name: "Save" }).click();
  await shims.getByText("is no longer a Stack-owned shim", { exact: false }).first().waitFor();
  await shims.getByText("No longer installed", { exact: true }).waitFor();
  assert.equal(await readFile(current.path, "utf8"), handEdited);
  assert.equal(await row("opencode-astra").count(), 0, "an edited command drops out of the listing");
  await shot("shims-foreign");
  await shims.getByRole("button", { name: "Close shim editor" }).click();

  // Inspect and remove: the dialog names the path, and running sessions are unaffected.
  const doomed = await rolesCall("role_shim_create", { name: "codex-plain", args: ["default", "--", "codex"] });
  await row("codex-plain").waitFor();
  await tap(row("codex-plain").getByRole("button", { name: "codex-plain actions" }));
  await page.getByRole("menuitem", { name: "Inspect record" }).click();
  await inspector.getByText("Role shim", { exact: true }).waitFor();
  await inspector.getByRole("button", { name: "Edit in Shims" }).click();
  await shims.getByText("Edit codex-plain", { exact: true }).waitFor();
  await tap(row("codex-plain").getByRole("button", { name: "codex-plain actions" }));
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await dialog.getByText(doomed.path, { exact: true }).waitFor();
  await dialog.getByText("Sessions already started with it keep running", { exact: false }).waitFor();
  await shot("shims-remove");
  await dialog.getByRole("button", { name: "Remove command" }).click();
  await until(() => stat(doomed.path).then(() => true, () => false), (exists) => !exists, "the removed script");
  await row("codex-plain").waitFor({ state: "detached" });
  await shims.getByText("No Role shims", { exact: true }).waitFor();
  assert.equal(await readFile(current.path, "utf8"), handEdited, "removing one shim touches no other command");

  await page.emulateMedia({ colorScheme: "dark" });
  await tap(shims.getByRole("button", { name: "Create shim" }));
  await shot("shims-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("shims-mobile");
  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "empty state with command directory and PATH note, token-by-token create of a whitespace/quote/dash/#/second -- vector with an exact preview and exact API args, native-side move and edit, -- among Stack arguments blocked, stale save refused without overwrite then Use installed, collision with a foreign file refused and file intact, reserved name, hand-edited shim refused and kept, inspector hand-off, remove dialog with path and running-session note, dark and mobile" }, null, 2));
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
  if (!(failed && evidence.startsWith(dir))) await rm(dir, { recursive: true, force: true });
}
