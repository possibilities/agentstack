import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { operatorHeaders } from "../src/local-auth.js";
import { serveSocket, socketCall } from "../src/socket.js";
import { serveApi } from "../src/serve.js";
import { serveWebSocket } from "../src/websocket.js";
import { mcpPort, socketPath } from "../src/workspace.js";
import { botMcpUrl, workerMcpUrl, parseWorkerMcpIdentity } from "../src/bot-mcp-identity.js";
import type { InvocationContext } from "../src/operation.js";
import { McpEventSubscriptions, type EventValue } from "../src/mcp-subscriptions.js";

test("one HTTP process exposes each configured Package API and forwards operations to socket servers", { timeout: 30_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "stack-mcp-"));
  const env = { ...process.env, STACK_STATE_DIR: stateDir, STACK_MCP_PORT: "0" };
  const seen: string[] = [];
  for (const name of ["auth", "bots", "brain", "browse", "content", "notify", "roles", "serve", "scrape", "usage", "worker"]) {
    const dir = join(stateDir, "packages", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "api.yaml"), `name: ${name}\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: all\n`);
  }
  const sockets = await Promise.all(["auth", "bots", "brain", "browse", "content", "notify", "roles", "serve", "scrape", "usage", "worker"].map((name) => serveSocket({
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
  const served = await serveMcp({ env, root: stateDir });
  try {
    assert.equal((await fetch(served.urls.auth!, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await fetch(served.urls.auth!, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
    const packageNames = ["auth", "bots", "brain", "browse", "content", "notify", "roles", "scrape", "serve", "usage", "worker"];
    assert.deepEqual(Object.keys(served.urls), [...packageNames, "computer-use", "chrome", "messages", "computer-history", "openai-developer-docs"]);
    for (const name of packageNames) {
      const url = served.urls[name]!;
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: operatorHeaders(env) } }));
      try {
        const tools = (await client.listTools()).tools;
        assert.deepEqual(tools.map((tool) => tool.name), [name === "auth" ? "account_list" : name === "scrape" ? "scrape_fetch" : "ping"]);
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
    await refreshed.connect(new StreamableHTTPClientTransport(new URL(served.urls.auth!), { requestInit: { headers: operatorHeaders(env) } }));
    try {
      assert.deepEqual((await refreshed.listTools()).tools.map((tool) => tool.name), ["new_operation"]);
    } finally {
      await refreshed.close();
    }
    const rejected = await fetch(served.urls.auth!, {
      method: "POST", headers: { ...operatorHeaders(env), Origin: "https://evil.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
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

test("Proc admits mutating calls over MCP and WebSocket with all event topics selected", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-proc-transports-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const dir = join(root, "packages", "proc");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: proc\ndescription: Processes and schedules.\nsocket:\n  description: Local.\nmcp:\n  description: Agent tools.\n  operations: all\n  events: all\nwebsocket:\n  description: Loopback tools.\n  operations: all\n  events: all\n");
  const proc = await serveApi({ name: "proc", transport: "socket", env });
  const mcp = await serveMcp({ root, env, port: 0 });
  const websocket = await serveWebSocket({ root, env, port: 0 });
  const client = new Client({ name: "proc-test", version: "1" });
  let ws: WebSocket | undefined;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urls.proc!), { requestInit: { headers: operatorHeaders(env) } }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("proc_schedule_create") && names.includes("proc_run_start"));
    const scheduleId = randomUUID();
    const created = await client.callTool({ name: "proc_schedule_create", arguments: {
      id: scheduleId, action: { type: "process", process: { command: process.execPath } },
      firstAt: new Date(Date.now() + 3_600_000).toISOString(), enabled: false,
    } });
    assert.equal(created.isError, undefined);
    assert.equal((created.structuredContent as { id: string }).id, scheduleId);
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(websocket.url, { headers: operatorHeaders(env) });
      conn.once("open", () => resolve(conn)); conn.once("error", reject);
    });
    const exchange = async (id: number, method: string, params: object) => {
      const frame = new Promise<any>((resolve, reject) => {
        ws!.once("message", (raw) => { try { resolve(JSON.parse(String(raw))); } catch (error) { reject(error); } });
        ws!.once("error", reject);
      });
      ws!.send(JSON.stringify({ id, method, params }));
      return frame;
    };
    const listed = await exchange(1, "tools/list", { package: "proc" });
    assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === "proc_run_start"));
    assert.deepEqual(Object.keys(listed.result.events.topics), ["proc_schedules_changed", "proc_runs_changed", "proc_output_changed"]);
    const removed = await exchange(2, "tools/call", { package: "proc", name: "proc_schedule_remove", arguments: { id: scheduleId, expectedRevision: 1 } });
    assert.deepEqual(removed.result, { removed: true });
    const started = await exchange(3, "tools/call", { package: "proc", name: "proc_run_start", arguments: {
      requestId: randomUUID(), process: { command: process.execPath, args: ["-e", "process.stdout.write('agent\\n')"] },
    } });
    assert.ok(started.result.id);
    const joined = await exchange(4, "tools/call", { package: "proc", name: "proc_run_join", arguments: { id: started.result.id, waitMs: 5_000 } });
    assert.equal(joined.result.run.state, "exited");
    assert.equal(joined.result.run.exitCode, 0);
  } finally {
    ws?.terminate(); await client.close(); await websocket.close(); await mcp.close(); await proc.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("any Package API can present native MCP media without changing its socket or WebSocket JSON", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-mcp-media-"));
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nmcp:\n  description: MCP.\n  operations: all\n  events: all\nwebsocket:\n  description: WebSocket.\n  operations: all\n  events: all\n");
  const env = { ...process.env, STACK_STATE_DIR: root };
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
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urls.demo!), { requestInit: { headers: operatorHeaders(env) } }));
    const result = await client.callTool({ name: "media", arguments: {} });
    assert.deepEqual(result.structuredContent, payload);
    assert.deepEqual(result.content, [{ type: "audio", mimeType: payload.mimeType, data: payload.base64 }]);
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(websocket.url, { headers: operatorHeaders(env) });
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
  const state = await mkdtemp(join(tmpdir(), "stack-content-media-"));
  const env = { ...process.env, STACK_STATE_DIR: state, STACK_CONTENT_PORT: "0", STACK_CONTENT_ARTIFACT_PORT: "0" };
  const content = await serveApi({ name: "content", transport: "socket", env });
  await mkdir(join(state, "packages", "content"), { recursive: true });
  await writeFile(join(state, "packages", "content", "api.yaml"), "name: content\ndescription: Test.\nmcp:\n  description: Test.\n  operations: all\n  events: all\nwebsocket:\n  description: Test.\n  operations: all\n  events: all\n");
  const mcp = await serveMcp({ env, port: 0 });
  const websocket = await serveWebSocket({ env, root: state, port: 0 });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urls.content!), { requestInit: { headers: operatorHeaders(env) } }));
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
    const ws = new WebSocket(websocket.url, { headers: operatorHeaders(env) });
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
  const root = await mkdtemp(join(tmpdir(), "stack-mcp-allow-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: demo\ndescription: Demo.\nsocket:\n  description: Socket.\nmcp:\n  description: Selected tools.\n  operations: [read]\n  events: []\n");
  let called = false;
  const socket = await serveSocket({ info: { name: "demo", description: "Demo.", transportDescription: "Socket.", path: socketPath("demo", env) }, context: {},
    operations: ["read", "secret"].map((name) => operation({ name, description: `${name}.`, input: z.strictObject({}), output: z.object({ ok: z.boolean() }),
      async call() { called = true; return { ok: true }; } })) });
  const served = await serveMcp({ root, env, port: 0 });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(served.urls.demo!), { requestInit: { headers: operatorHeaders(env) } }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["read"]);
    const denied = await client.callTool({ name: "secret", arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(called, false);
    assert.equal((await client.callTool({ name: "read", arguments: {} })).isError, undefined);
  } finally { await client.close(); await served.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});

test("a bot-bound MCP URL forwards verified bot and Codex thread context without changing tool inputs", { timeout: 30_000 }, async () => {
  const root = await mkdtemp("/tmp/as-mcp-b-");
  const env = { ...process.env, STACK_STATE_DIR: root, STACK_MCP_PORT: "0" };
  const packageDir = join(root, "packages", "sample");
  await mkdir(packageDir, { recursive: true });
  const configure = (operations: string, events: string) => writeFile(join(packageDir, "api.yaml"), `name: sample\ndescription: Sample.\nmcp:\n  description: Sample MCP.\n  operations: ${operations}\n  events: ${events}\n`);
  await configure("[who, snapshot]", "[sample_changed]");
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
      operation({ name: "hidden", description: "Hidden read.", input: z.strictObject({}), output: z.object({}), annotations: { readOnlyHint: true }, async call() { throw new Error("must not read hidden"); } }),
    ],
    events: { topics: { sample_changed: "Refresh snapshot.", hidden_changed: "Not exposed." } },
  });
  const subscriptions = new McpEventSubscriptions(env, async (target) => { assert.equal(target.botId, "bot-1"); }, async (event) => { delivered.push(event); }, undefined, undefined, root);
  const served = await serveMcp({ root, env, subscriptions });
  const url = botMcpUrl(served.urls.sample!, "bot-1", endpoint, env);
  const client = new Client({ name: "bot-bound", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "events_subscribe"));
    const catalog = await client.callTool({ name: "events_catalog", arguments: {}, _meta: { threadId: "thread-1" } });
    assert.deepEqual((catalog.structuredContent as { topics: Record<string, string> }).topics, { sample_changed: "Refresh snapshot." });
    assert.deepEqual((catalog.structuredContent as { reads: Array<{ name: string }> }).reads.map((read) => read.name), ["snapshot"]);
    for (const args of [{ topic: "hidden_changed", readOperation: "snapshot" }, { topic: "sample_changed", readOperation: "hidden" }, { topic: "sample_changed", readOperation: "who" }])
      assert.equal((await client.callTool({ name: "events_subscribe", arguments: args, _meta: { threadId: "thread-1" } })).isError, true);
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
    await configure("[]", "[]");
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal((await client.callTool({ name: "events_catalog", _meta: { threadId: "thread-1" } })).isError, true);
    assert.equal((await client.callTool({ name: "snapshot", _meta: { threadId: "thread-1" } })).isError, true);
    for (const [ops, events] of [["[missing]", "all"], ["all", "[missing]"], ["[snapshot, snapshot]", "all"], ["all", "[sample_changed, sample_changed]"]]) {
      await configure(ops!, events!);
      await assert.rejects(client.listTools(), /Error POSTing/);
      await assert.rejects(client.callTool({ name: "snapshot", _meta: { threadId: "thread-1" } }), /Error POSTing/);
      assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) })).status, 503);
    }
    await configure("[who, snapshot]", "[sample_changed]");
    endpoint = "unix:///tmp/bot-instance-2.sock";
    await assert.rejects(client.callTool({ name: "who", arguments: { value: "stale" }, _meta: { threadId: "thread-1" } }), /401|Unauthorized/);
    assert.equal(seen.length, 1);
    assert.equal((await lstat(join(env.STACK_STATE_DIR, "mcp-bot-identity.key"))).mode & 0o777, 0o600);
  } finally {
    await client.close();
    await subscriptions.close();
    await served.close();
    await sample.close();
    await bots.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker MCP disclosure is explicit, live, fail-closed and runtime-bound", { timeout: 30_000 }, async () => {
  const root = await mkdtemp("/tmp/as-mcp-w-");
  const env = { ...process.env, STACK_STATE_DIR: root, STACK_MCP_PORT: "0" };
  const packageDir = join(root, "packages", "sample");
  await mkdir(packageDir, { recursive: true });
  const configure = (worker = "", operations = "all") => writeFile(join(packageDir, "api.yaml"), `name: sample\ndescription: Sample.\nmcp:\n  description: Sample MCP.\n  operations: ${operations}\n  events: all\n${worker ? `  workerOperations: ${worker}\n` : ""}`);
  await configure();
  let withdrawOnRead = false;
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
        async call(_ctx, _input, invocation) { seen.push(invocation); if (withdrawOnRead) await configure("[]"); return { ok: true }; } }),
      operation({ name: "login_secret", description: "A read is not automatically safe for Workers", input: z.strictObject({}), output: z.object({ code: z.string() }), annotations: { readOnlyHint: true },
        async call() { throw new Error("secret must never reach the Worker"); } }),
      operation({ name: "change", description: "Change", input: z.strictObject({}), output: z.object({ ok: z.boolean() }),
        async call() { throw new Error("must never reach the package"); } }),
    ], events: { topics: { changed: "Refresh." } } });
  const served = await serveMcp({ root, env });
  const url = workerMcpUrl(served.urls.sample!, workerId, instance, env);
  const client = new Client({ name: "worker-bound", version: "1.0.0" });
  try {
    assert.deepEqual(parseWorkerMcpIdentity(new URL(url), env), { workerId, instance });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal((await client.callTool({ name: "read", arguments: {} })).isError, true);
    await configure("[read]");
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["read"]);
    assert.deepEqual((await client.callTool({ name: "read", arguments: {} })).structuredContent, { ok: true });
    assert.equal(seen[0]?.workerId, workerId);
    assert.equal(seen[0]?.workerInstance, instance);
    assert.equal(seen[0]?.botId, null);
    assert.equal((await client.callTool({ name: "change", arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: "login_secret", arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: "events_subscribe", arguments: {} })).isError, true);
    await configure("[read]", "[login_secret]");
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal((await client.callTool({ name: "read", arguments: {} })).isError, true);
    await configure("[read]");
    withdrawOnRead = true;
    const withheld = await client.callTool({ name: "read", arguments: {} });
    assert.equal(withheld.isError, true); assert.equal(withheld.structuredContent, undefined);
    assert.match(JSON.stringify(withheld), /policy changed/);
    assert.deepEqual((await client.listTools()).tools, []);
    await configure("[read]");
    const tampered = new URL(url); tampered.searchParams.set("proof", "0".repeat(64));
    assert.equal((await fetch(tampered, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" })).status, 403);
    instance = "44444444-4444-4444-8444-444444444444";
    await assert.rejects(client.callTool({ name: "read", arguments: {} }), /401|Unauthorized/);
    assert.equal(seen.length, 2);
  } finally {
    await client.close(); await served.close(); await sample.close(); await workers.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP paths follow configured packages after startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-mcp-config-"));
  const dir = join(root, "packages", "alpha");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: alpha\ndescription: Alpha.\nmcp:\n  description: Alpha HTTP.\n  operations: all\n  events: all\n");
  const served = await serveMcp({ root, port: 0, env: { ...process.env, STACK_STATE_DIR: root } });
  try {
    const url = `http://127.0.0.1:${served.port}/mcp/beta`;
    assert.equal((await fetch(url, { method: "POST" })).status, 404);
    const beta = join(root, "packages", "beta");
    await mkdir(beta);
    await writeFile(join(beta, "api.yaml"), "name: beta\ndescription: Beta.\nmcp:\n  description: Beta HTTP.\n  operations: all\n  events: all\n");
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
  assert.equal(mcpPort({ STACK_MCP_PORT: "0" }), 0);
  for (const value of ["", "-1", "65536", "123.5", "abc"]) {
    assert.throws(() => mcpPort({ STACK_MCP_PORT: value }), /STACK_MCP_PORT/);
  }
});
