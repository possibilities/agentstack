import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexToolsDiagnostics, serveSocket, socketCall, socketSubscribe, type InvocationContext } from "@stack/api";
import { api, serverHarnessReleases, serverHarnessReleasesCheck, serverSettingsRead, serverSettingsUpdate, type ServerContext } from "../api.js";
import { DeveloperService } from "../src/developer/service.js";
import { harnessReleases, serveSettings, type HarnessReleases } from "../src/developer/schema.js";
import { ResourceMonitor } from "../src/resources/monitor.js";
import { StatusSource } from "../src/status.js";

const interval = 6 * 60 * 60 * 1000;
const epoch = Date.parse("2026-09-30T12:00:00.000Z");
const channels = new Map([
  ["https://registry.npmjs.org/@opencode/cli/latest", { name: "@opencode/cli", version: "2.0.20" }],
  ["https://registry.npmjs.org/@openai/codex/latest", { name: "@openai/codex", version: "0.159.2" }],
  ["https://registry.npmjs.org/@anthropic-ai/claude-code/latest", { name: "@anthropic-ai/claude-code", version: "2.1.285" }],
  ["https://static.devin.ai/cli/current/manifest.json", { version: "3000.11.3", platforms: { "darwin-arm64": {} } }],
]);
const response = (url: string) => { assert.ok(channels.has(url), `unexpected network destination: ${url}`); return Response.json(channels.get(url)); };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stack-developer-"));
  const env = { STACK_STATE_DIR: root };
  const service = new DeveloperService(env);
  return { root, env, service, async close() { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function completed(service: DeveloperService): Promise<HarnessReleases> {
  await turn();
  const snapshot = harnessReleases.parse(service.snapshot());
  assert.equal(snapshot.checking, null, "bounded fixture responses should complete without polling or a model turn");
  return snapshot;
}

test("developer mode defaults off without probes or writes; enable, periodic checks and restart preserve revision and cadence", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const fetcher = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    return response(url);
  });
  const f = fixture();
  let restarted: DeveloperService | undefined;
  try {
    f.service.start();
    assert.deepEqual(f.service.settings(), { developerMode: false, revision: 0, updatedAt: null });
    t.mock.timers.tick(interval * 2);
    assert.throws(() => f.service.snapshot(), /developer_mode_disabled/);
    assert.throws(() => f.service.check(), /developer_mode_disabled/);
    assert.equal(fetcher.mock.callCount(), 0);
    assert.deepEqual(readdirSync(f.root), []);
    const saved = f.service.update({ developerMode: true, expectedRevision: 0 });
    assert.equal(saved.revision, 1);
    assert.throws(() => f.service.update({ developerMode: false, expectedRevision: 0 }), /revision_conflict/);
    assert.deepEqual(f.service.update({ developerMode: true, expectedRevision: 1 }), saved);
    t.mock.timers.tick(0);
    const first = await completed(f.service);
    assert.equal(fetcher.mock.callCount(), 4);
    assert.ok(first.observations.every(row => row.freshness === "fresh" && row.error === null && row.previousVersion === null && row.changedAt === null));
    assert.deepEqual(first.observations.map(row => row.version), ["2.0.20", "0.159.2", "2.1.285", "3000.11.3"]);
    const cachePath = join(f.root, "serve", "harness-releases.json");
    const before = readFileSync(cachePath, "utf8");
    f.service.snapshot(); f.service.settings();
    assert.equal(readFileSync(cachePath, "utf8"), before, "reads are side-effect-free");
    for (const name of ["settings.json", "harness-releases.json"]) assert.equal(statSync(join(f.root, "serve", name)).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(f.root, "serve")).sort(), ["harness-releases.json", "settings.json"]);
    await f.service.close();
    t.mock.timers.tick(60_000);
    restarted = new DeveloperService(f.env);
    restarted.start();
    assert.deepEqual(restarted.settings(), saved);
    assert.ok(restarted.snapshot().observations.every(row => row.freshness === "stale" && row.staleReason === "restart"));
    t.mock.timers.tick(interval - 60_001);
    assert.equal(fetcher.mock.callCount(), 4, "restart does not probe before the retained due time");
    t.mock.timers.tick(1);
    const second = await completed(restarted);
    assert.equal(fetcher.mock.callCount(), 8);
    assert.ok(second.observations.every(row => row.freshness === "fresh"));
    restarted.update({ developerMode: false, expectedRevision: 1 });
    t.mock.timers.tick(interval * 4);
    assert.equal(fetcher.mock.callCount(), 8, "disabled recurrence has stopped");
    await restarted.close();
    restarted = new DeveloperService(f.env);
    assert.equal(restarted.settings().developerMode, false);
    restarted.start();
    t.mock.timers.tick(interval);
    assert.equal(fetcher.mock.callCount(), 8);
    restarted.update({ developerMode: true, expectedRevision: 2 });
    t.mock.timers.tick(0);
    await completed(restarted);
    assert.equal(fetcher.mock.callCount(), 12, "overdue enable coalesces missed intervals into one check");
  } finally { await restarted?.close(); await f.close(); }
});

test("check admission deduplicates; disable aborts and fences even late responses across re-enable", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  const requests: Array<{ url: string; signal: AbortSignal; finish(value: Response): void }> = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => new Promise<Response>(finish => requests.push({ url, signal: init.signal!, finish })));
  const f = fixture();
  try {
    f.service.start();
    f.service.update({ developerMode: true, expectedRevision: 0 });
    const first = f.service.check();
    assert.equal(first.admitted, true); assert.ok(f.service.snapshot().checking);
    assert.deepEqual(f.service.check(), { admitted: false, startedAt: first.startedAt }); assert.equal(requests.length, 4);
    const recoveredAdmission = new DeveloperService(f.env);
    try {
      assert.ok(recoveredAdmission.snapshot().observations.every(row => row.outcome === "interrupted" && row.error?.code === "interrupted"),
        "a new owner recognizes the actual persisted in-flight admission as interrupted");
    } finally { await recoveredAdmission.close(); }
    f.service.update({ developerMode: false, expectedRevision: 1 });
    assert.ok(requests.every(request => request.signal.aborted));
    assert.throws(() => f.service.snapshot(), /developer_mode_disabled/);
    f.service.update({ developerMode: true, expectedRevision: 2 });
    assert.ok(f.service.snapshot().observations.every(row => row.outcome === "interrupted"));
    assert.equal(f.service.check().admitted, true);
    assert.equal(requests.length, 8);
    for (const request of requests.slice(4)) request.finish(response(request.url));
    const accepted = await completed(f.service);
    for (const request of requests.slice(0, 4)) request.finish(Response.json({ name: channels.get(request.url)?.name, version: "99.0.0", platforms: { test: {} } }));
    await turn();
    assert.deepEqual(f.service.snapshot(), accepted, "revoked generation cannot overwrite new observations");
    f.service.check();
    const closing = f.service.close();
    assert.ok(requests.slice(8).every(request => request.signal.aborted), "shutdown aborts active observations");
    for (const request of requests.slice(8)) request.finish(response(request.url));
    await closing;
    t.mock.timers.tick(interval * 2);
    assert.equal(requests.length, 12, "shutdown removes recurrence");
    const restarted = new DeveloperService(f.env);
    try {
      assert.deepEqual(restarted.snapshot().observations.map(row => row.version), accepted.observations.map(row => row.version));
      assert.ok(restarted.snapshot().observations.every(row => row.outcome === "interrupted" && row.freshness === "stale"));
    } finally { await restarted.close(); }
  } finally {
    for (const request of requests) request.finish(response(request.url));
    await f.close();
  }
});

test("partial failures retain good releases and sanitized errors; successful channel differences retain previous version", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  let round = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (round === 1 && url.includes("@openai/")) return new Response("secret upstream text", { status: 429 });
    if (round === 1 && url.includes("@anthropic-ai/")) return Response.json({ name: "wrong-package", version: "2.2.0" });
    if (round === 1 && url.includes("static.devin")) throw new Error("https://secret.invalid/?token=sensitive");
    if (round >= 1 && url.includes("@opencode/")) return Response.json({ name: "@opencode/cli", version: "2.1.0" });
    return response(url);
  });
  const f = fixture();
  try {
    f.service.update({ developerMode: true, expectedRevision: 0 });
    f.service.check();
    const first = await completed(f.service);
    round = 1; t.mock.timers.tick(1000);
    f.service.check();
    const partial = await completed(f.service);
    const changed = partial.observations[0];
    assert.equal(changed.version, "2.1.0"); assert.equal(changed.previousVersion, "2.0.20");
    assert.equal(changed.changedAt, "2026-09-30T12:00:01.000Z");
    assert.equal(changed.freshness, "fresh");
    assert.deepEqual(partial.observations.slice(1).map(row => row.error?.code), ["rate_limited", "invalid_response", "network_error"]);
    for (let i = 1; i < 4; i++) {
      const failed = partial.observations[i];
      assert.equal(failed.version, first.observations[i].version);
      assert.equal(failed.lastSuccessAt, first.observations[i].lastSuccessAt);
      assert.equal(failed.freshness, "stale"); assert.equal(failed.staleReason, "check_failed");
      assert.equal(failed.outcome, "failed");
    }
    assert.doesNotMatch(JSON.stringify(partial), /secret|sensitive|wrong-package/);
    const restored = new DeveloperService(f.env);
    try { assert.equal(restored.snapshot().observations[1].version, "0.159.2"); assert.equal(restored.snapshot().observations[1].error?.code, "rate_limited"); }
    finally { await restored.close(); }
    round = 2; f.service.check();
    const recovered = await completed(f.service);
    assert.ok(recovered.observations.every(row => row.freshness === "fresh" && row.error === null));
    assert.equal(recovered.observations[0].changedAt, changed.changedAt, "the same version does not become another change");
    t.mock.timers.tick(interval);
    assert.ok(f.service.snapshot().observations.every(row => row.freshness === "stale" && row.staleReason === "expired"));
  } finally { await f.close(); }
});

test("malformed, oversized and stalled release responses fail boundedly without asserting versions", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("@opencode/")) return Response.json({ name: "@opencode/cli", version: "<script>bad</script>" });
    if (url.includes("@openai/")) return new Response("{", { headers: { "content-type": "application/json" } });
    if (url.includes("@anthropic-ai/")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); controller.close(); } }), { headers: { "content-type": "application/json" } });
    return new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener("abort", () => controller.error(new Error("stalled stream")), { once: true }); } }), { headers: { "content-type": "application/json" } });
  });
  const f = fixture();
  try {
    f.service.update({ developerMode: true, expectedRevision: 0 });
    f.service.check();
    await turn();
    assert.ok(f.service.snapshot().checking);
    t.mock.timers.tick(15_000);
    const failed = await completed(f.service);
    assert.deepEqual(failed.observations.map(row => row.error?.code), ["invalid_response", "invalid_response", "response_too_large", "timeout"]);
    assert.ok(failed.observations.every(row => row.version === null && row.freshness === "unobserved" && row.lastSuccessAt === null));
  } finally { await f.close(); }
});

test("corrupt settings fail closed; corrupt caches report uncertainty and failed persistence admits no networking", async t => {
  const fetcher = t.mock.method(globalThis, "fetch", async (url: string) => response(url));
  const f = fixture();
  let restored: DeveloperService | undefined;
  try {
    f.service.update({ developerMode: true, expectedRevision: 0 });
    f.service.check(); await completed(f.service); await f.service.close();
    const cache = join(f.root, "serve", "harness-releases.json");
    writeFileSync(cache, "invalid cache");
    restored = new DeveloperService(f.env);
    assert.equal(restored.snapshot().cacheError?.code, "cache_read_failed");
    assert.ok(restored.snapshot().observations.every(row => row.version === null));
    rmSync(cache); mkdirSync(cache);
    assert.throws(() => restored!.check(), /cache_write_failed/);
    assert.equal(fetcher.mock.callCount(), 4, "cache admission failure performs no network request");
    assert.equal(restored.snapshot().cacheError?.code, "cache_write_failed");
    assert.equal(restored.snapshot().checking, null);
    assert.ok(!readdirSync(join(f.root, "serve")).some(name => name.endsWith(".tmp")));
    writeFileSync(join(f.root, "serve", "settings.json"), "invalid settings");
    assert.throws(() => new DeveloperService(f.env), /serve_settings_invalid/);
  } finally { await restored?.close(); await f.close(); }
});

test("socket API validates settings, refuses non-operator identities, and publishes payload-free invalidations", async t => {
  t.mock.method(globalThis, "fetch", async (url: string) => response(url));
  const f = fixture();
  const context: ServerContext = { source: new StatusSource(), resources: new ResourceMonitor({ roots: () => new StatusSource().resourceRoots(), env: f.env }),
    codexTools: new CodexToolsDiagnostics(f.env), developer: f.service, env: f.env };
  const operations = [serverSettingsRead, serverSettingsUpdate, serverHarnessReleases, serverHarnessReleasesCheck];
  const socket = await serveSocket({ info: { path: join(f.root, "serve.sock"), name: "serve", description: "Test.", transportDescription: "Test." },
    context, operations, events: { topics: api.events!.topics } });
  const stop = await api.events!.start(context, topic => socket.publish!(topic));
  const received: string[] = [];
  const subscription = await socketSubscribe(socket.path, ["serve_settings_changed", "harness_releases_changed"], topic => received.push(topic));
  const call = (name: string, args = {}, invocation?: InvocationContext) => socketCall(socket.path, "tools/call", { name, arguments: args, ...(invocation ? { invocation } : {}) });
  try {
    assert.equal(serveSettings.parse(await call("serve_settings_read")).developerMode, false);
    await assert.rejects(call("serve_harness_releases"), /developer_mode_disabled/);
    await assert.rejects(call("serve_harness_releases_check"), /developer_mode_disabled/);
    await assert.rejects(call("serve_settings_update", { developerMode: "true", expectedRevision: 0 }), /boolean/);
    assert.equal(serveSettings.parse(await call("serve_settings_update", { developerMode: true, expectedRevision: 0 })).revision, 1);
    const base = { botId: null, instance: null, threadId: null, sessionId: null };
    const callers: InvocationContext[] = [
      { transport: "mcp", ...base },
      { transport: "mcp", ...base, botId: "bot-1", instance: "launch", threadId: "root" },
      { transport: "mcp", ...base, workerId: "worker", workerInstance: "runtime" },
      { transport: "proc", ...base, scheduleId: randomUUID(), executionId: randomUUID(), authority: { kind: "system", name: "brain-source-sync" } },
      { transport: "proc", ...base, botId: "bot-1", instance: "launch", threadId: "root", scheduleId: randomUUID(), executionId: randomUUID(), authority: { kind: "bot", botId: "bot-1", mainThreadId: "root", threadId: "root" } },
    ];
    for (const invocation of callers) for (const operation of operations)
      await assert.rejects(call(operation.name, operation === serverSettingsUpdate ? { developerMode: false, expectedRevision: 1 } : {}, invocation), /local operator authority/);
    const operator: InvocationContext = { transport: "proc", ...base, scheduleId: randomUUID(), executionId: randomUUID(), authority: { kind: "operator" } };
    assert.equal(serveSettings.parse(await call("serve_settings_read", {}, operator)).developerMode, true);
    assert.equal((await call("serve_harness_releases_check") as { admitted: boolean }).admitted, true);
    await completed(f.service);
    assert.ok(harnessReleases.parse(await call("serve_harness_releases")).observations.every(row => row.version));
    assert.ok(received.includes("serve_settings_changed")); assert.ok(received.includes("harness_releases_changed"));
    assert.ok(received.every(topic => typeof topic === "string"));
    assert.ok(existsSync(join(f.root, "serve", "settings.json")));
  } finally { stop?.(); await subscription.close(); await socket.close(); await context.resources.close(); await context.codexTools.close(); await f.close(); }
});
