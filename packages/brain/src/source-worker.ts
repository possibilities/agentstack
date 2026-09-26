import { createHash } from "node:crypto";
import {
  canonicalSubmissionIntent,
  type DurableSubmissionIntent,
} from "./admission.js";
import {
  AgentscrapeDiscoveryError,
  type FeedDiscoveryEnvelope,
  type FeedDiscoveryItem,
  type SourceDiscoveryProvider,
  sourceDiscoveryWithAgentscrape,
  validateFeedDiscoveryEnvelope,
  validateXTimelineDiscoveryEnvelope,
  type XTimelineDiscoveryEnvelope,
  type XTimelineItem,
} from "./agentscrape.js";
import { CliError } from "./errors.js";
import { sanitizeExternalError } from "./sanitize.js";
import {
  type SourceObservationAdmission,
  SourceRegistry,
  type SourceRunExecutionContext,
} from "./sources.js";
import type { ResearchStore } from "./store.js";
import type { FailureClass, Job, Run } from "./types.js";
import { normalizedWebUrl, xStatusId } from "./url.js";

const X_SOURCE_OVERLAP_ITEMS = 5;
const MAX_SOURCE_WARNINGS = 100;
const DEFAULT_SOURCE_MAX_BYTES = 5_000_000;

interface BlogCheckpoint {
  version: 1;
  kind: "blog_feed";
  validators: { etag: string | null; last_modified: string | null };
  /** Conditional validators are valid only for this configured/effective retrieval pair. */
  retrieval_source_url?: string;
  validator_source_url?: string | null;
  source_definition_version?: number;
  newest_seen_at: string | null;
  recent_entries: Array<{ stable_id: string; observed_version: string }>;
}

interface XCheckpoint {
  version: 1;
  kind: "x_account";
  account_handle?: string;
  profile_url?: string;
  source_definition_version?: number;
  since_id: string | null;
  recent_ids: string[];
  newest_seen_at: string | null;
}

export interface SourceRunDispatchOptions {
  discovery?: SourceDiscoveryProvider;
  signal?: AbortSignal;
  now?: () => Date;
  /** Test-only crash seam inside the fanout/Checkpoint transaction. */
  beforeCheckpointCommit?: () => void;
}

export interface PreparedSourceRunDispatch {
  runId: number;
  disposition: "success" | "partial";
  commit(now?: Date): Run;
}

/**
 * A discovery failure carries the fenced evidence mutation that must commit in
 * the same transaction as the worker attempt's retry/block/failure outcome.
 */
export class SourceRunDispatchError extends Error {
  constructor(
    message: string,
    readonly failureClass: FailureClass,
    readonly commitEvidence: (now?: Date, terminal?: boolean) => Run,
  ) {
    super(message);
    this.name = "SourceRunDispatchError";
  }
}

export class SourceRunDispatchCancellationError extends AgentscrapeDiscoveryError {
  constructor(
    message: string,
    readonly commitEvidence: (now?: Date) => Run,
  ) {
    super(message, "cancelled", "cancellation");
    this.name = "SourceRunDispatchCancellationError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveBounded(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
    ? value
    : fallback;
}

function optionalBoolean(value: unknown): boolean {
  return value === true;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function sourceIntent(job: Job): {
  source_id: number;
  stable_source_id: string;
  source_kind: string;
  source_definition_version: number;
  run_id: number;
} {
  let parsed: unknown;
  try {
    parsed = job.intent === null ? null : JSON.parse(job.intent);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("source sync job has an invalid durable intent");
  }
  const intent = parsed as Record<string, unknown>;
  if (
    intent.version !== 1 ||
    intent.kind !== "source_sync" ||
    !Number.isSafeInteger(intent.source_id) ||
    !Number.isSafeInteger(intent.run_id) ||
    !Number.isSafeInteger(intent.source_definition_version) ||
    typeof intent.stable_source_id !== "string" ||
    typeof intent.source_kind !== "string"
  ) {
    throw new Error("source sync job has an unsupported durable intent");
  }
  return intent as ReturnType<typeof sourceIntent>;
}

function assertJobBinding(job: Job, context: SourceRunExecutionContext): void {
  const intent = sourceIntent(job);
  if (
    job.source_id !== context.source.id ||
    job.run_id !== context.run.id ||
    intent.source_id !== context.source.id ||
    intent.run_id !== context.run.id ||
    intent.stable_source_id !== context.source.identifier ||
    intent.source_kind !== context.definition.kind ||
    intent.source_definition_version !== context.run.source_definition_version
  ) {
    throw new Error("source sync job binding does not match its Run");
  }
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("source discovery was cancelled");
  error.name = "AbortError";
  throw error;
}

function warningStrings(
  warnings: ReadonlyArray<{ code: string; message: string }>,
  extras: readonly string[] = [],
): string[] {
  const values = [
    ...warnings.map((warning) =>
      warning.message.trim()
        ? `${warning.code}: ${warning.message}`
        : warning.code,
    ),
    ...extras,
  ];
  const unique = [
    ...new Set(values.map((value) => sanitizeExternalError(value))),
  ];
  if (unique.length <= MAX_SOURCE_WARNINGS) return unique;
  return [...unique.slice(0, MAX_SOURCE_WARNINGS - 1), "warnings_truncated"];
}

function resourceKeyForUrl(url: string): { type: string; value: string } {
  const statusId = xStatusId(url);
  return statusId === null
    ? { type: "url", value: normalizedWebUrl(url) }
    : { type: "x:status", value: statusId };
}

function fallbackEntryKey(
  sourceId: string,
  stableId: string,
): { type: string; value: string } {
  return {
    type: "source_entry",
    value: digest([sourceId, stableId]),
  };
}

function urlAdmission(
  url: string,
  resourceKey: { type: string; value: string },
  observedVersion: string,
): SourceObservationAdmission["admission"] {
  const intent: DurableSubmissionIntent = {
    version: 1,
    kind: "url",
    ingress: "source_sync",
    collections: [],
    payload: { url: { url } },
    options: {
      tags: [],
      force: false,
      max_bytes: DEFAULT_SOURCE_MAX_BYTES,
    },
  };
  return {
    idempotencyKey: `source-resource:v2:${digest([
      resourceKey.type,
      resourceKey.value,
      observedVersion,
    ])}`,
    intent: canonicalSubmissionIntent(intent),
  };
}

function validDate(value: string | null | undefined): string | null {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }
  return new Date(value).toISOString();
}

function newestDate(
  values: readonly (string | null | undefined)[],
): string | null {
  let newest: string | null = null;
  for (const value of values) {
    const normalized = validDate(value);
    if (
      normalized !== null &&
      (newest === null || Date.parse(normalized) > Date.parse(newest))
    ) {
      newest = normalized;
    }
  }
  return newest;
}

function healthDetail(
  label: string,
  count: number,
  newestSeenAt: string | null,
  now: Date,
): string {
  const lagSeconds =
    newestSeenAt === null
      ? null
      : Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(newestSeenAt)) / 1_000),
        );
  return `${label}; observations=${count}; lag_seconds=${lagSeconds ?? "unknown"}`;
}

function validCheckpointDate(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && validDate(value) !== null)
  );
}

function validCheckpointUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    return normalizedWebUrl(value) === value;
  } catch {
    return false;
  }
}

function blogCheckpoint(value: unknown): BlogCheckpoint | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("blog source checkpoint is invalid");
  }
  const checkpoint = value as Partial<BlogCheckpoint>;
  const validators = checkpoint.validators as
    | { etag?: unknown; last_modified?: unknown }
    | null
    | undefined;
  if (
    checkpoint.version !== 1 ||
    checkpoint.kind !== "blog_feed" ||
    validators === null ||
    typeof validators !== "object" ||
    (validators.etag !== null && typeof validators.etag !== "string") ||
    (validators.last_modified !== null &&
      typeof validators.last_modified !== "string") ||
    new Set([
      checkpoint.retrieval_source_url === undefined,
      checkpoint.validator_source_url === undefined,
      checkpoint.source_definition_version === undefined,
    ]).size !== 1 ||
    (checkpoint.retrieval_source_url !== undefined &&
      (typeof checkpoint.retrieval_source_url !== "string" ||
        !validCheckpointUrl(checkpoint.retrieval_source_url) ||
        !validCheckpointUrl(checkpoint.validator_source_url) ||
        !Number.isSafeInteger(checkpoint.source_definition_version) ||
        (checkpoint.source_definition_version as number) < 1)) ||
    !validCheckpointDate(checkpoint.newest_seen_at) ||
    !Array.isArray(checkpoint.recent_entries) ||
    checkpoint.recent_entries.length > 32 ||
    checkpoint.recent_entries.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.stable_id !== "string" ||
        entry.stable_id.length === 0 ||
        Array.from(entry.stable_id).length > 512 ||
        typeof entry.observed_version !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.observed_version),
    )
  ) {
    throw new Error("blog source checkpoint is invalid");
  }
  return checkpoint as BlogCheckpoint;
}

function xCheckpoint(value: unknown): XCheckpoint | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("X source checkpoint is invalid");
  }
  const checkpoint = value as Partial<XCheckpoint>;
  if (
    checkpoint.version !== 1 ||
    checkpoint.kind !== "x_account" ||
    new Set([
      checkpoint.account_handle === undefined,
      checkpoint.profile_url === undefined,
      checkpoint.source_definition_version === undefined,
    ]).size !== 1 ||
    (checkpoint.account_handle !== undefined &&
      (typeof checkpoint.account_handle !== "string" ||
        !/^[a-z0-9_]{1,20}$/.test(checkpoint.account_handle) ||
        typeof checkpoint.profile_url !== "string" ||
        !validCheckpointUrl(checkpoint.profile_url) ||
        !Number.isSafeInteger(checkpoint.source_definition_version) ||
        (checkpoint.source_definition_version as number) < 1)) ||
    (checkpoint.since_id !== null &&
      (typeof checkpoint.since_id !== "string" ||
        !/^\d+$/.test(checkpoint.since_id))) ||
    !Array.isArray(checkpoint.recent_ids) ||
    checkpoint.recent_ids.length > X_SOURCE_OVERLAP_ITEMS ||
    checkpoint.recent_ids.some(
      (id) => typeof id !== "string" || !/^\d+$/.test(id),
    ) ||
    !validCheckpointDate(checkpoint.newest_seen_at)
  ) {
    throw new Error("X source checkpoint is invalid");
  }
  return checkpoint as XCheckpoint;
}

function compareIdsDescending(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a > b ? -1 : 1;
}

function maxId(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  return [...values].sort(compareIdsDescending)[0] ?? null;
}

function normalizeBlogItems(
  sourceId: string,
  items: readonly FeedDiscoveryItem[],
  limit: number,
): { observations: SourceObservationAdmission[]; warnings: string[] } {
  const observations: SourceObservationAdmission[] = [];
  const warnings: string[] = [];
  const stableOccurrences = new Map<string, number>();
  const resourceKeys = new Set<string>();
  let eligible = 0;
  for (const item of items) {
    const candidate = item.url ?? item.candidate_urls[0] ?? null;
    let locator: string | null = null;
    let key = fallbackEntryKey(sourceId, item.stable_id);
    let unsafe = false;
    if (candidate !== null) {
      try {
        locator = normalizedWebUrl(candidate);
        key = resourceKeyForUrl(locator);
      } catch {
        unsafe = true;
      }
    }
    const resourceIdentity = `${key.type}\u0000${key.value}`;
    const occurrence = (stableOccurrences.get(item.stable_id) ?? 0) + 1;
    stableOccurrences.set(item.stable_id, occurrence);
    const duplicate = occurrence > 1 || resourceKeys.has(resourceIdentity);
    if (duplicate) warnings.push(`duplicate_observation: ${item.stable_id}`);
    else resourceKeys.add(resourceIdentity);

    let suppressionReason: string | null = null;
    if (duplicate) suppressionReason = "duplicate_observation";
    else if (item.tombstone) suppressionReason = "upstream_tombstone";
    else if (unsafe) suppressionReason = "unsafe_resource_url";
    else if (locator === null) suppressionReason = "no_resource_url";
    else {
      eligible += 1;
      if (eligible > limit) suppressionReason = "item_limit";
    }
    const metadata = {
      title: item.title,
      published_at: item.published_at,
      updated_at: item.updated_at,
      tombstone: item.tombstone,
      identity_source: item.identity_source,
    };
    const observedVersion = digest({ locator, ...metadata });
    observations.push({
      observationKey: `${digest(item.stable_id)}:${occurrence}`,
      stableId: item.stable_id,
      observedVersion,
      resourceKey: key,
      locator,
      metadata,
      suppressionReason,
      admission:
        suppressionReason === null && locator !== null
          ? urlAdmission(locator, key, observedVersion)
          : null,
    });
  }
  return { observations, warnings };
}

function normalizeXItems(
  items: readonly XTimelineItem[],
  limit: number,
  includeReplies: boolean,
  includeReposts: boolean,
): { observations: SourceObservationAdmission[]; warnings: string[] } {
  const observations: SourceObservationAdmission[] = [];
  const warnings: string[] = [];
  const occurrences = new Map<string, number>();
  let eligible = 0;
  for (const item of items) {
    const occurrence = (occurrences.get(item.id) ?? 0) + 1;
    occurrences.set(item.id, occurrence);
    const duplicate = occurrence > 1;
    if (duplicate) warnings.push(`duplicate_observation: ${item.id}`);
    const locator = normalizedWebUrl(item.url);
    const key = { type: "x:status", value: item.id };
    let suppressionReason: string | null = null;
    if (duplicate) suppressionReason = "duplicate_observation";
    else if (item.is_reply && !includeReplies)
      suppressionReason = "excluded_reply";
    else if (item.is_repost && !includeReposts) {
      suppressionReason = "excluded_repost";
    } else {
      eligible += 1;
      if (eligible > limit) suppressionReason = "item_limit";
    }
    const contentDigest = digest(item.text);
    const metadata = {
      published_at: item.created_at || null,
      content_digest: contentDigest,
      is_reply: item.is_reply,
      is_repost: item.is_repost,
      is_quote: item.is_quote,
      is_pinned: item.is_pinned,
      article_urls: [...item.article_urls].sort(),
    };
    const observedVersion = digest({ locator, ...metadata });
    observations.push({
      observationKey: `${digest(item.id)}:${occurrence}`,
      stableId: item.id,
      observedVersion,
      resourceKey: key,
      locator,
      metadata,
      suppressionReason,
      admission:
        suppressionReason === null
          ? urlAdmission(locator, key, observedVersion)
          : null,
    });
  }
  return { observations, warnings };
}

function feedFailureClass(
  envelope: FeedDiscoveryEnvelope,
): { failureClass: FailureClass; retry: boolean; pause: boolean } | null {
  const failure = envelope.failure;
  const warningText = envelope.warnings
    .map((warning) => warning.code)
    .join(" ");
  const code = `${failure?.code ?? ""} ${warningText}`;
  if (/rate|429|throttl/i.test(code)) {
    return { failureClass: "item_transient", retry: true, pause: false };
  }
  if (/auth|credential|config/i.test(code)) {
    return { failureClass: "auth_config", retry: false, pause: true };
  }
  if (failure === null) return null;
  if (failure.code === "cancelled") {
    return { failureClass: "permanent", retry: false, pause: false };
  }
  return failure.retryable
    ? { failureClass: "item_transient", retry: true, pause: false }
    : { failureClass: "permanent", retry: false, pause: false };
}

function providerFailure(error: unknown): {
  error: Error;
  failureClass: FailureClass;
  retry: boolean;
  pause: boolean;
} {
  if (error instanceof AgentscrapeDiscoveryError) {
    if (error.disposition === "cancelled") throw error;
    return {
      error,
      failureClass: error.disposition,
      retry:
        error.disposition === "infra" || error.disposition === "item_transient",
      pause: error.disposition === "auth_config",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate.?limit|throttl/i.test(message)) {
    return {
      error: error instanceof Error ? error : new Error(message),
      failureClass: "item_transient",
      retry: true,
      pause: false,
    };
  }
  if (/auth|credential|config|login|forbidden|unauthorized/i.test(message)) {
    return {
      error: error instanceof Error ? error : new Error(message),
      failureClass: "auth_config",
      retry: false,
      pause: true,
    };
  }
  return {
    error: error instanceof Error ? error : new Error(message),
    failureClass: "infra",
    retry: true,
    pause: false,
  };
}

function failureError(
  registry: SourceRegistry,
  runId: number,
  failure: {
    error: Error;
    failureClass: FailureClass;
    retry: boolean;
    pause: boolean;
  },
  attemptedCursor: unknown,
  observations: readonly SourceObservationAdmission[],
  warnings: readonly string[],
  detail: string,
): SourceRunDispatchError {
  return new SourceRunDispatchError(
    failure.error.message,
    failure.failureClass,
    (now = new Date(), terminal = false) =>
      registry.commitSourceRunWindow({
        runId,
        observations,
        attemptedCursor,
        warnings,
        disposition: terminal || !failure.retry ? "failed" : "retry",
        healthDetail: detail,
        ...(failure.pause ? { pauseReason: "auth_config" } : {}),
        now,
      }),
  );
}

function cancellationError(
  registry: SourceRegistry,
  runId: number,
  message: string,
  attemptedCursor: unknown,
  observations: readonly SourceObservationAdmission[],
  warnings: readonly string[],
  detail: string,
): SourceRunDispatchCancellationError {
  return new SourceRunDispatchCancellationError(message, (now = new Date()) =>
    registry.commitSourceRunWindow({
      runId,
      observations,
      attemptedCursor,
      warnings,
      disposition: "cancelled",
      healthDetail: detail,
      now,
    }),
  );
}

function invalidCheckpointError(
  registry: SourceRegistry,
  runId: number,
  kind: BlogCheckpoint["kind"] | XCheckpoint["kind"],
  error: unknown,
): SourceRunDispatchError {
  const detail = sanitizeExternalError(error);
  return failureError(
    registry,
    runId,
    {
      error: new Error(detail),
      failureClass: "auth_config",
      retry: false,
      pause: true,
    },
    { kind, status: "invalid_checkpoint" },
    [],
    [detail],
    detail,
  );
}

async function dispatchBlog(
  registry: SourceRegistry,
  context: SourceRunExecutionContext,
  provider: SourceDiscoveryProvider,
  options: SourceRunDispatchOptions,
): Promise<PreparedSourceRunDispatch> {
  const payload = context.definition.payload;
  const configuredFeedUrl = optionalText(payload.feed_url);
  const sourceUrl = configuredFeedUrl ?? optionalText(payload.homepage_url);
  if (sourceUrl === undefined) {
    throw new Error("blog source has no discovery URL");
  }
  const retrievalSourceUrl = normalizedWebUrl(sourceUrl);
  let previous: BlogCheckpoint | null;
  try {
    previous = blogCheckpoint(context.checkpoint);
  } catch (error) {
    throw invalidCheckpointError(registry, context.run.id, "blog_feed", error);
  }
  const validatorsCompatible =
    configuredFeedUrl !== undefined &&
    previous?.retrieval_source_url === retrievalSourceUrl &&
    typeof previous.validator_source_url === "string" &&
    previous.source_definition_version === context.definition.version;
  const validatorSourceUrl = validatorsCompatible
    ? (previous?.validator_source_url ?? null)
    : null;
  const now = options.now?.() ?? new Date();
  let envelope: FeedDiscoveryEnvelope;
  try {
    const discovered = await provider.discoverFeed({
      sourceUrl,
      sourceKind:
        payload.source_kind === "archive"
          ? "archive"
          : payload.source_kind === "feed" || configuredFeedUrl !== undefined
            ? "feed"
            : "auto",
      recordedInputFile: optionalText(payload.recorded_input_file),
      validators: {
        etag: validatorsCompatible ? (previous?.validators.etag ?? null) : null,
        lastModified: validatorsCompatible
          ? (previous?.validators.last_modified ?? null)
          : null,
      },
      validatorUrl: validatorSourceUrl ?? undefined,
      recordedValidators: {
        ...(optionalText(payload.etag) === undefined
          ? {}
          : { etag: optionalText(payload.etag) }),
        ...(optionalText(payload.last_modified) === undefined
          ? {}
          : { lastModified: optionalText(payload.last_modified) }),
      },
      maxResponseBytes: positiveBounded(
        payload.max_response_bytes,
        2_000_000,
        20_000_000,
      ),
      maxPages: context.definition.limits.max_pages_per_run,
      maxItems: context.definition.limits.max_items_per_run,
      timeoutMs: positiveBounded(payload.timeout_ms, 120_000, 300_000),
      signal: options.signal,
    });
    envelope = validateFeedDiscoveryEnvelope(discovered, sourceUrl, {
      maxItems: 10_000,
      maxPages: context.definition.limits.max_pages_per_run,
    });
  } catch (error) {
    if (
      error instanceof AgentscrapeDiscoveryError &&
      error.disposition === "cancelled"
    ) {
      const detail = sanitizeExternalError(error);
      throw cancellationError(
        registry,
        context.run.id,
        error.message,
        { kind: "blog_feed", status: "cancelled" },
        [],
        [detail],
        detail,
      );
    }
    const classified = providerFailure(error);
    throw failureError(
      registry,
      context.run.id,
      classified,
      { kind: "blog_feed", status: "failed" },
      [],
      [sanitizeExternalError(classified.error)],
      classified.error.message,
    );
  }
  abortIfRequested(options.signal);

  const normalized = normalizeBlogItems(
    context.source.identifier,
    envelope.items,
    context.definition.limits.max_items_per_run,
  );
  const failure = feedFailureClass(envelope);
  const warnings = warningStrings(envelope.warnings, [
    ...normalized.warnings,
    ...(envelope.failure === null
      ? []
      : [`${envelope.failure.code}: ${envelope.failure.message}`]),
  ]);
  const attemptedCursor = {
    kind: "blog_feed",
    status: envelope.status,
    validators: envelope.validators,
    pagination: {
      complete: envelope.pagination.complete,
      stop_reason: envelope.pagination.stop_reason,
      next_boundary_url: envelope.pagination.next_url,
    },
  };
  const newestSeenAt = newestDate([
    envelope.cursor.newest_seen_at,
    previous?.newest_seen_at,
    ...envelope.items.flatMap((item) => [item.updated_at, item.published_at]),
  ]);
  const detail = healthDetail(
    envelope.status === "success"
      ? "successful blog poll"
      : "incomplete blog poll",
    normalized.observations.length,
    newestSeenAt,
    now,
  );
  if (envelope.failure?.code === "cancelled") {
    throw cancellationError(
      registry,
      context.run.id,
      envelope.failure.message,
      attemptedCursor,
      normalized.observations,
      warnings,
      detail,
    );
  }
  if (failure !== null) {
    throw failureError(
      registry,
      context.run.id,
      {
        error: new Error(
          envelope.failure?.message ?? warnings[0] ?? "feed discovery failed",
        ),
        ...failure,
      },
      attemptedCursor,
      normalized.observations,
      warnings,
      detail,
    );
  }

  const recentEntries: BlogCheckpoint["recent_entries"] = [];
  const recentIds = new Set<string>();
  for (const entry of [
    ...normalized.observations.map((observation) => ({
      stable_id: observation.stableId,
      observed_version: observation.observedVersion,
    })),
    ...(previous?.recent_entries ?? []),
  ]) {
    if (recentIds.has(entry.stable_id)) continue;
    recentIds.add(entry.stable_id);
    recentEntries.push(entry);
    if (recentEntries.length === 32) break;
  }
  const checkpointValidatorUrl =
    configuredFeedUrl === undefined
      ? null
      : envelope.pagination.stop_reason === "not_modified"
        ? (previous?.validator_source_url ?? retrievalSourceUrl)
        : (envelope.pagination.pages[0]?.url ?? retrievalSourceUrl);
  const checkpoint: BlogCheckpoint = {
    version: 1,
    kind: "blog_feed",
    validators: envelope.cursor.validators,
    retrieval_source_url: retrievalSourceUrl,
    validator_source_url: checkpointValidatorUrl,
    source_definition_version: context.definition.version,
    newest_seen_at: newestSeenAt,
    recent_entries: recentEntries,
  };
  const complete =
    envelope.status === "success" &&
    envelope.pagination.complete &&
    (envelope.pagination.stop_reason === "exhausted" ||
      envelope.pagination.stop_reason === "not_modified") &&
    envelope.pagination.next_url === null &&
    envelope.cursor.next_url === null &&
    envelope.failure === null;
  return {
    runId: context.run.id,
    disposition: complete ? "success" : "partial",
    commit: (commitNow = new Date()) =>
      registry.commitSourceRunWindow({
        runId: context.run.id,
        observations: normalized.observations,
        attemptedCursor,
        warnings,
        disposition: complete ? "success" : "partial",
        ...(complete ? { checkpoint } : {}),
        healthDetail: detail,
        beforeCheckpointCommit: options.beforeCheckpointCommit,
        now: commitNow,
      }),
  };
}

function xRequestSince(checkpoint: XCheckpoint | null): string | undefined {
  if (checkpoint?.since_id === null || checkpoint === null) return undefined;
  const overlap = [...new Set(checkpoint.recent_ids)]
    .filter((id) => BigInt(id) <= BigInt(checkpoint.since_id as string))
    .sort(compareIdsDescending)
    .slice(0, X_SOURCE_OVERLAP_ITEMS);
  const oldest = overlap.at(-1);
  if (oldest === undefined) return checkpoint.since_id;
  // Agentscrape emits IDs strictly greater than since_id, so step below the
  // oldest retained ID to include the whole overlap window.
  const overlapBoundary = BigInt(oldest);
  return overlapBoundary > 0n
    ? String(overlapBoundary - 1n)
    : checkpoint.since_id;
}

async function dispatchX(
  registry: SourceRegistry,
  context: SourceRunExecutionContext,
  provider: SourceDiscoveryProvider,
  options: SourceRunDispatchOptions,
): Promise<PreparedSourceRunDispatch> {
  const payload = context.definition.payload;
  const handle = optionalText(payload.handle);
  if (handle === undefined) throw new Error("X source has no handle");
  const profileUrl = normalizedWebUrl(
    optionalText(payload.profile_url) ??
      `https://x.com/${handle.replace(/^@/, "")}`,
  );
  const accountHandle = handle.replace(/^@/, "").toLowerCase();
  let storedCheckpoint: XCheckpoint | null;
  try {
    storedCheckpoint = xCheckpoint(context.checkpoint);
  } catch (error) {
    throw invalidCheckpointError(registry, context.run.id, "x_account", error);
  }
  const previous =
    storedCheckpoint?.account_handle === accountHandle &&
    storedCheckpoint.profile_url === profileUrl &&
    storedCheckpoint.source_definition_version === context.definition.version
      ? storedCheckpoint
      : null;
  const requestedSinceId = xRequestSince(previous);
  const includeReplies = optionalBoolean(payload.include_replies);
  const includeReposts = optionalBoolean(payload.include_reposts);
  const requestLimit = Math.min(
    10_000,
    context.definition.limits.max_items_per_run + X_SOURCE_OVERLAP_ITEMS,
  );
  const now = options.now?.() ?? new Date();
  let envelope: XTimelineDiscoveryEnvelope;
  try {
    const discovered = await provider.discoverXTimeline({
      url: profileUrl,
      handle,
      ...(requestedSinceId === undefined ? {} : { sinceId: requestedSinceId }),
      limit: requestLimit,
      maxScrolls: context.definition.limits.max_pages_per_run,
      includeReplies: true,
      includeReposts: true,
      timeoutMs: positiveBounded(payload.timeout_ms, 120_000, 600_000),
      signal: options.signal,
    });
    envelope = validateXTimelineDiscoveryEnvelope(discovered, handle, {
      maxItems: 10_000,
    });
  } catch (error) {
    if (
      error instanceof AgentscrapeDiscoveryError &&
      error.disposition === "cancelled"
    ) {
      const detail = sanitizeExternalError(error);
      throw cancellationError(
        registry,
        context.run.id,
        error.message,
        {
          kind: "x_account",
          requested_since_id: requestedSinceId ?? null,
          status: "cancelled",
        },
        [],
        [detail],
        detail,
      );
    }
    const classified = providerFailure(error);
    throw failureError(
      registry,
      context.run.id,
      classified,
      {
        kind: "x_account",
        requested_since_id: requestedSinceId ?? null,
        status: "failed",
      },
      [],
      [sanitizeExternalError(classified.error)],
      classified.error.message,
    );
  }
  abortIfRequested(options.signal);

  const normalized = normalizeXItems(
    envelope.tweets,
    context.definition.limits.max_items_per_run,
    includeReplies,
    includeReposts,
  );
  const warnings = warningStrings(envelope.warnings, normalized.warnings);
  const warningEvidence = envelope.warnings
    .map((warning) => `${warning.code} ${warning.message}`)
    .join(" ");
  const rateLimited = /rate|429|throttl/i.test(warningEvidence);
  const authBlocked =
    /auth|credential|config|login|forbidden|unauthorized|cookie/i.test(
      warningEvidence,
    );
  const unsafeBoundary = envelope.warnings.length > 0;
  const high = maxId([
    ...(previous?.since_id === null || previous?.since_id === undefined
      ? []
      : [previous.since_id]),
    ...envelope.tweets.map((item) => item.id),
  ]);
  const newestSeenAt = newestDate([
    previous?.newest_seen_at,
    ...envelope.tweets.map((item) => item.created_at),
  ]);
  const boundaryComplete =
    !unsafeBoundary &&
    (previous?.since_id === null || previous === null
      ? true
      : envelope.next_cursor === null);
  const attemptedCursor = {
    kind: "x_account",
    requested_since_id: requestedSinceId ?? null,
    observed_high_water_id: high,
    boundary_complete: boundaryComplete,
    // Agentscrape explicitly documents this as non-seekable evidence.
    diagnostic_oldest_item_id: envelope.next_cursor,
  };
  const detail = healthDetail(
    boundaryComplete ? "successful X poll" : "incomplete X poll",
    normalized.observations.length,
    newestSeenAt,
    now,
  );
  if (rateLimited || authBlocked) {
    const failure = {
      error: new Error(
        warnings[0] ??
          (rateLimited ? "X rate limit" : "X authentication failed"),
      ),
      failureClass: (rateLimited
        ? "item_transient"
        : "auth_config") as FailureClass,
      retry: rateLimited,
      pause: authBlocked,
    };
    throw failureError(
      registry,
      context.run.id,
      failure,
      attemptedCursor,
      normalized.observations,
      warnings,
      detail,
    );
  }

  const recentIds = [
    ...new Set([
      ...envelope.tweets.map((item) => item.id),
      ...(previous?.recent_ids ?? []),
    ]),
  ]
    .sort(compareIdsDescending)
    .slice(0, X_SOURCE_OVERLAP_ITEMS);
  const checkpoint: XCheckpoint = {
    version: 1,
    kind: "x_account",
    account_handle: accountHandle,
    profile_url: profileUrl,
    source_definition_version: context.definition.version,
    since_id: high,
    recent_ids: recentIds,
    newest_seen_at: newestSeenAt,
  };
  return {
    runId: context.run.id,
    disposition: boundaryComplete ? "success" : "partial",
    commit: (commitNow = new Date()) =>
      registry.commitSourceRunWindow({
        runId: context.run.id,
        observations: normalized.observations,
        attemptedCursor,
        warnings,
        disposition: boundaryComplete ? "success" : "partial",
        ...(boundaryComplete ? { checkpoint } : {}),
        healthDetail: detail,
        beforeCheckpointCommit: options.beforeCheckpointCommit,
        now: commitNow,
      }),
  };
}

/** Execute exactly one bounded provider call for a leased source-sync job. */
export async function dispatchSourceRun(
  store: ResearchStore,
  job: Job,
  options: SourceRunDispatchOptions = {},
): Promise<PreparedSourceRunDispatch> {
  if (job.kind !== "source_sync") {
    throw new Error(
      "provider-specific source dispatch requires a source_sync job",
    );
  }
  const registry = new SourceRegistry(store);
  const intent = sourceIntent(job);
  let context: SourceRunExecutionContext;
  try {
    context = registry.sourceRunExecution(intent.run_id);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const detail = sanitizeExternalError(error);
    throw new SourceRunDispatchError(
      detail,
      "auth_config",
      (now = new Date()) =>
        registry.finishSourceRun({
          runId: intent.run_id,
          outcome: "failed",
          attemptedCursor: {
            kind: "source_sync",
            status: "invalid_definition",
          },
          warnings: [detail],
          healthDetail: detail,
          pauseReason: "auth_config",
          now,
        }),
    );
  }
  assertJobBinding(job, context);
  abortIfRequested(options.signal);
  registry.startSourceRun({ runId: context.run.id, now: options.now?.() });
  const provider = options.discovery ?? sourceDiscoveryWithAgentscrape;
  if (
    context.definition.kind === "blog_feed" ||
    context.definition.kind === "blog_source"
  ) {
    return dispatchBlog(registry, context, provider, options);
  }
  if (context.definition.kind === "x_account") {
    return dispatchX(registry, context, provider, options);
  }
  throw new Error(`source kind '${context.definition.kind}' is not executable`);
}
