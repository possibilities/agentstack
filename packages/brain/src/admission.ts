import { setTimeout as sleep } from "node:timers/promises";
import { brainSignal } from "./paths.js";
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import { CliError } from "./errors.js";
import { DEFAULT_EXTENSIONS, looksSensitiveComponent } from "./extract.js";
import {
  DIRECTORY_CANDIDATE_LIMIT,
  DIRECTORY_TRAVERSAL_LIMIT,
  type IngestSourceType,
  SKIP_DIRS,
} from "./ingest.js";
import type {
  VerifiedRecoveryCandidate,
  VerifiedRecoveryGeneration,
} from "./recovery.js";
import { RECOVERY_OFFLINE_SCOPE_KIND, type ResearchStore } from "./store.js";
import { normalizeTags } from "./text.js";
import type {
  AdmissionStatus,
  AdmissionWaitStatus,
  JobState,
  RecoveryDisposition,
  RecoveryImportReport,
  Sensitivity,
} from "./types.js";
import { normalizedWebUrl, xArticleId, xStatusId } from "./url.js";

export const SUBMISSION_VERSION = 1 as const;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export type SubmissionKind = Exclude<IngestSourceType, "auto">;

export interface SubmissionIntent {
  version: typeof SUBMISSION_VERSION;
  source: string;
  kind?: IngestSourceType;
  ingress: string;
  collections?: string[];
  idempotencyKey?: string;
  title?: string;
  tags?: unknown;
  notes?: string;
  recursive?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  force?: boolean;
  skipSecrets?: boolean;
}

interface ArtifactPayload {
  content_digest: string;
  byte_size: number;
  media_type: string;
  artifact_role: "original" | "imported_markdown";
}

export interface DurableSubmissionIntent {
  version: typeof SUBMISSION_VERSION;
  kind: SubmissionKind;
  ingress: string;
  collections: string[];
  payload:
    | { text: ArtifactPayload }
    | { file: ArtifactPayload }
    | {
        directory: {
          artifacts: ArtifactPayload[];
          recursive: boolean;
          truncated: boolean;
        };
      }
    | { url: { url: string } };
  options: {
    title?: string;
    tags: string[];
    notes?: string;
    force: boolean;
    max_bytes: number;
  };
}

export interface AdmissionResult {
  version: typeof SUBMISSION_VERSION;
  status: AdmissionStatus;
  job_id: number;
  idempotency_key: string;
  intent_hash: string;
  state: JobState;
  wait_status?: AdmissionWaitStatus;
}

export interface AdmissionOptions {
  artifactStore?: ArtifactStore;
}

interface PreparedSubmission {
  kind: SubmissionKind;
  ingress: string;
  collections: string[];
  source: string;
  localPaths: string[];
  recursive: boolean;
  truncated: boolean;
  maxBytes: number;
  title?: string;
  tags: string[];
  notes?: string;
  force: boolean;
}

const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".epub": "application/epub+zip",
};

const TERMINAL_JOB_STATES = new Set<JobState>([
  "blocked",
  "failed",
  "completed",
  "excluded",
  "cancelled",
]);

function admissionError(code: string, message: string): CliError {
  return new CliError(code, message, { exitCode: 2 });
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw admissionError("bad_intent", `${name} must be a positive integer`);
  }
  return resolved;
}

function optionalText(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) throw admissionError("bad_intent", `${name} must not be empty`);
  if (Array.from(text).length > 5000) {
    throw admissionError("bad_intent", `${name} is too long`);
  }
  return text;
}

function normalizedName(value: string, name: string): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized)) {
    throw admissionError(
      "bad_intent",
      `${name} must use 1-100 lowercase letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return normalized;
}

function detectedKind(source: string): SubmissionKind {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") return "url";
  } catch {}
  try {
    const stat = statSync(source);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {}
  return "text";
}

function sensitivePath(path: string): boolean {
  return realpathSync(path).split(/[\\/]/).some(looksSensitiveComponent);
}

function discoverDirectory(
  root: string,
  recursive: boolean,
  skipSecrets: boolean,
  maxFiles: number,
): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let entries = 0;
  let candidates = 0;
  let truncated = false;

  const visit = (directory: string): void => {
    if (truncated) return;
    const handle = opendirSync(directory);
    try {
      while (!truncated) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (entries >= DIRECTORY_TRAVERSAL_LIMIT) {
          truncated = true;
          break;
        }
        entries += 1;
        if (skipSecrets && looksSensitiveComponent(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(entry.name)) visit(path);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!DEFAULT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
          continue;
        if (
          candidates >= DIRECTORY_CANDIDATE_LIMIT ||
          paths.length >= maxFiles
        ) {
          truncated = true;
          break;
        }
        candidates += 1;
        paths.push(path);
      }
    } finally {
      handle.closeSync();
    }
  };

  visit(root);
  paths.sort();
  return { paths, truncated };
}

function prepareSubmission(input: SubmissionIntent): PreparedSubmission {
  if (input.version !== SUBMISSION_VERSION) {
    throw admissionError(
      "unsupported_submission_version",
      `submission version must be ${SUBMISSION_VERSION}`,
    );
  }
  const source = String(input.source ?? "").trim();
  if (!source) throw admissionError("bad_intent", "source is required");
  const requestedKind = String(input.kind ?? "auto")
    .trim()
    .toLowerCase();
  if (!["auto", "url", "file", "directory", "text"].includes(requestedKind)) {
    throw admissionError(
      "bad_intent",
      `unknown submission kind '${requestedKind}'`,
    );
  }
  const kind =
    requestedKind === "auto"
      ? detectedKind(source)
      : (requestedKind as SubmissionKind);
  const ingress = normalizedName(input.ingress, "ingress");
  const collections = [
    ...new Set(
      (input.collections ?? []).map((value) =>
        normalizedName(value, "collection"),
      ),
    ),
  ].sort();
  const maxBytes = positiveInteger(input.maxBytes, 5_000_000, "max_bytes");
  const recursive = input.recursive !== false;
  const maxFiles = Math.min(
    positiveInteger(input.maxFiles, 300, "max_files"),
    5000,
  );
  const skipSecrets = input.skipSecrets !== false;
  const title = optionalText(input.title, "title");
  const notes = optionalText(input.notes, "notes");
  const tags = [...new Set(normalizeTags(input.tags))].sort();
  let normalizedSource = source;
  let localPaths: string[] = [];
  let truncated = false;

  if (kind === "url") {
    try {
      normalizedSource = normalizedWebUrl(source);
    } catch (error) {
      throw admissionError(
        "bad_intent",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (kind === "file") {
    try {
      if (lstatSync(source).isSymbolicLink() || !statSync(source).isFile()) {
        throw new Error("not a regular file");
      }
      if (skipSecrets && sensitivePath(source)) {
        throw new Error(`refusing likely secret file: ${basename(source)}`);
      }
      if (statSync(source).size > maxBytes)
        throw new Error("file exceeds max_bytes");
      localPaths = [realpathSync(source)];
    } catch (error) {
      throw admissionError(
        "bad_intent",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (kind === "directory") {
    try {
      const root = realpathSync(source);
      if (!statSync(root).isDirectory()) throw new Error("not a directory");
      if (skipSecrets && sensitivePath(root)) {
        throw new Error(`refusing likely secret directory: ${basename(root)}`);
      }
      const discovered = discoverDirectory(
        root,
        recursive,
        skipSecrets,
        maxFiles,
      );
      for (const path of discovered.paths) {
        if (statSync(path).size > maxBytes) {
          throw new Error(
            `directory file exceeds max_bytes: ${basename(path)}`,
          );
        }
      }
      localPaths = discovered.paths;
      truncated = discovered.truncated;
    } catch (error) {
      throw admissionError(
        "bad_intent",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > maxBytes)
      throw admissionError("bad_intent", "text exceeds max_bytes");
  }

  const idempotencyKey = input.idempotencyKey?.trim();
  if (input.idempotencyKey !== undefined && !idempotencyKey) {
    throw admissionError(
      "bad_idempotency_key",
      "idempotency_key must not be empty",
    );
  }
  if (idempotencyKey !== undefined && idempotencyKey.length > 500) {
    throw admissionError("bad_idempotency_key", "idempotency_key is too long");
  }

  return {
    kind,
    ingress,
    collections,
    source: normalizedSource,
    localPaths,
    recursive,
    truncated,
    maxBytes,
    title,
    tags,
    notes,
    force: input.force === true,
  };
}

function mediaType(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function artifactPayload(
  stored: StoredArtifact,
  type: string,
): ArtifactPayload {
  return {
    content_digest: stored.contentDigest,
    byte_size: stored.byteSize,
    media_type: type,
    artifact_role: "original",
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function canonicalSubmissionIntent(
  intent: DurableSubmissionIntent,
): string {
  return JSON.stringify(stableValue(intent));
}

function submissionIntentHash(intent: DurableSubmissionIntent): string {
  return createHash("sha256")
    .update(canonicalSubmissionIntent(intent))
    .digest("hex");
}

function existingIntent(
  store: ResearchStore,
  idempotencyKey: string,
): { id: number; intent: string | null } | null {
  return store.db
    .query("SELECT id, intent FROM jobs WHERE idempotency_key=?")
    .get(idempotencyKey) as { id: number; intent: string | null } | null;
}

function assertEquivalent(
  existing: { id: number; intent: string | null },
  canonicalIntent: string,
): void {
  if (existing.intent !== canonicalIntent) {
    throw new CliError(
      "idempotency_conflict",
      `idempotency_key already belongs to a different intent (job ${existing.id})`,
      { exitCode: 2 },
    );
  }
}

export interface AlreadyIndexedResult {
  version: typeof SUBMISSION_VERSION;
  status: "already_indexed";
  document_id: number;
  resource_key: string;
}

/**
 * Read-only pre-admission lookup: the already-materialized document for a URL
 * submission, keyed by the same conservative resource identity the worker
 * derives (x:status and x:article aliases converge; generic URLs match only
 * their conservative normalization). Returns null for non-web sources and for
 * resources that exist without a materialized document.
 */
export function indexedDocumentForUrl(
  store: ResearchStore,
  source: string,
): AlreadyIndexedResult | null {
  let url: string;
  try {
    url = normalizedWebUrl(String(source ?? "").trim());
  } catch {
    return null;
  }
  const statusId = xStatusId(url);
  const articleId = xArticleId(url);
  const key = statusId
    ? { type: "x:status", value: statusId }
    : articleId
      ? { type: "x:article", value: articleId }
      : { type: "url", value: url };
  const row = store.db
    .query(
      "SELECT key_type, key_value, document_id FROM resources WHERE key_type=? AND key_value=? AND document_id IS NOT NULL",
    )
    .get(key.type, key.value) as {
    key_type: string;
    key_value: string;
    document_id: number;
  } | null;
  if (row === null) return null;
  return {
    version: SUBMISSION_VERSION,
    status: "already_indexed",
    document_id: row.document_id,
    resource_key: `${row.key_type}:${row.key_value}`,
  };
}

export function admitSubmission(
  store: ResearchStore,
  input: SubmissionIntent,
  options: AdmissionOptions = {},
): AdmissionResult {
  const prepared = prepareSubmission(input);
  const registered: Array<{ stored: StoredArtifact; mediaType: string }> = [];
  let payload: DurableSubmissionIntent["payload"];

  if (prepared.kind === "url") {
    payload = { url: { url: prepared.source } };
  } else {
    const artifactStore = options.artifactStore ?? new ArtifactStore();
    if (prepared.kind === "text") {
      const type = "text/plain; charset=utf-8";
      const stored = artifactStore.captureBytes(prepared.source, {
        maxBytes: prepared.maxBytes,
      });
      registered.push({ stored, mediaType: type });
      payload = { text: artifactPayload(stored, type) };
    } else {
      const snapshots = prepared.localPaths.map((path) => {
        const type = mediaType(path);
        const stored = artifactStore.snapshotLocalFile(path, {
          mediaType: type,
          maxBytes: prepared.maxBytes,
        });
        return { stored, mediaType: type };
      });
      registered.push(...snapshots);
      if (prepared.kind === "file") {
        const snapshot = snapshots[0];
        if (snapshot === undefined)
          throw admissionError("bad_intent", "file snapshot is missing");
        payload = {
          file: artifactPayload(snapshot.stored, snapshot.mediaType),
        };
      } else {
        payload = {
          directory: {
            artifacts: snapshots.map((snapshot) =>
              artifactPayload(snapshot.stored, snapshot.mediaType),
            ),
            recursive: prepared.recursive,
            truncated: prepared.truncated,
          },
        };
      }
    }
  }

  const intent: DurableSubmissionIntent = {
    version: SUBMISSION_VERSION,
    kind: prepared.kind,
    ingress: prepared.ingress,
    collections: prepared.collections,
    payload,
    options: {
      ...(prepared.title === undefined ? {} : { title: prepared.title }),
      tags: prepared.tags,
      ...(prepared.notes === undefined ? {} : { notes: prepared.notes }),
      force: prepared.force,
      max_bytes: prepared.maxBytes,
    },
  };
  const canonicalIntent = canonicalSubmissionIntent(intent);
  const intentHash = submissionIntentHash(intent);
  const explicitKey = input.idempotencyKey?.trim();
  const idempotencyKey =
    explicitKey ?? `submit:v${SUBMISSION_VERSION}:${intentHash}`;
  const existing = existingIntent(store, idempotencyKey);
  if (existing !== null) assertEquivalent(existing, canonicalIntent);

  const enqueue = () => {
    for (const artifact of registered) {
      store.registerStoredArtifact(artifact.stored, {
        mediaType: artifact.mediaType,
        artifactRole: "original",
      });
    }
    const result = store.enqueueJob({
      idempotencyKey,
      kind: prepared.kind,
      intent: canonicalIntent,
    });
    if (!result.created) {
      assertEquivalent(
        { id: result.job.id, intent: result.job.intent },
        canonicalIntent,
      );
    }
    return result;
  };
  const admitted =
    existing === null
      ? store.db.transaction(enqueue).immediate()
      : store.enqueueJob({
          idempotencyKey,
          kind: prepared.kind,
          intent: canonicalIntent,
        });
  return {
    version: SUBMISSION_VERSION,
    status: admitted.created ? "queued" : "duplicate",
    job_id: admitted.job.id,
    idempotency_key: admitted.job.idempotency_key,
    intent_hash: intentHash,
    state: admitted.job.state,
  };
}

export interface RecoveryAdmissionOptions {
  artifactStore?: ArtifactStore;
  authorizeOffline?: boolean;
  dryRun?: boolean;
  now?: Date;
}

interface RecoveryAdmissionContext {
  sourceId: number;
  runId: number;
  collectionId: number;
  timestamp: string;
}

interface RecoveryCandidateEffect {
  outcomeCreated: boolean;
  observationsCreated: number;
  observationsExisting: number;
  artifactCreated: boolean;
  artifactExisting: boolean;
  jobCreated: boolean;
  jobExisting: boolean;
}

export const RECOVERY_JOB_PREFIX = "legacy-recovery-candidate:v1:";
export const RECOVERY_ONLINE_JOB_PREFIX = `${RECOVERY_JOB_PREFIX}online:`;

function recoveryAdmissionError(code: string, message: string): CliError {
  return new CliError(code, message, { exitCode: 2 });
}

function recoveryJobState(
  disposition: RecoveryDisposition,
): "queued" | "blocked" | "excluded" | null {
  if (disposition === "import_offline") return "queued";
  if (
    disposition === "approved_online_backfill_telegram_human" ||
    disposition === "review_fetch" ||
    disposition === "review_retry"
  ) {
    return "blocked";
  }
  if (
    disposition === "exclude_infrastructure" ||
    disposition === "exclude_probable_test"
  ) {
    return "excluded";
  }
  return null;
}

export function recoveryUrlIntent(
  candidate: VerifiedRecoveryCandidate,
): string {
  const intent: DurableSubmissionIntent = {
    version: SUBMISSION_VERSION,
    kind: "url",
    ingress: "legacy-recovery",
    collections: candidate.catalogPosition === null ? [] : ["legacy-links"],
    payload: { url: { url: candidate.sourceUri } },
    options: {
      tags: ["legacy-recovery"],
      force: false,
      max_bytes: 5_000_000,
    },
  };
  return canonicalSubmissionIntent(intent);
}

function recoveryFileIntent(
  candidate: VerifiedRecoveryCandidate,
  contentDigest: string,
  byteSize: number,
): string {
  if (candidate.artifact === null) {
    throw recoveryAdmissionError(
      "recovery_artifact_missing",
      `candidate ${candidate.candidateId} has no approved offline Artifact`,
    );
  }
  const intent: DurableSubmissionIntent = {
    version: SUBMISSION_VERSION,
    kind: "file",
    ingress: "legacy-recovery",
    collections: candidate.catalogPosition === null ? [] : ["legacy-links"],
    payload: {
      file: {
        content_digest: contentDigest,
        byte_size: byteSize,
        media_type: "text/markdown; charset=utf-8",
        artifact_role: "imported_markdown",
      },
    },
    options: {
      title: candidate.artifact.summary,
      tags: ["legacy-recovery"],
      force: false,
      max_bytes: Math.max(1, byteSize),
    },
  };
  return canonicalSubmissionIntent(intent);
}

function ensureRecoveryContext(
  store: ResearchStore,
  generation: VerifiedRecoveryGeneration,
  timestamp: string,
): RecoveryAdmissionContext {
  const transaction = store.db.transaction((): RecoveryAdmissionContext => {
    store.db
      .query(
        `INSERT OR IGNORE INTO sources(
           source_type, identifier, display_name, enabled, sensitivity,
           created_at, updated_at
         ) VALUES ('frozen_recovery_generation', ?, NULL, 0, 'normal', ?, ?)`,
      )
      .run(generation.generationId, timestamp, timestamp);
    const source = store.db
      .query(
        "SELECT id FROM sources WHERE source_type='frozen_recovery_generation' AND identifier=?",
      )
      .get(generation.generationId) as { id: number } | null;
    if (source === null) {
      throw recoveryAdmissionError(
        "recovery_admission_failed",
        "the frozen recovery generation Source could not be admitted",
      );
    }
    const checkpoint = JSON.stringify({
      generation_id: generation.generationId,
      manifest_digest: generation.manifestDigest,
    });
    let run = store.db
      .query(
        `SELECT id, checkpoint FROM runs
         WHERE run_type='legacy_recovery_import' AND source_id=?
         ORDER BY id LIMIT 1`,
      )
      .get(source.id) as { id: number; checkpoint: string | null } | null;
    if (run === null) {
      const inserted = store.db
        .query(
          `INSERT INTO runs(
             run_type, source_id, state, checkpoint, created_at, updated_at
           ) VALUES ('legacy_recovery_import', ?, 'pending', ?, ?, ?)`,
        )
        .run(source.id, checkpoint, timestamp, timestamp);
      run = { id: Number(inserted.lastInsertRowid), checkpoint };
    } else if (run.checkpoint !== checkpoint) {
      throw recoveryAdmissionError(
        "mixed_recovery_generation",
        "the existing recovery run has a different frozen checkpoint",
      );
    }
    store.db
      .query(
        `INSERT OR IGNORE INTO collections(
           slug, title, sensitivity, created_at, updated_at
         ) VALUES ('legacy-links', 'Legacy links', 'normal', ?, ?)`,
      )
      .run(timestamp, timestamp);
    const collection = store.db
      .query("SELECT id FROM collections WHERE slug='legacy-links'")
      .get() as { id: number } | null;
    if (collection === null) {
      throw recoveryAdmissionError(
        "recovery_admission_failed",
        "the legacy-links Collection could not be admitted",
      );
    }
    return {
      sourceId: source.id,
      runId: run.id,
      collectionId: collection.id,
      timestamp,
    };
  });
  return transaction.immediate();
}

function sensitivityRank(value: Sensitivity): number {
  return ["public", "normal", "sensitive", "private"].indexOf(value);
}

function ensureRecoveryResource(
  store: ResearchStore,
  candidate: VerifiedRecoveryCandidate,
  timestamp: string,
): number {
  const candidateResource = store.db
    .query(
      "SELECT id, sensitivity FROM resources WHERE key_type='recovery_candidate' AND key_value=?",
    )
    .get(candidate.candidateId) as {
    id: number;
    sensitivity: Sensitivity;
  } | null;
  const exactOwners = store.db
    .query(
      `SELECT DISTINCT r.id, r.sensitivity
       FROM resources r
       JOIN resource_aliases ra ON ra.resource_id=r.id
       WHERE ra.alias_type='legacy_exact_url' AND ra.locator=?
       ORDER BY r.id`,
    )
    .all(candidate.sourceUri) as Array<{
    id: number;
    sensitivity: Sensitivity;
  }>;
  if (exactOwners.length > 1) {
    throw recoveryAdmissionError(
      "recovery_identity_conflict",
      `candidate ${candidate.candidateId} exact identity belongs to multiple Resources`,
    );
  }

  let resource = exactOwners[0] ?? candidateResource;
  if (
    candidateResource !== null &&
    resource !== null &&
    candidateResource.id !== resource.id
  ) {
    const candidateAliases = store.db
      .query(
        `SELECT locator FROM resource_aliases
         WHERE resource_id=? AND alias_type='legacy_exact_url'`,
      )
      .all(candidateResource.id) as Array<{ locator: string }>;
    if (candidateAliases.length > 0) {
      throw recoveryAdmissionError(
        "recovery_identity_conflict",
        `candidate ${candidate.candidateId} conflicts with an existing exact identity owner`,
      );
    }
  }
  if (resource === null) {
    const inserted = store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, sensitivity, created_at, updated_at
         ) VALUES ('recovery_candidate', ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.candidateId,
        candidate.sourceType,
        candidate.sensitivity,
        timestamp,
        timestamp,
      );
    resource = {
      id: Number(inserted.lastInsertRowid),
      sensitivity: candidate.sensitivity,
    };
  } else if (
    sensitivityRank(candidate.sensitivity) >
    sensitivityRank(resource.sensitivity)
  ) {
    store.db
      .query("UPDATE resources SET sensitivity=?, updated_at=? WHERE id=?")
      .run(candidate.sensitivity, timestamp, resource.id);
  }
  const exactAliases = store.db
    .query(
      `SELECT locator FROM resource_aliases
       WHERE resource_id=? AND alias_type='legacy_exact_url'`,
    )
    .all(resource.id) as Array<{ locator: string }>;
  if (exactAliases.some((alias) => alias.locator !== candidate.sourceUri)) {
    throw recoveryAdmissionError(
      "recovery_identity_conflict",
      `candidate ${candidate.candidateId} is already bound to another exact identity`,
    );
  }
  store.db
    .query(
      `INSERT INTO resource_aliases(
         resource_id, alias_type, locator, evidence, first_observed_at,
         last_observed_at
       ) VALUES (?, 'legacy_exact_url', ?, 'frozen recovery candidate', ?, ?)
       ON CONFLICT(resource_id, alias_type, locator) DO UPDATE SET
         last_observed_at=excluded.last_observed_at`,
    )
    .run(resource.id, candidate.sourceUri, timestamp, timestamp);
  store.db
    .query(
      `INSERT INTO resource_aliases(
         resource_id, alias_type, locator, evidence, first_observed_at,
         last_observed_at
       ) VALUES (?, 'comparison_uri', ?, 'diagnostic comparison only', ?, ?)
       ON CONFLICT(resource_id, alias_type, locator) DO UPDATE SET
         last_observed_at=excluded.last_observed_at`,
    )
    .run(resource.id, candidate.comparisonUri, timestamp, timestamp);
  return resource.id;
}

function ensureCandidateOutcome(
  store: ResearchStore,
  generation: VerifiedRecoveryGeneration,
  candidate: VerifiedRecoveryCandidate,
  resourceId: number,
  timestamp: string,
): boolean {
  const existing = store.db
    .query(
      `SELECT id, raw_metadata FROM provenance
       WHERE resource_id=? AND evidence_type='recovery_candidate_outcome'
       ORDER BY id`,
    )
    .all(resourceId) as Array<{ id: number; raw_metadata: string | null }>;
  const base = {
    schema_version: 1,
    candidate_evidence_row_id: candidate.candidateId,
    disposition: candidate.disposition,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    catalog_position: candidate.catalogPosition,
    summary: candidate.artifact?.summary ?? null,
    provenance_counts: candidate.provenanceCounts,
  };
  const matching: Array<{
    id: number;
    metadata: Record<string, unknown>;
  }> = [];
  for (const row of existing) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.raw_metadata ?? "null");
    } catch {
      throw recoveryAdmissionError(
        "recovery_identity_conflict",
        `candidate ${candidate.candidateId} has malformed durable outcome evidence`,
      );
    }
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      typeof (metadata as Record<string, unknown>).candidate_evidence_row_id !==
        "string"
    ) {
      throw recoveryAdmissionError(
        "recovery_identity_conflict",
        `candidate ${candidate.candidateId} has malformed durable outcome evidence`,
      );
    }
    if (
      (metadata as Record<string, unknown>).candidate_evidence_row_id ===
      candidate.candidateId
    ) {
      matching.push({
        id: row.id,
        metadata: metadata as Record<string, unknown>,
      });
    }
  }
  if (matching.length > 1) {
    throw recoveryAdmissionError(
      "recovery_identity_conflict",
      `candidate ${candidate.candidateId} has duplicate durable outcomes`,
    );
  }
  const [durable] = matching;
  if (durable === undefined) {
    store.db
      .query(
        `INSERT INTO provenance(
           resource_id, evidence_type, ingress, raw_metadata, observed_at
         ) VALUES (?, 'recovery_candidate_outcome', 'legacy-recovery', ?, ?)`,
      )
      .run(
        resourceId,
        JSON.stringify({ ...base, generation_ids: [generation.generationId] }),
        timestamp,
      );
    return true;
  }
  const previous = durable.metadata;
  if (previous.disposition !== candidate.disposition) {
    throw recoveryAdmissionError(
      "recovery_identity_conflict",
      `candidate ${candidate.candidateId} conflicts with its durable outcome`,
    );
  }
  const previousGenerations = Array.isArray(previous.generation_ids)
    ? previous.generation_ids.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const generations = [
    ...new Set([...previousGenerations, generation.generationId]),
  ].sort();
  store.db
    .query("UPDATE provenance SET raw_metadata=? WHERE id=?")
    .run(JSON.stringify({ ...base, generation_ids: generations }), durable.id);
  return false;
}

function ensureCatalogMembership(
  store: ResearchStore,
  candidate: VerifiedRecoveryCandidate,
  resourceId: number,
  context: RecoveryAdmissionContext,
): void {
  if (candidate.catalogPosition === null) return;
  const byPosition = store.db
    .query(
      `SELECT resource_id, external_ref FROM collection_memberships
       WHERE collection_id=? AND position=?`,
    )
    .get(context.collectionId, candidate.catalogPosition) as {
    resource_id: number;
    external_ref: string | null;
  } | null;
  const externalRef = `link-${String(candidate.catalogPosition).padStart(5, "0")}`;
  if (
    byPosition !== null &&
    (byPosition.resource_id !== resourceId ||
      byPosition.external_ref !== externalRef)
  ) {
    throw recoveryAdmissionError(
      "recovery_catalog_conflict",
      `catalog position ${candidate.catalogPosition} conflicts with existing evidence`,
    );
  }
  const byResource = store.db
    .query(
      `SELECT position, external_ref FROM collection_memberships
       WHERE collection_id=? AND resource_id=?`,
    )
    .get(context.collectionId, resourceId) as {
    position: number | null;
    external_ref: string | null;
  } | null;
  if (
    byResource !== null &&
    (byResource.position !== candidate.catalogPosition ||
      byResource.external_ref !== externalRef)
  ) {
    throw recoveryAdmissionError(
      "recovery_catalog_conflict",
      `candidate ${candidate.candidateId} conflicts with existing catalog evidence`,
    );
  }
  store.db
    .query(
      `INSERT OR IGNORE INTO collection_memberships(
         collection_id, resource_id, position, external_ref, added_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      context.collectionId,
      resourceId,
      candidate.catalogPosition,
      externalRef,
      context.timestamp,
    );
}

function ensureObservations(
  store: ResearchStore,
  candidate: VerifiedRecoveryCandidate,
  resourceId: number,
  context: RecoveryAdmissionContext,
): { created: number; existing: number } {
  let created = 0;
  let existing = 0;
  for (const observation of candidate.observations) {
    const row = store.db
      .query(
        `SELECT id FROM observations
         WHERE resource_id=? AND ingress='agentbot-secretary'
           AND observed_locator=? AND parent_resource_id IS NULL`,
      )
      .get(resourceId, observation.observationId);
    if (row === null) {
      store.db
        .query(
          `INSERT INTO observations(
             resource_id, source_id, run_id, ingress, observed_locator,
             suppressed, observed_at
           ) VALUES (?, ?, ?, 'agentbot-secretary', ?, 0, ?)`,
        )
        .run(
          resourceId,
          context.sourceId,
          context.runId,
          observation.observationId,
          context.timestamp,
        );
      created += 1;
    } else {
      existing += 1;
    }
    const evidenceType = `secretary_observation:${observation.observationId}`;
    const provenance = store.db
      .query(
        `SELECT id FROM provenance
         WHERE resource_id=? AND evidence_type=?`,
      )
      .get(resourceId, evidenceType);
    if (provenance === null) {
      store.db
        .query(
          `INSERT INTO provenance(
             resource_id, evidence_type, source_id, run_id, ingress,
             raw_metadata, observed_at
           ) VALUES (?, ?, ?, ?, 'agentbot-secretary', ?, ?)`,
        )
        .run(
          resourceId,
          evidenceType,
          context.sourceId,
          context.runId,
          JSON.stringify({
            schema_version: 1,
            observation_id: observation.observationId,
            fields: observation.fields,
            observed_in: observation.observedIn,
            sender_kind: observation.senderKind,
            soft_deleted_provenance: observation.softDeletedProvenance,
          }),
          context.timestamp,
        );
    }
  }
  return { created, existing };
}

function ensureImportedArtifact(
  store: ResearchStore,
  candidate: VerifiedRecoveryCandidate,
  resourceId: number,
  context: RecoveryAdmissionContext,
  stored: StoredArtifact,
): { created: boolean; existing: boolean } {
  if (candidate.artifact === null) {
    throw recoveryAdmissionError(
      "recovery_artifact_missing",
      `candidate ${candidate.candidateId} has no approved Artifact`,
    );
  }
  let artifact = store.db
    .query(
      `SELECT id, media_type, byte_size, storage_path FROM artifacts
       WHERE content_hash=? AND artifact_role='imported_markdown'`,
    )
    .get(stored.contentDigest) as {
    id: number;
    media_type: string;
    byte_size: number;
    storage_path: string | null;
  } | null;
  let created = false;
  if (artifact === null) {
    const inserted = store.db
      .query(
        `INSERT INTO artifacts(
           content_hash, media_type, byte_size, artifact_role, sensitivity,
           storage_path, created_at
         ) VALUES (?, 'text/markdown; charset=utf-8', ?,
                   'imported_markdown', ?, ?, ?)`,
      )
      .run(
        stored.contentDigest,
        stored.byteSize,
        candidate.sensitivity,
        stored.storagePath,
        context.timestamp,
      );
    artifact = {
      id: Number(inserted.lastInsertRowid),
      media_type: "text/markdown; charset=utf-8",
      byte_size: stored.byteSize,
      storage_path: stored.storagePath,
    };
    created = true;
  } else if (
    artifact.media_type !== "text/markdown; charset=utf-8" ||
    artifact.byte_size !== stored.byteSize ||
    artifact.storage_path !== stored.storagePath
  ) {
    throw recoveryAdmissionError(
      "recovery_artifact_conflict",
      `candidate ${candidate.candidateId} conflicts with stored Artifact metadata`,
    );
  }
  store.db
    .query(
      `INSERT OR IGNORE INTO resource_artifacts(
         resource_id, artifact_id, observed_at
       ) VALUES (?, ?, ?)`,
    )
    .run(resourceId, artifact.id, context.timestamp);
  const provenance = store.db
    .query(
      `SELECT id FROM provenance
       WHERE resource_id=? AND evidence_type='legacy_markdown_import'
         AND artifact_id=?`,
    )
    .get(resourceId, artifact.id);
  if (provenance === null) {
    store.db
      .query(
        `INSERT INTO provenance(
           resource_id, evidence_type, source_id, run_id, artifact_id, ingress,
           raw_metadata, observed_at
         ) VALUES (?, 'legacy_markdown_import', ?, ?, ?, 'legacy-recovery', ?, ?)`,
      )
      .run(
        resourceId,
        context.sourceId,
        context.runId,
        artifact.id,
        JSON.stringify({
          schema_version: 1,
          candidate_evidence_row_id: candidate.candidateId,
          source_sha256: candidate.artifact.sourceDigest,
          source_byte_size: candidate.artifact.sourceByteSize,
          summary: candidate.artifact.summary,
          frontmatter_removed: true,
        }),
        context.timestamp,
      );
  }
  return { created, existing: !created };
}

function ensureRecoveryJob(
  store: ResearchStore,
  candidate: VerifiedRecoveryCandidate,
  resourceId: number,
  context: RecoveryAdmissionContext,
  stored: StoredArtifact | null,
): { created: boolean; existing: boolean } {
  const targetState = recoveryJobState(candidate.disposition);
  if (targetState === null) return { created: false, existing: false };
  const intent =
    targetState === "queued"
      ? recoveryFileIntent(
          candidate,
          (stored as StoredArtifact).contentDigest,
          (stored as StoredArtifact).byteSize,
        )
      : recoveryUrlIntent(candidate);
  const kind = targetState === "queued" ? "file" : "url";
  const idempotencyKey = `${RECOVERY_JOB_PREFIX}${candidate.candidateId}`;
  const existing = store.db
    .query(
      `SELECT id, kind, intent, resource_id FROM jobs
       WHERE idempotency_key=?`,
    )
    .get(idempotencyKey) as {
    id: number;
    kind: string;
    intent: string | null;
    resource_id: number | null;
  } | null;
  if (existing !== null) {
    if (
      existing.kind !== kind ||
      existing.intent !== intent ||
      existing.resource_id !== resourceId
    ) {
      throw recoveryAdmissionError(
        "recovery_idempotency_conflict",
        `candidate ${candidate.candidateId} conflicts with an existing ingestion job`,
      );
    }
    return { created: false, existing: true };
  }
  const blockReason =
    targetState === "blocked"
      ? `recovery disposition ${candidate.disposition}`
      : null;
  const inserted = store.db
    .query(
      `INSERT INTO jobs(
         idempotency_key, kind, intent, resource_id, source_id, run_id, state,
         sensitivity, run_at, block_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      idempotencyKey,
      kind,
      intent,
      resourceId,
      context.sourceId,
      context.runId,
      targetState,
      candidate.sensitivity,
      context.timestamp,
      blockReason,
      context.timestamp,
      context.timestamp,
    );
  store.db
    .query(
      `INSERT INTO job_transitions(
         job_id, from_state, to_state, actor, reason, detail, created_at
       ) VALUES (?, NULL, ?, 'legacy-recovery', 'admitted', NULL, ?)`,
    )
    .run(Number(inserted.lastInsertRowid), targetState, context.timestamp);
  return { created: true, existing: false };
}

function admitRecoveryCandidate(
  store: ResearchStore,
  generation: VerifiedRecoveryGeneration,
  candidate: VerifiedRecoveryCandidate,
  context: RecoveryAdmissionContext,
  artifactStore: ArtifactStore,
): RecoveryCandidateEffect {
  const stored =
    candidate.disposition === "import_offline" && candidate.artifact !== null
      ? artifactStore.captureBytes(candidate.artifact.body, {
          expectedDigest: candidate.artifact.bodyDigest,
          maxBytes: candidate.artifact.bodyByteSize,
        })
      : null;
  const transaction = store.db.transaction((): RecoveryCandidateEffect => {
    const resourceId = ensureRecoveryResource(
      store,
      candidate,
      context.timestamp,
    );
    const outcomeCreated = ensureCandidateOutcome(
      store,
      generation,
      candidate,
      resourceId,
      context.timestamp,
    );
    ensureCatalogMembership(store, candidate, resourceId, context);
    const observations = ensureObservations(
      store,
      candidate,
      resourceId,
      context,
    );
    const artifact =
      stored === null
        ? { created: false, existing: false }
        : ensureImportedArtifact(store, candidate, resourceId, context, stored);
    const job = ensureRecoveryJob(
      store,
      candidate,
      resourceId,
      context,
      stored,
    );
    return {
      outcomeCreated,
      observationsCreated: observations.created,
      observationsExisting: observations.existing,
      artifactCreated: artifact.created,
      artifactExisting: artifact.existing,
      jobCreated: job.created,
      jobExisting: job.existing,
    };
  });
  return transaction.immediate();
}

function recoveryReport(
  generation: VerifiedRecoveryGeneration,
  dryRun: boolean,
  runId: number | null,
  offlineAuthorization: {
    authorizationDigest: string;
    allowedKinds: string[];
    expectedJobCount: number;
  } | null,
  effects: {
    outcomesCreated: number;
    outcomesExisting: number;
    observationsCreated: number;
    observationsExisting: number;
    artifactsCreated: number;
    artifactsExisting: number;
    jobsCreated: number;
    jobsExisting: number;
  },
): RecoveryImportReport {
  return {
    schema_version: 1,
    status: dryRun ? "verified" : "queued",
    dry_run: dryRun,
    generation_id: generation.generationId,
    counts: { ...generation.counts },
    dispositions: { ...generation.dispositionCounts },
    jobs: {
      queued: generation.counts.approved_offline_artifacts,
      blocked:
        generation.counts.approved_online_jobs +
        generation.counts.blocked_review_jobs,
      excluded: generation.counts.excluded_candidates,
      evidence_only: generation.counts.evidence_only_candidates,
      created: effects.jobsCreated,
      existing: effects.jobsExisting,
    },
    effects: {
      candidate_outcomes_created: effects.outcomesCreated,
      candidate_outcomes_existing: effects.outcomesExisting,
      observations_created: effects.observationsCreated,
      observations_existing: effects.observationsExisting,
      artifacts_created: effects.artifactsCreated,
      artifacts_existing: effects.artifactsExisting,
    },
    run: {
      id: runId,
      state: dryRun ? "verified" : "pending",
      operator_controlled: offlineAuthorization !== null,
      authorization_digest: offlineAuthorization?.authorizationDigest ?? null,
      allowed_job_kinds: offlineAuthorization?.allowedKinds ?? [],
      expected_job_count: offlineAuthorization?.expectedJobCount ?? null,
    },
  };
}

export function admitRecoveryGeneration(
  store: ResearchStore | null,
  generation: VerifiedRecoveryGeneration,
  options: RecoveryAdmissionOptions = {},
): RecoveryImportReport {
  if (options.dryRun === true) {
    return recoveryReport(generation, true, null, null, {
      outcomesCreated: 0,
      outcomesExisting: 0,
      observationsCreated: 0,
      observationsExisting: 0,
      artifactsCreated: 0,
      artifactsExisting: 0,
      jobsCreated: 0,
      jobsExisting: 0,
    });
  }
  if (store === null) {
    throw recoveryAdmissionError(
      "recovery_admission_failed",
      "a writable Index owner is required for recovery admission",
    );
  }
  const timestamp = (options.now ?? new Date()).toISOString();
  const context = ensureRecoveryContext(store, generation, timestamp);
  const artifactStore = options.artifactStore ?? new ArtifactStore();
  const effects = {
    outcomesCreated: 0,
    outcomesExisting: 0,
    observationsCreated: 0,
    observationsExisting: 0,
    artifactsCreated: 0,
    artifactsExisting: 0,
    jobsCreated: 0,
    jobsExisting: 0,
  };
  for (const candidate of generation.candidates) {
    const effect = admitRecoveryCandidate(
      store,
      generation,
      candidate,
      context,
      artifactStore,
    );
    if (effect.outcomeCreated) effects.outcomesCreated += 1;
    else effects.outcomesExisting += 1;
    effects.observationsCreated += effect.observationsCreated;
    effects.observationsExisting += effect.observationsExisting;
    if (effect.artifactCreated) effects.artifactsCreated += 1;
    if (effect.artifactExisting) effects.artifactsExisting += 1;
    if (effect.jobCreated) effects.jobsCreated += 1;
    if (effect.jobExisting) effects.jobsExisting += 1;
  }
  const offlineAuthorization =
    options.authorizeOffline === true
      ? store.authorizeRunScope({
          runId: context.runId,
          mode: "offline",
          authorizationDigest: generation.generationDigest,
          allowedKinds: [RECOVERY_OFFLINE_SCOPE_KIND],
          expectedJobCount: generation.counts.approved_offline_artifacts,
          now: options.now,
        })
      : null;
  return recoveryReport(
    generation,
    false,
    context.runId,
    offlineAuthorization,
    effects,
  );
}

export async function waitForAdmission(
  store: ResearchStore,
  result: AdmissionResult,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollMs = 50,
): Promise<AdmissionResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw admissionError(
      "bad_wait_timeout",
      "wait_timeout_ms must be a non-negative integer",
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = store.db
      .query("SELECT state FROM jobs WHERE id=?")
      .get(result.job_id) as { state: JobState } | null;
    if (row === null)
      throw new CliError("job_not_found", `job ${result.job_id} not found`);
    if (TERMINAL_JOB_STATES.has(row.state)) {
      return { ...result, state: row.state, wait_status: "terminal" };
    }
    if (Date.now() >= deadline) {
      return { ...result, state: row.state, wait_status: "timeout" };
    }
    if (brainSignal()?.aborted) return { ...result, state: row.state, wait_status: "timeout" };
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal: brainSignal() }).catch((error) => { if (!brainSignal()?.aborted) throw error; });
  }
}
