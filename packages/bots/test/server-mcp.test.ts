import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botInstance, parseMcpBinding, workspaceRoot } from "@stack/api";
import { serverMcpLaunches } from "../src/server-mcp.js";

test("bot stdio MCP connections follow the owner catalog and bind each connection to its launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-server-mcp-"));
  try {
    const alpha = join(root, "packages", "alpha");
    const beta = join(root, "packages", "beta");
    await mkdir(alpha, { recursive: true });
    await mkdir(beta);
    await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n  operations: all\n  events: all\n");
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nsocket:\n  description: Beta socket.\n");
    const env = { STACK_STATE_DIR: join(root, "state") };
    const endpoint = "unix:///tmp/stack-app/first.sock";
    const first = await serverMcpLaunches(root, 43123, "bot-1", endpoint, env);
    const bridges = ["codex-computer-use", "chrome", "messages", "computer-history", "openai-developer-docs"];
    assert.deepEqual(Object.keys(first), ["alpha", ...bridges]);
    for (const launch of Object.values(first)) {
      assert.equal(launch.type, "stdio");
      assert.equal(launch.command, process.execPath);
      assert.deepEqual(parseMcpBinding(launch.env.STACK_MCP_BINDING!, env), { botId: "bot-1", instance: botInstance(endpoint) });
      assert.equal(launch.env.STACK_STATE_DIR, env.STACK_STATE_DIR);
    }
    assert.equal(first.alpha!.args.at(-1), "alpha");
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n  operations: all\n  events: all\n");
    const next = await serverMcpLaunches(root, 43123, "bot-1", "unix:///tmp/stack-app/second.sock", env);
    assert.deepEqual(Object.keys(next), ["alpha", "beta", ...bridges]);
    assert.notEqual(next.alpha!.env.STACK_MCP_BINDING, first.alpha!.env.STACK_MCP_BINDING);
    assert.equal(next.beta!.args.at(-1), "beta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real owner catalog gives Bots a signed browser management connection", async () => {
  const state = await mkdtemp(join(tmpdir(), "stack-browser-mcp-"));
  try {
    const env = { STACK_STATE_DIR: state };
    const endpoint = "unix:///fixture/browser-bot.sock";
    const launches = await serverMcpLaunches(workspaceRoot(import.meta.dirname), 43123, "bot-1", endpoint, env);
    assert.ok(launches.browse, "browser management must be discoverable by launched Bots");
    assert.equal(launches.browse.args.at(-1), "browse");
    assert.deepEqual(parseMcpBinding(launches.browse.env.STACK_MCP_BINDING!, env), { botId: "bot-1", instance: botInstance(endpoint) });
  } finally { await rm(state, { recursive: true, force: true }); }
});
