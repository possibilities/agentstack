import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseConfig } from "../src/config.js";
import { serveApi } from "../src/serve.js";
import { findPackage, workspaceRoot } from "../src/workspace.js";

test("codex declares one namespaced socket server", async () => {
  const root = workspaceRoot(dirname(fileURLToPath(import.meta.url)));
  const codex = await findPackage(root, "codex");
  assert.equal(codex.config.name, "codex");
  assert.match(codex.config.description, /Start, stop, and list/);
  assert.match(codex.config.socket?.description ?? "", /codex/);
  assert.equal(codex.config.mcp, undefined);
  assert.deepEqual(Object.keys(codex.config.websocket?.pubsub ?? {}), ["servers_changed", "accounts_changed", "threads_changed"]);
});

test("config rejects unknown transports and empty blurbs", () => {
  assert.throws(() => parseConfig("name: demo\ndescription: Demo.\nhttp: {}\n"), /http/);
  assert.throws(() => parseConfig("name: demo\ndescription: '  '\nsocket:\n  description: Demo socket.\n"), /description/);
});

test("websocket pubsub topics follow operation names and need descriptions", () => {
  const parsed = parseConfig(
    "name: demo\ndescription: Demo.\nwebsocket:\n  description: Demo events.\n  pubsub:\n    pids_changed: Fired when pids change.\n",
  );
  assert.deepEqual(parsed.websocket?.pubsub, { pids_changed: "Fired when pids change." });
  assert.throws(
    () => parseConfig("name: demo\ndescription: Demo.\nwebsocket:\n  description: Demo events.\n  pubsub:\n    Bad_Topic: Fired.\n"),
    /pubsub/,
  );
  assert.throws(
    () => parseConfig("name: demo\ndescription: Demo.\nwebsocket:\n  description: Demo events.\n  pubsub:\n    pids_changed: ''\n"),
    /description/,
  );
  assert.throws(
    () => parseConfig("name: demo\ndescription: Demo.\nsocket:\n  description: Demo socket.\n  pubsub:\n    pids_changed: Fired.\n"),
    /pubsub|Unrecognized/,
  );
});

test("unimplemented transports are refused before the package is loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-api-config-"));
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "api.yaml"),
    "name: demo\ndescription: Demo operations.\nmcp:\n  description: MCP transport for demo operations.\n",
  );
  try {
    await assert.rejects(serveApi({ name: "demo", transport: "mcp", root }), /mcp transport is not implemented/);
    await assert.rejects(serveApi({ name: "demo", transport: "socket", root }), /does not configure socket/);
    await assert.rejects(serveApi({ name: "demo", transport: "websocket", root }), /does not configure websocket/);
    await assert.rejects(serveApi({ name: "missing", transport: "socket", root }), /no package API named missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
