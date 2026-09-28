import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { operation, serveSocket, socketPath } from "@agentstack/api";
import { z } from "zod";
import { AccessStore } from "../src/store.js";
import { startRemoteUix } from "../src/remote-uix.js";

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
  const root = mkdtempSync(join(tmpdir(), "agentstack-remote-ws-"));
  const store = new AccessStore(root);
  const env = { AGENTSTACK_STATE_DIR: root };
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
  const remote = await startRemoteUix({ store, env, host: "127.0.0.1", port, root,
    verify: async () => { if (!online) throw new Error("not verified"); } }, { key: readFileSync(key), cert: readFileSync(cert) });
  const origin = `https://127.0.0.1:${port}`, url = `wss://127.0.0.1:${port}/websocket`;
  const keyMaterial = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["uix:view", "uix:control"], redemptionSecret: keyMaterial });
  store.approve(pairing.id, pairing.code, true, ["uix:view"]);
  const credential = store.redeem(pairing.id, keyMaterial);
  const issued = store.startUix(credential.refreshToken, randomUUID());
  const cookie = `__Host-agentstack_uix=${issued.accessToken}`;
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
    store.updateGrant(store.inventory().grants[0]!.id, 1, ["uix:view", "uix:control"], []);
    await new Promise<void>(resolve => viewer!.once("close", () => resolve()));
    const next = store.startUix(issued.refreshToken, randomUUID());
    controller = await open(url, origin, `__Host-agentstack_uix=${next.accessToken}`);
    const forged = frame(controller);
    controller.send(JSON.stringify({ id: "forged", method: "tools/call", params: {
      package: "notify", name: "notification_dismiss", arguments: {}, invocation: {},
    } }));
    assert.match((await forged).error.message, /invocation context/);
    assert.equal(writes, 0, "remote admission cannot bypass the shared caller-context fence");
    assert.equal((await call(controller, "notification_dismiss")).result.ok, true);
    assert.equal(writes, 1);
    const closed = new Promise<void>(resolve => controller!.once("close", () => resolve()));
    store.updateGrant(store.inventory().grants[0]!.id, 2, ["uix:view"], []);
    await closed;
    const narrowed = store.startUix(next.refreshToken, randomUUID());
    controller = await open(url, origin, `__Host-agentstack_uix=${narrowed.accessToken}`);
    assert.match((await call(controller, "notification_dismiss")).error.message, /not available/);
    const revoked = new Promise<void>(resolve => controller!.once("close", () => resolve()));
    store.revoke("credential", credential.credentialId);
    await revoked;
    await assert.rejects(open(url, origin, `__Host-agentstack_uix=${next.accessToken}`), /403/);
    online = false;
    await assert.rejects(open(url, origin, cookie), /403/);
    assert.ok(store.inventory().audit.some((item: any) => item.action === "uix_mutation"));
  } finally {
    viewer?.terminate(); controller?.terminate(); await remote.close(); await backend.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("remote control sessions receive only Scrape's read-only operations; fetching and queue writes stay local", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-remote-scrape-"));
  const store = new AccessStore(root);
  const env = { AGENTSTACK_STATE_DIR: root };
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
  const remote = await startRemoteUix({ store, env, host: "127.0.0.1", port, root, verify: async () => {} }, { key: readFileSync(key), cert: readFileSync(cert) });
  const keyMaterial = randomBytes(32).toString("base64url");
  const pairing = store.pair({ requestId: randomUUID(), label: "browser", kind: "browser", scopes: ["uix:view", "uix:control"], redemptionSecret: keyMaterial });
  store.approve(pairing.id, pairing.code, true, ["uix:view", "uix:control"]);
  const issued = store.startUix(store.redeem(pairing.id, keyMaterial).refreshToken, randomUUID());
  let ws: WebSocket | undefined;
  const send = async (method: string, params: Record<string, unknown>) => {
    const response = frame(ws!);
    ws!.send(JSON.stringify({ id: 1, method, params: { package: "scrape", ...params } }));
    return response;
  };
  try {
    ws = await open(`wss://127.0.0.1:${port}/websocket`, `https://127.0.0.1:${port}`, `__Host-agentstack_uix=${issued.accessToken}`);
    assert.deepEqual((await send("tools/list", {})).result.tools.map((tool: { name: string }) => tool.name), ["scrape_queue_list"]);
    assert.equal((await send("tools/call", { name: "scrape_queue_list", arguments: {} })).result.ok, true);
    for (const name of ["scrape_queue_submit", "scrape_fetch"])
      assert.match((await send("tools/call", { name, arguments: {} })).error.message, /not available/);
    assert.equal(writes, 0);
  } finally {
    ws?.terminate(); await remote.close(); await backend.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
