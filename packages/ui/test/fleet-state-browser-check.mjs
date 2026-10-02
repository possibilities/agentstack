// Optional rendered check of Fleet's Bot state window after pnpm test (and a ui build, or NEXT_MODE=dev).
// The real auth and bots APIs run against a disposable state directory and HOME with the fake app-server runtime;
// Worker, Browse, Proc and Serve dependency answers come from fixture sockets. Queue entries are seeded through the owner's
// own ChatIndex. No live state is read or changed.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/fleet-state-browser-check.mjs
// CHROME_BIN may override the local headless Chrome executable; FLEET_STATE_EVIDENCE_DIR keeps the screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { operation, publishedJsonSchema, serveApi, serveSocket, serveWebSocket, socketCall, socketPath, stateDependencies, stateDependencyInput } from "@stack/api";
import { api as botsApi } from "../../bots/dist/api.js";
import { ChatIndex } from "../../bots/dist/src/chats.js";
import { StateStore } from "../../bots/dist/src/store.js";
import { RoleStore } from "../../roles/dist/src/index.js";
import { authorizeBrowser, fixtureDoc, fixtureOperations, freePort as port, gatewayRoot, root, serveFixture, ui } from "./browser-fixture.mjs";

if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to an installed Playwright module");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const require = createRequire(import.meta.url);
const dir = await realpath(await mkdtemp(join("/tmp", "as-fleet-state-")));
const home = await mkdtemp(join("/tmp", "as-fleet-home-"));
// Deliberately unresolved: on macOS /tmp is a symlink, so the workspace root is reached through a linked ancestor.
const external = await mkdtemp(join("/tmp", "as-fleet-ext-"));
const evidence = process.env.FLEET_STATE_EVIDENCE_DIR ?? join(dir, "evidence");
await mkdir(evidence, { recursive: true });
// The fake runtime is found through HOME; nothing of the live installation is used.
await mkdir(join(home, ".local", "libexec", "codexnk"), { recursive: true });
await symlink(join(root, "packages", "bots", "test", "fixtures", "fake-app-server.mjs"), join(home, ".local", "libexec", "codexnk", "codex"));
const savedHome = process.env.HOME;
process.env.HOME = home;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STACK_"))), STACK_STATE_DIR: dir, NEXT_TELEMETRY_DISABLED: "1" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (path) => lstat(path).then(() => true, () => false);

const store = new StateStore(dir);
const account = store.addAccount(JSON.stringify({ tokens: { refresh_token: "test", access_token: "access", id_token: "fixture.jwt.signature" } })).id;
store.close();
const roles = new RoleStore(dir);
roles.role(roles.catalog().defaultRoleId).update(0, { name: "Fixture" });
roles.close();

/** Dependency owners the plan consults. `blocked` names what the Worker fixture reports as open work. */
const dependency = { blocked: ["Close Worker w-17 (running) before Bot maintenance"] };
const dependencyOperation = (name, answer) => operation({ name: `${name}_bot_dependencies`, description: "Fixture", input: stateDependencyInput, output: stateDependencies, async call() { return answer(); } });

/** Turn the first apply response for `action` into a transport error: the request ran, but its answer was lost. */
const loseResponse = () => {
  const Native = window.WebSocket;
  window.__lose = null;
  window.WebSocket = class extends Native {
    set onmessage(handler) {
      super.onmessage = handler ? (event) => {
        const lose = window.__lose;
        if (lose && typeof event.data === "string" && event.data.includes(`"action":"${lose}"`) && event.data.includes('"planId"')) {
          const message = JSON.parse(event.data);
          if (message.result?.status) {
            window.__lose = null;
            window.__lost = message.result.requestId;
            return handler.call(this, new MessageEvent("message", { data: JSON.stringify({ id: message.id, error: { message: "fixture: response lost in transit" } }) }));
          }
        }
        handler.call(this, event);
      } : handler;
    }
    get onmessage() { return super.onmessage; }
  };
};

const sockets = [];
let websocket, next, browser, auth, bots, queue;
let log = "";
let failed = false;
try {
  auth = await serveApi({ name: "auth", transport: "socket", env });
  bots = await serveApi({ name: "bots", transport: "socket", env });
  const call = (name, args = {}) => socketCall(bots.socketPath, "tools/call", { name, arguments: args }, { timeoutMs: 30_000 });
  const alpha = await call("bot_start", { id: "alpha", account, args: ["-c", 'model="gpt-fixture"', "--secret-flag=hunter2"] });
  await call("bot_start", { id: "ext", cwd: external, account });
  // An upload staged and finalized through the owner's own API.
  const body = Buffer.from("hello from an upload\n");
  const uploadId = crypto.randomUUID();
  await call("chat_upload_start", { botId: "alpha", id: uploadId, name: "hello.txt", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
  await call("chat_upload_chunk", { botId: "alpha", id: uploadId, offset: 0, data: body.toString("base64") });
  await call("chat_upload_finish", { botId: "alpha", id: uploadId });
  await call("bot_stop", { id: "alpha" });
  // Queue admissions of every outcome, seeded through the owner's own index: bodies hold distinctive secrets so clearing is provable.
  const seedStore = new StateStore(dir);
  const { incarnation, generation: firstGeneration } = seedStore.stateIdentity("alpha");
  seedStore.close();
  queue = new ChatIndex(dir, (id) => join(dir, "history", id));
  const thread = "thread-queue-fixture";
  const queued = { sent: crypto.randomUUID(), unknown: crypto.randomUUID(), cancelled: crypto.randomUUID(), pending: crypto.randomUUID(), legacy: crypto.randomUUID() };
  queue.enqueue("alpha", thread, queued.sent, [{ type: "text", text: "Sent secret body" }], firstGeneration); queue.setQueued(queued.sent, "sent", "turn-1");
  queue.enqueue("alpha", thread, queued.unknown, [{ type: "text", text: "Unknown secret body" }], firstGeneration); queue.setQueued(queued.unknown, "unknown");
  queue.enqueue("alpha", thread, queued.cancelled, [{ type: "text", text: "Cancelled secret body" }], firstGeneration); queue.setQueued(queued.cancelled, "cancelled");
  queue.enqueue("alpha", thread, queued.pending, [{ type: "text", text: "Pending secret body" }], firstGeneration);
  queue.enqueue("alpha", thread, queued.legacy, [{ type: "text", text: "Unattributed legacy body" }]); queue.setQueued(queued.legacy, "cancelled");
  // Workspace files: selected, sibling, nested, markup, binary, a symlink out of the workspace and a cleanup quarantine.
  const cwd = alpha.cwd;
  await writeFile(join(cwd, "notes.txt"), "remove me\n");
  await writeFile(join(cwd, "keep.txt"), "sibling that must survive\n");
  await mkdir(join(cwd, "docs"));
  await writeFile(join(cwd, "docs", "a.md"), "# A\n");
  await writeFile(join(cwd, "page.html"), "<script>window.__pwned = true</script><b>not rendered</b>\n");
  await writeFile(join(cwd, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  await symlink("/etc/hosts", join(cwd, "hosts-link"));
  await mkdir(join(cwd, ".stack-clear-6f1c2e0a-8f5b-4c52-9a1e-0b7c3d2e1f40"));
  await writeFile(join(external, "outside.txt"), "external bytes\n");
  await mkdir(join(dir, "runtime-recovery", "alpha", "refresh-2026-09-30"), { recursive: true });
  await writeFile(join(dir, "runtime-recovery", "alpha", "refresh-2026-09-30", "auth.json"), "{\"never\":\"shown\"}");

  websocket = await serveWebSocket({ env, root: await gatewayRoot(dir, ["serve", "bots", "api"]), port: 0 });
  const doc = (name, api) => fixtureDoc(name, api, websocket.url, publishedJsonSchema);
  const handlers = {};
  const catalog = [doc("serve", (await import("../../serve/dist/api.js")).api), doc("bots", botsApi), doc("api")];
  handlers.docs_snapshot = () => ({ packages: catalog });
  const serve = await serveFixture({ serve_subscription_list: () => ({ subscriptions: [], revision: "none", nextOffset: null }), serve_state_list: () => ({ entries: [], revision: "none", observedAt: new Date().toISOString(), nextOffset: null, owners: [] }) });
  Object.assign(handlers, serve.handlers);
  const empty = () => ({ revision: "empty", blockedBy: [], retained: [], relationships: [] });
  sockets.push(await serveSocket({ info: { name: "serve", description: "serve", transportDescription: "Fixture", path: socketPath("serve", env) }, context: {},
    operations: [...fixtureOperations(serve.names, handlers), dependencyOperation("serve", empty)], events: { topics: serve.topics } }));
  sockets.push(await serveSocket({ info: { name: "api", description: "api", transportDescription: "Fixture", path: socketPath("api", env) }, context: {}, operations: fixtureOperations(["docs_snapshot"], handlers) }));
  sockets.push(await serveSocket({ info: { name: "worker", description: "worker", transportDescription: "Fixture", path: socketPath("worker", env) }, context: {},
    operations: [dependencyOperation("worker", () => ({ revision: JSON.stringify(dependency.blocked), blockedBy: dependency.blocked, retained: ["Worker w-17 transcript and Git worktree"],
      relationships: dependency.blocked.length ? [{ relation: "worker", package: "worker", kind: "worker", id: "w-17" }] : [] }))] }));
  for (const name of ["browse", "proc"]) sockets.push(await serveSocket({ info: { name, description: name, transportDescription: "Fixture", path: socketPath(name, env) }, context: {}, operations: [dependencyOperation(name, empty)] }));

  const nextPort = await port();
  env.STACK_WEBSOCKET_ORIGIN = `http://127.0.0.1:${nextPort}`;
  next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), process.env.NEXT_MODE === "dev" ? "dev" : "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], { cwd: ui, env: { ...env, HOME: savedHome }, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout.on("data", (chunk) => { log += chunk; }); next.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${nextPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/connect/local`)).ok) break; } catch { /* bounded readiness check */ }
    if (attempt > 1800 || next.exitCode !== null) throw new Error(log);
    await wait(50);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1500 }, reducedMotion: "reduce" });
  await page.addInitScript(loseResponse);
  await authorizeBrowser(page, origin, env);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shot = (name, locator) => (locator ?? page).screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  await page.goto(`${origin}/fleet`);
  const panel = page.locator('[data-window="bot-state"]');
  const tab = (name) => panel.getByRole("radio", { name, exact: true }).or(panel.getByRole("button", { name, exact: true })).first();

  // Open alpha's state from its Bot card. Worker work blocks cleanup; the owner's links and Bot controls are offered.
  await page.locator('[data-node="bot:alpha"]').getByRole("button", { name: "State" }).click();
  const blockers = panel.getByRole("region", { name: "Cleanup blockers" });
  await blockers.getByText("Close Worker w-17 (running) before Bot maintenance").waitFor();
  await blockers.getByRole("button", { name: "Workers" }).waitFor();
  await panel.getByText("Stored state").waitFor();
  // The owner's own record of the one-time introduction is shown apart from lifecycle, whatever its outcome in this fixture.
  const initialization = panel.locator("dt", { hasText: "Initialization" }).locator("xpath=following-sibling::dd[1]");
  await initialization.waitFor();
  assert.doesNotMatch(await initialization.innerText(), /Not enrolled|retired/i, "an account-bound Bot is enrolled and has not been reset");
  await shot("bot-state-blocked", panel);

  // The Worker closes; re-reading shows nothing blocks.
  dependency.blocked = [];
  await blockers.getByRole("button", { name: "Refresh before cleanup" }).click();
  await blockers.getByText("Nothing currently blocks maintenance", { exact: false }).waitFor();

  // Workspace: markup is text, binary is metadata, symlinks are not followed, quarantine is marked.
  await tab("Workspace").click();
  const files = panel.getByRole("list", { name: "Workspace files" });
  await files.getByText("symlink · not followed").waitFor();
  await files.getByText("cleanup quarantine").waitFor();
  await files.getByRole("button", { name: "page.html" }).click();
  await panel.getByText("<script>window.__pwned = true</script>", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__pwned), undefined, "file content is never interpreted");
  await files.getByRole("button", { name: "image.bin" }).click();
  await panel.getByText("Binary content", { exact: false }).waitFor();
  await files.getByRole("button", { name: "docs/" }).click();
  await panel.getByRole("list", { name: "Workspace files" }).getByText("a.md").waitFor();
  await panel.getByRole("button", { name: "Parent directory" }).click();

  // A stale selection: the plan binds file identity, so a file changed after planning is refused and nothing is removed.
  await files.getByRole("checkbox", { name: "Select notes.txt" }).check();
  await files.getByRole("checkbox", { name: "Select docs" }).check();
  await panel.getByRole("button", { name: "Prepare clear of selected entries" }).click();
  await panel.getByText("Exact resources", { exact: false }).waitFor();
  await shot("workspace-plan", panel);
  await writeFile(join(cwd, "notes.txt"), "changed after planning\n");
  await panel.getByRole("button", { name: "Clear these files" }).click();
  await panel.getByText("Result not confirmed").waitFor();
  await panel.getByText("changed", { exact: false }).first().waitFor();
  assert.equal(await exists(join(cwd, "notes.txt")), true, "a refused stale plan removes nothing");
  await shot("workspace-stale", panel);

  // A new plan is an explicit new decision; applying it removes exactly the selection and keeps siblings.
  await panel.getByRole("button", { name: "Prepare a new plan" }).click();
  await panel.getByRole("button", { name: "Clear these files" }).click();
  await panel.getByText("Completed for the declared scope only.").waitFor();
  assert.equal(await exists(join(cwd, "notes.txt")), false);
  assert.equal(await exists(join(cwd, "docs")), false);
  assert.equal(await readFile(join(cwd, "keep.txt"), "utf8"), "sibling that must survive\n");
  assert.equal(await exists("/etc/hosts"), true);
  await shot("workspace-cleared", panel);
  await panel.getByRole("button", { name: "Close receipt" }).click();

  // Launch arguments: count and digest first; values only on an explicit reveal.
  await tab("Launch").click();
  await panel.getByText("3 arguments").waitFor();
  assert.equal(await panel.getByText("--secret-flag=hunter2").count(), 0);
  await panel.getByRole("button", { name: "Reveal values" }).click();
  await panel.getByText("--secret-flag=hunter2").waitFor();
  await shot("launch-revealed", panel);
  await panel.getByRole("button", { name: "Hide values" }).click();

  // Uploads: status and content through the owner's reads; removal discloses what stays.
  await tab("Uploads").click();
  await panel.getByRole("button", { name: uploadId }).click();
  await panel.getByText("Finalized").waitFor();
  await panel.getByRole("button", { name: "Read content" }).click();
  await panel.getByText("hello from an upload").waitFor();
  await panel.getByRole("button", { name: "Prepare upload removal" }).click();
  await panel.getByText("Upload UUID remains retired", { exact: false }).waitFor();
  await panel.getByRole("button", { name: "Remove this upload" }).click();
  await panel.getByText("Completed for the declared scope only.").waitFor();
  assert.equal(await exists(join(dir, "chat-uploads", "alpha", uploadId)), false);

  // Log clear whose apply response is lost: the flow reads the same request's receipt instead of re-sending.
  await tab("Log").click();
  await panel.getByRole("button", { name: "Prepare log clear" }).click();
  await page.evaluate(() => { window.__lose = "log_clear"; });
  await panel.getByRole("button", { name: "Clear this log" }).click();
  await panel.getByText("Completed for the declared scope only.").waitFor();
  const lost = await page.evaluate(() => window.__lost);
  assert.ok(lost, "the apply response was replaced by a transport error");
  await panel.getByText(lost).waitFor();
  assert.equal(await exists(join(dir, "logs", "alpha.log")), false);
  await shot("log-lost-response-recovered", panel);

  // Recovery: metadata only, with the consequence stated before discarding.
  await tab("Recovery").click();
  await panel.getByText("refresh-2026-09-30").waitFor();
  assert.equal(await panel.getByText('{"never":"shown"}', { exact: false }).count(), 0, "credential contents are never read");
  await panel.getByText("may be the only copy", { exact: false }).waitFor();
  await shot("recovery", panel);

  // Queue: receipts keep identity, size, digest and generation; maintenance clears bodies only, and unknown stays unknown.
  await tab("Queue").click();
  const entries = panel.getByRole("list", { name: "Queue receipts" });
  const entryRow = (id) => entries.locator("li", { hasText: id });
  await entryRow(queued.unknown).getByText("unknown", { exact: true }).waitFor();
  await entryRow(queued.sent).getByText(`generation ${firstGeneration.slice(0, 8)}`).waitFor();
  await entryRow(queued.legacy).getByText("no generation recorded").waitFor();
  assert.equal(await panel.getByRole("checkbox", { name: /Select queue entry/ }).count(), 0, "no selection controls until maintenance is opened");
  await panel.locator("summary", { hasText: "Maintenance" }).click();
  assert.equal(await panel.getByRole("checkbox", { name: `Select queue entry ${queued.pending}` }).isDisabled(), true, "a pending entry blocks body cleanup and can't be selected");
  await panel.getByRole("checkbox", { name: `Select queue entry ${queued.sent}` }).check();
  await panel.getByRole("checkbox", { name: `Select queue entry ${queued.unknown}` }).check();
  // A dependency owner reports open work: the plan is blocked and cannot apply, until a new plan after it closes.
  dependency.blocked = ["Close Worker w-17 (running) before Bot maintenance"];
  await panel.getByRole("button", { name: "Prepare clearing bodies of 2 selected" }).click();
  await panel.getByRole("region", { name: /bots plan queue_bodies_clear/ }).getByText("Close Worker w-17 (running) before Bot maintenance").waitFor();
  assert.equal(await panel.getByRole("button", { name: "Clear these bodies" }).first().isDisabled(), true, "a blocked plan cannot apply");
  await shot("queue-plan-blocked", panel);
  dependency.blocked = [];
  await panel.getByRole("button", { name: "Prepare a new plan" }).click();
  await panel.getByRole("region", { name: /bots plan queue_bodies_clear/ }).getByText(queued.unknown).waitFor();
  await shot("queue-plan-preview", panel);
  await panel.getByRole("button", { name: "Clear these bodies" }).first().click();
  await panel.getByText("Completed for the declared scope only.").waitFor();
  await entryRow(queued.unknown).getByText("Content cleared", { exact: false }).waitFor();
  await entryRow(queued.unknown).getByText("unknown", { exact: true }).waitFor();
  await entryRow(queued.sent).getByText("Content cleared", { exact: false }).waitFor();
  assert.deepEqual([queue.queued(queued.unknown).input, queue.queued(queued.unknown).state, queue.queued(queued.sent).input], [[], "unknown", []], "bodies cleared, the unknown outcome kept");
  assert.equal(queue.queued(queued.unknown).bytes > 0 && Boolean(queue.queued(queued.unknown).admissionDigest), true, "original size and digest kept");
  assert.deepEqual(queue.queued(queued.cancelled).input, [{ type: "text", text: "Cancelled secret body" }], "a sibling that was not selected keeps its body");
  assert.equal(await entries.getByRole("checkbox", { name: `Select queue entry ${queued.unknown}` }).isDisabled(), true, "a cleared body can't be selected again");
  await shot("queue-cleared", panel);
  await panel.getByRole("button", { name: "Close receipt" }).first().click();

  // An unknown receipt from an earlier session returns after a reload, in a disclosure that opens itself.
  const interrupted = await call("bot_state_plan", { botId: "alpha", action: { kind: "queue_bodies_clear", selection: { ids: [queued.cancelled] } } });
  const interruptedInput = { planId: interrupted.id, expectedRevision: interrupted.revision, requestId: crypto.randomUUID(), botId: "alpha" };
  queue.maintenance.begin(interruptedInput, interrupted);
  queue.maintenance.finish(interruptedInput.requestId, "unknown", [{ resource: queued.cancelled, outcome: "unknown", detail: "Fixture: the owner cannot say whether the body was cleared" }]);
  await page.evaluate(([key, input]) => {
    for (const name of Object.keys(localStorage)) if (!name.startsWith("stack.state-flow.")) localStorage.removeItem(name);
    localStorage.setItem(key, JSON.stringify({ input, at: Date.now() }));
  }, [`stack.state-flow.bots:${incarnation}:queue_bodies_clear:ids`, interruptedInput]);
  await page.goto(`${origin}/fleet`);
  await page.locator('[data-node="bot:alpha"]').getByRole("button", { name: "State" }).click();
  await tab("Queue").click();
  await panel.getByText("Unknown. The owner cannot say what happened.", { exact: false }).waitFor();
  await panel.getByText("Fixture: the owner cannot say whether the body was cleared").waitFor();
  assert.equal(await panel.locator("details[open]").count(), 1, "the retained receipt is never hidden behind a closed disclosure");
  assert.deepEqual(queue.queued(queued.cancelled).input, [{ type: "text", text: "Cancelled secret body" }], "an unknown receipt is never rerun");
  await shot("queue-unknown-recovered", panel);
  await panel.getByRole("button", { name: "Close receipt" }).first().click();

  // Conversation: history retention is an explicit choice, then reset retires the root and adds a generation.
  await tab("Conversation").click();
  const generations = panel.getByRole("list", { name: "History generations" });
  await generations.getByText("active", { exact: true }).waitFor();
  await panel.getByText("The Bot’s introduction is retired too, which is not a native completion, and Stack will not repeat it. The next first message starts the new main thread.", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Prepare conversation reset" }).isDisabled(), true, "no default history choice");
  await panel.getByRole("radio", { name: "Retain it as a retired generation" }).check();
  await panel.getByRole("button", { name: "Prepare conversation reset" }).click();
  await panel.getByRole("button", { name: "Reset conversation" }).click();
  await panel.getByText("Completed for the declared scope only.").waitFor();
  await generations.getByText("retired", { exact: true }).waitFor();
  await shot("conversation-reset", panel);
  // The owner retired the introduction in the same transaction, and the Bot's card data followed.
  await tab("Overview").click();
  await initialization.getByText("Orientation retired", { exact: false }).waitFor();
  await initialization.getByText("The conversation was reset. This is not a native completion, and the introduction will not repeat.", { exact: true }).waitFor();
  await shot("bot-state-orientation-retired", panel);
  await tab("Conversation").click();
  await panel.getByRole("button", { name: "Purge this retired history…" }).click();
  await panel.getByRole("button", { name: "Prepare purge of this generation" }).click();
  await panel.getByRole("button", { name: "Purge this history" }).click();
  await generations.getByText("History bytes are gone", { exact: false }).waitFor();

  // A retired generation: its entries clear together; entries recorded without a generation are not guessed.
  await tab("Queue").click();
  await panel.locator("summary", { hasText: "Maintenance" }).click().catch(() => undefined);
  const retired = panel.getByRole("combobox", { name: "Retired generation" });
  await retired.selectOption({ value: firstGeneration });
  await panel.getByRole("button", { name: "Prepare clearing this generation's bodies" }).click();
  const generationPlan = panel.getByRole("region", { name: /bots plan queue_bodies_clear/ });
  await generationPlan.getByText(queued.pending).waitFor();
  assert.equal(await generationPlan.getByText(queued.legacy).count(), 0, "an entry without a recorded generation isn't selected");
  await shot("queue-generation-plan", panel);
  await panel.getByRole("button", { name: "Clear these bodies" }).last().click();
  await panel.getByText("Completed for the declared scope only.").waitFor();
  assert.deepEqual(queue.queued(queued.pending).input, [], "the generation's cancelled entry body is cleared");
  assert.equal(queue.queued(queued.pending).state, "cancelled", "reset had already cancelled it; clearing keeps that outcome");
  assert.deepEqual(queue.queued(queued.legacy).input, [{ type: "text", text: "Unattributed legacy body" }], "the unattributed entry keeps its body");
  await shot("queue-generation-cleared", panel);
  await panel.getByRole("button", { name: "Close receipt" }).last().click();

  // A durable start fence left by an unresolved cleanup: inspect, then release explicitly.
  const fenced = crypto.randomUUID();
  const fence = new StateStore(dir);
  fence.fenceMaintenance("alpha", fenced);
  fence.close();
  await tab("Overview").click();
  await panel.getByRole("button", { name: "Refresh before cleanup" }).click();
  const fenceView = panel.getByRole("region", { name: "Maintenance fence" });
  await fenceView.getByText(`The owner has no receipt for request ${fenced}.`).waitFor();
  await shot("fence", panel);
  await fenceView.getByRole("button", { name: "Release start fence…" }).click();
  await page.getByRole("alertdialog").getByText("Nothing is cleaned up or retried", { exact: false }).waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "Release fence" }).click();
  await fenceView.waitFor({ state: "detached" });

  // External workspace: readable, never clearable.
  await panel.getByRole("combobox", { name: "Bot" }).selectOption("ext");
  await tab("Workspace").click();
  await panel.getByRole("list", { name: "Workspace files" }).getByText("outside.txt").waitFor();
  await panel.getByText("Stack has no authority to delete its contents", { exact: false }).waitFor();
  assert.equal(await panel.getByRole("button", { name: /Prepare .*clear/ }).count(), 0);
  await tab("Overview").click();
  await panel.getByText("Stop and verify the Bot before cleanup").waitFor();
  await shot("external-running", panel);

  // Bot ID reuse: a new incarnation shows nothing of the old one.
  await panel.getByRole("combobox", { name: "Bot" }).selectOption("alpha");
  const before = await panel.getByText(/^[0-9a-f-]{36}$/).first().textContent();
  await call("bot_remove", { id: "alpha" });
  await call("bot_start", { id: "alpha", account });
  await call("bot_stop", { id: "alpha" });
  await page.locator('[data-node="bot:alpha"]').getByRole("button", { name: "State" }).click();
  await panel.getByText("Incarnation").waitFor();
  await page.waitForFunction((old) => !document.querySelector('[data-window="bot-state"]')?.textContent?.includes(old), before);
  await tab("Conversation").click();
  assert.equal(await panel.getByRole("list", { name: "History generations" }).getByText("retired", { exact: true }).count(), 0, "the old incarnation's generations are gone");
  await tab("Log").click();
  assert.equal(await panel.getByText("Completed for the declared scope only.").count(), 0, "no old receipt is recovered");

  await page.emulateMedia({ colorScheme: "dark" });
  await tab("Overview").click();
  await shot("bot-state-dark", panel);
  assert.deepEqual(errors, [], "browser has no uncaught application errors");
  console.log(JSON.stringify({ ok: true, evidence, assertions: "queue receipts with digest/generation and no selection controls until maintenance opens, pending entry unselectable, blocked queue plan cannot apply, exact-ID body clear keeping size/digest/unknown outcome and an unselected sibling, unknown receipt recovered after reload in a self-opening disclosure and never rerun, retired-generation clear leaving an unattributed entry alone; dependency-blocked then clear, markup shown as text, binary metadata, symlink not followed, quarantine marked, stale file revision refused with nothing removed, explicit replan then exact clear with sibling kept, launch values only on reveal, upload read and removal, lost apply response recovered from the same request's receipt, recovery metadata only, explicit history choice, reset retain then retired purge, start fence inspected and released, external workspace read-only, running Bot blocked, Bot ID reuse shows a clean incarnation, dark" }, null, 2));
} catch (error) {
  failed = true;
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" }).catch(() => undefined);
  if (log) console.error(log.slice(-3000));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) { next.kill("SIGTERM"); await new Promise((resolve) => next.once("exit", resolve)); }
  await websocket?.close();
  await Promise.all(sockets.map((socket) => socket.close()));
  queue?.close();
  await bots?.close();
  await auth?.close();
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (!(failed && evidence.startsWith(dir))) await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(external, { recursive: true, force: true });
}
