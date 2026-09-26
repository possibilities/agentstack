import { afterEach, test } from "node:test";
import { expect } from "expect";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DurableSubmissionIntent,
  RECOVERY_JOB_PREFIX,
  RECOVERY_ONLINE_JOB_PREFIX,
} from "../src/admission.js";
import { AgentscrapeExtractionError } from "../src/agentscrape.js";
import { ArtifactStore } from "../src/artifacts.js";
import { RECOVERY_ONLINE_SCOPE_KIND, ResearchStore } from "../src/store.js";
import { type JobMaterializer, runWorker } from "../src/worker.js";

const roots: string[] = [];
const originalPath = process.env.PATH;
const T0 = new Date("2026-06-01T00:00:00.000Z");

function at(milliseconds: number): Date {
  return new Date(T0.getTime() + milliseconds);
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.COUNT_FILE;
  delete process.env.ARGV_FILE;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  store: ResearchStore;
  artifacts: ArtifactStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-worker-"));
  roots.push(root);
  return {
    root,
    store: new ResearchStore(join(root, "brain.db")),
    artifacts: new ArtifactStore(join(root, "artifacts")),
  };
}

function createRun(store: ResearchStore, runType = "operator_fixture"): number {
  return Number(
    store.db
      .query(
        `INSERT INTO runs(run_type, state, created_at, updated_at)
         VALUES (?, 'pending', ?, ?)`,
      )
      .run(runType, T0.toISOString(), T0.toISOString()).lastInsertRowid,
  );
}

function createRecoveryOnlineRun(store: ResearchStore): {
  runId: number;
  scope: {
    runId: number;
    authorizationDigest: string;
    allowedKinds: string[];
  };
  jobs: number[];
} {
  const offlineRunId = createRun(store, "completed_offline_fixture");
  store.db
    .query("UPDATE runs SET state='completed', finished_at=? WHERE id=?")
    .run(T0.toISOString(), offlineRunId);
  const runId = createRun(store, "controlled_online_backfill");
  const jobs: number[] = [];
  const originalJobs: number[] = [];
  const resources: number[] = [];
  for (let index = 0; index < 2; index += 1) {
    const resourceId = Number(
      store.db
        .query(
          `INSERT INTO resources(
             key_type, key_value, kind, sensitivity, created_at, updated_at
           ) VALUES ('recovery_candidate', ?, 'url', 'normal', ?, ?)`,
        )
        .run(`candidate-${index}`, T0.toISOString(), T0.toISOString())
        .lastInsertRowid,
    );
    resources.push(resourceId);
    store.db
      .query(
        `INSERT INTO resource_aliases(
           resource_id, alias_type, locator, evidence, first_observed_at,
           last_observed_at
         ) VALUES (?, 'legacy_exact_url', ?, 'fixture', ?, ?)`,
      )
      .run(
        resourceId,
        `https://example.test/approved/${index}`,
        T0.toISOString(),
        T0.toISOString(),
      );
    const original = store.enqueueJob({
      idempotencyKey: `${RECOVERY_JOB_PREFIX}${String(index).padStart(16, "0")}`,
      kind: "url",
      intent: intent("url"),
      resourceId,
      runId: offlineRunId,
      now: T0,
    });
    store.db
      .query(
        "UPDATE jobs SET state='blocked', block_reason='approved' WHERE id=?",
      )
      .run(original.job.id);
    originalJobs.push(original.job.id);
    const online = store.enqueueJob({
      idempotencyKey: `${RECOVERY_ONLINE_JOB_PREFIX}${"a".repeat(64)}:${String(index).padStart(16, "0")}`,
      kind: "url",
      intent: intent("url"),
      resourceId,
      runId,
      now: T0,
    });
    jobs.push(online.job.id);
  }
  store.db
    .query(
      `INSERT INTO recovery_online_runs(
         run_id, offline_run_id, generation_id, generation_digest,
         manifest_digest, approval_digest, snapshot_database_digest,
         snapshot_artifact_inventory_digest, snapshot_artifact_count,
         snapshot_job_inventory_digest, snapshot_job_count,
         snapshot_max_job_id, snapshot_created_at, status, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 2, ?, ?, 'ready', ?, ?)`,
    )
    .run(
      runId,
      offlineRunId,
      `sha256-${"a".repeat(64)}`,
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
      "f".repeat(64),
      Math.max(...originalJobs),
      T0.toISOString(),
      T0.toISOString(),
      T0.toISOString(),
    );
  for (let index = 0; index < 2; index += 1) {
    store.db
      .query(
        `INSERT INTO recovery_online_items(
           run_id, candidate_evidence_row_id, offline_job_id, job_id,
           resource_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        String(index).padStart(16, "0"),
        originalJobs[index] ?? 0,
        jobs[index] ?? 0,
        resources[index] ?? 0,
        T0.toISOString(),
      );
  }
  const scope = {
    runId,
    authorizationDigest: "c".repeat(64),
    allowedKinds: [RECOVERY_ONLINE_SCOPE_KIND],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "online",
    expectedJobCount: 2,
    now: T0,
  });
  return { runId, scope, jobs };
}

function intent(kind: "text" | "url" = "text"): DurableSubmissionIntent {
  return {
    version: 1,
    kind,
    ingress: "test",
    collections: [],
    payload:
      kind === "url"
        ? { url: { url: "https://example.test/private?token=hidden" } }
        : {
            text: {
              content_digest: "0".repeat(64),
              byte_size: 1,
              media_type: "text/plain",
              artifact_role: "original",
            },
          },
    options: { tags: [], force: false, max_bytes: 1000 },
  };
}

function extractionEnvelope(url: string, content: string): string {
  return JSON.stringify({
    schema_version: "1",
    status: "success",
    requested_url: url,
    final_url: "https://example.test/final",
    extractor: {
      name: "agentscrape",
      version: "1.2.3",
      implementation: "generic-page",
      implementation_version: "1",
    },
    artifacts: [
      {
        artifact_type: "document",
        media_type: "text/markdown",
        encoding: "utf-8",
        content,
        size_bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    metadata: {
      content_type: "web_page",
      title: "Queued URL",
      author_name: "",
      author_handle: "",
      published_at: "",
      source_id: "",
      warnings: [],
    },
    relations: [],
    failure: null,
  });
}

function installExtractionCommand(root: string, envelope: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "agentscrape");
  writeFileSync(
    executable,
    `#!/bin/sh
printf x >> "$COUNT_FILE"
printf '%s\\n' "$@" > "$ARGV_FILE"
printf '%s' '${envelope.replaceAll("'", `'\\''`)}'
`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.COUNT_FILE = join(root, "count");
  process.env.ARGV_FILE = join(root, "argv");
}

const materialize: JobMaterializer = (job) => [
  {
    sourceType: "text",
    sourceUri: `test-job:${job.id}`,
    title: `Job ${job.id}`,
    content: `materialized ${job.id}`,
  },
];

test("queued URL extraction promotes and commits through fenced completion", async () => {
  const { root, store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "queued-url",
    kind: "url",
    intent: intent("url"),
    now: T0,
  });
  const requested = "https://example.test/private?token=%5BREDACTED%5D";
  const content = "# Queued URL\n\nDurable body";
  installExtractionCommand(root, extractionEnvelope(requested, content));

  const result = await runWorker(store, {
    once: true,
    workerId: "url-worker",
    now: () => T0,
    artifactStore: artifacts,
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(
    store.db
      .query("SELECT state, resource_id FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toMatchObject({ state: "completed", resource_id: 1 });
  const artifact = store.db
    .query(
      "SELECT content_hash, artifact_role, storage_path FROM artifacts WHERE artifact_role='extracted_markdown'",
    )
    .get() as {
    content_hash: string;
    artifact_role: string;
    storage_path: string;
  };
  expect(artifacts.readUtf8(artifact.content_hash)).toBe(content);
  expect(artifacts.readUrlExtraction(queued.job.id)).toMatchObject({
    record_version: 1,
    extractor: { name: "agentscrape" },
  });
  expect(
    store.db
      .query("SELECT evidence_type, raw_metadata FROM provenance ORDER BY id")
      .all(),
  ).toEqual([
    {
      evidence_type: "ingestion_materialized",
      raw_metadata: JSON.stringify({ job_id: queued.job.id, item: 1 }),
    },
    {
      evidence_type: "url_extraction",
      raw_metadata: expect.stringContaining('"name":"agentscrape"'),
    },
  ]);
  expect(readFileSync(process.env.ARGV_FILE ?? "", "utf8")).toContain(
    "--envelope\n",
  );
  expect(readFileSync(process.env.ARGV_FILE ?? "", "utf8")).not.toContain(
    "--markdown",
  );
  store.close();
});

test("URL worker persists parser-derived X thread classification", async () => {
  const { root, store, artifacts } = fixture();
  const url = "https://x.com/i/status/123";
  const xIntent = intent("url");
  xIntent.payload = { url: { url } };
  const queued = store.enqueueJob({
    idempotencyKey: "classified-x-thread",
    kind: "url",
    intent: xIntent,
    now: T0,
  });
  const payload = JSON.parse(
    extractionEnvelope(url, "first post\n\n---\n\nsecond post"),
  ) as Record<string, unknown>;
  payload.final_url = "https://x.com/Example/status/123";
  payload.extractor = {
    ...(payload.extractor as Record<string, unknown>),
    implementation: "x-tweet",
  };
  payload.metadata = {
    ...(payload.metadata as Record<string, unknown>),
    content_type: "social_post",
    content_kind: "thread",
    content_item_count: 2,
    source_id: "123",
  };
  installExtractionCommand(root, JSON.stringify(payload));

  const result = await runWorker(store, {
    once: true,
    workerId: "classified-worker",
    now: () => T0,
    artifactStore: artifacts,
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(
    store.db
      .query(
        `SELECT d.content_kind, d.content_item_count
         FROM jobs j JOIN resources r ON r.id=j.resource_id
         JOIN documents d ON d.id=r.document_id WHERE j.id=?`,
      )
      .get(queued.job.id),
  ).toEqual({ content_kind: "thread", content_item_count: 2 });
  store.close();
});

test("retry after index failure reuses the promoted URL Artifact", async () => {
  const { root, store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "url-index-retry",
    kind: "url",
    intent: intent("url"),
    now: T0,
  });
  const content = "# Reusable\n\nExtract once";
  installExtractionCommand(
    root,
    extractionEnvelope(
      "https://example.test/private?token=%5BREDACTED%5D",
      content,
    ),
  );
  const upsert = store.upsertDocument.bind(store);
  let indexAvailable = false;
  store.upsertDocument = ((input) => {
    if (!indexAvailable) {
      throw new Error("simulated index temporarily unavailable");
    }
    return upsert(input);
  }) as ResearchStore["upsertDocument"];
  const policy = { infraBaseMs: 1000, infraCapMs: 1000, jitterRatio: 0 };

  await runWorker(store, {
    once: true,
    workerId: "first-index-attempt",
    now: () => T0,
    artifactStore: artifacts,
    policy,
    installSignalHandlers: false,
  });
  expect(readFileSync(process.env.COUNT_FILE ?? "", "utf8")).toBe("x");
  expect(
    store.db.query("SELECT state FROM jobs WHERE id=?").get(queued.job.id),
  ).toEqual({ state: "retry_wait" });

  const extractionPath = join(
    artifacts.urlExtractionRoot,
    `${queued.job.id}.json`,
  );
  const historicalRecord = JSON.parse(
    readFileSync(extractionPath, "utf8"),
  ) as Record<string, unknown>;
  historicalRecord.extractor = {
    name: "historical-extractor",
    version: "0.9.0",
    implementation: "archived-provider",
    implementation_version: "7",
  };
  const historicalRecordBytes = JSON.stringify(historicalRecord);
  writeFileSync(extractionPath, historicalRecordBytes);

  indexAvailable = true;
  const retried = await runWorker(store, {
    once: true,
    workerId: "second-index-attempt",
    now: () => at(1000),
    artifactStore: artifacts,
    policy,
    installSignalHandlers: false,
  });
  expect(retried).toMatchObject({ claimed: 1, completed: 1 });
  expect(readFileSync(process.env.COUNT_FILE ?? "", "utf8")).toBe("x");
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({ state: "completed", attempt_count: 2 });
  expect(store.db.query("SELECT content FROM documents").get()).toEqual({
    content,
  });
  expect(readFileSync(extractionPath, "utf8")).toBe(historicalRecordBytes);
  expect(artifacts.readUrlExtraction(queued.job.id)).toMatchObject({
    record_version: 1,
    extractor: {
      name: "historical-extractor",
      implementation: "archived-provider",
    },
  });
  expect(
    store.db
      .query(
        "SELECT raw_metadata FROM provenance WHERE evidence_type='url_extraction'",
      )
      .get(),
  ).toEqual({ raw_metadata: expect.stringContaining("historical-extractor") });
  store.close();
});

test("recovery completion links a cross-candidate collision job to the document owner", async () => {
  const { store, artifacts } = fixture();
  const exactUrl = "https://legacy-collision.test/item/1";
  const document = store.upsertDocument({
    sourceType: "url",
    sourceUri: exactUrl,
    content: "content from a newer generation",
  });
  const existingResourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, document_id, created_at, updated_at
         ) VALUES ('url', 'foreign-owner', 'url', ?, ?, ?)`,
      )
      .run(document.document_id, T0.toISOString(), T0.toISOString())
      .lastInsertRowid,
  );
  const recoveryResourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, sensitivity, created_at, updated_at
         ) VALUES (
           'recovery_candidate', 'aaaaaaaaaaaaaaaa', 'url', 'private', ?, ?
         )`,
      )
      .run(T0.toISOString(), T0.toISOString()).lastInsertRowid,
  );
  store.db
    .query(
      `INSERT INTO resource_aliases(
         resource_id, alias_type, locator, evidence, first_observed_at,
         last_observed_at
       ) VALUES (?, 'legacy_exact_url', ?, 'legacy test', ?, ?)`,
    )
    .run(recoveryResourceId, exactUrl, T0.toISOString(), T0.toISOString());
  const recoveryIntent: DurableSubmissionIntent = {
    version: 1,
    kind: "file",
    ingress: "legacy-recovery",
    collections: [],
    payload: {
      file: {
        content_digest: "0".repeat(64),
        byte_size: 1,
        media_type: "text/markdown",
        artifact_role: "imported_markdown",
      },
    },
    options: { tags: [], force: false, max_bytes: 1000 },
  };
  const queued = store.enqueueJob({
    idempotencyKey: `${RECOVERY_JOB_PREFIX}aaaaaaaaaaaaaaaa`,
    kind: "file",
    intent: recoveryIntent,
    resourceId: recoveryResourceId,
    now: T0,
  });

  const result = await runWorker(store, {
    once: true,
    workerId: "recovery-collision",
    now: () => T0,
    artifactStore: artifacts,
    materialize: () => [
      {
        sourceType: "file",
        sourceUri: "ignored-for-recovery",
        title: "Recovered collision",
        content: "offline body from the older generation",
      },
    ],
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(
    store.db
      .query("SELECT state, resource_id, failure_class FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({
    state: "completed",
    resource_id: existingResourceId,
    failure_class: null,
  });
  expect(
    store.db
      .query(
        `SELECT d.id AS document_id
         FROM jobs j
         JOIN resources r ON r.id=j.resource_id
         JOIN documents d ON d.id=r.document_id
         WHERE j.id=?`,
      )
      .get(queued.job.id),
  ).toEqual({ document_id: document.document_id });
  expect(
    store.db
      .query("SELECT document_id, sensitivity FROM resources WHERE id=?")
      .get(recoveryResourceId),
  ).toEqual({ document_id: null, sensitivity: "private" });
  expect(
    store.db
      .query("SELECT document_id, sensitivity FROM resources WHERE id=?")
      .get(existingResourceId),
  ).toEqual({ document_id: document.document_id, sensitivity: "private" });
  expect(
    store.db
      .query(
        `SELECT COUNT(*) AS count FROM provenance
         WHERE resource_id=? AND evidence_type='ingestion_materialized'`,
      )
      .get(existingResourceId),
  ).toEqual({ count: 1 });
  const replay = await runWorker(store, {
    once: true,
    now: () => T0,
    artifactStore: artifacts,
    materialize,
    installSignalHandlers: false,
  });
  expect(replay.claimed).toBe(0);
  expect(
    store.db
      .query(
        `SELECT COUNT(*) AS count FROM provenance
         WHERE resource_id=? AND evidence_type='ingestion_materialized'`,
      )
      .get(existingResourceId),
  ).toEqual({ count: 1 });
  store.close();
});

test("permanent completion failures terminate instead of retrying as infrastructure", async () => {
  const { store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "permanent-completion-failure",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  store.upsertDocument = (() => {
    throw new Error("UNIQUE constraint failed: resources.document_id");
  }) as ResearchStore["upsertDocument"];

  const result = await runWorker(store, {
    once: true,
    workerId: "permanent-completion",
    now: () => T0,
    artifactStore: artifacts,
    materialize,
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
  expect(
    store.db
      .query("SELECT state, failure_class, attempt_count FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({ state: "failed", failure_class: "permanent", attempt_count: 1 });
  expect(
    store.db
      .query("SELECT state, failure_class FROM attempts WHERE job_id=?")
      .get(queued.job.id),
  ).toEqual({ state: "failed", failure_class: "permanent" });
  store.close();
});

test("extraction dispositions reach accepted durable job states", async () => {
  const cases = [
    ["infra", "infrastructure", "retry_wait"],
    ["item_transient", "item", "retry_wait"],
    ["auth_config", "auth_config", "blocked"],
    ["permanent", "policy", "failed"],
    ["permanent", "protocol", "failed"],
    ["cancelled", "cancellation", "cancelled"],
  ] as const;
  for (const [disposition, outcome, expectedState] of cases) {
    const { store, artifacts } = fixture();
    const queued = store.enqueueJob({
      idempotencyKey: `disposition-${outcome}`,
      kind: "url",
      intent: intent("url"),
      now: T0,
    });
    await runWorker(store, {
      once: true,
      workerId: `worker-${outcome}`,
      now: () => T0,
      artifactStore: artifacts,
      extract: async () => {
        throw new AgentscrapeExtractionError(
          `safe ${outcome} failure`,
          disposition,
          outcome,
        );
      },
      policy: {
        infraBaseMs: 1000,
        infraCapMs: 1000,
        itemBaseMs: 1000,
        itemCapMs: 1000,
        jitterRatio: 0,
      },
      installSignalHandlers: false,
    });
    expect(
      store.db.query("SELECT state FROM jobs WHERE id=?").get(queued.job.id),
    ).toEqual({ state: expectedState });
    store.close();
  }
});

test("worker once drains only eligible jobs", async () => {
  const { store, artifacts } = fixture();
  const blocked = store.enqueueJob({
    idempotencyKey: "blocked",
    kind: "url",
    intent: intent("url"),
    now: T0,
  });
  const blockedClaim = store.claimJob({
    worker: "setup",
    now: T0,
    leaseMs: 1000,
  });
  if (!blockedClaim.claimed) throw new Error("expected setup claim");
  store.failAttempt({
    fencingToken: blockedClaim.fencing_token,
    failureClass: "auth_config",
    summary: "configuration missing",
    now: T0,
  });
  const eligible = store.enqueueJob({
    idempotencyKey: "eligible",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const future = store.enqueueJob({
    idempotencyKey: "future",
    kind: "text",
    intent: intent(),
    now: at(60_000),
  });

  const result = await runWorker(store, {
    once: true,
    workerId: "once-test",
    now: () => T0,
    artifactStore: artifacts,
    materialize,
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({
    claimed: 1,
    completed: 1,
    failed: 0,
    fenced: 0,
  });
  expect(
    store.db.query("SELECT id, state FROM jobs ORDER BY id").all(),
  ).toEqual([
    { id: blocked.job.id, state: "blocked" },
    { id: eligible.job.id, state: "completed" },
    { id: future.job.id, state: "queued" },
  ]);
  expect(store.db.query("SELECT content FROM documents").all()).toEqual([
    { content: `materialized ${eligible.job.id}` },
  ]);
  store.close();
});

test("generic claims exclude operator-controlled Runs while scoped once drains only its allowed jobs", async () => {
  const { store, artifacts } = fixture();
  const runId = createRun(store);
  const first = store.enqueueJob({
    idempotencyKey: "controlled-first",
    kind: "text",
    intent: intent(),
    runId,
    now: T0,
  });
  const second = store.enqueueJob({
    idempotencyKey: "controlled-second",
    kind: "text",
    intent: intent(),
    runId,
    now: T0,
  });
  const parked = store.enqueueJob({
    idempotencyKey: "controlled-parked-url",
    kind: "url",
    intent: intent("url"),
    runId,
    now: T0,
  });
  store.db
    .query("UPDATE jobs SET state='blocked', block_reason='offline' WHERE id=?")
    .run(parked.job.id);
  const unrelated = store.enqueueJob({
    idempotencyKey: "ordinary-pressure",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const scope = {
    runId,
    authorizationDigest: "a".repeat(64),
    allowedKinds: ["text"],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "offline",
    expectedJobCount: 2,
    now: T0,
  });

  const generic = store.claimJob({
    worker: "generic-pressure",
    now: T0,
    leaseMs: 60_000,
  });
  if (!generic.claimed) throw new Error("expected ordinary claim");
  expect(generic.job.id).toBe(unrelated.job.id);

  const result = await runWorker(store, {
    once: true,
    workerId: "scoped-offline",
    scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize,
    extract: async () => {
      throw new Error("offline scope invoked URL extraction");
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({
    scope: {
      run_id: runId,
      execution_mode: "offline",
      authorization_digest: "a".repeat(64),
      allowed_job_kinds: ["text"],
      expected_job_count: 2,
    },
    scheduled: 0,
    claimed: 2,
    completed: 2,
  });
  expect(
    store.db.query("SELECT id, state FROM jobs ORDER BY id").all(),
  ).toEqual([
    { id: first.job.id, state: "completed" },
    { id: second.job.id, state: "completed" },
    { id: parked.job.id, state: "blocked" },
    { id: unrelated.job.id, state: "running" },
  ]);
  expect(
    store.db.query("SELECT job_id, worker FROM attempts ORDER BY id").all(),
  ).toEqual([
    { job_id: unrelated.job.id, worker: "generic-pressure" },
    { job_id: first.job.id, worker: "scoped-offline" },
    { job_id: second.job.id, worker: "scoped-offline" },
  ]);
  store.close();
});

test("scoped worker rejects authorization, kind, cardinality, and offline URL mismatches before claim", async () => {
  const { store, artifacts } = fixture();
  const runId = createRun(store, "validated_scope");
  store.enqueueJob({
    idempotencyKey: "validated-target",
    kind: "text",
    intent: intent(),
    runId,
    now: T0,
  });
  const scope = {
    runId,
    authorizationDigest: "b".repeat(64),
    allowedKinds: ["text"],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "offline",
    expectedJobCount: 1,
    now: T0,
  });
  expect(() =>
    store.db
      .query(
        "UPDATE operator_run_policies SET authorization_digest=? WHERE run_id=?",
      )
      .run("9".repeat(64), runId),
  ).toThrow("policy is immutable");
  expect(() =>
    store.enqueueJob({
      idempotencyKey: "late-controlled-job",
      kind: "text",
      intent: intent(),
      runId,
      now: T0,
    }),
  ).toThrow("Run jobs are immutable");

  await expect(
    runWorker(store, {
      once: true,
      scope: { ...scope, authorizationDigest: "c".repeat(64) },
      now: () => T0,
      artifactStore: artifacts,
      materialize,
      installSignalHandlers: false,
    }),
  ).rejects.toThrow("does not match");
  await expect(
    runWorker(store, {
      once: true,
      scope: { ...scope, allowedKinds: ["file"] },
      now: () => T0,
      artifactStore: artifacts,
      materialize,
      installSignalHandlers: false,
    }),
  ).rejects.toThrow("does not match");

  const malformedRunId = createRun(store, "cardinality_mismatch");
  store.enqueueJob({
    idempotencyKey: "cardinality-target",
    kind: "text",
    intent: intent(),
    runId: malformedRunId,
    now: T0,
  });
  store.db
    .query(
      `INSERT INTO operator_run_policies(
         run_id, mode, authorization_digest, allowed_job_kinds,
         expected_job_count, created_at
       ) VALUES (?, 'offline', ?, '["text"]', 2, ?)`,
    )
    .run(malformedRunId, "d".repeat(64), T0.toISOString());
  await expect(
    runWorker(store, {
      once: true,
      scope: {
        runId: malformedRunId,
        authorizationDigest: "d".repeat(64),
        allowedKinds: ["text"],
      },
      now: () => T0,
      artifactStore: artifacts,
      materialize,
      installSignalHandlers: false,
    }),
  ).rejects.toThrow("expected 2 authorized jobs but found 1");

  const offlineUrlRunId = createRun(store, "offline_url_rejected");
  store.enqueueJob({
    idempotencyKey: "offline-url",
    kind: "url",
    intent: intent("url"),
    runId: offlineUrlRunId,
    now: T0,
  });
  expect(() =>
    store.authorizeRunScope({
      runId: offlineUrlRunId,
      mode: "offline",
      authorizationDigest: "e".repeat(64),
      allowedKinds: ["url"],
      expectedJobCount: 1,
      now: T0,
    }),
  ).toThrow("cannot allow URL extraction jobs");
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM attempts").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("online scope executes exactly two bound URL jobs without admitting broad work", async () => {
  const { store, artifacts } = fixture();
  const runId = createRun(store, "controlled_online");
  const first = store.enqueueJob({
    idempotencyKey: "online-first",
    kind: "url",
    intent: intent("url"),
    runId,
    now: T0,
  });
  const second = store.enqueueJob({
    idempotencyKey: "online-second",
    kind: "url",
    intent: intent("url"),
    runId,
    now: T0,
  });
  const unrelated = store.enqueueJob({
    idempotencyKey: "online-unrelated",
    kind: "url",
    intent: intent("url"),
    now: T0,
  });
  const scope = {
    runId,
    authorizationDigest: "f".repeat(64),
    allowedKinds: ["url"],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "online",
    expectedJobCount: 2,
    now: T0,
  });
  let extractionCalls = 0;

  const result = await runWorker(store, {
    once: true,
    workerId: "scoped-online",
    scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: (job) => [
      {
        sourceType: "url",
        sourceUri: `controlled-url:${job.id}`,
        title: `Controlled URL ${job.id}`,
        content: `controlled URL body ${job.id}`,
        fanout: {
          discoveries: [
            {
              ordinal: 0,
              relationType: "content_link",
              targetUrl: `https://child.example/${job.id}`,
              canonicalUrl: `https://child.example/${job.id}`,
              resourceKey: {
                type: "url",
                value: `https://child.example/${job.id}`,
              },
              childIdempotencyKey: `controlled-child:${job.id}`,
              childIntent: JSON.stringify(intent("url")),
              suppressionReason: null,
            },
          ],
        },
      },
    ],
    extract: async () => {
      extractionCalls += 1;
      throw new Error("custom materializer should own this fixture");
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 2, completed: 2, scheduled: 0 });
  expect(extractionCalls).toBe(0);
  expect(
    store.db.query("SELECT id, state FROM jobs ORDER BY id").all(),
  ).toEqual([
    { id: first.job.id, state: "completed" },
    { id: second.job.id, state: "completed" },
    { id: unrelated.job.id, state: "queued" },
  ]);
  expect(
    store.db.query("SELECT state FROM runs WHERE id=?").get(runId),
  ).toEqual({ state: "completed" });
  expect(
    store.db
      .query(
        `SELECT suppressed, suppressed_reason FROM observations
         WHERE run_id=? ORDER BY source_job_id`,
      )
      .all(runId),
  ).toEqual([
    { suppressed: 1, suppressed_reason: "operator_controlled_run" },
    { suppressed: 1, suppressed_reason: "operator_controlled_run" },
  ]);
  store.close();
});

test("shared scoped failures pause sibling claims", async () => {
  const { store, artifacts } = fixture();
  const runId = createRun(store, "paused_online");
  const jobs = ["paused-first", "paused-second"].map((idempotencyKey) =>
    store.enqueueJob({
      idempotencyKey,
      kind: "url",
      intent: intent("url"),
      runId,
      now: T0,
    }),
  );
  const scope = {
    runId,
    authorizationDigest: "9".repeat(64),
    allowedKinds: ["url"],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "online",
    expectedJobCount: 2,
    now: T0,
  });

  const result = await runWorker(store, {
    once: true,
    scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: () => {
      throw new Error("credential unavailable");
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, failed: 1, completed: 0 });
  expect(
    store.db.query("SELECT id, state FROM jobs ORDER BY id").all(),
  ).toEqual([
    { id: jobs[0]?.job.id, state: "blocked" },
    { id: jobs[1]?.job.id, state: "queued" },
  ]);
  expect(
    store.db.query("SELECT state FROM runs WHERE id=?").get(runId),
  ).toEqual({ state: "pending" });
  store.close();
});

test("recovery online item failure preserves its sibling and completes with review", async () => {
  const { store, artifacts } = fixture();
  const recovery = createRecoveryOnlineRun(store);
  let calls = 0;
  const result = await runWorker(store, {
    once: true,
    workerId: "recovery-online-item-isolation",
    scope: recovery.scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: (job) => {
      calls += 1;
      if (job.id === recovery.jobs[0]) {
        throw new Error("deterministic item content failure");
      }
      return [
        {
          sourceType: "url",
          sourceUri: `fixture:${job.id}`,
          title: "Sibling completed",
          content: "sibling searchable content",
        },
      ];
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
  expect(calls).toBe(2);
  expect(
    store.db
      .query("SELECT state FROM jobs WHERE run_id=? ORDER BY id")
      .all(recovery.runId),
  ).toEqual([{ state: "failed" }, { state: "completed" }]);
  expect(
    store.db.query("SELECT state FROM runs WHERE id=?").get(recovery.runId),
  ).toEqual({ state: "completed" });
  expect(
    store.db
      .query("SELECT status FROM recovery_online_runs WHERE run_id=?")
      .get(recovery.runId),
  ).toEqual({ status: "completed_with_review" });
  expect(
    store.db
      .query(
        `SELECT outcome, attempt_count FROM recovery_online_items
         WHERE run_id=? ORDER BY candidate_evidence_row_id`,
      )
      .all(recovery.runId),
  ).toEqual([
    { outcome: "failed", attempt_count: 1 },
    { outcome: "succeeded_or_duplicate", attempt_count: 1 },
  ]);
  store.close();
});

test("recovery online shared failure pauses before the sibling claim", async () => {
  const { store, artifacts } = fixture();
  const recovery = createRecoveryOnlineRun(store);
  const result = await runWorker(store, {
    once: true,
    workerId: "recovery-online-shared-pause",
    scope: recovery.scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: () => {
      throw new AgentscrapeExtractionError(
        "shared provider configuration unavailable",
        "auth_config",
        "auth_config",
      );
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
  expect(
    store.db
      .query("SELECT state FROM jobs WHERE run_id=? ORDER BY id")
      .all(recovery.runId),
  ).toEqual([{ state: "blocked" }, { state: "queued" }]);
  expect(
    store.db
      .query("SELECT status FROM recovery_online_runs WHERE run_id=?")
      .get(recovery.runId),
  ).toEqual({ status: "paused" });

  const blindReplay = await runWorker(store, {
    once: true,
    workerId: "recovery-online-shared-still-paused",
    scope: recovery.scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: () => [
      {
        sourceType: "url",
        sourceUri: "fixture:must-not-run",
        title: "must not run",
        content: "must not run",
      },
    ],
    installSignalHandlers: false,
  });
  expect(blindReplay).toMatchObject({ claimed: 0, completed: 0, failed: 0 });

  store.retryJob({ jobId: recovery.jobs[0] ?? 0, now: T0 });
  const resumed = await runWorker(store, {
    once: true,
    workerId: "recovery-online-shared-resumed",
    scope: recovery.scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: (job) => [
      {
        sourceType: "url",
        sourceUri: `fixture:${job.id}`,
        title: "resumed",
        content: `resumed searchable content ${job.id}`,
      },
    ],
    installSignalHandlers: false,
  });
  expect(resumed).toMatchObject({ claimed: 2, completed: 2, failed: 0 });
  expect(
    store.db
      .query("SELECT status FROM recovery_online_runs WHERE run_id=?")
      .get(recovery.runId),
  ).toEqual({ status: "completed" });
  store.close();
});

test("recovery online keeps a final shared failure paused for operator retry", async () => {
  const { store, artifacts } = fixture();
  const recovery = createRecoveryOnlineRun(store);
  const result = await runWorker(store, {
    once: true,
    workerId: "recovery-online-final-shared-pause",
    scope: recovery.scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: (job) => {
      if (job.id === recovery.jobs[1]) {
        throw new AgentscrapeExtractionError(
          "shared provider authentication unavailable",
          "auth_config",
          "auth_config",
        );
      }
      return [
        {
          sourceType: "url",
          sourceUri: `fixture:${job.id}`,
          title: "first sibling completed",
          content: "first sibling searchable content",
        },
      ];
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
  expect(
    store.db
      .query("SELECT state FROM jobs WHERE run_id=? ORDER BY id")
      .all(recovery.runId),
  ).toEqual([{ state: "completed" }, { state: "blocked" }]);
  expect(
    store.db
      .query(
        "SELECT status, finished_at FROM recovery_online_runs WHERE run_id=?",
      )
      .get(recovery.runId),
  ).toEqual({ status: "paused", finished_at: null });
  expect(
    store.db.query("SELECT state FROM runs WHERE id=?").get(recovery.runId),
  ).toEqual({ state: "pending" });
  store.close();
});

test("active recovery online scope fences ordinary claims and requires quiescence", () => {
  const { store } = fixture();
  const recovery = createRecoveryOnlineRun(store);
  const unrelated = store.enqueueJob({
    idempotencyKey: "ordinary-due-during-online",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const execution = store.beginRunScope(recovery.scope, {
    worker: "recovery-online-exclusive",
    now: T0,
    leaseMs: 60_000,
  });
  expect(store.claimJob({ worker: "ordinary-worker", now: T0 })).toEqual({
    claimed: false,
  });
  expect(
    store.finishRunScope(recovery.scope, {
      executionToken: execution.executionToken,
      now: T0,
    }),
  ).toBe(false);

  const ordinary = store.claimJob({ worker: "ordinary-worker", now: T0 });
  if (!ordinary.claimed) throw new Error("expected ordinary claim after scope");
  expect(ordinary.job.id).toBe(unrelated.job.id);
  expect(() =>
    store.beginRunScope(recovery.scope, {
      worker: "recovery-online-must-wait",
      now: T0,
      leaseMs: 60_000,
    }),
  ).toThrow("active lease");
  store.close();
});

test("active recovery online execution lease globally fences expired ordinary lease recovery", () => {
  const { store } = fixture();
  const ordinary = store.enqueueJob({
    idempotencyKey: "ordinary-expired-during-recovery-online",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const claimed = store.claimJob({
    worker: "expired-ordinary-worker",
    now: T0,
    leaseMs: 1000,
  });
  if (!claimed.claimed) throw new Error("expected ordinary claim");

  const recovery = createRecoveryOnlineRun(store);
  const execution = store.beginRunScope(recovery.scope, {
    worker: "recovery-online-exclusive-recovery-fence",
    now: at(2000),
    leaseMs: 60_000,
  });
  expect(
    store.recoverExpiredLeases({
      now: at(2000),
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
    }),
  ).toEqual([]);
  expect(
    store.db
      .query("SELECT state, current_attempt_id FROM jobs WHERE id=?")
      .get(ordinary.job.id),
  ).toEqual({ state: "running", current_attempt_id: claimed.fencing_token });
  expect(
    store.db
      .query("SELECT state FROM attempts WHERE id=?")
      .get(claimed.fencing_token),
  ).toEqual({ state: "leased" });

  expect(
    store.finishRunScope(recovery.scope, {
      executionToken: execution.executionToken,
      now: at(2000),
    }),
  ).toBe(false);
  expect(
    store.recoverExpiredLeases({
      now: at(2000),
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
    }),
  ).toEqual([
    {
      job_id: ordinary.job.id,
      attempt_id: claimed.fencing_token,
      disposition: "retry_wait",
    },
  ]);
  store.close();
});

test("operator-controlled Run execution leases serialize scoped workers and fence expired owners", () => {
  const { store } = fixture();
  const runId = createRun(store, "serialized_online");
  for (const idempotencyKey of ["serialized-first", "serialized-second"]) {
    store.enqueueJob({
      idempotencyKey,
      kind: "url",
      intent: intent("url"),
      runId,
      now: T0,
    });
  }
  const scope = {
    runId,
    authorizationDigest: "0".repeat(64),
    allowedKinds: ["url"],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "online",
    expectedJobCount: 2,
    now: T0,
  });
  const first = store.beginRunScope(scope, {
    worker: "first-scoped-worker",
    now: T0,
    leaseMs: 1000,
  });
  const contender = new ResearchStore(store.dbPath);
  expect(() =>
    contender.beginRunScope(scope, {
      worker: "concurrent-scoped-worker",
      now: T0,
      leaseMs: 1000,
    }),
  ).toThrow("has an active lease");
  const replacement = contender.beginRunScope(scope, {
    worker: "replacement-scoped-worker",
    now: at(2000),
    leaseMs: 1000,
  });
  expect(replacement.executionToken).not.toBe(first.executionToken);
  expect(() =>
    store.finishRunScope(scope, {
      executionToken: first.executionToken,
      now: at(2000),
    }),
  ).toThrow("execution lease is stale or fenced");
  expect(
    contender.finishRunScope(scope, {
      executionToken: replacement.executionToken,
      now: at(2000),
    }),
  ).toBe(false);
  expect(
    store.db.query("SELECT state FROM runs WHERE id=?").get(runId),
  ).toEqual({ state: "pending" });
  contender.close();
  store.close();
});

test("terminal job failure does not mark an operator-controlled Run completed", async () => {
  const { store, artifacts } = fixture();
  const runId = createRun(store, "failed_offline_scope");
  store.enqueueJob({
    idempotencyKey: "failed-controlled-job",
    kind: "text",
    intent: intent(),
    runId,
    now: T0,
  });
  const scope = {
    runId,
    authorizationDigest: "7".repeat(64),
    allowedKinds: ["text"],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "offline",
    expectedJobCount: 1,
    now: T0,
  });

  const result = await runWorker(store, {
    once: true,
    scope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: () => {
      throw new Error("deterministic malformed content");
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, failed: 1, completed: 0 });
  expect(store.db.query("SELECT state FROM jobs").get()).toEqual({
    state: "failed",
  });
  expect(
    store.db.query("SELECT state FROM runs WHERE id=?").get(runId),
  ).toEqual({ state: "pending" });
  store.close();
});

test("scoped execution renews its Run lease between short jobs", async () => {
  const { store, artifacts } = fixture();
  const runId = createRun(store, "renewed_offline_scope");
  for (const idempotencyKey of ["renewed-a", "renewed-b", "renewed-c"]) {
    store.enqueueJob({
      idempotencyKey,
      kind: "text",
      intent: intent(),
      runId,
      now: T0,
    });
  }
  const scope = {
    runId,
    authorizationDigest: "6".repeat(64),
    allowedKinds: ["text"],
  };
  store.authorizeRunScope({
    ...scope,
    mode: "offline",
    expectedJobCount: 3,
    now: T0,
  });
  let elapsed = 0;
  const result = await runWorker(store, {
    once: true,
    workerId: "renewing-scoped-worker",
    scope,
    now: () => at(elapsed),
    leaseMs: 1000,
    heartbeatMs: 500,
    artifactStore: artifacts,
    materialize: (job) => {
      elapsed += 600;
      return materialize(job, intent(), {
        artifactStore: artifacts,
        signal: new AbortController().signal,
        extract: async () => {
          throw new Error("not used");
        },
      });
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 3, completed: 3, fenced: 0 });
  expect(
    store.db.query("SELECT state, attempt_count FROM jobs ORDER BY id").all(),
  ).toEqual([
    { state: "completed", attempt_count: 1 },
    { state: "completed", attempt_count: 1 },
    { state: "completed", attempt_count: 1 },
  ]);
  store.close();
});

test("scoped retry_wait and stale Attempt recovery resume without generic interference", async () => {
  const { store, artifacts } = fixture();
  const retryRunId = createRun(store, "retry_scope");
  const retryJob = store.enqueueJob({
    idempotencyKey: "scoped-retry",
    kind: "text",
    intent: intent(),
    runId: retryRunId,
    now: T0,
  });
  const retryScope = {
    runId: retryRunId,
    authorizationDigest: "1".repeat(64),
    allowedKinds: ["text"],
  };
  store.authorizeRunScope({
    ...retryScope,
    mode: "offline",
    expectedJobCount: 1,
    now: T0,
  });
  const policy = {
    infraBaseMs: 1000,
    infraCapMs: 1000,
    jitterRatio: 0,
  };

  await runWorker(store, {
    once: true,
    scope: retryScope,
    now: () => T0,
    artifactStore: artifacts,
    materialize: () => {
      throw new Error("temporarily unavailable");
    },
    policy,
    installSignalHandlers: false,
  });
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(retryJob.job.id),
  ).toEqual({ state: "retry_wait", attempt_count: 1 });
  expect(
    await runWorker(store, {
      once: true,
      scope: retryScope,
      now: () => T0,
      artifactStore: artifacts,
      materialize,
      policy,
      installSignalHandlers: false,
    }),
  ).toMatchObject({ claimed: 0, recovered: 0 });
  expect(
    await runWorker(store, {
      once: true,
      scope: retryScope,
      now: () => at(1000),
      artifactStore: artifacts,
      materialize,
      policy,
      installSignalHandlers: false,
    }),
  ).toMatchObject({ claimed: 1, completed: 1 });

  const crashRunId = createRun(store, "crash_scope");
  const crashJob = store.enqueueJob({
    idempotencyKey: "scoped-crash",
    kind: "text",
    intent: intent(),
    runId: crashRunId,
    now: T0,
  });
  const crashScope = {
    runId: crashRunId,
    authorizationDigest: "2".repeat(64),
    allowedKinds: ["text"],
  };
  store.authorizeRunScope({
    ...crashScope,
    mode: "offline",
    expectedJobCount: 1,
    now: T0,
  });
  const crashExecution = store.beginRunScope(crashScope, {
    worker: "crashed-scoped-worker",
    now: T0,
    leaseMs: 1000,
  });
  const crashed = store.claimJob({
    worker: "crashed-scoped-worker",
    scope: crashScope,
    executionToken: crashExecution.executionToken,
    now: T0,
    leaseMs: 1000,
  });
  if (!crashed.claimed) throw new Error("expected scoped crash claim");
  expect(
    store.recoverExpiredLeases({
      now: at(2000),
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
    }),
  ).toEqual([]);
  expect(
    await runWorker(store, {
      once: true,
      workerId: "resumed-scoped-worker",
      scope: crashScope,
      now: () => at(2000),
      artifactStore: artifacts,
      materialize,
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
      installSignalHandlers: false,
    }),
  ).toMatchObject({ recovered: 1, claimed: 1, completed: 1 });
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(crashJob.job.id),
  ).toEqual({ state: "completed", attempt_count: 2 });
  store.close();
});

test("shutdown wakes an idle long-loop without waiting for its poll interval", async () => {
  const { store, artifacts } = fixture();
  const stop = new AbortController();
  const started = performance.now();
  const running = runWorker(store, {
    pollMs: 10_000,
    signal: stop.signal,
    artifactStore: artifacts,
    installSignalHandlers: false,
  });
  setTimeout(() => stop.abort(), 10);
  const result = await running;
  expect(result.stopped).toBe(true);
  expect(performance.now() - started).toBeLessThan(500);
  store.close();
});

test("bounded shutdown leaves an unfinished attempt recoverable", async () => {
  const { store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "shutdown",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const stop = new AbortController();
  let started: (() => void) | undefined;
  const materializerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waitingMaterializer: JobMaterializer = async (
    _job,
    _intent,
    context,
  ) => {
    started?.();
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        {
          once: true,
        },
      );
    });
    return [];
  };
  const running = runWorker(store, {
    workerId: "shutdown-test",
    now: () => T0,
    leaseMs: 1000,
    heartbeatMs: 100,
    shutdownGraceMs: 0,
    signal: stop.signal,
    artifactStore: artifacts,
    materialize: waitingMaterializer,
    installSignalHandlers: false,
  });
  await materializerStarted;
  stop.abort();
  const result = await running;
  expect(result).toMatchObject({
    stopped: true,
    claimed: 1,
    completed: 0,
    fenced: 1,
  });
  expect(
    store.db.query("SELECT state FROM jobs WHERE id=?").get(queued.job.id),
  ).toEqual({
    state: "running",
  });
  expect(
    store.recoverExpiredLeases({
      now: at(2000),
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
    }),
  ).toEqual([
    { job_id: queued.job.id, attempt_id: 1, disposition: "retry_wait" },
  ]);
  store.close();
});

test("lease recovery fences a stale completion", async () => {
  const { store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "stale",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const reclaimingMaterializer: JobMaterializer = () => {
    store.recoverExpiredLeases({
      now: at(2000),
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
    });
    const reclaimed = store.claimJob({
      worker: "replacement",
      now: at(2000),
      leaseMs: 1000,
    });
    if (!reclaimed.claimed) throw new Error("expected replacement claim");
    store.completeJob({ fencingToken: reclaimed.fencing_token, now: at(2000) });
    return [
      {
        sourceType: "text",
        sourceUri: "must-not-commit",
        title: "Stale",
        content: "stale body",
      },
    ];
  };
  const result = await runWorker(store, {
    once: true,
    workerId: "stale-worker",
    now: () => T0,
    leaseMs: 1000,
    artifactStore: artifacts,
    materialize: reclaimingMaterializer,
    installSignalHandlers: false,
  });
  expect(result).toMatchObject({ claimed: 1, completed: 0, fenced: 1 });
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({
    state: "completed",
    attempt_count: 2,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});
