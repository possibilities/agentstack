import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { internalMcpLaunches, type McpLaunchAuthority } from "../src/mcp-launch.js";
import { operation } from "../src/operation.js";
import { McpEventSubscriptions, type EventValue } from "../src/mcp-subscriptions.js";
import { mcpEventRelayInput, relayMcpEvent } from "../src/mcp-events.js";
import { serveSocket, socketCall } from "../src/socket.js";
import { socketPath } from "../src/workspace.js";

// This boundary owns stdio authentication, live policy and the private owner relay.
// The separate delivery tests own actual Codex lineage and turn/start admission.
test("stdio children use private sockets, refresh policy, fence identities and leave durable watches with one owner", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-stdio-"));
  const env = { ...process.env, STACK_STATE_DIR: join(root, "state"), STACK_MCP_PORT: "not-an-http-port" };
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  const manifest = (operations = "[read, mutate]", workers = "[read]") => writeFile(join(dir, "api.yaml"),
    `name: demo\ndescription: Demo.\nmcp:\n  description: Demo MCP.\n  operations: ${operations}\n  workerOperations: ${workers}\n  events: [changed]\n`);
  await manifest();
  let value = 1, botLive = true, workerLive = true, mutations = 0;
  const workerId = randomUUID(), instance = randomUUID(), endpoint = "unix:///fixture/bot.sock";
  const socket = async (name: string, responses: Record<string, () => unknown>) => serveSocket({
    info: { name, description: "Fixture", transportDescription: "Fixture", path: socketPath(name, env) }, context: {},
    operations: Object.entries(responses).map(([name, call]) => operation({ name, description: "Fixture", input: z.any(), output: z.any(), async call() { return call(); } })),
  });
  const bots = await socket("bots", { bot_list: () => ({ bots: [{ id: "bot-1", url: endpoint, state: botLive ? "running" : "stopped", recoveryIssue: null }] }) });
  const workers = await socket("worker", {
    worker_status: () => ({ worker: { accountId: "account", phase: workerLive ? "running" : "closed", runtimeInstance: instance } }),
    worker_runtime_list: () => ({ runtimes: [{ id: "account", state: "running", instance }] }),
  });
  const pkg = await serveSocket({ info: { name: "demo", description: "Fixture", transportDescription: "Fixture", path: socketPath("demo", env) }, context: {},
    events: { topics: { changed: "Value changed" } }, operations: [
      operation({ name: "read", description: "Read value and caller", input: z.strictObject({}), output: z.object({ value: z.number(), thread: z.string().nullable(), worker: z.string().nullable() }),
        annotations: { readOnlyHint: true }, async call(_ctx, _input, invocation) { return { value, thread: invocation?.threadId ?? null, worker: invocation?.workerId ?? null }; },
        mcpContent() { return [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]; } }),
      operation({ name: "mutate", description: "Change value", input: z.strictObject({}), output: z.object({ value: z.number() }),
        async call() { mutations++; return { value: ++value }; } }),
    ] });
  const deliveries: EventValue[] = [];
  let delivered!: () => void;
  const changed = new Promise<void>(resolve => { delivered = resolve; });
  const owner = new McpEventSubscriptions(env, async target => {
    if (!botLive || !["root", "child"].includes(target.threadId)) throw new Error("thread is outside sanctioned lineage");
  }, async event => { deliveries.push(event); delivered(); }, undefined, undefined, root);
  const serve = await serveSocket({ info: { name: "serve", description: "Fixture", transportDescription: "Fixture", path: socketPath("serve", env) }, context: {}, operations: [
    operation({ name: "serve_mcp_event", description: "Owner relay", input: mcpEventRelayInput, output: z.any(),
      async call(_ctx, input) { return relayMcpEvent(owner, input, root, env); } }),
  ] });
  const clients: Client[] = [];
  const connect = async (authority: McpLaunchAuthority, overrides: Record<string, string> = {}) => {
    const launch = (await internalMcpLaunches(root, authority, env)).demo!;
    const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: { ...launch.env, ...overrides }, cwd: root, stderr: "pipe" });
    const client = new Client({ name: "stdio-fixture", version: "1" }); clients.push(client);
    await client.connect(transport);
    return { client, launch };
  };
  try {
    const operator = await connect({ kind: "operator" });
    assert.ok((await operator.client.listTools()).tools.some(tool => tool.name === "events_subscribe"));
    const read = await operator.client.callTool({ name: "read" });
    assert.deepEqual(read.structuredContent, { value: 1, thread: null, worker: null });
    assert.deepEqual(read.content, [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]);
    assert.equal((await operator.client.callTool({ name: "read", arguments: { invalid: true } })).isError, true);
    assert.equal((await operator.client.callTool({ name: "events_subscribe", arguments: { topic: "changed", readOperation: "read" } })).isError, true);
    const bot = await connect({ kind: "bot", botId: "bot-1", endpoint });
    assert.equal((await bot.client.callTool({ name: "read" })).isError, true);
    for (const threadId of ["root", "child"]) assert.equal(CallToolResultSchema.parse(await bot.client.callTool({ name: "read", _meta: { threadId } })).structuredContent?.thread, threadId);
    const subscribe = (threadId: string) => bot.client.callTool({ name: "events_subscribe", arguments: { topic: "changed", readOperation: "read" }, _meta: { threadId } });
    assert.equal((await subscribe("foreign-root")).isError, true);
    const accepted = await subscribe("child");
    assert.equal(accepted.isError, undefined);
    assert.equal(owner.operatorList().length, 1);
    assert.equal(owner.operatorList()[0]!.threadId, "child");
    assert.deepEqual(CallToolResultSchema.parse(await bot.client.callTool({ name: "events_status", _meta: { threadId: "root" } })).structuredContent?.subscriptions, []);
    assert.equal((await bot.client.callTool({ name: "events_status", _meta: { threadId: "foreign-root" } })).isError, true);
    await bot.client.close();
    value = 2; pkg.publish!("changed"); await changed;
    assert.equal(deliveries[0]!.subscription.threadId, "child", "closing stdio does not own or end the watch");
    assert.equal((deliveries[0]!.value as { value: number }).value, 2);
    assert.ok((await readFile(join(env.STACK_STATE_DIR, "event-subscriptions.sqlite"))).length);
    const worker = await connect({ kind: "worker", workerId, instance });
    assert.deepEqual((await worker.client.listTools()).tools.map(tool => tool.name), ["read"]);
    assert.equal(CallToolResultSchema.parse(await worker.client.callTool({ name: "read" })).structuredContent?.worker, workerId);
    assert.equal((await worker.client.callTool({ name: "mutate" })).isError, true);
    assert.equal((await worker.client.callTool({ name: "events_subscribe", arguments: { topic: "changed", readOperation: "read" } })).isError, true);
    await assert.rejects(connect({ kind: "worker", workerId, instance }, { STACK_MCP_BINDING: worker.launch.env.STACK_MCP_BINDING!.replace(/proof=./, "proof=z") }), /closed/);
    await assert.rejects(socketCall(serve.path, "tools/call", { name: "serve_mcp_event", arguments: { binding: worker.launch.env.STACK_MCP_BINDING, pkg: "demo", tool: "events_status", arguments: {}, threadId: "child", sessionId: null } }), /Bot launch binding/);
    await manifest("[read]", "[]");
    assert.equal((await operator.client.callTool({ name: "mutate" })).isError, true);
    assert.equal(mutations, 0);
    assert.deepEqual((await worker.client.listTools()).tools, []);
    assert.equal((await worker.client.callTool({ name: "read" })).isError, true);
    await manifest();
    workerLive = false;
    await assert.rejects(worker.client.listTools(), /live Worker/);
    const stale = await connect({ kind: "bot", botId: "bot-1", endpoint });
    botLive = false;
    assert.equal((await stale.client.callTool({ name: "read", _meta: { threadId: "child" } })).isError, true);
    await assert.rejects(connect({ kind: "operator" }, { STACK_MCP_AUTHORITY: "bot", STACK_MCP_BINDING: "" }), /closed/);
    await assert.rejects(connect({ kind: "operator" }, { STACK_MCP_AUTHORITY: "" }), /closed/);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await owner.close(); await Promise.all([serve.close(), pkg.close(), bots.close(), workers.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
