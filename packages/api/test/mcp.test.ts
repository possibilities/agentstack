import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const sockets = await Promise.all(["auth", "bots", "capabilities", "codex", "owner"].map((name) => serveSocket({
    info: { name, description: `${name}.`, transportDescription: "Socket.", path: socketPath(name, env) },
    context: {},
    operations: [name === "auth" ? operation({
      name: "account_list", description: "List accounts.", input: z.strictObject({}), output: z.object({ accounts: z.array(z.unknown()) }),
      async call() { seen.push("account_list"); return { accounts: [] }; },
    }) : operation({
      name: "ping", description: "Ping.", input: z.object({}), output: z.object({ ok: z.boolean() }),
      async call() { return { ok: true }; },
    })],
  })));
  const served = await serveMcp({ env });
  try {
    assert.deepEqual(Object.keys(served.urls), ["auth", "bots", "capabilities", "codex", "owner"]);
    for (const [name, url] of Object.entries(served.urls)) {
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      try {
        const tools = (await client.listTools()).tools;
        assert.deepEqual(tools.map((tool) => tool.name), [name === "auth" ? "account_list" : "ping"]);
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
    await sockets[0]!.close();
    sockets[0] = await serveSocket({
      info: { name: "auth", description: "Auth.", transportDescription: "Socket.", path: socketPath("auth", env) },
      context: {},
      operations: [operation({
        name: "new_operation", description: "A newly loaded operation.", input: z.object({}), output: z.object({ ok: z.boolean() }),
        async call() { return { ok: true }; },
      })],
    });
    const refreshed = new Client({ name: "test", version: "1.0.0" });
    await refreshed.connect(new StreamableHTTPClientTransport(new URL(served.urls.auth!)));
    try {
      assert.deepEqual((await refreshed.listTools()).tools.map((tool) => tool.name), ["new_operation"]);
    } finally {
      await refreshed.close();
    }
    const rejected = await fetch(served.urls.auth!, {
      method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal((await fetch(served.urls.auth!, { method: "GET" })).status, 405);
  } finally {
    await served.close();
    await Promise.all(sockets.map((socket) => socket.close()));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("MCP paths follow configured packages after startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-mcp-config-"));
  const dir = join(root, "packages", "alpha");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n");
  const served = await serveMcp({ root, port: 0 });
  try {
    const url = `http://127.0.0.1:${served.port}/mcp/beta`;
    assert.equal((await fetch(url, { method: "POST" })).status, 404);
    const beta = join(root, "packages", "beta");
    await mkdir(beta);
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n");
    assert.equal((await fetch(url, { method: "GET" })).status, 405);
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nsocket:\n  description: Beta socket.\n");
    assert.equal((await fetch(url, { method: "GET" })).status, 404);
  } finally {
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP port configuration rejects invalid values", () => {
  assert.equal(mcpPort({}), 8743);
  assert.equal(mcpPort({ AGENTSTACK_MCP_PORT: "0" }), 0);
  for (const value of ["", "-1", "65536", "123.5", "abc"]) {
    assert.throws(() => mcpPort({ AGENTSTACK_MCP_PORT: value }), /AGENTSTACK_MCP_PORT/);
  }
});
