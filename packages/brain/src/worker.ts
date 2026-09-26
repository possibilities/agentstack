import { setTimeout as sleep } from "node:timers/promises";
import { brainSignal } from "./paths.js";
import { hostname } from "node:os";
import { type DurableSubmissionIntent, RECOVERY_JOB_PREFIX } from "./admission.js";
import {
  AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES,
  AgentscrapeDiscoveryError,
  AgentscrapeExtractionError,
  type ExtractionProvider,
  extractWithAgentscrape,
  type SourceDiscoveryProvider,
  validateExtractionEnvelope,
} from "./agentscrape.js";
import {
  ArtifactStore,
  ArtifactStoreError,
  isSafeArtifactStoragePath,
} from "./artifacts.js";
import {
  decodeBytes,
  extractDocxBytes,
  extractEpubBytes,
  extractHtmlText,
  extractPdf,
  inferTitleFromSource,
  isProbablyBinary,
} from "./extract.js";
import { planQueuedUrlFanout, QUEUED_FANOUT_JOB_PREFIX } from "./link-ingest.js";
import { sanitizeExternalError } from "./sanitize.js";
import {
  dispatchSourceRun,
  SourceRunDispatchCancellationError,
  SourceRunDispatchError,
} from "./source-worker.js";
import { DEFAULT_LIFECYCLE_POLICY, type ResearchStore } from "./store.js";
import { cleanText } from "./text.js";
import type {
  ContentKind,
  ExtractionFanoutPlan,
  ExtractionSuccess,
  FailureClass,
  Job,
  JobState,
  LifecyclePolicy,
  OperatorRunScope,
  PromotedUrlExtraction,
  Sensitivity,
} from "./types.js";
import {
  canonicalizeSource,
  normalizedWebUrl,
  xArticleId,
  xStatusId,
} from "./url.js";

export interface MaterializedDocument {
  sourceType: string;
  sourceUri: string;
  title: string;
  content: string;
  contentKind?: ContentKind | null;
  contentItemCount?: number | null;
  tags?: string[];
  notes?: string;
  mediaType?: string;
  artifactDigest?: string;
  resourceKey?: { type: string; value: string };
  aliases?: Array<{ type: string; locator: string; evidence: string }>;
  artifact?: {
    contentDigest: string;
    byteSize: number;
    mediaType: string;
    artifactRole: string;
    storagePath: string;
    provenance: Record<string, unknown>;
  };
  fanout?: ExtractionFanoutPlan;
}

export interface MaterializerContext {
  artifactStore: ArtifactStore;
  signal: AbortSignal;
  extract: ExtractionProvider;
}

export type JobMaterializer = (
  job: Job,
  intent: DurableSubmissionIntent,
  context: MaterializerContext,
) => Promise<MaterializedDocument[]> | MaterializedDocument[];

export interface WorkerOptions {
  once?: boolean;
  workerId?: string;
  pollMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  shutdownGraceMs?: number;
  artifactStore?: ArtifactStore;
  materialize?: JobMaterializer;
  extract?: ExtractionProvider;
  /** Provider seam for offline source-run tests. */
  sourceDiscovery?: SourceDiscoveryProvider;
  /** @deprecated Use sourceDiscovery. */
  discovery?: SourceDiscoveryProvider;
  /** Fault-injection seam immediately before a source Checkpoint write. */
  beforeSourceCheckpointCommit?: () => void;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  policy?: Partial<LifecyclePolicy>;
  random?: () => number;
  signal?: AbortSignal;
  installSignalHandlers?: boolean;
  scope?: OperatorRunScope;
}

export interface WorkerResult {
  worker_id: string;
  scope: {
    run_id: number;
    execution_mode: "offline" | "online";
    authorization_digest: string;
    allowed_job_kinds: string[];
    expected_job_count: number;
  } | null;
  scheduled: number;
  recovered: number;
  claimed: number;
  completed: number;
  failed: number;
  fenced: number;
  stopped: boolean;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

function abortError(): Error {
  const error = new Error("worker shutdown requested");
  error.name = "AbortError";
  return error;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return sleep(milliseconds);
}

function parseIntent(job: Job): DurableSubmissionIntent {
  if (job.intent === null)
    throw new Error("ingestion job has no durable intent");
  let value: unknown;
  try {
    value = JSON.parse(job.intent);
  } catch {
    throw new Error("ingestion job has an invalid durable intent");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { kind?: unknown }).kind !== "string" ||
    (value as { kind: string }).kind !== job.kind
  ) {
    throw new Error("ingestion job has an unsupported durable intent");
  }
  return value as DurableSubmissionIntent;
}

function titleFromMarkdown(source: string, markdown: string): string {
  for (const line of markdown.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      return Array.from(stripped.replace(/^#+/, "").trim() || source)
        .slice(0, 500)
        .join("");
    }
    if (stripped) return Array.from(stripped).slice(0, 120).join("");
  }
  return inferTitleFromSource(source);
}

function extractArtifact(
  artifacts: ArtifactStore,
  digest: string,
  mediaType: string,
  maxBytes: number,
): string {
  if (mediaType === "application/pdf") {
    return extractPdf(artifacts.pathFor(digest), maxBytes);
  }
  const bytes = artifacts.readBytes(digest, maxBytes);
  if (
    mediaType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocxBytes(bytes, maxBytes);
  }
  if (mediaType === "application/epub+zip") {
    return extractEpubBytes(bytes, maxBytes);
  }
  if (isProbablyBinary(bytes)) throw new Error("Artifact appears to be binary");
  const decoded = decodeBytes(bytes);
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return extractHtmlText(decoded).content;
  }
  return cleanText(decoded);
}

interface IntentArtifact {
  content_digest: string;
  byte_size: number;
  media_type: string;
}

function requireArtifact(value: unknown): IntentArtifact {
  if (value === null || typeof value !== "object") {
    throw new Error("durable intent has no Artifact descriptor");
  }
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact.content_digest !== "string" ||
    typeof artifact.byte_size !== "number" ||
    typeof artifact.media_type !== "string"
  ) {
    throw new Error("durable intent has an invalid Artifact descriptor");
  }
  return artifact as unknown as IntentArtifact;
}

function hasBoundedIdentityText(
  value: unknown,
  maximumCodePoints: number,
  minimumCodePoints = 0,
): value is string {
  return (
    typeof value === "string" &&
    [...value].length >= minimumCodePoints &&
    [...value].length <= maximumCodePoints &&
    Buffer.byteLength(value, "utf8") <= maximumCodePoints * 4
  );
}

function hasValidHistoricalExtractor(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const extractor = value as Record<string, unknown>;
  const keys = [
    "name",
    "version",
    "implementation",
    "implementation_version",
  ].sort();
  return (
    Object.keys(extractor).length === keys.length &&
    !Object.keys(extractor)
      .sort()
      .some((key, index) => key !== keys[index]) &&
    hasBoundedIdentityText(extractor.name, 100, 1) &&
    hasBoundedIdentityText(extractor.version, 100) &&
    hasBoundedIdentityText(extractor.implementation, 100) &&
    hasBoundedIdentityText(extractor.implementation_version, 100)
  );
}

function cacheRecord(value: unknown): PromotedUrlExtraction {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentscrapeExtractionError(
      "agentscrape protocol defect: cached extraction record is invalid",
      "permanent",
      "protocol",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "record_version",
    "requested_url",
    "final_url",
    "extractor",
    "artifact",
    "metadata",
    "relations",
  ].sort();
  if (
    Object.keys(record)
      .sort()
      .some((key, index) => key !== keys[index]) ||
    Object.keys(record).length !== keys.length ||
    record.record_version !== 1 ||
    !hasValidHistoricalExtractor(record.extractor) ||
    record.artifact === null ||
    typeof record.artifact !== "object" ||
    Array.isArray(record.artifact)
  ) {
    throw new AgentscrapeExtractionError(
      "agentscrape protocol defect: cached extraction record is invalid",
      "permanent",
      "protocol",
    );
  }
  const artifact = record.artifact as Record<string, unknown>;
  const artifactKeys = [
    "artifact_type",
    "media_type",
    "encoding",
    "size_bytes",
    "sha256",
    "artifact_role",
    "storage_path",
  ].sort();
  if (
    Object.keys(artifact)
      .sort()
      .some((key, index) => key !== artifactKeys[index]) ||
    Object.keys(artifact).length !== artifactKeys.length ||
    artifact.artifact_role !== "extracted_markdown" ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    typeof artifact.storage_path !== "string" ||
    !isSafeArtifactStoragePath(artifact.storage_path, artifact.sha256)
  ) {
    throw new AgentscrapeExtractionError(
      "agentscrape protocol defect: cached extraction Artifact is invalid",
      "permanent",
      "protocol",
    );
  }
  return record as unknown as PromotedUrlExtraction;
}

function extractionFromCache(
  artifacts: ArtifactStore,
  jobId: number,
  url: string,
  maxContentBytes: number,
): { extraction: ExtractionSuccess; record: PromotedUrlExtraction } | null {
  const cached = artifacts.readUrlExtraction(jobId);
  if (cached === null) return null;
  const record = cacheRecord(cached);
  const stored = artifacts.verify(record.artifact.sha256);
  if (
    stored.byteSize !== record.artifact.size_bytes ||
    stored.storagePath !== record.artifact.storage_path
  ) {
    throw new ArtifactStoreError(
      "artifact_corrupt",
      "cached URL extraction Artifact metadata does not match its bytes",
    );
  }
  const content = artifacts.readUtf8(record.artifact.sha256, maxContentBytes);
  const envelope = validateExtractionEnvelope(
    {
      schema_version: "1",
      status: "success",
      requested_url: record.requested_url,
      final_url: record.final_url,
      extractor: { ...record.extractor, name: "agentscrape" },
      artifacts: [
        {
          artifact_type: record.artifact.artifact_type,
          media_type: record.artifact.media_type,
          encoding: record.artifact.encoding,
          content,
          size_bytes: record.artifact.size_bytes,
          sha256: record.artifact.sha256,
        },
      ],
      metadata: record.metadata,
      relations: record.relations,
      failure: null,
    },
    url,
    { maxContentBytes },
  );
  if (envelope.status !== "success") {
    throw new AgentscrapeExtractionError(
      "agentscrape protocol defect: cached extraction is not successful",
      "permanent",
      "protocol",
    );
  }
  return { extraction: envelope, record };
}

function promoteExtraction(
  artifacts: ArtifactStore,
  jobId: number,
  extraction: ExtractionSuccess,
  maxContentBytes: number,
): PromotedUrlExtraction {
  const descriptor = extraction.artifacts[0];
  const stored = artifacts.captureBytes(descriptor.content, {
    expectedDigest: descriptor.sha256,
    maxBytes: maxContentBytes,
  });
  const record: PromotedUrlExtraction = {
    record_version: 1,
    requested_url: extraction.requested_url,
    final_url: extraction.final_url,
    extractor: extraction.extractor,
    artifact: {
      artifact_type: descriptor.artifact_type,
      media_type: descriptor.media_type,
      encoding: descriptor.encoding,
      size_bytes: descriptor.size_bytes,
      sha256: descriptor.sha256,
      artifact_role: "extracted_markdown",
      storage_path: stored.storagePath,
    },
    metadata: extraction.metadata,
    relations: extraction.relations,
  };
  artifacts.writeUrlExtraction(jobId, record);
  return record;
}

function urlDocument(
  job: Job,
  url: string,
  extraction: ExtractionSuccess,
  record: PromotedUrlExtraction,
  intent: DurableSubmissionIntent,
): MaterializedDocument {
  const [sourceType, sourceUri] = canonicalizeSource(url);
  const statusId = xStatusId(url);
  const articleId = xArticleId(url);
  const resourceKey = statusId
    ? { type: "x:status", value: statusId }
    : articleId
      ? { type: "x:article", value: articleId }
      : { type: "url", value: normalizedWebUrl(url) };
  const contentKind =
    extraction.metadata.content_kind ??
    (extraction.metadata.content_type === "article" ? "article" : undefined);
  const contentItemCount =
    extraction.metadata.content_item_count ??
    (contentKind === "article" ? 1 : undefined);
  const aliases = [
    {
      type: "submitted_url",
      locator: normalizedWebUrl(url),
      evidence: "intent",
    },
    {
      type: "extractor_requested_url",
      locator: extraction.requested_url,
      evidence: "agentscrape",
    },
    {
      type: "redirect_resolved_url",
      locator: extraction.final_url,
      evidence: "agentscrape",
    },
  ];
  return {
    sourceType,
    sourceUri,
    title:
      intent.options.title ??
      (extraction.metadata.title ||
        titleFromMarkdown(sourceUri, extraction.artifacts[0].content)),
    content: extraction.artifacts[0].content,
    contentKind,
    contentItemCount,
    mediaType: record.artifact.media_type,
    tags: intent.options.tags,
    notes: intent.options.notes,
    resourceKey,
    aliases,
    artifactDigest: record.artifact.sha256,
    artifact: {
      contentDigest: record.artifact.sha256,
      byteSize: record.artifact.size_bytes,
      mediaType: record.artifact.media_type,
      artifactRole: record.artifact.artifact_role,
      storagePath: record.artifact.storage_path,
      provenance: {
        schema_version: String(record.record_version),
        requested_url: record.requested_url,
        final_url: record.final_url,
        extractor: record.extractor,
        metadata: record.metadata,
      },
    },
    fanout: planQueuedUrlFanout(url, extraction.relations, {
      oneHopChild: job.idempotency_key.startsWith(QUEUED_FANOUT_JOB_PREFIX),
    }),
  };
}

const defaultMaterializer: JobMaterializer = async (job, intent, context) => {
  if (context.signal.aborted) throw abortError();
  const options = intent.options;
  const common = {
    tags: options.tags,
    notes: options.notes,
  };
  if (intent.kind === "url") {
    if (!("url" in intent.payload))
      throw new Error("URL intent payload is missing");
    const url = intent.payload.url.url;
    const maxContentBytes = Math.min(
      options.max_bytes,
      AGENTSCRAPE_DEFAULT_MARKDOWN_MAX_BYTES,
    );
    const cached = extractionFromCache(
      context.artifactStore,
      job.id,
      url,
      maxContentBytes,
    );
    let extraction: ExtractionSuccess;
    let record: PromotedUrlExtraction;
    if (cached === null) {
      extraction = await context.extract(url, {
        maxContentBytes,
        signal: context.signal,
      });
      if (context.signal.aborted) throw abortError();
      const validated = validateExtractionEnvelope(extraction, url, {
        maxContentBytes,
      });
      if (validated.status !== "success") {
        throw new AgentscrapeExtractionError(
          "agentscrape protocol defect: extraction provider returned a failure value",
          "permanent",
          "protocol",
        );
      }
      extraction = validated;
      record = promoteExtraction(
        context.artifactStore,
        job.id,
        extraction,
        maxContentBytes,
      );
    } else {
      extraction = cached.extraction;
      record = cached.record;
    }
    if (context.signal.aborted) throw abortError();
    return [urlDocument(job, url, extraction, record, intent)];
  }

  const descriptors =
    intent.kind === "text" && "text" in intent.payload
      ? [requireArtifact(intent.payload.text)]
      : intent.kind === "file" && "file" in intent.payload
        ? [requireArtifact(intent.payload.file)]
        : intent.kind === "directory" && "directory" in intent.payload
          ? intent.payload.directory.artifacts.map(requireArtifact)
          : [];
  if (descriptors.length === 0 && intent.kind !== "directory") {
    throw new Error("local intent payload is missing");
  }
  return descriptors.map((artifact, index) => {
    if (context.signal.aborted) throw abortError();
    const content = extractArtifact(
      context.artifactStore,
      artifact.content_digest,
      artifact.media_type,
      options.max_bytes,
    );
    return {
      sourceType: intent.kind === "text" ? "text" : "file",
      sourceUri: `ingestion-job:${job.id}:artifact:${index + 1}`,
      title:
        options.title ??
        (intent.kind === "text"
          ? "Pasted note"
          : `Captured Artifact ${artifact.content_digest.slice(0, 12)}`),
      content,
      mediaType: artifact.media_type,
      artifactDigest: artifact.content_digest,
      ...common,
    };
  });
};

function classifyFailure(error: unknown): FailureClass {
  if (error instanceof SourceRunDispatchError) return error.failureClass;
  if (error instanceof AgentscrapeDiscoveryError) {
    return error.disposition === "cancelled" ? "permanent" : error.disposition;
  }
  if (error instanceof AgentscrapeExtractionError) {
    return error.disposition === "cancelled" ? "permanent" : error.disposition;
  }
  if (error instanceof ArtifactStoreError) return "infra";
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  if (
    /not installed|not found|credential|authorization|authentication|permission/.test(
      message,
    )
  ) {
    return "auth_config";
  }
  if (
    /timeout|timed out|unavailable|busy|locked|econn|temporar|interrupted/.test(
      message,
    )
  ) {
    return "infra";
  }
  if (/429|rate limit|throttl/.test(message)) return "item_transient";
  return "permanent";
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  normal: 1,
  sensitive: 2,
  private: 3,
};

function applyDocuments(
  store: ResearchStore,
  job: Job,
  intent: DurableSubmissionIntent,
  documents: MaterializedDocument[],
  observedAt: Date,
): number | null {
  let firstResourceId: number | null = null;
  const timestamp = observedAt.toISOString();
  for (const [index, document] of documents.entries()) {
    const recoveryJob =
      intent.ingress === "legacy-recovery" &&
      job.idempotency_key.startsWith(RECOVERY_JOB_PREFIX);
    const recoveryResource =
      recoveryJob && job.resource_id !== null
        ? (store.db
            .query(
              `SELECT r.id, r.kind, r.sensitivity, ra.locator
               FROM resources r
               JOIN resource_aliases ra ON ra.resource_id=r.id
                 AND ra.alias_type='legacy_exact_url'
               WHERE r.id=?`,
            )
            .get(job.resource_id) as {
            id: number;
            kind: string;
            sensitivity: Sensitivity;
            locator: string;
          } | null)
        : null;
    if (recoveryJob && recoveryResource === null) {
      throw new Error("legacy recovery job has no exact Resource identity");
    }
    const indexed = store.upsertDocument({
      sourceType: recoveryResource?.kind ?? document.sourceType,
      sourceUri: recoveryResource?.locator ?? document.sourceUri,
      title: document.title,
      content: document.content,
      contentKind: document.contentKind,
      contentItemCount: document.contentItemCount,
      tags: document.tags,
      notes: document.notes,
      mediaType: document.mediaType ?? document.artifact?.mediaType,
      revisionDigest:
        document.artifactDigest ?? document.artifact?.contentDigest,
      force: intent.options.force,
    });
    let resource: { id: number; sensitivity: Sensitivity };
    if (recoveryResource !== null) {
      const documentOwner = store.db
        .query("SELECT id, sensitivity FROM resources WHERE document_id=?")
        .get(indexed.document_id) as {
        id: number;
        sensitivity: Sensitivity;
      } | null;
      if (documentOwner === null || documentOwner.id === recoveryResource.id) {
        store.db
          .query("UPDATE resources SET document_id=?, updated_at=? WHERE id=?")
          .run(indexed.document_id, timestamp, recoveryResource.id);
        resource = recoveryResource;
      } else {
        const sensitivity =
          SENSITIVITY_RANK[recoveryResource.sensitivity] >
          SENSITIVITY_RANK[documentOwner.sensitivity]
            ? recoveryResource.sensitivity
            : documentOwner.sensitivity;
        store.db
          .query("UPDATE resources SET sensitivity=?, updated_at=? WHERE id=?")
          .run(sensitivity, timestamp, documentOwner.id);
        resource = { id: documentOwner.id, sensitivity };
      }
    } else {
      const resourceKey = document.resourceKey ?? {
        type: "ingestion_job_item",
        value: `${job.id}:${index + 1}`,
      };
      store.db
        .query(
          `INSERT INTO resources(
             key_type, key_value, kind, sensitivity, document_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key_type, key_value) DO UPDATE SET
             document_id=excluded.document_id,
             sensitivity=CASE
               WHEN (SELECT rank FROM sensitivity_levels WHERE level=excluded.sensitivity) >
                    (SELECT rank FROM sensitivity_levels WHERE level=resources.sensitivity)
               THEN excluded.sensitivity ELSE resources.sensitivity END,
             updated_at=excluded.updated_at`,
        )
        .run(
          resourceKey.type,
          resourceKey.value,
          job.kind,
          job.sensitivity,
          indexed.document_id,
          timestamp,
          timestamp,
        );
      resource = store.db
        .query(
          "SELECT id, sensitivity FROM resources WHERE key_type=? AND key_value=?",
        )
        .get(resourceKey.type, resourceKey.value) as {
        id: number;
        sensitivity: Sensitivity;
      };
    }
    if (firstResourceId === null) {
      firstResourceId = resource.id;
    }
    const aliases = [
      {
        type: "materialized_uri",
        locator: document.sourceUri,
        evidence: "worker",
      },
      ...(document.aliases ?? []),
    ];
    const seenAliases = new Set<string>();
    for (const alias of aliases) {
      const key = `${alias.type}\u0000${alias.locator}`;
      if (seenAliases.has(key)) continue;
      seenAliases.add(key);
      store.db
        .query(
          `INSERT INTO resource_aliases(
             resource_id, alias_type, locator, evidence, first_observed_at, last_observed_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(resource_id, alias_type, locator) DO UPDATE SET
             evidence=excluded.evidence,
             last_observed_at=excluded.last_observed_at`,
        )
        .run(
          resource.id,
          alias.type,
          alias.locator,
          alias.evidence,
          timestamp,
          timestamp,
        );
    }
    store.db
      .query(
        `INSERT INTO provenance(
           resource_id, evidence_type, source_id, run_id, ingress, raw_metadata,
           observed_at
         ) VALUES (?, 'ingestion_materialized', ?, ?, ?, ?, ?)`,
      )
      .run(
        resource.id,
        job.source_id,
        job.run_id,
        intent.ingress,
        JSON.stringify({ job_id: job.id, item: index + 1 }),
        timestamp,
      );
    if (document.artifact !== undefined) {
      let artifact = store.db
        .query(
          `SELECT id, media_type, byte_size, sensitivity, storage_path
           FROM artifacts WHERE content_hash=? AND artifact_role=?`,
        )
        .get(
          document.artifact.contentDigest,
          document.artifact.artifactRole,
        ) as {
        id: number;
        media_type: string;
        byte_size: number;
        sensitivity: Sensitivity;
        storage_path: string | null;
      } | null;
      if (artifact === null) {
        const inserted = store.db
          .query(
            `INSERT INTO artifacts(
               content_hash, media_type, byte_size, artifact_role, sensitivity,
               storage_path, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            document.artifact.contentDigest,
            document.artifact.mediaType,
            document.artifact.byteSize,
            document.artifact.artifactRole,
            resource.sensitivity,
            document.artifact.storagePath,
            timestamp,
          );
        artifact = {
          id: Number(inserted.lastInsertRowid),
          media_type: document.artifact.mediaType,
          byte_size: document.artifact.byteSize,
          sensitivity: resource.sensitivity,
          storage_path: document.artifact.storagePath,
        };
      } else {
        if (
          artifact.media_type !== document.artifact.mediaType ||
          artifact.byte_size !== document.artifact.byteSize ||
          artifact.storage_path !== document.artifact.storagePath
        ) {
          throw new Error(
            "extracted Artifact metadata conflicts with existing content",
          );
        }
        if (
          SENSITIVITY_RANK[resource.sensitivity] >
          SENSITIVITY_RANK[artifact.sensitivity]
        ) {
          store.db
            .query("UPDATE artifacts SET sensitivity=? WHERE id=?")
            .run(resource.sensitivity, artifact.id);
        }
      }
      store.db
        .query(
          `INSERT OR IGNORE INTO resource_artifacts(resource_id, artifact_id, observed_at)
           VALUES (?, ?, ?)`,
        )
        .run(resource.id, artifact.id, timestamp);
      store.db
        .query(
          `INSERT INTO provenance(
             resource_id, evidence_type, source_id, run_id, artifact_id, ingress,
             raw_metadata, observed_at
           ) VALUES (?, 'url_extraction', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resource.id,
          job.source_id,
          job.run_id,
          artifact.id,
          intent.ingress,
          JSON.stringify({ job_id: job.id, ...document.artifact.provenance }),
          timestamp,
        );
    } else if (document.artifactDigest !== undefined) {
      const artifact = store.db
        .query(
          "SELECT id FROM artifacts WHERE content_hash=? AND artifact_role='original'",
        )
        .get(document.artifactDigest) as { id: number } | null;
      if (artifact !== null) {
        store.db
          .query(
            `INSERT OR IGNORE INTO resource_artifacts(resource_id, artifact_id, observed_at)
             VALUES (?, ?, ?)`,
          )
          .run(resource.id, artifact.id, timestamp);
      }
    }
    for (const slug of intent.collections) {
      store.db
        .query(
          `INSERT OR IGNORE INTO collections(slug, title, sensitivity, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(slug, slug, resource.sensitivity, timestamp, timestamp);
      store.db
        .query(
          `INSERT OR IGNORE INTO collection_memberships(collection_id, resource_id, added_at)
           SELECT id, ?, ? FROM collections WHERE slug=?`,
        )
        .run(resource.id, timestamp, slug);
    }
    if (document.fanout !== undefined) {
      store.commitUrlFanout({
        parentResourceId: resource.id,
        parentJobId: job.id,
        sourceId: job.source_id,
        runId: job.run_id,
        ingress: intent.ingress,
        sensitivity: resource.sensitivity,
        discoveries: document.fanout.discoveries,
        observedAt,
      });
    }
  }
  if (firstResourceId !== null) {
    store.db
      .query("UPDATE jobs SET resource_id=? WHERE id=?")
      .run(firstResourceId, job.id);
  }
  return firstResourceId;
}

export async function runWorker(
  store: ResearchStore,
  options: WorkerOptions = {},
): Promise<WorkerResult> {
  options = { ...options, signal: options.signal ?? brainSignal(), installSignalHandlers: options.installSignalHandlers ?? !brainSignal() };
  const once = options.once === true;
  const workerId = options.workerId ?? `${hostname()}:${process.pid}`;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LIFECYCLE_POLICY.leaseMs;
  const heartbeatMs =
    options.heartbeatMs ?? Math.max(100, Math.floor(leaseMs / 3));
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const artifactStore = options.artifactStore ?? new ArtifactStore();
  const materialize = options.materialize ?? defaultMaterializer;
  const extract = options.extract ?? extractWithAgentscrape;
  if (
    !Number.isFinite(pollMs) ||
    pollMs < 1 ||
    !Number.isFinite(leaseMs) ||
    leaseMs < 1 ||
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs < 1 ||
    !Number.isFinite(shutdownGraceMs) ||
    shutdownGraceMs < 0
  ) {
    throw new Error(
      "worker timing options must be positive (shutdown grace may be zero)",
    );
  }
  if (options.scope !== undefined && !once) {
    throw new Error("operator-controlled Run scope requires --once");
  }
  const scopePolicy =
    options.scope === undefined
      ? null
      : store.beginRunScope(options.scope, {
          worker: workerId,
          now: now(),
          leaseMs,
        });

  let stopping = options.signal?.aborted === true;
  let activeController: AbortController | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeIdle: (() => void) | null = null;
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    wakeIdle?.();
    if (activeController !== null) {
      shutdownTimer = setTimeout(
        () => activeController?.abort(),
        shutdownGraceMs,
      );
    }
  };
  const onAbort = (): void => requestStop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  if (options.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = (): void => requestStop();
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    }
  }

  const recovered = store.recoverExpiredLeases({
    now: now(),
    policy: options.policy,
    random: options.random,
    scope: options.scope,
    executionToken: scopePolicy?.executionToken,
  }).length;
  const result: WorkerResult = {
    worker_id: workerId,
    scope:
      scopePolicy === null
        ? null
        : {
            run_id: scopePolicy.runId,
            execution_mode: scopePolicy.mode,
            authorization_digest: scopePolicy.authorizationDigest,
            allowed_job_kinds: scopePolicy.allowedKinds,
            expected_job_count: scopePolicy.expectedJobCount,
          },
    scheduled: 0,
    recovered,
    claimed: 0,
    completed: 0,
    failed: 0,
    fenced: 0,
    stopped: false,
  };

  try {
    while (!stopping) {
      if (
        options.scope !== undefined &&
        scopePolicy !== null &&
        !store.heartbeatRunScope(options.scope, scopePolicy.executionToken, {
          now: now(),
          leaseMs,
        })
      ) {
        throw new Error(
          "operator-controlled Run execution lease is stale or fenced",
        );
      }
      const claim = store.claimJob({
        worker: workerId,
        now: now(),
        leaseMs,
        policy: options.policy,
        scope: options.scope,
        executionToken: scopePolicy?.executionToken,
      });
      if (!claim.claimed) {
        if (once) break;
        let resolveWake: () => void = () => {};
        const wake = new Promise<void>((resolve) => {
          resolveWake = resolve;
          wakeIdle = resolve;
        });
        if (stopping) resolveWake();
        if (options.sleep) await Promise.race([sleep(pollMs), wake]);
        else {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, pollMs); }), wake]); }
          finally { clearTimeout(timer); }
        }
        wakeIdle = null;
        continue;
      }
      result.claimed += 1;
      const controller = new AbortController();
      activeController = controller;
      let lostLease = false;
      const heartbeat = setInterval(() => {
        try {
          const heartbeatTime = now();
          const beat = store.heartbeat({
            fencingToken: claim.fencing_token,
            now: heartbeatTime,
            leaseMs,
            policy: options.policy,
          });
          const runScopeOk =
            options.scope === undefined || scopePolicy === null
              ? true
              : store.heartbeatRunScope(
                  options.scope,
                  scopePolicy.executionToken,
                  { now: heartbeatTime, leaseMs },
                );
          if (!beat.ok || !runScopeOk) {
            lostLease = true;
            controller.abort();
          }
        } catch {
          lostLease = true;
          controller.abort();
        }
      }, heartbeatMs);
      const sourceJob = claim.job.kind === "source_sync";
      try {
        if (sourceJob) {
          const dispatch = await dispatchSourceRun(store, claim.job, {
            discovery: options.sourceDiscovery ?? options.discovery,
            signal: controller.signal,
            now,
            beforeCheckpointCommit: options.beforeSourceCheckpointCommit,
          });
          if (controller.signal.aborted || lostLease) {
            result.fenced += 1;
            continue;
          }
          const completionTime = now();
          const completed = store.completeJob({
            fencingToken: claim.fencing_token,
            now: completionTime,
            apply: () => {
              dispatch.commit(completionTime);
            },
          });
          if (completed.ok) result.completed += 1;
          else result.fenced += 1;
          continue;
        }

        const intent = parseIntent(claim.job);
        const documents = await materialize(claim.job, intent, {
          artifactStore,
          signal: controller.signal,
          extract,
        });
        if (controller.signal.aborted || lostLease) {
          result.fenced += 1;
          continue;
        }
        const completionTime = now();
        const completed = store.completeJob({
          fencingToken: claim.fencing_token,
          now: completionTime,
          apply: () => {
            applyDocuments(store, claim.job, intent, documents, completionTime);
          },
        });
        if (completed.ok) {
          result.completed += 1;
        } else {
          result.fenced += 1;
        }
      } catch (error) {
        if (controller.signal.aborted || lostLease) {
          result.fenced += 1;
          continue;
        }
        if (
          (error instanceof AgentscrapeExtractionError ||
            error instanceof AgentscrapeDiscoveryError) &&
          error.disposition === "cancelled"
        ) {
          const guard = store.heartbeat({
            fencingToken: claim.fencing_token,
            now: now(),
            leaseMs,
            policy: options.policy,
          });
          if (!guard.ok) {
            result.fenced += 1;
            continue;
          }
          const cancellationTime = now();
          const cancelled = store.cancelJob({
            jobId: claim.job.id,
            actor: workerId,
            reason: sanitizeExternalError(error),
            ...(error instanceof SourceRunDispatchCancellationError
              ? { apply: () => error.commitEvidence(cancellationTime) }
              : {}),
            now: cancellationTime,
          });
          if (cancelled.ok) result.failed += 1;
          else result.fenced += 1;
          continue;
        }
        const failureClass = sourceJob
          ? error instanceof SourceRunDispatchError
            ? error.failureClass
            : "infra"
          : classifyFailure(error);
        const failureTime = now();
        const failed = store.failAttempt({
          fencingToken: claim.fencing_token,
          failureClass,
          summary: sanitizeExternalError(error),
          ...(error instanceof SourceRunDispatchError
            ? {
                apply: (_db: unknown, disposition: JobState) =>
                  error.commitEvidence(
                    failureTime,
                    disposition === "blocked" || disposition === "failed",
                  ),
              }
            : {}),
          now: failureTime,
          policy: options.policy,
          random: options.random,
        });
        if (failed.ok) {
          result.failed += 1;
          if (
            options.scope !== undefined &&
            (failureClass === "infra" || failureClass === "auth_config")
          ) {
            break;
          }
        } else {
          result.fenced += 1;
        }
      } finally {
        clearInterval(heartbeat);
        activeController = null;
        if (shutdownTimer !== null) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
      }
    }
  } finally {
    if (options.scope !== undefined && scopePolicy !== null) {
      const finishTime = now();
      store.heartbeatRunScope(options.scope, scopePolicy.executionToken, {
        now: finishTime,
        leaseMs,
      });
      store.finishRunScope(options.scope, {
        executionToken: scopePolicy.executionToken,
        now: finishTime,
      });
    }
    options.signal?.removeEventListener("abort", onAbort);
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
  }
  result.stopped = stopping;
  return result;
}
