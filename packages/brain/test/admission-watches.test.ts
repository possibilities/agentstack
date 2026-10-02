import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { botInstance, botMcpUrl, invocationContext, McpEventSubscriptions, operation, serveMcp, serveSocket, socketCall, socketPath, type EventValue, type InvocationContext } from "@stack/api";
import { api, createBrainContext, closeBrainContext } from "../api.js";
import { brainCompletionIdentityInput } from "../src/admission-watches.js";
import { ResearchStore, RESEARCH_SCHEMA_VERSION } from "../src/store.js";
import { ResearchCache } from "../src/db.js";
import { SourceRegistry } from "../src/sources.js";
import { createBackup, verifyBackup } from "../src/backup.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let n = 0; n < 300 && !check(); n++) await pause(10);
  assert.ok(check(), "completion did not settle");
}

test("Brain correlated admissions atomically bind exact jobs and fixed source sets with content-safe completion", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-brain-watches-")), dbPath = join(root, "brain", "research.db");
  const endpoint = "unix:///fixture/brain-bot.sock";
  const env = { HOME: root, STACK_STATE_DIR: root, STACK_BRAIN_SHARE_PORT: "0" }, caller: InvocationContext = { transport: "mcp", botId: "bot-1", instance: botInstance(endpoint), threadId: "chat", sessionId: null };
  await mkdir(join(root, "packages", "brain"), { recursive: true });
  await writeFile(join(root, "packages", "brain", "api.yaml"), "name: brain\ndescription: Brain\nmcp:\n  description: Brain\n  operations: all\n  events: [jobs_changed, sources_changed]\n");
  // The worker starts against an empty queue; keep its next scan outside this
  // bounded test while driving real ledger dispositions explicitly.
  const ctx = await createBrainContext(env, { pollMs: 60_000, extract: async () => { throw new Error("this test may not fetch network content"); } });
  const store = ctx.store;
  const deliveries: EventValue[] = [];
  const createOwner = () => new McpEventSubscriptions(env, async target => {
    if (target.botId !== caller.botId || target.instance !== caller.instance || target.threadId !== caller.threadId) throw new Error("outside the sanctioned Chat");
  }, async (event, _signal, authorize, submitting) => { await authorize(); submitting?.(); deliveries.push(event); }, undefined, undefined, root);
  let owner = createOwner();
  const capability = await serveSocket({ info: { name: "serve", description: "Capability", transportDescription: "Socket", path: socketPath("serve", env) }, context: {}, operations: [
    operation({ name: "serve_completion_check", description: "Verify reserved coordination", input: z.strictObject({ id: z.uuid(), package: z.string(), operation: z.string(), recordId: z.uuid(), caller: invocationContext }), output: z.object({ verified: z.boolean() }),
      async call(_ctx, input) { await owner.verifyCompletion(input.id, input.package, input.operation, input.recordId, input.caller); return { verified: true }; } }),
  ] });
  const brain = await serveSocket({ info: { name: "brain", description: "Brain", transportDescription: "Socket", path: socketPath("brain", env) }, context: ctx, operations: api.operations, events: { topics: api.events!.topics } });
  const bots = await serveSocket({ info: { name: "bots", description: "Live launch", transportDescription: "Socket", path: socketPath("bots", env) }, context: {}, operations: [
    operation({ name: "bot_list", description: "Read live launch", input: z.strictObject({}), output: z.any(), async call() { return { bots: [{ id: caller.botId, state: "running", url: endpoint, recoveryIssue: null }] }; } }),
  ] });
  let mcp = await serveMcp({ root, env, port: 0, subscriptions: owner });
  const call = (name: string, input: object) => socketCall(brain.path, "tools/call", { name, arguments: input }) as Promise<any>;
  const send = async (name: string, input: Record<string, unknown>) => {
    const response = await fetch(botMcpUrl(mcp.urls.brain!, caller.botId!, endpoint, env), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...input, subscribe: true }, _meta: { threadId: caller.threadId } } }) });
    assert.equal(response.status, 200);
    const frame = await response.json() as { result: { isError?: boolean; structuredContent?: any; content: unknown } };
    if (frame.result.isError) throw new Error(JSON.stringify(frame.result.content));
    return frame.result.structuredContent;
  };
  const pointer = (requestId: string) => ({ requestId, botId: caller.botId, threadId: caller.threadId });
  const count = (table: string) => (store.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  try {
    const requestId = randomUUID(), input = { requestId, source: "PRIVATE RAW TEXT", kind: "text", "idempotency-key": "PRIVATE KEY" };
    assert.deepEqual(await call("submission_completion", pointer(requestId)), { result: null });
    await assert.rejects(call("submit", { ...input, subscribe: true }), /verified Bot Chat/);
    await assert.rejects(send("submit", { ...input, wait: true }), /cannot wait/);
    await assert.rejects(send("sources_sync", { due: true, limit: 1001 }), /at most 1000/);
    assert.equal(count("jobs"), 0); assert.equal(count("admission_bindings"), 0);
    const first = await send("submit", input);
    assert.equal(first.status, "queued"); assert.equal(first.idempotency_key, "PRIVATE KEY"); assert.equal(first.subscription.state, "pending");
    assert.deepEqual(first.observation, { result: null });
    const { requestId: _requestId, ...duplicateInput } = input;
    const duplicate = await send("submit", duplicateInput);
    assert.ok(z.uuid().safeParse(duplicate.requestId).success, "HTTP MCP allocates a separate completion UUID, not the numeric job identity");
    assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.job_id, first.job_id);
    await assert.rejects(send("submit", { ...input, source: "different intent" }), /conflicts/);
    await assert.rejects(call("submission_completion", { ...pointer(requestId), threadId: "another" }), /another admission or Chat/);
    assert.equal(owner.status(caller).subscriptions.length, 2, "conflict cannot remove an established watch");
    await mcp.close(); await owner.close(); owner = createOwner(); owner.resume(); mcp = await serveMcp({ root, env, port: 0, subscriptions: owner });
    store.cancelJob({ jobId: first.job_id }); brain.publish!("jobs_changed");
    await until(() => owner.status(caller).completions.every(receipt => receipt.state === "delivered"));
    assert.equal(deliveries.length, 2);
    const settled = await call("submission_completion", pointer(requestId));
    assert.equal(settled.result.job_id, first.job_id); assert.equal(settled.result.state, "cancelled"); assert.equal(settled.result.scope, "exact_job");
    assert.equal((await send("submit", input)).subscription.state, "delivered", "request retry must not create another job/wakeup");
    assert.equal(count("jobs"), 1);

    // A write failure at the binding commit must roll back the nested admission.
    store.db.exec("CREATE TEMP TRIGGER refuse_binding BEFORE INSERT ON admission_bindings BEGIN SELECT RAISE(ABORT, 'binding_failed'); END");
    await assert.rejects(send("submit", { requestId: randomUUID(), source: "ROLLBACK PRIVATE TEXT", kind: "text" }), /binding_failed/);
    assert.equal(count("jobs"), 1, "binding must not follow a separately committed admission");
    store.db.exec("DROP TRIGGER refuse_binding");
    const clearPlan = await call("brain_jobs_plan", { ids: [first.job_id], scope: "payload" });
    await call("brain_jobs_clear", { planId: clearPlan.id, expectedRevision: clearPlan.revision, requestId: randomUUID() });
    assert.deepEqual(await call("submission_completion", pointer(requestId)), settled, "payload clearing must preserve exact admission observation");
    assert.equal((await send("submit", input)).job_id, first.job_id, "cleared admission retains its UUID binding and deduplication");

    const timestamp = new Date().toISOString(), url = "https://private.example/PRIVATE-URL";
    const document = store.upsertDocument({ sourceType: "url", sourceUri: url, title: "PRIVATE TITLE", content: "PRIVATE BODY" });
    store.db.query("INSERT INTO resources(key_type,key_value,kind,sensitivity,document_id,created_at,updated_at) VALUES ('url',?,'url','normal',?,?,?)").run(url, document.document_id, timestamp, timestamp);
    const indexedId = randomUUID();
    const indexed = await send("submit", { requestId: indexedId, source: url, kind: "url" });
    assert.equal(indexed.status, "already_indexed"); assert.equal(indexed.resource_key, `url:${url}`);
    assert.equal(indexed.subscription.state, "observed");
    assert.deepEqual(indexed.observation, { result: { kind: "already_indexed", document_id: document.document_id } });

    const registry = new SourceRegistry(store);
    const definition = (id: string) => ({ id, version: 1, kind: "blog_source" as const, display_name: "PRIVATE SOURCE", enabled: true,
      payload: { homepage_url: "https://source.example/PRIVATE-URL" }, schedule: { cadence_seconds: 3600 }, limits: { max_items_per_run: 25, max_pages_per_run: 3 }, collections: [], sensitivity: "normal" as const, credential_refs: [] });
    registry.applySourceDefinitions([definition("one")]);
    const sourceId = randomUUID(), sync = await send("sources_sync", { requestId: sourceId, due: true });
    assert.equal(sync.results.length, 1); assert.equal(sync.subscription.state, "pending");
    registry.applySourceDefinitions([definition("two")]);
    assert.equal((await send("sources_sync", { requestId: sourceId, due: true })).results.length, 1, "retry must not reevaluate a moved due set");
    registry.startSourceRun({ runId: sync.results[0].run_id });
    registry.finishSourceRun({ runId: sync.results[0].run_id, outcome: "partial", warnings: ["PRIVATE https://source.example/PRIVATE-URL"] });
    brain.publish!("sources_changed");
    await until(() => owner.status(caller, sync.subscription.id).completions[0]?.state === "delivered");
    const sourceResult = await call("sources_sync_completion", pointer(sourceId));
    assert.equal(sourceResult.result.run_count, 1); assert.equal(sourceResult.result.scope, "discovery_and_admission");
    assert.deepEqual(sourceResult.result.outcomes, { partial: 1 }); assert.equal(sourceResult.result.runs[0].warnings, 1);
    const dry = await send("sources_sync", { requestId: randomUUID(), "source-id": "two", "dry-run": true });
    assert.equal(dry.subscription.state, "observed"); assert.equal(dry.observation.result.no_run_count, 1);
    assert.deepEqual(dry.observation.result.admission_outcomes, { would_queue: 1 });

    registry.applySourceDefinitions(Array.from({ length: 51 }, (_, n) => definition(`page-${n}`)));
    const pagedId = randomUUID(), paged = await send("sources_sync", { requestId: pagedId, due: true, limit: 51 });
    assert.equal(paged.results.length, 51);
    for (const admission of paged.results) {
      registry.startSourceRun({ runId: admission.run_id });
      registry.finishSourceRun({ runId: admission.run_id, outcome: "cancelled" });
    }
    const page = await call("sources_sync_completion", pointer(pagedId));
    assert.equal(page.result.run_count, 51); assert.equal(page.result.runs.length, 50); assert.equal(page.result.nextOffset, 50); assert.equal(page.result.truncated, true);
    const tail = await call("sources_sync_completion", { ...pointer(pagedId), offset: page.result.nextOffset });
    assert.equal(tail.result.runs.length, 1); assert.equal(tail.result.nextOffset, null);
    assert.deepEqual([...page.result.runs, ...tail.result.runs].map(run => run.run_id), paged.results.map((admission: { run_id: number }) => admission.run_id), "summary pages must cover the same fixed Run set exactly");

    const retained = JSON.stringify(store.db.query("SELECT * FROM admission_bindings").all());
    for (const safe of [retained, JSON.stringify(deliveries.map(event => event.value)), JSON.stringify(sourceResult), JSON.stringify(indexed.observation), JSON.stringify(page)]) {
      assert.ok(!safe.includes("PRIVATE")); assert.ok(!safe.includes("https://")); assert.ok(!safe.includes("resource_key")); assert.ok(!safe.includes("idempotency_key"));
    }
    assert.equal(store.db.query("SELECT count(*) AS n FROM job_transitions WHERE reason='sensitive_inspection'").get().n, 0, "completion reads must never perform sensitive reveal");
    const backup = createBackup(store, join(root, "backup"), { artifactRoot: join(root, "brain", "artifacts") });
    assert.equal(verifyBackup(backup.backup_path).verified, true);
    const cache = new ResearchCache(backup.database_path);
    try { assert.equal((cache.db.query("SELECT count(*) AS n FROM admission_bindings").get() as { n: number }).n, count("admission_bindings")); }
    finally { cache.close(); }
  } finally { await mcp.close(); await owner.close(); await brain.close(); await closeBrainContext(ctx); await capability.close(); await bots.close(); await rm(root, { recursive: true, force: true }); }
});

test("Brain v14 migration adds content-free admission bindings while read-only retrieval never migrates", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-brain-watch-migration-")), dbPath = join(root, "research.db");
  let store = new ResearchStore(dbPath);
  try {
    store.db.exec("DROP TABLE admission_bindings; UPDATE meta SET value='14' WHERE key='schema_version'");
    store.close();
    assert.throws(() => new ResearchCache(dbPath), /older than supported/);
    store = new ResearchStore(dbPath);
    assert.equal(Number(store.db.query("SELECT value FROM meta WHERE key='schema_version'").get().value), RESEARCH_SCHEMA_VERSION);
    assert.equal(store.db.query("SELECT count(*) AS n FROM admission_bindings").get().n, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("completion identity reads return exact admission links for the local operator only", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-brain-identity-"));
  const env = { HOME: root, STACK_STATE_DIR: root, STACK_BRAIN_SHARE_PORT: "0" };
  const ctx = await createBrainContext(env, { pollMs: 60_000, extract: async () => { throw new Error("no network"); } });
  const dbPath = ctx.dbPath;
  const identity = api.operations.find((op) => op.name === "brain_completion_identity_get")!;
  const read = (input: Record<string, unknown>, invocation?: InvocationContext) =>
    identity.call(ctx, brainCompletionIdentityInput.parse(input), invocation);
  const bind = (requestId: string, operation: string, safe: unknown, botId = "bot-1", threadId = "chat") =>
    ctx.store.db.query("INSERT INTO admission_bindings(request_id,operation,bot_id,thread_id,input_digest,admission_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(requestId, operation, botId, threadId, "CANARY-INTENT-DIGEST", JSON.stringify(safe), new Date().toISOString());
  const source = (run_id: number | null) => ({ source_database_id: 1, status: run_id === null ? "not_due" : "queued", run_id, job_id: null, scheduled_for: null, dry_run: false });
  try {
    const job = randomUUID();
    bind(job, "submit", { version: 1, status: "queued", job_id: 7, intent_hash: "CANARY-INTENT", state: "queued" });
    const queued = await read({ requestId: job, botId: "bot-1", threadId: "chat", operation: "submit" });
    assert.deepEqual(queued, { link: { kind: "brain-submit", requestId: job, jobId: 7, documentId: null } },
      "a still-pending job resolves its admission identity");
    assert.ok(!JSON.stringify(queued).includes("CANARY"));

    const indexed = randomUUID();
    bind(indexed, "submit", { version: 1, status: "already_indexed", document_id: 42 });
    assert.deepEqual(await read({ requestId: indexed, botId: "bot-1", threadId: "chat", operation: "submit" }),
      { link: { kind: "brain-submit", requestId: indexed, jobId: null, documentId: 42 } });

    const empty = randomUUID();
    bind(empty, "sources_sync", [source(null), source(null)]);
    assert.deepEqual(await read({ requestId: empty, botId: "bot-1", threadId: "chat", operation: "sources_sync" }),
      { link: { kind: "brain-sources", requestId: empty, runIds: [] } });

    const thousand = randomUUID();
    bind(thousand, "sources_sync", Array.from({ length: 1000 }, (_, n) => source(1000 - n)).concat([source(5), source(7)]));
    const bounded = await read({ requestId: thousand, botId: "bot-1", threadId: "chat", operation: "sources_sync" });
    assert.equal((bounded.link as { runIds: number[] }).runIds.length, 1000, "the complete fixed Run set, deduplicated");
    assert.deepEqual((bounded.link as { runIds: number[] }).runIds.slice(0, 3), [1, 2, 3], "ascending");

    const over = randomUUID();
    bind(over, "sources_sync", Array.from({ length: 1001 }, (_, n) => source(n + 1)));
    await assert.rejects(read({ requestId: over, botId: "bot-1", threadId: "chat", operation: "sources_sync" }), /exceeds 1000/);

    for (const miss of [{ requestId: job, botId: "bot-1", threadId: "chat", operation: "sources_sync" },
      { requestId: job, botId: "other", threadId: "chat", operation: "submit" },
      { requestId: job, botId: "bot-1", threadId: "other", operation: "submit" },
      { requestId: randomUUID(), botId: "bot-1", threadId: "chat", operation: "submit" }])
      assert.deepEqual(await read(miss), { link: null });
    await assert.rejects(read({ requestId: job, botId: "bot-1", threadId: "chat", operation: "submit" },
      { transport: "mcp", botId: "bot-1", instance: "launch-1", threadId: "chat", sessionId: "s" }), /local operator/);
  } finally { await closeBrainContext(ctx); await rm(root, { recursive: true, force: true }); }
});
