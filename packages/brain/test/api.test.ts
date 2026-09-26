import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { api, createBrainContext, closeBrainContext, type BrainContext } from "../api.js";
import { ResearchCache } from "../src/db.js";
import { Database } from "../src/sqlite.js";
import { ResearchStore } from "../src/store.js";
import { SourceRegistry } from "../src/sources.js";

async function call(ctx: BrainContext, name: string, input: Record<string, unknown> = {}): Promise<any> {
  const op = api.operations.find((candidate) => candidate.name === name);
  assert.ok(op, name);
  return op.output.parse(await op.call(ctx, op.input.parse(input)));
}

test("Package API initializes isolated state and owns share-to-index processing and shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-api-"));
  const state = join(root, "state");
  const forbidden = join(root, "ignored");
  const ctx = await createBrainContext({ HOME: root, AGENTSTACK_STATE_DIR: state, AGENTSTACK_BRAIN_SHARE_PORT: "0", AGENTSTACK_BRAIN_DB: forbidden, XDG_DATA_HOME: forbidden }, {
    pollMs: 5, extract: async () => { throw new Error("this test may not perform network reads"); },
  });
  let url = "";
  try {
    const status = await call(ctx, "brain_status");
    url = status.shareUrl;
    assert.equal(status.database, join(state, "brain", "research.db"));
    assert.equal(status.artifactStore, join(state, "brain", "artifacts"));
    assert.equal(status.worker, "running");
    assert.equal((await call(ctx, "stats")).document_count, 0);
    assert.deepEqual(await call(ctx, "sources_list"), { sources: [] });
    assert.equal(existsSync(forbidden), false);
    assert.equal(existsSync(join(root, ".local")), false);
    const token = readFileSync(ctx.tokenPath, "utf8").trim();
    assert.ok(token.length >= 32);
    assert.equal(statSync(ctx.tokenPath).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(status).includes(token), false);
    assert.equal(api.operations.find((op) => op.name === "share_token_reveal")?.annotations?.readOnlyHint, false);
    assert.equal((await call(ctx, "share_token_reveal", { reveal: true })).token, token);

    const unauthorized = await fetch(`${url}/v1/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: "chrome-extension", text: "no admission" }) });
    assert.equal(unauthorized.status, 401);
    assert.equal((await call(ctx, "jobs_stats")).total, 0);
    const payload = { client: "chrome-extension", text: "# Isolated research\n\nQuasar evidence from an offline share.", tags: ["offline"], idempotency_key: "api-share" };
    const submitShare = async () => {
      const response = await fetch(`${url}/v1/share`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      return await response.json() as any;
    };
    const admitted = (await submitShare()).data;
    const replay = (await submitShare()).data;
    assert.equal(admitted.status, "queued");
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.job_id, admitted.job_id);
    let stateResult: any;
    for (let n = 0; n < 100; n++) {
      stateResult = await call(ctx, "jobs_show", { "job-id": admitted.job_id });
      if (stateResult.state === "completed") break;
      await sleep(10);
    }
    assert.equal(stateResult.state, "completed");
    const search = await call(ctx, "search", { query: "Quasar" });
    assert.equal(search.results.length, 1);
    const documentId = search.results[0].document_id;
    assert.match((await call(ctx, "get", { "document-id": documentId })).content, /Quasar/);
    assert.equal((await call(ctx, "context", { query: "Quasar" })).hits[0].document_id, documentId);
    const states = await fetch(`${url}/v1/shares?job_ids=${admitted.job_id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(((await states.json()) as any).data.shares[0].document_id, documentId);
    assert.equal((await call(ctx, "retag", { "dry-run": true })).success, true);
    assert.ok((await call(ctx, "tags")).tags.length > 0);
    const backup = join(root, "backup");
    assert.equal((await call(ctx, "backup_create", { output: backup })).artifact_count > 0, true);
    assert.equal((await call(ctx, "backup_verify", { backup })).verified, true);
    const removed = await call(ctx, "delete", { "document-id": documentId, confirm: "delete" });
    assert.equal(removed.deleted_document_id, documentId);
    assert.equal((await call(ctx, "search", { query: "Quasar" })).results.length, 0);
    const rotated = await call(ctx, "share_token_rotate");
    assert.notEqual(rotated.token, token);
    assert.equal(readFileSync(ctx.tokenPath, "utf8").trim(), rotated.token);
    assert.equal((await fetch(`${url}/v1/health`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(`${url}/v1/health`, { headers: { authorization: `Bearer ${rotated.token}` } })).status, 200);
  } finally { await closeBrainContext(ctx); }
  assert.equal(existsSync(ctx.registrationPath), false);
  assert.equal(ctx.workerState, "stopped");
  await assert.rejects(fetch(`${url}/v1/health`));
  await closeBrainContext(ctx);
  rmSync(root, { recursive: true, force: true });
});

test("API admission and source/operator dispositions use typed outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-operations-"));
  const ctx = await createBrainContext({ HOME: root, AGENTSTACK_STATE_DIR: root, AGENTSTACK_BRAIN_SHARE_PORT: "0" }, { pollMs: 60_000 });
  try {
    const admitted = await call(ctx, "submit", { source: "-offline operator text", kind: "text", "idempotency-key": "operator" });
    assert.equal(admitted.status, "queued");
    assert.equal((await call(ctx, "submit", { source: "-offline operator text", kind: "text", "idempotency-key": "operator" })).status, "duplicate");
    assert.equal((await call(ctx, "jobs_list")).jobs.length, 1);
    assert.equal(api.operations.find((op) => op.name === "jobs_show")?.annotations?.readOnlyHint, true);
    const revealed = await call(ctx, "jobs_reveal", { "job-id": admitted.job_id });
    assert.match(revealed.artifacts[0].body, /offline operator text/);
    const cancelled = await call(ctx, "jobs_cancel", { "job-id": admitted.job_id, reason: "fixture" });
    assert.equal(cancelled.job.state, "cancelled");
    assert.equal((await call(ctx, "jobs_retry", { "job-id": admitted.job_id })).state, "queued");
    assert.equal((await call(ctx, "jobs_exclude", { "job-id": admitted.job_id, reason: "fixture" })).state, "excluded");
    const manifest = join(root, "sources.json");
    writeFileSync(manifest, JSON.stringify({ schema_version: 1, sources: [{ id: "fixture", version: 1, kind: "blog_feed", display_name: "Fixture", enabled: false, payload: { feed_url: "https://example.test/feed" }, schedule: { cadence_seconds: 3600 }, limits: { max_items_per_run: 10, max_pages_per_run: 1 }, collections: [], sensitivity: "public", credential_refs: [] }] }));
    assert.equal((await call(ctx, "sources_apply", { manifest })).results[0].created, true);
    assert.equal((await call(ctx, "sources_show", { "source-id": "fixture" })).enabled, false);
    assert.equal((await call(ctx, "sources_status")).sources[0].id, "fixture");
    assert.equal((await call(ctx, "sources_sync", { "source-id": "fixture" })).results[0].status, "disabled");
    assert.equal((await call(ctx, "sources_pause", { "source-id": "fixture" })).paused, true);
    assert.equal((await call(ctx, "sources_resume", { "source-id": "fixture" })).paused, false);
  } finally { await closeBrainContext(ctx); rmSync(root, { recursive: true, force: true }); }
});

test("retrieval is structurally read-only, refuses absent DB and preserves indexed bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-readonly-"));
  try {
    const absent = join(root, "absent.db");
    assert.throws(() => new ResearchCache(absent), /not found/);
    assert.equal(existsSync(absent), false);
    const db = new Database(join(root, "fixture.db"));
    db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('original')"); db.close();
    const readOnly = new Database(join(root, "fixture.db"), { readonly: true });
    assert.throws(() => readOnly.exec("INSERT INTO proof VALUES ('mutation')"), /readonly|read.only/);
    assert.equal(readOnly.query("SELECT value FROM proof").get().value, "original"); readOnly.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every operation publishes a useful JSON output schema", () => {
  assert.ok(api.operations.length > 25);
  for (const op of api.operations) {
    const schema = z.toJSONSchema(op.output);
    assert.equal(schema.type, "object", op.name);
    z.toJSONSchema(op.input, { io: "input" });
  }
});

test("due Sources require explicit admission at startup and during maintenance", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "brain-due-"));
  const store = new ResearchStore(join(root, "brain", "research.db"));
  try {
    new SourceRegistry(store).applySourceDefinitions([{
      id: "due-fixture", version: 1, kind: "blog_feed", display_name: "Due fixture", enabled: true,
      payload: { feed_url: "https://example.test/feed" }, schedule: { cadence_seconds: 3600 },
      limits: { max_items_per_run: 10, max_pages_per_run: 1 }, collections: [], sensitivity: "public", credential_refs: [],
    }], { now: new Date("2020-01-01T00:00:00Z") });
  } finally { store.close(); }
  let discoveries = 0;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const ctx = await createBrainContext({ HOME: root, AGENTSTACK_STATE_DIR: root, AGENTSTACK_BRAIN_SHARE_PORT: "0" }, {
    pollMs: 5,
    extract: async () => { throw new Error("unexpected URL extraction"); },
    sourceDiscovery: {
      discoverXTimeline: async () => { throw new Error("unexpected timeline discovery"); },
      discoverFeed: async ({ sourceUrl }) => {
        discoveries++;
        return {
          schema_version: "1", status: "success", source_url: sourceUrl, source_format: "rss",
          validators: { etag: null, last_modified: null }, cursor: { validators: { etag: null, last_modified: null }, newest_seen_at: null, next_url: null }, items: [],
          pagination: { pages: [{ url: sourceUrl, page_format: "rss", validators: { etag: null, last_modified: null }, item_count: 0, next_url: null }], complete: true, stop_reason: "exhausted", next_url: null },
          warnings: [], absence_implies_deletion: false, failure: null,
        };
      },
    },
  });
  try {
    await sleep(30);
    const before = (await call(ctx, "sources_status")).sources[0];
    assert.equal(before.due, true);
    assert.equal(before.latest_run, null);
    assert.deepEqual(await call(ctx, "jobs_list"), { jobs: [] });
    t.mock.timers.tick(60_000);
    assert.ok(ctx.maintenanceTask);
    await ctx.maintenanceTask;
    assert.equal(ctx.health, null);
    assert.deepEqual(await call(ctx, "jobs_list"), { jobs: [] });
    assert.equal(discoveries, 0);
    const sync = await call(ctx, "sources_sync", { due: true });
    assert.equal(sync.results.length, 1);
    assert.equal(sync.results[0].status, "queued");
    let job: any;
    for (let n = 0; n < 200; n++) {
      job = await call(ctx, "jobs_show", { "job-id": sync.results[0].job_id });
      if (job.state === "completed") break;
      await sleep(10);
    }
    assert.equal(job.state, "completed");
    assert.equal(discoveries, 1);
    assert.equal((await call(ctx, "sources_status")).sources[0].due, false);
    // Exercise the wait-result wrapper as well as the admission-result wrapper.
    const waited = await call(ctx, "sources_sync", { "source-id": "due-fixture", wait: true, "wait-poll-ms": 25 });
    assert.equal(waited.results[0].execution.job.state, "completed");
    assert.equal(waited.results[0].timed_out, false);
    assert.equal(discoveries, 2);
  } finally {
    await closeBrainContext(ctx);
    t.mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing Brain cancels active extraction and waiting admission without losing the durable job", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-cancel-"));
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let aborted = false;
  const ctx = await createBrainContext({ HOME: root, AGENTSTACK_STATE_DIR: root, AGENTSTACK_BRAIN_SHARE_PORT: "0" }, {
    pollMs: 5,
    extract: async (_url, options) => {
      markStarted();
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled fixture")); }, { once: true });
      });
      throw new Error("unreachable");
    },
  });
  try {
    const waiting = call(ctx, "submit", { source: "https://example.test/cancel", kind: "url", wait: true, "wait-timeout-ms": 60_000 });
    await started;
    const start = Date.now();
    await closeBrainContext(ctx);
    assert.ok(Date.now() - start < 2000);
    assert.equal(aborted, true);
    const result = await waiting;
    assert.equal(result.wait_status, "timeout");
    const cache = new ResearchCache(ctx.dbPath);
    try {
      assert.equal(cache.db.query("SELECT state FROM jobs WHERE id=?").get(result.job_id).state, "running");
      assert.equal(cache.db.query("SELECT COUNT(*) AS count FROM documents").get().count, 0);
      assert.equal(cache.db.query("SELECT COUNT(*) AS count FROM attempts").get().count, 1);
    } finally { cache.close(); }
  } finally { await closeBrainContext(ctx); rmSync(root, { recursive: true, force: true }); }
});
