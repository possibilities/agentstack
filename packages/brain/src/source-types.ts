import type { JobState, RunState, Sensitivity } from "./types.js";

export const SOURCE_MANIFEST_VERSION = 1 as const;
export const SOURCE_RUN_INTENT_VERSION = 1 as const;

export type KnownSourceKind = "blog_feed" | "blog_source" | "x_account";

export interface SourceSchedule {
  cadence_seconds: number;
}

export interface SourceLimits {
  max_items_per_run: number;
  max_pages_per_run: number;
}

export interface BlogSourcePayload {
  homepage_url?: string;
  feed_url?: string;
  [key: string]: unknown;
}

export interface XAccountSourcePayload {
  account_id?: string;
  handle: string;
  profile_url?: string;
  [key: string]: unknown;
}

export interface UnknownSourcePayload {
  [key: string]: unknown;
}

export interface SourceDefinition {
  id: string;
  version: number;
  kind: KnownSourceKind | (string & {});
  display_name: string;
  enabled: boolean;
  payload: BlogSourcePayload | XAccountSourcePayload | UnknownSourcePayload;
  schedule: SourceSchedule;
  limits: SourceLimits;
  collections: string[];
  sensitivity: Sensitivity;
  credential_refs: string[];
}

export interface SourceManifest {
  schema_version: typeof SOURCE_MANIFEST_VERSION;
  sources: SourceDefinition[];
}

export interface SourceManifestOverlay {
  schema_version: typeof SOURCE_MANIFEST_VERSION;
  sources: Array<Record<string, unknown> & { id: string }>;
}

export type SourceHealthState = "never" | "healthy" | "warning" | "unhealthy";

export type SourceRunOutcome = "success" | "partial" | "failed" | "cancelled";

export interface SourceRunCounts {
  discovered: number;
  admitted: number;
  suppressed: number;
}

export interface Source {
  id: number;
  source_type: string;
  identifier: string;
  display_name: string | null;
  enabled: boolean;
  sensitivity: Sensitivity;
  schedule: string | null;
  checkpoint: string | null;
  definition_version: number;
  definition: string;
  definition_hash: string;
  collections: string;
  limits: string;
  credential_refs: string;
  paused: boolean;
  pause_reason: string | null;
  health_state: SourceHealthState;
  health_detail: string | null;
  last_evaluated_at: string | null;
  last_success_at: string | null;
  next_due_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SourceAuditAction = "config_applied" | "paused" | "resumed";

export interface SourceAuditEvent {
  id: number;
  source_id: number;
  action: SourceAuditAction;
  actor: string;
  reason: string | null;
  definition_version: number;
  definition_hash: string;
  created_at: string;
}

export interface SourceCheckpoint {
  id: number;
  source_id: number;
  run_id: number;
  definition_version: number;
  value: string;
  committed_at: string;
}

export interface SourceRunIntent {
  version: typeof SOURCE_RUN_INTENT_VERSION;
  kind: "source_sync";
  source_id: number;
  stable_source_id: string;
  source_kind: string;
  source_definition_version: number;
  run_id: number;
}

export type SourceSyncAdmissionStatus =
  | "queued"
  | "duplicate"
  | "would_queue"
  | "not_due"
  | "disabled"
  | "paused"
  | "unsupported";

export interface SourceSyncAdmission {
  source_id: string;
  source_database_id: number;
  status: SourceSyncAdmissionStatus;
  run_id: number | null;
  job_id: number | null;
  scheduled_for: string | null;
  dry_run: boolean;
}

/** Stable scheduler-facing view of one admitted source-sync Run. */
export interface SourceRunStatus {
  source_id: string;
  run_id: number;
  run_state: RunState;
  outcome: SourceRunOutcome | null;
  terminal: boolean;
  warnings: number;
  counts: SourceRunCounts;
  checkpoint_committed: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  job: {
    id: number;
    state: JobState;
    failure_class: string | null;
    failure_summary: string | null;
  } | null;
}

export interface SourceSyncWaitResult {
  admission: SourceSyncAdmission;
  execution: SourceRunStatus | null;
  timed_out: boolean;
}

export interface SourceListItem {
  id: string;
  database_id: number;
  version: number;
  kind: string;
  display_name: string;
  enabled: boolean;
  paused: boolean;
  executable: boolean;
  schedule: SourceSchedule | null;
  sensitivity: Sensitivity;
  collections: string[];
  limits: SourceLimits | null;
  credential_reference_count: number;
  created_at: string;
  updated_at: string;
}

export interface SourceDetail extends SourceListItem {
  payload: Record<string, unknown>;
  pause_reason: string | null;
  health: {
    state: SourceHealthState;
    detail: string | null;
    last_evaluated_at: string | null;
    last_success_at: string | null;
    next_due_at: string | null;
  };
  checkpoint: {
    present: boolean;
    run_id: number | null;
    committed_at: string | null;
  };
}

export interface SourceStatus extends SourceDetail {
  due: boolean;
  latest_run: {
    id: number;
    state: RunState;
    outcome: SourceRunOutcome | null;
    warnings: number;
    counts: SourceRunCounts;
    created_at: string;
    finished_at: string | null;
  } | null;
}
