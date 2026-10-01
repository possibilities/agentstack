import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { operation, serveSocket, socketPath } from "@stack/api";
import { z } from "zod";
import { AccessStore } from "../src/store.js";
import { startRemoteUi } from "../src/remote-ui.js";

const freePort = async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
};
const open = (url: string, origin: string | undefined, cookie?: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url, { rejectUnauthorized: false, ...(origin ? { origin } : {}),
    ...(cookie ? { headers: { cookie } } : {}) });
  ws.once("open", () => resolve(ws)); ws.once("error", reject);
});
const frame = (ws: WebSocket) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("websocket response timed out")), 2_000);
  ws.once("message", raw => { clearTimeout(timer); resolve(JSON.parse(String(raw))); });
});
const call = async (ws: WebSocket, name: string) => {
  const response = frame(ws);
  ws.send(JSON.stringify({ id: 1, method: "tools/call", params: { package: "notify", name, arguments: {} } }));
  return response;
};

test("TLS WebSocket intersects live exposure, refuses cross-origin, and closes immediately on grant narrowing and revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "stack-remote-ws-"));
  const store = new AccessStore(root);
  const env = { STACK_STATE_DIR: root };
  const directory = join(root, "packages", "notify"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "api.yaml"), "name: notify\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: [notification_counts, notification_dismiss]\n  events: [changed]\n  description: WebSocket.\n");
  let writes = 0;
  const backend = await serveSocket({ info: { name: "notify", description: "Demo.", transportDescription: "Socket.", path: socketPath("notify", env) }, context: {},
    operations: [
      operation({ name: "notification_counts", description: "Read.", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), annotations: { readOnlyHint: true }, async call() { return { ok: true }; } }),
      operation({ name: "notification_dismiss", description: "Write.", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), async call() { writes++; return { ok: true }; } }),
    ], events: { topics: { changed: "Changed." } } });
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const port = await freePort();
  let online = true;
  const remote = await startRemoteUi({ store, env, host: "127.0.0.1", port, root,
    verify: async () => { if (!online) throw new Error("not verified"); } }, { key: readFileSync(key), cert: readFileSync(cert) });
  const origin = `https://127.0.0.1:${port}`, url = `wss://127.0.0.1:${port}/websocket`;
  const keyMaterial = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["ui:view", "ui:control"], redemptionSecret: keyMaterial });
  store.approve(pairing.id, pairing.code, true, ["ui:view"]);
  const credential = store.redeem(pairing.id, keyMaterial);
  const issued = store.startUi(credential.refreshToken, randomUUID());
  const cookie = `__Host-stack_ui=${issued.accessToken}`;
  let viewer: WebSocket | undefined, controller: WebSocket | undefined;
  try {
    await assert.rejects(open(url, origin), /403/);
    await assert.rejects(open(url, "https://evil.example", cookie), /403/);
    await assert.rejects(open(url, undefined, cookie), /403/);
    viewer = await open(url, origin, cookie);
    assert.equal((await call(viewer, "notification_counts")).result.ok, true);
    assert.match((await call(viewer, "notification_dismiss")).error.message, /not available/);
    assert.equal(writes, 0);
    // A new control session sees a new grant, but the old view connection is
    // terminated instead of inheriting powers when its grant changes.
    store.updateGrant(store.inventory().grants[0]!.id, 1, ["ui:view", "ui:control"], []);
    await new Promise<void>(resolve => viewer!.once("close", () => resolve()));
    const next = store.startUi(issued.refreshToken, randomUUID());
    controller = await open(url, origin, `__Host-stack_ui=${next.accessToken}`);
    const forged = frame(controller);
    controller.send(JSON.stringify({ id: "forged", method: "tools/call", params: {
      package: "notify", name: "notification_dismiss", arguments: {}, invocation: {},
    } }));
    assert.match((await forged).error.message, /invocation context/);
    assert.equal(writes, 0, "remote admission cannot bypass the shared caller-context fence");
    assert.equal((await call(controller, "notification_dismiss")).result.ok, true);
    assert.equal(writes, 1);
    const closed = new Promise<void>(resolve => controller!.once("close", () => resolve()));
    store.updateGrant(store.inventory().grants[0]!.id, 2, ["ui:view"], []);
    await closed;
    const narrowed = store.startUi(next.refreshToken, randomUUID());
    controller = await open(url, origin, `__Host-stack_ui=${narrowed.accessToken}`);
    assert.match((await call(controller, "notification_dismiss")).error.message, /not available/);
    const revoked = new Promise<void>(resolve => controller!.once("close", () => resolve()));
    store.revoke("credential", credential.credentialId);
    await revoked;
    await assert.rejects(open(url, origin, `__Host-stack_ui=${next.accessToken}`), /403/);
    online = false;
    await assert.rejects(open(url, origin, cookie), /403/);
    assert.ok(store.inventory().audit.some((item: any) => item.action === "ui_mutation"));
  } finally {
    viewer?.terminate(); controller?.terminate(); await remote.close(); await backend.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("remote control sessions receive only Scrape's read-only operations; fetching and queue writes stay local", async () => {
  const root = mkdtempSync(join(tmpdir(), "stack-remote-scrape-"));
  const store = new AccessStore(root);
  const env = { STACK_STATE_DIR: root };
  const directory = join(root, "packages", "scrape"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "api.yaml"), "name: scrape\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: [scrape_queue_list, scrape_queue_submit, scrape_fetch]\n  events: all\n  description: WebSocket.\n");
  let writes = 0;
  const ok = z.object({ ok: z.boolean() });
  const backend = await serveSocket({ info: { name: "scrape", description: "Demo.", transportDescription: "Socket.", path: socketPath("scrape", env) }, context: {},
    operations: [
      operation({ name: "scrape_queue_list", description: "Read.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { return { ok: true }; } }),
      operation({ name: "scrape_queue_submit", description: "Write.", input: z.strictObject({}), output: ok, async call() { writes++; return { ok: true }; } }),
      operation({ name: "scrape_fetch", description: "Network.", input: z.strictObject({}), output: ok, annotations: { openWorldHint: true }, async call() { writes++; return { ok: true }; } }),
    ], events: { topics: { scrape_queue_changed: "Changed." } } });
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const port = await freePort();
  const remote = await startRemoteUi({ store, env, host: "127.0.0.1", port, root, verify: async () => {} }, { key: readFileSync(key), cert: readFileSync(cert) });
  const keyMaterial = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["ui:view", "ui:control"], redemptionSecret: keyMaterial });
  store.approve(pairing.id, pairing.code, true, ["ui:view", "ui:control"]);
  const issued = store.startUi(store.redeem(pairing.id, keyMaterial).refreshToken, randomUUID());
  let ws: WebSocket | undefined;
  const send = async (method: string, params: Record<string, unknown>) => {
    const response = frame(ws!);
    ws!.send(JSON.stringify({ id: 1, method, params: { package: "scrape", ...params } }));
    return response;
  };
  try {
    ws = await open(`wss://127.0.0.1:${port}/websocket`, `https://127.0.0.1:${port}`, `__Host-stack_ui=${issued.accessToken}`);
    assert.deepEqual((await send("tools/list", {})).result.tools.map((tool: { name: string }) => tool.name), ["scrape_queue_list"]);
    assert.equal((await send("tools/call", { name: "scrape_queue_list", arguments: {} })).result.ok, true);
    for (const name of ["scrape_queue_submit", "scrape_fetch"])
      assert.match((await send("tools/call", { name, arguments: {} })).error.message, /not available/);
    assert.equal(writes, 0);
  } finally {
    ws?.terminate(); await remote.close(); await backend.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("remote UI cannot read Brain share jobs or use local Role, state and developer controls even with control scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "stack-remote-brain-"));
  const store = new AccessStore(root);
  const env = { STACK_STATE_DIR: root };
  const directory = join(root, "packages", "brain"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "api.yaml"), "name: brain\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: all\n  events: []\n  description: WebSocket.\n");
  let shareReads = 0;
  let maintenanceCalls = 0;
  const brainMaintenance = ["brain_jobs_plan", "brain_jobs_clear", "brain_runs_plan", "brain_runs_clear", "brain_source_plan", "brain_source_clear", "brain_artifacts_plan", "brain_artifacts_clear"];
  const ok = z.object({ ok: z.boolean() });
  const backend = await serveSocket({ info: { name: "brain", description: "Demo.", transportDescription: "Socket.", path: socketPath("brain", env) }, context: {},
    operations: [
      operation({ name: "jobs_show", description: "Read.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { return { ok: true }; } }),
      operation({ name: "share_read_states", description: "Trusted local read.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { shareReads++; return { ok: true }; } }),
      ...brainMaintenance.map(name => operation({ name, description: "Local maintenance.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { maintenanceCalls++; return { ok: true }; } })),
    ], events: { topics: {} } });
  const rolesDirectory = join(root, "packages", "roles"); mkdirSync(rolesDirectory, { recursive: true });
  writeFileSync(join(rolesDirectory, "api.yaml"), "name: roles\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: all\n  events: [role_shims_changed]\n  description: WebSocket.\n");
  let shimCalls = 0;
  const roles = await serveSocket({ info: { name: "roles", description: "Demo.", transportDescription: "Socket.", path: socketPath("roles", env) }, context: {},
    operations: [
      operation({ name: "roles_snapshot", description: "Catalog.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { return { ok: true }; } }),
      operation({ name: "role_shim_list", description: "Local PATH inventory.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { shimCalls++; return { ok: true }; } }),
      operation({ name: "role_shim_create", description: "Local PATH write.", input: z.strictObject({}), output: ok, async call() { shimCalls++; return { ok: true }; } }),
      ...["role_launch_list", "role_launch_plan", "role_launch_clear", "roles_state_receipt_get"].map(name => operation({ name, description: "Local launch maintenance.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { maintenanceCalls++; return { ok: true }; } })),
    ], events: { topics: { role_shims_changed: "Changed." } } });
  const botsDirectory = join(root, "packages", "bots"); mkdirSync(botsDirectory, { recursive: true });
  writeFileSync(join(botsDirectory, "api.yaml"), "name: bots\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: all\n  events: []\n  description: WebSocket.\n");
  let stateCalls = 0;
  const bots = await serveSocket({ info: { name: "bots", description: "Demo.", transportDescription: "Socket.", path: socketPath("bots", env) }, context: {},
    operations: ["bot_state_read", "bot_workspace_read", "bot_session_reset", "bot_recovery_discard", "bot_queue_bodies_clear", "chat_upload_read", "bot_settings_receipts_plan", "bot_settings_receipts_clear"].map(name => operation({
      name, description: "Local state.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: name.endsWith("read") },
      async call() { stateCalls++; return { ok: true }; },
    })) });
  const serveDirectory = join(root, "packages", "serve"); mkdirSync(serveDirectory, { recursive: true });
  writeFileSync(join(serveDirectory, "api.yaml"), "name: serve\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: all\n  events: all\n  description: WebSocket.\n");
  let developerCalls = 0;
  const server = await serveSocket({ info: { name: "serve", description: "Demo.", transportDescription: "Socket.", path: socketPath("serve", env) }, context: {},
    operations: ["serve_status", "serve_settings_read", "serve_settings_update", "serve_harness_releases", "serve_harness_releases_check"].map(name => operation({
      name, description: "Server control.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: !name.endsWith("update") && !name.endsWith("check") },
      async call() { developerCalls++; return { ok: true }; },
    })), events: { topics: { pids_changed: "Changed.", serve_settings_changed: "Settings changed.", harness_releases_changed: "Releases changed." } } });
  for (const owner of ["infer", "hud", "scrape", "signal", "worker", "auth", "access"]) {
    const dir = join(root, "packages", owner); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api.yaml"), `name: ${owner}\ndescription: Fixture.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: all\n  events: []\n  description: WebSocket.\n`);
  }
  const maintenance = await Promise.all(([ ["infer", ["infer_catalog_clear"]], ["hud", ["hud_history_plan", "hud_history_clear"]],
    ["scrape", ["scrape_queue_plan", "scrape_queue_apply", "scrape_corpus_list", "scrape_corpus_plan", "scrape_corpus_clear"]],
    ["signal", ["attention_checkpoint_plan", "attention_checkpoint_reset"]],
    ["worker", ["worker_settings_receipts_plan", "worker_settings_receipts_clear", "worker_state_receipt_get", "worker_account_state_dependencies"]],
    ["auth", ["worker_account_cache_plan", "worker_account_cache_clear", "auth_state_receipt_get"]],
    ["access", ["access_history_plan", "access_history_clear", "access_state_receipt_get"]] ] as const).map(([owner, names]) =>
    serveSocket({ info: { name: owner, description: "Fixture.", transportDescription: "Socket.", path: socketPath(owner, env) }, context: {},
      operations: names.map(name => operation({ name, description: "Local maintenance.", input: z.strictObject({}), output: ok,
        annotations: { readOnlyHint: true }, async call() { maintenanceCalls++; return { ok: true }; } })) })));
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const port = await freePort();
  const remote = await startRemoteUi({ store, env, host: "127.0.0.1", port, root, verify: async () => {} }, { key: readFileSync(key), cert: readFileSync(cert) });
  const secret = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["ui:view", "ui:control"], redemptionSecret: secret });
  store.approve(pairing.id, pairing.code, true, ["ui:view", "ui:control"]);
  const issued = store.startUi(store.redeem(pairing.id, secret).refreshToken, randomUUID());
  let ws: WebSocket | undefined;
  const send = async (method: string, params: Record<string, unknown>) => {
    const response = frame(ws!);
    ws!.send(JSON.stringify({ id: 1, method, params: { package: "brain", ...params } }));
    return response;
  };
  try {
    ws = await open(`wss://127.0.0.1:${port}/websocket`, `https://127.0.0.1:${port}`, `__Host-stack_ui=${issued.accessToken}`);
    assert.deepEqual((await send("tools/list", {})).result.tools.map((tool: { name: string }) => tool.name), ["jobs_show"]);
    assert.equal((await send("tools/call", { name: "jobs_show", arguments: {} })).result.ok, true);
    assert.match((await send("tools/call", { name: "share_read_states", arguments: {} })).error.message, /not available/);
    assert.equal(shareReads, 0);
    const rolesCall = async (method: string, params: Record<string, unknown>) => {
      const response = frame(ws!);
      ws!.send(JSON.stringify({ id: 2, method, params: { package: "roles", ...params } }));
      return response;
    };
    assert.deepEqual((await rolesCall("tools/list", {})).result.tools.map((tool: { name: string }) => tool.name), ["roles_snapshot"]);
    for (const name of ["role_shim_list", "role_shim_create", "role_launch_list", "role_launch_plan", "role_launch_clear", "roles_state_receipt_get"])
      assert.match((await rolesCall("tools/call", { name, arguments: {} })).error.message, /not available/);
    assert.match((await rolesCall("events/subscribe", { subscription: "s", topics: ["role_shims_changed"] })).error.message, /not available|selected|topic/i);
    assert.equal(shimCalls, 0);
    for (const name of ["bot_state_read", "bot_workspace_read", "bot_session_reset", "bot_recovery_discard", "bot_queue_bodies_clear", "chat_upload_read", "bot_settings_receipts_plan", "bot_settings_receipts_clear"])
      assert.match((await send("tools/call", { package: "bots", name, arguments: {} })).error.message, /not available/);
    assert.equal(stateCalls, 0);
    for (const [owner, names] of [["infer", ["infer_catalog_clear"]], ["hud", ["hud_history_plan", "hud_history_clear"]],
      ["brain", ["brain_jobs_plan", "brain_jobs_clear", "brain_runs_plan", "brain_runs_clear", "brain_source_plan", "brain_source_clear", "brain_artifacts_plan", "brain_artifacts_clear"]],
      ["scrape", ["scrape_queue_plan", "scrape_queue_apply", "scrape_corpus_list", "scrape_corpus_plan", "scrape_corpus_clear"]],
      ["signal", ["attention_checkpoint_plan", "attention_checkpoint_reset"]],
      ["worker", ["worker_settings_receipts_plan", "worker_settings_receipts_clear", "worker_state_receipt_get", "worker_account_state_dependencies"]],
      ["auth", ["worker_account_cache_plan", "worker_account_cache_clear", "auth_state_receipt_get"]],
      ["access", ["access_history_plan", "access_history_clear", "access_state_receipt_get"]]] as const) {
      assert.deepEqual((await send("tools/list", { package: owner })).result.tools.map((tool: { name: string }) => tool.name), owner === "brain" ? ["jobs_show"] : []);
      for (const name of names) assert.match((await send("tools/call", { package: owner, name, arguments: {} })).error.message, /not available/);
    }
    assert.equal(maintenanceCalls, 0, "even read-only annotations cannot expose local maintenance");
    const listed = await send("tools/list", { package: "serve" });
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["serve_status"]);
    assert.equal((await send("tools/call", { package: "serve", name: "serve_status", arguments: {} })).result.ok, true);
    for (const name of ["serve_settings_read", "serve_settings_update", "serve_harness_releases", "serve_harness_releases_check"])
      assert.match((await send("tools/call", { package: "serve", name, arguments: {} })).error.message, /not available/);
    for (const topic of ["serve_settings_changed", "harness_releases_changed"])
      assert.match((await send("events/subscribe", { package: "serve", subscription: topic, topics: [topic] })).error.message, /not available|selected|topic/i);
    assert.equal(developerCalls, 1, "only existing server status reaches the private socket");
  } finally {
    ws?.terminate(); await remote.close(); for (const owner of maintenance) await owner.close(); await server.close(); await bots.close(); await roles.close(); await backend.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

for (const [owner, names, topic] of [
  ["proc", ["proc_run_list", "proc_run_read", "proc_run_start"], "proc_runs_changed"],
  ["xcom", ["xcom_status", "xcom_get", "xcom_history_clear"], "archive_changed"],
] as const) test(`remote UI sessions receive no ${owner} operations or events at all`, async () => {
  const root = mkdtempSync(join(tmpdir(), "stack-remote-proc-"));
  const store = new AccessStore(root);
  const env = { STACK_STATE_DIR: root };
  const directory = join(root, "packages", owner); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "api.yaml"), `name: ${owner}\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: [${names.join(", ")}]\n  events: [${topic}]\n  description: WebSocket.\n`);
  let reads = 0;
  const ok = z.object({ ok: z.boolean() });
  const backend = await serveSocket({ info: { name: owner, description: "Demo.", transportDescription: "Socket.", path: socketPath(owner, env) }, context: {},
    operations: [
      operation({ name: names[0], description: "Read.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { reads++; return { ok: true }; } }),
      operation({ name: names[1], description: "Read.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { reads++; return { ok: true }; } }),
      operation({ name: names[2], description: "Write.", input: z.strictObject({}), output: ok, async call() { reads++; return { ok: true }; } }),
    ], events: { topics: { [topic]: "Changed." } } });
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const port = await freePort();
  const remote = await startRemoteUi({ store, env, host: "127.0.0.1", port, root, verify: async () => {} }, { key: readFileSync(key), cert: readFileSync(cert) });
  const secret = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["ui:view", "ui:control"], redemptionSecret: secret });
  store.approve(pairing.id, pairing.code, true, ["ui:view", "ui:control"]);
  const issued = store.startUi(store.redeem(pairing.id, secret).refreshToken, randomUUID());
  let ws: WebSocket | undefined;
  const send = async (method: string, params: Record<string, unknown>) => {
    const response = frame(ws!);
    ws!.send(JSON.stringify({ id: 1, method, params: { package: owner, ...params } }));
    return response;
  };
  try {
    ws = await open(`wss://127.0.0.1:${port}/websocket`, `https://127.0.0.1:${port}`, `__Host-stack_ui=${issued.accessToken}`);
    // Local-only owners stay unavailable even for read-only operations or a control grant.
    assert.deepEqual((await send("tools/list", {})).result.tools, []);
    for (const name of names)
      assert.match((await send("tools/call", { name, arguments: {} })).error.message, /not available/);
    assert.equal(reads, 0);
    const subscribed = frame(ws);
    ws.send(JSON.stringify({ id: 9, method: "events/subscribe", params: { package: owner, subscription: "s", topics: [topic] } }));
    assert.match((await subscribed).error.message, /not available/);
  } finally {
    ws?.terminate(); await remote.close(); await backend.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("remote HUD sessions read work under ui:view and collaborate only under a live ui:control grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "stack-remote-hud-"));
  const store = new AccessStore(root);
  const env = { STACK_STATE_DIR: root };
  const directory = join(root, "packages", "hud"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "api.yaml"), "name: hud\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  operations: [work_get, work_update, work_note_add]\n  events: [hud_changed]\n  description: WebSocket.\n");
  const writes: string[] = [];
  const ok = z.object({ ok: z.boolean() });
  const backend = await serveSocket({ info: { name: "hud", description: "Demo.", transportDescription: "Socket.", path: socketPath("hud", env) }, context: {},
    operations: [
      operation({ name: "work_get", description: "Read.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { return { ok: true }; } }),
      operation({ name: "work_update", description: "Write.", input: z.strictObject({}), output: ok, annotations: { idempotentHint: true }, async call() { writes.push("work_update"); return { ok: true }; } }),
      operation({ name: "work_note_add", description: "Write.", input: z.strictObject({}), output: ok, annotations: { idempotentHint: true }, async call() { writes.push("work_note_add"); return { ok: true }; } }),
      // Selected for the socket only: Worker admission context resolution never reaches a browser.
      operation({ name: "work_context_resolve", description: "Internal.", input: z.strictObject({}), output: ok, annotations: { readOnlyHint: true }, async call() { return { ok: true }; } }),
    ], events: { topics: { hud_changed: "Changed." } } });
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const port = await freePort();
  const remote = await startRemoteUi({ store, env, host: "127.0.0.1", port, root, verify: async () => {} }, { key: readFileSync(key), cert: readFileSync(cert) });
  const origin = `https://127.0.0.1:${port}`, url = `wss://127.0.0.1:${port}/websocket`;
  const keyMaterial = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["ui:view", "ui:control"], redemptionSecret: keyMaterial });
  store.approve(pairing.id, pairing.code, true, ["ui:view"]);
  const credential = store.redeem(pairing.id, keyMaterial);
  const viewing = store.startUi(credential.refreshToken, randomUUID());
  let ws: WebSocket | undefined;
  const send = async (method: string, params: Record<string, unknown>) => {
    const response = frame(ws!);
    ws!.send(JSON.stringify({ id: 1, method, params: { package: "hud", ...params } }));
    return response;
  };
  const tools = async () => (await send("tools/list", {})).result.tools.map((tool: { name: string }) => tool.name).sort();
  try {
    ws = await open(url, origin, `__Host-stack_ui=${viewing.accessToken}`);
    assert.deepEqual(await tools(), ["work_get"]);
    assert.equal((await send("tools/call", { name: "work_get", arguments: {} })).result.ok, true);
    for (const name of ["work_update", "work_note_add", "work_context_resolve"])
      assert.match((await send("tools/call", { name, arguments: {} })).error.message, /not available/);
    assert.deepEqual(writes, [], "a viewer never reaches a HUD write");

    const upgraded = new Promise<void>(resolve => ws!.once("close", () => resolve()));
    store.updateGrant(store.inventory().grants[0]!.id, 1, ["ui:view", "ui:control"], []);
    await upgraded;
    const controlling = store.startUi(viewing.refreshToken, randomUUID());
    ws = await open(url, origin, `__Host-stack_ui=${controlling.accessToken}`);
    assert.deepEqual(await tools(), ["work_get", "work_note_add", "work_update"]);
    assert.equal((await send("tools/call", { name: "work_update", arguments: {} })).result.ok, true);
    assert.equal((await send("tools/call", { name: "work_note_add", arguments: {} })).result.ok, true);
    assert.match((await send("tools/call", { name: "work_context_resolve", arguments: {} })).error.message, /not available/);
    assert.deepEqual(writes, ["work_update", "work_note_add"]);
    assert.ok(store.inventory().audit.some((item: any) => item.action === "ui_mutation" && /:hud\.work_update$/.test(item.subject)));

    const revoked = new Promise<void>(resolve => ws!.once("close", () => resolve()));
    store.revoke("credential", credential.credentialId);
    await revoked;
    await assert.rejects(open(url, origin, `__Host-stack_ui=${controlling.accessToken}`), /403/);
    assert.deepEqual(writes, ["work_update", "work_note_add"], "a revoked grant admits no further writes");
  } finally {
    ws?.terminate(); await remote.close(); await backend.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
