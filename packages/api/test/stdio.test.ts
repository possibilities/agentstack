import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { internalMcpLaunches, type McpLaunchAuthority } from "../src/mcp-launch.js";
import { operation } from "../src/operation.js";
import { McpEventSubscriptions, type EventValue } from "../src/mcp-subscriptions.js";
import { mcpEventRelayInput, relayMcpEvent } from "../src/mcp-events.js";
import { serveSocket, socketCall } from "../src/socket.js";
import { completionReceipt } from "../src/completion-watch.js";
import { socketPath, workspaceRoot } from "../src/workspace.js";
import { loadPackageApi } from "../src/catalog.js";
import { codexMcpDefinition } from "../src/codex-mcp/catalog.js";
import { pollEvent } from "../src/occurrence.js";
import { operatorHeaders, withLocalAuth } from "../src/local-auth.js";
import { serveMcp } from "../src/mcp.js";

// This boundary owns stdio authentication, live policy and the private owner relay.
// The separate delivery tests own actual Codex lineage and turn/start admission.
test("stdio children use private sockets, refresh policy, fence identities and leave durable watches with one owner", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-stdio-"));
  const env = { ...process.env, STACK_STATE_DIR: join(root, "state"), STACK_MCP_PORT: "not-an-http-port" };
  const dir = join(root, "packages", "demo");
  await mkdir(dir, { recursive: true });
  const manifest = (operations = "[read, mutate, send, record, read_events]", workers = "[read]", workerEvents = "[]") => writeFile(join(dir, "api.yaml"),
    `name: demo\ndescription: Demo.\nmcp:\n  description: Demo MCP.\n  operations: ${operations}\n  workerOperations: ${workers}\n  workerEvents: ${workerEvents}\n  events: [changed, arrived]\n`);
  await manifest();
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "api.js"), `
    import { operation } from ${JSON.stringify(new URL("../src/operation.js", import.meta.url).href)};
    import { completionReceipt } from ${JSON.stringify(new URL("../src/completion-watch.js", import.meta.url).href)};
    import { pollEvent } from ${JSON.stringify(new URL("../src/occurrence.js", import.meta.url).href)};
    import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
    const record = z.object({ id: z.uuid(), done: z.string().nullable(), answer: z.string().nullable() });
    export const api = { operations: [
      operation({ name: "read", description: "Read value and caller", input: z.strictObject({}), output: z.object({ value: z.number(), thread: z.string().nullable(), worker: z.string().nullable() }), annotations: { readOnlyHint: true }, async call() {} }),
      operation({ name: "mutate", description: "Change value", input: z.strictObject({}), output: z.object({ value: z.number() }), async call() {} }),
      operation({ name: "send", description: "Send a record with optional completion", input: z.strictObject({ id: z.uuid().optional(), subscribe: z.boolean().optional(), actions: z.array(z.string()).optional() }), output: record.extend({ subscription: completionReceipt.nullable() }),
        completionWatch: { topic: "changed", readOperation: "record", idArgument: "id", terminalField: "done", defaultWhen: ["actions"] }, async call() { throw new Error("send must use the live owner"); } }),
      operation({ name: "record", description: "Read a durable record", input: z.strictObject({ id: z.uuid() }), output: record, annotations: { readOnlyHint: true }, async call() {} }),
      pollEvent({ name: "arrived", operation: "read_events", description: "Fixture occurrence.", input: z.strictObject({}), payload: z.strictObject({ value: z.number() }), async poll() { throw new Error("poll must use its socket owner"); } })
    ], events: { topics: { changed: "Value changed" } }, async createContext() { throw new Error("gateway must not create contexts"); } };
  `);
  let value = 1, botLive = true, workerLive = true, mutations = 0;
  const records = new Map<string, { id: string; done: string | null; answer: string | null }>();
  const recordSchema = z.object({ id: z.uuid(), done: z.string().nullable(), answer: z.string().nullable() });
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
      operation({ name: "send", description: "Send a record with optional completion", input: z.strictObject({ id: z.uuid().optional(), subscribe: z.boolean().optional(), actions: z.array(z.string()).optional() }), output: recordSchema.extend({ subscription: completionReceipt.nullable() }),
        completionWatch: { topic: "changed", readOperation: "record", idArgument: "id", terminalField: "done", defaultWhen: ["actions"] },
        async call(_ctx, input) { const id = input.id ?? randomUUID(); const record = records.get(id) ?? { id, done: null, answer: null }; records.set(id, record); return { ...record, subscription: null }; } }),
      pollEvent({ name: "arrived", operation: "read_events", description: "Fixture occurrence.", input: z.strictObject({}), payload: z.strictObject({ value: z.number() }),
        async poll() { return { events: [], cursor: "0", truncated: false, hasMore: false, nextPollMs: 1000 }; } }),
      operation({ name: "record", description: "Read a durable record", input: z.strictObject({ id: z.uuid() }), output: recordSchema, annotations: { readOnlyHint: true },
        async call(_ctx, { id }) { const record = records.get(id); if (!record) throw new Error("record not found"); return record; } }),
    ] });
  const deliveries: EventValue[] = [];
  let delivered!: () => void;
  const changed = new Promise<void>(resolve => { delivered = resolve; });
  const owner = new McpEventSubscriptions(env, async target => {
    if (!botLive || !["root", "child"].includes(target.threadId)) throw new Error("thread is outside sanctioned lineage");
  }, async event => { deliveries.push(event); delivered(); }, undefined, undefined, root, {
    async resolve(invocation) {
      if (invocation.botId && invocation.instance && invocation.threadId)
        return { kind: "bot", botId: invocation.botId, instance: invocation.instance, threadId: invocation.threadId };
      assert.equal(invocation.workerId, workerId); assert.equal(invocation.workerInstance, instance);
      assert.equal(invocation.botId, null, "Worker relay cannot invent Bot authority");
      return { kind: "worker", workerId, instance, sessionId: "owner-session" };
    },
    async verify(target) { return target; },
    async deliver() { throw new Error("empty occurrence fixture must not dispatch input"); },
  });
  let loseOwnerAck = false;
  const serveOwner = () => serveSocket({ info: { name: "serve", description: "Fixture", transportDescription: "Fixture", path: socketPath("serve", env) }, context: {}, operations: [
    operation({ name: "serve_mcp_event", description: "Owner relay", input: mcpEventRelayInput, output: z.any(),
      async call(_ctx, input) { const result = await relayMcpEvent(owner, input, root, env); if (loseOwnerAck) throw new Error("owner response lost after admission"); return result; } }),
  ] });
  let serve = await serveOwner();
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
    await assert.rejects(socketCall(serve.path, "tools/call", { name: "serve_mcp_event", arguments: { binding: worker.launch.env.STACK_MCP_BINDING, pkg: "demo", tool: "events_status", arguments: {}, threadId: "child", sessionId: null } }), /event subscriptions are unavailable over mcp/);
    await manifest(undefined, undefined, "[arrived]");
    assert.ok((await worker.client.listTools()).tools.some(tool => tool.name === "events_listen"), "live explicit Worker event selection refreshes the same pipe");
    const listening = CallToolResultSchema.parse(await worker.client.callTool({ name: "events_listen", arguments: { name: "arrived" }, _meta: { threadId: "foreign-root", sessionId: "forged-session" } }));
    assert.notEqual(listening.isError, true);
    const occurrence = (listening.structuredContent as { subscription: { id: string; target: { sessionId: string } } }).subscription;
    assert.equal(occurrence.target.sessionId, "owner-session");
    assert.equal(owner.occurrences!.operatorList().length, 1);
    assert.equal((await worker.client.callTool({ name: "events_subscribe", arguments: { topic: "changed", readOperation: "read" } })).isError, true, "occurrence authority must not admit Bot snapshot watches");
    const removed = CallToolResultSchema.parse(await worker.client.callTool({ name: "events_unsubscribe", arguments: { id: occurrence.id } }));
    assert.deepEqual(removed.structuredContent, { id: occurrence.id, removed: true });
    await manifest();
    const completion = await connect({ kind: "bot", botId: "bot-1", endpoint });
    const request = { actions: ["Yes"] };
    assert.equal((await completion.client.callTool({ name: "send", arguments: request, _meta: { threadId: "foreign-root" } })).isError, true);
    assert.equal((await operator.client.callTool({ name: "send", arguments: { subscribe: true } })).isError, true);
    assert.equal(records.size, 0, "the stdio relay verifies the destination before an operation side effect");
    await serve.close();
    const noOwner = await completion.client.callTool({ name: "send", arguments: request, _meta: { threadId: "child" } });
    assert.equal(noOwner.isError, true);
    assert.match(JSON.stringify(noOwner.content), /stack_service_unavailable.*event-subscription owner.*not executed/);
    assert.match(JSON.stringify(noOwner.content), /Completion record [0-9a-f-]{36}.*Retry only with this ID/);
    assert.equal(records.size, 0, "an absent completion owner cannot fall through to the live record mutation");
    serve = await serveOwner();
    const sent = CallToolResultSchema.parse(await completion.client.callTool({ name: "send", arguments: request, _meta: { threadId: "child" } })).structuredContent as { id: string; subscription: { id: string; state: string } };
    assert.equal(sent.subscription.state, "pending");
    assert.equal(owner.operatorList().find(row => row.id === sent.subscription.id)?.completion?.operation, "send");
    const beforeCompletion = deliveries.length;
    pkg.publish!("changed"); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(deliveries.length, beforeCompletion, "nonterminal records do not wake the stdio invoking Chat");
    records.set(sent.id, { id: sent.id, done: "answered", answer: "Yes" }); pkg.publish!("changed");
    for (let n = 0; n < 100 && owner.operatorList().some(row => row.id === sent.subscription.id); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(deliveries.at(-1)?.value, { id: sent.id, done: "answered", answer: "Yes" });
    assert.equal(deliveries.at(-1)?.subscription.threadId, "child");
    assert.equal(owner.status({ transport: "mcp", botId: "bot-1", instance: deliveries.at(-1)!.subscription.instance, threadId: "child", sessionId: null }).completions.find(row => row.id === sent.subscription.id)?.state, "delivered");
    const repeated = CallToolResultSchema.parse(await completion.client.callTool({ name: "send", arguments: { ...request, id: sent.id }, _meta: { threadId: "child" } })).structuredContent as { subscription: { id: string; state: string } };
    assert.deepEqual(repeated.subscription.id, sent.subscription.id); assert.equal(repeated.subscription.state, "delivered");
    loseOwnerAck = true;
    const lostOwnerResponse = await completion.client.callTool({ name: "send", arguments: { subscribe: true }, _meta: { threadId: "child" } });
    assert.equal(lostOwnerResponse.isError, true);
    const recoveryId = [...records.keys()].at(-1)!;
    assert.notEqual(recoveryId, sent.id);
    assert.match(JSON.stringify(lostOwnerResponse.content), new RegExp(recoveryId), "a lost owner response still supplies the ingress-allocated ID for safe retry");
    loseOwnerAck = false;
    const recovered = CallToolResultSchema.parse(await completion.client.callTool({ name: "send", arguments: { id: recoveryId, subscribe: true }, _meta: { threadId: "child" } })).structuredContent as { subscription: { id: string; state: string } };
    assert.equal(recovered.subscription.state, "pending");
    assert.equal(owner.operatorList().filter(row => row.completion).length, 1);
    await owner.operatorRemove(recovered.subscription.id, owner.operatorList().find(row => row.id === recovered.subscription.id)!.revision);
    await manifest("[read]", "[]");
    assert.equal((await operator.client.callTool({ name: "mutate" })).isError, true);
    assert.equal(mutations, 0);
    assert.deepEqual((await worker.client.listTools()).tools, []);
    assert.equal((await worker.client.callTool({ name: "read" })).isError, true);
    await manifest();
    workerLive = false;
    assert.deepEqual((await worker.client.listTools()).tools.map(tool => tool.name), ["read"], "catalog admission conveys no live identity authority");
    assert.equal((await worker.client.callTool({ name: "read" })).isError, true);
    const stale = await connect({ kind: "bot", botId: "bot-1", endpoint });
    botLive = false;
    assert.equal((await stale.client.callTool({ name: "read", _meta: { threadId: "child" } })).isError, true);
    await assert.rejects(connect({ kind: "operator" }, { STACK_MCP_AUTHORITY: "bot", STACK_MCP_BINDING: "" }), /closed/);
    await assert.rejects(connect({ kind: "operator" }, { STACK_MCP_AUTHORITY: "" }), /closed/);
    await assert.rejects(connect({ kind: "operator" }, { STACK_MCP_OPERATOR: operatorHeaders(env).authorization }), /closed/);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await owner.close(); await Promise.all([serve.close(), pkg.close(), bots.close(), workers.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("offline stdio recovers on the same pipe after Server auth startup, never replays and obeys explicit revocation", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-offline-stdio-"));
  const env = { ...process.env, STACK_STATE_DIR: join(root, "state") };
  const dir = join(root, "packages", "demo");
  await mkdir(join(dir, "dist"), { recursive: true });
  const manifest = (operations = "all") => writeFile(join(dir, "api.yaml"), `name: demo\ndescription: Demo\nmcp:\n  description: Demo MCP\n  operations: ${operations}\n  workerOperations: [read]\n  events: []\n`);
  await manifest();
  const entry = join(dir, "dist", "api.js");
  await writeFile(entry, `
    import { operation } from ${JSON.stringify(new URL("../src/operation.js", import.meta.url).href)};
    import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
    export const api = { operations: [
      operation({ name: "read", description: "Stored read", input: z.strictObject({}), output: z.object({ value: z.number() }), annotations: { readOnlyHint: true },
        standalone: { open() { return { value: 17 }; }, close() {} },
        async call(ctx) { return { value: ctx.value }; }, mcpContent(_ctx, _input, out) { return [{ type: "text", text: "value=" + out.value }]; } }),
      operation({ name: "mutate", description: "Mutation", input: z.strictObject({}), output: z.object({ value: z.number() }), async call(ctx) { return ctx.mutate(); } })
    ], async createContext() { throw new Error("gateway must not create contexts"); } };
  `);
  const launch = (await internalMcpLaunches(root, { kind: "operator" }, env)).demo!;
  const client = new Client({ name: "offline", version: "1" });
  const external = new Client({ name: "external", version: "1" });
  const oldHttp = operatorHeaders(env);
  let owner: Awaited<ReturnType<typeof serveSocket>> | undefined;
  let revoker: Awaited<ReturnType<typeof serveSocket>> | undefined;
  let http: Awaited<ReturnType<typeof serveMcp>> | undefined;
  let dropped: ReturnType<typeof createServer> | undefined;
  let mutations = 0;
  try {
    await client.connect(new StdioClientTransport({ command: launch.command, args: launch.args, env: launch.env, stderr: "pipe" }));
    const offline = await client.listTools();
    assert.deepEqual(offline.tools.map(tool => tool.name), ["read", "mutate"]);
    const read = await client.callTool({ name: "read" });
    assert.deepEqual(read.structuredContent, { value: 17 });
    assert.deepEqual(read.content, [{ type: "text", text: "value=17" }]);
    assert.equal((await client.callTool({ name: "read", arguments: { extra: true } })).isError, true);
    const absent = await client.callTool({ name: "mutate" });
    assert.equal(absent.isError, true);
    assert.match(JSON.stringify(absent.content), /stack_service_unavailable.*demo.*mutate.*not executed.*stack serve/);
    // Exercise the authentication rotation that production Server startup runs,
    // not just the package socket becoming available.
    withLocalAuth(env, auth => auth.rotateForStartup());
    const { api } = await import(pathToFileURL(entry).href);
    owner = await serveSocket({ info: { name: "demo", description: "Owner", transportDescription: "Owner", path: socketPath("demo", env) }, operations: api.operations,
      context: { value: 23, mutate() { mutations++; throw new Error("handler refused"); } } });
    const recovered = await client.callTool({ name: "read" });
    assert.notEqual(recovered.isError, true, `same-pipe recovery: ${JSON.stringify(recovered.content)}`);
    assert.deepEqual(recovered.structuredContent, { value: 23 });
    assert.deepEqual(await client.listTools(), offline);
    http = await serveMcp({ root, env, port: 0 });
    for (const headers of [oldHttp, { authorization: launch.env.STACK_MCP_OPERATOR! }]) {
      assert.equal((await fetch(http.urls.demo!, { method: "POST", headers, body: "{}" })).status, 401, "neither stale HTTP nor private stdio authority authorizes external HTTP");
    }
    await external.connect(new StreamableHTTPClientTransport(new URL(http.urls.demo!), { requestInit: { headers: operatorHeaders(env) } }));
    assert.deepEqual((await external.listTools()).tools.map(tool => tool.name), ["read", "mutate"]);
    await external.close();
    assert.match(JSON.stringify((await client.callTool({ name: "mutate" })).content), /handler refused/);
    assert.equal(mutations, 1);
    await owner.close(); owner = undefined;
    let dispatches = 0;
    dropped = createServer(socket => socket.once("data", () => { dispatches++; socket.destroy(); }));
    await new Promise<void>(resolve => dropped!.listen(socketPath("demo", env), resolve));
    for (const name of ["read", "mutate"]) {
      const lost = await client.callTool({ name });
      assert.equal(lost.isError, true);
      assert.match(JSON.stringify(lost.content), /stack_service_outcome_unknown.*Outcome unknown.*dispatched.*do not automatically retry/);
      assert.equal(lost.structuredContent, undefined, "even an opted read must not fall back after dispatch");
    }
    assert.equal(dispatches, 2, "one dispatch per call, with no replay");
    await new Promise<void>(resolve => dropped!.close(() => resolve())); dropped = undefined;
    for (const authority of [{ kind: "bot" as const, botId: "bot-1", endpoint: "unix:///fixture/bot.sock" }, { kind: "worker" as const, workerId: randomUUID(), instance: randomUUID() }]) {
      const managed = (await internalMcpLaunches(root, authority, env)).demo!;
      const client = new Client({ name: "offline-managed", version: "1" });
      try {
        await client.connect(new StdioClientTransport({ ...managed, stderr: "pipe" }));
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), authority.kind === "worker" ? ["read"] : ["read", "mutate"]);
        const result = await client.callTool({ name: "read", _meta: { threadId: "root" } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /stack_service_unavailable.*live managed identity owner.*not executed/);
      } finally { await client.close(); }
    }
    await manifest("[missing]");
    await assert.rejects(client.listTools(), /unknown name: missing/);
    assert.equal((await client.callTool({ name: "read" })).isError, true);
    await manifest();
    assert.deepEqual((await client.callTool({ name: "read" })).structuredContent, { value: 17 });
    // The real private-socket operation owns revoke-all semantics. Import only
    // its declaration; no Server context, children or full Stack are started.
    const { serverLocalRevoke } = await import(new URL("../../../serve/dist/api.js", import.meta.url).href);
    revoker = await serveSocket({ info: { name: "serve", description: "Owner", transportDescription: "Owner", path: socketPath("serve", env) },
      operations: [serverLocalRevoke], context: { env } });
    assert.deepEqual(await socketCall(revoker.path, "tools/call", { name: "serve_local_revoke", arguments: {} }), { revoked: true });
    const denied = async () => {
      for (const name of ["read", "mutate"]) {
        const result = await client.callTool({ name });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /local authentication required/);
        assert.equal(result.structuredContent, undefined);
      }
      await assert.rejects(client.listTools(), /local authentication required/);
    };
    await denied(); // Includes an opted stored read with no package socket.
    let liveReads = 0;
    owner = await serveSocket({ info: { name: "demo", description: "Owner", transportDescription: "Owner", path: socketPath("demo", env) }, operations: api.operations,
      context: { get value() { liveReads++; return 29; }, mutate() { mutations++; return { value: 29 }; } } });
    withLocalAuth(env, auth => auth.rotateForStartup());
    await denied(); // Starting the backend never renews the captured credential.
    assert.equal(liveReads, 0);
    assert.equal(mutations, 1);
    const freshLaunch = (await internalMcpLaunches(root, { kind: "operator" }, env)).demo!;
    assert.notEqual(freshLaunch.env.STACK_MCP_OPERATOR, launch.env.STACK_MCP_OPERATOR);
    const fresh = new Client({ name: "explicit-relaunch", version: "1" });
    try {
      await fresh.connect(new StdioClientTransport({ ...freshLaunch, stderr: "pipe" }));
      assert.deepEqual((await fresh.callTool({ name: "read" })).structuredContent, { value: 29 });
      await denied();
    } finally { await fresh.close(); }
  } finally { await Promise.all([client.close(), external.close()]); await http?.close(); await revoker?.close(); await owner?.close(); await new Promise<void>(resolve => dropped ? dropped.close(() => resolve()) : resolve()); await rm(root, { recursive: true, force: true }); }
});

test("installed package stdio catalogs connect without Stack and owner-opted reads retrieve isolated stored data without creating services", { timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-owner-stdio-"));
  const env = { ...process.env, HOME: root, STACK_STATE_DIR: root, STACK_CONTENT_PORT: "0", STACK_CONTENT_ARTIFACT_PORT: "0" };
  const installed = workspaceRoot(import.meta.dirname);
  const { ResearchStore } = await import(new URL("../../../brain/dist/src/store.js", import.meta.url).href);
  const brain = new ResearchStore(join(root, "brain", "research.db"));
  const document = brain.upsertDocument({ sourceType: "text", sourceUri: "fixture:quasar", title: "Quasar research", content: "Quasar evidence retained offline.", tags: ["offline"] });
  brain.close();
  const { RoleStore } = await import(new URL("../../../roles/dist/src/store.js", import.meta.url).href);
  const roles = new RoleStore(root); const roleId = roles.defaultSnapshot().id; roles.close();
  const content = await loadPackageApi(join(installed, "packages", "content"));
  const ctx = await content.createContext(env);
  const seed = async (name: string, args: object) => {
    const op = content.operations.find(op => op.name === name)!;
    return op.call(ctx, op.input.parse(args));
  };
  let item: any, artifact: any;
  try {
    await seed("new", { title: "Offline Note", tags: "offline" });
    await seed("add", { title: "Link Note", content: "Read [[offline-note]] for Quasar evidence." });
    item = await seed("item_put", { name: "offline-image", kind: "image", mediaType: "image/png", base64: "aGVsbG8=" });
    await seed("collection_create", { slug: "offline", title: "Offline collection" });
    const bytes = Buffer.from("stored artifact bytes"), digest = createHash("sha256").update(bytes).digest("hex");
    const stage = await seed("blob_stage_start", { bytes: bytes.length, digest });
    await seed("blob_stage_chunk", { id: stage.id, offset: 0, base64: bytes.toString("base64") });
    await seed("blob_stage_finish", { id: stage.id });
    artifact = await seed("artifact_publish", { name: "offline-artifact", files: [{ name: "stored.txt", blob: digest }] });
  } finally { await content.closeContext(ctx); }
  const editedPath = join(root, "wiki", "vault", "offline-note.md");
  await writeFile(editedPath, "---\ntitle: Offline Note\ntags: [offline]\n---\nQuasar independently edited offline.\n");
  const paths = [join(root, "brain", "research.db"), join(root, "roles.sqlite"), join(root, "wiki", "collections", "collections.sqlite3"),
    join(root, "wiki", "artifacts", "manifest.sqlite3"), join(root, "wiki", "vault", ".git", "logs", "HEAD")];
  const before = await Promise.all(paths.map(path => readFile(path)));
  const launches = await internalMcpLaunches(installed, { kind: "operator" }, env);
  try {
    for (const [name, launch] of Object.entries(launches).filter(([name]) => !codexMcpDefinition(name))) {
      const client = new Client({ name: "installed-offline", version: "1" });
      try {
        await client.connect(new StdioClientTransport({ ...launch, stderr: "pipe" }));
        assert.ok((await client.listTools()).tools.length > 0, name);
        const read = async (operation: string, args: Record<string, unknown> = {}) => {
          const result = await client.callTool({ name: operation, arguments: args });
          assert.notEqual(result.isError, true, `${name}/${operation}: ${JSON.stringify(result.content)}`);
          return result.structuredContent as any;
        };
        if (name === "brain") {
          assert.equal((await read("stats")).document_count, 1);
          assert.equal((await read("search", { query: "Quasar" })).results[0].document_id, document.document_id);
          assert.equal((await read("context", { query: "Quasar" })).hits[0].document_id, document.document_id);
          assert.match((await read("get", { "document-id": document.document_id })).content, /Quasar/);
          assert.ok((await read("tags")).tags.length);
          const mutation = await client.callTool({ name: "submit", arguments: { source: "must not be admitted", kind: "text" } });
          assert.equal(mutation.isError, true);
          assert.match(JSON.stringify(mutation.content), /stack_service_unavailable.*submit.*not executed/);
        } else if (name === "roles") {
          assert.ok((await read("roles_snapshot")).roles.some((role: any) => role.id === roleId));
          assert.equal((await read("role_snapshot", { roleId })).id, roleId);
          assert.ok((await read("role_internal_mcp_list", { roleId })).servers.length);
          assert.equal((await read("role_preview", { roleId })).rendered, "");
        } else if (name === "content") {
          assert.equal((await read("search", { query: "Quasar" })).count, 2);
          assert.match((await read("get", { ref: "offline-note" })).content, /independently edited/);
          assert.equal((await read("list")).count, 3);
          assert.equal((await read("resolve", { phrase: "Offline Note" })).candidates[0].slug, "offline-note");
          assert.equal((await read("links", { ref: "link-note" })).outgoing[0].to, "offline-note");
          assert.equal((await read("backlinks", { ref: "offline-note" })).incoming[0].from, "link-note");
          assert.ok((await read("graph")).nodes.length);
          assert.ok((await read("tags")).count);
          assert.equal((await read("collection_list")).collections[0].slug, "offline");
          assert.equal((await read("collection_get", { collection: "offline" })).title, "Offline collection");
          assert.equal((await read("item_list")).items[0].id, item.id);
          assert.equal((await read("item_read", { id: item.id })).base64, "aGVsbG8=");
          const media = await client.callTool({ name: "item_get", arguments: { id: item.id, includeData: true } });
          assert.deepEqual((media.content as any[])[1], { type: "image", mimeType: "image/png", data: "aGVsbG8=" });
          assert.equal((await read("artifacts_list")).artifacts[0].name, "offline-artifact");
          assert.equal((await read("artifacts_show", { name: "offline-artifact" })).version, artifact.version);
          assert.equal((await read("artifacts_versions", { name: "offline-artifact" })).versions[0].version, artifact.version);
        } else if (name === "notify") {
          const notice = await client.callTool({ name: "notification_send", arguments: { title: "Offline fixture", message: "Must not be stored", actions: ["Yes"] } });
          assert.equal(notice.isError, true);
          assert.match(JSON.stringify(notice.content), /stack_service_unavailable.*notification_send.*not executed/);
          const watched = await client.callTool({ name: "notification_send", arguments: { title: "Offline fixture", message: "Must not be stored", subscribe: true } });
          assert.equal(watched.isError, true);
          assert.match(JSON.stringify(watched.content), /verified Bot MCP call and sanctioned Chat.*nothing was sent/);
        } else if (name === "api") assert.ok((await read("docs_get", { package: "brain" })).operations.find((op: any) => op.name === "search").standalone);
      } finally { await client.close(); }
    }
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before, "authoritative metadata and Brain bytes stay unchanged");
    await assert.rejects(readFile(join(root, "brain", "share-ingress.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "event-subscriptions.sqlite")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "notify", "notifications.sqlite")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
