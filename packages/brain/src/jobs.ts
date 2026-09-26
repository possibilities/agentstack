import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ArtifactStore,
  defaultArtifactRoot,
  isSafeArtifactStoragePath,
} from "./artifacts.js";
import { ResearchCache } from "./db.js";
import { CliError } from "./errors.js";
import { findExecutable } from "./executable.js";
import { sanitizeExternalError } from "./sanitize.js";
import { RESEARCH_SCHEMA_VERSION, type ResearchStore } from "./store.js";
import type {
  Attempt,
  AttemptState,
  FailureClass,
  Job,
  JobRecord,
  JobState,
  JobTransition,
  OperatorRunMode,
  RunState,
} from "./types.js";

const JOB_STATES: readonly JobState[] = [
  "queued",
  "running",
  "retry_wait",
  "blocked",
  "failed",
  "completed",
  "excluded",
  "cancelled",
];
const ATTEMPT_STATES: readonly AttemptState[] = [
  "leased",
  "succeeded",
  "failed",
  "stale",
  "cancelled",
];
const FAILURE_CLASSES: readonly FailureClass[] = [
  "infra",
  "item_transient",
  "permanent",
  "auth_config",
];
const SAFE_CLASS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_JOB_COLUMNS = `id, kind, state, sensitivity, resource_id, source_id,
  run_id, attempt_count, item_retry_count, run_at, failure_class, created_at,
  updated_at`;

export interface SafeJob {
  id: number;
  kind: string;
  state: JobState;
  sensitivity: string;
  resource_id: number | null;
  source_id: number | null;
  run_id: number | null;
  attempt_count: number;
  item_retry_count: number;
  run_at: string;
  failure_class: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafeJobRecord extends SafeJob {
  failure_summary: string | null;
  attempts: Array<
    Omit<Attempt, "worker" | "failure_summary" | "failure_class"> & {
      failure_class: string | null;
      failure_summary: string | null;
    }
  >;
  transitions: Array<Omit<JobTransition, "actor" | "detail" | "reason">>;
}

export interface RevealedArtifact {
  content_digest: string;
  media_type: string;
  byte_size: number;
  body: string;
}

export interface RevealedJob extends SafeJobRecord {
  intent: unknown;
  artifacts: RevealedArtifact[];
}

export interface JobStats {
  total: number;
  by_state: Record<JobState, number>;
  runnable_due: number;
  active_leases: number;
  stale_leases: number;
  oldest_runnable_at: string | null;
}

export interface SafeRunRecord {
  id: number;
  run_type: string;
  source_id: number | null;
  state: RunState;
  operator_controlled: boolean;
  execution_mode: OperatorRunMode | null;
  authorization_digest: string | null;
  allowed_job_kinds: string[];
  expected_job_count: number | null;
  counts: {
    jobs: number;
    attempts: number;
    by_job_state: Record<JobState, number>;
    by_attempt_state: Record<AttemptState, number>;
    by_kind: Record<string, number>;
    by_failure_class: Record<FailureClass, number>;
  };
  quiescence: {
    runnable_due: number;
    active_leases: number;
    stale_leases: number;
    execution_active: boolean;
    quiescent: boolean;
  };
  jobs: SafeJob[];
  jobs_truncated: boolean;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "failed";
  detail: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

function safeClass(value: string): string {
  return SAFE_CLASS_PATTERN.test(value) ? value : "invalid";
}

function safeFailureClass(value: string | null): string | null {
  if (value === null) return null;
  return FAILURE_CLASSES.includes(value as FailureClass) ? value : "invalid";
}

/** Keep failure diagnostics useful without echoing submitted or final URLs. */
function safeFailureSummary(value: string | null): string | null {
  if (value === null) return null;
  return sanitizeExternalError(value).replace(
    /\bhttps?:\/\/[^\s"'<>]+/gi,
    "[URL]",
  );
}

export function safeJobView(job: Job): SafeJob {
  return {
    id: job.id,
    kind: safeClass(job.kind),
    state: job.state,
    sensitivity: job.sensitivity,
    resource_id: job.resource_id,
    source_id: job.source_id,
    run_id: job.run_id,
    attempt_count: job.attempt_count,
    item_retry_count: job.item_retry_count,
    run_at: job.run_at,
    failure_class: safeFailureClass(job.failure_class),
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function safeRecord(record: JobRecord): SafeJobRecord {
  return {
    ...safeJobView(record),
    failure_summary: safeFailureSummary(record.failure_summary),
    attempts: record.attempts.map(
      ({ worker: _worker, failure_summary, failure_class, ...attempt }) => ({
        ...attempt,
        failure_class: safeFailureClass(failure_class),
        failure_summary: safeFailureSummary(failure_summary),
      }),
    ),
    transitions: record.transitions.map(
      ({ actor: _actor, detail: _detail, reason: _reason, ...transition }) =>
        transition,
    ),
  };
}

export function parseJobState(value: string | undefined): JobState | undefined {
  if (value === undefined) return undefined;
  if (JOB_STATES.includes(value as JobState)) return value as JobState;
  throw new CliError("bad_job_state", `unknown job state '${value}'`, {
    exitCode: 2,
    recovery: `Use one of: ${JOB_STATES.join(", ")}.`,
  });
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new CliError(
      "bad_limit",
      "--limit must be an integer from 1 to 1000",
      {
        exitCode: 2,
      },
    );
  }
  return limit;
}

function jobsFor(
  cache: ResearchCache,
  options: { state?: JobState; runId?: number; limit?: number } = {},
): Job[] {
  const predicates: string[] = [];
  const parameters: Array<string | number> = [];
  if (options.state !== undefined) {
    predicates.push("state=?");
    parameters.push(options.state);
  }
  if (options.runId !== undefined) {
    if (!Number.isInteger(options.runId) || options.runId < 1) {
      throw new CliError("bad_run_id", "Run ID must be a positive integer", {
        exitCode: 2,
      });
    }
    predicates.push("run_id=?");
    parameters.push(options.runId);
  }
  const where =
    predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
  const limit = options.limit === undefined ? "" : " LIMIT ?";
  if (options.limit !== undefined) parameters.push(options.limit);
  return cache.db
    .query(
      `SELECT ${SAFE_JOB_COLUMNS} FROM jobs${where} ORDER BY run_at ASC, id ASC${limit}`,
    )
    .all(...parameters) as Job[];
}

export function listJobs(
  cache: ResearchCache,
  options: { state?: JobState; runId?: number; limit?: number } = {},
): SafeJob[] {
  const limit = boundedLimit(options.limit);
  return jobsFor(cache, { ...options, limit }).map(safeJobView);
}

export function showJob(cache: ResearchCache, jobId: number): SafeJobRecord {
  const record = cache.job(jobId);
  if (record === null)
    throw new CliError("job_not_found", `job ${jobId} not found`);
  return safeRecord(record);
}

function safeRunPolicy(
  cache: ResearchCache,
  runId: number,
): {
  mode: OperatorRunMode;
  authorizationDigest: string;
  allowedKinds: string[];
  expectedJobCount: number;
} | null {
  const row = cache.db
    .query(
      `SELECT mode, authorization_digest, allowed_job_kinds,
              expected_job_count FROM operator_run_policies WHERE run_id=?`,
    )
    .get(runId) as {
    mode: OperatorRunMode;
    authorization_digest: string;
    allowed_job_kinds: string;
    expected_job_count: number;
  } | null;
  if (row === null) return null;
  let allowedKinds: unknown;
  try {
    allowedKinds = JSON.parse(row.allowed_job_kinds);
  } catch {
    return null;
  }
  if (
    (row.mode !== "offline" && row.mode !== "online") ||
    !/^[a-f0-9]{64}$/.test(row.authorization_digest) ||
    !Array.isArray(allowedKinds) ||
    allowedKinds.length === 0 ||
    allowedKinds.some(
      (kind) => typeof kind !== "string" || !SAFE_CLASS_PATTERN.test(kind),
    ) ||
    !Number.isInteger(row.expected_job_count) ||
    row.expected_job_count < 1
  ) {
    return null;
  }
  return {
    mode: row.mode,
    authorizationDigest: row.authorization_digest,
    allowedKinds: allowedKinds as string[],
    expectedJobCount: row.expected_job_count,
  };
}

export function showRun(
  cache: ResearchCache,
  runId: number,
  options: { limit?: number; now?: Date } = {},
): SafeRunRecord {
  if (!Number.isInteger(runId) || runId < 1) {
    throw new CliError("bad_run_id", "Run ID must be a positive integer", {
      exitCode: 2,
    });
  }
  const limit = boundedLimit(options.limit);
  const now = options.now ?? new Date();
  const run = cache.db
    .query(
      `SELECT id, run_type, source_id, state, started_at, finished_at,
              created_at, updated_at FROM runs WHERE id=?`,
    )
    .get(runId) as {
    id: number;
    run_type: string;
    source_id: number | null;
    state: RunState;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  if (run === null)
    throw new CliError("run_not_found", `Run ${runId} not found`);
  const onlineStatus = cache.db
    .query("SELECT status FROM recovery_online_runs WHERE run_id=?")
    .get(runId) as { status: string } | null;
  const effectiveState: RunState =
    onlineStatus?.status === "completed_with_review"
      ? "completed_with_review"
      : run.state;

  const policy = safeRunPolicy(cache, run.id);
  const operatorControlled =
    cache.db
      .query("SELECT run_id FROM operator_run_policies WHERE run_id=?")
      .get(run.id) !== null;
  const jobsByState = Object.fromEntries(
    JOB_STATES.map((state) => [state, 0]),
  ) as Record<JobState, number>;
  const stateRows = cache.db
    .query(
      "SELECT state, COUNT(*) AS count FROM jobs WHERE run_id=? GROUP BY state",
    )
    .all(runId) as Array<{ state: JobState; count: number }>;
  for (const row of stateRows) {
    if (row.state in jobsByState) jobsByState[row.state] = row.count;
  }
  const attemptsByState = Object.fromEntries(
    ATTEMPT_STATES.map((state) => [state, 0]),
  ) as Record<AttemptState, number>;
  const attemptRows = cache.db
    .query(
      `SELECT a.state, COUNT(*) AS count FROM attempts a
       JOIN jobs j ON j.id=a.job_id WHERE j.run_id=? GROUP BY a.state`,
    )
    .all(runId) as Array<{ state: AttemptState; count: number }>;
  for (const row of attemptRows) {
    if (row.state in attemptsByState) attemptsByState[row.state] = row.count;
  }
  const failures = Object.fromEntries(
    FAILURE_CLASSES.map((failureClass) => [failureClass, 0]),
  ) as Record<FailureClass, number>;
  const failureRows = cache.db
    .query(
      `SELECT a.failure_class, COUNT(*) AS count FROM attempts a
       JOIN jobs j ON j.id=a.job_id
       WHERE j.run_id=? AND a.failure_class IS NOT NULL GROUP BY a.failure_class`,
    )
    .all(runId) as Array<{ failure_class: FailureClass; count: number }>;
  for (const row of failureRows) {
    if (row.failure_class in failures) failures[row.failure_class] = row.count;
  }
  const kinds: Record<string, number> = {};
  const kindRows = cache.db
    .query(
      "SELECT kind, COUNT(*) AS count FROM jobs WHERE run_id=? GROUP BY kind",
    )
    .all(runId) as Array<{ kind: string; count: number }>;
  for (const row of kindRows) {
    const kind = safeClass(row.kind);
    kinds[kind] = (kinds[kind] ?? 0) + row.count;
  }
  const leaseRows = cache.db
    .query(
      `SELECT a.lease_expires_at FROM attempts a
       JOIN jobs j ON j.id=a.job_id WHERE j.run_id=? AND a.state='leased'`,
    )
    .all(runId) as Array<{ lease_expires_at: string }>;
  const runnable = cache.db
    .query(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE run_id=? AND state IN ('queued', 'retry_wait') AND run_at<=?`,
    )
    .get(runId, now.toISOString()) as { count: number };
  const executionLease = cache.db
    .query(
      `SELECT lease_expires_at FROM operator_run_execution_leases
       WHERE run_id=?`,
    )
    .get(runId) as { lease_expires_at: string } | null;
  const visibleJobs = jobsFor(cache, { runId, limit });
  const jobCount = stateRows.reduce((sum, row) => sum + row.count, 0);
  const attemptCount = attemptRows.reduce((sum, row) => sum + row.count, 0);
  const staleLeases = leaseRows.filter(
    (lease) => Date.parse(lease.lease_expires_at) <= now.getTime(),
  ).length;
  const activeLeases = leaseRows.length - staleLeases;
  const executionActive =
    executionLease !== null &&
    Date.parse(executionLease.lease_expires_at) > now.getTime();
  return {
    id: run.id,
    run_type: safeClass(run.run_type),
    source_id: run.source_id,
    state: effectiveState,
    operator_controlled: operatorControlled,
    execution_mode: policy?.mode ?? null,
    authorization_digest: policy?.authorizationDigest ?? null,
    allowed_job_kinds: policy?.allowedKinds ?? [],
    expected_job_count: policy?.expectedJobCount ?? null,
    counts: {
      jobs: jobCount,
      attempts: attemptCount,
      by_job_state: jobsByState,
      by_attempt_state: attemptsByState,
      by_kind: kinds,
      by_failure_class: failures,
    },
    quiescence: {
      runnable_due: runnable.count,
      active_leases: activeLeases,
      stale_leases: staleLeases,
      execution_active: executionActive,
      quiescent: activeLeases === 0 && !executionActive,
    },
    jobs: visibleJobs.map(safeJobView),
    jobs_truncated: jobCount > limit,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

function artifactDescriptors(intent: unknown): Array<{
  content_digest: string;
  media_type: string;
  byte_size: number;
}> {
  if (intent === null || typeof intent !== "object") return [];
  const payload = (intent as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (value.text !== undefined) candidates.push(value.text);
  if (value.file !== undefined) candidates.push(value.file);
  const directory = value.directory as { artifacts?: unknown[] } | undefined;
  if (Array.isArray(directory?.artifacts))
    candidates.push(...directory.artifacts);
  return candidates.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.content_digest !== "string" ||
      typeof item.media_type !== "string" ||
      typeof item.byte_size !== "number"
    )
      return [];
    return [
      {
        content_digest: item.content_digest,
        media_type: item.media_type,
        byte_size: item.byte_size,
      },
    ];
  });
}

export function revealJob(
  store: ResearchStore,
  jobId: number,
  options: {
    artifactStore?: ArtifactStore;
    actor?: string;
    maxBytes?: number;
  } = {},
): RevealedJob {
  const row = store.db
    .query("SELECT intent FROM jobs WHERE id=?")
    .get(jobId) as {
    intent: string | null;
  } | null;
  if (row === null)
    throw new CliError("job_not_found", `job ${jobId} not found`);
  let intent: unknown = null;
  if (row.intent !== null) {
    try {
      intent = JSON.parse(row.intent);
    } catch {
      throw new CliError(
        "invalid_intent",
        `job ${jobId} has an invalid durable intent`,
      );
    }
  }
  const artifacts = options.artifactStore ?? new ArtifactStore();
  const bodies = artifactDescriptors(intent).map((artifact) => ({
    ...artifact,
    body: artifacts.readUtf8(artifact.content_digest, options.maxBytes),
  }));
  store.recordSensitiveInspection({
    jobId,
    actor: options.actor ?? "operator",
    detail: `revealed ${bodies.length} Artifact bodies`,
  });
  const cache = new ResearchCache(store.dbPath);
  try {
    return { ...showJob(cache, jobId), intent, artifacts: bodies };
  } finally {
    cache.close();
  }
}

function tableExists(cache: ResearchCache, name: string): boolean {
  return (
    cache.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      )
      .get(name) !== null
  );
}

export function jobStats(
  cache: ResearchCache,
  now = new Date(),
  options: { runId?: number } = {},
): JobStats {
  const rows = jobsFor(cache, { runId: options.runId });
  const byState = Object.fromEntries(
    JOB_STATES.map((state) => [state, 0]),
  ) as Record<JobState, number>;
  for (const row of rows) byState[row.state] += 1;
  const due = rows.filter(
    (row) =>
      (row.state === "queued" || row.state === "retry_wait") &&
      Date.parse(row.run_at) <= now.getTime(),
  );
  const leases = tableExists(cache, "attempts")
    ? options.runId === undefined
      ? (cache.db
          .query("SELECT lease_expires_at FROM attempts WHERE state='leased'")
          .all() as Array<{ lease_expires_at: string }>)
      : (cache.db
          .query(
            `SELECT a.lease_expires_at FROM attempts a
             JOIN jobs j ON j.id=a.job_id
             WHERE a.state='leased' AND j.run_id=?`,
          )
          .all(options.runId) as Array<{ lease_expires_at: string }>)
    : [];
  const staleLeases = leases.filter(
    (lease) => Date.parse(lease.lease_expires_at) <= now.getTime(),
  ).length;
  return {
    total: rows.length,
    by_state: byState,
    runnable_due: due.length,
    active_leases: leases.length - staleLeases,
    stale_leases: staleLeases,
    oldest_runnable_at: due.map((row) => row.run_at).sort()[0] ?? null,
  };
}

export interface JobDispositions {
  /** Blocked or failed after an attempt recorded a failure class. */
  stranded: number;
  blocked_after_failure: number;
  failed: number;
  /** Blocked by admission before any attempt, pending an operator decision. */
  awaiting_review: number;
}

/**
 * Separate ingestion that broke from ingestion an operator never authorized.
 *
 * Both land in blocked, but only one is evidence of a defect: a failure class
 * is written by an attempt, so its absence means no attempt was ever made.
 */
export function jobDispositions(cache: ResearchCache): JobDispositions {
  if (!tableExists(cache, "jobs"))
    return {
      stranded: 0,
      blocked_after_failure: 0,
      failed: 0,
      awaiting_review: 0,
    };
  const row = cache.db
    .query(
      `SELECT
         COUNT(*) FILTER (
           WHERE state='blocked' AND failure_class IS NOT NULL
         ) AS blocked_after_failure,
         COUNT(*) FILTER (WHERE state='failed') AS failed,
         COUNT(*) FILTER (
           WHERE state='blocked' AND failure_class IS NULL
         ) AS awaiting_review
       FROM jobs`,
    )
    .get() as {
    blocked_after_failure: number;
    failed: number;
    awaiting_review: number;
  };
  return {
    stranded: row.blocked_after_failure + row.failed,
    blocked_after_failure: row.blocked_after_failure,
    failed: row.failed,
    awaiting_review: row.awaiting_review,
  };
}

/**
 * `extra` carries checks that cannot be answered from the database alone — the
 * share ingress probe is one, since only a completed request proves a bound
 * socket still serves. They are resolved by the caller and folded in here so
 * `healthy` accounts for every check the report shows.
 */
/**
 * What a device client may learn about the shares it submitted.
 *
 * Keyed by job id, which the client already holds from its own acknowledgement:
 * this answers "what became of the thing I sent", never "what is in the
 * ledger". It carries no locator, title, or body — a client that needs the
 * content already had it — and an unknown id is simply absent rather than
 * distinguishable from one belonging to somebody else's share.
 */
export interface ShareJobState {
  job_id: number;
  state: JobState;
  failure_class: string | null;
  document_id: number | null;
}

export function shareJobStates(
  store: Pick<ResearchStore, "db">,
  ids: number[],
): ShareJobState[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = store.db
    .query(
      `SELECT j.id AS job_id, j.state, j.failure_class, r.document_id
         FROM jobs j
         LEFT JOIN resources r ON r.id = j.resource_id
        WHERE j.id IN (${placeholders})
        ORDER BY j.id`,
    )
    .all(...ids) as Array<{
    job_id: number;
    state: JobState;
    failure_class: string | null;
    document_id: number | null;
  }>;
  return rows.map((row) => ({
    job_id: row.job_id,
    state: row.state,
    failure_class:
      row.failure_class === null ? null : safeClass(row.failure_class),
    document_id: row.document_id,
  }));
}

export function doctor(
  cache: ResearchCache,
  now = new Date(),
  extra: DoctorCheck[] = [],
): DoctorReport {
  const checks: DoctorCheck[] = [];
  try {
    const quick = cache.db.query("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    checks.push({
      name: "database_integrity",
      status: quick.quick_check === "ok" ? "ok" : "failed",
      detail:
        quick.quick_check === "ok"
          ? "SQLite quick check passed"
          : "SQLite quick check reported defects",
    });
  } catch {
    checks.push({
      name: "database_integrity",
      status: "failed",
      detail: "SQLite quick check failed",
    });
  }

  const schema = tableExists(cache, "meta")
    ? (cache.db
        .query("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string } | null)
    : null;
  const schemaVersion = Number(schema?.value);
  checks.push({
    name: "schema_version",
    status: schemaVersion === RESEARCH_SCHEMA_VERSION ? "ok" : "failed",
    detail:
      schemaVersion === RESEARCH_SCHEMA_VERSION
        ? `Schema version ${RESEARCH_SCHEMA_VERSION}`
        : "Schema is not at the supported version",
  });

  const artifacts = tableExists(cache, "artifacts")
    ? (cache.db
        .query("SELECT content_hash, storage_path FROM artifacts ORDER BY id")
        .all() as Array<{
        content_hash: string;
        storage_path: string | null;
      }>)
    : [];
  const root = defaultArtifactRoot();
  let missing = 0;
  let invalid = 0;
  for (const artifact of artifacts) {
    try {
      if (
        artifact.storage_path === null ||
        !isSafeArtifactStoragePath(artifact.storage_path, artifact.content_hash)
      ) {
        invalid += 1;
        continue;
      }
    } catch {
      invalid += 1;
      continue;
    }
    if (!existsSync(join(root, artifact.storage_path))) missing += 1;
  }
  checks.push({
    name: "artifact_references",
    status: missing === 0 && invalid === 0 ? "ok" : "failed",
    detail:
      missing === 0 && invalid === 0
        ? `${artifacts.length} Artifact references present`
        : `${missing} missing and ${invalid} invalid Artifact references`,
  });

  const stats = jobStats(cache, now);
  checks.push({
    name: "leases",
    status: stats.stale_leases === 0 ? "ok" : "warning",
    detail: `${stats.active_leases} active, ${stats.stale_leases} expired`,
  });
  // A job in blocked or failed with a recorded failure class has stopped moving
  // and no retry will revive it, yet admission already acknowledged the
  // submitter. Without this check the report stays healthy while shared links
  // silently never become searchable. Excluded and cancelled are operator
  // dispositions, so they are not stranded.
  //
  // A job blocked without a failure class never ran: admission itself withheld
  // it, as the recovery import does when a disposition reserves the decision
  // for an operator. That is an undecided question, not a broken ingestion, and
  // conflating the two would report breakage that does not exist.
  const disposition = jobDispositions(cache);
  const triageCommands = [
    disposition.blocked_after_failure > 0
      ? "node packages/brain/dist/src/cli.js jobs list --state blocked"
      : null,
    disposition.failed > 0 ? "node packages/brain/dist/src/cli.js jobs list --state failed" : null,
  ].filter((command): command is string => command !== null);
  checks.push({
    name: "stranded_ingestion",
    status: disposition.stranded === 0 ? "ok" : "failed",
    detail:
      disposition.stranded === 0
        ? "No stranded ingestion jobs"
        : `${disposition.stranded} stranded ingestion jobs (${disposition.blocked_after_failure} blocked, ${disposition.failed} failed); triage with ${triageCommands.join(" and ")}, then inspect with node packages/brain/dist/src/cli.js jobs show <id> --json`,
  });
  checks.push({
    name: "admission_review",
    status: disposition.awaiting_review === 0 ? "ok" : "warning",
    detail:
      disposition.awaiting_review === 0
        ? "No jobs awaiting admission review"
        : `${disposition.awaiting_review} jobs withheld at admission awaiting an operator decision`,
  });
  const agentscrape = findExecutable("agentscrape");
  checks.push({
    name: "agentscrape",
    status: agentscrape === null ? "failed" : "ok",
    detail:
      agentscrape === null
        ? "Agentscrape executable not found"
        : "Agentscrape executable found",
  });
  checks.push(...extra);
  return {
    healthy: checks.every((check) => check.status !== "failed"),
    checks,
  };
}
