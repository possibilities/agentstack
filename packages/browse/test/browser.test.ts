import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BrowserSystem } from "../src/system.js";
import { Backend, backendSession } from "../src/backend.js";
import { handleProvider } from "../src/provider.js";
import { prepareBrowserConfig } from "../src/config.js";
import { Profiles } from "../src/profiles.js";
import type { ManagedGate } from "../src/gate.js";
const fakeGate = (cdp: string, neko: string): ManagedGate => ({
  cdpUrl: cdp, observationUrl: neko, async start() {}, async close() {}, hold() {}, async drain() {}, resume() {}, unknownDrain() {},
  async grantHuman() { return neko + "/human"; }, async revokeHuman() {},
});
import { botMcpUrl, botInstance, serveSocket, socketPath, operation, type InvocationContext } from "@agentstack/api";
import { browserProfileList, browserProfileCreate, browserProfileDelete, browserControllerList, browserControllerSelect } from "../api.js";

type Item = Record<string, unknown>;
async function fixture(options: { failInstanceCreate?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-browser-") );
  const root = join(dir, "local-hypeman");
  await mkdir(join(root, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "bin", "hypeman-api"), "fixture", { mode: 0o700 });
  await writeFile(join(root, "token"), "test-token\n", { mode: 0o600 });
  await writeFile(join(root, "config.yaml"), JSON.stringify({ port: "4975", network: { subnet_cidr: "192.168.64.0/24" } }));
  let instances: Item[] = [];
  let volumes: Item[] = [];
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
        volumes.push({ id: `volume-${volumes.length + 1}`, ...value }); output = volumes.at(-1);
      } else if (req.method === "POST" && path === "/instances") {
        if (options.failInstanceCreate) { res.writeHead(503).end(); return; }
        instances.push({ id: `instance-${instances.length + 1}`, ...value, state: "Running", network: { ip: "192.168.64.2" } }); output = instances.at(-1);
      } else if (req.method === "POST" && path.endsWith("/start")) {
        assert.equal(body, "{}");
        const item = instances.find((item) => path === `/instances/${String(item.id)}/start`)!;
        item.state = "Running"; item.network = { ip: "192.168.64.3" }; output = item;
      } else if (req.method === "GET" && path.startsWith("/instances/")) output = instances.find((item) => item.name === decodeURIComponent(path.slice(11)));
      else if (req.method === "DELETE" && path.startsWith("/instances/")) { instances = instances.filter((item) => item.id !== decodeURIComponent(path.slice(11))); output = {}; }
      else if (req.method === "DELETE" && path.startsWith("/volumes/")) { volumes = volumes.filter((item) => item.id !== decodeURIComponent(path.slice(9))); output = {}; }
      else { res.writeHead(404).end(); return; }
      if (output === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  await writeFile(join(root, "connection.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, tokenFile: join(root, "token") }));
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTSTACK_STATE_DIR: dir, HOME: dir };
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
  const ctx = { backend, system: s.system, profiles };
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
    await profiles.close(); await backend.closeContext(); await s.close();
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
  try {
    await s.system.setHypemanLocation(s.root); await s.system.enableHypeman(s.root); await profiles.start(false);
    const own = await profiles.create("a", "own", true); await profiles.ensure(own.id);
    const extra = await profiles.create("a", "other"); await profiles.ensure(extra.id);
    const input = { profileId: own.id, requestId: randomUUID(), message: "Sign in" };
    await assert.rejects(profiles.requestHandoff(input, { ...invocation, threadId: "foreign" }), /sanctioned/);
    blocked = true;
    let h = await profiles.requestHandoff(input, invocation);
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
    profiles.onHandoffChange = () => { published.push(profiles.handoffs(null).find((row) => row.id === h.id)!.state); };
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
    profiles.onHandoffChange = undefined;
    await assert.rejects(profiles.actHandoff("finish", { ...finish, note: "changed" }), /conflicts/);
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
    // Native resource cleanup is exact and independent of the test handoff.
    for (const r of await backend.list()) if (r.target) await backend.close({ session: r.session, lease: r.lease, browserProfile: r.profile, browserTarget: r.target.name, backend: "local" });
    await backend.closeContext(); await server.close(); await s.close();
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
    const racing = profiles.requestHandoff({ profileId: removed.id, requestId: randomUUID(), message: "Too late" }, invocation);
    const refused = assert.rejects(racing, /does not belong/);
    // origin() performs two Bot reads; the third occurs inside the lifecycle
    // lock. Let origin finish, then release deletion without waiting for it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    continueDeletion(); await deletion; await checked; await refused;
    backend.get = get; verified = null;
    assert.ok(!profiles.handoffs(null).some((h) => h.profileId === removed.id));
    const other = await profiles.create(bot.id, "request collision"); await profiles.ensure(other.id);
    const sameRequest = randomUUID();
    const requests = await Promise.allSettled([profile.id, other.id].map((profileId) => profiles.requestHandoff({ profileId, requestId: sameRequest, message: "Same request" }, invocation)));
    assert.equal(requests.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(String((requests.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /conflicts/);
    const admitted = profiles.handoffs(null).find((h) => h.requestId === sameRequest)!;
    await profiles.actHandoff("cancel", { id: admitted.id, expectedRevision: admitted.revision, requestId: randomUUID() }, invocation);
    let h = await profiles.requestHandoff({ profileId: profile.id, targetId: "requested-tab", message: "Help", requestId: randomUUID() }, invocation);
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
    const request = { profileId: profile.id, message: "Unknown work", requestId: randomUUID() };
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
    }) as typeof import("@agentstack/api").socketCall;
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
      (async () => { throw new Error("owner socket closed"); }) as typeof import("@agentstack/api").socketCall)).success, true);
    assert.equal((await handleProvider(JSON.stringify({ protocol, type: "browser.launch", capability: "browser.provider", request: { session: "bot-1" } }), s.env, call)).success, false);
    const refused = await handleProvider(JSON.stringify({ protocol, type: "browser.launch", capability: "browser.provider", request: { session: "task" } }), s.env,
      (async () => ({ provider: "agentbrowse" })) as typeof import("@agentstack/api").socketCall);
    assert.equal(refused.success, false);
  } finally { await s.close(); }
});

test("owner's private agent-browser config leaves global settings alone", async () => {
  const s = await fixture();
  try {
    const path = prepareBrowserConfig(s.env);
    const config = JSON.parse(await readFile(path, "utf8")) as { provider: string; plugins: Array<{ command: string; args: string[] }> };
    assert.equal(config.provider, "agentstack");
    assert.equal(config.plugins[0]?.command, process.execPath);
    assert.match(config.plugins[0]?.args[0] ?? "", /packages\/browse\/dist\/src\/provider\.js$/);
  } finally { await s.close(); }
});

test("manual release observation requires exact acceptance; automatic checks only upgrade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-browser-updates-"));
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
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, AGENTSTACK_STATE_DIR: dir, PATH: `${bin}:/usr/bin:/bin`, TEST_LATEST: "0.39.0" };
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
