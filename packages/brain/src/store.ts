import { Database } from "./sqlite.js";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ArtifactReconciliationReport,
  ArtifactStore,
  LocalFileSnapshot,
  ReconcileOptions,
  StoredArtifact,
} from "./artifacts.js";
import { isSafeArtifactStoragePath, SHA256_DIGEST_PATTERN } from "./artifacts.js";
import { CliError } from "./errors.js";
import {
  assertDefaultDatabaseTargetSafe,
  isDefaultDatabasePath,
} from "./paths.js";
import { parseTags } from "./query.js";
import { sanitizeExternalError } from "./sanitize.js";
import { deriveStructuralTags } from "./tagging.js";
import {
  chunkMarkdown,
  chunkText,
  cleanMarkdown,
  cleanText,
  codePointLength,
  isMarkdownContent,
  MARKDOWN_CHUNKER_VERSION,
  normalizeTags,
  sha256Text,
  TEXT_CHUNKER_VERSION,
} from "./text.js";
import type {
  Artifact,
  Attempt,
  CancelResult,
  ClaimResult,
  CompleteResult,
  ContentKind,
  FailResult,
  FailureClass,
  FanoutDiscovery,
  HeartbeatResult,
  Job,
  JobState,
  LifecyclePolicy,
  OperatorRunExecution,
  OperatorRunMode,
  OperatorRunPolicy,
  OperatorRunScope,
  RecoveredLease,
  ResourceRelation,
  Run,
  Sensitivity,
} from "./types.js";

export const RESEARCH_SCHEMA_VERSION = 12;

/**
 * Default lease and retry policy. Durations are policy, not identity: callers
 * may override any field per invocation without altering persisted job
 * semantics or idempotency keys (ADR 0004).
 */
export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  leaseMs: 60_000,
  maxItemRetries: 5,
  infraBaseMs: 5_000,
  infraCapMs: 300_000,
  itemBaseMs: 2_000,
  itemCapMs: 120_000,
  jitterRatio: 0.1,
};

/**
 * The accepted job state machine (ADR 0004). Every state change routes through
 * assertTransition so an illegal transition is rejected rather than silently
 * corrupting queue state. Sensitive-inspection audit is a self-loop recorded
 * outside this map because it never changes state.
 */
const LEGAL_JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "cancelled", "excluded"],
  running: ["completed", "retry_wait", "blocked", "failed", "cancelled"],
  retry_wait: ["running", "queued", "cancelled", "excluded"],
  blocked: ["queued", "cancelled", "excluded"],
  failed: ["queued", "cancelled", "excluded"],
  completed: [],
  excluded: ["queued"],
  cancelled: ["queued"],
};

interface LifecycleOptions {
  now?: Date;
  /** Lease duration for this claim/heartbeat; falls back to policy.leaseMs. */
  leaseMs?: number;
  policy?: Partial<LifecyclePolicy>;
  random?: () => number;
}

interface Row {
  [key: string]: unknown;
}

export interface UpsertDocumentInput {
  sourceType: string;
  sourceUri: string;
  title?: string | null;
  contentKind?: ContentKind | null;
  contentItemCount?: number | null;
  content: string;
  tags?: unknown;
  notes?: string | null;
  mediaType?: string | null;
  revisionDigest?: string | null;
  force?: boolean;
}

export interface UpsertDocumentResult {
  success: true;
  status: "created" | "updated" | "unchanged";
  document_id: number;
  title: string;
  source_uri: string;
  source_type?: string;
  content_kind: ContentKind | null;
  content_item_count: number | null;
  size_chars: number;
  chunk_count?: number;
  tags: string[];
}

export interface RetagDocumentResult {
  success: true;
  status: "unchanged" | "updated";
  document_id: number;
  tags: string[];
}

export interface DocumentLinkResult {
  success: true;
  id: number;
  from_document_id: number;
  to_document_id: number | null;
  relation_type: string;
  discovered_url: string;
  resolved_url: string | null;
  status: "success" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommitUrlFanoutInput {
  parentResourceId: number;
  parentJobId: number;
  sourceId?: number | null;
  runId?: number | null;
  ingress: string;
  sensitivity: Sensitivity;
  discoveries: FanoutDiscovery[];
  observedAt?: Date;
}

export interface CommitUrlFanoutResult {
  admitted: number;
  suppressed: number;
  relations: ResourceRelation[];
}

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    title TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size_chars INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_type, source_uri)
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    content TEXT NOT NULL,
    UNIQUE(document_id, chunk_index)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    document_id UNINDEXED,
    chunk_id UNINDEXED,
    title,
    content,
    tags,
    source_uri,
    tokenize='porter unicode61 remove_diacritics 2'
  );

  CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type, source_uri);
  CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, chunk_index);
`;

const MIGRATION_V2 = `
  CREATE TABLE IF NOT EXISTS document_links (
    id INTEGER PRIMARY KEY,
    from_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    to_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    relation_type TEXT NOT NULL,
    discovered_url TEXT NOT NULL,
    resolved_url TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(from_document_id, relation_type, discovered_url)
  );
  CREATE INDEX IF NOT EXISTS idx_document_links_from
    ON document_links(from_document_id, relation_type, status);
  CREATE INDEX IF NOT EXISTS idx_document_links_to
    ON document_links(to_document_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_document_links_status
    ON document_links(status, updated_at DESC);
  UPDATE meta SET value='2' WHERE key='schema_version';
`;

// Additive durable-ingestion domain model. Legacy documents/chunks/FTS and
// document_links are untouched; resources reference them by nullable FK so a
// resource's identity survives content deletion. Artifact bytes dedupe by
// digest while resources link them many-to-many, and observed locators are
// per-resource aliases: equal digests and canonical URLs never collapse two
// resources (ADR 0006, ADR 0008).
const MIGRATION_V3 = `
  CREATE TABLE IF NOT EXISTS sensitivity_levels (
    level TEXT PRIMARY KEY,
    rank INTEGER NOT NULL UNIQUE
  );
  INSERT OR IGNORE INTO sensitivity_levels(level, rank) VALUES
    ('public', 0), ('normal', 1), ('sensitive', 2), ('private', 3);

  CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY,
    key_type TEXT NOT NULL,
    key_value TEXT NOT NULL,
    kind TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    document_id INTEGER UNIQUE REFERENCES documents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(key_type, key_value)
  );
  CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind, updated_at DESC);

  CREATE TABLE IF NOT EXISTS resource_aliases (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    alias_type TEXT NOT NULL,
    locator TEXT NOT NULL,
    evidence TEXT,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE(resource_id, alias_type, locator)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_aliases_locator
    ON resource_aliases(locator, alias_type);

  CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    artifact_role TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    storage_path TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(content_hash, artifact_role)
  );

  CREATE TABLE IF NOT EXISTS resource_artifacts (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    UNIQUE(resource_id, artifact_id)
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    source_type TEXT NOT NULL,
    identifier TEXT NOT NULL,
    display_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    schedule TEXT,
    checkpoint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_type, identifier)
  );

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collection_memberships (
    id INTEGER PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    position INTEGER,
    external_ref TEXT,
    added_at TEXT NOT NULL,
    UNIQUE(collection_id, resource_id),
    UNIQUE(collection_id, position)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    run_type TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'active', 'completed', 'failed', 'cancelled')),
    checkpoint TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    ingress TEXT NOT NULL,
    observed_locator TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
    suppressed_reason TEXT,
    observed_at TEXT NOT NULL,
    CHECK (suppressed = 0 OR suppressed_reason IS NOT NULL),
    UNIQUE(run_id, resource_id, observed_locator)
  );
  CREATE INDEX IF NOT EXISTS idx_observations_resource
    ON observations(resource_id, observed_at DESC);

  CREATE TABLE IF NOT EXISTS provenance (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
    relation_id INTEGER REFERENCES document_links(id) ON DELETE SET NULL,
    ingress TEXT,
    raw_metadata TEXT,
    observed_at TEXT NOT NULL,
    UNIQUE(resource_id, evidence_type, source_id, run_id, artifact_id, relation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_provenance_resource
    ON provenance(resource_id, evidence_type);

  INSERT INTO resources(
    key_type, key_value, kind, sensitivity, document_id, created_at, updated_at
  )
    SELECT 'legacy_document', CAST(d.id AS TEXT), d.source_type, 'normal',
           d.id, d.created_at, d.updated_at
    FROM documents d;

  INSERT INTO resource_aliases(
    resource_id, alias_type, locator, evidence, first_observed_at, last_observed_at
  )
    SELECT r.id, 'legacy_source_uri', d.source_uri, d.source_type,
           d.created_at, d.updated_at
    FROM documents d JOIN resources r ON r.document_id = d.id;

  INSERT INTO provenance(
    resource_id, evidence_type, relation_id, raw_metadata, observed_at
  )
    SELECT r.id, 'legacy_relation', dl.id, dl.discovered_url, dl.created_at
    FROM document_links dl JOIN resources r ON r.document_id = dl.from_document_id;

  UPDATE meta SET value='3' WHERE key='schema_version';
`;

// Additive durable ingestion ledger (ADR 0004). Jobs hold one immutable intent
// and a mutable disposition; attempts are append-only leased executions whose
// autoincrement id doubles as a globally monotonic fencing token; transitions
// are an append-only audit of every disposition change and operator action.
// current_attempt_id is the job's live fencing token (a logical reference, not
// an enforced FK, to avoid a jobs<->attempts cycle). No legacy table is touched.
const MIGRATION_V4 = `
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    intent TEXT,
    resource_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
      'queued', 'running', 'retry_wait', 'blocked',
      'failed', 'completed', 'excluded', 'cancelled'
    )),
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    item_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (item_retry_count >= 0),
    current_attempt_id INTEGER,
    run_at TEXT NOT NULL,
    block_reason TEXT,
    failure_class TEXT,
    failure_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs(state, run_at, id);
  CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, updated_at DESC);

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    worker TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'leased' CHECK (state IN (
      'leased', 'succeeded', 'failed', 'stale', 'cancelled'
    )),
    lease_expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    failure_class TEXT,
    failure_summary TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(job_id, attempt_number)
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts(job_id, attempt_number);
  CREATE INDEX IF NOT EXISTS idx_attempts_lease ON attempts(state, lease_expires_at);

  CREATE TABLE IF NOT EXISTS job_transitions (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_id INTEGER REFERENCES attempts(id) ON DELETE SET NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_job_transitions_job
    ON job_transitions(job_id, id);

  UPDATE meta SET value='4' WHERE key='schema_version';
`;

// Artifact derivation is many-to-many: a normalized Artifact can be derived
// from one or more captured Artifacts without placing bytes in SQLite or
// treating a content digest as a Resource key (ADR 0008).
const MIGRATION_V5 = `
  CREATE TABLE IF NOT EXISTS artifact_derivations (
    id INTEGER PRIMARY KEY,
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    parent_artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    derivation_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (artifact_id <> parent_artifact_id),
    UNIQUE(artifact_id, parent_artifact_id, derivation_type)
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_derivations_parent
    ON artifact_derivations(parent_artifact_id, artifact_id);
  UPDATE meta SET value='5' WHERE key='schema_version';
`;

const MIGRATION_V6 = `
  CREATE TABLE IF NOT EXISTS resource_relations (
    id INTEGER PRIMARY KEY,
    from_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    to_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL CHECK (
      relation_type IN ('content_link', 'article', 'quoted_post')
    ),
    source_job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    observed_url TEXT NOT NULL,
    discovery_ordinal INTEGER NOT NULL CHECK (discovery_ordinal >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_job_id, relation_type, discovery_ordinal)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_relations_from
    ON resource_relations(from_resource_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_resource_relations_to
    ON resource_relations(to_resource_id, relation_type);

  CREATE TABLE observations_v6 (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    parent_resource_id INTEGER REFERENCES resources(id) ON DELETE CASCADE,
    source_job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    ingress TEXT NOT NULL,
    relation_type TEXT CHECK (
      relation_type IS NULL OR
      relation_type IN ('content_link', 'article', 'quoted_post')
    ),
    discovery_ordinal INTEGER CHECK (
      discovery_ordinal IS NULL OR discovery_ordinal >= 0
    ),
    observed_locator TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
    suppressed_reason TEXT,
    observed_at TEXT NOT NULL,
    CHECK (suppressed = 0 OR suppressed_reason IS NOT NULL),
    CHECK (
      (parent_resource_id IS NULL AND source_job_id IS NULL AND relation_type IS NULL AND discovery_ordinal IS NULL) OR
      (parent_resource_id IS NOT NULL AND source_job_id IS NOT NULL AND relation_type IS NOT NULL AND discovery_ordinal IS NOT NULL)
    )
  );
  INSERT INTO observations_v6(
    id, resource_id, source_id, run_id, ingress, observed_locator, suppressed,
    suppressed_reason, observed_at
  )
    SELECT id, resource_id, source_id, run_id, ingress, observed_locator,
           suppressed, suppressed_reason, observed_at
    FROM observations;
  DROP TABLE observations;
  ALTER TABLE observations_v6 RENAME TO observations;
  CREATE INDEX idx_observations_resource
    ON observations(resource_id, observed_at DESC);
  CREATE INDEX idx_observations_parent
    ON observations(parent_resource_id, discovery_ordinal);
  CREATE UNIQUE INDEX idx_observations_legacy_identity
    ON observations(run_id, resource_id, observed_locator)
    WHERE parent_resource_id IS NULL;
  CREATE UNIQUE INDEX idx_observations_fanout_identity
    ON observations(source_job_id, relation_type, discovery_ordinal)
    WHERE source_job_id IS NOT NULL;
  UPDATE meta SET value='6' WHERE key='schema_version';
`;

const MIGRATION_V7 = `
  ALTER TABLE documents ADD COLUMN revision_digest TEXT NOT NULL DEFAULT '';
  ALTER TABLE chunks ADD COLUMN structural_anchor TEXT NOT NULL DEFAULT '';
  ALTER TABLE chunks ADD COLUMN heading_path TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE chunks ADD COLUMN start_line INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE chunks ADD COLUMN end_line INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE chunks ADD COLUMN block_types TEXT NOT NULL DEFAULT '["text"]';
  ALTER TABLE chunks ADD COLUMN revision_digest TEXT NOT NULL DEFAULT '';
  ALTER TABLE chunks ADD COLUMN chunker_version TEXT NOT NULL DEFAULT 'legacy-v1';
  ALTER TABLE chunks ADD COLUMN chunk_digest TEXT NOT NULL DEFAULT '';
  ALTER TABLE chunks ADD COLUMN duplicate_ordinal INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chunks ADD COLUMN chunk_identity TEXT NOT NULL DEFAULT '';
  UPDATE documents SET revision_digest=content_hash WHERE revision_digest='';
  UPDATE chunks SET
    structural_anchor='legacy:' || chunk_index,
    revision_digest=(
      SELECT documents.content_hash FROM documents WHERE documents.id=chunks.document_id
    ),
    chunk_digest='legacy:' || id,
    duplicate_ordinal=chunk_index,
    chunk_identity='legacy:' || document_id || ':' || chunk_index
  WHERE chunk_identity='';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_identity
    ON chunks(document_id, chunk_identity);
  CREATE INDEX IF NOT EXISTS idx_chunks_digest
    ON chunks(document_id, chunk_digest, duplicate_ordinal);
  UPDATE meta SET value='7' WHERE key='schema_version';
`;

const MIGRATION_V8 = `
  CREATE TABLE operator_run_policies (
    run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK (mode IN ('offline', 'online')),
    authorization_digest TEXT NOT NULL CHECK (
      length(authorization_digest)=64 AND
      authorization_digest NOT GLOB '*[^0-9a-f]*'
    ),
    allowed_job_kinds TEXT NOT NULL CHECK (
      json_valid(allowed_job_kinds) AND json_type(allowed_job_kinds)='array'
    ),
    expected_job_count INTEGER NOT NULL CHECK (expected_job_count > 0),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_jobs_run_runnable
    ON jobs(run_id, kind, state, run_at, id);
  CREATE TABLE operator_run_execution_leases (
    run_id INTEGER PRIMARY KEY REFERENCES operator_run_policies(run_id) ON DELETE CASCADE,
    fencing_token TEXT NOT NULL UNIQUE,
    worker TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  );
  CREATE INDEX idx_operator_run_execution_leases_expiry
    ON operator_run_execution_leases(lease_expires_at, run_id);
  CREATE TRIGGER operator_run_policy_immutable_update
    BEFORE UPDATE ON operator_run_policies
    BEGIN
      SELECT RAISE(ABORT, 'operator-controlled Run policy is immutable');
    END;
  CREATE TRIGGER operator_run_policy_immutable_delete
    BEFORE DELETE ON operator_run_policies
    BEGIN
      SELECT RAISE(ABORT, 'operator-controlled Run policy is immutable');
    END;
  CREATE TRIGGER operator_run_jobs_frozen_insert
    BEFORE INSERT ON jobs
    WHEN NEW.run_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM operator_run_policies p WHERE p.run_id=NEW.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator-controlled Run jobs are immutable');
    END;
  CREATE TRIGGER operator_run_jobs_frozen_update
    BEFORE UPDATE OF run_id, kind, intent ON jobs
    WHEN (
      NEW.run_id IS NOT OLD.run_id OR
      NEW.kind IS NOT OLD.kind OR
      NEW.intent IS NOT OLD.intent
    ) AND (
      EXISTS (SELECT 1 FROM operator_run_policies p WHERE p.run_id=OLD.run_id) OR
      EXISTS (SELECT 1 FROM operator_run_policies p WHERE p.run_id=NEW.run_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator-controlled Run job binding is immutable');
    END;
  CREATE TRIGGER operator_run_jobs_frozen_delete
    BEFORE DELETE ON jobs
    WHEN EXISTS (
      SELECT 1 FROM operator_run_policies p WHERE p.run_id=OLD.run_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator-controlled Run jobs are immutable');
    END;
  UPDATE meta SET value='8' WHERE key='schema_version';
`;

const MIGRATION_V9 = `
  CREATE TABLE recovery_online_runs (
    run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
    offline_run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
    generation_id TEXT NOT NULL,
    generation_digest TEXT NOT NULL CHECK (
      length(generation_digest)=64 AND generation_digest NOT GLOB '*[^0-9a-f]*'
    ),
    manifest_digest TEXT NOT NULL CHECK (
      length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'
    ),
    approval_digest TEXT NOT NULL CHECK (
      length(approval_digest)=64 AND approval_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_database_digest TEXT NOT NULL CHECK (
      length(snapshot_database_digest)=64 AND snapshot_database_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_artifact_inventory_digest TEXT NOT NULL CHECK (
      length(snapshot_artifact_inventory_digest)=64 AND
      snapshot_artifact_inventory_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_artifact_count INTEGER NOT NULL CHECK (snapshot_artifact_count >= 0),
    snapshot_job_inventory_digest TEXT NOT NULL CHECK (
      length(snapshot_job_inventory_digest)=64 AND
      snapshot_job_inventory_digest NOT GLOB '*[^0-9a-f]*'
    ),
    snapshot_job_count INTEGER NOT NULL CHECK (snapshot_job_count >= 0),
    snapshot_max_job_id INTEGER NOT NULL CHECK (snapshot_max_job_id >= 0),
    snapshot_created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'preparing', 'ready', 'active', 'paused', 'completed',
      'completed_with_review'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE recovery_online_items (
    run_id INTEGER NOT NULL REFERENCES recovery_online_runs(run_id) ON DELETE RESTRICT,
    candidate_evidence_row_id TEXT NOT NULL CHECK (
      length(candidate_evidence_row_id)=16 AND
      candidate_evidence_row_id NOT GLOB '*[^0-9a-f]*'
    ),
    offline_job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
    outcome TEXT NOT NULL DEFAULT 'pending',
    failure_class TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_id INTEGER REFERENCES attempts(id) ON DELETE SET NULL,
    artifact_digest TEXT,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(run_id, candidate_evidence_row_id)
  );
  CREATE TRIGGER recovery_online_run_binding_immutable
    BEFORE UPDATE OF offline_run_id, generation_id, generation_digest,
      manifest_digest, approval_digest, snapshot_database_digest,
      snapshot_artifact_inventory_digest, snapshot_artifact_count,
      snapshot_job_inventory_digest, snapshot_job_count, snapshot_max_job_id,
      snapshot_created_at
    ON recovery_online_runs
    BEGIN
      SELECT RAISE(ABORT, 'controlled online backfill binding is immutable');
    END;
  CREATE TRIGGER recovery_online_run_delete_forbidden
    BEFORE DELETE ON recovery_online_runs
    BEGIN
      SELECT RAISE(ABORT, 'controlled online backfill binding is immutable');
    END;
  CREATE TRIGGER recovery_online_item_binding_immutable
    BEFORE UPDATE OF run_id, candidate_evidence_row_id, offline_job_id, job_id,
      resource_id ON recovery_online_items
    BEGIN
      SELECT RAISE(ABORT, 'controlled online backfill item binding is immutable');
    END;
  CREATE TRIGGER recovery_online_item_delete_forbidden
    BEFORE DELETE ON recovery_online_items
    BEGIN
      SELECT RAISE(ABORT, 'controlled online backfill item binding is immutable');
    END;
  UPDATE meta SET value='9' WHERE key='schema_version';
`;

const MIGRATION_V10 = `
  ALTER TABLE sources ADD COLUMN definition_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sources ADD COLUMN definition TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE sources ADD COLUMN definition_hash TEXT NOT NULL DEFAULT '';
  ALTER TABLE sources ADD COLUMN collections TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE sources ADD COLUMN limits TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE sources ADD COLUMN credential_refs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE sources ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sources ADD COLUMN pause_reason TEXT;
  ALTER TABLE sources ADD COLUMN health_state TEXT NOT NULL DEFAULT 'never';
  ALTER TABLE sources ADD COLUMN health_detail TEXT;
  ALTER TABLE sources ADD COLUMN last_evaluated_at TEXT;
  ALTER TABLE sources ADD COLUMN last_success_at TEXT;
  ALTER TABLE sources ADD COLUMN next_due_at TEXT;

  ALTER TABLE runs ADD COLUMN attempted_cursor TEXT;
  ALTER TABLE runs ADD COLUMN committed_checkpoint TEXT;
  ALTER TABLE runs ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE runs ADD COLUMN discovered_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN admitted_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN suppressed_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN terminal_outcome TEXT;
  ALTER TABLE runs ADD COLUMN source_definition_version INTEGER;
  ALTER TABLE runs ADD COLUMN schedule_key TEXT;
  ALTER TABLE runs ADD COLUMN scheduled_for TEXT;

  CREATE UNIQUE INDEX idx_sources_stable_id ON sources(identifier);
  CREATE UNIQUE INDEX idx_source_runs_schedule
    ON runs(source_id, schedule_key)
    WHERE run_type='source_sync' AND schedule_key IS NOT NULL;
  CREATE UNIQUE INDEX idx_source_runs_active
    ON runs(source_id)
    WHERE run_type='source_sync' AND state IN ('pending', 'active');

  CREATE TABLE source_definition_versions (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
    definition_hash TEXT NOT NULL,
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    created_at TEXT NOT NULL,
    UNIQUE(source_id, definition_version),
    UNIQUE(source_id, definition_hash)
  );

  CREATE TABLE source_audit_events (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN ('config_applied', 'paused', 'resumed')),
    actor TEXT NOT NULL,
    reason TEXT,
    definition_version INTEGER NOT NULL,
    definition_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_source_audit_events_source
    ON source_audit_events(source_id, id);

  CREATE TABLE source_checkpoints (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
    definition_version INTEGER NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    committed_at TEXT NOT NULL
  );
  CREATE INDEX idx_source_checkpoints_source
    ON source_checkpoints(source_id, id);

  UPDATE meta SET value='10' WHERE key='schema_version';
`;

// Provider-neutral evidence for recurring source Observations. The base
// observations table remains shared with URL fanout; this companion keeps a
// source's stable entry identity and normalized change fingerprint without
// persisting a Agentscrape/provider response schema.
const MIGRATION_V11 = `
  DROP INDEX idx_observations_legacy_identity;
  CREATE UNIQUE INDEX idx_observations_legacy_identity
    ON observations(run_id, resource_id, observed_locator)
    WHERE parent_resource_id IS NULL AND ingress <> 'source_sync';

  CREATE TABLE source_observation_details (
    observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
    observation_key TEXT NOT NULL,
    stable_id TEXT NOT NULL,
    observed_version TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
    admission_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, observation_key)
  );
  CREATE INDEX idx_source_observations_stable
    ON source_observation_details(source_id, stable_id, run_id DESC);
  CREATE INDEX idx_source_observations_job
    ON source_observation_details(admission_job_id);
  UPDATE meta SET value='11' WHERE key='schema_version';
`;

// Parser-derived content form is separate from URL/source identity. Existing
// provenance can identify Articles exactly; post/thread classification remains
// null until a parser reports its item count.
const MIGRATION_V12 = `
  ALTER TABLE documents ADD COLUMN content_kind TEXT
    CHECK (content_kind IS NULL OR content_kind IN ('post', 'thread', 'article'));
  ALTER TABLE documents ADD COLUMN content_item_count INTEGER
    CHECK (content_item_count IS NULL OR content_item_count >= 1);
  CREATE INDEX idx_documents_content_kind
    ON documents(content_kind, updated_at DESC);
  CREATE TRIGGER documents_content_classification_insert
    BEFORE INSERT ON documents
    WHEN CASE
      WHEN NEW.content_kind IS NULL AND NEW.content_item_count IS NULL THEN 0
      WHEN NEW.content_kind IN ('post', 'article') AND NEW.content_item_count=1 THEN 0
      WHEN NEW.content_kind='thread' AND NEW.content_item_count BETWEEN 2 AND 10000 THEN 0
      ELSE 1
    END=1
    BEGIN
      SELECT RAISE(ABORT, 'invalid document content classification');
    END;
  CREATE TRIGGER documents_content_classification_update
    BEFORE UPDATE OF content_kind, content_item_count ON documents
    WHEN CASE
      WHEN NEW.content_kind IS NULL AND NEW.content_item_count IS NULL THEN 0
      WHEN NEW.content_kind IN ('post', 'article') AND NEW.content_item_count=1 THEN 0
      WHEN NEW.content_kind='thread' AND NEW.content_item_count BETWEEN 2 AND 10000 THEN 0
      ELSE 1
    END=1
    BEGIN
      SELECT RAISE(ABORT, 'invalid document content classification');
    END;
  UPDATE documents
  SET content_kind='article', content_item_count=1
  WHERE EXISTS (
    SELECT 1
    FROM resources r
    JOIN provenance p ON p.resource_id=r.id
    WHERE r.document_id=documents.id
      AND p.evidence_type='url_extraction'
      AND json_valid(p.raw_metadata)
      AND (
        json_extract(p.raw_metadata, '$.extractor.implementation')='x-article'
        OR json_extract(p.raw_metadata, '$.metadata.content_type')='article'
      )
  );
  UPDATE meta SET value='12' WHERE key='schema_version';
`;

const CONTENT_KINDS = new Set<ContentKind>(["post", "thread", "article"]);

function normalizeContentClassification(
  kind: ContentKind | null | undefined,
  itemCount: number | null | undefined,
): { kind: ContentKind | null; itemCount: number | null } | undefined {
  if (kind === undefined && itemCount === undefined) return undefined;
  if (kind === undefined || itemCount === undefined) {
    throw new Error(
      "content_kind and content_item_count must be provided together",
    );
  }
  if (kind === null || itemCount === null) {
    if (kind !== null || itemCount !== null) {
      throw new Error("content_kind and content_item_count must both be null");
    }
    return { kind: null, itemCount: null };
  }
  const normalized = String(kind).trim().toLowerCase() as ContentKind;
  if (!CONTENT_KINDS.has(normalized)) {
    throw new Error("content_kind must be post, thread, or article");
  }
  if (!Number.isSafeInteger(itemCount) || itemCount < 1 || itemCount > 10_000) {
    throw new Error(
      "content_item_count must be an integer between 1 and 10000",
    );
  }
  if ((normalized === "post" || normalized === "article") && itemCount !== 1) {
    throw new Error(`${normalized} content_item_count must be 1`);
  }
  if (normalized === "thread" && itemCount < 2) {
    throw new Error("thread content_item_count must be at least 2");
  }
  return { kind: normalized, itemCount };
}

const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[ -~]+)?$/;
const JOB_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const RECOVERY_OFFLINE_SCOPE_KIND = "recovery_offline";
export const RECOVERY_ONLINE_SCOPE_KIND = "recovery_online";
const RECOVERY_JOB_IDEMPOTENCY_GLOB = "legacy-recovery-candidate:v1:*";
const RECOVERY_ONLINE_JOB_IDEMPOTENCY_GLOB =
  "legacy-recovery-candidate:v1:online:*";
const CONTROLLED_JOB_KINDS = new Set([
  "text",
  "file",
  "directory",
  "url",
  RECOVERY_OFFLINE_SCOPE_KIND,
  RECOVERY_ONLINE_SCOPE_KIND,
]);

interface PersistedOperatorRunPolicy {
  run_id: number;
  mode: OperatorRunMode;
  authorization_digest: string;
  allowed_job_kinds: string;
  expected_job_count: number;
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  normal: 1,
  sensitive: 2,
  private: 3,
};

export interface RegisterArtifactInput {
  contentDigest: string;
  mediaType: string;
  byteSize: number;
  artifactRole: string;
  sensitivity?: Sensitivity;
  storagePath: string;
  resourceId?: number;
  observedAt?: Date;
  derivedFromArtifactId?: number;
  derivationType?: string;
  jobId?: number;
  sourceId?: number;
  provenance?: {
    evidenceType: string;
    ingress?: string | null;
    runId?: number | null;
    rawMetadata?: unknown;
  };
}

export interface RegisteredArtifactResult {
  artifact: Artifact;
  resourceReferenceCreated: boolean;
  derivationCreated: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

const JOB_COLUMNS = `id, idempotency_key, kind, intent, resource_id, source_id,
  run_id, state, sensitivity, attempt_count, item_retry_count,
  current_attempt_id, run_at, block_reason, failure_class, failure_summary,
  created_at, updated_at`;

const ATTEMPT_COLUMNS = `id, job_id, attempt_number, worker, state,
  lease_expires_at, heartbeat_at, failure_class, failure_summary, started_at,
  finished_at`;

function backoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitterRatio: number,
  random: () => number,
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * jitterRatio * random();
  return Math.round(exponential + jitter);
}

function isoAfter(now: Date, deltaMs: number): string {
  return new Date(now.getTime() + deltaMs).toISOString();
}

function isExpired(leaseExpiresAt: string, now: Date): boolean {
  return Date.parse(leaseExpiresAt) <= now.getTime();
}

function pythonStyleTagJson(tags: string[]): string {
  return `[${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
}

function titleFromSource(source: string): string {
  if (source.length === 0) return "Untitled";
  try {
    const url = new URL(source);
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return decodeURIComponent(last ?? url.hostname) || url.hostname;
  } catch {
    return source.split(/[\\/]/).at(-1) || source.slice(0, 80);
  }
}

function limitCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function normalizedAllowedKinds(value: readonly string[]): string[] {
  if (value.length === 0 || value.length > CONTROLLED_JOB_KINDS.size) {
    throw new CliError(
      "bad_run_scope",
      "operator-controlled Run scope requires one or more allowed job kinds",
      { exitCode: 2 },
    );
  }
  const normalized = value.map((kind) => String(kind).trim().toLowerCase());
  if (
    normalized.some(
      (kind) => !JOB_KIND_PATTERN.test(kind) || !CONTROLLED_JOB_KINDS.has(kind),
    )
  ) {
    throw new CliError(
      "bad_run_scope",
      "operator-controlled Run scope contains an unsupported job kind",
      { exitCode: 2 },
    );
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new CliError(
      "bad_run_scope",
      "operator-controlled Run scope contains a duplicate allowed job kind",
      { exitCode: 2 },
    );
  }
  return normalized.sort();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function controlledScopeJobPredicate(
  policy: Pick<OperatorRunPolicy, "allowedKinds">,
  alias = "",
): { sql: string; parameters: string[] } {
  const column = (name: string): string => (alias ? `${alias}.${name}` : name);
  if (sameStrings(policy.allowedKinds, [RECOVERY_OFFLINE_SCOPE_KIND])) {
    return {
      sql: `${column("kind")}='file' AND ${column("idempotency_key")} GLOB ?`,
      parameters: [RECOVERY_JOB_IDEMPOTENCY_GLOB],
    };
  }
  if (sameStrings(policy.allowedKinds, [RECOVERY_ONLINE_SCOPE_KIND])) {
    return {
      sql: `${column("kind")}='url' AND ${column("idempotency_key")} GLOB ?`,
      parameters: [RECOVERY_ONLINE_JOB_IDEMPOTENCY_GLOB],
    };
  }
  const placeholders = policy.allowedKinds.map(() => "?").join(", ");
  return {
    sql: `${column("kind")} IN (${placeholders})`,
    parameters: [...policy.allowedKinds],
  };
}

function validatedAuthorizationDigest(value: string): string {
  const digest = String(value || "").trim();
  if (!SHA256_DIGEST_PATTERN.test(digest)) {
    throw new CliError(
      "bad_run_scope",
      "operator-controlled Run scope requires a lowercase SHA-256 authorization digest",
      { exitCode: 2 },
    );
  }
  return digest;
}

function policyFromRow(row: PersistedOperatorRunPolicy): OperatorRunPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.allowed_job_kinds);
  } catch {
    throw new CliError(
      "invalid_run_policy",
      `operator-controlled Run ${row.run_id} has an invalid allowed-kind policy`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((kind) => typeof kind !== "string")
  ) {
    throw new CliError(
      "invalid_run_policy",
      `operator-controlled Run ${row.run_id} has an invalid allowed-kind policy`,
    );
  }
  const allowedKinds = normalizedAllowedKinds(parsed);
  if (!sameStrings(parsed, allowedKinds)) {
    throw new CliError(
      "invalid_run_policy",
      `operator-controlled Run ${row.run_id} has a non-canonical allowed-kind policy`,
    );
  }
  return {
    runId: row.run_id,
    mode: row.mode,
    authorizationDigest: validatedAuthorizationDigest(row.authorization_digest),
    allowedKinds,
    expectedJobCount: row.expected_job_count,
  };
}

/** Writable schema-v2 store. Read commands deliberately use ResearchCache instead. */
export class ResearchStore {
  readonly dbPath: string;
  readonly db: Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const directory = dirname(dbPath);
    const isDefault = isDefaultDatabasePath(dbPath);
    if (isDefault) assertDefaultDatabaseTargetSafe(dbPath);
    mkdirSync(directory, {
      recursive: true,
      ...(isDefault ? { mode: 0o700 } : {}),
    });
    if (isDefault) chmodSync(directory, 0o700);
    this.db = new Database(dbPath, { create: true, strict: true });
    if (isDefault) chmodSync(dbPath, 0o600);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    try {
      this.rejectUnsupportedExistingSchema();
      try {
        const journal = this.db.query("PRAGMA journal_mode").get() as {
          journal_mode: string;
        };
        if (journal.journal_mode.toLowerCase() !== "wal") {
          this.db.exec("PRAGMA journal_mode=WAL;");
        }
      } catch {
        // WAL may be unavailable on unusual filesystems; transactions still work.
      }
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Create a transactionally consistent, standalone SQLite image. VACUUM INTO
   * takes its own read snapshot, so committed WAL state is included while
   * concurrent readers and the Index owner's later writes may continue.
   * The caller must provide a new path and is responsible for atomic
   * publication of the completed image.
   */
  createConsistentSnapshot(destinationPath: string): void {
    this.db.query("VACUUM main INTO ?").run(destinationPath);
  }

  upsertDocument(input: UpsertDocumentInput): UpsertDocumentResult {
    const sourceType = (input.sourceType || "unknown").trim().toLowerCase();
    const sourceUri = String(input.sourceUri || "").trim();
    if (sourceUri.length === 0) throw new Error("source_uri is required");
    const markdown = isMarkdownContent({
      sourceType,
      sourceUri,
      mediaType: input.mediaType,
      content: input.content,
    });
    const content = markdown
      ? cleanMarkdown(input.content)
      : cleanText(input.content);
    if (content.length === 0) throw new Error("no extractable text content");
    const tags = normalizeTags(input.tags);
    const tagsJson = pythonStyleTagJson(tags);
    const hash = sha256Text(content);
    const revisionDigest = input.revisionDigest?.trim().toLowerCase() || hash;
    if (!SHA256_DIGEST_PATTERN.test(revisionDigest)) {
      throw new Error("revision_digest must be a lowercase SHA-256 digest");
    }
    const chunkerVersion = markdown
      ? MARKDOWN_CHUNKER_VERSION
      : TEXT_CHUNKER_VERSION;
    const sizeChars = codePointLength(content);
    const title = limitCodePoints(
      (input.title || titleFromSource(sourceUri) || "Untitled").trim(),
      500,
    );
    const notes = input.notes ?? "";
    const providedClassification = normalizeContentClassification(
      input.contentKind,
      input.contentItemCount,
    );

    const transaction = this.db.transaction((): UpsertDocumentResult => {
      const existing = this.db
        .query(
          `SELECT id, title, tags, notes, content_hash, revision_digest,
                  content_kind, content_item_count,
                  (SELECT COUNT(*) FROM chunks c WHERE c.document_id=documents.id) AS chunk_count,
                  (SELECT COUNT(*) FROM chunks c
                   WHERE c.document_id=documents.id AND c.chunker_version=?) AS generation_count
           FROM documents WHERE source_type=? AND source_uri=?`,
        )
        .get(chunkerVersion, sourceType, sourceUri) as {
        id: number;
        title: string | null;
        tags: string;
        notes: string | null;
        content_hash: string;
        revision_digest: string;
        content_kind: ContentKind | null;
        content_item_count: number | null;
        chunk_count: number;
        generation_count: number;
      } | null;
      const inheritedClassification = normalizeContentClassification(
        existing?.content_kind ?? null,
        existing?.content_item_count ?? null,
      );
      if (inheritedClassification === undefined) {
        throw new Error("stored content classification is incomplete");
      }
      const classification = providedClassification ?? inheritedClassification;

      if (
        existing !== null &&
        existing.content_hash === hash &&
        existing.revision_digest === revisionDigest &&
        existing.chunk_count > 0 &&
        existing.generation_count === existing.chunk_count &&
        existing.title === title &&
        existing.tags === tagsJson &&
        (existing.notes ?? "") === notes &&
        existing.content_kind === classification.kind &&
        existing.content_item_count === classification.itemCount &&
        !input.force
      ) {
        return {
          success: true,
          status: "unchanged",
          document_id: existing.id,
          title,
          source_uri: sourceUri,
          content_kind: classification.kind,
          content_item_count: classification.itemCount,
          size_chars: sizeChars,
          tags,
        };
      }

      const timestamp = nowIso();
      let documentId: number;
      let status: "created" | "updated";
      if (existing !== null) {
        documentId = existing.id;
        status = "updated";
        this.db
          .query(
            "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=?)",
          )
          .run(documentId);
        this.db.query("DELETE FROM chunks WHERE document_id=?").run(documentId);
        this.db
          .query(
            `UPDATE documents
             SET title=?, tags=?, notes=?, content=?, content_hash=?, revision_digest=?,
                 content_kind=?, content_item_count=?, size_chars=?, updated_at=?
             WHERE id=?`,
          )
          .run(
            title,
            tagsJson,
            notes,
            content,
            hash,
            revisionDigest,
            classification.kind,
            classification.itemCount,
            sizeChars,
            timestamp,
            documentId,
          );
      } else {
        status = "created";
        const inserted = this.db
          .query(
            `INSERT INTO documents(
               source_type, source_uri, title, tags, notes, content, content_hash,
               revision_digest, content_kind, content_item_count, size_chars,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceType,
            sourceUri,
            title,
            tagsJson,
            notes,
            content,
            hash,
            revisionDigest,
            classification.kind,
            classification.itemCount,
            sizeChars,
            timestamp,
            timestamp,
          );
        documentId = Number(inserted.lastInsertRowid);
      }

      const chunks = markdown
        ? chunkMarkdown(content, undefined, revisionDigest)
        : chunkText(content, undefined, undefined, revisionDigest);
      for (const [index, chunk] of chunks.entries()) {
        const inserted = this.db
          .query(
            `INSERT INTO chunks(
               document_id, chunk_index, start_char, end_char, content,
               structural_anchor, heading_path, start_line, end_line, block_types,
               revision_digest, chunker_version, chunk_digest, duplicate_ordinal,
               chunk_identity
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            documentId,
            index,
            chunk.start,
            chunk.end,
            chunk.content,
            chunk.structuralAnchor,
            JSON.stringify(chunk.headingPath),
            chunk.startLine,
            chunk.endLine,
            JSON.stringify(chunk.blockTypes),
            revisionDigest,
            chunk.chunkerVersion,
            chunk.chunkDigest,
            chunk.duplicateOrdinal,
            chunk.chunkIdentity,
          );
        const chunkId = Number(inserted.lastInsertRowid);
        this.db
          .query(
            `INSERT INTO chunks_fts(
               rowid, document_id, chunk_id, title, content, tags, source_uri
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunkId,
            documentId,
            chunkId,
            title,
            chunk.content,
            tags.join(" "),
            sourceUri,
          );
      }

      return {
        success: true,
        status,
        document_id: documentId,
        title,
        source_uri: sourceUri,
        source_type: sourceType,
        content_kind: classification.kind,
        content_item_count: classification.itemCount,
        size_chars: sizeChars,
        chunk_count: chunks.length,
        tags,
      };
    });
    return transaction.immediate();
  }

  upsertDocumentLink(input: {
    fromDocumentId: number;
    discoveredUrl: string;
    relationType?: string;
    toDocumentId?: number | null;
    resolvedUrl?: string | null;
    status?: "success" | "failed";
    error?: string | null;
  }): DocumentLinkResult {
    const parentId = Number(input.fromDocumentId);
    const targetId =
      input.toDocumentId === null || input.toDocumentId === undefined
        ? null
        : Number(input.toDocumentId);
    const discoveredUrl = String(input.discoveredUrl || "").trim();
    const relationType = (input.relationType || "content_link")
      .trim()
      .toLowerCase();
    const resolvedUrl = String(input.resolvedUrl || "").trim() || null;
    const status = input.status ?? (targetId === null ? "failed" : "success");
    let error = String(input.error || "").trim() || null;
    if (discoveredUrl.length === 0)
      throw new Error("discovered_url is required");
    if (relationType.length === 0) throw new Error("relation_type is required");
    if (status !== "success" && status !== "failed") {
      throw new Error("document link status must be 'success' or 'failed'");
    }
    if (status === "success" && targetId === null) {
      throw new Error("a successful document link requires to_document_id");
    }
    if (status === "failed" && targetId !== null) {
      throw new Error("a failed document link cannot have to_document_id");
    }
    if (status === "success") error = null;
    const timestamp = nowIso();

    const transaction = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO document_links(
             from_document_id, to_document_id, relation_type, discovered_url,
             resolved_url, status, error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(from_document_id, relation_type, discovered_url) DO UPDATE SET
             to_document_id=excluded.to_document_id,
             resolved_url=excluded.resolved_url,
             status=excluded.status,
             error=excluded.error,
             updated_at=excluded.updated_at`,
        )
        .run(
          parentId,
          targetId,
          relationType,
          discoveredUrl,
          resolvedUrl,
          status,
          error,
          timestamp,
          timestamp,
        );
      return this.db
        .query(
          `SELECT * FROM document_links
           WHERE from_document_id=? AND relation_type=? AND discovered_url=?`,
        )
        .get(parentId, relationType, discoveredUrl) as Omit<
        DocumentLinkResult,
        "success"
      >;
    });
    return { success: true, ...transaction.immediate() };
  }

  commitUrlFanout(input: CommitUrlFanoutInput): CommitUrlFanoutResult {
    const timestamp = (input.observedAt ?? new Date()).toISOString();
    const transaction = this.db.transaction((): CommitUrlFanoutResult => {
      const parent = this.db
        .query("SELECT id FROM resources WHERE id=?")
        .get(input.parentResourceId);
      if (parent === null) {
        throw new CliError(
          "resource_not_found",
          `parent Resource ${input.parentResourceId} not found`,
        );
      }
      const parentJob = this.db
        .query("SELECT id, run_id FROM jobs WHERE id=?")
        .get(input.parentJobId) as { id: number; run_id: number | null } | null;
      if (parentJob === null) {
        throw new CliError(
          "job_not_found",
          `parent job ${input.parentJobId} not found`,
        );
      }
      if (parentJob.run_id !== (input.runId ?? null)) {
        throw new CliError(
          "fanout_run_mismatch",
          "URL fanout Run binding does not match its parent ingestion job",
        );
      }
      const operatorControlled = this.runIsOperatorControlled(parentJob.run_id);

      let admitted = 0;
      let suppressed = 0;
      const relations: ResourceRelation[] = [];
      for (const discovery of input.discoveries) {
        this.db
          .query(
            `INSERT INTO resources(
               key_type, key_value, kind, sensitivity, created_at, updated_at
             ) VALUES (?, ?, 'url', ?, ?, ?)
             ON CONFLICT(key_type, key_value) DO UPDATE SET
               sensitivity=CASE
                 WHEN (SELECT rank FROM sensitivity_levels WHERE level=excluded.sensitivity) >
                      (SELECT rank FROM sensitivity_levels WHERE level=resources.sensitivity)
                 THEN excluded.sensitivity ELSE resources.sensitivity END,
               updated_at=excluded.updated_at`,
          )
          .run(
            discovery.resourceKey.type,
            discovery.resourceKey.value,
            input.sensitivity,
            timestamp,
            timestamp,
          );
        const target = this.db
          .query("SELECT id FROM resources WHERE key_type=? AND key_value=?")
          .get(discovery.resourceKey.type, discovery.resourceKey.value) as {
          id: number;
        };
        this.db
          .query(
            `INSERT INTO resource_aliases(
               resource_id, alias_type, locator, evidence,
               first_observed_at, last_observed_at
             ) VALUES (?, 'extractor_target_url', ?, 'extraction_relation', ?, ?)
             ON CONFLICT(resource_id, alias_type, locator) DO UPDATE SET
               last_observed_at=excluded.last_observed_at`,
          )
          .run(target.id, discovery.targetUrl, timestamp, timestamp);

        const existingObservation = this.db
          .query(
            `SELECT id FROM observations
             WHERE source_job_id=? AND relation_type=? AND discovery_ordinal=?`,
          )
          .get(
            input.parentJobId,
            discovery.relationType,
            discovery.ordinal,
          ) as { id: number } | null;
        const suppressionReason =
          discovery.suppressionReason ??
          (operatorControlled ? "operator_controlled_run" : null);
        const isSuppressed = suppressionReason !== null;
        if (existingObservation === null) {
          this.db
            .query(
              `INSERT INTO observations(
                 resource_id, parent_resource_id, source_job_id, source_id, run_id,
                 ingress, relation_type, discovery_ordinal, observed_locator,
                 suppressed, suppressed_reason, observed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              target.id,
              input.parentResourceId,
              input.parentJobId,
              input.sourceId ?? null,
              input.runId ?? null,
              input.ingress,
              discovery.relationType,
              discovery.ordinal,
              discovery.targetUrl,
              isSuppressed ? 1 : 0,
              suppressionReason,
              timestamp,
            );
        } else {
          this.db
            .query(
              `UPDATE observations SET
                 resource_id=?, source_id=?, run_id=?, ingress=?,
                 observed_locator=?, suppressed=?, suppressed_reason=?, observed_at=?
               WHERE id=?`,
            )
            .run(
              target.id,
              input.sourceId ?? null,
              input.runId ?? null,
              input.ingress,
              discovery.targetUrl,
              isSuppressed ? 1 : 0,
              suppressionReason,
              timestamp,
              existingObservation.id,
            );
        }

        if (isSuppressed) {
          suppressed += 1;
          continue;
        }
        admitted += 1;
        this.db
          .query(
            `INSERT INTO resource_relations(
               from_resource_id, to_resource_id, relation_type, source_job_id,
               observed_url, discovery_ordinal, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_job_id, relation_type, discovery_ordinal)
             DO UPDATE SET
               to_resource_id=excluded.to_resource_id,
               source_job_id=excluded.source_job_id,
               observed_url=excluded.observed_url,
               updated_at=excluded.updated_at`,
          )
          .run(
            input.parentResourceId,
            target.id,
            discovery.relationType,
            input.parentJobId,
            discovery.targetUrl,
            discovery.ordinal,
            timestamp,
            timestamp,
          );
        relations.push(
          this.db
            .query(
              `SELECT * FROM resource_relations
               WHERE source_job_id=? AND relation_type=? AND discovery_ordinal=?`,
            )
            .get(
              input.parentJobId,
              discovery.relationType,
              discovery.ordinal,
            ) as ResourceRelation,
        );

        let child = this.db
          .query(
            `SELECT id FROM jobs
             WHERE resource_id=? AND kind='url'
               AND state IN ('queued', 'running', 'retry_wait', 'completed')
             ORDER BY CASE state WHEN 'completed' THEN 0 ELSE 1 END, id
             LIMIT 1`,
          )
          .get(target.id) as { id: number } | null;
        if (child === null) {
          const existingJob = this.db
            .query(
              "SELECT id, intent, resource_id FROM jobs WHERE idempotency_key=?",
            )
            .get(discovery.childIdempotencyKey) as {
            id: number;
            intent: string | null;
            resource_id: number | null;
          } | null;
          if (
            existingJob !== null &&
            (existingJob.intent !== discovery.childIntent ||
              (existingJob.resource_id !== null &&
                existingJob.resource_id !== target.id))
          ) {
            throw new CliError(
              "idempotency_conflict",
              "fanout child identity conflicts with existing durable intent",
            );
          }
          child = this.enqueueJob({
            idempotencyKey: discovery.childIdempotencyKey,
            kind: "url",
            intent: discovery.childIntent,
            sensitivity: input.sensitivity,
            resourceId: target.id,
            now: new Date(timestamp),
          }).job;
        }
        this.db
          .query(
            `UPDATE jobs SET
               resource_id=?,
               sensitivity=CASE
                 WHEN (SELECT rank FROM sensitivity_levels WHERE level=?) >
                      (SELECT rank FROM sensitivity_levels WHERE level=jobs.sensitivity)
                 THEN ? ELSE jobs.sensitivity END,
               updated_at=?
             WHERE id=?`,
          )
          .run(
            target.id,
            input.sensitivity,
            input.sensitivity,
            timestamp,
            child.id,
          );
        this.db
          .query(
            `UPDATE artifacts SET sensitivity=?
             WHERE id IN (
               SELECT artifact_id FROM resource_artifacts WHERE resource_id=?
             ) AND (SELECT rank FROM sensitivity_levels WHERE level=?) >
                   (SELECT rank FROM sensitivity_levels WHERE level=artifacts.sensitivity)`,
          )
          .run(input.sensitivity, target.id, input.sensitivity);
      }
      return { admitted, suppressed, relations };
    });
    return transaction.immediate();
  }

  deleteDocument(input: {
    documentId?: number;
    sourceUri?: string;
    confirm: string;
    /** Supplied when unreferenced Artifact bytes should be reclaimed too. */
    artifactStore?: ArtifactStore;
  }): {
    success: true;
    deleted_document_id: number;
    title: string | null;
    source_uri: string;
    purged_resources: number;
    redacted_jobs: number;
    removed_artifacts: string[];
  } {
    if (input.confirm !== "delete") {
      throw new Error("set --confirm delete to delete from the research cache");
    }
    const selectorCount =
      Number(input.documentId !== undefined) +
      Number(input.sourceUri !== undefined);
    if (selectorCount !== 1) {
      throw new Error("provide exactly one of document_id or source_uri");
    }
    const transaction = this.db.transaction(() => {
      const row = (
        input.documentId !== undefined
          ? this.db
              .query("SELECT id, title, source_uri FROM documents WHERE id=?")
              .get(input.documentId)
          : this.db
              .query(
                `SELECT id, title, source_uri FROM documents
               WHERE source_uri=? ORDER BY updated_at DESC, id DESC LIMIT 1`,
              )
              .get(input.sourceUri as string)
      ) as {
        id: number;
        title: string | null;
        source_uri: string;
      } | null;
      if (row === null) throw new CliError("not_found", "document not found");
      // Everything the ingestion created goes, not just what answers searches.
      // Resource identity is captured before the document is removed, because
      // dropping the document sets resources.document_id to null and the
      // Resources would otherwise become unreachable from here (ADR 0018).
      const resourceIds = this.hasResourcesTable()
        ? (
            this.db
              .query("SELECT id FROM resources WHERE document_id=?")
              .all(row.id) as Array<{ id: number }>
          ).map((resource) => resource.id)
        : [];
      const placeholders = resourceIds.map(() => "?").join(",");
      const jobIds =
        resourceIds.length === 0
          ? []
          : (
              this.db
                .query(
                  `SELECT id FROM jobs WHERE resource_id IN (${placeholders})`,
                )
                .all(...resourceIds) as Array<{ id: number }>
            ).map((job) => job.id);
      const candidateArtifacts =
        resourceIds.length === 0
          ? []
          : (
              this.db
                .query(
                  `SELECT DISTINCT artifact_id FROM resource_artifacts
                   WHERE resource_id IN (${placeholders})`,
                )
                .all(...resourceIds) as Array<{ artifact_id: number }>
            ).map((link) => link.artifact_id);

      this.db
        .query(
          "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=?)",
        )
        .run(row.id);
      this.db.query("DELETE FROM documents WHERE id=?").run(row.id);

      for (const jobId of jobIds) this.redactJobIntent(jobId);
      if (resourceIds.length > 0) {
        this.db
          .query(`DELETE FROM resources WHERE id IN (${placeholders})`)
          .run(...resourceIds);
      }

      // The Resource cascade removed the registrations; an Artifact is only
      // unreferenced once no other Resource holds it and nothing derives from
      // it, so shared content-addressed bytes survive this deletion.
      const orphanedDigests: string[] = [];
      for (const artifactId of candidateArtifacts) {
        const referenced = this.db
          .query("SELECT 1 FROM resource_artifacts WHERE artifact_id=? LIMIT 1")
          .get(artifactId);
        if (referenced !== null) continue;
        const derived = this.db
          .query(
            "SELECT 1 FROM artifact_derivations WHERE parent_artifact_id=? LIMIT 1",
          )
          .get(artifactId);
        if (derived !== null) continue;
        const artifact = this.db
          .query("SELECT content_hash FROM artifacts WHERE id=?")
          .get(artifactId) as { content_hash: string } | null;
        if (artifact === null) continue;
        this.db.query("DELETE FROM artifacts WHERE id=?").run(artifactId);
        const stillRegistered = this.db
          .query("SELECT 1 FROM artifacts WHERE content_hash=? LIMIT 1")
          .get(artifact.content_hash);
        if (stillRegistered === null)
          orphanedDigests.push(artifact.content_hash);
      }

      return {
        success: true as const,
        deleted_document_id: row.id,
        title: row.title,
        source_uri: row.source_uri,
        purged_resources: resourceIds.length,
        redacted_jobs: jobIds.length,
        orphaned_digests: orphanedDigests,
      };
    });
    const result = transaction.immediate();

    // SQLite has committed, so these bytes are provably unreferenced. An
    // interruption here leaves orphans that reconciliation collects, which is
    // the recoverable direction of the two-store problem (ADR 0008).
    const removed: string[] = [];
    if (input.artifactStore !== undefined) {
      for (const digest of result.orphaned_digests) {
        if (input.artifactStore.removeObject(digest)) removed.push(digest);
      }
    }
    const { orphaned_digests, ...rest } = result;
    return { ...rest, removed_artifacts: removed };
  }

  /**
   * Strips the content-bearing parts of a job's immutable intent, keeping the
   * row and its lifecycle. Per ADR 0018 the record that an ingestion happened
   * is history worth keeping; the address of what was ingested is content, and
   * an operator who deleted the content asked for that to be gone too. The
   * idempotency key and intent hash stay: they are one-way digests.
   */
  private redactJobIntent(jobId: number): void {
    const job = this.db
      .query("SELECT intent FROM jobs WHERE id=?")
      .get(jobId) as { intent: string } | null;
    if (job === null) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(job.intent) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    if (parsed.redacted === true) return;
    const options = { ...((parsed.options as Record<string, unknown>) ?? {}) };
    options.title = undefined;
    const redacted = {
      version: parsed.version ?? 1,
      kind: parsed.kind ?? null,
      ingress: parsed.ingress ?? null,
      collections: [],
      payload: {},
      options: JSON.parse(JSON.stringify(options)),
      redacted: true,
    };
    this.db
      .query("UPDATE jobs SET intent=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(redacted), new Date().toISOString(), jobId);
  }

  private hasResourcesTable(): boolean {
    return (
      this.db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='resources' LIMIT 1",
        )
        .get() !== null
    );
  }

  private collectionSlugsForDocument(documentId: number): string[] {
    if (!this.hasResourcesTable()) return [];
    return (
      this.db
        .query(
          `SELECT col.slug AS slug
           FROM resources r
           JOIN collection_memberships cm ON cm.resource_id = r.id
           JOIN collections col ON col.id = cm.collection_id
           WHERE r.document_id = ?
           ORDER BY col.slug ASC`,
        )
        .all(documentId) as { slug: string }[]
    ).map((row) => row.slug);
  }

  /**
   * Re-derive and write one document's structural tags, keeping
   * `documents.tags` and the denormalized `chunks_fts.tags` in sync without
   * re-chunking. `chunks_fts` is a regular fts5 table, so a partial-column
   * UPDATE is unsafe here — every chunk's FTS row is deleted and reinserted
   * with all indexed columns, mirroring deleteDocument's targeted idiom.
   * A no-op when the derived tag JSON is unchanged, which is what makes
   * repeated retag runs byte-identical.
   */
  retagDocument(documentId: number): RetagDocumentResult {
    const transaction = this.db.transaction((): RetagDocumentResult => {
      const doc = this.db
        .query(
          "SELECT id, source_type, source_uri, title, tags FROM documents WHERE id=?",
        )
        .get(documentId) as {
        id: number;
        source_type: string;
        source_uri: string;
        title: string | null;
        tags: string;
      } | null;
      if (doc === null) throw new CliError("not_found", "document not found");

      const tags = deriveStructuralTags({
        existingTags: parseTags(doc.tags),
        sourceType: doc.source_type,
        sourceUri: doc.source_uri,
        collectionSlugs: this.collectionSlugsForDocument(documentId),
      });
      const tagsJson = pythonStyleTagJson(tags);
      if (tagsJson === doc.tags) {
        return {
          success: true,
          status: "unchanged",
          document_id: doc.id,
          tags,
        };
      }

      this.db
        .query("UPDATE documents SET tags=? WHERE id=?")
        .run(tagsJson, documentId);

      const chunks = this.db
        .query(
          "SELECT id, content FROM chunks WHERE document_id=? ORDER BY chunk_index ASC",
        )
        .all(documentId) as { id: number; content: string }[];
      this.db
        .query(
          "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=?)",
        )
        .run(documentId);
      const tagsText = tags.join(" ");
      for (const chunk of chunks) {
        this.db
          .query(
            `INSERT INTO chunks_fts(
               rowid, document_id, chunk_id, title, content, tags, source_uri
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.id,
            documentId,
            chunk.id,
            doc.title,
            chunk.content,
            tagsText,
            doc.source_uri,
          );
      }

      return {
        success: true,
        status: "updated",
        document_id: doc.id,
        tags,
      };
    });
    return transaction.immediate();
  }

  // ---- Content-addressed Artifact metadata (ADR 0008) ----

  /**
   * Register typed metadata only after Artifact bytes have been verified and
   * promoted. Replays are idempotent for the same digest/role, while Resource
   * references remain distinct even when their Artifact bytes deduplicate.
   */
  registerArtifact(input: RegisterArtifactInput): RegisteredArtifactResult {
    const contentDigest = String(input.contentDigest || "").toLowerCase();
    if (!SHA256_DIGEST_PATTERN.test(contentDigest)) {
      throw new CliError("invalid_digest", "invalid SHA-256 content digest");
    }
    const mediaType = String(input.mediaType || "")
      .trim()
      .toLowerCase();
    const artifactRole = String(input.artifactRole || "")
      .trim()
      .toLowerCase();
    if (
      mediaType.length === 0 ||
      mediaType.length > 255 ||
      !MEDIA_TYPE_PATTERN.test(mediaType)
    ) {
      throw new CliError(
        "bad_artifact",
        "Artifact media_type must be a valid type/subtype of at most 255 characters",
      );
    }
    if (artifactRole.length === 0 || artifactRole.length > 100) {
      throw new CliError(
        "bad_artifact",
        "Artifact role is required and must be at most 100 characters",
      );
    }
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
      throw new CliError(
        "bad_artifact",
        "Artifact byte_size must be a non-negative safe integer",
      );
    }
    if (!isSafeArtifactStoragePath(input.storagePath, contentDigest)) {
      throw new CliError(
        "bad_artifact",
        "Artifact storage_path must be the digest-derived relative path",
      );
    }
    const requestedSensitivity = input.sensitivity ?? "normal";
    if (!(requestedSensitivity in SENSITIVITY_RANK)) {
      throw new CliError("bad_artifact", "invalid Artifact sensitivity");
    }
    if (
      input.derivedFromArtifactId !== undefined &&
      !String(input.derivationType || "").trim()
    ) {
      throw new CliError(
        "bad_artifact",
        "derived Artifacts require a derivation_type",
      );
    }
    if (
      input.derivedFromArtifactId === undefined &&
      input.derivationType !== undefined
    ) {
      throw new CliError(
        "bad_artifact",
        "derivation_type requires a parent Artifact",
      );
    }
    if (input.provenance !== undefined && input.resourceId === undefined) {
      throw new CliError(
        "bad_artifact",
        "Artifact provenance requires a Resource reference",
      );
    }
    const timestamp = (input.observedAt ?? new Date()).toISOString();

    const transaction = this.db.transaction((): RegisteredArtifactResult => {
      const inherited: Sensitivity[] = [requestedSensitivity];
      const inherit = (table: string, id: number | undefined): void => {
        if (id === undefined) return;
        const row = this.db
          .query(`SELECT sensitivity FROM ${table} WHERE id=?`)
          .get(id) as { sensitivity: Sensitivity } | null;
        if (row === null) {
          throw new CliError(
            "bad_artifact_reference",
            `referenced ${table.slice(0, -1)} does not exist`,
          );
        }
        inherited.push(row.sensitivity);
      };
      inherit("resources", input.resourceId);
      inherit("jobs", input.jobId);
      inherit("sources", input.sourceId);
      inherit("artifacts", input.derivedFromArtifactId);
      if (input.resourceId !== undefined) {
        const collectionPolicies = this.db
          .query(
            `SELECT c.sensitivity FROM collections c
             JOIN collection_memberships cm ON cm.collection_id=c.id
             WHERE cm.resource_id=?`,
          )
          .all(input.resourceId) as Array<{ sensitivity: Sensitivity }>;
        inherited.push(...collectionPolicies.map((row) => row.sensitivity));
      }
      const sensitivity = inherited.reduce((strictest, candidate) =>
        SENSITIVITY_RANK[candidate] > SENSITIVITY_RANK[strictest]
          ? candidate
          : strictest,
      );

      let artifact = this.db
        .query(
          "SELECT * FROM artifacts WHERE content_hash=? AND artifact_role=?",
        )
        .get(contentDigest, artifactRole) as Artifact | null;
      if (artifact === null) {
        const inserted = this.db
          .query(
            `INSERT INTO artifacts(
               content_hash, media_type, byte_size, artifact_role, sensitivity,
               storage_path, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            contentDigest,
            mediaType,
            input.byteSize,
            artifactRole,
            sensitivity,
            input.storagePath,
            timestamp,
          );
        artifact = this.db
          .query("SELECT * FROM artifacts WHERE id=?")
          .get(Number(inserted.lastInsertRowid)) as Artifact;
      } else {
        if (
          artifact.media_type !== mediaType ||
          artifact.byte_size !== input.byteSize ||
          artifact.storage_path !== input.storagePath
        ) {
          throw new CliError(
            "artifact_metadata_conflict",
            "registered Artifact metadata conflicts with the existing digest and role",
          );
        }
        if (
          SENSITIVITY_RANK[sensitivity] > SENSITIVITY_RANK[artifact.sensitivity]
        ) {
          this.db
            .query("UPDATE artifacts SET sensitivity=? WHERE id=?")
            .run(sensitivity, artifact.id);
          artifact = this.db
            .query("SELECT * FROM artifacts WHERE id=?")
            .get(artifact.id) as Artifact;
        }
      }

      let resourceReferenceCreated = false;
      if (input.resourceId !== undefined) {
        const result = this.db
          .query(
            `INSERT OR IGNORE INTO resource_artifacts(
               resource_id, artifact_id, observed_at
             ) VALUES (?, ?, ?)`,
          )
          .run(input.resourceId, artifact.id, timestamp);
        resourceReferenceCreated = result.changes > 0;
      }

      let derivationCreated = false;
      if (input.derivedFromArtifactId !== undefined) {
        if (input.derivedFromArtifactId === artifact.id) {
          throw new CliError(
            "bad_artifact",
            "an Artifact cannot be derived from itself",
          );
        }
        const result = this.db
          .query(
            `INSERT OR IGNORE INTO artifact_derivations(
               artifact_id, parent_artifact_id, derivation_type, created_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            artifact.id,
            input.derivedFromArtifactId,
            String(input.derivationType).trim().toLowerCase(),
            timestamp,
          );
        derivationCreated = result.changes > 0;
      }

      if (input.provenance !== undefined && input.resourceId !== undefined) {
        const evidenceType = String(input.provenance.evidenceType || "").trim();
        if (!evidenceType) {
          throw new CliError(
            "bad_artifact",
            "Provenance evidence_type is required",
          );
        }
        const rawMetadata =
          input.provenance.rawMetadata === undefined
            ? null
            : typeof input.provenance.rawMetadata === "string"
              ? input.provenance.rawMetadata
              : JSON.stringify(input.provenance.rawMetadata);
        const sourceId = input.sourceId ?? null;
        const runId = input.provenance.runId ?? null;
        const ingress = input.provenance.ingress ?? null;
        const existingProvenance = this.db
          .query(
            `SELECT id FROM provenance
             WHERE resource_id=? AND evidence_type=? AND source_id IS ?
               AND run_id IS ? AND artifact_id=? AND relation_id IS NULL
               AND ingress IS ? AND raw_metadata IS ?`,
          )
          .get(
            input.resourceId,
            evidenceType,
            sourceId,
            runId,
            artifact.id,
            ingress,
            rawMetadata,
          );
        if (existingProvenance === null) {
          this.db
            .query(
              `INSERT INTO provenance(
                 resource_id, evidence_type, source_id, run_id, artifact_id,
                 ingress, raw_metadata, observed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.resourceId,
              evidenceType,
              sourceId,
              runId,
              artifact.id,
              ingress,
              rawMetadata,
              timestamp,
            );
        }
      }
      return { artifact, resourceReferenceCreated, derivationCreated };
    });
    return transaction.immediate();
  }

  registerStoredArtifact(
    stored: StoredArtifact,
    metadata: Omit<
      RegisterArtifactInput,
      "contentDigest" | "byteSize" | "storagePath"
    >,
  ): RegisteredArtifactResult {
    return this.registerArtifact({
      ...metadata,
      contentDigest: stored.contentDigest,
      byteSize: stored.byteSize,
      storagePath: stored.storagePath,
    });
  }

  /**
   * Admit local-file work only from an already-promoted immutable snapshot.
   * The durable intent deliberately contains no mutable or private source path.
   */
  enqueueLocalFileSnapshot(input: {
    idempotencyKey: string;
    snapshot: LocalFileSnapshot;
    artifactStore: ArtifactStore;
    artifactRole?: string;
    sensitivity?: Sensitivity;
    resourceId?: number;
    sourceId?: number;
    runId?: number;
    now?: Date;
  }): {
    artifact: Artifact;
    job: Job;
    created: boolean;
  } {
    const verified = input.artifactStore.verify(input.snapshot.contentDigest);
    if (
      verified.byteSize !== input.snapshot.byteSize ||
      verified.storagePath !== input.snapshot.storagePath
    ) {
      throw new CliError(
        "snapshot_mismatch",
        "local-file snapshot metadata does not match immutable Artifact bytes",
      );
    }
    const registered = this.registerStoredArtifact(input.snapshot, {
      mediaType: input.snapshot.mediaType,
      artifactRole: input.artifactRole ?? "original",
      sensitivity: input.sensitivity,
      resourceId: input.resourceId,
      sourceId: input.sourceId,
      observedAt: input.now,
    });
    const admitted = this.enqueueJob({
      idempotencyKey: input.idempotencyKey,
      kind: "local_file_snapshot",
      intent: {
        artifact_id: registered.artifact.id,
        content_digest: input.snapshot.contentDigest,
        byte_size: input.snapshot.byteSize,
        media_type: input.snapshot.mediaType,
        artifact_role: registered.artifact.artifact_role,
      },
      sensitivity: registered.artifact.sensitivity,
      resourceId: input.resourceId,
      sourceId: input.sourceId,
      runId: input.runId,
      now: input.now,
    });
    return { artifact: registered.artifact, ...admitted };
  }

  /** Content digests known to SQLite, suitable as reconciliation roots. */
  registeredArtifactDigests(): string[] {
    return (
      this.db
        .query(
          "SELECT DISTINCT content_hash FROM artifacts ORDER BY content_hash",
        )
        .all() as Array<{ content_hash: string }>
    ).map((row) => row.content_hash);
  }

  reconcileArtifactStore(
    artifactStore: ArtifactStore,
    options: ReconcileOptions = {},
  ): ArtifactReconciliationReport {
    return artifactStore.reconcile(this.registeredArtifactDigests(), options);
  }

  /**
   * Rebuild searchable content from a retained normalized Artifact, without a
   * source file or network. Digest verification happens before UTF-8 decoding.
   */
  rebuildDocumentFromArtifact(input: {
    artifactId: number;
    artifactStore: ArtifactStore;
    sourceType?: string;
    sourceUri?: string;
    title?: string | null;
    tags?: unknown;
    notes?: string | null;
    resourceId?: number;
    maxBytes?: number;
  }): UpsertDocumentResult {
    const artifact = this.db
      .query("SELECT * FROM artifacts WHERE id=?")
      .get(input.artifactId) as Artifact | null;
    if (artifact === null) {
      throw new CliError(
        "artifact_not_found",
        `Artifact ${input.artifactId} not found`,
      );
    }
    const normalizedRoles = new Set([
      "normalized",
      "normalized_text",
      "normalized_markdown",
      "imported_markdown",
      "extracted_markdown",
    ]);
    if (!normalizedRoles.has(artifact.artifact_role)) {
      throw new CliError(
        "artifact_not_normalized",
        "only a normalized Artifact can rebuild indexed content",
      );
    }
    if (
      !artifact.media_type.startsWith("text/") &&
      artifact.media_type !== "application/markdown"
    ) {
      throw new CliError(
        "artifact_not_text",
        "normalized Artifact media_type must be textual",
      );
    }
    if (input.resourceId !== undefined) {
      const resource = this.db
        .query("SELECT id FROM resources WHERE id=?")
        .get(input.resourceId);
      if (resource === null) {
        throw new CliError(
          "resource_not_found",
          `Resource ${input.resourceId} not found`,
        );
      }
    }
    const content = input.artifactStore.readUtf8(
      artifact.content_hash,
      input.maxBytes,
    );
    const result = this.upsertDocument({
      sourceType: input.sourceType ?? "artifact",
      sourceUri: input.sourceUri ?? `artifact:sha256:${artifact.content_hash}`,
      title: input.title,
      tags: input.tags,
      notes: input.notes,
      content,
      mediaType: artifact.media_type,
      revisionDigest: artifact.content_hash,
      force: true,
    });
    if (input.resourceId !== undefined) {
      const update = this.db
        .query("UPDATE resources SET document_id=?, updated_at=? WHERE id=?")
        .run(result.document_id, nowIso(), input.resourceId);
      if (update.changes === 0) {
        throw new CliError(
          "resource_update_failed",
          `Resource ${input.resourceId} could not attach rebuilt content`,
        );
      }
    }
    return result;
  }

  authorizeRunScope(
    input: OperatorRunPolicy & { now?: Date },
  ): OperatorRunPolicy {
    if (!Number.isInteger(input.runId) || input.runId < 1) {
      throw new CliError("bad_run_scope", "Run ID must be a positive integer", {
        exitCode: 2,
      });
    }
    if (input.mode !== "offline" && input.mode !== "online") {
      throw new CliError(
        "bad_run_scope",
        "operator-controlled Run mode must be offline or online",
        { exitCode: 2 },
      );
    }
    if (
      !Number.isInteger(input.expectedJobCount) ||
      input.expectedJobCount < 1
    ) {
      throw new CliError(
        "bad_run_scope",
        "operator-controlled Run expected job count must be positive",
        { exitCode: 2 },
      );
    }
    const authorizationDigest = validatedAuthorizationDigest(
      input.authorizationDigest,
    );
    const allowedKinds = normalizedAllowedKinds(input.allowedKinds);
    this.assertControlledMode(input.mode, allowedKinds, input.expectedJobCount);
    const timestamp = (input.now ?? new Date()).toISOString();

    const transaction = this.db.transaction((): OperatorRunPolicy => {
      const run = this.db
        .query(
          `SELECT id, run_type, source_id, state, checkpoint, started_at,
                  finished_at, created_at, updated_at
           FROM runs WHERE id=?`,
        )
        .get(input.runId) as Run | null;
      if (run === null) {
        throw new CliError("run_not_found", `Run ${input.runId} not found`);
      }
      const existing = this.loadRunPolicy(input.runId);
      if (existing !== null) {
        if (
          existing.mode !== input.mode ||
          existing.authorizationDigest !== authorizationDigest ||
          !sameStrings(existing.allowedKinds, allowedKinds) ||
          existing.expectedJobCount !== input.expectedJobCount
        ) {
          throw new CliError(
            "run_policy_immutable",
            `operator-controlled Run ${input.runId} already has a different immutable policy`,
          );
        }
        return existing;
      }
      const running = this.db
        .query(
          `SELECT COUNT(*) AS count FROM jobs
           WHERE run_id=? AND state='running'`,
        )
        .get(input.runId) as { count: number };
      if (running.count !== 0) {
        throw new CliError(
          "run_not_quiescent",
          `Run ${input.runId} has active ingestion jobs`,
        );
      }
      const policy: OperatorRunPolicy = {
        runId: input.runId,
        mode: input.mode,
        authorizationDigest,
        allowedKinds,
        expectedJobCount: input.expectedJobCount,
      };
      this.assertRunScopeCardinality(policy);
      this.db
        .query(
          `INSERT INTO operator_run_policies(
             run_id, mode, authorization_digest, allowed_job_kinds,
             expected_job_count, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          policy.runId,
          policy.mode,
          policy.authorizationDigest,
          JSON.stringify(policy.allowedKinds),
          policy.expectedJobCount,
          timestamp,
        );
      return policy;
    });
    return transaction.immediate();
  }

  validateRunScope(scope: OperatorRunScope): OperatorRunPolicy {
    return this.requireRunScope(scope);
  }

  beginRunScope(
    scope: OperatorRunScope,
    input: { worker: string; now?: Date; leaseMs?: number },
  ): OperatorRunExecution {
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const leaseMs = input.leaseMs ?? DEFAULT_LIFECYCLE_POLICY.leaseMs;
    const worker = String(input.worker || "").trim();
    if (worker.length === 0 || !Number.isFinite(leaseMs) || leaseMs < 1) {
      throw new CliError(
        "bad_run_scope",
        "operator-controlled Run execution requires a worker and positive lease duration",
        { exitCode: 2 },
      );
    }
    const leaseExpiresAt = isoAfter(now, leaseMs);
    const transaction = this.db.transaction((): OperatorRunExecution => {
      const policy = this.requireRunScope(scope);
      const active = this.db
        .query(
          `SELECT COUNT(*) AS count
           FROM attempts a JOIN jobs j ON j.id=a.job_id
           WHERE a.state='leased' AND a.lease_expires_at>?
             AND (?='online' OR j.run_id=?)`,
        )
        .get(timestamp, policy.mode, policy.runId) as { count: number };
      const execution = this.db
        .query(
          `SELECT lease_expires_at FROM operator_run_execution_leases
           WHERE run_id=?`,
        )
        .get(policy.runId) as { lease_expires_at: string } | null;
      if (
        active.count !== 0 ||
        (execution !== null && execution.lease_expires_at > timestamp)
      ) {
        throw new CliError(
          "run_not_quiescent",
          `operator-controlled Run ${policy.runId} has an active lease`,
        );
      }
      const run = this.db
        .query("SELECT state FROM runs WHERE id=?")
        .get(policy.runId) as { state: string };
      if (run.state === "cancelled" || run.state === "failed") {
        throw new CliError(
          "run_not_executable",
          `operator-controlled Run ${policy.runId} is ${run.state}`,
        );
      }
      this.db
        .query(
          "DELETE FROM operator_run_execution_leases WHERE run_id=? AND lease_expires_at<=?",
        )
        .run(policy.runId, timestamp);
      const leased = this.db
        .query(
          `INSERT INTO operator_run_execution_leases(
             run_id, fencing_token, worker, lease_expires_at, heartbeat_at
           ) VALUES (?, lower(hex(randomblob(16))), ?, ?, ?)
           RETURNING fencing_token`,
        )
        .get(policy.runId, worker, leaseExpiresAt, timestamp) as {
        fencing_token: string;
      };
      this.db
        .query(
          `UPDATE runs SET state='active', started_at=COALESCE(started_at, ?),
             finished_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(timestamp, timestamp, policy.runId);
      this.db
        .query(
          `UPDATE recovery_online_runs
           SET status='active', updated_at=?, finished_at=NULL WHERE run_id=?`,
        )
        .run(timestamp, policy.runId);
      return { ...policy, executionToken: leased.fencing_token };
    });
    return transaction.immediate();
  }

  heartbeatRunScope(
    scope: OperatorRunScope,
    executionToken: string,
    input: { now?: Date; leaseMs?: number } = {},
  ): boolean {
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const leaseMs = input.leaseMs ?? DEFAULT_LIFECYCLE_POLICY.leaseMs;
    if (!Number.isFinite(leaseMs) || leaseMs < 1) return false;
    const transaction = this.db.transaction((): boolean => {
      const policy = this.requireRunScope(scope);
      const updated = this.db
        .query(
          `UPDATE operator_run_execution_leases
           SET lease_expires_at=?, heartbeat_at=?
           WHERE run_id=? AND fencing_token=? AND lease_expires_at>?`,
        )
        .run(
          isoAfter(now, leaseMs),
          timestamp,
          policy.runId,
          executionToken,
          timestamp,
        );
      return updated.changes === 1;
    });
    return transaction.immediate();
  }

  finishRunScope(
    scope: OperatorRunScope,
    input: { executionToken: string; now?: Date },
  ): boolean {
    const timestamp = (input.now ?? new Date()).toISOString();
    const transaction = this.db.transaction((): boolean => {
      const policy = this.requireRunScope(scope);
      this.assertRunExecutionLease(policy, input.executionToken, timestamp);
      const eligible = controlledScopeJobPredicate(policy);
      const recoveryOnline = this.db
        .query("SELECT run_id FROM recovery_online_runs WHERE run_id=?")
        .get(policy.runId) as { run_id: number } | null;
      let terminal: boolean;
      if (recoveryOnline !== null) {
        const counts = this.db
          .query(
            `SELECT
               SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) AS completed,
               SUM(CASE WHEN state IN ('queued', 'running', 'retry_wait')
                        THEN 1 ELSE 0 END) AS pending,
               SUM(CASE
                 WHEN failure_class IN ('infra', 'auth_config')
                   AND state<>'completed' THEN 1 ELSE 0
               END) AS shared_failures
             FROM jobs WHERE run_id=? AND (${eligible.sql})`,
          )
          .get(policy.runId, ...eligible.parameters) as {
          completed: number;
          pending: number;
          shared_failures: number;
        };
        const status =
          counts.completed === policy.expectedJobCount
            ? "completed"
            : counts.shared_failures > 0 || counts.pending > 0
              ? "paused"
              : "completed_with_review";
        terminal = status === "completed" || status === "completed_with_review";
        this.db
          .query(
            `UPDATE recovery_online_items AS item SET
               outcome=CASE job.state
                 WHEN 'completed' THEN 'succeeded_or_duplicate'
                 ELSE job.state
               END,
               failure_class=CASE
                 WHEN job.state='completed' THEN NULL ELSE job.failure_class
               END,
               attempt_count=job.attempt_count,
               last_attempt_id=(
                 SELECT MAX(a.id) FROM attempts a WHERE a.job_id=job.id
               ),
               artifact_digest=(
                 SELECT a.content_hash
                 FROM provenance p
                 JOIN artifacts a ON a.id=p.artifact_id
                 WHERE p.run_id=item.run_id
                   AND p.evidence_type='url_extraction'
                   AND json_extract(p.raw_metadata, '$.job_id')=job.id
                 ORDER BY p.id DESC LIMIT 1
               ),
               started_at=(
                 SELECT MIN(a.started_at) FROM attempts a WHERE a.job_id=job.id
               ),
               finished_at=(
                 SELECT MAX(a.finished_at) FROM attempts a WHERE a.job_id=job.id
               ),
               updated_at=?
             FROM jobs AS job
             WHERE item.run_id=? AND job.id=item.job_id`,
          )
          .run(timestamp, policy.runId);
        this.db
          .query(
            `UPDATE recovery_online_runs
             SET status=?, updated_at=?, finished_at=? WHERE run_id=?`,
          )
          .run(status, timestamp, terminal ? timestamp : null, policy.runId);
        this.db
          .query(
            `UPDATE runs SET state=?, finished_at=?, updated_at=? WHERE id=?
               AND state NOT IN ('failed', 'cancelled')`,
          )
          .run(
            terminal ? "completed" : "pending",
            terminal ? timestamp : null,
            timestamp,
            policy.runId,
          );
      } else {
        const pending = this.db
          .query(
            `SELECT COUNT(*) AS count FROM jobs
             WHERE run_id=? AND (${eligible.sql})
               AND state NOT IN ('completed', 'excluded')`,
          )
          .get(policy.runId, ...eligible.parameters) as { count: number };
        terminal = pending.count === 0;
        this.db
          .query(
            `UPDATE runs SET state=?, finished_at=?, updated_at=? WHERE id=?
               AND state NOT IN ('failed', 'cancelled')`,
          )
          .run(
            terminal ? "completed" : "pending",
            terminal ? timestamp : null,
            timestamp,
            policy.runId,
          );
      }
      this.db
        .query(
          `DELETE FROM operator_run_execution_leases
           WHERE run_id=? AND fencing_token=?`,
        )
        .run(policy.runId, input.executionToken);
      return terminal;
    });
    return transaction.immediate();
  }

  // ---- Durable ingestion job lifecycle (ADR 0004) ----

  /**
   * Admission: create or identify a durable job for one intent. Idempotent on
   * `idempotencyKey`, so replayed submissions return the existing job instead
   * of forking a second lifecycle. Returns whether the job was newly created.
   */
  enqueueJob(input: {
    idempotencyKey: string;
    kind: string;
    intent?: unknown;
    sensitivity?: string;
    resourceId?: number | null;
    sourceId?: number | null;
    runId?: number | null;
    now?: Date;
  }): { job: Job; created: boolean } {
    const idempotencyKey = String(input.idempotencyKey || "").trim();
    if (idempotencyKey.length === 0) {
      throw new CliError("bad_intent", "idempotency_key is required");
    }
    const kind = String(input.kind || "").trim();
    if (kind.length === 0) throw new CliError("bad_intent", "kind is required");
    const intent =
      input.intent === undefined || input.intent === null
        ? null
        : typeof input.intent === "string"
          ? input.intent
          : JSON.stringify(input.intent);
    const sensitivity = input.sensitivity ?? "normal";
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();

    const transaction = this.db.transaction(
      (): { job: Job; created: boolean } => {
        const existing = this.loadJobByKey(idempotencyKey);
        if (existing !== null) return { job: existing, created: false };
        const inserted = this.db
          .query(
            `INSERT INTO jobs(
             idempotency_key, kind, intent, resource_id, source_id, run_id,
             state, sensitivity, run_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
          )
          .run(
            idempotencyKey,
            kind,
            intent,
            input.resourceId ?? null,
            input.sourceId ?? null,
            input.runId ?? null,
            sensitivity,
            timestamp,
            timestamp,
            timestamp,
          );
        const jobId = Number(inserted.lastInsertRowid);
        this.recordTransition(
          jobId,
          null,
          null,
          "queued",
          "system",
          "admitted",
          null,
          timestamp,
        );
        return { job: this.requireJob(jobId), created: true };
      },
    );
    return transaction.immediate();
  }

  /**
   * Atomically claim the next runnable job and open a fresh leased attempt.
   * The immediate transaction takes the write lock at BEGIN, and the runnable
   * predicate excludes any already-running job, so two concurrent claimers can
   * never obtain the same active lease. The new attempt id is the fencing token.
   */
  claimJob(
    input: {
      worker: string;
      scope?: OperatorRunScope;
      executionToken?: string;
    } & LifecycleOptions,
  ): ClaimResult {
    const worker = String(input.worker || "").trim();
    if (worker.length === 0)
      throw new CliError("bad_claim", "worker is required");
    const now = input.now ?? new Date();
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, ...input.policy };
    const timestamp = now.toISOString();
    const leaseExpiresAt = isoAfter(now, input.leaseMs ?? policy.leaseMs);

    const transaction = this.db.transaction((): ClaimResult => {
      let candidate: Job | null;
      if (input.scope === undefined) {
        candidate = this.db
          .query(
            `SELECT ${JOB_COLUMNS} FROM jobs j
             WHERE state IN ('queued', 'retry_wait') AND run_at <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM operator_run_policies p WHERE p.run_id=j.run_id
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM operator_run_execution_leases l
                 JOIN operator_run_policies p ON p.run_id=l.run_id
                 WHERE p.mode='online' AND l.lease_expires_at>?
               )
             ORDER BY run_at ASC, id ASC LIMIT 1`,
          )
          .get(timestamp, timestamp) as Job | null;
      } else {
        const scope = this.requireRunScope(input.scope);
        this.assertRunExecutionLease(scope, input.executionToken, timestamp);
        const eligible = controlledScopeJobPredicate(scope);
        candidate = this.db
          .query(
            `SELECT ${JOB_COLUMNS} FROM jobs j
             WHERE state IN ('queued', 'retry_wait') AND run_at <= ?
               AND run_id=? AND (${eligible.sql})
               AND (
                 NOT EXISTS (
                   SELECT 1
                   FROM recovery_online_items i
                   JOIN jobs failed_job ON failed_job.id=i.job_id
                   WHERE i.run_id=?
                     AND i.failure_class IN ('infra', 'auth_config')
                     AND failed_job.state IN (
                       'queued', 'running', 'retry_wait', 'blocked'
                     )
                 )
                 OR j.id=(
                   SELECT i.job_id
                   FROM recovery_online_items i
                   JOIN jobs failed_job ON failed_job.id=i.job_id
                   WHERE i.run_id=?
                     AND i.failure_class IN ('infra', 'auth_config')
                     AND failed_job.state IN (
                       'queued', 'running', 'retry_wait', 'blocked'
                     )
                   ORDER BY i.job_id LIMIT 1
                 )
               )
             ORDER BY run_at ASC, id ASC LIMIT 1`,
          )
          .get(
            timestamp,
            scope.runId,
            ...eligible.parameters,
            scope.runId,
            scope.runId,
          ) as Job | null;
      }
      if (candidate === null) return { claimed: false };

      const attemptNumber = candidate.attempt_count + 1;
      const inserted = this.db
        .query(
          `INSERT INTO attempts(
             job_id, attempt_number, worker, state, lease_expires_at,
             heartbeat_at, started_at
           ) VALUES (?, ?, ?, 'leased', ?, ?, ?)`,
        )
        .run(
          candidate.id,
          attemptNumber,
          worker,
          leaseExpiresAt,
          timestamp,
          timestamp,
        );
      const attemptId = Number(inserted.lastInsertRowid);
      this.assertTransition(candidate.state, "running");
      this.db
        .query(
          `UPDATE jobs SET state='running', attempt_count=?, current_attempt_id=?,
             updated_at=? WHERE id=?`,
        )
        .run(attemptNumber, attemptId, timestamp, candidate.id);
      this.recordTransition(
        candidate.id,
        attemptId,
        candidate.state,
        "running",
        worker,
        "claimed",
        null,
        timestamp,
      );
      return {
        claimed: true,
        job: this.requireJob(candidate.id),
        attempt: this.requireAttempt(attemptId),
        fencing_token: attemptId,
      };
    });
    return transaction.immediate();
  }

  /** Extend a live lease. Rejects an expired (stale) or fenced token. */
  heartbeat(
    input: { fencingToken: number } & LifecycleOptions,
  ): HeartbeatResult {
    const now = input.now ?? new Date();
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, ...input.policy };
    const timestamp = now.toISOString();
    const leaseExpiresAt = isoAfter(now, input.leaseMs ?? policy.leaseMs);

    const transaction = this.db.transaction((): HeartbeatResult => {
      const guard = this.guardActiveToken(input.fencingToken, now);
      if (guard.ok === false) return guard;
      this.db
        .query(
          "UPDATE attempts SET lease_expires_at=?, heartbeat_at=? WHERE id=?",
        )
        .run(leaseExpiresAt, timestamp, input.fencingToken);
      return {
        ok: true,
        job: this.requireJob(guard.job.id),
        attempt: this.requireAttempt(input.fencingToken),
      };
    });
    return transaction.immediate();
  }

  /**
   * Fenced, idempotent success. `apply` runs the resource/provenance/index
   * effects inside the same transaction that finalizes the attempt and job, so
   * they commit together. A replayed completion of an already-completed job is
   * a no-op (`idempotent: true`) that never re-runs `apply`, so at-least-once
   * execution cannot duplicate resource, provenance, or terminal job effects.
   */
  completeJob(
    input: {
      fencingToken: number;
      resourceId?: number | null;
      apply?: (db: Database) => void;
    } & LifecycleOptions,
  ): CompleteResult {
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();

    const transaction = this.db.transaction((): CompleteResult => {
      const attempt = this.requireAttempt(input.fencingToken);
      const job = this.requireJob(attempt.job_id);
      if (job.state === "completed" && attempt.state === "succeeded") {
        return { ok: true, idempotent: true, job };
      }
      const guard = this.guardActiveToken(input.fencingToken, now);
      if (guard.ok === false) return guard;

      if (input.apply !== undefined) input.apply(this.db);
      this.db
        .query(
          "UPDATE attempts SET state='succeeded', finished_at=? WHERE id=?",
        )
        .run(timestamp, input.fencingToken);
      this.assertTransition(guard.job.state, "completed");
      this.db
        .query(
          `UPDATE jobs SET state='completed', resource_id=COALESCE(?, resource_id),
             updated_at=? WHERE id=?`,
        )
        .run(input.resourceId ?? null, timestamp, guard.job.id);
      this.recordTransition(
        guard.job.id,
        input.fencingToken,
        guard.job.state,
        "completed",
        guard.job_worker,
        "completed",
        null,
        timestamp,
      );
      return {
        ok: true,
        idempotent: false,
        job: this.requireJob(guard.job.id),
      };
    });
    return transaction.immediate();
  }

  /**
   * Fenced failure classification. Infrastructure failure retries indefinitely
   * in retry_wait; item-transient failure consumes a bounded budget and blocks
   * once exhausted; permanent failure fails terminally; auth/config blocks.
   */
  failAttempt(
    input: {
      fencingToken: number;
      failureClass: FailureClass;
      summary?: unknown;
      /** Fenced domain evidence committed with the failed attempt and disposition. */
      apply?: (db: Database, disposition: JobState) => void;
    } & LifecycleOptions,
  ): FailResult {
    const now = input.now ?? new Date();
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, ...input.policy };
    const random = input.random ?? Math.random;
    const timestamp = now.toISOString();
    const summary =
      input.summary === undefined ? null : sanitizeExternalError(input.summary);

    const transaction = this.db.transaction((): FailResult => {
      const guard = this.guardActiveToken(input.fencingToken, now);
      if (guard.ok === false) return guard;
      const job = guard.job;
      this.db
        .query(
          `UPDATE attempts SET state='failed', failure_class=?, failure_summary=?,
             finished_at=? WHERE id=?`,
        )
        .run(input.failureClass, summary, timestamp, input.fencingToken);

      let toState: JobState;
      let runAt = job.run_at;
      let itemRetryCount = job.item_retry_count;
      let blockReason: string | null = null;
      let reason: string;
      if (input.failureClass === "infra") {
        toState = "retry_wait";
        runAt = isoAfter(
          now,
          backoffMs(
            job.attempt_count,
            policy.infraBaseMs,
            policy.infraCapMs,
            policy.jitterRatio,
            random,
          ),
        );
        reason = "infra_retry";
      } else if (input.failureClass === "item_transient") {
        itemRetryCount = job.item_retry_count + 1;
        if (itemRetryCount >= policy.maxItemRetries) {
          toState = "blocked";
          blockReason = "item_retry_exhausted";
          reason = "item_retry_exhausted";
        } else {
          toState = "retry_wait";
          runAt = isoAfter(
            now,
            backoffMs(
              itemRetryCount,
              policy.itemBaseMs,
              policy.itemCapMs,
              policy.jitterRatio,
              random,
            ),
          );
          reason = "item_retry";
        }
      } else if (input.failureClass === "auth_config") {
        toState = "blocked";
        blockReason = "auth_config";
        reason = "auth_config";
      } else {
        toState = "failed";
        reason = "permanent";
      }

      if (input.apply !== undefined) input.apply(this.db, toState);
      this.assertTransition(job.state, toState);
      this.db
        .query(
          `UPDATE jobs SET state=?, item_retry_count=?, run_at=?, block_reason=?,
             failure_class=?, failure_summary=?, current_attempt_id=NULL,
             updated_at=? WHERE id=?`,
        )
        .run(
          toState,
          itemRetryCount,
          runAt,
          blockReason,
          input.failureClass,
          summary,
          timestamp,
          job.id,
        );
      this.recordTransition(
        job.id,
        input.fencingToken,
        job.state,
        toState,
        guard.job_worker,
        reason,
        summary,
        timestamp,
      );
      return {
        ok: true,
        job: this.requireJob(job.id),
        attempt: this.requireAttempt(input.fencingToken),
        disposition: toState,
      };
    });
    return transaction.immediate();
  }

  /**
   * Reconcile leases whose worker crashed or stalled: mark each expired leased
   * attempt stale and return its job to retry_wait with infra backoff. A crash
   * is not attributable to the item, so it never consumes the item budget.
   */
  recoverExpiredLeases(
    input: LifecycleOptions & {
      scope?: OperatorRunScope;
      executionToken?: string;
    } = {},
  ): RecoveredLease[] {
    const now = input.now ?? new Date();
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, ...input.policy };
    const random = input.random ?? Math.random;
    const timestamp = now.toISOString();

    const transaction = this.db.transaction((): RecoveredLease[] => {
      let expired: Array<{
        attempt_id: number;
        job_id: number;
        state: JobState;
        attempt_count: number;
      }>;
      if (input.scope === undefined) {
        expired = this.db
          .query(
            `SELECT a.id AS attempt_id, a.job_id AS job_id, j.state AS state,
                    j.attempt_count AS attempt_count
             FROM attempts a JOIN jobs j ON j.id = a.job_id
             WHERE a.state='leased' AND a.lease_expires_at <= ? AND j.state='running'
               AND NOT EXISTS (
                 SELECT 1 FROM operator_run_policies p WHERE p.run_id=j.run_id
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM operator_run_execution_leases l
                 JOIN operator_run_policies p ON p.run_id=l.run_id
                 WHERE p.mode='online' AND l.lease_expires_at>?
               )
             ORDER BY a.id ASC`,
          )
          .all(timestamp, timestamp) as typeof expired;
      } else {
        const scope = this.requireRunScope(input.scope);
        this.assertRunExecutionLease(scope, input.executionToken, timestamp);
        const eligible = controlledScopeJobPredicate(scope, "j");
        expired = this.db
          .query(
            `SELECT a.id AS attempt_id, a.job_id AS job_id, j.state AS state,
                    j.attempt_count AS attempt_count
             FROM attempts a JOIN jobs j ON j.id = a.job_id
             WHERE a.state='leased' AND a.lease_expires_at <= ? AND j.state='running'
               AND j.run_id=? AND (${eligible.sql})
             ORDER BY a.id ASC`,
          )
          .all(
            timestamp,
            scope.runId,
            ...eligible.parameters,
          ) as typeof expired;
      }
      const recovered: RecoveredLease[] = [];
      for (const row of expired) {
        this.db
          .query("UPDATE attempts SET state='stale', finished_at=? WHERE id=?")
          .run(timestamp, row.attempt_id);
        const runAt = isoAfter(
          now,
          backoffMs(
            row.attempt_count,
            policy.infraBaseMs,
            policy.infraCapMs,
            policy.jitterRatio,
            random,
          ),
        );
        this.assertTransition(row.state, "retry_wait");
        this.db
          .query(
            `UPDATE jobs SET state='retry_wait', run_at=?, current_attempt_id=NULL,
               updated_at=? WHERE id=?`,
          )
          .run(runAt, timestamp, row.job_id);
        this.recordTransition(
          row.job_id,
          row.attempt_id,
          row.state,
          "retry_wait",
          "system",
          "lease_expired",
          null,
          timestamp,
        );
        recovered.push({
          job_id: row.job_id,
          attempt_id: row.attempt_id,
          disposition: "retry_wait",
        });
      }
      return recovered;
    });
    return transaction.immediate();
  }

  /** Operator manual retry: requeue the same job, preserving prior attempts. */
  retryJob(input: {
    jobId: number;
    actor?: string;
    reason?: string;
    now?: Date;
  }): Job {
    return this.operatorTransition(
      input.jobId,
      "queued",
      input.actor ?? "operator",
      input.reason ?? "manual_retry",
      null,
      input.now,
      true,
    );
  }

  /** Operator reopen of a terminal disposition back to the runnable queue. */
  reopenJob(input: {
    jobId: number;
    actor?: string;
    reason?: string;
    now?: Date;
  }): Job {
    return this.operatorTransition(
      input.jobId,
      "queued",
      input.actor ?? "operator",
      input.reason ?? "reopened",
      null,
      input.now,
      true,
    );
  }

  /** Operator exclusion: durably remove a job from processing with a reason. */
  excludeJob(input: {
    jobId: number;
    actor?: string;
    reason: string;
    now?: Date;
  }): Job {
    const reason = String(input.reason || "").trim();
    if (reason.length === 0)
      throw new CliError("bad_exclude", "exclusion requires a reason");
    return this.operatorTransition(
      input.jobId,
      "excluded",
      input.actor ?? "operator",
      reason,
      reason,
      input.now,
      false,
    );
  }

  /**
   * Operator cancellation, fenced by a compare-and-swap: a job that already
   * committed a completion wins the race and cancellation is refused; otherwise
   * the job is cancelled and any live attempt is marked cancelled so a late
   * worker cannot commit.
   */
  cancelJob(input: {
    jobId: number;
    actor?: string;
    reason?: string;
    apply?: (db: Database) => void;
    now?: Date;
  }): CancelResult {
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const actor = input.actor ?? "operator";
    const reason = input.reason ?? "cancelled";

    const transaction = this.db.transaction((): CancelResult => {
      const job = this.requireJob(input.jobId);
      if (job.state === "completed") {
        return { ok: false, reason: "already_completed", job };
      }
      if (job.state === "cancelled") {
        this.cancelSourceRunForJob(job, reason, timestamp);
        return { ok: true, job };
      }
      this.assertTransition(job.state, "cancelled");
      if (input.apply !== undefined) input.apply(this.db);
      this.cancelSourceRunForJob(job, reason, timestamp);
      if (job.current_attempt_id !== null) {
        this.db
          .query(
            "UPDATE attempts SET state='cancelled', finished_at=? WHERE id=? AND state='leased'",
          )
          .run(timestamp, job.current_attempt_id);
      }
      this.db
        .query(
          "UPDATE jobs SET state='cancelled', current_attempt_id=NULL, updated_at=? WHERE id=?",
        )
        .run(timestamp, input.jobId);
      this.recordTransition(
        input.jobId,
        job.current_attempt_id,
        job.state,
        "cancelled",
        actor,
        reason,
        null,
        timestamp,
      );
      return { ok: true, job: this.requireJob(input.jobId) };
    });
    return transaction.immediate();
  }

  /**
   * Append durable audit evidence without changing the job's state, e.g. an
   * operator inspecting a sensitive job. This is a self-loop, so it deliberately
   * bypasses the state-transition table.
   */
  recordSensitiveInspection(input: {
    jobId: number;
    actor: string;
    detail: string;
    now?: Date;
  }): Job {
    const actor = String(input.actor || "").trim();
    if (actor.length === 0)
      throw new CliError("bad_audit", "an actor is required");
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const detail = sanitizeExternalError(input.detail);

    const transaction = this.db.transaction((): Job => {
      const job = this.requireJob(input.jobId);
      this.recordTransition(
        job.id,
        job.current_attempt_id,
        job.state,
        job.state,
        actor,
        "sensitive_inspection",
        detail,
        timestamp,
      );
      return job;
    });
    return transaction.immediate();
  }

  private assertControlledMode(
    mode: OperatorRunMode,
    allowedKinds: readonly string[],
    expectedJobCount: number,
  ): void {
    if (mode === "offline" && allowedKinds.includes("url")) {
      throw new CliError(
        "offline_scope_external_kind",
        "offline operator-controlled Run scopes cannot allow URL extraction jobs",
        { exitCode: 2 },
      );
    }
    if (
      allowedKinds.includes(RECOVERY_OFFLINE_SCOPE_KIND) &&
      (mode !== "offline" ||
        !sameStrings(allowedKinds, [RECOVERY_OFFLINE_SCOPE_KIND]))
    ) {
      throw new CliError(
        "recovery_offline_scope_mismatch",
        "recovery_offline must be the only allowed kind in an offline scope",
        { exitCode: 2 },
      );
    }
    if (
      allowedKinds.includes(RECOVERY_ONLINE_SCOPE_KIND) &&
      (mode !== "online" ||
        !sameStrings(allowedKinds, [RECOVERY_ONLINE_SCOPE_KIND]))
    ) {
      throw new CliError(
        "recovery_online_scope_mismatch",
        "recovery_online must be the only allowed kind in an online scope",
        { exitCode: 2 },
      );
    }
    if (
      mode === "online" &&
      ((!sameStrings(allowedKinds, ["url"]) &&
        !sameStrings(allowedKinds, [RECOVERY_ONLINE_SCOPE_KIND])) ||
        expectedJobCount !== 2)
    ) {
      throw new CliError(
        "online_scope_policy_mismatch",
        "online operator-controlled Run scopes require exactly two URL jobs",
        { exitCode: 2 },
      );
    }
  }

  private loadRunPolicy(runId: number): OperatorRunPolicy | null {
    const row = this.db
      .query(
        `SELECT run_id, mode, authorization_digest, allowed_job_kinds,
                expected_job_count
         FROM operator_run_policies WHERE run_id=?`,
      )
      .get(runId) as PersistedOperatorRunPolicy | null;
    return row === null ? null : policyFromRow(row);
  }

  private requireRunScope(scope: OperatorRunScope): OperatorRunPolicy {
    if (!Number.isInteger(scope.runId) || scope.runId < 1) {
      throw new CliError("bad_run_scope", "Run ID must be a positive integer", {
        exitCode: 2,
      });
    }
    const authorizationDigest = validatedAuthorizationDigest(
      scope.authorizationDigest,
    );
    const allowedKinds = normalizedAllowedKinds(scope.allowedKinds);
    const policy = this.loadRunPolicy(scope.runId);
    if (policy === null) {
      throw new CliError(
        "run_not_operator_controlled",
        `Run ${scope.runId} is not operator-controlled`,
      );
    }
    this.assertControlledMode(
      policy.mode,
      policy.allowedKinds,
      policy.expectedJobCount,
    );
    if (
      policy.authorizationDigest !== authorizationDigest ||
      !sameStrings(policy.allowedKinds, allowedKinds)
    ) {
      throw new CliError(
        "run_scope_mismatch",
        `operator-controlled Run ${scope.runId} does not match the requested authorization scope`,
      );
    }
    this.assertRunScopeCardinality(policy);
    return policy;
  }

  private assertRunExecutionLease(
    policy: OperatorRunPolicy,
    executionToken: string | undefined,
    timestamp: string,
  ): void {
    const execution = this.db
      .query(
        `SELECT fencing_token, lease_expires_at
         FROM operator_run_execution_leases WHERE run_id=?`,
      )
      .get(policy.runId) as {
      fencing_token: string;
      lease_expires_at: string;
    } | null;
    if (
      executionToken === undefined ||
      execution === null ||
      execution.fencing_token !== executionToken ||
      execution.lease_expires_at <= timestamp
    ) {
      throw new CliError(
        "run_scope_fenced",
        `operator-controlled Run ${policy.runId} execution lease is stale or fenced`,
      );
    }
  }

  private assertRunScopeCardinality(policy: OperatorRunPolicy): void {
    const eligible = controlledScopeJobPredicate(policy);
    const jobs = this.db
      .query(
        `SELECT id, kind, intent FROM jobs
         WHERE run_id=? AND (${eligible.sql}) ORDER BY id`,
      )
      .all(policy.runId, ...eligible.parameters) as Array<{
      id: number;
      kind: string;
      intent: string | null;
    }>;
    if (jobs.length !== policy.expectedJobCount) {
      throw new CliError(
        "run_scope_cardinality_mismatch",
        `operator-controlled Run ${policy.runId} expected ${policy.expectedJobCount} authorized jobs but found ${jobs.length}`,
      );
    }
    for (const job of jobs) {
      let intent: unknown;
      try {
        intent = job.intent === null ? null : JSON.parse(job.intent);
      } catch {
        intent = null;
      }
      if (
        intent === null ||
        typeof intent !== "object" ||
        (intent as { version?: unknown }).version !== 1 ||
        (intent as { kind?: unknown }).kind !== job.kind
      ) {
        throw new CliError(
          "run_scope_intent_mismatch",
          `operator-controlled Run ${policy.runId} job ${job.id} has an invalid kind binding`,
        );
      }
    }
    const disallowed = this.db
      .query(
        `SELECT id FROM jobs
         WHERE run_id=? AND NOT (${eligible.sql})
           AND state IN ('queued', 'running', 'retry_wait')
         ORDER BY id LIMIT 1`,
      )
      .get(policy.runId, ...eligible.parameters) as { id: number } | null;
    if (disallowed !== null) {
      throw new CliError(
        "run_scope_disallowed_runnable",
        `operator-controlled Run ${policy.runId} has runnable work outside its allowed kinds`,
      );
    }
  }

  private operatorTransition(
    jobId: number,
    toState: JobState,
    actor: string,
    reason: string,
    blockReason: string | null,
    nowInput: Date | undefined,
    resetRunAt: boolean,
  ): Job {
    const now = nowInput ?? new Date();
    const timestamp = now.toISOString();
    const transaction = this.db.transaction((): Job => {
      const job = this.requireJob(jobId);
      if (
        toState === "queued" &&
        job.kind === "source_sync" &&
        job.run_id !== null
      ) {
        const run = this.db
          .query("SELECT terminal_outcome FROM runs WHERE id=?")
          .get(job.run_id) as { terminal_outcome: string | null } | null;
        if (run !== null && run.terminal_outcome !== null) {
          throw new CliError(
            "source_run_terminal",
            "a terminal source-sync job cannot be reopened; admit a new Source Run",
          );
        }
      }
      this.assertTransition(job.state, toState);
      if (job.current_attempt_id !== null) {
        this.db
          .query(
            "UPDATE attempts SET state='stale', finished_at=? WHERE id=? AND state='leased'",
          )
          .run(timestamp, job.current_attempt_id);
      }
      this.db
        .query(
          `UPDATE jobs SET state=?, run_at=?, block_reason=?, current_attempt_id=NULL,
             updated_at=? WHERE id=?`,
        )
        .run(
          toState,
          resetRunAt ? timestamp : job.run_at,
          blockReason,
          timestamp,
          jobId,
        );
      this.recordTransition(
        jobId,
        job.current_attempt_id,
        job.state,
        toState,
        actor,
        reason,
        null,
        timestamp,
      );
      if (toState === "excluded") {
        this.cancelSourceRunForJob(job, reason, timestamp);
      }
      return this.requireJob(jobId);
    });
    return transaction.immediate();
  }

  private cancelSourceRunForJob(
    job: Job,
    reason: string,
    timestamp: string,
  ): void {
    if (job.kind !== "source_sync" || job.run_id === null) return;
    const run = this.db
      .query("SELECT source_id, terminal_outcome FROM runs WHERE id=?")
      .get(job.run_id) as {
      source_id: number | null;
      terminal_outcome: string | null;
    } | null;
    if (run === null || run.terminal_outcome !== null) return;
    this.db
      .query(
        `UPDATE runs SET state='cancelled', terminal_outcome='cancelled',
           finished_at=?, updated_at=? WHERE id=? AND terminal_outcome IS NULL`,
      )
      .run(timestamp, timestamp, job.run_id);
    if (run.source_id !== null) {
      this.db
        .query(
          `UPDATE sources SET health_state='unhealthy', health_detail=?,
             last_evaluated_at=?, updated_at=? WHERE id=?`,
        )
        .run(
          sanitizeExternalError(reason),
          timestamp,
          timestamp,
          run.source_id,
        );
    }
  }

  private guardActiveToken(
    token: number,
    now: Date,
  ):
    | { ok: true; job: Job; job_worker: string }
    | { ok: false; reason: "stale" | "fenced" | "terminal"; job: Job } {
    const attempt = this.requireAttempt(token);
    const job = this.requireJob(attempt.job_id);
    const TERMINAL: readonly JobState[] = [
      "completed",
      "failed",
      "excluded",
      "cancelled",
    ];
    if (TERMINAL.includes(job.state))
      return { ok: false, reason: "terminal", job };
    if (job.current_attempt_id !== token)
      return { ok: false, reason: "fenced", job };
    if (attempt.state !== "leased") return { ok: false, reason: "stale", job };
    if (isExpired(attempt.lease_expires_at, now))
      return { ok: false, reason: "stale", job };
    return { ok: true, job, job_worker: attempt.worker };
  }

  private assertTransition(from: JobState, to: JobState): void {
    if (!LEGAL_JOB_TRANSITIONS[from].includes(to)) {
      throw new CliError(
        "illegal_transition",
        `illegal job transition ${from} -> ${to}`,
      );
    }
  }

  private recordTransition(
    jobId: number,
    attemptId: number | null,
    fromState: JobState | null,
    toState: JobState,
    actor: string,
    reason: string | null,
    detail: string | null,
    timestamp: string,
  ): void {
    this.db
      .query(
        `INSERT INTO job_transitions(
           job_id, attempt_id, from_state, to_state, actor, reason, detail, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        attemptId,
        fromState,
        toState,
        actor,
        reason,
        detail,
        timestamp,
      );
  }

  private runIsOperatorControlled(runId: number | null | undefined): boolean {
    if (runId === null || runId === undefined) return false;
    return (
      this.db
        .query("SELECT run_id FROM operator_run_policies WHERE run_id=?")
        .get(runId) !== null
    );
  }

  private loadJobByKey(idempotencyKey: string): Job | null {
    return this.db
      .query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE idempotency_key=?`)
      .get(idempotencyKey) as Job | null;
  }

  private requireJob(jobId: number): Job {
    const job = this.db
      .query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id=?`)
      .get(jobId) as Job | null;
    if (job === null)
      throw new CliError("job_not_found", `job ${jobId} not found`);
    return job;
  }

  private requireAttempt(attemptId: number): Attempt {
    const attempt = this.db
      .query(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id=?`)
      .get(attemptId) as Attempt | null;
    if (attempt === null) {
      throw new CliError("attempt_not_found", `attempt ${attemptId} not found`);
    }
    return attempt;
  }

  private rejectUnsupportedExistingSchema(): void {
    const hasMeta = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1",
      )
      .get() as Row | null;
    if (hasMeta === null) return;
    const row = this.db
      .query("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string } | null;
    if (row === null) return;
    const version = Number(row.value);
    if (!Number.isInteger(version)) {
      throw new CliError(
        "bad_schema_version",
        "research cache schema_version is not an integer",
      );
    }
    if (version > RESEARCH_SCHEMA_VERSION) {
      throw new CliError(
        "unsupported_schema_version",
        `research cache schema version ${version} is newer than supported version ${RESEARCH_SCHEMA_VERSION}`,
      );
    }
  }

  private initializeSchema(): void {
    const hasMeta = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1",
      )
      .get();
    if (hasMeta !== null) {
      const current = this.db
        .query("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string } | null;
      if (Number(current?.value) === RESEARCH_SCHEMA_VERSION) return;
    }
    this.db
      .transaction(() => {
        this.db.exec(SCHEMA_V1);
        const row = this.db
          .query("SELECT value FROM meta WHERE key='schema_version'")
          .get() as { value: string } | null;
        const version = Number(row?.value ?? 1);
        if (!Number.isInteger(version)) {
          throw new CliError(
            "bad_schema_version",
            "research cache schema_version is not an integer",
          );
        }
        if (version > RESEARCH_SCHEMA_VERSION) {
          throw new CliError(
            "unsupported_schema_version",
            `research cache schema version ${version} is newer than supported version ${RESEARCH_SCHEMA_VERSION}`,
          );
        }
        if (version < 2) this.db.exec(MIGRATION_V2);
        if (version < 3) this.db.exec(MIGRATION_V3);
        if (version < 4) this.db.exec(MIGRATION_V4);
        if (version < 5) this.db.exec(MIGRATION_V5);
        if (version < 6) this.db.exec(MIGRATION_V6);
        if (version < 7) this.db.exec(MIGRATION_V7);
        if (version < 8) this.db.exec(MIGRATION_V8);
        if (version < 9) this.db.exec(MIGRATION_V9);
        if (version < 10) this.db.exec(MIGRATION_V10);
        if (version < 11) this.db.exec(MIGRATION_V11);
        if (version < 12) this.db.exec(MIGRATION_V12);
      })
      .immediate();
  }
}
