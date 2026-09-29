import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botInstance, parseBotMcpIdentity, workspaceRoot } from "@agentstack/api";
import { serverMcpUrls } from "../src/server-mcp.js";

test("bot MCP URLs follow the owner catalog and bind each connection to its launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-server-mcp-"));
  try {
    const alpha = join(root, "packages", "alpha");
    const beta = join(root, "packages", "beta");
    await mkdir(alpha, { recursive: true });
    await mkdir(beta);
    await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n  operations: all\n  events: all\n");
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nsocket:\n  description: Beta socket.\n");
    const env = { AGENTSTACK_STATE_DIR: join(root, "state") };
    const endpoint = "unix:///tmp/agentstack-app/first.sock";
    const first = await serverMcpUrls(root, 43123, "bot-1", endpoint, env);
    assert.deepEqual(Object.keys(first), ["alpha"]);
    assert.deepEqual(parseBotMcpIdentity(new URL(first.alpha!), env), { botId: "bot-1", instance: botInstance(endpoint) });
    assert.equal(new URL(first.alpha!).pathname, "/mcp/alpha");
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n  operations: all\n  events: all\n");
    const next = await serverMcpUrls(root, 43123, "bot-1", "unix:///tmp/agentstack-app/second.sock", env);
    assert.deepEqual(Object.keys(next), ["alpha", "beta"]);
    assert.notEqual(next.alpha, first.alpha);
    assert.equal(new URL(next.beta!).pathname, "/mcp/beta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real owner catalog gives Bots a signed browser management connection", async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-browser-mcp-"));
  try {
    const env = { AGENTSTACK_STATE_DIR: state };
    const endpoint = "unix:///fixture/browser-bot.sock";
    const urls = await serverMcpUrls(workspaceRoot(import.meta.dirname), 43123, "bot-1", endpoint, env);
    assert.ok(urls.browse, "browser management must be discoverable by launched Bots");
    assert.equal(new URL(urls.browse).pathname, "/mcp/browse");
    assert.deepEqual(parseBotMcpIdentity(new URL(urls.browse), env), { botId: "bot-1", instance: botInstance(endpoint) });
  } finally { await rm(state, { recursive: true, force: true }); }
});
