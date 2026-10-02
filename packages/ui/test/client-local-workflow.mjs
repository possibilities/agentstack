// Browser/operator boundary proof. Real Client owner, installer and revisioned
// ledger; only the external service manager and release transport are fixtures.
// No launchd/systemd registration, live Stack, GUI or binary-file inspection.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { serveSocket, socketCall } from "@stack/api";
import { clientInputs, clientOutputs, bundleSchema } from "@stack/client/contract";
import { startClientUi } from "../bin/launcher.mjs";
import { z } from "./browser-fixture.mjs";

const { ClientState } = await import(new URL("./state.js", import.meta.resolve("@stack/client")));
const { PlatformService } = await import(new URL("./service.js", import.meta.resolve("@stack/client")));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(call, label) {
  for (let n = 0; n < 160; n++) { if (await call()) return; await delay(50); }
  throw new Error(`workflow_timeout_${label}`);
}
const exists = file => access(file).then(() => true, () => false);
// The recorded stage a job is at (or last reached) is the current step of its sequence.
const currentStage = (scope, label) => scope.locator('li[aria-current="step"]').getByText(label, { exact: true });

/** Full-page capture paints fixed elements at the scroll offset and tiles a still-growing page; settle first. */
export async function settleForCapture(page) {
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForFunction(() => new Promise(resolve => { const height = document.documentElement.scrollHeight; setTimeout(() => resolve(document.documentElement.scrollHeight === height), 150); }));
}

/** Evidence only: one full-page capture per appearance, then the prior viewport and media. */
export async function captureVariants(page, evidence, name) {
  if (!evidence) return;
  const viewport = page.viewportSize();
  for (const [variant, colorScheme, width] of [["light", "light", 1200], ["dark", "dark", 1200], ["narrow", "light", 390]]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" }); await page.setViewportSize({ width, height: 900 });
    await settleForCapture(page);
    await page.screenshot({ path: join(evidence, `${name}-${variant}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null, reducedMotion: null }); await page.setViewportSize(viewport);
}

export async function checkNoTrustedRelease(page, client, pass, evidence) {
  await page.goto(`${client.origin}/client/local`);
  await page.getByRole("heading", { name: "Run locally", exact: true }).waitFor();
  await page.getByText("No trusted release configured for this Client", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Install reviewed release" }).count(), 0);
  assert.ok((await page.content()).includes("stack-ui --release-manifest /absolute/reviewed-release.json"));
  const before = (await client.host.call("client_snapshot", {})).jobs;
  const result = await page.evaluate(async release => {
    const response = await fetch("/api/client/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "client_install", input: { requestId: crypto.randomUUID(), release } }) });
    return { status: response.status, body: await response.json() };
  }, { version: "untrusted", platform: process.platform, architecture: process.arch, url: "https://untrusted.example/bundle.tgz", sha256: "a".repeat(64), bytes: 1, unpackedBytes: 1 });
  assert.equal(result.status, 502); assert.equal(result.body.error, "trusted_release_required"); assert.equal(result.body.uncertain, false);
  assert.deepEqual((await client.host.call("client_snapshot", {})).jobs, before);
  await captureVariants(page, evidence, "local-no-trusted-release");
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await page.getByRole("heading", { name: "Connections", exact: true }).waitFor();
  pass("no trusted release explains exact launcher flag and HTTP cannot install a browser descriptor");
}

export async function checkLocalWorkflow({ browser, base, evidence, pass, checkHeader }) {
  const root = join(base, "l"), fixtures = join(base, "f"), commands = join(fixtures, "bin");
  await mkdir(commands, { recursive: true });
  const managerFile = join(fixtures, "manager.json"), managerLog = join(fixtures, "manager.log");
  // This PATH adapter exercises the real owner's definition hashes and lifecycle
  // without calling a real service manager, even with a disposable HOME.
  const adapter = `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2), file=${JSON.stringify(managerFile)}, log=${JSON.stringify(managerLog)};
let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{registered:false,running:false,path:null};
fs.appendFileSync(log,JSON.stringify(args)+'\\n');
const command=args[0];
if(command==='print'){if(!state.registered)process.exit(113);console.log('state = '+(state.running?'running':'waiting'));console.log('path = '+state.path);}
else if(command==='bootstrap'){const text=fs.readFileSync(args[2],'utf8');state={registered:true,running:text.includes('<key>RunAtLoad</key><true/>'),path:args[2]};}
else if(command==='kickstart')state.running=true;
else if(command==='bootout')state={...state,registered:false,running:false};
else throw new Error('unexpected_fake_service_command');
fs.writeFileSync(file,JSON.stringify(state));\n`;
  // The local release matrix's macOS target is used on this dispatch machine.
  assert.equal(process.platform, "darwin", "this isolated adapter qualifies macOS only, not Debian");
  await writeFile(join(commands, "launchctl"), adapter, { mode: 0o700 });
  await writeFile(join(commands, "gh"), `#!/bin/sh\n[ -e '${join(fixtures, "fail-gh")}' ] && exit 1\necho 'gh fixture executable'\n`, { mode: 0o700 });
  const oldPath = process.env.PATH, originalFetch = globalThis.fetch;
  process.env.PATH = `${commands}:${oldPath}`;
  let client, ready, platformHttp, context;
  let releaseDownload;
  const downloadGate = new Promise(resolve => { releaseDownload = resolve; });
  let downloads = 0;
  try {
    const source = join(fixtures, "bundle");
    await mkdir(join(source, "bin"), { recursive: true }); await mkdir(join(source, "runtime"));
    const manifest = bundleSchema.parse({ version: "ui-fixture-1", platform: process.platform, architecture: process.arch,
      codexnk: { tag: "codexnk-v0.1.7", sha: "3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c" } });
    await writeFile(join(source, "stack-release.json"), JSON.stringify(manifest));
    await writeFile(join(source, "bin", "stack"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(source, "runtime", "codexnk-install.py"), `import os,pathlib,sys,time\nassert sys.argv[1:]==['--install','--tag','codexnk-v0.1.7','--sha','3aae20d1ad1d41734b7303b4f0a4bfe95eb56d8c']\np=pathlib.Path(${JSON.stringify(join(fixtures, "runtime-entered"))})\np.write_text('entered')\nwhile not pathlib.Path(${JSON.stringify(join(fixtures, "runtime-continue"))}).exists(): time.sleep(.05)\np=pathlib.Path.home()/'.local/libexec/codexnk/codex'\np.parent.mkdir(parents=True,exist_ok=True)\np.write_text('#!/bin/sh\\nexit 0\\n')\np.chmod(0o700)\n`);
    const tar = createRequire(import.meta.resolve("@stack/client"))("tar");
    const chunks = [];
    for await (const chunk of tar.c({ gzip: true, cwd: source }, ["bin", "runtime", "stack-release.json"])) chunks.push(chunk);
    const bytes = Buffer.concat(chunks); // Generated in memory; no binary file is read or printed.
    const release = { version: manifest.version, platform: manifest.platform, architecture: manifest.architecture,
      url: "https://release.example/ui-fixture.tgz", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, unpackedBytes: 1_000_000 };
    const releaseFile = join(fixtures, "release.json"); await writeFile(releaseFile, JSON.stringify(release));
    const invalidFile = join(fixtures, "invalid.json"); await writeFile(invalidFile, JSON.stringify({ ...release, instructions: "untrusted" }));
    await assert.rejects(startClientUi({ root: join(base, "bad"), port: 0, releaseManifest: invalidFile, open: false }), /client_release_manifest_invalid/);
    assert.equal(await exists(join(base, "bad", "client.sock")), false);
    globalThis.fetch = async (url, init) => {
      if (String(url) !== release.url) return originalFetch(url, init);
      downloads++;
      return new Response(new ReadableStream({ async start(controller) { controller.enqueue(bytes); await downloadGate; controller.close(); } }));
    };
    client = await startClientUi({ root, port: 0, releaseManifest: releaseFile, open: false });
    // Parent value is pinned once, not reread from a mutable manifest per request.
    await writeFile(releaseFile, JSON.stringify({ ...release, version: "changed-on-disk" }));
    context = await browser.newContext(); const page = await context.newPage();
    const errors = []; page.on("pageerror", () => errors.push("pageerror"));
    await page.addInitScript(() => {
      window.clientCspViolations = [];
      document.addEventListener("securitypolicyviolation", event => window.clientCspViolations.push(event.violatedDirective));
    });
    const bootstrap = await client.host.call("client_ui_connect", {}); await page.goto(bootstrap.url); await page.waitForURL(`${client.origin}/client`);
    await page.getByRole("link", { name: "Run locally", exact: true }).click();
    await page.getByText("Trusted launcher release:", { exact: false }).waitFor();
    const key = `stack.client.stack_client_ui_${createHash("sha256").update(client.root).digest("hex").slice(0, 24)}.local-request.v1`;
    const calls = []; page.on("request", request => {
      if (request.url().endsWith("/api/client/rpc") && request.postData()) calls.push(JSON.parse(request.postData()));
    });
    const actionCalls = () => calls.filter(call => ["client_install", "client_platform_start", "client_platform_stop", "client_login_set"].includes(call.operation));
    const foreignKey = "stack.client.foreign-root.local-request.v1";
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, operation: "client_platform_start", input: { requestId: crypto.randomUUID() } })), foreignKey);
    await page.reload(); await page.getByText("Trusted launcher release:", { exact: false }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Saved exact request" }).count(), 0);
    assert.equal((await client.host.call("client_snapshot", {})).jobs.length, 0);
    assert.ok(await page.evaluate(key => localStorage.getItem(key), foreignKey), "foreign-root recovery is retained, not migrated or removed");
    const changed = await page.evaluate(async release => {
      const response = await fetch("/api/client/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "client_install_plan", input: { release: { ...release, version: "browser-selected" } } }) });
      return await response.json();
    }, release);
    assert.equal(changed.error, "trusted_release_changed");
    if (evidence) await page.getByText("No local platform installed.", { exact: true }).waitFor();
    await captureVariants(page, evidence, "local-not-installed");
    pass("reviewed release schema, immutable parent pin and browser release substitution refusal");

    await writeFile(join(fixtures, "fail-gh"), "missing");
    await page.getByRole("button", { name: "Check prerequisites" }).click();
    await page.getByText("gh: missing executable", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Review install plan" }).isDisabled(), true);
    await captureVariants(page, evidence, "local-prerequisite-missing");
    await rm(join(fixtures, "fail-gh"));
    await page.getByRole("button", { name: "Check prerequisites" }).click();
    await page.getByText("gh: executable available", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Review install plan" }).click();
    await page.getByRole("heading", { name: "Reviewed install plan" }).waitFor();
    assert.equal(downloads, 0); assert.equal((await client.host.call("client_snapshot", {})).installation, null);
    pass("failed executable prerequisite blocks install; reviewing truthful effects admits no install or startup");

    // A browser quota failure must stop BEFORE the HTTP admission boundary.
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("fixture quota", "QuotaExceededError"); }; });
    await page.getByRole("button", { name: "Install reviewed release" }).click();
    await page.getByText("Could not persist the exact request.", { exact: false }).waitFor();
    assert.equal(actionCalls().length, 0);
    await page.reload(); await page.getByRole("button", { name: "Check prerequisites" }).click();
    await page.getByText("gh: executable available", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Review install plan" }).click();
    let lost;
    await page.route("**/api/client/rpc", async route => {
      const body = route.request().postDataJSON();
      if (body.operation === "client_install" && !lost) { lost = body; await route.abort("failed"); } else await route.continue();
    });
    await page.getByRole("button", { name: "Install reviewed release" }).click();
    await page.getByText("Admission unresolved.", { exact: false }).first().waitFor();
    const persisted = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert.deepEqual(persisted.input, lost.input); assert.deepEqual(persisted.input.release, release);
    const beforeReload = actionCalls().length; await page.reload();
    await page.getByRole("heading", { name: "Saved exact request" }).waitFor();
    assert.equal(actionCalls().length, beforeReload, "reload does not dispatch");
    assert.equal(await page.getByRole("button", { name: "Retry identical request" }).isDisabled(), true);
    await captureVariants(page, evidence, "local-admission-unresolved");
    await page.getByRole("button", { name: "Inspect job and snapshot" }).click();
    await page.getByRole("button", { name: "Retry identical request" }).click();
    const savedRequest = page.getByRole("region", { name: "Saved exact request" });
    await currentStage(savedRequest, "Downloading").waitFor();
    const installs = actionCalls().filter(call => call.operation === "client_install");
    assert.deepEqual(installs[1], installs[0]); assert.equal(downloads, 1);
    await captureVariants(page, evidence, "local-install-downloading");
    await page.unroute("**/api/client/rpc");
    pass("storage failure blocks dispatch; lost admission survives reload and only explicit identical UUID/input retry installs");
    releaseDownload();
    await until(() => exists(join(fixtures, "runtime-entered")), "runtime");
    await currentStage(savedRequest, "Installing shared codexnk runtime").waitFor();
    await writeFile(join(fixtures, "runtime-continue"), "continue");
    await until(async () => (await client.host.call("client_job_get", { id: persisted.input.requestId })).state === "completed", "install");
    await page.getByText("Installed release ui-fixture-1", { exact: true }).waitFor();
    assert.equal((await client.host.call("client_snapshot", {})).service.running, false);
    assert.equal((await client.host.call("client_snapshot", {})).service.login.saved, false);
    await page.getByRole("button", { name: "Inspect job and snapshot" }).click();
    await page.getByRole("button", { name: "Acknowledge inspected outcome" }).click();
    pass("real fixture-bundle install shows downloading/runtime/terminal stages, retains data and never starts or changes login");

    // Owner-ledger rendering fixtures cover the brief transitional stages and
    // interrupted job, without claiming those native effects ran.
    const owner = new ClientState(root);
    const unknown = randomUUID(); owner.admit(unknown, "client_platform_start", { requestId: unknown }); owner.progress(unknown, "interrupted", "unknown", "host_interrupted");
    const renderedStages = [];
    for (const stage of ["admitted", "extracting", "selecting"]) {
      const id = randomUUID(); owner.admit(id, "client_install", { requestId: id, release }); owner.progress(id, stage, "unknown", "fixture_display_only"); renderedStages.push({ id, stage });
    }
    owner.close();
    await page.evaluate(({ key, unknown }) => localStorage.setItem(key, JSON.stringify({ version: 1, operation: "client_platform_start", input: { requestId: unknown } })), { key, unknown });
    const beforeUnknown = actionCalls().length; await page.reload();
    await savedRequest.getByText("Outcome unknown", { exact: true }).waitFor();
    await captureVariants(page, evidence, "local-unknown-recovery");
    assert.equal(actionCalls().length, beforeUnknown); assert.equal(await page.getByRole("button", { name: "Retry identical request" }).count(), 0);
    for (const item of renderedStages) {
      await page.getByRole("button", { name: `Install · unknown · ${item.id.slice(0, 8)}`, exact: true }).click();
      await currentStage(page.getByRole("region", { name: "Recent local jobs" }), { admitted: "Admitted", extracting: "Extracting", selecting: "Selecting installed release" }[item.stage]).waitFor();
    }
    await page.getByRole("button", { name: "Inspect job and snapshot" }).click();
    await page.getByRole("button", { name: "Acknowledge inspected outcome" }).click();
    pass("unknown jobs reload read-only with no dispatch; exact job inspector renders admitted/extracting/selecting stages");

    const acknowledge = async () => {
      await page.getByRole("button", { name: "Inspect job and snapshot" }).click();
      await page.getByRole("button", { name: "Acknowledge inspected outcome" }).click();
      await until(async () => ["Start platform", "Stop platform", "Open platform"].includes(await page.evaluate(() => document.activeElement.textContent)), "focus_restored");
    };
    const persistedActions = [];
    let droppedStart;
    const serviceRecoveryHandler = async route => {
      const body = route.request().postDataJSON();
      if (["client_platform_start", "client_platform_stop", "client_login_set"].includes(body.operation)) {
        const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
        assert.deepEqual(saved.input, body.input); assert.equal(saved.operation, body.operation);
        persistedActions.push(body.operation);
      }
      if (body.operation === "client_platform_start" && !droppedStart) {
        const admitted = await route.fetch(); assert.equal(admitted.status(), 200);
        droppedStart = (await admitted.json()).output.job.id; await route.abort("failed");
      } else await route.continue();
    };
    await page.route("**/api/client/rpc", serviceRecoveryHandler);
    await page.clock.install();
    await page.getByRole("button", { name: "Start platform", exact: true }).click();
    await until(async () => (await client.host.call("client_snapshot", {})).service.running, "start");
    assert.equal((await client.host.call("client_snapshot", {})).service.ready, false);
    await page.getByText("Observing unresolved service state", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Open platform", exact: true }).count(), 0);
    await captureVariants(page, evidence, "local-starting");
    await page.clock.runFor(31_000);
    await page.getByText("Bounded observation ended", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Inspect job and snapshot" }).click();
    await until(() => page.getByRole("button", { name: "Acknowledge inspected outcome" }).isEnabled(), "acknowledge_unready");
    assert.equal(await page.getByRole("button", { name: "Retry identical request" }).count(), 0, "lost admitted response is resolved by exact job inspection, not replay");
    assert.equal(actionCalls().filter(call => call.operation === "client_platform_start").length, 1);
    assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).input.requestId, droppedStart);
    platformHttp = createServer((_request, response) => { response.end("Disposable platform navigation fixture"); });
    await new Promise(resolve => platformHttp.listen(0, "127.0.0.1", resolve));
    const platformOrigin = `http://127.0.0.1:${platformHttp.address().port}`;
    const readyPath = join(root, "platform", "state", "sockets", "serve.sock"); await mkdir(join(readyPath, ".."), { recursive: true });
    let openCount = 0;
    const startReady = () => serveSocket({ info: { name: "serve", description: "Readiness fixture", transportDescription: "Fixture", path: readyPath }, context: {}, operations: [
      { name: "serve_status", description: "Observed fixture readiness", input: clientInputs.client_snapshot, output: z.unknown(), call: async () => ({ pid: process.pid, uiUrl: platformOrigin }) },
      { name: "serve_local_connect", description: "Fixture handoff", input: z.strictObject({ target: z.literal("ui") }), output: clientOutputs.client_local_open, call: async () => { openCount++; return { url: `${platformOrigin}/connect/local#disposable-${randomUUID()}`, expiresInSeconds: 60 }; } },
    ] });
    ready = await startReady();
    await page.getByRole("button", { name: "Inspect job and snapshot" }).click();
    await page.getByText("Ready means a serve_status answer was observed", { exact: false }).waitFor();
    await acknowledge();
    await captureVariants(page, evidence, "local-ready");
    const popupPromise = page.waitForEvent("popup"); await page.getByRole("button", { name: "Open platform", exact: true }).click();
    const popup = await popupPromise; await popup.waitForURL(`${platformOrigin}/connect/local#*`); await popup.close();
    assert.equal(openCount, 1);
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes("#disposable-"));
    const lostOpenHandler = async route => { if (route.request().postDataJSON().operation === "client_local_open") { await route.fetch(); await route.abort("failed"); } else await route.fallback(); };
    await page.route("**/api/client/rpc", lostOpenHandler);
    const uncertainPopup = page.waitForEvent("popup"); await page.getByRole("button", { name: "Open platform", exact: true }).click(); await uncertainPopup;
    await page.getByRole("button", { name: "Open again deliberately", exact: true }).waitFor();
    await page.unroute("**/api/client/rpc", lostOpenHandler);
    const newPopup = page.waitForEvent("popup"); await page.getByRole("button", { name: "Open again deliberately", exact: true }).click(); await (await newPopup).close();
    assert.equal(openCount, 3);
    pass("Start completion is not readiness; polling stops at its bound without replay and exact inspection recovers lost admitted response; Open never stores URLs and uncertainty needs fresh deliberate action");

    await page.getByRole("button", { name: "Enable platform login" }).click();
    await page.getByText("Saved: on · Applied: off · Application pending", { exact: true }).waitFor();
    await captureVariants(page, evidence, "local-login-pending");
    assert.equal((await client.host.call("client_snapshot", {})).service.running, true); await acknowledge();
    await page.getByText("Edit ports and Access/TLS", { exact: true }).click();
    for (const label of ["Local UI", "WebSocket", "MCP", "Inspector", "Documents", "Artifacts", "Brain"]) assert.equal(await page.getByLabel(`${label} port`, { exact: true }).inputValue(), "");
    await page.getByLabel("Local UI port", { exact: true }).fill("19031");
    let conflicted = false;
    const conflictHandler = async route => {
      if (route.request().postDataJSON().operation === "client_platform_configure" && !conflicted) { conflicted = true; await client.host.call("client_platform_configure", { expectedRevision: 0, configuration: { ports: { brain: 19032 } } }); }
      await route.fallback();
    };
    await page.route("**/api/client/rpc", conflictHandler);
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await page.getByText("Configuration revision conflict.", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("Local UI port", { exact: true }).inputValue(), "19031");
    await page.unroute("**/api/client/rpc", conflictHandler);
    await page.getByText("Saved revision 1", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Load observed configuration" }).click();
    await page.getByLabel("Brain port", { exact: true }).fill(""); await page.getByLabel("Local UI port", { exact: true }).fill("19031");
    await page.getByRole("switch", { name: "Configure direct-tailnet Access" }).click();
    const access = { host: "100.80.0.1", deviceOrigin: "https://fixture.tail.example:8943", artifactPort: 8944, uiOrigin: "https://fixture.tail.example:8945", tlsCert: "/operator/cert.pem", tlsKey: "/operator/key.pem" };
    for (const [name, value] of Object.entries({ "Direct Tailscale IP": access.host, "Device HTTPS origin": access.deviceOrigin, "Access artifact port": access.artifactPort, "UI HTTPS origin": access.uiOrigin, "TLS certificate path": access.tlsCert, "TLS key path": access.tlsKey })) await page.getByLabel(name, { exact: true }).fill(String(value));
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await page.getByText("Saved configuration revision 2.", { exact: false }).waitFor();
    assert.deepEqual((await client.host.call("client_snapshot", {})).configuration.saved, { ports: { ui: 19031 }, access });
    assert.equal((await client.host.call("client_snapshot", {})).configuration.pending, true);
    assert.equal((await client.host.call("client_snapshot", {})).service.running, true);
    pass("login stays saved-on/applied-off without restart; configuration preserves omission, retains revision-conflicted input and saves explicit operator-provisioned Access/TLS for next start");

    await page.getByRole("button", { name: "Stop platform", exact: true }).click();
    await until(async () => !(await client.host.call("client_snapshot", {})).service.running, "stop");
    await ready.close(); ready = null;
    await page.getByText("Installed, stopped", { exact: true }).waitFor(); await acknowledge();
    await page.getByRole("button", { name: "Start platform", exact: true }).click();
    await until(async () => (await client.host.call("client_snapshot", {})).service.running, "restart");
    ready = await startReady(); await page.getByText("Saved: on · Applied: on · No pending login change", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Inspect job and snapshot" }).click();
    await page.getByText("No pending configuration", { exact: false }).waitFor();
    await acknowledge();
    assert.equal((await client.host.call("client_snapshot", {})).configuration.pending, false);
    assert.deepEqual(persistedActions, ["client_platform_start", "client_login_set", "client_platform_stop", "client_platform_start"]);
    pass("explicit Stop then Start applies pending login/configuration; no configuration or login action starts the service");

    const layouts = [];
    for (const [label, colorScheme, width] of [["light", "light", 1200], ["dark", "dark", 1200], ["narrow", "light", 390]]) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" }); await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => scrollTo(0, 0));
      await checkHeader(page); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "local form reflows without overflow");
      layouts.push({ colorScheme, width, overflow: false, headerOcclusion: false });
      if (evidence) { await settleForCapture(page); await page.screenshot({ path: join(evidence, `local-${label}.png`), fullPage: true }); }
    }
    await page.reload(); await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.textContent), "Skip to local platform");
    await page.keyboard.press("Enter");
    assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.clientCspViolations), []);
    const last = await client.host.call("client_snapshot", {});
    await client.close(); client = null;
    assert.equal(JSON.parse(await readFile(managerFile, "utf8")).running, true);
    assert.equal((await socketCall(readyPath, "tools/call", { name: "serve_status", arguments: {} })).pid, process.pid);
    const retained = new ClientState(root);
    try { assert.deepEqual(retained.jobs().map(job => ({ ...job })), last.jobs); await new PlatformService(retained).stop(); } finally { retained.close(); }
    assert.equal(JSON.parse(await readFile(managerFile, "utf8")).running, false);
    if (evidence) await writeFile(join(evidence, "local-render-check.json"), JSON.stringify({ pageErrors: errors, cspViolations: [], layouts, keyboardSkipLink: true, downloads, root, serviceAdapter: "fake PATH launchctl; no native registration", afterCloseRunning: true }, null, 2));
    pass("light/dark/narrow local workflow, keyboard and CSP pass; closing Client leaves independently owned service/socket running and admits no jobs");
  } finally {
    releaseDownload(); await writeFile(join(fixtures, "runtime-continue"), "cleanup");
    await context?.close(); await client?.close(); await ready?.close();
    if (platformHttp) await new Promise(resolve => platformHttp.close(resolve));
    globalThis.fetch = originalFetch;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
}
