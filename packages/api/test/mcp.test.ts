import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { z } from "zod";
import { operation } from "../src/operation.js";
import { serveMcp } from "../src/mcp.js";
import { serveSocket, socketCall } from "../src/socket.js";
import { serveApi } from "../src/serve.js";
import { serveWebSocket } from "../src/websocket.js";
import { mcpPort, socketPath } from "../src/workspace.js";
import { botMcpUrl, workerMcpUrl, parseWorkerMcpIdentity } from "../src/bot-mcp-identity.js";
import type { InvocationContext } from "../src/operation.js";
import { McpEventSubscriptions, type EventValue } from "../src/mcp-subscriptions.js";

test("one HTTP process exposes each configured Package API and forwards operations to socket owners", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-mcp-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir, AGENTSTACK_MCP_PORT: "0" };
  const seen: string[] = [];
  const sockets = await Promise.all(["auth", "bots", "brain", "browse", "content", "notify", "roles", "owner", "scrape", "usage", "worker"].map((name) => serveSocket({
    info: { name, description: `${name}.`, transportDescription: "Socket.", path: socketPath(name, env) },
    context: {},
    operations: [name === "auth" ? operation({
      name: "account_list", description: "List accounts.", input: z.strictObject({}), output: z.object({ accounts: z.array(z.unknown()) }),
      async call() { seen.push("account_list"); return { accounts: [] }; },
    }) : operation({
      name: name === "scrape" ? "scrape_fetch" : "ping", description: "Ping.", input: z.object({}), output: z.object({ ok: z.boolean() }),
      async call() { return { ok: true }; },
    })],
  })));
  const served = await serveMcp({ env });
  try {
    assert.deepEqual(Object.keys(served.urls), ["auth", "bots", "brain", "browse", "content", "notify", "owner", "roles", "scrape", "usage", "worker"]);
    for (const [name, url] of Object.entries(served.urls)) {
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      try {
        const tools = (await client.listTools()).tools;
        assert.deepEqual(tools.map((tool) => tool.name), name === "browse" ? [] : [name === "auth" ? "account_list" : name === "scrape" ? "scrape_fetch" : "ping"]);
        assert.ok(tools.every((tool) => tool.inputSchema.type === "object" && tool.outputSchema?.type === "object"));
        if (name === "auth") {
          assert.ok(tools.some((tool) => tool.name === "account_list"));
          const result = await client.callTool({ name: "account_list", arguments: {} });
          assert.deepEqual(result.structuredContent, { accounts: [] });
          assert.deepEqual(result.content, [{ type: "text", text: '{"accounts":[]}' }]);
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

test("any Package API can present native MCP media without changing its socket or WebSocket JSON", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-mcp-media-"));
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nmcp:\n  description: MCP.\nwebsocket:\n  description: WebSocket.\n");
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root };
  const bytes = Buffer.from("sample audio\0");
  const payload = { mimeType: "audio/wav", base64: bytes.toString("base64") };
  let calls = 0;
  const socket = await serveSocket({ info: { name: "demo", description: "Demo.", transportDescription: "Socket.", path: socketPath("demo", env) }, context: {},
    operations: [operation({ name: "media", description: "Read media.", input: z.strictObject({}), output: z.object({ mimeType: z.string(), base64: z.string() }),
      async call() { calls++; return payload; },
      mcpContent(_ctx, _input, output) { return [{ type: "audio", mimeType: output.mimeType, data: output.base64 }]; },
    })] });
  const mcp = await serveMcp({ root, env, port: 0 });
  const websocket = await serveWebSocket({ root, env, port: 0 });
  const client = new Client({ name: "test", version: "1" });
  let ws: WebSocket | undefined;
  try {
    await assert.rejects(socketCall(socket.path, "tools/call", { name: "media", arguments: {}, resultFormat: "unknown" }), /unknown result format/);
    assert.equal(calls, 0);
    assert.deepEqual(await socketCall(socket.path, "tools/call", { name: "media", arguments: {} }), payload);
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urls.demo!)));
    const result = await client.callTool({ name: "media", arguments: {} });
    assert.deepEqual(result.structuredContent, payload);
    assert.deepEqual(result.content, [{ type: "audio", mimeType: payload.mimeType, data: payload.base64 }]);
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(websocket.url);
      conn.once("open", () => resolve(conn)); conn.once("error", reject);
    });
    const frame = new Promise<unknown>((resolve, reject) => {
      ws!.once("message", (raw) => { try { resolve(JSON.parse(String(raw))); } catch (error) { reject(error); } });
      ws!.once("error", reject);
    });
    ws.send(JSON.stringify({ id: 7, method: "tools/call", params: { package: "demo", name: "media", arguments: {} } }));
    assert.deepEqual(await frame, { id: 7, result: payload });
    const denied = new Promise<any>((resolve) => ws!.once("message", (raw) => resolve(JSON.parse(String(raw)))));
    ws.send(JSON.stringify({ id: 8, method: "tools/call", params: { package: "demo", name: "media", arguments: {}, resultFormat: "mcp" } }));
    assert.match((await denied).error.message, /not available over websocket/);
    assert.equal(calls, 3, "one call per transport; MCP presentation must not execute the operation twice");
  } finally {
    ws?.terminate(); await client.close(); await websocket.close(); await mcp.close(); await socket.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("content items keep portable JSON on socket and WebSocket and gain native MCP blocks", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-content-media-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_CONTENT_PORT: "0", AGENTSTACK_CONTENT_ARTIFACT_PORT: "0" };
  const content = await serveApi({ name: "content", transport: "socket", env });
  const mcp = await serveMcp({ env, port: 0 });
  const websocket = await serveWebSocket({ env, port: 0 });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urls.content!)));
    for (const [kind, name, mediaType, bytes] of [
      ["document", "note.md", "text/markdown", Buffer.from("# Note")],
      ["image", "pic.png", "image/png", Buffer.from("89504e470d0a1a0a", "hex")],
      ["file", "archive.zip", "application/zip", Buffer.from("file\0bytes")],
    ] as const) {
      const put = { name, kind, mediaType, ...(kind === "document" ? { content: bytes.toString("utf8") } : { base64: bytes.toString("base64") }) };
      const item = await socketCall(content.socketPath!, "tools/call", { name: "item_put", arguments: put }) as { id: string; url: string };
      const arguments_ = { id: item.id, includeData: true };
      const json = await socketCall(content.socketPath!, "tools/call", { name: "item_get", arguments: arguments_ });
      const result = await client.callTool({ name: "item_get", arguments: arguments_ }) as CallToolResult;
      assert.deepEqual(result.structuredContent, json);
      assert.equal(result.content?.[0]?.type, "text");
      assert.equal(JSON.stringify(result.content?.[0]).includes(bytes.toString("base64")), false, "summary should not duplicate binary data");
      const block = result.content?.[1];
      if (kind === "image") assert.deepEqual(block, { type: "image", data: bytes.toString("base64"), mimeType: mediaType });
      else {
        assert.equal(block?.type, "resource");
        if (block?.type === "resource") {
          assert.equal(block.resource.mimeType, mediaType);
          assert.match(block.resource.uri, new RegExp(`/c/${item.id}$`));
          if (kind === "document") assert.equal("text" in block.resource && block.resource.text, bytes.toString("utf8"));
          else assert.equal("blob" in block.resource && block.resource.blob, bytes.toString("base64"));
        }
      }
      const withoutData = await client.callTool({ name: "item_get", arguments: { id: item.id } }) as CallToolResult;
      assert.equal(withoutData.content?.[1]?.type, "resource_link");
      const link = withoutData.content?.[1];
      if (link?.type === "resource_link") assert.deepEqual(Buffer.from(await (await fetch(link.uri)).arrayBuffer()), bytes);
    }
    // Chunk reads remain ordinary JSON, including through MCP. No media type can
    // be inferred safely from a byte range, and staged content stays bounded.
    const ordinary = await client.callTool({ name: "content_status", arguments: {} });
    assert.deepEqual(ordinary.content, [{ type: "text", text: JSON.stringify(ordinary.structuredContent) }]);
    const escaped = "\0".repeat(256 * 1024);
    const longDoc = await socketCall(content.socketPath!, "tools/call", { name: "item_put", arguments: {
      name: "escaped.txt", kind: "document", mediaType: "text/plain", content: escaped,
    } }) as { id: string };
    const large = await client.callTool({ name: "item_get", arguments: { id: longDoc.id, includeData: true } }) as CallToolResult;
    assert.equal((large.structuredContent as { content: string }).content, escaped);
    assert.equal(large.content[1]?.type, "resource");
    if (large.content[1]?.type === "resource") assert.equal("text" in large.content[1].resource && large.content[1].resource.text, escaped);
    const ws = new WebSocket(websocket.url);
    try {
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      const image = await socketCall(content.socketPath!, "tools/call", { name: "item_list", arguments: {} }) as { items: Array<{ id: string; kind: string }> };
      const id = image.items.find((item) => item.kind === "image")!.id;
      const frame = new Promise<any>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(String(raw)))));
      ws.send(JSON.stringify({ id: 1, method: "tools/call", params: { package: "content", name: "item_get", arguments: { id, includeData: true } } }));
      assert.deepEqual((await frame).result, await socketCall(content.socketPath!, "tools/call", { name: "item_get", arguments: { id, includeData: true } }));
      const largeFrame = new Promise<any>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(String(raw)))));
      ws.send(JSON.stringify({ id: 2, method: "tools/call", params: { package: "content", name: "item_get", arguments: { id: longDoc.id, includeData: true } } }));
      assert.equal((await largeFrame).result.content, escaped);
      const upload = new Promise<any>((resolve) => ws.once("message", (raw) => resolve(JSON.parse(String(raw)))));
      ws.send(JSON.stringify({ id: 3, method: "tools/call", params: { package: "content", name: "item_put", arguments: {
        name: "via-websocket.txt", kind: "document", mediaType: "text/plain", content: escaped,
      } } }));
      const uploaded = await upload;
      assert.equal(uploaded.id, 3);
      assert.equal((await socketCall(content.socketPath!, "tools/call", { name: "item_get", arguments: {
        id: uploaded.result.id, includeData: true,
      } }) as { content: string }).content, escaped);
    } finally { ws.terminate(); }
  } finally {
    await client.close(); await websocket.close(); await mcp.close(); await content.close();
    await rm(state, { recursive: true, force: true });
  }
});

test("MCP allowlists hide and reject direct calls to excluded socket operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-mcp-allow-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root };
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nmcp:\n  description: Selected tools.\n  operations: [read]\n");
  let called = false;
  const socket = await serveSocket({ info: { name: "demo", description: "Demo.", transportDescription: "Socket.", path: socketPath("demo", env) }, context: {},
    operations: ["read", "secret"].map((name) => operation({ name, description: `${name}.`, input: z.strictObject({}), output: z.object({ ok: z.boolean() }),
      async call() { called = true; return { ok: true }; } })) });
  const served = await serveMcp({ root, env, port: 0 });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(served.urls.demo!)));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["read"]);
    const denied = await client.callTool({ name: "secret", arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(called, false);
    assert.equal((await client.callTool({ name: "read", arguments: {} })).isError, undefined);
  } finally { await client.close(); await served.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});

test("a bot-bound MCP URL forwards verified bot and Codex thread context without changing tool inputs", { timeout: 30_000 }, async () => {
  const root = await mkdtemp("/tmp/as-mcp-b-");
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root, AGENTSTACK_MCP_PORT: "0" };
  const packageDir = join(root, "packages", "sample");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "api.yaml"), "name: sample\ndescription: Sample.\nmcp:\n  description: Sample MCP.\n");
  let endpoint = "unix:///tmp/bot-instance-1.sock";
  let snapshotValue = 0;
  const seen: Array<{ input: unknown; invocation: InvocationContext | undefined }> = [];
  const delivered: EventValue[] = [];
  const bots = await serveSocket({
    info: { name: "bots", description: "Bots.", transportDescription: "Socket.", path: socketPath("bots", env) }, context: {},
    operations: [operation({ name: "bot_list", description: "List bots.", input: z.strictObject({}), output: z.object({ bots: z.array(z.unknown()) }),
      async call() { return { bots: [{ id: "bot-1", state: "running", url: endpoint, recoveryIssue: null }] }; } })],
  });
  const sample = await serveSocket({
    info: { name: "sample", description: "Sample.", transportDescription: "Socket.", path: socketPath("sample", env) }, context: {},
    operations: [
      operation({ name: "who", description: "Read the caller.", input: z.strictObject({ value: z.string() }), output: z.object({ invocation: z.unknown() }),
        async call(_ctx, input, invocation) { seen.push({ input, invocation }); return { invocation }; } }),
      operation({ name: "snapshot", description: "Read state.", input: z.strictObject({}), output: z.object({ value: z.number() }), annotations: { readOnlyHint: true },
        async call() { return { value: snapshotValue }; } }),
    ],
    events: { topics: { sample_changed: "Refresh snapshot." } },
  });
  const subscriptions = new McpEventSubscriptions(env, async (target) => { assert.equal(target.botId, "bot-1"); }, async (event) => { delivered.push(event); });
  const served = await serveMcp({ root, env, subscriptions });
  const url = botMcpUrl(served.urls.sample!, "bot-1", endpoint, env);
  const client = new Client({ name: "bot-bound", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "events_subscribe"));
    const catalog = await client.callTool({ name: "events_catalog", arguments: {}, _meta: { threadId: "thread-1" } });
    assert.deepEqual((catalog.structuredContent as { topics: Record<string, string> }).topics, { sample_changed: "Refresh snapshot." });
    const subscribed = await client.callTool({ name: "events_subscribe", arguments: { topic: "sample_changed", readOperation: "snapshot" }, _meta: { threadId: "thread-1" } });
    const sub = subscribed.structuredContent as { subscription: { id: string }; value: { value: number } };
    assert.deepEqual(sub.value, { value: 0 });
    snapshotValue = 1;
    sample.publish?.("sample_changed");
    for (let i = 0; i < 100 && !delivered.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(delivered[0]?.value, { value: 1 });
    const status = await client.callTool({ name: "events_status", arguments: {}, _meta: { threadId: "thread-1" } });
    assert.equal((status.structuredContent as { subscriptions: unknown[] }).subscriptions.length, 1);
    const removed = await client.callTool({ name: "events_unsubscribe", arguments: { id: sub.subscription.id }, _meta: { threadId: "thread-1" } });
    assert.deepEqual(removed.structuredContent, { id: sub.subscription.id, removed: true });
    const call = await client.callTool({ name: "who", arguments: { value: "unchanged" }, _meta: { threadId: "thread-1", sessionId: "session-1" } });
    assert.equal(call.isError, undefined);
    assert.deepEqual(seen, [{ input: { value: "unchanged" }, invocation: {
      transport: "mcp", botId: "bot-1", instance: new URL(url).searchParams.get("instance"), threadId: "thread-1", sessionId: "session-1",
      workerId: null, workerInstance: null,
    } }]);
    assert.deepEqual(call.structuredContent, { invocation: seen[0]!.invocation });
    const missing = await client.callTool({ name: "who", arguments: { value: "no-thread" } });
    assert.equal(missing.isError, true);
    assert.equal(seen.length, 1);
    const tampered = new URL(url);
    tampered.searchParams.set("proof", "0".repeat(64));
    const forbidden = await fetch(tampered, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(forbidden.status, 403);
    endpoint = "unix:///tmp/bot-instance-2.sock";
    const stale = await client.callTool({ name: "who", arguments: { value: "stale" }, _meta: { threadId: "thread-1" } });
    assert.equal(stale.isError, true);
    assert.equal(seen.length, 1);
    assert.equal((await lstat(join(env.AGENTSTACK_STATE_DIR, "mcp-bot-identity.key"))).mode & 0o777, 0o600);
  } finally {
    await client.close();
    await subscriptions.close();
    await served.close();
    await sample.close();
    await bots.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Worker-bound MCP URL exposes only read operations and fences a replaced native runtime", { timeout: 30_000 }, async () => {
  const root = await mkdtemp("/tmp/as-mcp-w-");
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root, AGENTSTACK_MCP_PORT: "0" };
  const packageDir = join(root, "packages", "sample");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "api.yaml"), "name: sample\ndescription: Sample.\nmcp:\n  description: Sample MCP.\n");
  const workerId = "11111111-1111-4111-8111-111111111111";
  const accountId = "22222222-2222-4222-8222-222222222222";
  let instance = "33333333-3333-4333-8333-333333333333";
  const seen: Array<InvocationContext | undefined> = [];
  const workers = await serveSocket({ info: { name: "worker", description: "Workers", transportDescription: "Socket", path: socketPath("worker", env) },
    context: {}, operations: [
      operation({ name: "worker_status", description: "Status", input: z.strictObject({ id: z.string() }), output: z.any(),
        async call(_ctx, { id }) { assert.equal(id, workerId); return { worker: { accountId, phase: "running", runtimeInstance: instance } }; } }),
      operation({ name: "worker_runtime_list", description: "Runtimes", input: z.strictObject({}), output: z.any(),
        async call() { return { runtimes: [{ id: accountId, state: "running", instance }] }; } }),
    ] });
  const sample = await serveSocket({ info: { name: "sample", description: "Sample", transportDescription: "Socket", path: socketPath("sample", env) },
    context: {}, operations: [
      operation({ name: "read", description: "Read", input: z.strictObject({}), output: z.object({ ok: z.boolean() }), annotations: { readOnlyHint: true },
        async call(_ctx, _input, invocation) { seen.push(invocation); return { ok: true }; } }),
      operation({ name: "change", description: "Change", input: z.strictObject({}), output: z.object({ ok: z.boolean() }),
        async call() { throw new Error("must never reach the package"); } }),
    ], events: { topics: { changed: "Refresh." } } });
  const served = await serveMcp({ root, env });
  const url = workerMcpUrl(served.urls.sample!, workerId, instance, env);
  const client = new Client({ name: "worker-bound", version: "1.0.0" });
  try {
    assert.deepEqual(parseWorkerMcpIdentity(new URL(url), env), { workerId, instance });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["read"]);
    assert.deepEqual((await client.callTool({ name: "read", arguments: {} })).structuredContent, { ok: true });
    assert.equal(seen[0]?.workerId, workerId);
    assert.equal(seen[0]?.workerInstance, instance);
    assert.equal(seen[0]?.botId, null);
    assert.equal((await client.callTool({ name: "change", arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: "events_subscribe", arguments: {} })).isError, true);
    const tampered = new URL(url); tampered.searchParams.set("proof", "0".repeat(64));
    assert.equal((await fetch(tampered, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" })).status, 403);
    instance = "44444444-4444-4444-8444-444444444444";
    assert.equal((await client.callTool({ name: "read", arguments: {} })).isError, true);
    assert.equal(seen.length, 1);
  } finally {
    await client.close(); await served.close(); await sample.close(); await workers.close();
    await rm(root, { recursive: true, force: true });
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
