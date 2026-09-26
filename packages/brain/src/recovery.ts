import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { CliError } from "./errors.js";
import type {
  RecoveryDisposition,
  RecoveryImportCounts,
  Sensitivity,
} from "./types.js";

const GENERATION_FILES = [
  "SHA256SUMS",
  "candidate-manifest.jsonl",
  "generation.json",
  "online-allowlist.json",
  "private-reconciliation.jsonl",
  "public-summary.json",
] as const;
const CHECKSUM_FILES = GENERATION_FILES.filter((name) => name !== "SHA256SUMS");
const GENERATION_ID_PATTERN = /^sha256-[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_ID_PATTERN = /^[a-f0-9]{16}$/;
const OBSERVATION_ID_PATTERN = /^[a-f0-9]{24}$/;
const JSON_FILE_MAX_BYTES = 2_000_000;
const JSONL_FILE_MAX_BYTES = 32_000_000;
const JSONL_LINE_MAX_BYTES = 2_000_000;
const ARTIFACT_MAX_BYTES = 50_000_000;
const MAX_CANDIDATE_ROWS = 2_000;
const MAX_RECONCILIATION_ROWS = 1_000;
const MAX_OBSERVATIONS = 2_000;
const FORBIDDEN_BODY_KEYS = new Set([
  "api_hash",
  "body",
  "bot_token",
  "content",
  "credential",
  "credentials",
  "message_body",
  "password",
  "raw_json",
  "session",
  "session_string",
]);
const FORBIDDEN_PRIVATE_KEYS = new Set([
  ...FORBIDDEN_BODY_KEYS,
  "chat_id",
  "message_id",
  "sender_id",
]);

const LOCKED_RECOVERY_DISPOSITIONS: Readonly<
  Record<RecoveryDisposition, number>
> = {
  approved_online_backfill_telegram_human: 2,
  exclude_infrastructure: 25,
  exclude_probable_test: 12,
  import_offline: 581,
  review: 98,
  review_discord: 356,
  review_fetch: 4,
  review_retry: 5,
  review_telegram_bot_generated: 5,
};

const LOCKED_RECOVERY_COUNTS: RecoveryImportCounts = {
  candidate_rows: 1088,
  baseline_candidate_rows: 1075,
  appended_candidate_rows: 13,
  telegram_candidate_rows: 131,
  telegram_observations: 294,
  telegram_provenance_merges: 118,
  catalog_memberships: 584,
  approved_offline_artifacts: 581,
  approved_online_jobs: 2,
  blocked_review_jobs: 9,
  excluded_candidates: 37,
  evidence_only_candidates: 459,
};

interface FrozenGenerationDescriptor {
  schema_version: number;
  generation_id: string;
  binding: {
    bound_checksum_inventory: Record<string, string>;
    candidate_counts: { baseline: number; final: number };
    controlled_online_backfill_candidate_evidence_row_ids: string[];
    schema_versions: {
      candidate_manifest: number;
      frozen_recovery_generation: number;
      public_summary: number;
    };
    [key: string]: unknown;
  };
}

interface CandidateArtifactInput {
  status: "present" | "missing";
  path: string;
  sha256?: string;
  size_bytes?: number;
}

interface CandidateManifestRow {
  schema_version: number;
  candidate_id: string;
  source_uri: string;
  normalized_uri: string;
  source_type: string;
  resource_sensitivity?: Sensitivity;
  provenance_sensitivity?: Sensitivity;
  provenance: Record<string, unknown>;
  reconciliation: Record<string, unknown>;
  recovery: {
    confidence: string;
    disposition: RecoveryDisposition;
    reasons: string[];
  };
}

export interface RecoveryObservationEvidence {
  observationId: string;
  fields: string[];
  observedIn: string[];
  senderKind: "human" | "bot" | "unknown";
  softDeletedProvenance: boolean;
}

export interface VerifiedRecoveryArtifact {
  sourceDigest: string;
  sourceByteSize: number;
  summary: string;
  body: string;
  bodyDigest: string;
  bodyByteSize: number;
}

export interface VerifiedRecoveryCandidate {
  candidateId: string;
  sourceUri: string;
  comparisonUri: string;
  sourceType: string;
  sensitivity: Sensitivity;
  disposition: RecoveryDisposition;
  confidence: string;
  reasons: string[];
  catalogPosition: number | null;
  provenanceCounts: {
    botctlMessages: number;
    discordMessages: number;
    historicalDocuments: number;
    saveLinkPipelines: number;
  };
  observations: RecoveryObservationEvidence[];
  artifact: VerifiedRecoveryArtifact | null;
}

export interface VerifiedRecoveryGeneration {
  schemaVersion: 1;
  generationId: string;
  generationDigest: string;
  generationRoot: string;
  manifestDigest: string;
  onlineAllowlistDigest: string;
  candidates: VerifiedRecoveryCandidate[];
  onlineAllowlist: string[];
  dispositionCounts: Record<RecoveryDisposition, number>;
  counts: RecoveryImportCounts;
}

export interface ReadRecoveryGenerationOptions {
  artifactRoots?: string[];
}

function recoveryError(code: string, message: string): CliError {
  return new CliError(code, message, { exitCode: 2 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    throw recoveryError(
      "invalid_recovery_generation",
      "frozen recovery generation contains an unsupported field",
    );
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function readRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Buffer {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw recoveryError(
        "unsafe_recovery_path",
        `${label} must be a regular, non-symlink file`,
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw recoveryError(
        "recovery_input_too_large",
        `${label} exceeds its bounded byte limit`,
      );
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw recoveryError(
        "recovery_input_changed",
        `${label} changed while it was being opened`,
      );
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        fd,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.byteLength) {
      throw recoveryError(
        "recovery_input_changed",
        `${label} changed while it was being read`,
      );
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw recoveryError(
        "recovery_input_changed",
        `${label} changed while it was being read`,
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw recoveryError(
      "invalid_recovery_generation",
      `${label} is unavailable`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw recoveryError(
      "invalid_recovery_generation",
      `${label} must contain valid UTF-8`,
    );
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes, label));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw recoveryError(
      "invalid_recovery_generation",
      `${label} contains invalid JSON`,
    );
  }
}

function readJsonLines(
  path: string,
  label: string,
  maxRows: number,
): { rows: unknown[]; digest: string } {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > BigInt(JSONL_FILE_MAX_BYTES)
    ) {
      throw recoveryError(
        "unsafe_recovery_path",
        `${label} must be a bounded regular, non-symlink file`,
      );
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw recoveryError(
        "recovery_input_changed",
        `${label} changed while it was being opened`,
      );
    }
    const rows: unknown[] = [];
    const hash = createHash("sha256");
    const block = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let total = 0;
    const accept = (lineBytes: Buffer): void => {
      if (lineBytes.byteLength > JSONL_LINE_MAX_BYTES) {
        throw recoveryError(
          "recovery_input_too_large",
          `${label} contains an overlong JSONL row`,
        );
      }
      const line = decodeUtf8(lineBytes, label);
      if (!line.trim()) return;
      if (rows.length >= maxRows) {
        throw recoveryError(
          "recovery_input_too_large",
          `${label} exceeds its bounded row limit`,
        );
      }
      try {
        rows.push(JSON.parse(line));
      } catch {
        throw recoveryError(
          "invalid_recovery_generation",
          `${label} contains invalid JSONL`,
        );
      }
    };
    while (true) {
      const count = readSync(fd, block, 0, block.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > JSONL_FILE_MAX_BYTES) {
        throw recoveryError(
          "recovery_input_too_large",
          `${label} exceeds its bounded byte limit`,
        );
      }
      const chunk = block.subarray(0, count);
      hash.update(chunk);
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        accept(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(0x0a);
      }
      if (pending.byteLength > JSONL_LINE_MAX_BYTES) {
        throw recoveryError(
          "recovery_input_too_large",
          `${label} contains an overlong JSONL row`,
        );
      }
    }
    if (pending.byteLength > 0) accept(pending);
    const after = fstatSync(fd, { bigint: true });
    if (
      total !== Number(opened.size) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      throw recoveryError(
        "recovery_input_changed",
        `${label} changed while it was being read`,
      );
    }
    return { rows, digest: hash.digest("hex") };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw recoveryError(
      "invalid_recovery_generation",
      `${label} is unavailable`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parsePointer(path: string): { root: string; descriptor?: unknown } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path);
    if (
      isAbsolute(target) ||
      target.includes("/") ||
      target.includes("\\") ||
      !GENERATION_ID_PATTERN.test(target)
    ) {
      throw recoveryError(
        "unsafe_recovery_path",
        "the recovery generation pointer has an unsafe target",
      );
    }
    const root = realpathSync(path);
    if (!lstatSync(root).isDirectory() || basename(root) !== target) {
      throw recoveryError(
        "invalid_recovery_generation",
        "the recovery generation pointer does not resolve to its generation",
      );
    }
    return { root };
  }
  if (stat.isDirectory()) return { root: realpathSync(path) };
  if (!stat.isFile()) {
    throw recoveryError(
      "unsafe_recovery_path",
      "the recovery generation descriptor must be a regular file or directory",
    );
  }
  const descriptor = parseJson(
    readRegularFile(path, JSON_FILE_MAX_BYTES, "generation descriptor"),
    "generation descriptor",
  );
  if (!isRecord(descriptor)) {
    throw recoveryError(
      "invalid_recovery_generation",
      "the recovery generation descriptor must be an object",
    );
  }
  if (isRecord(descriptor.binding)) {
    const generationId = descriptor.generation_id;
    if (
      typeof generationId === "string" &&
      GENERATION_ID_PATTERN.test(generationId)
    ) {
      const published = join(dirname(path), generationId);
      try {
        if (lstatSync(published).isDirectory()) {
          return { root: realpathSync(published), descriptor };
        }
      } catch {}
    }
    return { root: realpathSync(dirname(path)), descriptor };
  }
  const generationId = descriptor.generation_id;
  if (
    descriptor.schema_version !== 1 ||
    typeof generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(generationId)
  ) {
    throw recoveryError(
      "invalid_recovery_generation",
      "the recovery generation pointer is invalid",
    );
  }
  const requested = resolve(dirname(path), generationId);
  if (dirname(requested) !== resolve(dirname(path))) {
    throw recoveryError(
      "unsafe_recovery_path",
      "the recovery generation pointer escapes its manifest root",
    );
  }
  return { root: realpathSync(requested) };
}

function locateGeneration(path: string): {
  root: string;
  descriptor: FrozenGenerationDescriptor;
} {
  let pointer: ReturnType<typeof parsePointer>;
  try {
    pointer = parsePointer(resolve(path));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw recoveryError(
      "invalid_recovery_generation",
      "the recovery generation descriptor is unavailable",
    );
  }
  const descriptorValue =
    pointer.descriptor ??
    parseJson(
      readRegularFile(
        join(pointer.root, "generation.json"),
        JSON_FILE_MAX_BYTES,
        "generation.json",
      ),
      "generation.json",
    );
  if (!isRecord(descriptorValue) || !isRecord(descriptorValue.binding)) {
    throw recoveryError(
      "invalid_recovery_generation",
      "generation.json has an invalid schema",
    );
  }
  const generationId = descriptorValue.generation_id;
  if (
    descriptorValue.schema_version !== 1 ||
    typeof generationId !== "string" ||
    !GENERATION_ID_PATTERN.test(generationId) ||
    basename(pointer.root) !== generationId
  ) {
    throw recoveryError(
      "mixed_recovery_generation",
      "the generation directory and descriptor identities do not match",
    );
  }
  const names = readdirSync(pointer.root).sort();
  if (
    names.length !== GENERATION_FILES.length ||
    names.some((name, index) => name !== [...GENERATION_FILES].sort()[index])
  ) {
    throw recoveryError(
      "invalid_recovery_generation",
      "the frozen recovery generation file set is incomplete or mixed",
    );
  }
  for (const name of GENERATION_FILES) {
    const path = join(pointer.root, name);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      throw recoveryError(
        "unsafe_recovery_path",
        "frozen recovery generation files must not be symlinks",
      );
    }
  }
  return {
    root: pointer.root,
    descriptor: descriptorValue as unknown as FrozenGenerationDescriptor,
  };
}

function parseChecksums(value: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64}) {2}([A-Za-z0-9.-]+)$/);
    const digest = match?.[1];
    const name = match?.[2];
    if (
      digest === undefined ||
      name === undefined ||
      !CHECKSUM_FILES.includes(name as never)
    ) {
      throw recoveryError(
        "invalid_recovery_generation",
        "SHA256SUMS contains an unsafe or unexpected entry",
      );
    }
    if (entries.has(name)) {
      throw recoveryError(
        "invalid_recovery_generation",
        "SHA256SUMS contains a duplicate entry",
      );
    }
    entries.set(name, digest);
  }
  if (
    entries.size !== CHECKSUM_FILES.length ||
    CHECKSUM_FILES.some((name) => !entries.has(name))
  ) {
    throw recoveryError(
      "invalid_recovery_generation",
      "SHA256SUMS does not cover the complete generation",
    );
  }
  return entries;
}

function validateDescriptor(
  descriptor: FrozenGenerationDescriptor,
  checksums: Map<string, string>,
): void {
  const cutoff = descriptor.binding.cutoff_metadata;
  const hardCaps = isRecord(cutoff) ? cutoff.hard_caps : null;
  const startedAt = isRecord(cutoff) ? cutoff.started_at : null;
  const completedAt = isRecord(cutoff) ? cutoff.completed_at : null;
  if (
    descriptor.binding.schema_versions?.candidate_manifest !== 1 ||
    descriptor.binding.schema_versions?.frozen_recovery_generation !== 1 ||
    descriptor.binding.schema_versions?.public_summary !== 1 ||
    descriptor.binding.candidate_counts?.baseline !==
      LOCKED_RECOVERY_COUNTS.baseline_candidate_rows ||
    descriptor.binding.candidate_counts?.final !==
      LOCKED_RECOVERY_COUNTS.candidate_rows ||
    !isRecord(cutoff) ||
    !isRecord(hardCaps) ||
    hardCaps.messages !== 20_000 ||
    hardCaps.duration_ms !== 600_000 ||
    cutoff.message_count !== 119 ||
    cutoff.termination !== "history_exhausted" ||
    typeof cutoff.upper_cutoff_message_id !== "string" ||
    !/^\d+$/.test(cutoff.upper_cutoff_message_id) ||
    typeof startedAt !== "string" ||
    typeof completedAt !== "string" ||
    !Number.isFinite(Date.parse(startedAt)) ||
    !Number.isFinite(Date.parse(completedAt)) ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(completedAt) - Date.parse(startedAt) > 600_000
  ) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "the frozen generation does not match the locked recovery contract",
    );
  }
  const expectedId = `sha256-${sha256(canonicalJson(descriptor.binding))}`;
  if (descriptor.generation_id !== expectedId) {
    throw recoveryError(
      "mixed_recovery_generation",
      "the frozen generation binding digest does not match its identity",
    );
  }
  const bound = descriptor.binding.bound_checksum_inventory;
  for (const name of [
    "candidate-manifest.jsonl",
    "private-reconciliation.jsonl",
    "public-summary.json",
  ]) {
    if (bound?.[name] !== checksums.get(name)) {
      throw recoveryError(
        "mixed_recovery_generation",
        "the bound checksum inventory does not match SHA256SUMS",
      );
    }
  }
}

function validateUrl(
  value: unknown,
  candidateId: string,
  kind: string,
): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} has an invalid ${kind}`,
    );
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error("invalid URL");
    }
    for (const key of url.searchParams.keys()) {
      if (
        /(?:token|secret|auth|signature|api[_-]?key|access[_-]?key|password|credential)/i.test(
          key,
        )
      ) {
        throw new Error("credential-shaped query");
      }
    }
  } catch {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} has an invalid ${kind}`,
    );
  }
  return value;
}

function stringArray(
  value: unknown,
  candidateId: string,
  label: string,
  maxItems = 100,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (item) => typeof item !== "string" || !item.trim() || item.length > 2_000,
    )
  ) {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} has invalid ${label}`,
    );
  }
  return value as string[];
}

function rejectForbiddenFields(
  value: unknown,
  forbidden: ReadonlySet<string>,
  message: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenFields(item, forbidden, message);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) {
      throw recoveryError("private_recovery_data", message);
    }
    rejectForbiddenFields(item, forbidden, message);
  }
}

function rejectPrivateFields(value: unknown): void {
  rejectForbiddenFields(
    value,
    FORBIDDEN_PRIVATE_KEYS,
    "private Telegram evidence contains a forbidden field",
  );
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function parseCandidate(value: unknown): {
  row: CandidateManifestRow;
  artifactInput: CandidateArtifactInput | null;
  catalogPosition: number | null;
  observationIds: string[];
} {
  if (!isRecord(value)) {
    throw recoveryError(
      "invalid_recovery_candidate",
      "candidate manifest rows must be objects",
    );
  }
  rejectForbiddenFields(
    value,
    FORBIDDEN_BODY_KEYS,
    "candidate evidence contains a forbidden private field",
  );
  ownKeys(value, [
    "candidate_id",
    "normalized_uri",
    "provenance",
    "provenance_sensitivity",
    "reconciliation",
    "recovery",
    "resource_sensitivity",
    "schema_version",
    "source_type",
    "source_uri",
  ]);
  const candidateId = value.candidate_id;
  if (
    value.schema_version !== 1 ||
    typeof candidateId !== "string" ||
    !CANDIDATE_ID_PATTERN.test(candidateId)
  ) {
    throw recoveryError(
      "invalid_recovery_candidate",
      "candidate manifest row identity is invalid",
    );
  }
  const sourceUri = validateUrl(value.source_uri, candidateId, "exact URL");
  if (sha256(sourceUri).slice(0, 16) !== candidateId) {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} does not match its exact URL identity`,
    );
  }
  validateUrl(value.normalized_uri, candidateId, "comparison URI");
  if (
    (value.source_type !== "url" && value.source_type !== "x") ||
    !isRecord(value.provenance) ||
    !isRecord(value.reconciliation) ||
    !isRecord(value.recovery)
  ) {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} has an invalid schema`,
    );
  }
  const recovery = value.recovery;
  ownKeys(recovery, ["confidence", "disposition", "reasons"]);
  const disposition = recovery.disposition;
  if (
    typeof recovery.confidence !== "string" ||
    !recovery.confidence.trim() ||
    !((disposition as string) in LOCKED_RECOVERY_DISPOSITIONS)
  ) {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} has an invalid disposition`,
    );
  }
  stringArray(recovery.reasons, candidateId, "reasons");
  const sensitivity = value.resource_sensitivity ?? "normal";
  if (
    !new Set(["public", "normal", "sensitive", "private"]).has(
      sensitivity as string,
    )
  ) {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} has invalid sensitivity`,
    );
  }
  const positions = value.provenance.catalog_positions;
  if (
    positions !== undefined &&
    (!Array.isArray(positions) ||
      positions.length > 1 ||
      positions.some(
        (position) => !Number.isInteger(position) || Number(position) < 1,
      ))
  ) {
    throw recoveryError(
      "invalid_recovery_candidate",
      `candidate ${candidateId} has invalid catalog evidence`,
    );
  }
  const catalogPosition =
    Array.isArray(positions) && positions.length === 1
      ? Number(positions[0])
      : null;
  const artifactValue = value.reconciliation.artifact;
  let artifactInput: CandidateArtifactInput | null = null;
  if (artifactValue !== undefined) {
    if (!isRecord(artifactValue)) {
      throw recoveryError(
        "invalid_recovery_candidate",
        `candidate ${candidateId} has invalid Artifact evidence`,
      );
    }
    ownKeys(artifactValue, ["path", "sha256", "size_bytes", "status"]);
    if (
      (artifactValue.status !== "present" &&
        artifactValue.status !== "missing") ||
      typeof artifactValue.path !== "string" ||
      !isAbsolute(artifactValue.path)
    ) {
      throw recoveryError(
        "invalid_recovery_candidate",
        `candidate ${candidateId} has invalid Artifact evidence`,
      );
    }
    if (
      artifactValue.status === "present" &&
      (typeof artifactValue.sha256 !== "string" ||
        !DIGEST_PATTERN.test(artifactValue.sha256) ||
        !Number.isSafeInteger(artifactValue.size_bytes) ||
        Number(artifactValue.size_bytes) < 1 ||
        Number(artifactValue.size_bytes) > ARTIFACT_MAX_BYTES)
    ) {
      throw recoveryError(
        "invalid_recovery_candidate",
        `candidate ${candidateId} has incomplete Artifact evidence`,
      );
    }
    if (
      artifactValue.status === "missing" &&
      (artifactValue.sha256 !== undefined ||
        artifactValue.size_bytes !== undefined)
    ) {
      throw recoveryError(
        "invalid_recovery_candidate",
        `candidate ${candidateId} has contradictory Artifact evidence`,
      );
    }
    artifactInput = artifactValue as unknown as CandidateArtifactInput;
  }
  const secretary = value.provenance.agentbot_secretary;
  let observationIds: string[] = [];
  if (secretary !== undefined) {
    if (!isRecord(secretary)) {
      throw recoveryError(
        "invalid_recovery_candidate",
        `candidate ${candidateId} has invalid Secretary evidence`,
      );
    }
    ownKeys(secretary, [
      "observation_count",
      "observation_ids",
      "private_reconciliation",
    ]);
    observationIds = stringArray(
      secretary.observation_ids,
      candidateId,
      "Secretary observation IDs",
      MAX_OBSERVATIONS,
    );
    if (
      secretary.private_reconciliation !== "private-reconciliation.jsonl" ||
      secretary.observation_count !== observationIds.length ||
      new Set(observationIds).size !== observationIds.length ||
      observationIds.some((id) => !OBSERVATION_ID_PATTERN.test(id))
    ) {
      throw recoveryError(
        "invalid_recovery_candidate",
        `candidate ${candidateId} has invalid Secretary evidence`,
      );
    }
  }
  return {
    row: value as unknown as CandidateManifestRow,
    artifactInput,
    catalogPosition,
    observationIds,
  };
}

function safeArtifactRoots(roots: string[] | undefined): string[] {
  const requested = roots?.length
    ? roots
    : [join(homedir(), "content", "links")];
  return requested.flatMap((root) => {
    try {
      const absolute = resolve(root);
      const real = realpathSync(absolute);
      if (!lstatSync(real).isDirectory()) throw new Error("not a directory");
      return absolute === real ? [real] : [absolute, real];
    } catch {
      throw recoveryError(
        "unsafe_recovery_path",
        "a declared legacy Artifact root is unavailable",
      );
    }
  });
}

function pathWithinRoot(path: string, roots: string[]): boolean {
  const absolute = resolve(path);
  return roots.some((root) => {
    const rel = relative(root, absolute);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

function readArtifact(
  input: CandidateArtifactInput,
  candidateId: string,
  sourceUri: string,
  roots: string[],
): VerifiedRecoveryArtifact | null {
  if (!pathWithinRoot(input.path, roots)) {
    throw recoveryError(
      "unsafe_recovery_path",
      `candidate ${candidateId} has an Artifact outside declared roots`,
    );
  }
  if (input.status === "missing") return null;
  let real: string;
  try {
    real = realpathSync(input.path);
  } catch {
    throw recoveryError(
      "recovery_artifact_missing",
      `candidate ${candidateId} is missing its approved Artifact`,
    );
  }
  if (!pathWithinRoot(real, roots)) {
    throw recoveryError(
      "unsafe_recovery_path",
      `candidate ${candidateId} has an Artifact that escapes declared roots`,
    );
  }
  const bytes = readRegularFile(
    input.path,
    ARTIFACT_MAX_BYTES,
    `candidate ${candidateId} Artifact`,
  );
  if (bytes.byteLength !== input.size_bytes || sha256(bytes) !== input.sha256) {
    throw recoveryError(
      "recovery_artifact_mismatch",
      `candidate ${candidateId} Artifact does not match frozen evidence`,
    );
  }
  const parsed = parseLinkctlMarkdown(bytes, candidateId);
  if (parsed.url !== sourceUri) {
    throw recoveryError(
      "recovery_artifact_mismatch",
      `candidate ${candidateId} Artifact URL does not match exact identity`,
    );
  }
  return {
    sourceDigest: input.sha256 as string,
    sourceByteSize: input.size_bytes as number,
    summary: parsed.summary,
    body: parsed.body,
    bodyDigest: sha256(parsed.body),
    bodyByteSize: Buffer.byteLength(parsed.body, "utf8"),
  };
}

function parseScalar(value: string, candidateId: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {}
    throw recoveryError(
      "malformed_recovery_frontmatter",
      `candidate ${candidateId} has malformed Linkctl frontmatter`,
    );
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw recoveryError(
        "malformed_recovery_frontmatter",
        `candidate ${candidateId} has malformed Linkctl frontmatter`,
      );
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (/^(?:[|>]|[&*!{}[\]])/.test(trimmed)) {
    throw recoveryError(
      "malformed_recovery_frontmatter",
      `candidate ${candidateId} uses unsupported Linkctl frontmatter syntax`,
    );
  }
  return trimmed;
}

function parseLinkctlMarkdown(
  bytes: Uint8Array,
  candidateId = "unknown",
): { url: string; summary: string; body: string } {
  const text = decodeUtf8(bytes, `candidate ${candidateId} Artifact`);
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw recoveryError(
      "malformed_recovery_frontmatter",
      `candidate ${candidateId} Artifact is missing Linkctl frontmatter`,
    );
  }
  const end = lines.indexOf("---", 1);
  if (end < 2) {
    throw recoveryError(
      "malformed_recovery_frontmatter",
      `candidate ${candidateId} Artifact has unterminated Linkctl frontmatter`,
    );
  }
  const fields = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))$/);
    if (field !== null) {
      const key = field[1];
      if ((key !== "url" && key !== "summary") || fields.has(key)) {
        throw recoveryError(
          "malformed_recovery_frontmatter",
          `candidate ${candidateId} Artifact has invalid Linkctl frontmatter fields`,
        );
      }
      fields.set(key, [field[2] ?? ""]);
      current = key;
      continue;
    }
    if (current === null || !/^\s+\S/.test(line)) {
      throw recoveryError(
        "malformed_recovery_frontmatter",
        `candidate ${candidateId} Artifact has malformed Linkctl frontmatter`,
      );
    }
    fields.get(current)?.push(line.trim());
  }
  if (fields.size !== 2 || !fields.has("url") || !fields.has("summary")) {
    throw recoveryError(
      "malformed_recovery_frontmatter",
      `candidate ${candidateId} Artifact lacks required Linkctl fields`,
    );
  }
  const url = parseScalar((fields.get("url") ?? []).join(" "), candidateId);
  const summary = parseScalar(
    (fields.get("summary") ?? []).join(" "),
    candidateId,
  );
  if (!url || !summary || summary.length > 10_000) {
    throw recoveryError(
      "malformed_recovery_frontmatter",
      `candidate ${candidateId} Artifact has empty or oversized Linkctl fields`,
    );
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n/, "");
  if (!body.trim() || Buffer.byteLength(body, "utf8") > ARTIFACT_MAX_BYTES) {
    throw recoveryError(
      "malformed_recovery_frontmatter",
      `candidate ${candidateId} Artifact has no bounded searchable body`,
    );
  }
  return { url, summary, body };
}

function validatePublicSummary(value: unknown): void {
  if (!isRecord(value)) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "public recovery summary has an invalid schema",
    );
  }
  const outcomes = value.candidate_outcomes;
  const reconciliation = value.reconciliation;
  const additions = value.secretary_additions;
  const online = value.controlled_online_backfill;
  const privacy = value.privacy;
  const live = value.live_capture;
  if (
    value.schema_version !== 1 ||
    !isRecord(outcomes) ||
    outcomes.final_candidates !== LOCKED_RECOVERY_COUNTS.candidate_rows ||
    outcomes.baseline_candidate_ids_preserved !==
      LOCKED_RECOVERY_COUNTS.baseline_candidate_rows ||
    outcomes.appended_exact_candidates !==
      LOCKED_RECOVERY_COUNTS.appended_candidate_rows ||
    outcomes.comparison_new_urls !== 8 ||
    !isRecord(reconciliation) ||
    reconciliation.exact_urls !==
      LOCKED_RECOVERY_COUNTS.telegram_candidate_rows ||
    reconciliation.message_level_url_observations !==
      LOCKED_RECOVERY_COUNTS.telegram_observations ||
    reconciliation.provenance_merges !==
      LOCKED_RECOVERY_COUNTS.telegram_provenance_merges ||
    reconciliation.live_only_urls !== 1 ||
    !isRecord(additions) ||
    additions.approved_controlled_online_human_submissions !== 2 ||
    additions.bot_output_review_candidates !== 5 ||
    additions.probable_test_exclusions !== 6 ||
    !isRecord(online) ||
    online.approved_human_candidate_evidence_rows !== 2 ||
    online.network_fetches_performed !== 0 ||
    !isRecord(privacy) ||
    privacy.exact_urls_in_summary !== 0 ||
    privacy.private_locators_in_summary !== 0 ||
    privacy.transport_privacy_alone_marks_resource_sensitive !== false ||
    !isRecord(live) ||
    live.fixed_upper_cutoff !== true ||
    live.history_exhausted !== true ||
    live.hard_cap_duration_ms !== 600_000 ||
    live.hard_cap_messages !== 20_000 ||
    live.visible_messages !== 119 ||
    live.credential_session_copies_retained !== 0
  ) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "public recovery summary does not match the locked cohort counts",
    );
  }
}

function parsePrivateReconciliation(
  rows: unknown[],
  candidates: Map<
    string,
    ReturnType<typeof parseCandidate> & { sourceUri: string }
  >,
): Map<string, RecoveryObservationEvidence[]> {
  const result = new Map<string, RecoveryObservationEvidence[]>();
  const globalObservationIds = new Set<string>();
  let observationCount = 0;
  let merges = 0;
  let appends = 0;
  for (const value of rows) {
    rejectPrivateFields(value);
    if (!isRecord(value)) {
      throw recoveryError(
        "invalid_recovery_reconciliation",
        "private reconciliation rows must be objects",
      );
    }
    ownKeys(value, [
      "candidate_disposition",
      "candidate_evidence_row_id",
      "comparison_candidate_evidence_row_ids",
      "comparison_uri",
      "exact_uri",
      "observations",
      "reconciliation_action",
      "resource_sensitivity",
      "schema_version",
    ]);
    const candidateId = value.candidate_evidence_row_id;
    if (
      value.schema_version !== 1 ||
      typeof candidateId !== "string" ||
      !CANDIDATE_ID_PATTERN.test(candidateId) ||
      result.has(candidateId)
    ) {
      throw recoveryError(
        "invalid_recovery_reconciliation",
        "private reconciliation candidate identity is invalid or duplicated",
      );
    }
    const candidate = candidates.get(candidateId);
    if (
      candidate === undefined ||
      value.exact_uri !== candidate.sourceUri ||
      value.comparison_uri !== candidate.row.normalized_uri ||
      value.candidate_disposition !== candidate.row.recovery.disposition ||
      value.resource_sensitivity !==
        (candidate.row.resource_sensitivity ?? "normal")
    ) {
      throw recoveryError(
        "mixed_recovery_generation",
        `candidate ${candidateId} reconciliation does not match its manifest row`,
      );
    }
    const comparisonIds = stringArray(
      value.comparison_candidate_evidence_row_ids,
      candidateId,
      "comparison candidate IDs",
    );
    if (
      new Set(comparisonIds).size !== comparisonIds.length ||
      comparisonIds.some((id) => !candidates.has(id))
    ) {
      throw recoveryError(
        "invalid_recovery_reconciliation",
        `candidate ${candidateId} has invalid comparison-only evidence`,
      );
    }
    const action = value.reconciliation_action;
    if (action === "merge_existing_provenance") merges += 1;
    else if (action === "append_exact_candidate") appends += 1;
    else {
      throw recoveryError(
        "invalid_recovery_reconciliation",
        `candidate ${candidateId} has an invalid reconciliation action`,
      );
    }
    if (!Array.isArray(value.observations) || value.observations.length === 0) {
      throw recoveryError(
        "invalid_recovery_reconciliation",
        `candidate ${candidateId} has invalid observation evidence`,
      );
    }
    const observations = value.observations.map((item) => {
      if (!isRecord(item)) {
        throw recoveryError(
          "invalid_recovery_reconciliation",
          `candidate ${candidateId} has invalid observation evidence`,
        );
      }
      ownKeys(item, [
        "fields",
        "observation_id",
        "observed_in",
        "sender_kind",
        "soft_deleted_provenance",
      ]);
      const observationId = item.observation_id;
      const fields = stringArray(
        item.fields,
        candidateId,
        "observation fields",
      );
      const observedIn = stringArray(
        item.observed_in,
        candidateId,
        "observation origins",
      );
      if (
        typeof observationId !== "string" ||
        !OBSERVATION_ID_PATTERN.test(observationId) ||
        globalObservationIds.has(observationId) ||
        !["human", "bot", "unknown"].includes(String(item.sender_kind)) ||
        typeof item.soft_deleted_provenance !== "boolean" ||
        observedIn.some(
          (origin) => origin !== "agentbot_db" && origin !== "telegram_live",
        )
      ) {
        throw recoveryError(
          "invalid_recovery_reconciliation",
          `candidate ${candidateId} has invalid body-free observation evidence`,
        );
      }
      globalObservationIds.add(observationId);
      observationCount += 1;
      return {
        observationId,
        fields: [...new Set(fields)].sort(),
        observedIn: [...new Set(observedIn)].sort(),
        senderKind:
          item.sender_kind as RecoveryObservationEvidence["senderKind"],
        softDeletedProvenance: item.soft_deleted_provenance,
      };
    });
    if (
      observations
        .map((item) => item.observationId)
        .sort()
        .join("\0") !== [...candidate.observationIds].sort().join("\0")
    ) {
      throw recoveryError(
        "mixed_recovery_generation",
        `candidate ${candidateId} observation inventory is mixed`,
      );
    }
    result.set(candidateId, observations);
  }
  if (
    result.size !== LOCKED_RECOVERY_COUNTS.telegram_candidate_rows ||
    observationCount !== LOCKED_RECOVERY_COUNTS.telegram_observations ||
    merges !== LOCKED_RECOVERY_COUNTS.telegram_provenance_merges ||
    appends !== LOCKED_RECOVERY_COUNTS.appended_candidate_rows
  ) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "private reconciliation does not match the locked observation counts",
    );
  }
  return result;
}

function validatedAllowlist(
  value: unknown,
  descriptor: FrozenGenerationDescriptor,
  candidates: Map<string, ReturnType<typeof parseCandidate>>,
  observations: Map<string, RecoveryObservationEvidence[]>,
): string[] {
  if (!isRecord(value)) {
    throw recoveryError(
      "invalid_recovery_generation",
      "controlled online allowlist has an invalid schema",
    );
  }
  ownKeys(value, [
    "candidate_evidence_row_ids",
    "entry_count",
    "generation_digest",
    "generation_id",
    "schema_version",
  ]);
  const ids = value.candidate_evidence_row_ids;
  if (
    value.schema_version !== 1 ||
    value.generation_id !== descriptor.generation_id ||
    value.generation_digest !== descriptor.generation_id.slice(7) ||
    value.entry_count !== LOCKED_RECOVERY_COUNTS.approved_online_jobs ||
    !Array.isArray(ids) ||
    ids.length !== LOCKED_RECOVERY_COUNTS.approved_online_jobs ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        typeof id !== "string" ||
        candidates.get(id)?.row.recovery.disposition !==
          "approved_online_backfill_telegram_human" ||
        !observations.has(id) ||
        observations.get(id)?.length === 0 ||
        observations
          .get(id)
          ?.some((observation) => observation.senderKind !== "human"),
    )
  ) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "controlled online allowlist is not bound to the approved cohort",
    );
  }
  const bound =
    descriptor.binding.controlled_online_backfill_candidate_evidence_row_ids;
  if (
    !Array.isArray(bound) ||
    [...ids].sort().join("\0") !== [...bound].sort().join("\0")
  ) {
    throw recoveryError(
      "mixed_recovery_generation",
      "controlled online allowlist differs from the generation binding",
    );
  }
  return [...(ids as string[])].sort();
}

export function readRecoveryGeneration(
  descriptorPath: string,
  options: ReadRecoveryGenerationOptions = {},
): VerifiedRecoveryGeneration {
  const { root, descriptor } = locateGeneration(descriptorPath);
  const fileBytes = new Map<string, Buffer>();
  for (const name of CHECKSUM_FILES) {
    if (
      name === "candidate-manifest.jsonl" ||
      name === "private-reconciliation.jsonl"
    ) {
      continue;
    }
    fileBytes.set(
      name,
      readRegularFile(join(root, name), JSON_FILE_MAX_BYTES, name),
    );
  }
  const checksums = parseChecksums(
    decodeUtf8(
      readRegularFile(
        join(root, "SHA256SUMS"),
        JSON_FILE_MAX_BYTES,
        "SHA256SUMS",
      ),
      "SHA256SUMS",
    ),
  );
  const candidateInput = readJsonLines(
    join(root, "candidate-manifest.jsonl"),
    "candidate-manifest.jsonl",
    MAX_CANDIDATE_ROWS,
  );
  const privateInput = readJsonLines(
    join(root, "private-reconciliation.jsonl"),
    "private-reconciliation.jsonl",
    MAX_RECONCILIATION_ROWS,
  );
  const actualDigests = new Map<string, string>([
    ["candidate-manifest.jsonl", candidateInput.digest],
    ["private-reconciliation.jsonl", privateInput.digest],
  ]);
  for (const [name, bytes] of fileBytes) actualDigests.set(name, sha256(bytes));
  for (const name of CHECKSUM_FILES) {
    if (actualDigests.get(name) !== checksums.get(name)) {
      throw recoveryError(
        "mixed_recovery_generation",
        `${name} does not match the frozen checksum inventory`,
      );
    }
  }
  const descriptorBytes = fileBytes.get("generation.json");
  if (
    descriptorBytes === undefined ||
    canonicalJson(parseJson(descriptorBytes, "generation.json")) !==
      canonicalJson(descriptor)
  ) {
    throw recoveryError(
      "mixed_recovery_generation",
      "the selected descriptor differs from generation.json",
    );
  }
  validateDescriptor(descriptor, checksums);
  validatePublicSummary(
    parseJson(
      fileBytes.get("public-summary.json") as Buffer,
      "public-summary.json",
    ),
  );

  if (candidateInput.rows.length !== LOCKED_RECOVERY_COUNTS.candidate_rows) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "candidate manifest does not contain exactly 1,088 rows",
    );
  }
  const parsedCandidates = new Map<
    string,
    ReturnType<typeof parseCandidate> & { sourceUri: string }
  >();
  const exactUris = new Set<string>();
  const dispositionCounts = Object.fromEntries(
    Object.keys(LOCKED_RECOVERY_DISPOSITIONS).map((key) => [key, 0]),
  ) as Record<RecoveryDisposition, number>;
  const positions = new Set<number>();
  for (const raw of candidateInput.rows) {
    const parsed = parseCandidate(raw);
    if (
      parsedCandidates.has(parsed.row.candidate_id) ||
      exactUris.has(parsed.row.source_uri)
    ) {
      throw recoveryError(
        "invalid_recovery_candidate",
        "candidate manifest contains duplicate exact outcomes",
      );
    }
    parsedCandidates.set(parsed.row.candidate_id, {
      ...parsed,
      sourceUri: parsed.row.source_uri,
    });
    exactUris.add(parsed.row.source_uri);
    dispositionCounts[parsed.row.recovery.disposition] += 1;
    if (parsed.catalogPosition !== null) {
      if (positions.has(parsed.catalogPosition)) {
        throw recoveryError(
          "invalid_recovery_candidate",
          "candidate manifest contains a duplicate catalog position",
        );
      }
      positions.add(parsed.catalogPosition);
    }
  }
  for (const [disposition, expected] of Object.entries(
    LOCKED_RECOVERY_DISPOSITIONS,
  )) {
    if (dispositionCounts[disposition as RecoveryDisposition] !== expected) {
      throw recoveryError(
        "recovery_contract_mismatch",
        "candidate dispositions do not match the locked recovery cohorts",
      );
    }
  }
  if (
    positions.size !== LOCKED_RECOVERY_COUNTS.catalog_memberships ||
    Math.min(...positions) !== 1 ||
    Math.max(...positions) !== LOCKED_RECOVERY_COUNTS.catalog_memberships
  ) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "legacy catalog positions are incomplete or non-contiguous",
    );
  }
  const observations = parsePrivateReconciliation(
    privateInput.rows,
    parsedCandidates,
  );
  const allowlist = validatedAllowlist(
    parseJson(
      fileBytes.get("online-allowlist.json") as Buffer,
      "online-allowlist.json",
    ),
    descriptor,
    parsedCandidates,
    observations,
  );
  const roots = safeArtifactRoots(options.artifactRoots);
  const candidates: VerifiedRecoveryCandidate[] = [];
  let approvedArtifacts = 0;
  for (const parsed of parsedCandidates.values()) {
    const artifact =
      parsed.artifactInput === null
        ? null
        : readArtifact(
            parsed.artifactInput,
            parsed.row.candidate_id,
            parsed.row.source_uri,
            roots,
          );
    if (parsed.row.recovery.disposition === "import_offline") {
      if (artifact === null) {
        throw recoveryError(
          "recovery_artifact_missing",
          `candidate ${parsed.row.candidate_id} lacks its approved offline Artifact`,
        );
      }
      approvedArtifacts += 1;
    }
    const provenance = parsed.row.provenance;
    candidates.push({
      candidateId: parsed.row.candidate_id,
      sourceUri: parsed.row.source_uri,
      comparisonUri: parsed.row.normalized_uri,
      sourceType: parsed.row.source_type,
      sensitivity: parsed.row.resource_sensitivity ?? "normal",
      disposition: parsed.row.recovery.disposition,
      confidence: parsed.row.recovery.confidence,
      reasons: [...parsed.row.recovery.reasons],
      catalogPosition: parsed.catalogPosition,
      provenanceCounts: {
        botctlMessages: countArray(provenance.botctl_messages),
        discordMessages: countArray(provenance.discord_cache_messages),
        historicalDocuments: countArray(provenance.historical_document_ids),
        saveLinkPipelines: countArray(provenance.save_link_pipelines),
      },
      observations: observations.get(parsed.row.candidate_id) ?? [],
      artifact,
    });
  }
  if (approvedArtifacts !== LOCKED_RECOVERY_COUNTS.approved_offline_artifacts) {
    throw recoveryError(
      "recovery_contract_mismatch",
      "approved offline Artifact count does not match the locked cohort",
    );
  }
  candidates.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
  return {
    schemaVersion: 1,
    generationId: descriptor.generation_id,
    generationDigest: descriptor.generation_id.slice(7),
    generationRoot: root,
    manifestDigest: checksums.get("candidate-manifest.jsonl") as string,
    onlineAllowlistDigest: checksums.get("online-allowlist.json") as string,
    candidates,
    onlineAllowlist: allowlist,
    dispositionCounts,
    counts: { ...LOCKED_RECOVERY_COUNTS },
  };
}
