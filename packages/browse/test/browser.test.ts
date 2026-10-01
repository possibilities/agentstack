import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WebSocketServer } from "ws";
import { BrowserSystem } from "../src/system.js";
import { researchFirewall } from "../src/research-egress.js";
import { Backend, backendSession } from "../src/backend.js";
import { handleProvider } from "../src/provider.js";
import { prepareBrowserConfig } from "../src/config.js";
import { Profiles } from "../src/profiles.js";
import { BrowseState } from "../src/state.js";
import type { ManagedGate } from "../src/gate.js";
const fakeGate = (cdp: string, neko: string): ManagedGate => ({
  cdpUrl: cdp, observationUrl: neko, async start() {}, async close() {}, hold() {}, async drain() {}, resume() {}, unknownDrain() {},
  async grantHuman() { return neko + "/human"; }, async revokeHuman() {},
});
import { botMcpUrl, botInstance, installationControlRoot, invocationContext, McpEventSubscriptions, serveSocket, socketCall, socketPath, operation, type EventValue, type InvocationContext, type StatePlan } from "@stack/api";
import { api, browserHandoffRequest, browserHandoffCompletion, browserProfileList, browserProfileCreate, browserProfileDelete, browserControllerList, browserControllerSelect } from "../api.js";
import type { Handoff } from "../src/handoff.js";

type Item = Record<string, unknown>;
const applyState = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });

test("factory callback pins the parent's Browser scope, removes only recorded incarnations without provisioning and never repeats partial provider effects", async () => {
  for (const failVolumeDelete of [false, true]) {
    const options = { failVolumeDelete: false }, s = await fixture(options), backend = new Backend(s.system, async () => undefined);
    const profiles = new Profiles(backend, s.system, s.env, async () => [], fakeGate), state = new BrowseState(profiles, backend, s.env, s.system.root);
    const control = installationControlRoot(s.env);
    try {
      await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root);
      const launched = await backend.launch("factory-selected", true);
      const selectedVolume = String(s.volumes()[0]!.id);
      s.instances().push({ id: "foreign-instance", name: "foreign", volumes: [{ volume_id: selectedVolume }] });
      assert.ok((await backend.factoryResetSnapshot()).blockedBy.some(text => text.includes("foreign/unselected")));
      (s.instances().at(-1)!.volumes as unknown[]) = [];
      s.volumes().push({ id: "foreign-volume", name: "foreign", tags: {} });
      const snapshot = await backend.factoryResetSnapshot();
      assert.deepEqual(snapshot.blockedBy, []);
      assert.equal(snapshot.resources.length, 2);
      const callback = api.operations.find(op => op.name === "browser_factory_reset_clear")!;
      await assert.rejects(callback.call({ backend, profiles, system: s.system, state }, { requestId: randomUUID(), snapshot }), /No exact admitted/);
      const probe = await backend.launch("factory-unblocked", false);
      await backend.close(probe.cleanup); // Invalid callback must not drain the Browser owner.
      const requestId = randomUUID(); await mkdir(control, { mode: 0o700 });
      await writeFile(join(control, "fence.json"), JSON.stringify({ version: 1, requestId, generation: randomUUID(), nextGeneration: randomUUID(), pid: process.pid, browserRevision: snapshot.revision }), { mode: 0o600 });
      await assert.rejects(state.factoryReset(requestId, { ...snapshot, resources: [] }), /scope/);
      options.failVolumeDelete = failVolumeDelete;
      const receipt = await state.factoryReset(requestId, snapshot);
      assert.equal(receipt.status, failVolumeDelete ? "partial" : "completed");
      assert.equal(s.instances().some(row => row.id === "foreign-instance"), true);
      assert.equal(s.volumes().some(row => row.id === "foreign-volume"), true);
      assert.equal(s.instances().some(row => row.name === launched.cleanup.browserTarget), false);
      assert.equal(s.volumes().some(row => row.id === selectedVolume), failVolumeDelete);
      const counts = s.counts(); options.failVolumeDelete = false;
      assert.deepEqual(await state.factoryReset(requestId, snapshot), receipt);
      assert.deepEqual(s.counts(), counts, "same UUID cannot retry an uncertain provider effect or reprovision");
      assert.ok(receipt.outcomes.some(row => row.resource === selectedVolume && row.outcome === (failVolumeDelete ? "unknown" : "removed")));
    } finally { state.journal.close(); await backend.closeContext(); await s.close(); await rm(control, { recursive: true, force: true }); }
  }
});

test("profile reset preserves default assignment/generation and siblings, exact provider plans refuse races and partial/restart effects stay fenced", async () => {
  const options = { failInstanceCreate: false }, s = await fixture(options), backend = new Backend(s.system, async () => undefined);
  const bot = { id: "reset-bot", url: null as string | null, state: "stopped", recoveryIssue: null };
  const profiles = new Profiles(backend, s.system, s.env, async () => [bot], fakeGate), state = new BrowseState(profiles, backend, s.env, s.system.root), ctx = { backend, system: s.system, profiles, state };
  let journalClosed = false;
  const browser = await serveSocket({ info: { name: "browse", description: "Fixture", transportDescription: "Socket", path: socketPath("browse", s.env) }, context: ctx, operations: api.operations });
  const bots = await serveSocket({ info: { name: "bots", description: "Fixture", transportDescription: "Socket", path: socketPath("bots", s.env) }, context: {}, operations: [operation({
    name: "bot_state_browser_guard", description: "Stopped Bot callback transport fixture; real mutex proof belongs to Bots tests", input: z.strictObject({ botId: z.string(), profileId: z.uuid(), token: z.uuid() }), output: z.record(z.string(), z.unknown()),
    async call(_ctx, input) { if (bot.state !== "stopped") throw new Error("Stop Bot before maintenance"); return await socketCall(browser.path, "tools/call", { name: "browse_state_bot_effect", arguments: input }) as Record<string, unknown>; },
  })] });
  const call = async (name: string, args: unknown): Promise<any> => socketCall(browser.path, "tools/call", { name, arguments: args });
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false);
    const selected = await profiles.create(bot.id, "Default", true), sibling = await profiles.create(null, "Retained sibling");
    await profiles.ensure(selected.id); await profiles.ensure(sibling.id);
    const old = await backend.stateProfile(`profile:${selected.id}`), siblingNative = await backend.stateProfile(`profile:${sibling.id}`);
    const stale = await call("browser_profile_reset_plan", { profileId: selected.id });
    s.volumes()[0]!.size = "changed-after-plan";
    await assert.rejects(call("browser_profile_reset_clear", applyState(stale)), /changed/);
    const volumeName = s.volumes()[0]!.name; s.volumes()[0]!.name = "renamed-externally";
    const renamed = await call("browser_profile_reset_plan", { profileId: selected.id });
    assert.ok(renamed.blockedBy.some((text: string) => text.includes("name/identity")));
    await assert.rejects(call("browser_profile_reset_clear", applyState(renamed)), /name\/identity/);
    s.volumes()[0]!.name = volumeName;
    bot.state = "running"; bot.url = "unix:///not-started";
    assert.ok((await call("browser_profile_reset_plan", { profileId: selected.id })).blockedBy.some((text: string) => text.includes("Stop")));
    bot.state = "stopped"; bot.url = null;
    let notices = 0; profiles.onChange = () => notices++;
    const input = applyState(await call("browser_profile_reset_plan", { profileId: selected.id }));
    const receipt = await call("browser_profile_reset_clear", input); assert.equal(receipt.status, "completed"); assert.deepEqual(await call("browser_profile_reset_clear", input), receipt);
    const reset = profiles.list().find(row => row.id === selected.id)!; assert.equal(reset.botId, bot.id); assert.equal(reset.default, true); assert.equal(reset.generation, 1); assert.equal(reset.maintenanceRequestId, null); assert.ok(notices > 0);
    const next = await backend.stateProfile(`profile:${selected.id}`); assert.notEqual(next.receipt!.lease, old.receipt!.lease); assert.notEqual(next.volumes[0]!.id, old.volumes[0]!.id);
    assert.equal((await backend.stateProfile(`profile:${sibling.id}`)).revision, siblingNative.revision);
    await profiles.ensure(selected.id);
    options.failInstanceCreate = true;
    const partialInput = applyState(await call("browser_profile_reset_plan", { profileId: selected.id }));
    const partial = await call("browser_profile_reset_clear", partialInput); assert.equal(partial.status, "partial");
    const leftovers = await backend.stateProfile(`profile:${selected.id}`); assert.equal(leftovers.volumes.length, 1); assert.equal(leftovers.instances.length, 0);
    assert.ok(partial.outcomes.some((row: any) => row.resource === leftovers.volumes[0]!.id && row.outcome === "retained"));
    assert.equal(profiles.list().find(row => row.id === selected.id)!.maintenanceRequestId, partialInput.requestId);
    const counts = s.counts(); await assert.rejects(profiles.ensure(selected.id), /fenced/); assert.deepEqual(s.counts(), counts);
    assert.deepEqual(await call("browser_profile_reset_clear", partialInput), partial);
    await assert.rejects(call("browse_state_fence_release", { profileId: selected.id, requestId: partialInput.requestId, expectedGeneration: 1 }), /generation/);
    await call("browse_state_fence_release", { profileId: selected.id, requestId: partialInput.requestId, expectedGeneration: 2 }); options.failInstanceCreate = false;
    await profiles.ensure(selected.id);
    const interrupted = await call("browser_profile_reset_plan", { profileId: selected.id }), interruptedInput = applyState(interrupted);
    state.journal.begin(interruptedInput, interrupted); await profiles.stateFence(selected.id, interruptedInput.requestId); state.journal.close(); journalClosed = true;
    const restoredProfiles = new Profiles(backend, s.system, s.env, async () => [bot], fakeGate); await restoredProfiles.start(false);
    const restored = new BrowseState(restoredProfiles, backend, s.env, s.system.root);
    try { assert.equal((await restored.clear(interruptedInput)).status, "unknown"); await assert.rejects(restoredProfiles.ensure(selected.id), /fenced/); assert.deepEqual(s.counts(), { instances: 2, volumes: 2 }); }
    finally { restored.journal.close(); }
  } finally { await browser.close(); await bots.close(); if (!journalClosed) state.journal.close(); await backend.closeContext(); await s.close(); }
});

test("volume collection excludes foreign/unrecorded names, blocks referenced/mounted leases and verifies exact orphan absence", async () => {
  const s = await fixture(), backend = new Backend(s.system, async () => undefined), profiles = new Profiles(backend, s.system, s.env, async () => [], fakeGate), state = new BrowseState(profiles, backend, s.env, s.system.root);
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false);
    const live = await profiles.create(null, "Referenced"); await profiles.ensure(live.id);
    const owned = structuredClone(s.volumes()[0]!); owned.id = "orphan-owned";
    const tags = owned.tags as Item; tags["dev.stack.session"] = backendSession("retired-orphan"); tags["dev.stack.lease"] = "a".repeat(32); owned.name = `stack-profile-${tags["dev.stack.session"]}-${"a".repeat(8)}`; s.volumes().push(owned);
    const foreign = { ...owned, id: "foreign-volume", tags: { ...tags, "dev.stack.browser": "false" } }; s.volumes().push(foreign);
    assert.equal((await backend.stateVolumes()).volumes.some(row => row.id === foreign.id), false);
    await assert.rejects(state.plan({ kind: "volume", ids: [foreign.id] }), /foreign/);
    const referenced = await state.plan({ kind: "volume", ids: [String(s.volumes()[0]!.id)] }); assert.ok(referenced.blockedBy.length); await assert.rejects(state.clear(applyState(referenced)), /referenced|mounted/);
    const stale = await state.plan({ kind: "volume", ids: [String(owned.id)] });
    s.instances().push({ id: "foreign-instance", volumes: [{ volume_id: owned.id }] }); await assert.rejects(state.clear(applyState(stale)), /changed/);
    const occupied = await state.plan({ kind: "volume", ids: [String(owned.id)] }); assert.ok(occupied.blockedBy.some(text => text.includes("mounted"))); s.instances().pop();
    const input = applyState(await state.plan({ kind: "volume", ids: [String(owned.id)] })), receipt = await state.clear(input); assert.equal(receipt.status, "completed"); assert.deepEqual(await state.clear(input), receipt);
    assert.equal(s.volumes().some(row => row.id === owned.id), false); assert.equal(s.volumes().some(row => row.id === foreign.id), true); assert.ok(s.volumes().some(row => row.id !== foreign.id));
  } finally { state.journal.close(); await backend.closeContext(); await s.close(); }
});

test("CDP site maintenance binds native observations and deletes only selected origin/storage and exact cookie partitions without global cache/history calls", async () => {
  const s = await fixture(), backend = new Backend(s.system, async () => undefined), frames: Array<{ method: string; params: any }> = [];
  const storage = { indexeddb: 10, cache_storage: 5 };
  let refuseStorage = false;
  let cookies: any[] = [
    { name: "selected", domain: ".selected.example", path: "/", value: "secret-value" },
    { name: "partitioned", domain: ".selected.example", path: "/private", value: "partition-secret", partitionKey: { topLevelSite: "https://selected.example", hasCrossSiteAncestor: false } },
    { name: "other-partition", domain: ".selected.example", path: "/", value: "retained-partition", partitionKey: { topLevelSite: "https://other.example", hasCrossSiteAncestor: true } },
    { name: "other", domain: "other.example", path: "/", value: "retained" },
  ];
  const cdp = createServer((req, res) => { if (req.url === "/json/version") res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(cdp.address() as any).port}/devtools/browser/fixture` })); else res.writeHead(404).end(); });
  const ws = new WebSocketServer({ server: cdp });
  ws.on("connection", peer => peer.on("message", raw => {
    const request = JSON.parse(String(raw)); frames.push(request); let result: any = {};
    switch (request.method) {
      case "Storage.getCookies": result = { cookies }; break;
      case "Storage.getUsageAndQuota": result = { usage: storage.indexeddb + storage.cache_storage, quota: 100, usageBreakdown: Object.entries(storage).map(([storageType, usage]) => ({ storageType, usage })) }; break;
      case "Target.getTargets": result = { targetInfos: [{ targetId: "retained-human-tab", type: "page", url: "https://other.example/private" }] }; break;
      case "Target.createTarget": result = { targetId: "maintenance-blank" }; break;
      case "Target.attachToTarget": result = { sessionId: "maintenance-session" }; break;
      case "Network.deleteCookies": cookies = cookies.filter(cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey]) !== JSON.stringify([request.params.name, request.params.domain, request.params.path, request.params.partitionKey])); break;
      case "Storage.clearDataForOrigin":
        if (refuseStorage) { peer.send(JSON.stringify({ id: request.id, error: { code: -1, message: "Native storage failure" } })); return; }
        for (const type of String(request.params.storageTypes).split(",")) if (type in storage) storage[type as keyof typeof storage] = 0;
        break;
      case "Target.closeTarget": result = { success: true }; break;
      default: peer.send(JSON.stringify({ id: request.id, error: { code: -1, message: "Unsupported native command" } })); return;
    }
    peer.send(JSON.stringify({ id: request.id, result }));
  }));
  await new Promise<void>(resolve => cdp.listen(0, "127.0.0.1", resolve));
  const launch = backend.launch.bind(backend); backend.launch = async (...args) => ({ ...await launch(...args), cdpUrl: `http://127.0.0.1:${(cdp.address() as any).port}` });
  const profiles = new Profiles(backend, s.system, s.env, async () => [], fakeGate), state = new BrowseState(profiles, backend, s.env, s.system.root), ctx = { backend, system: s.system, profiles, state };
  const call = async (name: string, input: unknown, invocation?: InvocationContext): Promise<any> => { const op = api.operations.find(op => op.name === name)!; return op.output.parse(await op.call(ctx, op.input.parse(input), invocation)); };
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false); const profile = await profiles.create(null, "Site fixture"); await profiles.ensure(profile.id);
    const selection = { profileId: profile.id, origins: ["https://selected.example"], categories: ["cookies", "storage", "cache"] };
    await assert.rejects(call("browser_site_data_plan", { ...selection, origins: ["https://name:secret@selected.example/path"] }), /origins/);
    const history = await call("browser_site_data_plan", { ...selection, categories: ["history"] }); assert.ok(history.blockedBy.some((text: string) => text.includes("unsupported")));
    await assert.rejects(call("browser_site_data_clear", applyState(history)), /unsupported/);
    const stale = await call("browser_site_data_plan", selection); assert.equal(JSON.stringify(stale).includes("secret-value"), false);
    cookies[0].value = "changed-after-plan"; await assert.rejects(call("browser_site_data_clear", applyState(stale)), /changed/);
    const input = applyState(await call("browser_site_data_plan", selection)), receipt = await call("browser_site_data_clear", input); assert.equal(receipt.status, "completed"); assert.deepEqual(await call("browser_site_data_clear", input), receipt);
    assert.deepEqual(cookies.map(cookie => cookie.name), ["other-partition", "other"]); assert.equal(cookies[1].value, "retained");
    const deletions = frames.filter(frame => frame.method === "Storage.clearDataForOrigin"); assert.equal(deletions.length, 2); assert.equal(deletions.every(frame => frame.params.origin === "https://selected.example"), true);
    assert.equal(frames.some(frame => ["Network.clearBrowserCache", "Network.clearBrowserCookies", "Page.resetNavigationHistory"].includes(frame.method)), false);
    assert.equal(receipt.outcomes.filter((row: any) => row.outcome === "removed").length, 3);
    storage.cache_storage = 5; refuseStorage = true;
    const failedInput = applyState(await call("browser_site_data_plan", selection));
    const failed = await call("browser_site_data_clear", failedInput); assert.equal(failed.status, "partial");
    for (const category of ["cache", "storage"]) assert.ok(failed.outcomes.some((row: any) => row.resource === `https://selected.example:${category}` && row.outcome === "unknown"));
    const beforeRetry = frames.length; assert.deepEqual(await call("browser_site_data_clear", failedInput), failed); assert.equal(frames.length, beforeRetry);
    assert.equal(profiles.list().find(row => row.id === profile.id)!.maintenanceRequestId, failedInput.requestId);
    assert.deepEqual(cookies.map(cookie => cookie.name), ["other-partition", "other"]);
    await assert.rejects(call("browser_site_data_plan", selection, { transport: "mcp", botId: null, instance: null, sessionId: null, threadId: null }), /operator authority/);
  } finally { state.journal.close(); await backend.closeContext(); for (const peer of ws.clients) peer.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => cdp.close(() => resolve())); await s.close(); }
});

test("research firewall denies guest private ranges, direct UDP and non-global IPv6 before Chrome starts", () => {
  const script = researchFirewall({ privateDestinations: [{ address: "10.1.2.3", port: 8443 }] });
  assert.ok(script.indexOf("iptables -P OUTPUT DROP") < script.indexOf("iptables -F OUTPUT"));
  assert.match(script, /ip6tables -P OUTPUT DROP/);
  assert.match(script, /--ctstate ESTABLISHED --ctdir REPLY/);
  assert.match(script, /-d 10\.1\.2\.3 -p tcp --dport 8443 -j ACCEPT/);
  assert.ok(script.indexOf("--dport 8443") < script.indexOf("-d 10.0.0.0/8 -j REJECT"));
  assert.ok(script.indexOf("-d 127.0.0.0/8 -j REJECT") < script.indexOf("iptables -A OUTPUT -p tcp -j ACCEPT"));
  assert.match(script, /-d 2000::\/3 -p tcp -j ACCEPT/);
  assert.equal(script.split("; ").filter((line) => line.includes("-p udp")).length, 1, "only fixed resolver DNS uses UDP");
  assert.throws(() => researchFirewall({ privateDestinations: [{ address: "10.0.0.1; echo bad", port: 80 }] }));
});

test("research runtime binds policy to its receipt and never attaches to an unrestricted incarnation", async () => {
  const s = await fixture(); const backend = new Backend(s.system, async () => undefined);
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root);
    const policy = { privateDestinations: [] };
    const acquired = await backend.launch("research", false, policy);
    const instance = s.instances()[0]!;
    const command = (instance.cmd as string[])[0]!;
    assert.ok(command.indexOf("iptables -P OUTPUT DROP") < command.indexOf("exec /wrapper"));
    assert.match(command, /sleep 300; iptables -F OUTPUT; ip6tables -F OUTPUT/);
    assert.equal((instance.env as Item).ENABLE_WEBRTC, "false");
    await assert.rejects(backend.launch("research"), /policy mismatch/);
    await assert.rejects(backend.launch("research", false, { privateDestinations: [{ address: "10.0.0.1", port: 80 }] }), /policy mismatch/);
    delete (instance.tags as Item)["dev.stack.egress"];
    await assert.rejects(backend.launch("research", false, policy), /egress_unverifiable/);
    await backend.close(acquired.cleanup);
  } finally { await backend.closeContext(); await s.close(); }
});
async function fixture(options: { failInstanceCreate?: boolean; failVolumeDelete?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "stack-browser-") );
  const root = join(dir, "local-hypeman");
  await mkdir(join(root, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "bin", "hypeman-api"), "fixture", { mode: 0o700 });
  await writeFile(join(root, "token"), "test-token\n", { mode: 0o600 });
  await writeFile(join(root, "config.yaml"), JSON.stringify({ port: "4975", network: { subnet_cidr: "192.168.64.0/24" } }));
  let instances: Item[] = [];
  let volumes: Item[] = [];
  let volumeSeq = 0, instanceSeq = 0;
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== "Bearer test-token") { res.writeHead(403).end(); return; }
      let body = "";
      for await (const part of req) body += part;
      const value = body ? JSON.parse(body) as Item : {};
      let output: unknown;
      const path = req.url ?? "";
      if (req.method === "GET" && path === "/instances") output = instances;
      else if (req.method === "GET" && path === "/volumes") output = volumes;
      else if (req.method === "GET" && path === "/resources") output = { disk: { available: 100 * 1024 ** 3 } };
      else if (req.method === "GET" && path.startsWith("/images/")) output = { status: "ready" };
      else if (req.method === "POST" && path === "/volumes") {
        volumes.push({ id: `volume-${++volumeSeq}`, ...value }); output = volumes.at(-1);
      } else if (req.method === "POST" && path === "/instances") {
        if (options.failInstanceCreate) { res.writeHead(503).end(); return; }
        instances.push({ id: `instance-${++instanceSeq}`, ...value, state: "Running", network: { ip: "192.168.64.2" } }); output = instances.at(-1);
      } else if (req.method === "POST" && path.endsWith("/start")) {
        assert.equal(body, "{}");
        const item = instances.find((item) => path === `/instances/${String(item.id)}/start`)!;
        item.state = "Running"; item.network = { ip: "192.168.64.3" }; output = item;
      } else if (req.method === "GET" && path.startsWith("/instances/")) output = instances.find((item) => item.name === decodeURIComponent(path.slice(11)));
      else if (req.method === "DELETE" && path.startsWith("/instances/")) { instances = instances.filter((item) => item.id !== decodeURIComponent(path.slice(11))); output = {}; }
      else if (req.method === "DELETE" && path.startsWith("/volumes/")) { if (options.failVolumeDelete) { res.writeHead(503).end(); return; } volumes = volumes.filter((item) => item.id !== decodeURIComponent(path.slice(9))); output = {}; }
      else { res.writeHead(404).end(); return; }
      if (output === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  await writeFile(join(root, "connection.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, tokenFile: join(root, "token") }));
  const env: NodeJS.ProcessEnv = { ...process.env, STACK_STATE_DIR: dir, HOME: dir };
  const system = new BrowserSystem(env);
  await system.start();
  return { dir, root, env, system, counts: () => ({ instances: instances.length, volumes: volumes.length }),
    instances: () => instances, volumes: () => volumes,
    async close() { await system.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}

test("local Hypeman detection, selection and durable update policy are read independently of Artbird", async () => {
  const s = await fixture();
  try {
    assert.equal((await s.system.detectHypeman()).some((entry) => entry.root === s.root), false);
    assert.equal((await s.system.setHypemanLocation(s.root)).find((entry) => entry.root === s.root)?.running, true);
    assert.equal((await s.system.detectHypeman()).find((entry) => entry.root === s.root)?.selected, false);
    await s.system.enableHypeman(s.root);
    assert.equal(s.system.selectedHypemanRoot(), s.root);
    assert.equal((await s.system.setUpdatePolicy("automatic")).policy, "automatic");
    const persisted = JSON.parse(await readFile(join(s.dir, "browser", "system.json"), "utf8")) as { policy: string; hypemanRoot: string };
    assert.equal(persisted.policy, "automatic");
    assert.equal(persisted.hypemanRoot, s.root);
    await assert.rejects(s.system.enableHypeman("http://artbird:4973"), /selected Hypeman root/);
  } finally { await s.close(); }
});

test("durable restart refreshes the relay and fences both native instance and profile volume", async () => {
  const s = await fixture(); const backend = new Backend(s.system, async () => undefined);
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root);
    const a = await backend.launch("durable", true);
    s.instances()[0]!.state = "Stopped";
    const b = await backend.launch("durable", true);
    assert.notEqual(b.cdpUrl, a.cdpUrl);
    assert.deepEqual(b.cleanup, a.cleanup);
    assert.equal((await backend.observation("durable"))?.url, "http://192.168.64.3:8080/?readOnly=1");
    s.instances()[0]!.id = "foreign";
    await assert.rejects(backend.launch("durable", true), /another incarnation/);
    await assert.rejects(backend.close(a.cleanup), /foreign browser target/);
    s.instances()[0]!.id = "instance-1";
    s.volumes()[0]!.id = "foreign";
    await assert.rejects(backend.launch("durable", true), /another volume/);
    s.volumes()[0]!.id = "volume-1";
    const missing = s.instances().pop()!;
    await assert.rejects(backend.launch("durable", true), /VM is missing; automatic replacement is disabled/);
    assert.deepEqual(s.counts(), { instances: 0, volumes: 1 }, "missing VM does not replace or discard its profile volume");
    s.instances().push(missing);
    await backend.close(a.cleanup);
  } finally { await backend.closeContext(); await s.close(); }
});

test("persistent CDP failure retains a Running instance and volume rather than force-rebooting", async () => {
  const s = await fixture(); let probes = 0;
  const backend = new Backend(s.system, async () => { probes++; throw new Error("CDP readiness deadline"); });
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root);
    await assert.rejects(backend.launch("cdp-failed", true), /CDP readiness deadline/);
    const receipt = (await backend.list())[0]!;
    await assert.rejects(backend.launch("cdp-failed", true), /CDP readiness deadline/);
    assert.equal(probes, 2); assert.deepEqual(s.counts(), { instances: 1, volumes: 1 });
    assert.equal(s.instances()[0]!.state, "Running");
    assert.deepEqual((await backend.list())[0], receipt);
    await backend.close({ session: receipt.session, lease: receipt.lease, browserProfile: receipt.profile, browserTarget: receipt.target!.name, backend: "local" });
  } finally { await backend.closeContext(); await s.close(); }
});

test("Bot defaults are exclusive, proof-fenced, retained on deletion, and not deleted by controller close", async () => {
  const s = await fixture(); const backend = new Backend(s.system, async () => undefined);
  let bots = [{ id: "bot-a", url: "unix:///private/test-a", state: "running", recoveryIssue: null }];
  const profiles = new Profiles(backend, s.system, s.env, async () => bots, fakeGate);
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false);
    await profiles.tick();
    const a = profiles.list()[0]!;
    assert.equal(a.botId, "bot-a"); assert.equal(a.default, true); assert.equal(a.state, "ready");
    await profiles.tick(); assert.equal(profiles.list().length, 1);
    const identity = botMcpUrl("http://127.0.0.1/browser", "bot-a", bots[0]!.url, s.env);
    const launch = await profiles.launch(identity, "arbitrary-name");
    await profiles.disconnected(launch.cleanup.controller, launch.cleanup.revision);
    assert.deepEqual(s.counts(), { instances: 1, volumes: 1 });
    await assert.rejects(profiles.remove(a.id), /default profile/);
    await assert.rejects(profiles.launch(botMcpUrl("http://127.0.0.1/browser", "bot-a", "unix:///stale", s.env), "bot-a"), /verified live Bot/);
    bots = [];
    await profiles.releaseBot("bot-a");
    await profiles.tick();
    assert.equal(profiles.list()[0]!.botId, null); assert.equal(profiles.list()[0]!.default, false);
    assert.equal(profiles.list()[0]!.state, "ready"); assert.deepEqual(s.counts(), { instances: 1, volumes: 1 });
    await profiles.remove(a.id); assert.deepEqual(s.counts(), { instances: 0, volumes: 0 });
  } finally { await profiles.close(); await backend.closeContext(); await s.close(); }
});

test("an incomplete launch retains its lease and can be reconciled without a provider receipt", async () => {
  const s = await fixture({ failInstanceCreate: true });
  const backend = new Backend(s.system, async () => undefined);
  try {
    await s.system.setHypemanLocation(s.root);
    await s.system.enableHypeman(s.root);
    await assert.rejects(backend.launch("task-failed"), /HTTP 503/);
    assert.deepEqual(s.counts(), { instances: 0, volumes: 1 });
    const [reserved] = await backend.list();
    assert.equal(reserved?.target, null);
    await assert.rejects(backend.reconcile(reserved!.session, "b".repeat(32)), /no matching/);
    assert.deepEqual(s.counts(), { instances: 0, volumes: 1 });
    await backend.reconcile(reserved!.session, reserved!.lease);
    assert.deepEqual(s.counts(), { instances: 0, volumes: 0 });
    assert.deepEqual(await backend.list(), []);
  } finally { await backend.closeContext(); await s.close(); }
});

test("failed controller selection reports unknown and fences uncertain profile deletion", async () => {
  const s = await fixture(); const backend = new Backend(s.system, async () => undefined);
  const bot = { id: "bot-a", url: "unix:///test-bot", state: "running", recoveryIssue: null };
  const profiles = new Profiles(backend, s.system, s.env, async () => [bot], fakeGate);
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false); await profiles.tick();
    const extra = await profiles.create(bot.id, "extra"); await profiles.ensure(extra.id);
    const binding = await profiles.select(bot.id, "default", extra.id);
    assert.equal(binding.state, "unknown"); assert.equal(binding.actualProfileId, null); assert.equal(binding.targetId, null);
    assert.match(binding.error!, /not installed/);
    await assert.rejects(profiles.remove(extra.id), /uncertain binding/);
    const identity = botMcpUrl("http://127.0.0.1/browser", bot.id, bot.url, s.env);
    const receipt = (await profiles.launch(identity, "default")).cleanup;
    await profiles.disconnected(receipt.controller, receipt.revision - 1);
    assert.equal(profiles.bindings()[0]!.state, "unknown", "a stale close cannot clear the new selection");
    await profiles.disconnected(receipt.controller, receipt.revision);
    await profiles.releaseBot(bot.id);
    for (const profile of profiles.list()) await profiles.remove(profile.id);
  } finally { await profiles.close(); await backend.closeContext(); await s.close(); }
});

test("MCP management scopes reads and every mutation to a verified live Bot launch", async () => {
  const s = await fixture(); const backend = new Backend(s.system, async () => undefined);
  const bots = ["a", "b"].map((id) => ({ id, url: `unix:///bot-${id}`, state: "running", mainThreadId: `root-${id}`, recoveryIssue: null as string | null }));
  const profiles = new Profiles(backend, s.system, s.env, async () => bots, fakeGate);
  const state = new BrowseState(profiles, backend, s.env, s.system.root);
  const ctx = { backend, system: s.system, profiles, state };
  const invocation: InvocationContext = { transport: "mcp", botId: "a", instance: botInstance(bots[0]!.url), threadId: "main", sessionId: null };
  const receipts: Array<{ controller: string; revision: number }> = [];
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false);
    const own = await browserProfileCreate.call(ctx, { botId: "a", label: "own" }, invocation);
    const foreign = await profiles.create("b", "foreign"); const orphan = await profiles.create(null, "orphan");
    for (const p of profiles.list()) await profiles.ensure(p.id);
    assert.deepEqual((await browserProfileList.call(ctx, {}, invocation)).profiles.map((p) => p.id), [own.id]);
    assert.equal((await browserProfileList.call(ctx, {})).profiles.length, 3);
    const scheduled: InvocationContext = { ...invocation, transport: "proc", scheduleId: "00000000-0000-4000-8000-000000000001",
      executionId: "00000000-0000-4000-8000-000000000002", authority: { kind: "bot", botId: "a", mainThreadId: "root-a", threadId: "main" } };
    assert.deepEqual((await browserProfileList.call(ctx, {}, scheduled)).profiles.map((p) => p.id), [own.id]);
    await assert.rejects(browserProfileCreate.call(ctx, { botId: "b", label: "denied" }, scheduled), /invoking Bot/);
    await assert.rejects(browserProfileList.call(ctx, {}, { ...scheduled, authority: { ...scheduled.authority, kind: "bot", botId: "a", mainThreadId: "old-root", threadId: "main" } }), /root changed/);
    const operatorSchedule: InvocationContext = { ...scheduled, authority: { kind: "operator" }, botId: null, instance: null, threadId: null };
    assert.equal((await browserProfileList.call(ctx, {}, operatorSchedule)).profiles.length, 3);
    for (const bot of bots) receipts.push((await profiles.launch(botMcpUrl("http://127.0.0.1/browser", bot.id, bot.url, s.env), "same-session")).cleanup);
    assert.deepEqual((await browserControllerList.call(ctx, {}, invocation)).controllers.map((c) => c.botId), ["a"]);
    assert.equal((await browserControllerList.call(ctx, {})).controllers.length, 2);
    for (const botId of ["b", null]) await assert.rejects(browserProfileCreate.call(ctx, { botId, label: "denied" }, invocation), /invoking Bot/);
    for (const profileId of [foreign.id, orphan.id]) {
      await assert.rejects(browserProfileDelete.call(ctx, { profileId, confirm: "delete" }, invocation), /invoking Bot/);
      await assert.rejects(browserControllerSelect.call(ctx, { botId: "a", session: "same-session", profileId }, invocation), /exclusively assigned/);
    }
    await assert.rejects(browserControllerSelect.call(ctx, { botId: "b", session: "same-session", profileId: foreign.id }, invocation), /invoking live Bot/);
    for (const denied of [
      { ...invocation, instance: "stale" }, { ...invocation, botId: null, instance: null },
      { ...invocation, workerId: "worker", workerInstance: "runtime" },
    ]) {
      await assert.rejects(browserProfileList.call(ctx, {}, denied), /Bot/);
      await assert.rejects(browserControllerList.call(ctx, {}, denied), /Bot/);
      await assert.rejects(browserProfileCreate.call(ctx, { botId: "a", label: "denied" }, denied), /Bot/);
      await assert.rejects(browserProfileDelete.call(ctx, { profileId: own.id, confirm: "delete" }, denied), /Bot/);
      await assert.rejects(browserControllerSelect.call(ctx, { botId: "a", session: "same-session", profileId: own.id }, denied), /Bot/);
    }
    bots[0]!.state = "stopped";
    await assert.rejects(browserProfileList.call(ctx, {}, invocation), /verified live Bot/);
    bots[0]!.state = "running"; bots[0]!.recoveryIssue = "unverified process";
    await assert.rejects(browserProfileDelete.call(ctx, { profileId: own.id, confirm: "delete" }, invocation), /verified live Bot/);
    bots[0]!.recoveryIssue = null;
    for (const receipt of receipts) await profiles.disconnected(receipt.controller, receipt.revision);
    await browserProfileDelete.call(ctx, { profileId: own.id, confirm: "delete" }, invocation);
    assert.ok(!profiles.list().some((p) => p.id === own.id));
  } finally {
    for (const receipt of receipts) await profiles.disconnected(receipt.controller, receipt.revision);
    for (const bot of bots) await profiles.releaseBot(bot.id);
    for (const profile of profiles.list()) await profiles.remove(profile.id);
    state.journal.close(); await profiles.close(); await backend.closeContext(); await s.close();
  }
});

test("handoff admission, human revisions, retry-safe return, cancellation and restart stay profile scoped", async () => {
  const s = await fixture(); const backend = new Backend(s.system, async () => undefined);
  const bot = { id: "a", url: "unix:///bot-a", state: "running", recoveryIssue: null };
  const invocation: InvocationContext = { transport: "mcp", botId: bot.id, instance: botInstance(bot.url), threadId: "main", sessionId: null };
  const server = await serveSocket({ info: { name: "bots", description: "fixture", transportDescription: "fixture", path: socketPath("bots", s.env) }, context: {}, operations: [operation({
    name: "chat_thread_read", description: "Sanctioned thread fixture.", input: z.object({ botId: z.string(), threadId: z.string() }), output: z.object({ thread: z.object({ id: z.string() }) }),
    async call(_ctx, input) { if (input.botId !== "a" || !["main", "child"].includes(input.threadId)) throw new Error("outside sanctioned lineage"); return { thread: { id: input.threadId } }; },
  })] });
  let blocked = false; let held = false; let revoked = 0; let granted = 0; let failResume = false;
  const makeGate = (cdp: string, neko: string): ManagedGate => ({ ...fakeGate(cdp, neko), hold() { held = true; }, resume() { if (failResume) throw new Error("resume failed"); held = false; },
    async drain() { if (blocked) throw new Error("drain pending"); }, async revokeHuman() { revoked++; }, async grantHuman() { granted++; return "http://human/grant"; } });
  let profiles = new Profiles(backend, s.system, s.env, async () => [bot], makeGate);
  const maintenance = new BrowseState(profiles, backend, s.env, s.system.root);
  const workspace = join(s.root, "workspace");
  await mkdir(join(workspace, "packages", "browse"), { recursive: true });
  await writeFile(join(workspace, "packages", "browse", "api.yaml"), "name: browse\ndescription: Browse\nmcp:\n  description: Browse\n  operations: [browser_handoff_request, browser_handoff_completion]\n  events: [browser_handoffs_changed]\n");
  const deliveries: EventValue[] = [];
  const owner = new McpEventSubscriptions(s.env, async () => undefined, async (event, _signal, authorize, submitting) => { await authorize(); submitting?.(); deliveries.push(event); }, undefined, undefined, workspace);
  const capability = await serveSocket({ info: { name: "serve", description: "Capability", transportDescription: "Socket", path: socketPath("serve", s.env) }, context: {}, operations: [
    operation({ name: "serve_completion_check", description: "Verify coordination", input: z.strictObject({ id: z.uuid(), package: z.string(), operation: z.string(), recordId: z.uuid(), caller: invocationContext }), output: z.object({ verified: z.boolean() }),
      async call(_ctx, input) { await owner.verifyCompletion(input.id, input.package, input.operation, input.recordId, input.caller); return { verified: true }; } }),
  ] });
  const browse = await serveSocket({ info: { name: "browse", description: "Browse", transportDescription: "Socket", path: socketPath("browse", s.env) }, context: { get profiles() { return profiles; }, backend, system: s.system, state: maintenance }, operations: [browserHandoffRequest, browserHandoffCompletion], events: { topics: { browser_handoffs_changed: "Handoff state changed." } } });
  profiles.onHandoffChange = () => browse.publish!("browser_handoffs_changed");
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false);
    const own = await profiles.create("a", "own", true); await profiles.ensure(own.id);
    const extra = await profiles.create("a", "other"); await profiles.ensure(extra.id);
    const input = { profileId: own.id, requestId: randomUUID(), message: "Sign in", subscribe: false };
    await assert.rejects(profiles.requestHandoff({ ...input, subscribe: undefined }, invocation), /owner-coordinated/);
    assert.equal(profiles.handoffs(null).length, 0, "failed automatic coordination must not persist or hold a profile");
    assert.equal(held, false);
    await assert.rejects(profiles.requestHandoff(input, { ...invocation, threadId: "foreign" }), /sanctioned/);
    blocked = true;
    const admission = await owner.callAndWatch("browse", "browser_handoff_request", { ...input, subscribe: undefined }, invocation);
    assert.deepEqual(admission.observation, { result: null });
    let h = admission as Handoff;
    const openPlan = await maintenance.plan({ kind: "handoff", ids: [h.id] });
    await assert.rejects(maintenance.clear({ planId: openPlan.id, expectedRevision: openPlan.revision, requestId: randomUUID() }), /Open handoff/);
    assert.equal(h.state, "preparing"); assert.match(h.issue!, /drain pending/); assert.equal(held, true);
    await assert.rejects(profiles.select("a", "later", own.id), /held/);
    await assert.rejects(profiles.requestHandoff({ ...input, requestId: randomUUID() }, invocation), /unresolved/);
    await assert.rejects(profiles.actHandoff("take", { id: h.id, expectedRevision: h.revision, requestId: randomUUID() }), /not awaiting/);
    blocked = false;
    h = await profiles.requestHandoff(input, invocation); assert.equal(h.state, "awaiting_human");
    assert.equal((await profiles.requestHandoff(input, invocation)).id, h.id);
    await assert.rejects(profiles.requestHandoff({ ...input, message: "different" }, invocation), /conflicts/);
    await assert.rejects(profiles.actHandoff("take", { id: h.id, expectedRevision: h.revision - 1, requestId: randomUUID() }), /stale/);
    const take = { id: h.id, expectedRevision: h.revision, requestId: randomUUID() };
    await assert.rejects(profiles.actHandoff("take", take, invocation), /local operator/);
    const taken = await profiles.actHandoff("take", take); h = taken.handoff;
    assert.equal(h.state, "human_controlling"); assert.ok(taken.controlUrl); assert.equal(granted, 1);
    await profiles.actHandoff("take", take); assert.equal(granted, 1);
    await assert.rejects(profiles.actHandoff("cancel", { id: h.id, expectedRevision: h.revision, requestId: randomUUID() }, invocation), /before human take/);
    const finish = { id: h.id, expectedRevision: h.revision, requestId: randomUUID(), outcome: "completed" as const, note: "Signed in" };
    const published: string[] = [];
    profiles.onHandoffChange = () => { published.push(profiles.handoffs(null).find((row) => row.id === h.id)!.state); browse.publish!("browser_handoffs_changed"); };
    failResume = true;
    h = (await profiles.actHandoff("finish", finish)).handoff;
    assert.equal(h.state, "returning"); assert.equal(h.resolvedAt, null); assert.equal(held, true);
    assert.match(h.issue!, /resume failed/); assert.ok(!published.includes("resolved"));
    failResume = false;
    const path = join(s.system.root, "profiles.json");
    const saved = await readFile(path, "utf8");
    await rm(path); await mkdir(path);
    await assert.rejects(profiles.actHandoff("finish", finish));
    assert.equal(profiles.handoffs(null).find((row) => row.id === h.id)!.state, "returning");
    assert.equal(held, true); assert.ok(!published.includes("resolved"));
    await rm(path, { recursive: true }); await writeFile(path, saved);
    h = (await profiles.actHandoff("finish", finish)).handoff;
    assert.equal(h.state, "resolved"); assert.equal(h.outcome, "completed"); assert.equal(held, false); assert.ok(revoked >= 2);
    assert.deepEqual((await profiles.actHandoff("finish", finish)).handoff, h);
    assert.equal(published.filter((state) => state === "resolved").length, 1);
    for (let n = 0; n < 300 && deliveries.length === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(deliveries.length, 1); assert.equal((deliveries[0]!.value as { result: Handoff }).result.id, h.id);
    assert.equal(owner.status(invocation).completions[0]?.state, "delivered");
    profiles.onHandoffChange = undefined;
    await assert.rejects(profiles.actHandoff("finish", { ...finish, note: "changed" }), /conflicts/);
    const redaction = await maintenance.plan({ kind: "handoff", ids: [h.id] });
    const staleRedaction = await maintenance.plan({ kind: "handoff", ids: [h.id] });
    const redactionInput = { planId: redaction.id, expectedRevision: redaction.revision, requestId: randomUUID() };
    const receipt = await maintenance.clear(redactionInput); assert.equal(receipt.status, "completed"); assert.deepEqual(await maintenance.clear(redactionInput), receipt);
    await assert.rejects(maintenance.clear(applyState(staleRedaction)), /changed/);
    const cleared = profiles.handoffs(null).find(row => row.id === h.id)!;
    assert.equal(cleared.message, ""); assert.equal(cleared.note, null); assert.ok(cleared.contentClearedAt); assert.equal(cleared.outcome, "completed"); assert.equal(cleared.resolvedAt, h.resolvedAt);
    assert.equal((await profiles.requestHandoff(input, invocation)).id, h.id, "original intent retry survives redaction via permanent digest");
    const clearedRetry = await owner.callAndWatch("browse", "browser_handoff_request", { ...input, subscribe: undefined }, invocation);
    assert.equal(clearedRetry.contentClearedAt, cleared.contentClearedAt);
    assert.equal((clearedRetry.subscription as { state: string }).state, "delivered");
    assert.equal(deliveries.length, 1, "content maintenance must not rearm an acknowledged handoff watch");
    await assert.rejects(profiles.requestHandoff({ ...input, message: "changed" }, invocation), /conflicts/);
    assert.equal((await profiles.actHandoff("finish", finish)).handoff.contentClearedAt, cleared.contentClearedAt);
    h = await profiles.requestHandoff({ ...input, requestId: randomUUID() }, invocation);
    h = (await profiles.actHandoff("finish", { id: h.id, expectedRevision: h.revision, requestId: randomUUID(), outcome: "skipped" })).handoff;
    assert.equal(h.outcome, "skipped");
    h = await profiles.requestHandoff({ ...input, requestId: randomUUID() }, invocation);
    await assert.rejects(profiles.actHandoff("cancel", { id: h.id, expectedRevision: h.revision, requestId: randomUUID() }, { ...invocation, threadId: "child" }), /another Chat/);
    h = (await profiles.actHandoff("cancel", { id: h.id, expectedRevision: h.revision, requestId: randomUUID() }, invocation)).handoff;
    assert.equal(h.outcome, "cancelled");
    h = await profiles.requestHandoff({ ...input, requestId: randomUUID() }, invocation);
    // An independent controller can still select another profile. No installed
    // daemon exists in this fixture, so its honest outcome is unknown.
    assert.equal((await profiles.select("a", "other", extra.id)).state, "unknown");
    const proof = botMcpUrl("http://127.0.0.1/browser", "a", bot.url, s.env);
    await assert.rejects(profiles.launch(proof, "new-controller"), /held|not ready/);
    // Crash-style reconstruction: no close() and no implicit resolution.
    profiles = new Profiles(backend, s.system, s.env, async () => [bot], makeGate);
    await profiles.start(false); await profiles.ensure(own.id);
    const restored = profiles.handoffs(null).find((row) => row.id === h.id)!;
    assert.equal(restored.state, "awaiting_human"); assert.match(restored.issue!, /Owner restarted/);
    await assert.rejects(profiles.select("a", "later", own.id), /held/);
    await assert.rejects(profiles.remove(own.id), /unresolved/);
  } finally {
    await owner.close(); await browse.close(); await capability.close();
    // Native resource cleanup is exact and independent of the test handoff.
    for (const r of await backend.list()) if (r.target) await backend.close({ session: r.session, lease: r.lease, browserProfile: r.profile, browserTarget: r.target.name, backend: "local" });
    await backend.closeContext(); await server.close(); await s.close();
    maintenance.journal.close();
  }
});

test("handoff replacement revokes grants, preserves unknown drain, and activates the requested target only after drain", async () => {
  const s = await fixture(); const backend = new Backend(s.system, async () => undefined);
  const bot = { id: "a", url: "unix:///bot-a", state: "running", recoveryIssue: null };
  const invocation: InvocationContext = { transport: "mcp", botId: bot.id, instance: botInstance(bot.url), threadId: "main", sessionId: null };
  const server = await serveSocket({ info: { name: "bots", description: "fixture", transportDescription: "fixture", path: socketPath("bots", s.env) }, context: {}, operations: [operation({
    name: "chat_thread_read", description: "Fixture.", input: z.object({ botId: z.string(), threadId: z.string() }), output: z.object({ thread: z.object({ id: z.string() }) }),
    async call(_ctx, input) { return { thread: { id: input.threadId } }; },
  })] });
  const events: string[] = [];
  const cdp = createServer((req, res) => {
    if (req.url?.endsWith("/json/list")) res.end(JSON.stringify([{ id: "requested-tab" }]));
    else if (req.url?.endsWith("/json/activate/requested-tab")) { events.push("activate"); res.end("Target activated"); }
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => cdp.listen(0, "127.0.0.1", resolve));
  const address = cdp.address(); assert.ok(address && typeof address !== "string");
  let generation = 1; let blocked = false; let grants = 0; let originReads = 0; let verified: (() => void) | null = null;
  const launch = backend.launch.bind(backend);
  backend.launch = async (...args) => ({ ...await launch(...args), cdpUrl: `http://127.0.0.1:${address.port}/${generation}` });
  const profiles = new Profiles(backend, s.system, s.env, async () => { if (++originReads === 3) verified?.(); return [bot]; }, (url, neko) => {
    const epoch = generation; let unknown = false;
    return { ...fakeGate(url, neko),
      unknownDrain() { unknown = true; },
      async drain() { events.push("drain"); if (blocked || unknown) throw new Error("drain unknown"); },
      async revokeHuman() { events.push(`revoke:${epoch}`); },
      async grantHuman() { grants++; events.push("grant"); return `http://human/${epoch}`; },
    };
  });
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false);
    const profile = await profiles.create(bot.id, "handoff"); await profiles.ensure(profile.id);
    const removed = await profiles.create(bot.id, "deletion race"); await profiles.ensure(removed.id);
    const get = backend.get.bind(backend);
    let deletionEntered!: () => void; let continueDeletion!: () => void;
    const entered = new Promise<void>((resolve) => { deletionEntered = resolve; });
    const proceed = new Promise<void>((resolve) => { continueDeletion = resolve; });
    backend.get = async (resource) => { if (resource === `profile:${removed.id}`) { deletionEntered(); await proceed; } return get(resource); };
    const deletion = profiles.remove(removed.id); await entered;
    originReads = 0;
    const checked = new Promise<void>((resolve) => { verified = resolve; });
    const racing = profiles.requestHandoff({ profileId: removed.id, requestId: randomUUID(), message: "Too late", subscribe: false }, invocation);
    const refused = assert.rejects(racing, /does not belong/);
    // origin() performs two Bot reads; the third occurs inside the lifecycle
    // lock. Let origin finish, then release deletion without waiting for it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    continueDeletion(); await deletion; await checked; await refused;
    backend.get = get; verified = null;
    assert.ok(!profiles.handoffs(null).some((h) => h.profileId === removed.id));
    const other = await profiles.create(bot.id, "request collision"); await profiles.ensure(other.id);
    const sameRequest = randomUUID();
    const requests = await Promise.allSettled([profile.id, other.id].map((profileId) => profiles.requestHandoff({ profileId, requestId: sameRequest, message: "Same request", subscribe: false }, invocation)));
    assert.equal(requests.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(String((requests.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /conflicts/);
    const admitted = profiles.handoffs(null).find((h) => h.requestId === sameRequest)!;
    await profiles.actHandoff("cancel", { id: admitted.id, expectedRevision: admitted.revision, requestId: randomUUID() }, invocation);
    let h = await profiles.requestHandoff({ profileId: profile.id, targetId: "requested-tab", message: "Help", requestId: randomUUID(), subscribe: false }, invocation);
    events.length = 0;
    const take = { id: h.id, expectedRevision: h.revision, requestId: randomUUID() };
    assert.equal((await profiles.actHandoff("take", take)).controlUrl, "http://human/1");
    assert.deepEqual(events, ["drain", "revoke:1", "activate", "grant"]);
    generation++;
    await profiles.ensure(profile.id);
    assert.ok(events.includes("revoke:1"));
    assert.equal((await profiles.actHandoff("take", take)).controlUrl, "http://human/2", "retry replaces the revoked URL");
    assert.equal(grants, 2);
    h = profiles.handoffs(null).find((row) => row.id === h.id)!;
    await profiles.actHandoff("finish", { id: h.id, expectedRevision: h.revision, requestId: randomUUID(), outcome: "completed" });
    blocked = true;
    const request = { profileId: profile.id, message: "Unknown work", requestId: randomUUID(), subscribe: false };
    h = await profiles.requestHandoff(request, invocation); assert.equal(h.quiesced, false);
    generation++; blocked = false;
    await profiles.ensure(profile.id);
    h = await profiles.requestHandoff(request, invocation);
    assert.equal(h.state, "preparing"); assert.match(h.issue!, /drain unknown/);
    h = (await profiles.actHandoff("cancel", { id: h.id, expectedRevision: h.revision, requestId: randomUUID() }, invocation)).handoff;
    assert.equal(h.state, "returning"); assert.match(h.issue!, /drain unknown/);
    await profiles.releaseBot(bot.id);
    await assert.rejects(profiles.actHandoff("cancel", { id: h.id, expectedRevision: h.revision, requestId: randomUUID() }, invocation), /another Chat or Bot launch/);
  } finally {
    for (const r of await backend.list()) if (r.target) await backend.close({ session: r.session, lease: r.lease, browserProfile: r.profile, browserTarget: r.target.name, backend: "local" });
    await backend.closeContext(); await server.close(); await new Promise<void>((resolve) => cdp.close(() => resolve())); await s.close();
  }
});

test("disposable launch and exact close use only the selected local Hypeman API", async () => {
  const s = await fixture();
  const backend = new Backend(s.system, async () => undefined);
  try {
    await s.system.setHypemanLocation(s.root);
    await s.system.enableHypeman(s.root);
    const first = await backend.launch("task-a");
    assert.equal(first.cleanup.session, backendSession("task-a"));
    assert.equal(first.cleanup.backend, "local");
    assert.deepEqual(s.counts(), { instances: 1, volumes: 1 });
    assert.deepEqual((await backend.launch("task-a")).cleanup, first.cleanup);
    assert.equal((await backend.list())[0]?.persistent, false);
    await assert.rejects(backend.close({ ...first.cleanup, lease: "b".repeat(32) }), /stale or mismatched/);
    assert.deepEqual(s.counts(), { instances: 1, volumes: 1 });
    await backend.close(first.cleanup);
    assert.deepEqual(s.counts(), { instances: 0, volumes: 0 });
    assert.deepEqual(await backend.list(), []);
    await backend.close(first.cleanup);
  } finally { await backend.closeContext(); await s.close(); }
});

test("provider protocol forwards only the exact browser lifecycle calls", async () => {
  const s = await fixture();
  try {
    const calls: string[] = [];
    const call = (async (_path: string, _method: string, input: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(input.name);
      if (input.name === "browser_status") return { provider: "hypeman", mode: "disposable", sessions: 0 };
      if (input.name === "browser_controller_launch") return { cdpUrl: "http://127.0.0.1:9999", cleanup: { controller: "controller", revision: 0 } };
      return { closed: true };
    }) as typeof import("@stack/api").socketCall;
    const protocol = "agent-browser.plugin.v1";
    const manifest = await handleProvider(JSON.stringify({ protocol, type: "plugin.manifest", capability: "plugin.manifest", request: {} }), s.env, call);
    assert.deepEqual((manifest.manifest as { capabilities: string[] }).capabilities, ["browser.provider"]);
    const opened = await handleProvider(JSON.stringify({ protocol, type: "browser.launch", capability: "browser.provider", request: { session: "task" } }), s.env, call, "private-launch-proof");
    assert.equal(opened.success, true);
    const cleanup = (opened.browser as { cleanup: unknown }).cleanup;
    const closed = await handleProvider(JSON.stringify({ protocol, type: "browser.close", capability: "browser.provider", request: cleanup }), s.env, call);
    assert.equal(closed.success, true);
    assert.deepEqual(calls, ["browser_status", "browser_controller_launch", "browser_controller_close"]);
    assert.equal((await handleProvider(JSON.stringify({ protocol, type: "browser.close", capability: "browser.provider", request: cleanup }), s.env,
      (async () => { throw new Error("owner socket closed"); }) as typeof import("@stack/api").socketCall)).success, true);
    assert.equal((await handleProvider(JSON.stringify({ protocol, type: "browser.launch", capability: "browser.provider", request: { session: "bot-1" } }), s.env, call)).success, false);
    const refused = await handleProvider(JSON.stringify({ protocol, type: "browser.launch", capability: "browser.provider", request: { session: "task" } }), s.env,
      (async () => ({ provider: "agentbrowse" })) as typeof import("@stack/api").socketCall);
    assert.equal(refused.success, false);
  } finally { await s.close(); }
});

test("owner's private agent-browser config leaves global settings alone", async () => {
  const s = await fixture();
  try {
    const path = prepareBrowserConfig(s.env);
    const config = JSON.parse(await readFile(path, "utf8")) as { provider: string; plugins: Array<{ command: string; args: string[] }> };
    assert.equal(config.provider, "stack");
    assert.equal(config.plugins[0]?.command, process.execPath);
    assert.match(config.plugins[0]?.args[0] ?? "", /packages\/browse\/dist\/src\/provider\.js$/);
  } finally { await s.close(); }
});

test("private provider config migrates only the former managed identity", async () => {
  const s = await fixture();
  try {
    const path = prepareBrowserConfig(s.env);
    const old = { provider: "agentstack", plugins: [{ name: "agentstack", command: "/Users/operator/.nvm/versions/node/v24.16.0/bin/node",
      args: ["/Users/operator/code/agentstack/packages/browser/dist/src/provider.js"], capabilities: ["browser.provider"] }] };
    await writeFile(path, JSON.stringify(old));
    prepareBrowserConfig(s.env);
    assert.equal(JSON.parse(await readFile(path, "utf8")).provider, "stack");
    await writeFile(path, JSON.stringify({ ...old, plugins: [{ ...old.plugins[0], command: "/foreign/node" }] }));
    assert.throws(() => prepareBrowserConfig(s.env), /differs from the managed provider/);
  } finally { await s.close(); }
});

test("manual release observation requires exact acceptance; automatic checks only upgrade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-browser-updates-"));
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const npm = `#!/bin/sh
if [ "$1" = view ]; then printf '"%s"\\n' "$TEST_LATEST"; exit 0; fi
[ "$1" = install ] || exit 11
shift
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then shift; root="$1"; fi
  case "$1" in agent-browser@*) version="\${1#agent-browser@}";; esac
  shift
done
package="$root/node_modules/agent-browser"
mkdir -p "$package/bin"
printf '{"name":"agent-browser","version":"%s"}\\n' "$version" >"$package/package.json"
printf '#!/bin/sh\\nprintf "agent-browser %s\\\\n"\\n' "$version" >"$package/bin/agent-browser-darwin-arm64"
`;
  await writeFile(join(bin, "npm"), npm, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, STACK_STATE_DIR: dir, PATH: `${bin}:/usr/bin:/bin`, TEST_LATEST: "0.39.0" };
  const system = new BrowserSystem(env);
  try {
    await system.start();
    assert.equal((await system.checkUpdates()).pending, "0.39.0");
    assert.equal((await system.browserStatus()).installed, false);
    await assert.rejects(system.acceptUpdate("0.39.1"), /not the current observed/);
    assert.equal((await system.acceptUpdate("0.39.0")).version, "0.39.0");
    assert.equal((await system.browserStatus()).pending, null);
    env.TEST_LATEST = "0.38.1";
    await system.setUpdatePolicy("automatic");
    const observed = await system.checkUpdates();
    assert.equal(observed.version, "0.39.0");
    assert.equal(observed.pending, null);
    assert.equal((await system.uninstallBrowser()).installed, false);
    assert.equal((await system.browserStatus()).policy, "automatic");
  } finally { await system.close(); await rm(dir, { recursive: true, force: true }); }
});
