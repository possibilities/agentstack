import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botInstance, parseBotMcpIdentity } from "@agentstack/api";
import { ownerMcpUrls } from "../src/owner-mcp.js";

test("bot MCP URLs follow the owner catalog and bind each connection to its launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-owner-mcp-"));
  try {
    const alpha = join(root, "packages", "alpha");
    const beta = join(root, "packages", "beta");
    await mkdir(alpha, { recursive: true });
    await mkdir(beta);
    await writeFile(join(alpha, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n");
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nsocket:\n  description: Beta socket.\n");
    const env = { AGENTSTACK_STATE_DIR: join(root, "state") };
    const endpoint = "unix:///tmp/agentstack-app/first.sock";
    const first = await ownerMcpUrls(root, 43123, "bot-1", endpoint, env);
    assert.deepEqual(Object.keys(first), ["alpha"]);
    assert.deepEqual(parseBotMcpIdentity(new URL(first.alpha!), env), { botId: "bot-1", instance: botInstance(endpoint) });
    assert.equal(new URL(first.alpha!).pathname, "/mcp/alpha");
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n");
    const next = await ownerMcpUrls(root, 43123, "bot-1", "unix:///tmp/agentstack-app/second.sock", env);
    assert.deepEqual(Object.keys(next), ["alpha", "beta"]);
    assert.notEqual(next.alpha, first.alpha);
    assert.equal(new URL(next.beta!).pathname, "/mcp/beta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
