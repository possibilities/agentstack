import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { operation } from "../src/operation.js";
import { serveMcp } from "../src/mcp.js";
import { serveSocket } from "../src/socket.js";
import { mcpPort, socketPath } from "../src/workspace.js";

test("one HTTP process exposes each configured Package API and forwards operations to socket owners", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-mcp-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0" };
  const seen: string[] = [];
  const socket = await serveSocket({
    info: { name: "auth", description: "Auth.", transportDescription: "Socket.", path: socketPath("auth", env) },
    context: {},
    operations: [operation({
      name: "account_list", description: "List accounts.", input: z.strictObject({}), output: z.object({ accounts: z.array(z.unknown()) }),
      async call() { seen.push("account_list"); return { accounts: [] }; },
    })],
  });
  const served = await serveMcp({ env });
  try {
    assert.deepEqual(Object.keys(served.urls), ["auth", "bots", "codex", "owner"]);
    for (const [name, url] of Object.entries(served.urls)) {
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      try {
        const tools = (await client.listTools()).tools;
        assert.ok(tools.length > 0, `${name} has tools`);
        assert.ok(tools.every((tool) => tool.inputSchema.type === "object" && tool.outputSchema?.type === "object"));
        if (name === "auth") {
          assert.ok(tools.some((tool) => tool.name === "account_list"));
          const result = await client.callTool({ name: "account_list", arguments: {} });
          assert.deepEqual(result.structuredContent, { accounts: [] });
          assert.deepEqual(seen, ["account_list"]);
          const error = await client.callTool({ name: "account_list", arguments: { unknown: true } });
          assert.equal(error.isError, true);
          assert.match(JSON.stringify(error.content), /unrecognized|unknown/i);
        }
      } finally {
        await client.close();
      }
    }
    const rejected = await fetch(served.urls.auth!, {
      method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal((await fetch(served.urls.auth!, { method: "GET" })).status, 405);
  } finally {
    await served.close();
    await socket.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("MCP port configuration rejects invalid values", () => {
  assert.equal(mcpPort({}), 8743);
  assert.equal(mcpPort({ AGENTSTACK_MCP_PORT: "0" }), 0);
  for (const value of ["", "-1", "65536", "123.5", "abc"]) {
    assert.throws(() => mcpPort({ AGENTSTACK_MCP_PORT: value }), /AGENTSTACK_MCP_PORT/);
  }
});
