import type { Database } from "./sqlite.js";
import { createHash } from "node:crypto";
import { lstatSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RECOVERY_JOB_PREFIX,
  RECOVERY_ONLINE_JOB_PREFIX,
  recoveryUrlIntent,
} from "./admission.js";
import type { ArtifactStore } from "./artifacts.js";
import {
  BACKUP_DATABASE_FILE,
  readBackupManifest,
  verifyBackup,
} from "./backup.js";
import { CliError } from "./errors.js";
import type {
  VerifiedRecoveryCandidate,
  VerifiedRecoveryGeneration,
} from "./recovery.js";
import { openReadonlyDatabase } from "./sqlite.js";
import {
  RECOVERY_OFFLINE_SCOPE_KIND,
  RECOVERY_ONLINE_SCOPE_KIND,
  type ResearchStore,
} from "./store.js";
import type { FailureClass, JobState, OperatorRunScope } from "./types.js";
import { runWorker, type WorkerOptions, type WorkerResult } from "./worker.js";

const APPROVED_ONLINE_DISPOSITION = "approved_online_backfill_telegram_human";
const ONLINE_ITEM_COUNT = 2;
const MIN_FREE_BYTES = 256 * 1024 * 1024;
const ACTIVATION_BLOCK_REASON =
  "controlled online backfill awaiting activation";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type RecoveryOnlineStatus =
  | "ready"
  | "active"
  | "paused"
  | "completed"
  | "completed_with_review";

export interface PrepareRecoveryOnlineOptions {
  offlineRunId: number;
  postOfflineSnapshot: string;
  expectedGenerationDigest: string;
  expectedApprovalDigest: string;
  expectedSnapshotDigest: string;
  artifactStore: ArtifactStore;
  now?: Date;
}

export interface RecoveryOnlineItemReport {
  candidate_evidence_row_id: string;
  job_id: number;
  state: JobState;
  outcome: string;
  attempt_ids: number[];
  failure_class: FailureClass | null;
  artifact_digest: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface RecoveryOnlineReport {
  schema_version: 1;
  status: RecoveryOnlineStatus;
  generation_id: string;
  generation_digest: string;
  manifest_digest: string;
  approval_digest: string;
  candidate_evidence_row_ids: string[];
  snapshot: {
    restore_verified: true;
    database_digest: string;
    artifact_inventory_digest: string;
    artifacts_checked: number;
    corpus_jobs: number;
    corpus_documents: number;
  };
  offline_run: {
    id: number;
    state: "completed";
    completed_artifact_jobs: number;
    succeeded_attempts: number;
  };
  online_run: {
    id: number;
    linked_offline_run_id: number;
    state: RecoveryOnlineStatus;
    authorization_digest: string;
    allowed_job_kinds: [typeof RECOVERY_ONLINE_SCOPE_KIND];
    expected_job_count: 2;
    protected_jobs_unchanged: number;
    counts: {
      jobs: number;
      attempts: number;
      completed: number;
      review: number;
      pending: number;
    };
    created_at: string;
    updated_at: string;
    finished_at: string | null;
  };
  items: RecoveryOnlineItemReport[];
  artifact_digests: string[];
  rollback: {
    scope: "local_database_and_artifacts_only";
    snapshot_database_digest: string;
    remote_requests_reversible: false;
    steps: [
      "quiesce_workers",
      "verify_snapshot_digest",
      "restore_snapshot_database_atomically",
      "reconcile_unreferenced_artifacts_after_restore",
    ];
  };
}

export interface ExecuteRecoveryOnlineOptions
  extends PrepareRecoveryOnlineOptions {
  worker?: Omit<
    WorkerOptions,
    "once" | "scope" | "artifactStore" | "installSignalHandlers"
  >;
  installSignalHandlers?: boolean;
}

export interface ExecuteRecoveryOnlineResult {
  recovery: RecoveryOnlineReport;
  worker: WorkerResult;
}

interface OfflineGateResult {
  sourceId: number;
  finishedAt: string;
  completedJobs: number;
  succeededAttempts: number;
  documents: number;
  corpusDigest: string;
  reconciliationDigest: string;
}

interface JobInventory {
  digest: string;
  count: number;
  maxJobId: number;
  ids: number[];
}

interface PersistedOnlineBinding {
  run_id: number;
  offline_run_id: number;
  generation_id: string;
  generation_digest: string;
  manifest_digest: string;
  approval_digest: string;
  snapshot_database_digest: string;
  snapshot_artifact_inventory_digest: string;
  snapshot_artifact_count: number;
  snapshot_job_inventory_digest: string;
  snapshot_job_count: number;
  snapshot_max_job_id: number;
  snapshot_created_at: string;
  status: RecoveryOnlineStatus | "preparing";
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function onlineError(code: string, message: string): CliError {
  return new CliError(code, message, { exitCode: 2 });
}

function requireDigest(value: string, name: string): string {
  const digest = String(value || "").trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw onlineError(
      "bad_recovery_online_digest",
      `${name} must be an explicit lowercase SHA-256 digest`,
    );
  }
  return digest;
}

function hashRows(rows: unknown[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function jobInventory(db: Database, maxJobId?: number): JobInventory {
  const where = maxJobId === undefined ? "" : " WHERE id<=?";
  const parameters = maxJobId === undefined ? [] : [maxJobId];
  const jobs = db
    .query(
      `SELECT id, idempotency_key, kind, intent, resource_id, source_id, run_id,
              state, sensitivity, attempt_count, item_retry_count,
              current_attempt_id, run_at, block_reason, failure_class,
              failure_summary, created_at, updated_at
       FROM jobs${where} ORDER BY id`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  const ids = jobs.map((job) => Number(job.id));
  const attempts =
    ids.length === 0
      ? []
      : (db
          .query(
            `SELECT id, job_id, attempt_number, state, lease_expires_at,
                    heartbeat_at, failure_class, failure_summary, started_at,
                    finished_at
             FROM attempts
             WHERE job_id<=? AND job_id IN (SELECT id FROM jobs WHERE id<=?)
             ORDER BY id`,
          )
          .all(
            maxJobId ?? ids.at(-1) ?? 0,
            maxJobId ?? ids.at(-1) ?? 0,
          ) as Array<Record<string, unknown>>);
  const transitions =
    ids.length === 0
      ? []
      : (db
          .query(
            `SELECT id, job_id, attempt_id, from_state, to_state, actor, reason,
                    detail, created_at
             FROM job_transitions
             WHERE job_id IN (SELECT id FROM jobs WHERE id<=?) ORDER BY id`,
          )
          .all(maxJobId ?? ids.at(-1) ?? 0) as Array<Record<string, unknown>>);
  return {
    digest: hashRows([{ jobs }, { attempts }, { transitions }]),
    count: jobs.length,
    maxJobId: ids.at(-1) ?? 0,
    ids,
  };
}

function parseCheckpoint(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function assertOfflineCorpus(
  db: Database,
  generation: VerifiedRecoveryGeneration,
  offlineRunId: number,
): OfflineGateResult {
  const run = db
    .query(
      `SELECT r.run_type, r.source_id, r.state, r.checkpoint, r.finished_at,
              s.identifier
       FROM runs r JOIN sources s ON s.id=r.source_id WHERE r.id=?`,
    )
    .get(offlineRunId) as {
    run_type: string;
    source_id: number;
    state: string;
    checkpoint: string | null;
    finished_at: string | null;
    identifier: string;
  } | null;
  const checkpoint = parseCheckpoint(run?.checkpoint ?? null);
  if (
    run === null ||
    run.run_type !== "legacy_recovery_import" ||
    run.state !== "completed" ||
    run.finished_at === null ||
    run.identifier !== generation.generationId ||
    checkpoint?.generation_id !== generation.generationId ||
    checkpoint?.manifest_digest !== generation.manifestDigest
  ) {
    throw onlineError(
      "recovery_offline_not_reconciled",
      "the linked offline Run is not terminal and pinned to the selected generation",
    );
  }

  const policy = db
    .query(
      `SELECT mode, authorization_digest, allowed_job_kinds, expected_job_count
       FROM operator_run_policies WHERE run_id=?`,
    )
    .get(offlineRunId) as {
    mode: string;
    authorization_digest: string;
    allowed_job_kinds: string;
    expected_job_count: number;
  } | null;
  if (
    policy === null ||
    policy.mode !== "offline" ||
    policy.authorization_digest !== generation.generationDigest ||
    policy.allowed_job_kinds !==
      JSON.stringify([RECOVERY_OFFLINE_SCOPE_KIND]) ||
    policy.expected_job_count !== generation.counts.approved_offline_artifacts
  ) {
    throw onlineError(
      "recovery_offline_policy_mismatch",
      "the linked offline Run does not retain its immutable recovery scope",
    );
  }

  const jobCounts = db
    .query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN kind='file' AND state='completed' THEN 1 ELSE 0 END)
           AS completed_files,
         SUM(CASE WHEN kind='url' AND state='blocked' THEN 1 ELSE 0 END)
           AS blocked_urls,
         SUM(CASE WHEN state='excluded' THEN 1 ELSE 0 END) AS excluded
       FROM jobs WHERE run_id=?`,
    )
    .get(offlineRunId) as {
    total: number;
    completed_files: number;
    blocked_urls: number;
    excluded: number;
  };
  if (
    jobCounts.total !== 629 ||
    jobCounts.completed_files !==
      generation.counts.approved_offline_artifacts ||
    jobCounts.blocked_urls !==
      generation.counts.approved_online_jobs +
        generation.counts.blocked_review_jobs ||
    jobCounts.excluded !== generation.counts.excluded_candidates
  ) {
    throw onlineError(
      "recovery_offline_accounting_mismatch",
      "the linked offline Run no longer matches the frozen recovery accounting",
    );
  }

  const attemptCounts = db
    .query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN a.state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN j.kind='url' THEN 1 ELSE 0 END) AS url_attempts
       FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE j.run_id=?`,
    )
    .get(offlineRunId) as {
    total: number;
    succeeded: number;
    url_attempts: number;
  };
  if (
    attemptCounts.total !== generation.counts.approved_offline_artifacts ||
    attemptCounts.succeeded !== generation.counts.approved_offline_artifacts ||
    attemptCounts.url_attempts !== 0
  ) {
    throw onlineError(
      "recovery_offline_attempt_mismatch",
      "the linked offline Attempt inventory is not exactly reconciled",
    );
  }

  const materialized = db
    .query(
      `SELECT COUNT(*) AS count
       FROM jobs j
       JOIN resources r ON r.id=j.resource_id
       JOIN documents d ON d.id=r.document_id
       WHERE j.run_id=? AND j.kind='file' AND j.state='completed'
         AND j.idempotency_key GLOB ?
         AND EXISTS (
           SELECT 1 FROM provenance p
           WHERE p.resource_id=r.id AND p.run_id=j.run_id
             AND p.evidence_type='legacy_markdown_import'
             AND p.artifact_id IS NOT NULL
         )
         AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id=d.id)
         AND EXISTS (
           SELECT 1 FROM collection_memberships cm
           JOIN collections col ON col.id=cm.collection_id
           WHERE cm.resource_id=r.id AND col.slug='legacy-links'
         )
         AND length(d.source_uri)>0`,
    )
    .get(offlineRunId, `${RECOVERY_JOB_PREFIX}*`) as { count: number };
  if (materialized.count !== generation.counts.approved_offline_artifacts) {
    throw onlineError(
      "recovery_offline_materialization_mismatch",
      "the linked offline Artifact, Document, and Provenance gate failed",
    );
  }

  const fts = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM chunks) AS chunks,
         (SELECT COUNT(*) FROM chunks_fts) AS fts,
         (SELECT COUNT(*)
          FROM chunks c LEFT JOIN chunks_fts f ON f.rowid=c.id
          WHERE f.rowid IS NULL OR CAST(f.document_id AS INTEGER)<>c.document_id
             OR CAST(f.chunk_id AS INTEGER)<>c.id OR f.content<>c.content)
           AS mismatched`,
    )
    .get() as { chunks: number; fts: number; mismatched: number };
  const integrity = db.query("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;
  if (
    fts.chunks !== fts.fts ||
    fts.mismatched !== 0 ||
    integrity.length !== 1 ||
    integrity[0]?.integrity_check !== "ok"
  ) {
    throw onlineError(
      "recovery_offline_integrity_mismatch",
      "the linked offline SQLite or FTS integrity gate failed",
    );
  }

  const corpusRows = db
    .query(
      `SELECT j.id AS job_id, j.resource_id, r.document_id, d.source_type,
              d.source_uri, d.content_hash, d.revision_digest, d.size_chars,
              a.content_hash AS artifact_digest, a.byte_size AS artifact_bytes
       FROM jobs j
       JOIN resources r ON r.id=j.resource_id
       JOIN documents d ON d.id=r.document_id
       JOIN provenance p ON p.resource_id=r.id AND p.run_id=j.run_id
         AND p.evidence_type='legacy_markdown_import'
       JOIN artifacts a ON a.id=p.artifact_id
       WHERE j.run_id=? AND j.kind='file' AND j.state='completed'
       ORDER BY j.id`,
    )
    .all(offlineRunId) as Array<Record<string, unknown>>;
  const candidateEvidence = db
    .query(
      `SELECT r.key_value AS candidate_evidence_row_id, r.sensitivity,
              a.locator AS exact_locator, p.raw_metadata
       FROM resources r
       JOIN resource_aliases a ON a.resource_id=r.id
         AND a.alias_type='legacy_exact_url'
       JOIN provenance p ON p.resource_id=r.id
         AND p.evidence_type='recovery_candidate_outcome'
       WHERE r.key_type='recovery_candidate'
         AND EXISTS (
           SELECT 1 FROM json_each(p.raw_metadata, '$.generation_ids') g
           WHERE g.value=?
         )
       ORDER BY r.key_value`,
    )
    .all(generation.generationId) as Array<Record<string, unknown>>;
  const observationRows = db
    .query(
      `SELECT o.id, r.key_value AS candidate_evidence_row_id, o.ingress,
              o.observed_locator, o.suppressed, o.suppressed_reason,
              o.observed_at
       FROM observations o JOIN resources r ON r.id=o.resource_id
       WHERE o.run_id=? ORDER BY o.id`,
    )
    .all(offlineRunId) as Array<Record<string, unknown>>;
  const membershipRows = db
    .query(
      `SELECT r.key_value AS candidate_evidence_row_id, m.position,
              m.external_ref, m.added_at
       FROM collection_memberships m
       JOIN collections c ON c.id=m.collection_id
       JOIN resources r ON r.id=m.resource_id
       WHERE c.slug='legacy-links' ORDER BY m.position`,
    )
    .all() as Array<Record<string, unknown>>;
  if (
    candidateEvidence.length !== generation.counts.candidate_rows ||
    observationRows.length !== generation.counts.telegram_observations ||
    membershipRows.length !== generation.counts.catalog_memberships
  ) {
    throw onlineError(
      "recovery_offline_reconciliation_mismatch",
      "the linked offline candidate, Observation, or Collection reconciliation gate failed",
    );
  }

  return {
    sourceId: run.source_id,
    finishedAt: run.finished_at,
    completedJobs: jobCounts.completed_files,
    succeededAttempts: attemptCounts.succeeded,
    documents: materialized.count,
    corpusDigest: hashRows(corpusRows),
    reconciliationDigest: hashRows([
      { candidateEvidence },
      { observationRows },
      { membershipRows },
    ]),
  };
}

function approvedCandidates(
  generation: VerifiedRecoveryGeneration,
): VerifiedRecoveryCandidate[] {
  if (
    generation.onlineAllowlist.length !== ONLINE_ITEM_COUNT ||
    new Set(generation.onlineAllowlist).size !== ONLINE_ITEM_COUNT
  ) {
    throw onlineError(
      "recovery_online_cardinality_mismatch",
      "the immutable approval allowlist must contain exactly two distinct entries",
    );
  }
  const byId = new Map(
    generation.candidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  const candidates = generation.onlineAllowlist.map((id) => byId.get(id));
  if (
    candidates.some(
      (candidate) =>
        candidate === undefined ||
        candidate.disposition !== APPROVED_ONLINE_DISPOSITION ||
        candidate.observations.length === 0 ||
        candidate.observations.some(
          (observation) => observation.senderKind !== "human",
        ),
    )
  ) {
    throw onlineError(
      "recovery_online_approval_mismatch",
      "the immutable approval allowlist contains an ineligible candidate",
    );
  }
  return (candidates as VerifiedRecoveryCandidate[]).sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
}

function originalApprovedJobs(
  db: Database,
  offlineRunId: number,
  candidates: VerifiedRecoveryCandidate[],
): Array<{
  candidate: VerifiedRecoveryCandidate;
  jobId: number;
  resourceId: number;
}> {
  return candidates.map((candidate) => {
    const row = db
      .query(
        `SELECT id, intent, resource_id, state, block_reason, attempt_count
         FROM jobs WHERE run_id=? AND idempotency_key=? AND kind='url'`,
      )
      .get(offlineRunId, `${RECOVERY_JOB_PREFIX}${candidate.candidateId}`) as {
      id: number;
      intent: string | null;
      resource_id: number | null;
      state: string;
      block_reason: string | null;
      attempt_count: number;
    } | null;
    const outcome =
      row?.resource_id === null || row?.resource_id === undefined
        ? null
        : (db
            .query(
              `SELECT p.id
               FROM provenance p
               WHERE p.resource_id=?
                 AND p.evidence_type='recovery_candidate_outcome'
                 AND json_extract(p.raw_metadata, '$.candidate_evidence_row_id')=?
                 AND json_extract(p.raw_metadata, '$.disposition')=?`,
            )
            .get(
              row.resource_id,
              candidate.candidateId,
              APPROVED_ONLINE_DISPOSITION,
            ) as { id: number } | null);
    const exactAlias =
      row?.resource_id === null || row?.resource_id === undefined
        ? null
        : db
            .query(
              `SELECT id FROM resource_aliases
               WHERE resource_id=? AND alias_type='legacy_exact_url'
                 AND locator=?`,
            )
            .get(row.resource_id, candidate.sourceUri);
    if (
      row === null ||
      row.state !== "blocked" ||
      row.block_reason !==
        `recovery disposition ${APPROVED_ONLINE_DISPOSITION}` ||
      row.attempt_count !== 0 ||
      row.resource_id === null ||
      row.intent !== recoveryUrlIntent(candidate) ||
      exactAlias === null ||
      outcome === null
    ) {
      throw onlineError(
        "recovery_online_mapping_mismatch",
        `approved candidate ${candidate.candidateId} is not mapped to its original blocked job`,
      );
    }
    return { candidate, jobId: row.id, resourceId: row.resource_id };
  });
}

function assertQuiescent(store: ResearchStore, now: Date): void {
  const timestamp = now.toISOString();
  const active = store.db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM attempts
          WHERE state='leased' AND lease_expires_at>?) AS attempts,
         (SELECT COUNT(*) FROM operator_run_execution_leases
          WHERE lease_expires_at>?) AS executions,
         (SELECT COUNT(*) FROM jobs j WHERE state='running'
            AND NOT EXISTS (
              SELECT 1 FROM recovery_online_runs r WHERE r.run_id=j.run_id
            )) AS running`,
    )
    .get(timestamp, timestamp) as {
    attempts: number;
    executions: number;
    running: number;
  };
  if (
    active.attempts !== 0 ||
    active.executions !== 0 ||
    active.running !== 0
  ) {
    throw onlineError(
      "recovery_workers_not_quiescent",
      "all ordinary and scoped Workers must be quiescent before online activation",
    );
  }
}

function assertPrivateRecoveryPaths(
  generation: VerifiedRecoveryGeneration,
  snapshotPath: string,
): void {
  const required = [
    { path: generation.generationRoot, directory: true },
    {
      path: join(generation.generationRoot, "online-allowlist.json"),
      directory: false,
    },
    { path: resolve(snapshotPath), directory: true },
    {
      path: join(resolve(snapshotPath), BACKUP_DATABASE_FILE),
      directory: false,
    },
    { path: join(resolve(snapshotPath), "manifest.json"), directory: false },
  ];
  try {
    for (const entry of required) {
      const stat = lstatSync(entry.path);
      const expectedMode = entry.directory ? 0o700 : 0o600;
      if (
        stat.isSymbolicLink() ||
        (entry.directory ? !stat.isDirectory() : !stat.isFile()) ||
        (stat.mode & 0o777) !== expectedMode
      ) {
        throw new Error("unsafe mode");
      }
    }
  } catch {
    throw onlineError(
      "recovery_private_permissions_failed",
      "the generation approval or post-offline snapshot is not a private regular path",
    );
  }
}

function assertArtifactAndDiskGates(
  store: ResearchStore,
  artifactStore: ArtifactStore,
  now: Date,
): void {
  const reconciliation = store.reconcileArtifactStore(artifactStore, {
    now,
    verifyPromoted: true,
  });
  if (
    reconciliation.permissionDrift.length !== 0 ||
    reconciliation.integrityDefects.length !== 0
  ) {
    throw onlineError(
      "recovery_artifact_integrity_failed",
      "Artifact integrity or private-permission verification failed",
    );
  }
  const stat = statfsSync(artifactStore.root);
  const available = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isFinite(available) || available < MIN_FREE_BYTES) {
    throw onlineError(
      "recovery_disk_space_failed",
      "the Artifact store does not have the required recovery safety floor",
    );
  }
}

function loadBinding(
  store: ResearchStore,
  offlineRunId: number,
): PersistedOnlineBinding | null {
  return store.db
    .query(
      `SELECT run_id, offline_run_id, generation_id, generation_digest,
              manifest_digest, approval_digest, snapshot_database_digest,
              snapshot_artifact_inventory_digest, snapshot_artifact_count,
              snapshot_job_inventory_digest, snapshot_job_count,
              snapshot_max_job_id, snapshot_created_at, status, created_at,
              updated_at, finished_at
       FROM recovery_online_runs WHERE offline_run_id=?`,
    )
    .get(offlineRunId) as PersistedOnlineBinding | null;
}

function assertBinding(
  binding: PersistedOnlineBinding,
  generation: VerifiedRecoveryGeneration,
  expectedApprovalDigest: string,
  snapshotDigest: string,
  artifactInventoryDigest: string,
  artifactCount: number,
  snapshotInventory: JobInventory,
  snapshotCreatedAt: string,
): void {
  if (
    binding.generation_id !== generation.generationId ||
    binding.generation_digest !== generation.generationDigest ||
    binding.manifest_digest !== generation.manifestDigest ||
    binding.approval_digest !== expectedApprovalDigest ||
    binding.snapshot_database_digest !== snapshotDigest ||
    binding.snapshot_artifact_inventory_digest !== artifactInventoryDigest ||
    binding.snapshot_artifact_count !== artifactCount ||
    binding.snapshot_job_inventory_digest !== snapshotInventory.digest ||
    binding.snapshot_job_count !== snapshotInventory.count ||
    binding.snapshot_max_job_id !== snapshotInventory.maxJobId ||
    binding.snapshot_created_at !== snapshotCreatedAt
  ) {
    throw onlineError(
      "recovery_online_binding_immutable",
      "an online Run already exists with a different immutable authorization tuple",
    );
  }
}

function assertProtectedInventory(
  store: ResearchStore,
  binding: PersistedOnlineBinding,
): void {
  const inventory = jobInventory(store.db, binding.snapshot_max_job_id);
  if (
    inventory.count !== binding.snapshot_job_count ||
    inventory.digest !== binding.snapshot_job_inventory_digest
  ) {
    throw onlineError(
      "recovery_protected_jobs_changed",
      "a pre-online ingestion job or Attempt changed after the post-offline snapshot",
    );
  }
  const allowed = store.db
    .query(
      "SELECT job_id FROM recovery_online_items WHERE run_id=? ORDER BY job_id",
    )
    .all(binding.run_id) as Array<{ job_id: number }>;
  const postSnapshot = store.db
    .query("SELECT id FROM jobs WHERE id>? ORDER BY id")
    .all(binding.snapshot_max_job_id) as Array<{ id: number }>;
  if (
    postSnapshot.length !== ONLINE_ITEM_COUNT ||
    postSnapshot.some((row, index) => row.id !== allowed[index]?.job_id)
  ) {
    throw onlineError(
      "recovery_scope_widened",
      "the post-snapshot job inventory contains work outside the approved online pair",
    );
  }
}

function createOnlineBinding(
  store: ResearchStore,
  generation: VerifiedRecoveryGeneration,
  offlineRunId: number,
  sourceId: number,
  approved: Array<{
    candidate: VerifiedRecoveryCandidate;
    jobId: number;
    resourceId: number;
  }>,
  snapshotDigest: string,
  artifactInventoryDigest: string,
  artifactCount: number,
  snapshotInventory: JobInventory,
  snapshotCreatedAt: string,
  timestamp: string,
): PersistedOnlineBinding {
  const transaction = store.db.transaction((): number => {
    const checkpoint = JSON.stringify({
      schema_version: 1,
      generation_id: generation.generationId,
      generation_digest: generation.generationDigest,
      manifest_digest: generation.manifestDigest,
      approval_digest: generation.onlineAllowlistDigest,
      offline_run_id: offlineRunId,
      snapshot_database_digest: snapshotDigest,
      snapshot_artifact_inventory_digest: artifactInventoryDigest,
      candidate_evidence_row_ids: approved.map(
        (item) => item.candidate.candidateId,
      ),
      rollback_scope: "local_only_remote_requests_irreversible",
    });
    const runId = Number(
      store.db
        .query(
          `INSERT INTO runs(
             run_type, source_id, state, checkpoint, created_at, updated_at
           ) VALUES ('controlled_online_backfill', ?, 'pending', ?, ?, ?)`,
        )
        .run(sourceId, checkpoint, timestamp, timestamp).lastInsertRowid,
    );
    store.db
      .query(
        `INSERT INTO recovery_online_runs(
           run_id, offline_run_id, generation_id, generation_digest,
           manifest_digest, approval_digest, snapshot_database_digest,
           snapshot_artifact_inventory_digest, snapshot_artifact_count,
           snapshot_job_inventory_digest, snapshot_job_count,
           snapshot_max_job_id, snapshot_created_at, status, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?) `,
      )
      .run(
        runId,
        offlineRunId,
        generation.generationId,
        generation.generationDigest,
        generation.manifestDigest,
        generation.onlineAllowlistDigest,
        snapshotDigest,
        artifactInventoryDigest,
        artifactCount,
        snapshotInventory.digest,
        snapshotInventory.count,
        snapshotInventory.maxJobId,
        snapshotCreatedAt,
        timestamp,
        timestamp,
      );
    for (const item of approved) {
      const onlineJobId = Number(
        store.db
          .query(
            `INSERT INTO jobs(
               idempotency_key, kind, intent, resource_id, source_id, run_id,
               state, sensitivity, run_at, block_reason, created_at, updated_at
             ) VALUES (?, 'url', ?, ?, ?, ?, 'blocked', ?, ?, ?, ?, ?)`,
          )
          .run(
            `${RECOVERY_ONLINE_JOB_PREFIX}${generation.generationDigest}:${item.candidate.candidateId}`,
            recoveryUrlIntent(item.candidate),
            item.resourceId,
            sourceId,
            runId,
            item.candidate.sensitivity,
            timestamp,
            ACTIVATION_BLOCK_REASON,
            timestamp,
            timestamp,
          ).lastInsertRowid,
      );
      store.db
        .query(
          `INSERT INTO job_transitions(
             job_id, from_state, to_state, actor, reason, detail, created_at
           ) VALUES (?, NULL, 'blocked', 'legacy-recovery',
                     'controlled_online_prepared', NULL, ?)`,
        )
        .run(onlineJobId, timestamp);
      store.db
        .query(
          `INSERT INTO recovery_online_items(
             run_id, candidate_evidence_row_id, offline_job_id, job_id,
             resource_id, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          item.candidate.candidateId,
          item.jobId,
          onlineJobId,
          item.resourceId,
          timestamp,
        );
    }
    return runId;
  });
  transaction.immediate();
  const binding = loadBinding(store, offlineRunId);
  if (binding === null) {
    throw onlineError(
      "recovery_online_activation_failed",
      "the controlled online Run binding was not durably created",
    );
  }
  return binding;
}

function validateOnlineItems(
  store: ResearchStore,
  binding: PersistedOnlineBinding,
  generation: VerifiedRecoveryGeneration,
  approved: Array<{
    candidate: VerifiedRecoveryCandidate;
    jobId: number;
    resourceId: number;
  }>,
): void {
  const rows = store.db
    .query(
      `SELECT i.candidate_evidence_row_id, i.offline_job_id, i.job_id,
              i.resource_id, j.resource_id AS job_resource_id,
              j.idempotency_key, j.kind, j.intent, j.run_id, j.state
       FROM recovery_online_items i JOIN jobs j ON j.id=i.job_id
       WHERE i.run_id=? ORDER BY i.candidate_evidence_row_id`,
    )
    .all(binding.run_id) as Array<{
    candidate_evidence_row_id: string;
    offline_job_id: number;
    job_id: number;
    resource_id: number;
    job_resource_id: number | null;
    idempotency_key: string;
    kind: string;
    intent: string | null;
    run_id: number;
    state: JobState;
  }>;
  if (rows.length !== ONLINE_ITEM_COUNT) {
    throw onlineError(
      "recovery_online_cardinality_mismatch",
      "the controlled online Run does not contain exactly two item bindings",
    );
  }
  const expected = new Map(
    approved.map((item) => [item.candidate.candidateId, item]),
  );
  for (const row of rows) {
    const item = expected.get(row.candidate_evidence_row_id);
    if (
      item === undefined ||
      row.offline_job_id !== item.jobId ||
      row.resource_id !== item.resourceId ||
      row.kind !== "url" ||
      row.run_id !== binding.run_id ||
      (row.state !== "completed" && row.job_resource_id !== item.resourceId) ||
      row.intent !== recoveryUrlIntent(item.candidate) ||
      row.idempotency_key !==
        `${RECOVERY_ONLINE_JOB_PREFIX}${generation.generationDigest}:${item.candidate.candidateId}`
    ) {
      throw onlineError(
        "recovery_online_mapping_mismatch",
        "the controlled online Run contains a substituted or altered candidate",
      );
    }
  }
}

function authorizeAndActivate(
  store: ResearchStore,
  binding: PersistedOnlineBinding,
  now: Date,
): void {
  store.authorizeRunScope({
    runId: binding.run_id,
    mode: "online",
    authorizationDigest: binding.approval_digest,
    allowedKinds: [RECOVERY_ONLINE_SCOPE_KIND],
    expectedJobCount: ONLINE_ITEM_COUNT,
    now,
  });
  const timestamp = now.toISOString();
  const transaction = store.db.transaction(() => {
    const jobs = store.db
      .query(
        `SELECT id FROM jobs
         WHERE run_id=? AND state='blocked' AND block_reason=? ORDER BY id`,
      )
      .all(binding.run_id, ACTIVATION_BLOCK_REASON) as Array<{ id: number }>;
    for (const job of jobs) {
      store.db
        .query(
          `UPDATE jobs SET state='queued', block_reason=NULL, run_at=?, updated_at=?
           WHERE id=?`,
        )
        .run(timestamp, timestamp, job.id);
      store.db
        .query(
          `INSERT INTO job_transitions(
             job_id, from_state, to_state, actor, reason, detail, created_at
           ) VALUES (?, 'blocked', 'queued', 'legacy-recovery',
                     'controlled_online_activated', NULL, ?)`,
        )
        .run(job.id, timestamp);
    }
    store.db
      .query(
        `UPDATE recovery_online_runs
         SET status=CASE WHEN status='preparing' THEN 'ready' ELSE status END,
             updated_at=? WHERE run_id=?`,
      )
      .run(timestamp, binding.run_id);
  });
  transaction.immediate();
}

function onlineScope(binding: PersistedOnlineBinding): OperatorRunScope {
  return {
    runId: binding.run_id,
    authorizationDigest: binding.approval_digest,
    allowedKinds: [RECOVERY_ONLINE_SCOPE_KIND],
  };
}

function recoveryOnlineReport(
  store: ResearchStore,
  offlineRunId: number,
): RecoveryOnlineReport {
  const binding = loadBinding(store, offlineRunId);
  if (binding === null) {
    throw onlineError(
      "recovery_online_not_found",
      "the linked controlled online Run does not exist",
    );
  }
  assertProtectedInventory(store, binding);
  const rows = store.db
    .query(
      `SELECT i.candidate_evidence_row_id, i.job_id, i.outcome,
              i.failure_class, i.artifact_digest, i.started_at, i.finished_at,
              j.state
       FROM recovery_online_items i JOIN jobs j ON j.id=i.job_id
       WHERE i.run_id=? ORDER BY i.candidate_evidence_row_id`,
    )
    .all(binding.run_id) as Array<{
    candidate_evidence_row_id: string;
    job_id: number;
    outcome: string;
    failure_class: FailureClass | null;
    artifact_digest: string | null;
    started_at: string | null;
    finished_at: string | null;
    state: JobState;
  }>;
  const items: RecoveryOnlineItemReport[] = rows.map((row) => ({
    candidate_evidence_row_id: row.candidate_evidence_row_id,
    job_id: row.job_id,
    state: row.state,
    outcome: row.outcome,
    attempt_ids: (
      store.db
        .query("SELECT id FROM attempts WHERE job_id=? ORDER BY id")
        .all(row.job_id) as Array<{ id: number }>
    ).map((attempt) => attempt.id),
    failure_class: row.failure_class,
    artifact_digest: row.artifact_digest,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }));
  const completed = rows.filter((row) => row.state === "completed").length;
  const review = rows.filter((row) =>
    ["blocked", "failed", "excluded", "cancelled"].includes(row.state),
  ).length;
  const pending = rows.length - completed - review;
  const status = binding.status === "preparing" ? "ready" : binding.status;
  const artifacts = [
    ...new Set(
      rows
        .map((row) => row.artifact_digest)
        .filter((digest): digest is string => digest !== null),
    ),
  ].sort();
  return {
    schema_version: 1,
    status,
    generation_id: binding.generation_id,
    generation_digest: binding.generation_digest,
    manifest_digest: binding.manifest_digest,
    approval_digest: binding.approval_digest,
    candidate_evidence_row_ids: rows.map(
      (row) => row.candidate_evidence_row_id,
    ),
    snapshot: {
      restore_verified: true,
      database_digest: binding.snapshot_database_digest,
      artifact_inventory_digest: binding.snapshot_artifact_inventory_digest,
      artifacts_checked: binding.snapshot_artifact_count,
      corpus_jobs: 581,
      corpus_documents: 581,
    },
    offline_run: {
      id: binding.offline_run_id,
      state: "completed",
      completed_artifact_jobs: 581,
      succeeded_attempts: 581,
    },
    online_run: {
      id: binding.run_id,
      linked_offline_run_id: binding.offline_run_id,
      state: status,
      authorization_digest: binding.approval_digest,
      allowed_job_kinds: [RECOVERY_ONLINE_SCOPE_KIND],
      expected_job_count: ONLINE_ITEM_COUNT,
      protected_jobs_unchanged: binding.snapshot_job_count,
      counts: {
        jobs: rows.length,
        attempts: items.reduce(
          (total, item) => total + item.attempt_ids.length,
          0,
        ),
        completed,
        review,
        pending,
      },
      created_at: binding.created_at,
      updated_at: binding.updated_at,
      finished_at: binding.finished_at,
    },
    items,
    artifact_digests: artifacts,
    rollback: {
      scope: "local_database_and_artifacts_only",
      snapshot_database_digest: binding.snapshot_database_digest,
      remote_requests_reversible: false,
      steps: [
        "quiesce_workers",
        "verify_snapshot_digest",
        "restore_snapshot_database_atomically",
        "reconcile_unreferenced_artifacts_after_restore",
      ],
    },
  };
}

export function prepareRecoveryOnlineBackfill(
  store: ResearchStore,
  generation: VerifiedRecoveryGeneration,
  options: PrepareRecoveryOnlineOptions,
): RecoveryOnlineReport {
  if (!Number.isSafeInteger(options.offlineRunId) || options.offlineRunId < 1) {
    throw onlineError(
      "bad_recovery_offline_run",
      "the linked offline Run ID must be a positive integer",
    );
  }
  const generationDigest = requireDigest(
    options.expectedGenerationDigest,
    "generation digest",
  );
  const approvalDigest = requireDigest(
    options.expectedApprovalDigest,
    "approval digest",
  );
  const snapshotDigest = requireDigest(
    options.expectedSnapshotDigest,
    "post-offline snapshot digest",
  );
  if (generationDigest !== generation.generationDigest) {
    throw onlineError(
      "recovery_generation_digest_mismatch",
      "the explicit generation digest does not match the pinned generation",
    );
  }
  if (approvalDigest !== generation.onlineAllowlistDigest) {
    throw onlineError(
      "recovery_approval_digest_mismatch",
      "the explicit approval digest does not match the immutable allowlist",
    );
  }

  assertPrivateRecoveryPaths(generation, options.postOfflineSnapshot);
  const backup = verifyBackup(options.postOfflineSnapshot, {
    artifactRoot: options.artifactStore.root,
  });
  if (!backup.verified || backup.database_sha256 !== snapshotDigest) {
    throw onlineError(
      "recovery_snapshot_verification_failed",
      "the post-offline snapshot failed restore verification or digest pinning",
    );
  }
  const manifest = readBackupManifest(resolve(options.postOfflineSnapshot));
  if (
    resolve(manifest.source_paths.database) !== resolve(store.dbPath) ||
    resolve(manifest.source_paths.artifact_store) !==
      resolve(options.artifactStore.root)
  ) {
    throw onlineError(
      "recovery_snapshot_source_mismatch",
      "the post-offline snapshot was not created from the selected database and Artifact store",
    );
  }

  const snapshotDb = openReadonlyDatabase(
    join(resolve(options.postOfflineSnapshot), BACKUP_DATABASE_FILE),
  );
  let snapshotGate: OfflineGateResult;
  let snapshotInventory: JobInventory;
  try {
    snapshotGate = assertOfflineCorpus(
      snapshotDb,
      generation,
      options.offlineRunId,
    );
    snapshotInventory = jobInventory(snapshotDb);
  } finally {
    snapshotDb.close();
  }

  if (backup.created_at < snapshotGate.finishedAt) {
    throw onlineError(
      "recovery_snapshot_stale",
      "the verified snapshot predates terminal offline reconciliation",
    );
  }

  const now = options.now ?? new Date();
  const liveGate = assertOfflineCorpus(
    store.db,
    generation,
    options.offlineRunId,
  );
  if (
    liveGate.completedJobs !== snapshotGate.completedJobs ||
    liveGate.succeededAttempts !== snapshotGate.succeededAttempts ||
    liveGate.documents !== snapshotGate.documents ||
    liveGate.corpusDigest !== snapshotGate.corpusDigest ||
    liveGate.reconciliationDigest !== snapshotGate.reconciliationDigest
  ) {
    throw onlineError(
      "recovery_snapshot_corpus_mismatch",
      "the live offline corpus differs from the verified post-offline snapshot",
    );
  }
  assertQuiescent(store, now);
  assertArtifactAndDiskGates(store, options.artifactStore, now);

  const candidates = approvedCandidates(generation);
  const approved = originalApprovedJobs(
    store.db,
    options.offlineRunId,
    candidates,
  );
  let binding = loadBinding(store, options.offlineRunId);
  if (binding === null) {
    const currentSnapshotInventory = jobInventory(
      store.db,
      snapshotInventory.maxJobId,
    );
    const postSnapshotJobs = store.db
      .query("SELECT COUNT(*) AS count FROM jobs WHERE id>?")
      .get(snapshotInventory.maxJobId) as { count: number };
    if (
      currentSnapshotInventory.digest !== snapshotInventory.digest ||
      currentSnapshotInventory.count !== snapshotInventory.count ||
      postSnapshotJobs.count !== 0
    ) {
      throw onlineError(
        "recovery_snapshot_stale",
        "ingestion ledger state changed after the verified post-offline snapshot",
      );
    }
    binding = createOnlineBinding(
      store,
      generation,
      options.offlineRunId,
      liveGate.sourceId,
      approved,
      snapshotDigest,
      backup.artifact_inventory_sha256,
      backup.artifacts_checked,
      snapshotInventory,
      backup.created_at,
      now.toISOString(),
    );
  } else {
    assertBinding(
      binding,
      generation,
      approvalDigest,
      snapshotDigest,
      backup.artifact_inventory_sha256,
      backup.artifacts_checked,
      snapshotInventory,
      backup.created_at,
    );
  }
  validateOnlineItems(store, binding, generation, approved);
  assertProtectedInventory(store, binding);
  authorizeAndActivate(store, binding, now);
  return recoveryOnlineReport(store, options.offlineRunId);
}

export async function executeRecoveryOnlineBackfill(
  store: ResearchStore,
  generation: VerifiedRecoveryGeneration,
  options: ExecuteRecoveryOnlineOptions,
): Promise<ExecuteRecoveryOnlineResult> {
  prepareRecoveryOnlineBackfill(store, generation, options);
  const binding = loadBinding(store, options.offlineRunId);
  if (binding === null) {
    throw onlineError(
      "recovery_online_activation_failed",
      "the controlled online Run was not available for execution",
    );
  }
  const worker = await runWorker(store, {
    ...options.worker,
    once: true,
    scope: onlineScope(binding),
    artifactStore: options.artifactStore,
    installSignalHandlers: options.installSignalHandlers ?? false,
  });
  try {
    assertArtifactAndDiskGates(
      store,
      options.artifactStore,
      options.now ?? new Date(),
    );
  } catch (error) {
    const timestamp = (options.now ?? new Date()).toISOString();
    store.db
      .transaction(() => {
        store.db
          .query(
            `UPDATE recovery_online_runs
             SET status='paused', updated_at=?, finished_at=NULL WHERE run_id=?`,
          )
          .run(timestamp, binding.run_id);
        store.db
          .query(
            `UPDATE runs SET state='pending', updated_at=?, finished_at=NULL
             WHERE id=? AND state NOT IN ('failed', 'cancelled')`,
          )
          .run(timestamp, binding.run_id);
      })
      .immediate();
    throw error;
  }
  return {
    recovery: recoveryOnlineReport(store, options.offlineRunId),
    worker,
  };
}
