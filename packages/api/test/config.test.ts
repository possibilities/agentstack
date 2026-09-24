import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseConfig } from "../src/config.js";
import { loadPackageApi } from "../src/catalog.js";
import { serveApi } from "../src/serve.js";
import { findPackage, workspaceRoot } from "../src/workspace.js";

test("bots declares socket, MCP, and WebSocket transports", async () => {
  const root = workspaceRoot(dirname(fileURLToPath(import.meta.url)));
  const bots = await findPackage(root, "bots");
  assert.equal(bots.config.name, "bots");
  assert.match(bots.config.description, /Codex bots/);
  assert.ok(bots.config.socket && bots.config.mcp && bots.config.websocket);
  const botsApi = await loadPackageApi(bots.dir);
  assert.deepEqual(Object.keys(botsApi.events?.topics ?? {}).sort(), ["bots_changed", "threads_changed", "voice_changed"]);
});

test("a package API loads from the built sibling api.ts without an index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-api-entry-"));
  try {
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    await writeFile(join(dir, "dist", "api.js"), "export const api = { operations: [] };\n");
    const api = await loadPackageApi(dir);
    assert.deepEqual(api.operations, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config rejects unknown transports and empty blurbs", () => {
  assert.throws(() => parseConfig("name: demo\ndescription: Demo.\nhttp: {}\n"), /http/);
  assert.throws(() => parseConfig("name: demo\ndescription: '  '\nsocket:\n  description: Demo socket.\n"), /description/);
});

test("WebSocket uses Package API events rather than transport-specific pubsub", () => {
  const parsed = parseConfig("name: demo\ndescription: Demo.\nwebsocket:\n  description: Browser operations and events.\n");
  assert.match(parsed.websocket?.description ?? "", /Browser/);
  assert.throws(() => parseConfig("name: demo\ndescription: Demo.\nwebsocket:\n  description: Demo events.\n  pubsub:\n    pids_changed: Fired.\n"), /pubsub/);
  assert.throws(
    () => parseConfig("name: demo\ndescription: Demo.\nsocket:\n  description: Demo socket.\n  pubsub:\n    pids_changed: Fired.\n"),
    /pubsub|Unrecognized/,
  );
});

test("individual WebSocket launch is refused in favor of the shared listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-ws-config-"));
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nwebsocket:\n  description: WebSocket.\n");
  try {
    await assert.rejects(serveApi({ name: "demo", transport: "websocket", root }), /agentstack websocket/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("individual mcp launch is refused in favor of the shared HTTP process", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-api-config-"));
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "api.yaml"),
    "name: demo\ndescription: Demo operations.\nmcp:\n  description: MCP transport for demo operations.\n",
  );
  try {
    await assert.rejects(serveApi({ name: "demo", transport: "mcp", root }), /agentstack mcp/);
    await assert.rejects(serveApi({ name: "demo", transport: "socket", root }), /does not configure socket/);
    await assert.rejects(serveApi({ name: "demo", transport: "websocket", root }), /does not configure websocket/);
    await assert.rejects(serveApi({ name: "missing", transport: "socket", root }), /no package API named missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
