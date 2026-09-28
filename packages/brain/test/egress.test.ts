import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { currentEgress, EgressRefused } from "@agentstack/scrape/network";
import { ResearchEgress } from "../src/egress.js";
import { ResearchStore } from "../src/store.js";
import { ResearchCache } from "../src/db.js";
import { runWorker } from "../src/worker.js";
import { SourceRegistry } from "../src/sources.js";
import type { SourceDefinition } from "../src/types.js";
import { api, createBrainContext, closeBrainContext } from "../api.js";

const intent = (url: string) => ({ version: 1, kind: "url", ingress: "test", collections: [], payload: { url: { url } }, options: { tags: [], force: false, max_bytes: 5000 } });
function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "as-egress-"));
  const store = new ResearchStore(join(root, "research.db"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, policy: new ResearchEgress(store) };
}

test("grants are operator-only socket policy; ordinary shares cannot request private authority", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "as-egress-api-"));
  const ctx = await createBrainContext({ HOME: root, AGENTSTACK_STATE_DIR: root, AGENTSTACK_BRAIN_SHARE_PORT: "0" }, { pollMs: 60_000 });
  t.after(async () => { await closeBrainContext(ctx); rmSync(root, { recursive: true, force: true }); });
  const job = ctx.store.enqueueJob({ idempotencyKey: "private", kind: "url", intent: intent("http://10.0.0.1/doc.md") }).job;
  const create = api.operations.find((op) => op.name === "egress_grant_create")!;
  const args = create.input.parse({ scope: { kind: "job", id: job.id }, policy: { privateDestinations: [{ address: "10.0.0.1", port: 80 }] } });
  for (const invocation of [
    { transport: "mcp" as const, botId: "bot", instance: "launch", threadId: "thread", sessionId: null },
    { transport: "mcp" as const, botId: null, instance: null, threadId: null, sessionId: null, workerId: "worker", workerInstance: "runtime" },
    { transport: "mcp" as const, botId: null, instance: null, threadId: null, sessionId: null },
  ]) await assert.rejects(create.call(ctx, args, invocation), /operator_only/);
  const grant = create.output.parse(await create.call(ctx, args)) as { id: number };
  const show = api.operations.find((op) => op.name === "jobs_show")!;
  const shown = show.output.parse(await show.call(ctx, show.input.parse({ "job-id": job.id }))) as { network_policy: { grantId: number } };
  assert.equal(shown.network_policy.grantId, grant.id);
  const share = await fetch(`${ctx.server.url}/v1/share`, { method: "POST", headers: { authorization: `Bearer ${ctx.shareToken}`, "content-type": "application/json" },
    body: JSON.stringify({ client: "chrome-extension", url: "http://10.0.0.1/private", allowPrivateNetwork: true }) });
  assert.equal(share.status, 200);
  const admitted = await share.json() as { data: { job_id: number } };
  assert.equal(new ResearchEgress(ctx.store).forJob(admitted.data.job_id).grantId, null, "unrecognized share fields cannot authorize egress");
});

test("a queued private job is refused after revocation and has no automatic retry or index effects", async (t) => {
  const { store, policy } = fixture(t);
  const job = store.enqueueJob({ idempotencyKey: "private", kind: "url", intent: intent("http://127.0.0.1:9/doc.md") }).job;
  const grant = policy.create({ kind: "job", id: job.id }, { privateDestinations: [{ address: "127.0.0.1", port: 9 }] });
  assert.equal(policy.forJob(job.id).grantId, grant.id);
  policy.revoke(grant.id);
  const result = await runWorker(store, { once: true, installSignalHandlers: false });
  assert.equal(result.failed, 1);
  const row = store.db.query("SELECT state,failure_class,failure_summary FROM jobs WHERE id=?").get(job.id) as { state: string; failure_class: string; failure_summary: string };
  assert.equal(row.state, "failed");
  assert.equal(row.failure_class, "permanent");
  assert.match(row.failure_summary, /network_policy:private_destination/);
  const cache = new ResearchCache(store.dbPath);
  try { assert.equal(cache.stats({ topTags: 1, recent: 1 }).document_count, 0); } finally { cache.close(); }
  assert.equal((await runWorker(store, { once: true, installSignalHandlers: false })).claimed, 0);
});

test("revoking an active grant fences completion and revokes cached extraction reuse", async (t) => {
  const { store, policy } = fixture(t);
  const job = store.enqueueJob({ idempotencyKey: "race", kind: "url", intent: intent("http://10.0.0.1/doc.md") }).job;
  const grant = policy.create({ kind: "job", id: job.id }, { privateDestinations: [{ address: "10.0.0.1", port: 80 }] });
  const result = await runWorker(store, { once: true, installSignalHandlers: false, materialize: async (_job, _intent, context) => {
    assert.equal(currentEgress()!.policy.privateDestinations.length, 1);
    context.cache!.remember();
    assert.equal(context.cache!.valid(), true);
    policy.revoke(grant.id);
    return [{ sourceType: "url", sourceUri: "http://10.0.0.1/doc.md", title: "revoked", content: "must not be indexed" }];
  } });
  assert.equal(result.failed, 1);
  assert.equal((store.db.query("SELECT count(*) AS n FROM documents").get() as { n: number }).n, 0);
  const claim = store.db.query("SELECT id FROM attempts WHERE job_id=?").get(job.id) as { id: number };
  const prior = store.db.query("SELECT grant_id FROM egress_attempts WHERE attempt_id=?").get(claim.id) as { grant_id: number };
  assert.equal(prior.grant_id, grant.id);
  // A fresh public retry cannot use bytes promoted under the revoked authority.
  store.db.query("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);
  const retry = await runWorker(store, { once: true, installSignalHandlers: false, materialize: async (_job, _intent, context) => {
    assert.equal(currentEgress()!.policy.privateDestinations.length, 0);
    assert.equal(context.cache!.valid(), false);
    throw new EgressRefused("egress_grant_revoked");
  } });
  assert.equal(retry.failed, 1);
});

test("source grants bind definition versions and discovered children inherit only that source scope", async (t) => {
  const { store, policy } = fixture(t);
  const server = createServer((req, res) => {
    if (req.url === "/feed.xml") res.writeHead(200, { "content-type": "application/rss+xml" }).end(`<rss version="2.0"><channel><title>Local</title><link>${url}</link><item><guid>one</guid><title>One</title><link>${url}/one.md</link></item></channel></rss>`);
    else res.writeHead(200, { "content-type": "text/markdown" }).end("# Private source\n\nGranted evidence.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port, url = `http://127.0.0.1:${port}`;
  const definition: SourceDefinition = { id: "lan", version: 1, kind: "blog_feed", display_name: "LAN", enabled: true,
    payload: { feed_url: `${url}/feed.xml` }, schedule: { cadence_seconds: 3600 }, limits: { max_items_per_run: 5, max_pages_per_run: 2 }, collections: [], sensitivity: "normal", credential_refs: [] };
  const registry = new SourceRegistry(store);
  registry.applySourceDefinitions([definition]);
  const source = store.db.query("SELECT id,definition_version FROM sources").get() as { id: number; definition_version: number };
  const grant = policy.create({ kind: "source", id: source.id, version: source.definition_version }, { privateDestinations: [{ address: "127.0.0.1", port }] });
  registry.syncSource({ sourceId: "lan" });
  const result = await runWorker(store, { once: true, installSignalHandlers: false });
  assert.equal(result.completed, 2, JSON.stringify(store.db.query("SELECT state,failure_summary FROM jobs").all()));
  const child = store.db.query("SELECT id FROM jobs WHERE kind='url'").get() as { id: number };
  assert.equal(policy.forJob(child.id).grantId, grant.id);
  const unrelated = store.enqueueJob({ idempotencyKey: "unrelated", kind: "url", intent: intent(`${url}/one.md`) }).job;
  assert.equal(policy.forJob(unrelated.id).grantId, null);
  registry.applySourceDefinitions([{ ...definition, version: 2, payload: { feed_url: `${url}/changed.xml` } }]);
  assert.equal(policy.forJob(child.id).grantId, null);
  assert.throws(() => policy.create({ kind: "source", id: source.id, version: 1 }, grant.policy), /version_changed/);
});

test("schema migration keeps existing jobs and sources public-only and records no invented grants", (t) => {
  const { store, root } = fixture(t);
  const job = store.enqueueJob({ idempotencyKey: "legacy", kind: "url", intent: intent("http://10.0.0.1/doc.md") }).job;
  store.db.exec("DROP TABLE egress_extractions; DROP TABLE egress_attempts; DROP TABLE egress_grants; DROP TRIGGER jobs_egress_scope; ALTER TABLE jobs DROP COLUMN egress_scope; UPDATE meta SET value='12' WHERE key='schema_version';");
  const migrated = new ResearchStore(join(root, "research.db"));
  try {
    const policy = new ResearchEgress(migrated);
    assert.deepEqual(policy.list(), []);
    assert.deepEqual(policy.forJob(job.id), { scope: { kind: "job", id: job.id }, grantId: null, policy: { privateDestinations: [] } });
    assert.equal((migrated.db.query("SELECT intent FROM jobs WHERE id=?").get(job.id) as { intent: string }).intent, JSON.stringify(intent("http://10.0.0.1/doc.md")));
  } finally { migrated.close(); }
});
