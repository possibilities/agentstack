import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { operation, serveSocket, socketPath, type StatePlan } from "@stack/api";
import { z } from "zod";
import { api, createBrainContext, closeBrainContext, type BrainContext } from "../api.js";
import { admitSubmission } from "../src/admission.js";
import { SourceRegistry } from "../src/sources.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-state-"));
  const env = { HOME: root, STACK_STATE_DIR: root, STACK_BRAIN_SHARE_PORT: "0" };
  const ctx = await createBrainContext(env, { pollMs: 60_000, extract: async () => { throw new Error("network forbidden"); } });
  async function call(name: string, args: unknown = {}, invocation?: Parameters<typeof api.operations[number]["call"]>[2]) {
    const op = api.operations.find(op => op.name === name)!;
    return op.output.parse(await op.call(ctx, op.input.parse(args), invocation)) as any;
  }
  return { root, env, ctx, call, close: async () => { await closeBrainContext(ctx); rmSync(root, { recursive: true, force: true }); } };
}
const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });

test("terminal job payload clearing retains device dedupe, siblings, dispositions and truthful readers", async () => {
  const f = await fixture();
  try {
    const intent = { version: 1 as const, source: "https://example.test/private", kind: "url" as const, ingress: "device", idempotencyKey: "device-one", title: "private title", notes: "private note" };
    const job = admitSubmission(f.ctx.store, intent);
    f.ctx.store.cancelJob({ jobId: job.job_id, reason: "private reason" });
    const before = await f.call("jobs_show", { "job-id": job.job_id });
    const sibling = admitSubmission(f.ctx.store, { ...intent, idempotencyKey: "device-two" });
    const blocked = await f.call("brain_jobs_plan", { ids: [sibling.job_id], scope: "payload" });
    assert.ok(blocked.blockedBy.length);
    await assert.rejects(f.call("brain_jobs_clear", apply(blocked)), /active|claimed/);
    const plan = await f.call("brain_jobs_plan", { ids: [job.job_id], scope: "payload" });
    const request = apply(plan);
    const receipt = await f.call("brain_jobs_clear", request);
    assert.equal(receipt.status, "completed");
    assert.deepEqual(await f.call("brain_jobs_clear", request), receipt);
    assert.deepEqual((await f.call("brain_state_receipt_get", { requestId: request.requestId })).receipt, receipt);
    assert.deepEqual((await f.call("jobs_show", { "job-id": job.job_id })).transitions, before.transitions);
    const revealed = await f.call("jobs_reveal", { "job-id": job.job_id });
    assert.equal(revealed.intent.redacted, true);
    assert.ok(revealed.content_cleared_at);
    assert.deepEqual(revealed.intent.payload, {});
    assert.deepEqual(revealed.intent.options, {});
    assert.equal(revealed.state, "cancelled");
    // Reveal appends its own sensitive-inspection transition; cleanup does not.
    assert.ok(revealed.transitions.length > before.transitions.length);
    assert.equal(JSON.stringify(revealed).includes("private"), false);
    assert.equal((await f.call("jobs_show", { "job-id": job.job_id })).content_cleared_at, revealed.content_cleared_at);
    assert.equal((await f.call("jobs_reveal", { "job-id": sibling.job_id })).intent.payload.url.url, intent.source);
    assert.equal(admitSubmission(f.ctx.store, intent).status, "duplicate");
    assert.equal(admitSubmission(f.ctx.store, intent).job_id, job.job_id);
    assert.throws(() => admitSubmission(f.ctx.store, { ...intent, source: "https://example.test/changed" }), /different intent/);
    assert.throws(() => f.ctx.store.retryJob({ jobId: job.job_id }), /content_cleared/);
    const stale = await f.call("brain_jobs_plan", { ids: [job.job_id], scope: "payload" });
    await f.call("jobs_reveal", { "job-id": job.job_id });
    await assert.rejects(f.call("brain_jobs_clear", apply(stale)), /changed/);
    await assert.rejects(f.call("brain_jobs_plan", { ids: [job.job_id], scope: "payload" }, { transport: "mcp", botId: null, instance: null, threadId: null, sessionId: null, workerId: "untrusted" }), /operator authority/);
  } finally { await f.close(); }
});

test("source maintenance is paused/drained, keeps documents and jobs, and permanently retires removed identities", async () => {
  const f = await fixture();
  let revision = 1;
  const proc = await serveSocket({ info: { name: "proc", path: socketPath("proc", f.env), description: "Protected scheduler fixture", transportDescription: "local" }, context: {},
    operations: [operation({ name: "proc_schedule_get", description: "Protected Brain schedule", input: z.strictObject({ id: z.string(), includeRemoved: z.boolean() }), output: z.object({ system: z.boolean(), revision: z.number(), action: z.object({ type: z.string(), package: z.string(), operation: z.string() }) }),
      async call(_ctx, input) { assert.equal(input.id, "00000000-0000-4000-8000-000000000001"); return { system: true, revision, action: { type: "api", package: "brain", operation: "sources_sync" } }; } })] });
  try {
    const registry = new SourceRegistry(f.ctx.store);
    const definition = { id: "source-one", version: 1, kind: "blog_feed" as const, display_name: "Source", enabled: true, payload: { feed_url: "https://example.test/feed" },
      schedule: { cadence_seconds: 3600 }, limits: { max_items_per_run: 10, max_pages_per_run: 1 }, collections: [], sensitivity: "public" as const, credential_refs: [] };
    registry.applySourceDefinitions([definition]);
    const active = await f.call("brain_source_plan", { id: definition.id, action: "remove" });
    await assert.rejects(f.call("brain_source_clear", apply(active)), /Pause/);
    await f.call("sources_pause", { "source-id": definition.id });
    const document = f.ctx.store.upsertDocument({ sourceType: "text", sourceUri: "fixture:retained", content: "indexed evidence" });
    const id = (await f.call("sources_show", { "source-id": definition.id })).database_id;
    f.ctx.store.db.query("UPDATE sources SET checkpoint=? WHERE id=?").run('{"cursor":"private"}', id);
    const job = f.ctx.store.enqueueJob({ idempotencyKey: "retained-source-job", kind: "url", intent: { url: "https://example.test/item" }, sourceId: id });
    const reset = await f.call("brain_source_plan", { id: definition.id, action: "checkpoint_reset" });
    assert.ok(reset.regeneration.some((text: string) => text.includes("spend")));
    const request = apply(reset);
    const receipt = await f.call("brain_source_clear", request);
    assert.deepEqual(await f.call("brain_source_clear", request), receipt);
    const shown = await f.call("sources_show", { "source-id": definition.id });
    assert.equal(shown.checkpoint.present, false);
    assert.equal(shown.checkpoint_generation, 1);
    assert.equal(shown.paused, true);
    assert.equal((await f.call("jobs_show", { "job-id": job.job.id })).state, "queued");
    assert.equal((await f.call("get", { "document-id": document.document_id })).content, "indexed evidence");
    const stale = await f.call("brain_source_plan", { id: definition.id, action: "remove" });
    revision++;
    await assert.rejects(f.call("brain_source_clear", apply(stale)), /changed/);
    const removed = await f.call("brain_source_plan", { id: definition.id, action: "remove" });
    await f.call("brain_source_clear", apply(removed));
    const retired = await f.call("sources_show", { "source-id": definition.id });
    assert.ok(retired.removed_at); assert.equal(retired.enabled, false); assert.equal(retired.executable, false);
    await assert.rejects(f.call("sources_resume", { "source-id": definition.id }), /source_removed/);
    assert.throws(() => registry.applySourceDefinitions([{ ...definition, version: 2 }]), /source_removed/);
  } finally { await proc.close(); await f.close(); }
});

test("Run payload retirement preserves immutable recovery authority and refuses active claims", async () => {
  const f = await fixture();
  try {
    const at = new Date().toISOString();
    const run = { id: Number(f.ctx.store.db.query("INSERT INTO runs(run_type,state,created_at,updated_at) VALUES(?,?,?,?)").run("maintenance-fixture", "pending", at, at).lastInsertRowid) };
    const job = f.ctx.store.enqueueJob({ idempotencyKey: "run-job", kind: "text", intent: { body: "private payload" }, runId: run.id });
    const live = await f.call("brain_runs_plan", { ids: [run.id], scope: "payload" });
    await assert.rejects(f.call("brain_runs_clear", apply(live)), /drained/);
    f.ctx.store.cancelJob({ jobId: job.job.id });
    f.ctx.store.db.query("UPDATE runs SET state='cancelled',checkpoint=?,warnings=? WHERE id=?").run('"private cursor"', '["private warning"]', run.id);
    f.ctx.store.db.query("INSERT INTO operator_run_policies VALUES(?,?,?,?,?,?)").run(run.id, "offline", "a".repeat(64), '["text"]', 1, new Date().toISOString());
    const policy = f.ctx.store.db.query("SELECT * FROM operator_run_policies WHERE run_id=?").get(run.id);
    const document = f.ctx.store.upsertDocument({ sourceType: "text", sourceUri: "fixture:run-document", content: "indexed run evidence" });
    const resource = Number(f.ctx.store.db.query("INSERT INTO resources(key_type,key_value,kind,sensitivity,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("fixture", "run-document", "text", "normal", document.document_id, at, at).lastInsertRowid);
    f.ctx.store.db.query("UPDATE jobs SET resource_id=? WHERE id=?").run(resource, job.job.id);
    const indexed = await f.call("brain_runs_plan", { ids: [run.id], scope: "payload" });
    await assert.rejects(f.call("brain_runs_clear", apply(indexed)), /indexed documents/);
    // Existing document deletion remains usable for a drained controlled Run;
    // redaction must not relax its immutable generation/authorization binding.
    f.ctx.store.deleteDocument({ documentId: document.document_id, confirm: "delete" });
    const plan = await f.call("brain_runs_plan", { ids: [run.id], scope: "payload" });
    const request = apply(plan);
    await f.call("brain_runs_clear", request);
    assert.deepEqual(f.ctx.store.db.query("SELECT * FROM operator_run_policies WHERE run_id=?").get(run.id), policy);
    const record = await f.call("jobs_run", { "run-id": run.id });
    assert.ok(record.content_cleared_at); assert.ok(record.payload_digest);
    assert.equal(record.state, "cancelled");
    assert.equal(JSON.stringify(await f.call("jobs_reveal", { "job-id": job.job.id })).includes("private"), false);
    assert.throws(() => f.ctx.store.db.query("UPDATE operator_run_policies SET authorization_digest=? WHERE run_id=?").run("b".repeat(64), run.id), /immutable/);
    assert.throws(() => f.ctx.store.retryJob({ jobId: job.job.id }), /content_cleared/);
  } finally { await f.close(); }
});

test("Artifact collection fences new references, retains siblings, and interrupted admission never re-executes", async () => {
  const f = await fixture();
  try {
    const objects = ["first", "second", "sibling"].map(body => f.ctx.artifacts.captureBytes(body));
    for (const object of objects) f.ctx.store.registerStoredArtifact(object, { mediaType: "text/plain", artifactRole: "original" });
    const stale = await f.call("brain_artifacts_plan", { digests: [objects[0].contentDigest] });
    const job = f.ctx.store.enqueueJob({ idempotencyKey: "new-reference", kind: "text", intent: { content_digest: objects[0].contentDigest } });
    await assert.rejects(f.call("brain_artifacts_clear", apply(stale)), /changed/);
    f.ctx.store.cancelJob({ jobId: job.job.id });
    await f.call("brain_jobs_clear", apply(await f.call("brain_jobs_plan", { ids: [job.job.id], scope: "payload" })));
    const plan = await f.call("brain_artifacts_plan", { digests: objects.slice(0, 2).map(row => row.contentDigest) });
    const request = apply(plan);
    assert.equal((await f.call("brain_artifacts_clear", request)).status, "completed");
    assert.equal(objects.slice(0, 2).some(row => existsSync(f.ctx.artifacts.pathFor(row.contentDigest))), false);
    assert.equal(f.ctx.artifacts.readUtf8(objects[2].contentDigest), "sibling");
    const interruptedPlan = await f.call("brain_artifacts_plan", { digests: [objects[2].contentDigest] });
    const interrupted = apply(interruptedPlan);
    f.ctx.state.journal.begin(interrupted, interruptedPlan);
    await closeBrainContext(f.ctx);
    const restarted: BrainContext = await createBrainContext(f.env, { pollMs: 60_000 });
    try {
      const receipt = restarted.state.clear(interrupted, "artifacts");
      assert.equal(receipt.status, "unknown");
      assert.equal(restarted.artifacts.readUtf8(objects[2].contentDigest), "sibling");
      assert.deepEqual(restarted.state.clear(interrupted, "artifacts"), receipt);
    } finally { await closeBrainContext(restarted); }
  } finally { await f.close(); }
});
