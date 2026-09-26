import type { SourceRunOutcome } from "./source-types.js";

export type * from "./source-types.js";

export const SCHEMA_VERSION = 1;

export type OutputFormat = "human" | "json" | "jsonl";
export type SearchMode = "any" | "all" | "raw";
export type AdmissionStatus = "queued" | "duplicate";
export type AdmissionWaitStatus = "terminal" | "timeout";

export type RecoveryDisposition =
  | "approved_online_backfill_telegram_human"
  | "exclude_infrastructure"
  | "exclude_probable_test"
  | "import_offline"
  | "review"
  | "review_discord"
  | "review_fetch"
  | "review_retry"
  | "review_telegram_bot_generated";

export interface RecoveryImportCounts {
  candidate_rows: number;
  baseline_candidate_rows: number;
  appended_candidate_rows: number;
  telegram_candidate_rows: number;
  telegram_observations: number;
  telegram_provenance_merges: number;
  catalog_memberships: number;
  approved_offline_artifacts: number;
  approved_online_jobs: number;
  blocked_review_jobs: number;
  excluded_candidates: number;
  evidence_only_candidates: number;
}

export interface RecoveryImportReport {
  schema_version: 1;
  status: "verified" | "queued";
  dry_run: boolean;
  generation_id: string;
  counts: RecoveryImportCounts;
  dispositions: Record<RecoveryDisposition, number>;
  jobs: {
    queued: number;
    blocked: number;
    excluded: number;
    evidence_only: number;
    created: number;
    existing: number;
  };
  effects: {
    candidate_outcomes_created: number;
    candidate_outcomes_existing: number;
    observations_created: number;
    observations_existing: number;
    artifacts_created: number;
    artifacts_existing: number;
  };
  run: {
    id: number | null;
    state: "verified" | "pending";
    operator_controlled: boolean;
    authorization_digest: string | null;
    allowed_job_kinds: string[];
    expected_job_count: number | null;
  };
}

export type ChunkBlockType =
  | "text"
  | "heading"
  | "paragraph"
  | "list"
  | "code"
  | "table"
  | "blockquote"
  | "thematic_break"
  | "html"
  | "definition"
  | "other";

export interface ChunkStructuralProvenance {
  structural_anchor: string;
  heading_path: string[];
  start_line: number;
  end_line: number;
  block_types: ChunkBlockType[];
  revision_digest: string;
  chunker_version: string;
  chunk_digest: string;
  duplicate_ordinal: number;
  chunk_identity: string;
}

export interface GlobalOptions {
  dbPath: string;
  format: OutputFormat;
  quiet: boolean;
}

export interface Envelope<T> {
  schema_version: typeof SCHEMA_VERSION;
  ok: true;
  command: string;
  data: T;
  meta: {
    db_path: string;
    read_only: boolean;
    generated_at: string;
  };
}

export interface ErrorEnvelope {
  schema_version: typeof SCHEMA_VERSION;
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    recovery?: string;
  };
}

export interface RelationStats {
  relation_count: number;
  failed_relation_count: number;
}

export interface StatsData extends RelationStats {
  db_path: string;
  db_size_bytes: number;
  document_count: number;
  chunk_count: number;
  total_chars: number;
  by_source_type: Array<{ source_type: string; count: number }>;
  top_tags: Array<{ tag: string; count: number }>;
  recent: Array<{
    document_id: number;
    title: string | null;
    source_uri: string;
    source_type: string;
    updated_at: string;
  }>;
}

export interface SourceSummary {
  source_type: string;
  identifier: string;
}

export interface RelationSummary {
  relation_id: number;
  direction: "outbound" | "inbound";
  relation_type: string;
  status: string;
  linked_document_id: number;
  linked_resource_id: number | null;
  linked_title: string | null;
  linked_resource_kind: string;
  linked_sensitivity: Sensitivity;
}

export type ContentKind = "post" | "thread" | "article";

export interface SearchResult {
  document_id: number;
  resource_id: number | null;
  resource_kind: string;
  sensitivity: Sensitivity;
  collections: string[];
  sources: SourceSummary[];
  relations: RelationSummary[];
  chunk_id: number;
  chunk_index: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  content_kind: ContentKind | null;
  content_item_count: number | null;
  tags: string[];
  updated_at: string;
  start_char: number;
  end_char: number;
  score: number;
  snippet: string;
}

export interface SearchData {
  query: string;
  normalized_query: string;
  mode: SearchMode;
  limit: number;
  offset: number;
  filters: {
    tag?: string;
    source_type?: string;
    content_kind?: ContentKind;
    collection?: string;
    source?: string;
    resource_kind?: string;
    sensitivity?: Sensitivity;
    date?: string;
    date_from?: string;
    date_to?: string;
    local_path?: string;
  };
  results: SearchResult[];
  next_offset: number | null;
}

export interface ContextHit {
  document_id: number;
  resource_id: number | null;
  resource_kind: string;
  sensitivity: Sensitivity;
  collections: string[];
  sources: SourceSummary[];
  relations: RelationSummary[];
  chunk_id: number;
  chunk_index: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  content_kind: ContentKind | null;
  content_item_count: number | null;
  tags: string[];
  start_char: number;
  end_char: number;
  score: number;
  citation: string;
  content: string;
  truncated: boolean;
}

export interface ContextData {
  query: string;
  filters: SearchData["filters"];
  limit: number;
  max_chars: number;
  returned_chars: number;
  truncated: boolean;
  hits: ContextHit[];
}

export interface DocumentLink {
  id: number;
  from_document_id: number;
  to_document_id: number | null;
  relation_type: string;
  discovered_url: string | null;
  resolved_url: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentData {
  document_id: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  content_kind: ContentKind | null;
  content_item_count: number | null;
  tags: string[];
  notes: string | null;
  size_chars: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  content: string;
  outbound_links: DocumentLink[];
  inbound_links: DocumentLink[];
  truncation: {
    requested_char_limit: number | null;
    returned_chars: number;
    omitted_chars: number;
  };
}

export interface ChunkData {
  chunk_id: number;
  document_id: number;
  chunk_index: number;
  start_char: number;
  end_char: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  content_kind: ContentKind | null;
  content_item_count: number | null;
  tags: string[];
  content: string;
}

export interface TagsData {
  tags: Array<{ tag: string; count: number }>;
}

export interface SourcesData {
  source_types: Array<{ source_type: string; count: number }>;
  domains: Array<{ domain: string; count: number }>;
}

/**
 * Durable ingestion domain records (schema v3). Sensitivity is an inherited
 * handling policy drawn from a closed, ranked vocabulary, never a free tag.
 */
export type Sensitivity = "public" | "normal" | "sensitive" | "private";

export interface Resource {
  id: number;
  key_type: string;
  key_value: string;
  kind: string;
  sensitivity: Sensitivity;
  document_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceAlias {
  id: number;
  resource_id: number;
  alias_type: string;
  locator: string;
  evidence: string | null;
  first_observed_at: string;
  last_observed_at: string;
}

export interface ResourceRecord extends Resource {
  aliases: ResourceAlias[];
}

export interface Artifact {
  id: number;
  content_hash: string;
  media_type: string;
  byte_size: number;
  artifact_role: string;
  sensitivity: Sensitivity;
  storage_path: string | null;
  created_at: string;
}

export interface Collection {
  id: number;
  slug: string;
  title: string;
  sensitivity: Sensitivity;
  created_at: string;
  updated_at: string;
}

export interface CollectionMembership {
  id: number;
  collection_id: number;
  resource_id: number;
  position: number | null;
  external_ref: string | null;
  added_at: string;
}

export type ResourceRelationType = "content_link" | "article" | "quoted_post";

export type FanoutSuppressionReason =
  | "self_reference"
  | "duplicate_destination"
  | "excluded_x_chrome"
  | "excluded_media"
  | "unsafe_destination"
  | "relation_target_mismatch"
  | "operator_controlled_run"
  | "ineligible_root"
  | "fanout_limit"
  | "one_hop_limit";

export interface ResourceRelation {
  id: number;
  from_resource_id: number;
  to_resource_id: number;
  relation_type: ResourceRelationType;
  source_job_id: number;
  observed_url: string;
  discovery_ordinal: number;
  created_at: string;
  updated_at: string;
}

export interface Observation {
  id: number;
  resource_id: number;
  parent_resource_id: number | null;
  source_job_id: number | null;
  source_id: number | null;
  run_id: number | null;
  ingress: string;
  relation_type: ResourceRelationType | null;
  discovery_ordinal: number | null;
  observed_locator: string | null;
  suppressed: boolean;
  suppressed_reason: string | null;
  observed_at: string;
}

export interface FanoutDiscovery {
  ordinal: number;
  relationType: ResourceRelationType;
  targetUrl: string;
  canonicalUrl: string;
  resourceKey: { type: string; value: string };
  childIdempotencyKey: string;
  childIntent: string;
  suppressionReason: FanoutSuppressionReason | null;
}

export interface ExtractionFanoutPlan {
  discoveries: FanoutDiscovery[];
}

export type RunState =
  | "pending"
  | "active"
  | "completed"
  | "completed_with_review"
  | "failed"
  | "cancelled";

export type OperatorRunMode = "offline" | "online";

export interface OperatorRunScope {
  runId: number;
  authorizationDigest: string;
  allowedKinds: string[];
}

export interface OperatorRunPolicy extends OperatorRunScope {
  mode: OperatorRunMode;
  expectedJobCount: number;
}

export interface OperatorRunExecution extends OperatorRunPolicy {
  executionToken: string;
}

export interface Run {
  id: number;
  run_type: string;
  source_id: number | null;
  state: RunState;
  checkpoint: string | null;
  attempted_cursor: string | null;
  committed_checkpoint: string | null;
  warnings: string;
  discovered_count: number;
  admitted_count: number;
  suppressed_count: number;
  terminal_outcome: SourceRunOutcome | null;
  source_definition_version: number | null;
  schedule_key: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Provenance {
  id: number;
  resource_id: number;
  evidence_type: string;
  source_id: number | null;
  run_id: number | null;
  artifact_id: number | null;
  relation_id: number | null;
  ingress: string | null;
  raw_metadata: string | null;
  observed_at: string;
}

/**
 * Durable ingestion job lifecycle (schema v4). A job is one immutable intent;
 * every leased execution appends an immutable attempt; state changes append an
 * audited transition. See ADR 0004.
 */
export type JobState =
  | "queued"
  | "running"
  | "retry_wait"
  | "blocked"
  | "failed"
  | "completed"
  | "excluded"
  | "cancelled";

export type AttemptState =
  | "leased"
  | "succeeded"
  | "failed"
  | "stale"
  | "cancelled";

/**
 * How an attempt failed, which decides routing: infrastructure is retried
 * indefinitely, item-specific transient failure has a bounded budget before it
 * blocks, permanent failure stops, and auth/config failure blocks.
 */
export type FailureClass =
  | "infra"
  | "item_transient"
  | "permanent"
  | "auth_config";

export type ExtractionFailureClass =
  | "invalid_request"
  | "authentication_required"
  | "upstream_unavailable"
  | "timeout"
  | "browser_error"
  | "provider_error"
  | "malformed_provider_output"
  | "empty_content"
  | "output_limit_exceeded"
  | "cancelled"
  | "internal_error";

export interface ExtractionArtifact {
  artifact_type: "document";
  media_type: "text/markdown";
  encoding: "utf-8";
  content: string;
  size_bytes: number;
  sha256: string;
}

export interface ExtractionMetadata {
  content_type: "web_page" | "social_post" | "article";
  content_kind?: ContentKind;
  content_item_count?: number;
  title: string;
  author_name: string;
  author_handle: string;
  published_at: string;
  source_id: string;
  warnings: Array<"partial_content">;
}

export interface ExtractionRelation {
  relation_type: "references" | ResourceRelationType;
  target_url: string;
}

export interface ExtractorIdentity {
  name: "agentscrape";
  version: string;
  implementation: string;
  implementation_version: string;
}

export interface HistoricalExtractorIdentity {
  name: string;
  version: string;
  implementation: string;
  implementation_version: string;
}

export interface ExtractionFailureDetail {
  failure_class: ExtractionFailureClass;
  retryable: boolean;
  message: string;
  evidence: string;
}

interface ExtractionEnvelopeBase {
  schema_version: "1";
  requested_url: string;
  final_url: string | null;
  extractor: ExtractorIdentity;
  artifacts: ExtractionArtifact[];
  metadata: ExtractionMetadata | null;
  relations: ExtractionRelation[];
  failure: ExtractionFailureDetail | null;
}

export interface ExtractionSuccess extends ExtractionEnvelopeBase {
  status: "success";
  final_url: string;
  artifacts: [ExtractionArtifact];
  metadata: ExtractionMetadata;
  failure: null;
}

export interface ExtractionFailure extends ExtractionEnvelopeBase {
  status: "failure";
  artifacts: [];
  metadata: null;
  relations: [];
  failure: ExtractionFailureDetail;
}

export type ExtractionEnvelope = ExtractionSuccess | ExtractionFailure;

interface PromotedUrlExtractionBase {
  requested_url: string;
  final_url: string;
  artifact: Omit<ExtractionArtifact, "content"> & {
    artifact_role: "extracted_markdown";
    storage_path: string;
  };
  metadata: ExtractionMetadata;
  relations: ExtractionRelation[];
}

export interface PromotedUrlExtraction extends PromotedUrlExtractionBase {
  record_version: 1;
  extractor: HistoricalExtractorIdentity;
}

export interface Job {
  id: number;
  idempotency_key: string;
  kind: string;
  intent: string | null;
  resource_id: number | null;
  source_id: number | null;
  run_id: number | null;
  state: JobState;
  sensitivity: Sensitivity;
  attempt_count: number;
  item_retry_count: number;
  current_attempt_id: number | null;
  run_at: string;
  block_reason: string | null;
  failure_class: FailureClass | null;
  failure_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface Attempt {
  id: number;
  job_id: number;
  attempt_number: number;
  worker: string;
  state: AttemptState;
  lease_expires_at: string;
  heartbeat_at: string;
  failure_class: FailureClass | null;
  failure_summary: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface JobTransition {
  id: number;
  job_id: number;
  attempt_id: number | null;
  from_state: JobState | null;
  to_state: JobState;
  actor: string;
  reason: string | null;
  detail: string | null;
  created_at: string;
}

export interface JobRecord extends Job {
  attempts: Attempt[];
  transitions: JobTransition[];
}

/**
 * Retry and lease durations are policy, not identity: defaults are configurable
 * and testable without changing persisted job semantics or idempotency keys.
 */
export interface LifecyclePolicy {
  leaseMs: number;
  maxItemRetries: number;
  infraBaseMs: number;
  infraCapMs: number;
  itemBaseMs: number;
  itemCapMs: number;
  jitterRatio: number;
}

/** Outcome of a fenced heartbeat/completion/failure that lost its claim. */
export interface FencedResult {
  ok: false;
  reason: "stale" | "fenced" | "terminal";
  job: Job;
}

export type ClaimResult =
  | { claimed: false }
  | { claimed: true; job: Job; attempt: Attempt; fencing_token: number };

export type HeartbeatResult =
  | { ok: true; job: Job; attempt: Attempt }
  | FencedResult;

export type CompleteResult =
  | { ok: true; idempotent: boolean; job: Job }
  | FencedResult;

export type FailResult =
  | { ok: true; job: Job; attempt: Attempt; disposition: JobState }
  | FencedResult;

export type CancelResult =
  | { ok: true; job: Job }
  | { ok: false; reason: "already_completed"; job: Job };

export interface RecoveredLease {
  job_id: number;
  attempt_id: number;
  disposition: JobState;
}
