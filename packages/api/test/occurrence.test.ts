import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { packageMcpServer } from "../src/mcp-package.js";
import { pollEvent, pollOutput, type Occurrence } from "../src/occurrence.js";
import { McpEventSubscriptions } from "../src/mcp-subscriptions.js";
import { subscriptionService } from "../src/mcp-events.js";
import { serveSocket } from "../src/socket.js";
import { socketPath } from "../src/workspace.js";
import type { InvocationContext } from "../src/operation.js";
import type { OccurrenceRuntime } from "../src/occurrence-subscriptions.js";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!await check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(await check(), "expected occurrence state did not arrive");
}

test("draft poll requests and durable Worker intake remain distinct from snapshot watches and uncertain native delivery", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-occurrence-")), env = { STACK_STATE_DIR: root };
  const dir = join(root, "packages", "sample"); await mkdir(dir, { recursive: true });
  const manifest = (selection: string) => writeFile(join(dir, "api.yaml"), `name: sample\ndescription: Fixture.\nmcp:\n  description: Fixture.\n  operations: all\n  events: ${selection}\n  workerEvents: [arrived]\n`);
  await manifest("all");
  const history: Occurrence[] = [];
  let ephemeral = true;
  const source = pollEvent({ name: "arrived", operation: "read_events", description: "Read fixture occurrences.",
    input: z.strictObject({ filter: z.string() }), payload: z.strictObject({ value: z.string() }),
    async poll(_ctx, args, request) {
      if (args.filter === "ephemeral") {
        const events = ephemeral ? [{ eventId: "ephemeral", name: "arrived", timestamp: new Date().toISOString(), data: { value: "ephemeral" } }] : [];
        ephemeral = false;
        return { events, cursor: null, truncated: false, hasMore: false, nextPollMs: 1000 };
      }
      const position = request.cursor === null ? history.length : Number(request.cursor);
      return { events: history.slice(position).filter(event => event.data.value === args.filter).slice(0, request.maxEvents), cursor: String(history.length), truncated: false, hasMore: false, nextPollMs: 1000 };
    } });
  const socket = await serveSocket({ info: { name: "sample", description: "Fixture.", transportDescription: "Fixture.", path: socketPath("sample", env) }, context: {}, operations: [source] });
  const invocation: InvocationContext = { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null, workerId: "worker", workerInstance: "instance" };
  let attempts = 0;
  const delivered: Occurrence[] = [];
  const runtime: OccurrenceRuntime = {
    async resolve(input) { assert.equal(input.workerId, "worker"); return { kind: "worker", workerId: "worker", instance: "instance", sessionId: "session" }; },
    async verify(target) { return target; },
    async deliver(_target, event, _id, _policy, _signal, authorize) {
      await authorize(); attempts++;
      if (event.eventId === "second") throw new Error("input response lost after dispatch");
      delivered.push(event); return { boundary: "worker_inbox" };
    },
  };
  const owner = () => new McpEventSubscriptions(env, async () => { throw new Error("Worker must not acquire Bot lineage"); }, async () => { throw new Error("not a snapshot"); }, undefined, undefined, root, runtime);
  let service = owner();
  const server = packageMcpServer("sample", "Fixture.", root, env, { workerId: "worker", instance: "instance" }, async () => {}, subscriptionService(service, root, env));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "events-test", version: "1" });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const registry = await client.request({ method: "events/list", params: {} }, z.object({ events: z.array(z.any()) }));
    assert.equal(registry.events[0].name, "arrived"); assert.deepEqual(registry.events[0].delivery, ["poll"]);
    assert.deepEqual(registry.events[0].payloadSchema.required, ["value"]);
    const request = { name: "arrived", arguments: { filter: "match" }, cursor: null };
    const initial = await client.request({ method: "events/poll", params: request }, pollOutput);
    assert.deepEqual(initial.events, []); assert.equal(initial.cursor, "0");
    await assert.rejects(client.request({ method: "events/poll", params: { ...request, arguments: {} } }, pollOutput), error => (error as { code: number }).code === -32602);
    await assert.rejects(client.request({ method: "events/poll", params: { ...request, name: "missing" } }, pollOutput), error => (error as { code: number }).code === -32011);
    await assert.rejects(client.request({ method: "events/subscribe", params: {} }, z.any()), error => (error as { code: number }).code === -32014);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes("events_listen") && !tools.includes("events_subscribe"));
    const listening = await client.callTool({ name: "events_listen", arguments: { name: "arrived", arguments: { filter: "match" } } });
    assert.notEqual(listening.isError, true);
    const sub = (listening.structuredContent as { subscription: { id: string } }).subscription;
    const add = (eventId: string) => history.push({ eventId, name: "arrived", timestamp: new Date().toISOString(), data: { value: "match" } });
    add("first");
    await until(async () => delivered.length === 1);
    assert.equal((await service.occurrences!.status(invocation))[0]!.deliveries[0]!.boundary, "worker_inbox");
    add("second");
    await until(async () => (await service.occurrences!.status(invocation))[0]!.deliveries.some(row => row.state === "unknown"));
    assert.equal(attempts, 2); assert.equal(delivered[0]!.eventId, "first");
    const repeat = await service.occurrences!.subscribe("sample", { name: "arrived", arguments: { filter: "match" } }, invocation);
    assert.equal(repeat.id, sub.id); assert.equal(repeat.cursor, "2");
    await service.close(); service = owner(); service.resume(); add("third");
    await until(async () => !!(await service.occurrences!.status(invocation))[0]!.lastError);
    assert.equal(attempts, 2, "restart must not replay an uncertain native attempt or pass it");
    await manifest("[]");
    assert.deepEqual((await client.request({ method: "events/list", params: {} }, z.object({ events: z.array(z.any()) }))).events, []);
    await assert.rejects(client.request({ method: "events/poll", params: { ...request, cursor: "0" } }, pollOutput), error => (error as { code: number }).code === -32011);
    await service.occurrences!.unsubscribe(sub.id, invocation);
    assert.deepEqual(await service.occurrences!.status(invocation), []);
    await manifest("all");
    await service.occurrences!.subscribe("sample", { name: "arrived", arguments: { filter: "ephemeral" } }, invocation);
    await until(async () => delivered.some(event => event.eventId === "ephemeral"));
    assert.equal(delivered.filter(event => event.eventId === "ephemeral").length, 1, "a cursor-less occurrence in the first response must not be discarded by bootstrap");
  } finally { await client.close(); await server.close(); await service.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});

test("competing occurrence polls enforce the shared retained-receipt cap without advancing a refused cursor", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-occurrence-limit-")), env = { STACK_STATE_DIR: root };
  const dir = join(root, "packages", "sample"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "api.yaml"), "name: sample\ndescription: Fixture.\nmcp:\n  description: Fixture.\n  operations: all\n  events: all\n  workerEvents: [arrived]\n");
  let release!: () => void, polls = 0;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const source = pollEvent({ name: "arrived", operation: "read_events", description: "Fixture.",
    input: z.strictObject({ id: z.string() }), payload: z.strictObject({ value: z.string() }),
    async poll(_ctx, args, request) {
      if (request.cursor === null) return { events: [], cursor: "0", truncated: false, hasMore: false, nextPollMs: 1000 };
      polls++; await ready;
      return { events: request.cursor === "0" ? [{ eventId: args.id, name: "arrived", timestamp: new Date().toISOString(), data: { value: args.id } }] : [],
        cursor: "1", truncated: false, hasMore: false, nextPollMs: 1000 };
    } });
  const socket = await serveSocket({ info: { name: "sample", description: "Fixture.", transportDescription: "Fixture.", path: socketPath("sample", env) }, context: {}, operations: [source] });
  const invocation: InvocationContext = { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null, workerId: "worker", workerInstance: "instance" };
  let attempts = 0;
  const runtime: OccurrenceRuntime = {
    async resolve() { return { kind: "worker", workerId: "worker", sessionId: "session", instance: "instance" }; },
    async verify(target) { return target; },
    async deliver(_target, _event, _id, _policy, _signal, authorize) { await authorize(); attempts++; return { boundary: "worker_inbox" }; },
  };
  const service = new McpEventSubscriptions(env, async () => {}, async () => {}, undefined, undefined, root, runtime);
  try {
    const first = await service.occurrences!.subscribe("sample", { name: "arrived", arguments: { id: "first" } }, invocation);
    await service.occurrences!.subscribe("sample", { name: "arrived", arguments: { id: "second" } }, invocation);
    await until(async () => polls >= 2);
    // Model retained history committing while both upstream polls are in flight.
    // This is a durable recovery fixture, not a configurable production limit.
    const db = new DatabaseSync(join(root, "event-subscriptions.sqlite"));
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO occurrence_deliveries VALUES(?,?,?,?,'admitted','worker_inbox',NULL)");
    for (let n = 0; n < 9999; n++) insert.run(randomUUID(), first.id, `retained-${n}`, "{}");
    db.exec("COMMIT"); db.close(); release();
    await until(async () => attempts >= 1 && (await service.occurrences!.status(invocation)).some(row => row.lastError?.includes("ResourceExhausted")));
    const rows = await service.occurrences!.status(invocation);
    assert.equal(rows.reduce((sum, row) => sum + row.receiptCount, 0), 10_000);
    assert.equal(attempts, 1, "only the capacity winner may admit new input");
    assert.equal(rows.find(row => row.lastError?.includes("ResourceExhausted"))!.cursor, "0", "a refused batch must remain replayable from its previous cursor");
    assert.equal(rows.reduce((sum, row) => sum + row.deliveries.length, 0), 128, "conversation receipt output remains bounded across subscriptions");
    assert.ok(rows.some(row => row.receiptsTruncated));
  } finally { release(); await service.close(); await socket.close(); await rm(root, { recursive: true, force: true }); }
});
