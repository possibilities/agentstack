import type { Database } from "./sqlite.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { CliError } from "./errors.js";
import { sanitizeExternalError } from "./sanitize.js";
import {
  LIMITS_KEYS,
  MANIFEST_KEYS,
  MAX_SOURCES,
  manifestEnvelopeSchema,
  SCHEDULE_KEYS,
  SOURCE_DEFINITION_KEYS,
  sourceDefinitionValuesSchema,
} from "./source-manifest-schema.js";
import type {
  KnownSourceKind,
  Source,
  SourceAuditEvent,
  SourceCheckpoint,
  SourceDefinition,
  SourceDetail,
  SourceHealthState,
  SourceLimits,
  SourceListItem,
  SourceManifest,
  SourceManifestOverlay,
  SourceRunCounts,
  SourceRunOutcome,
  SourceRunStatus,
  SourceSchedule,
  SourceStatus,
  SourceSyncAdmission,
} from "./source-types.js";
import {
  SOURCE_MANIFEST_VERSION,
  SOURCE_RUN_INTENT_VERSION,
} from "./source-types.js";
import type { JobState, Run, RunState, Sensitivity } from "./types.js";
import { validateHttpUrl } from "./url.js";

const X_HANDLE_PATTERN = /^@?[A-Za-z0-9_]{1,20}$/;
const CREDENTIAL_KEY_PATTERN =
  /(?:^|[_-])(access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session|signature|token)(?:$|[_-])/i;
const CREDENTIAL_QUERY_PATTERN =
  /^(?:access[_-]?key|api[_-]?key|auth|authorization|cookie|password|secret|session|signature|token)$/i;
const SOURCE_SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  normal: 1,
  sensitive: 2,
  private: 3,
};
const KNOWN_SOURCE_KIND_SET = new Set<KnownSourceKind>([
  "blog_feed",
  "blog_source",
  "x_account",
]);
const MAX_DEFINITION_BYTES = 128 * 1024;

/**
 * Bundled example source manifest shipped with the repo. Never applied
 * implicitly; an operator or `sources apply` reads and applies it.
 */
export const DEFAULT_SOURCE_MANIFEST_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "config",
  "sources.example.json",
);
const SOURCE_COLUMNS = `id, source_type, identifier, display_name, enabled,
  sensitivity, schedule, checkpoint, definition_version, definition,
  definition_hash, collections, limits, credential_refs, paused, pause_reason,
  health_state, health_detail, last_evaluated_at, last_success_at, next_due_at,
  created_at, updated_at`;
const SOURCE_RUN_COLUMNS = `id, run_type, source_id, state, checkpoint,
  attempted_cursor, committed_checkpoint, warnings, discovered_count,
  admitted_count, suppressed_count, terminal_outcome, source_definition_version,
  schedule_key, scheduled_for, started_at, finished_at, created_at, updated_at`;

interface SourceRow extends Source {
  definition: string;
}

interface RunRow {
  id: number;
  state: RunState;
  terminal_outcome: SourceRunOutcome | null;
  warnings: string;
  discovered_count: number;
  admitted_count: number;
  suppressed_count: number;
  created_at: string;
  finished_at: string | null;
}

function sourceError(code: string, message: string): CliError {
  return new CliError(code, message, { exitCode: 2 });
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw sourceError("bad_source_manifest", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength = 500): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw sourceError(
      "bad_source_manifest",
      `${name} must be a non-empty string`,
    );
  }
  const normalized = value.trim();
  if (Array.from(normalized).length > maxLength) {
    throw sourceError("bad_source_manifest", `${name} is too long`);
  }
  return normalized;
}

function positiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw sourceError(
      "bad_source_manifest",
      `${name} must be an integer between 1 and ${maximum}`,
    );
  }
  return value as number;
}

function cadenceSeconds(value: unknown): number {
  if (typeof value === "number") {
    return positiveInteger(value, "schedule cadence", 31 * 24 * 60 * 60);
  }
  if (typeof value !== "string") {
    throw sourceError(
      "bad_source_manifest",
      "schedule cadence must be hourly, daily, an ISO duration, or a bounded duration",
    );
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "hourly") return 60 * 60;
  if (normalized === "daily") return 24 * 60 * 60;
  const compact = normalized.match(/^(\d+)(s|m|h|d)$/);
  if (compact !== null) {
    const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400 }[
      compact[2] as "s" | "m" | "h" | "d"
    ];
    return positiveInteger(
      Number(compact[1]) * multiplier,
      "schedule cadence",
      31 * 24 * 60 * 60,
    );
  }
  const iso = normalized.match(/^pt(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (iso !== null) {
    const seconds =
      Number(iso[1] ?? 0) * 3_600 +
      Number(iso[2] ?? 0) * 60 +
      Number(iso[3] ?? 0);
    return positiveInteger(seconds, "schedule cadence", 31 * 24 * 60 * 60);
  }
  throw sourceError(
    "bad_source_manifest",
    `unsupported schedule cadence '${value}'`,
  );
}

function parseSchedule(value: unknown): SourceSchedule {
  const schedule = record(value, "source schedule");
  const cadence =
    schedule.cadence_seconds ??
    (typeof schedule.cadence_minutes === "number"
      ? schedule.cadence_minutes * 60
      : undefined) ??
    schedule.cadence ??
    schedule.every;
  return { cadence_seconds: cadenceSeconds(cadence) };
}

function parseLimits(value: unknown): SourceLimits {
  const limits = record(value, "source limits");
  return {
    max_items_per_run: positiveInteger(
      limits.max_items_per_run ?? limits.max_items,
      "limits.max_items_per_run",
      10_000,
    ),
    max_pages_per_run: positiveInteger(
      limits.max_pages_per_run ?? limits.max_pages,
      "limits.max_pages_per_run",
      100,
    ),
  };
}

function credentialFree(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      credentialFree(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      const url = validateHttpUrl(value);
      for (const name of url.searchParams.keys()) {
        if (
          CREDENTIAL_QUERY_PATTERN.test(name) ||
          CREDENTIAL_KEY_PATTERN.test(name)
        ) {
          throw sourceError(
            "source_contains_credential",
            `${path} contains a credential-shaped URL query value; use credential_refs`,
          );
        }
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw sourceError(
        "source_contains_credential",
        `${path}.${key} must be represented by credential_refs, not stored inline`,
      );
    }
    credentialFree(child, `${path}.${key}`);
  }
}

type ManifestIssue = z.core.$ZodIssue;

function issueAt(
  issues: readonly ManifestIssue[],
  key: string,
): ManifestIssue | undefined {
  return issues.find((issue) => issue.path[0] === key);
}

function unknownKeyNamesError(
  scope: string,
  keys: readonly string[],
  known: readonly string[],
): CliError {
  const named = keys.map((key) => `'${key}'`).join(", ");
  return sourceError(
    "bad_source_manifest",
    `${scope} has unknown key${keys.length === 1 ? "" : "s"} ${named}; known keys: ${known.join(", ")}`,
  );
}

function unknownKeysError(
  scope: string,
  issue: ManifestIssue,
  known: readonly string[],
): CliError {
  return unknownKeyNamesError(
    scope,
    issue.code === "unrecognized_keys" ? issue.keys : [],
    known,
  );
}

/**
 * The dup refinement collapses to its own issue; item faults arrive as a
 * union against the tolerated-null branch and are unwrapped here.
 */
function credentialRefEntryFault(
  issue: ManifestIssue,
  index: unknown,
): CliError {
  if (issue.code === "too_big") {
    return sourceError(
      "bad_source_manifest",
      `credential_refs[${String(index)}] is too long`,
    );
  }
  if (issue.code === "invalid_format") {
    return sourceError(
      "bad_source_manifest",
      "credential_refs entries must be opaque reference names, never credential values",
    );
  }
  return sourceError(
    "bad_source_manifest",
    `credential_refs[${String(index)}] must be a non-empty string`,
  );
}

function credentialRefsFault(issue: ManifestIssue): CliError {
  // When the array branch type-matches, zod collapses the array-or-null
  // union and reports entry faults directly at credential_refs[i].
  if (issue.path.length === 2) {
    return credentialRefEntryFault(issue, issue.path[1]);
  }
  if (issue.code === "custom") {
    return sourceError("bad_source_manifest", issue.message);
  }
  if (issue.code === "invalid_union") {
    for (const branch of issue.errors) {
      const item = branch.find((candidate) => candidate.path.length > 0);
      if (item === undefined) continue;
      return credentialRefEntryFault(item, item.path[item.path.length - 1]);
    }
  }
  return sourceError("bad_source_manifest", "credential_refs must be an array");
}

/** Renders one schema issue as the loader's own error prose. */
function definitionFault(issue: ManifestIssue, idLabel: string): CliError {
  const bad = (message: string) => sourceError("bad_source_manifest", message);
  switch (issue.path[0]) {
    case "id":
      if (issue.code === "too_big") return bad("source id is too long");
      if (issue.code === "invalid_format") {
        return bad(
          "source id must use 1-100 lowercase letters, numbers, dots, underscores, or hyphens",
        );
      }
      return bad("source id must be a non-empty string");
    case "version":
      return bad(
        `source ${idLabel} version must be an integer between 1 and 1000000`,
      );
    case "kind":
      if (issue.code === "too_big")
        return bad(`source ${idLabel} kind is too long`);
      if (issue.code === "invalid_format") {
        return bad(`source ${idLabel} kind is invalid`);
      }
      return bad(`source ${idLabel} kind must be a non-empty string`);
    case "enabled":
      return bad(`source ${idLabel} enabled must be boolean`);
    case "sensitivity":
      if (issue.code === "invalid_type") {
        return bad(`source ${idLabel} sensitivity must be a non-empty string`);
      }
      return bad(
        `source ${idLabel} sensitivity must be public, normal, sensitive, or private`,
      );
    case "payload":
      return bad(`source ${idLabel} payload must be an object`);
    case "display_name":
      if (issue.code === "too_big") {
        return bad(`source ${idLabel} display_name is too long`);
      }
      return bad(`source ${idLabel} display_name must be a non-empty string`);
    case "schedule":
      if (issue.code === "unrecognized_keys") {
        return unknownKeysError(
          `source ${idLabel} schedule`,
          issue,
          SCHEDULE_KEYS,
        );
      }
      return bad("source schedule must be an object");
    case "limits":
      if (issue.code === "unrecognized_keys") {
        return unknownKeysError(`source ${idLabel} limits`, issue, LIMITS_KEYS);
      }
      return bad("source limits must be an object");
    case "collections": {
      if (issue.path.length === 2) {
        const slot = `collections[${String(issue.path[1])}]`;
        if (issue.code === "too_big") return bad(`${slot} is too long`);
        if (issue.code === "invalid_format") {
          return bad(`${slot} must be a stable lowercase slug`);
        }
        return bad(`${slot} must be a non-empty string`);
      }
      if (issue.code === "custom") return bad(issue.message);
      return bad("collections must be an array");
    }
    case "credential_refs":
      return credentialRefsFault(issue);
    default:
      if (issue.code === "unrecognized_keys") {
        return unknownKeysError(
          `source ${idLabel}`,
          issue,
          SOURCE_DEFINITION_KEYS,
        );
      }
      return bad(`source ${idLabel} definition is invalid`);
  }
}

function validateKnownPayload(
  kind: string,
  payload: Record<string, unknown>,
): void {
  if (kind === "blog_feed" || kind === "blog_source") {
    const homepage = payload.homepage_url;
    const feed = payload.feed_url;
    if (homepage === undefined && feed === undefined) {
      throw sourceError(
        "bad_source_manifest",
        `${kind} payload requires homepage_url or feed_url`,
      );
    }
    if (homepage !== undefined)
      validateHttpUrl(requiredString(homepage, "payload.homepage_url", 2_000));
    if (feed !== undefined)
      validateHttpUrl(requiredString(feed, "payload.feed_url", 2_000));
    if (payload.timeout_ms !== undefined) {
      positiveInteger(payload.timeout_ms, "payload.timeout_ms", 300_000);
    }
    return;
  }
  if (kind === "x_account") {
    const handle = requiredString(payload.handle, "payload.handle", 21);
    if (!X_HANDLE_PATTERN.test(handle)) {
      throw sourceError(
        "bad_source_manifest",
        "x_account payload.handle is invalid",
      );
    }
    if (payload.account_id !== undefined) {
      const accountId = requiredString(
        payload.account_id,
        "payload.account_id",
        100,
      );
      if (!/^[A-Za-z0-9._:-]+$/.test(accountId)) {
        throw sourceError(
          "bad_source_manifest",
          "x_account payload.account_id is invalid",
        );
      }
    }
    if (payload.profile_url !== undefined) {
      validateHttpUrl(
        requiredString(payload.profile_url, "payload.profile_url", 2_000),
      );
    }
  }
}

export function isExecutableSourceKind(kind: string): kind is KnownSourceKind {
  return KNOWN_SOURCE_KIND_SET.has(kind as KnownSourceKind);
}

/**
 * Validates one merged definition with the zod schema, replaying its issues
 * in the order the hand-rolled validator read the fields, so a multi-fault
 * definition still surfaces the same first fault — and the payload sweeps
 * (whose URL faults are plain Errors, exiting 1 as unexpected errors) still
 * run between the identity fields and the remaining ones.
 */
function validateSourceDefinition(value: unknown): SourceDefinition {
  const input = record(value, "source definition");
  const parsed = sourceDefinitionValuesSchema.safeParse(input);
  const issues: readonly ManifestIssue[] = parsed.success
    ? []
    : parsed.error.issues;
  const throwAt = (key: string, idLabel: string): void => {
    const issue = issueAt(issues, key);
    if (issue !== undefined) throw definitionFault(issue, idLabel);
  };

  throwAt("id", "?");
  const id = String(input.id).trim();
  for (const key of ["version", "kind", "enabled", "sensitivity", "payload"]) {
    throwAt(key, id);
  }

  const payload = input.payload as Record<string, unknown>;
  const kind = String(input.kind).trim();
  credentialFree(payload, `source ${id} payload`);
  validateKnownPayload(kind, payload);

  throwAt("display_name", id);
  throwAt("schedule", id);
  const schedule = parseSchedule(input.schedule);
  throwAt("limits", id);
  const limits = parseLimits(input.limits);
  throwAt("collections", id);
  throwAt("credential_refs", id);
  const unknown = issues.find(
    (issue) => issue.code === "unrecognized_keys" && issue.path.length === 0,
  );
  if (unknown !== undefined) {
    throw unknownKeysError(`source ${id}`, unknown, SOURCE_DEFINITION_KEYS);
  }
  if (!parsed.success) {
    const [first] = issues;
    throw first !== undefined
      ? definitionFault(first, id)
      : sourceError(
          "bad_source_manifest",
          `source ${id} definition is invalid`,
        );
  }

  const values = parsed.data;
  const definition: SourceDefinition = {
    id: values.id,
    version: values.version,
    kind: values.kind,
    display_name: values.display_name ?? values.id,
    enabled: values.enabled,
    payload,
    schedule,
    limits,
    collections: values.collections,
    sensitivity: values.sensitivity,
    credential_refs: values.credential_refs ?? [],
  };
  if (
    (kind === "blog_feed" || kind === "blog_source") &&
    payload.recorded_input_file === undefined &&
    definition.limits.max_pages_per_run > 10
  ) {
    throw sourceError(
      "bad_source_manifest",
      "live blog Sources support at most 10 pages per run",
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(definition), "utf8") > MAX_DEFINITION_BYTES
  ) {
    throw sourceError(
      "bad_source_manifest",
      `source ${id} definition is too large`,
    );
  }
  return definition;
}

/** `$schema` is editor tooling, never configuration; drop it pre-validation. */
function stripEditorSchemaKey(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { $schema: _editorSchema, ...manifest } = value as Record<
    string,
    unknown
  >;
  return manifest;
}

/** Envelope issues, replayed in the order the old checks ran. */
function envelopeFault(
  name: string,
  issues: readonly ManifestIssue[],
): CliError {
  if (
    issues.some(
      (issue) => issue.path.length === 0 && issue.code === "invalid_type",
    )
  ) {
    return sourceError("bad_source_manifest", `${name} must be an object`);
  }
  if (issueAt(issues, "schema_version") !== undefined) {
    return sourceError(
      "unsupported_source_manifest_version",
      `${name} schema_version must be ${SOURCE_MANIFEST_VERSION}`,
    );
  }
  const arrayIssue = issues.find(
    (issue) => issue.path.length === 1 && issue.path[0] === "sources",
  );
  if (arrayIssue !== undefined) {
    return arrayIssue.code === "too_big"
      ? sourceError(
          "bad_source_manifest",
          `${name}.sources exceeds the ${MAX_SOURCES}-source limit`,
        )
      : sourceError("bad_source_manifest", `${name}.sources must be an array`);
  }
  const entryIssue = issueAt(issues, "sources");
  if (entryIssue !== undefined) {
    return sourceError(
      "bad_source_manifest",
      `${name}.sources[${String(entryIssue.path[1])}] must be an object`,
    );
  }
  const unknown = issues.find((issue) => issue.code === "unrecognized_keys");
  if (unknown !== undefined) {
    return unknownKeysError(name, unknown, MANIFEST_KEYS);
  }
  return sourceError(
    "bad_source_manifest",
    `${name} is not a valid source manifest`,
  );
}

/**
 * zod's object parser deliberately skips a literal own `__proto__` key as an
 * anti-pollution guard, so `strictObject` never reports it among its
 * `unrecognized_keys` — it would be the one unknown key the strict levels
 * still accepted and dropped in silence, which is exactly the mode the
 * strictness flip exists to end. JSON.parse does define it as an ordinary own
 * property, so the raw document is scanned for it here instead.
 *
 * The scan runs per file and before the overlay merge, which is both where a
 * manifest's strict levels belong and the only point at which the key is still
 * visible: `deepMerge` would hand it to the prototype setter, dropping it and
 * reshaping the merged definition. `payload` is an open passthrough and is not
 * scanned — a `__proto__` entry rides through it like any other key.
 */
function rejectProtoKey(
  value: unknown,
  scope: string,
  known: readonly string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (Object.hasOwn(value, "__proto__")) {
    throw unknownKeyNamesError(scope, ["__proto__"], known);
  }
}

function rejectProtoKeys(
  manifest: unknown,
  sources: readonly unknown[],
  name: string,
): void {
  rejectProtoKey(manifest, name, MANIFEST_KEYS);
  for (const source of sources) {
    if (source === null || typeof source !== "object") continue;
    const entry = source as Record<string, unknown>;
    // "?" is the same stand-in the definition faults use before the id is known.
    const rawId = entry.id;
    const id =
      typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : "?";
    rejectProtoKey(entry, `source ${id}`, SOURCE_DEFINITION_KEYS);
    rejectProtoKey(entry.schedule, `source ${id} schedule`, SCHEDULE_KEYS);
    rejectProtoKey(entry.limits, `source ${id} limits`, LIMITS_KEYS);
  }
}

function rawManifest(value: unknown, name: string): Record<string, unknown>[] {
  const stripped = stripEditorSchemaKey(value);
  const parsed = manifestEnvelopeSchema.safeParse(stripped);
  if (!parsed.success) throw envelopeFault(name, parsed.error.issues);
  const sources = (stripped as Record<string, unknown>).sources as unknown[];
  rejectProtoKeys(stripped, sources, name);
  return sources.map((source) => source as Record<string, unknown>);
}

function assertUniqueIds(
  sources: readonly Record<string, unknown>[],
  name: string,
): void {
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    const id = requiredString(source.id, `${name}.sources[${index}].id`, 100);
    if (seen.has(id)) {
      throw sourceError(
        "duplicate_source_id",
        `duplicate stable source id '${id}'`,
      );
    }
    seen.add(id);
  }
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = output[key];
    output[key] =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      previous !== null &&
      typeof previous === "object" &&
      !Array.isArray(previous)
        ? deepMerge(
            previous as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return output;
}

export function mergeSourceOverlay(
  manifestValue: unknown,
  overlayValue?: unknown,
): SourceManifest {
  const base = rawManifest(manifestValue, "source manifest");
  assertUniqueIds(base, "source manifest");
  let merged = base;
  if (overlayValue !== undefined) {
    const overlay = rawManifest(overlayValue, "source overlay");
    assertUniqueIds(overlay, "source overlay");
    const positions = new Map(
      merged.map((source, index) => [String(source.id), index] as const),
    );
    merged = merged.map((source) => ({ ...source }));
    for (const item of overlay) {
      const id = String(item.id);
      const position = positions.get(id);
      if (position === undefined) {
        positions.set(id, merged.length);
        merged.push(item);
        continue;
      }
      const base = merged[position];
      if (base === undefined) continue;
      const combined = deepMerge(base, item);
      if (
        item.kind !== undefined &&
        base.kind !== undefined &&
        item.kind !== base.kind
      ) {
        throw sourceError(
          "source_identity_mismatch",
          `source overlay cannot change kind for stable source id '${id}'`,
        );
      }
      combined.id = id;
      merged[position] = combined;
    }
  }
  const sources = merged.map(validateSourceDefinition);
  return { schema_version: SOURCE_MANIFEST_VERSION, sources };
}

export function validateSourceManifest(value: unknown): SourceManifest {
  return mergeSourceOverlay(value);
}

export function readSourceManifest(
  manifestPath: string,
  overlayPath?: string,
): SourceManifest {
  let manifest: unknown;
  let overlay: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (overlayPath !== undefined) {
      overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
    }
  } catch (error) {
    throw sourceError(
      "bad_source_manifest",
      error instanceof Error ? error.message : String(error),
    );
  }
  return mergeSourceOverlay(manifest, overlay);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function sourceDefinitionHash(definition: SourceDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(definition)))
    .digest("hex");
}

function sourceCadenceMs(schedule: SourceSchedule): number {
  return schedule.cadence_seconds * 1_000;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function fallbackDefinition(row: SourceRow): SourceDefinition {
  const parsed = parseJson<Partial<SourceDefinition>>(row.definition, {});
  return {
    id: row.identifier,
    version: row.definition_version,
    kind: row.source_type,
    display_name: row.display_name ?? row.identifier,
    enabled: Boolean(row.enabled),
    payload:
      parsed.payload !== null &&
      typeof parsed.payload === "object" &&
      !Array.isArray(parsed.payload)
        ? parsed.payload
        : {},
    schedule: parsed.schedule ??
      parseJson<SourceSchedule | null>(row.schedule, null) ?? {
        cadence_seconds: 86_400,
      },
    limits: parsed.limits ??
      parseJson<SourceLimits | null>(row.limits, null) ?? {
        max_items_per_run: 1,
        max_pages_per_run: 1,
      },
    collections: parsed.collections ?? parseJson<string[]>(row.collections, []),
    sensitivity: row.sensitivity,
    credential_refs:
      parsed.credential_refs ?? parseJson<string[]>(row.credential_refs, []),
  };
}

function sourceRows(db: Database, stableId?: string): SourceRow[] {
  const columns = `id, source_type, identifier, display_name, enabled,
    sensitivity, schedule, checkpoint, definition_version, definition,
    definition_hash, collections, limits, credential_refs, paused, pause_reason,
    health_state, health_detail, last_evaluated_at, last_success_at, next_due_at,
    created_at, updated_at`;
  return (
    stableId === undefined
      ? db.query(`SELECT ${columns} FROM sources ORDER BY identifier ASC`).all()
      : db
          .query(
            `SELECT ${columns} FROM sources WHERE identifier=? ORDER BY id ASC`,
          )
          .all(stableId)
  ) as SourceRow[];
}

function listItem(row: SourceRow): SourceListItem {
  const definition = fallbackDefinition(row);
  return {
    id: row.identifier,
    database_id: row.id,
    version: row.definition_version,
    kind: row.source_type,
    display_name: row.display_name ?? row.identifier,
    enabled: Boolean(row.enabled),
    paused: Boolean(row.paused),
    executable: isExecutableSourceKind(row.source_type),
    schedule: definition.schedule,
    sensitivity: row.sensitivity,
    collections: definition.collections,
    limits: definition.limits,
    credential_reference_count: definition.credential_refs.length,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function latestCheckpoint(
  db: Database,
  sourceId: number,
): { run_id: number; committed_at: string } | null {
  return db
    .query(
      `SELECT run_id, committed_at FROM source_checkpoints
       WHERE source_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(sourceId) as { run_id: number; committed_at: string } | null;
}

function detail(db: Database, row: SourceRow): SourceDetail {
  const definition = fallbackDefinition(row);
  const checkpoint = latestCheckpoint(db, row.id);
  return {
    ...listItem(row),
    payload: definition.payload,
    pause_reason: row.pause_reason,
    health: {
      state: row.health_state,
      detail: row.health_detail,
      last_evaluated_at: row.last_evaluated_at,
      last_success_at: row.last_success_at,
      next_due_at: row.next_due_at,
    },
    checkpoint: {
      present: row.checkpoint !== null,
      run_id: checkpoint?.run_id ?? null,
      committed_at: checkpoint?.committed_at ?? null,
    },
  };
}

export function listSources(db: Database): SourceListItem[] {
  return sourceRows(db).map(listItem);
}

export function showSource(db: Database, stableId: string): SourceDetail {
  const rows = sourceRows(db, stableId);
  if (rows.length === 0) {
    throw new CliError("source_not_found", `source '${stableId}' not found`);
  }
  const [row] = rows;
  if (rows.length > 1 || row === undefined) {
    throw new CliError(
      "duplicate_source_id",
      `stable source id '${stableId}' is not unique in durable state`,
    );
  }
  return detail(db, row);
}

function sourceRunCounts(row: RunRow): SourceRunCounts {
  return {
    discovered: row.discovered_count,
    admitted: row.admitted_count,
    suppressed: row.suppressed_count,
  };
}

function status(db: Database, row: SourceRow, now: Date): SourceStatus {
  const current = detail(db, row);
  const latest = db
    .query(
      `SELECT id, state, terminal_outcome, warnings, discovered_count,
              admitted_count, suppressed_count, created_at, finished_at
       FROM runs WHERE source_id=? AND run_type='source_sync'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(row.id) as RunRow | null;
  return {
    ...current,
    due:
      current.enabled &&
      !current.paused &&
      current.executable &&
      row.next_due_at !== null &&
      Date.parse(row.next_due_at) <= now.getTime(),
    latest_run:
      latest === null
        ? null
        : {
            id: latest.id,
            state: latest.state,
            outcome: latest.terminal_outcome,
            warnings: parseJson<unknown[]>(latest.warnings, []).length,
            counts: sourceRunCounts(latest),
            created_at: latest.created_at,
            finished_at: latest.finished_at,
          },
  };
}

export function sourceStatuses(
  db: Database,
  options: { sourceId?: string; now?: Date } = {},
): SourceStatus[] {
  const rows = sourceRows(db, options.sourceId);
  if (options.sourceId !== undefined && rows.length === 0) {
    throw new CliError(
      "source_not_found",
      `source '${options.sourceId}' not found`,
    );
  }
  return rows.map((row) => status(db, row, options.now ?? new Date()));
}

export function sourceRunStatus(db: Database, runId: number): SourceRunStatus {
  const row = db
    .query(
      `SELECT s.identifier AS source_identifier,
              r.id AS run_id, r.state AS run_state,
              r.terminal_outcome, r.warnings,
              r.discovered_count, r.admitted_count, r.suppressed_count,
              r.committed_checkpoint, r.created_at, r.started_at, r.finished_at,
              j.id AS job_id, j.state AS job_state,
              j.failure_class, j.failure_summary
       FROM runs r
       JOIN sources s ON s.id=r.source_id
       LEFT JOIN jobs j ON j.run_id=r.id AND j.kind='source_sync'
       WHERE r.id=? AND r.run_type='source_sync'
       ORDER BY j.id ASC LIMIT 1`,
    )
    .get(runId) as {
    source_identifier: string;
    run_id: number;
    run_state: RunState;
    terminal_outcome: SourceRunOutcome | null;
    warnings: string;
    discovered_count: number;
    admitted_count: number;
    suppressed_count: number;
    committed_checkpoint: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    job_id: number | null;
    job_state: JobState | null;
    failure_class: string | null;
    failure_summary: string | null;
  } | null;
  if (row === null) {
    throw new CliError("source_run_not_found", `source Run ${runId} not found`);
  }
  return {
    source_id: row.source_identifier,
    run_id: row.run_id,
    run_state: row.run_state,
    outcome: row.terminal_outcome,
    terminal: row.terminal_outcome !== null,
    warnings: parseJson<unknown[]>(row.warnings, []).length,
    counts: {
      discovered: row.discovered_count,
      admitted: row.admitted_count,
      suppressed: row.suppressed_count,
    },
    checkpoint_committed: row.committed_checkpoint !== null,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    job:
      row.job_id === null || row.job_state === null
        ? null
        : {
            id: row.job_id,
            state: row.job_state,
            failure_class: row.failure_class,
            failure_summary: row.failure_summary,
          },
  };
}

export function latestSourceRunStatus(
  db: Database,
  stableSourceId: string,
): SourceRunStatus | null {
  const row = db
    .query(
      `SELECT r.id
       FROM runs r JOIN sources s ON s.id=r.source_id
       WHERE s.identifier=? AND r.run_type='source_sync'
       ORDER BY r.id DESC LIMIT 1`,
    )
    .get(stableSourceId) as { id: number } | null;
  return row === null ? null : sourceRunStatus(db, row.id);
}

export interface SourceApplyResult {
  source_id: string;
  database_id: number;
  version: number;
  created: boolean;
  changed: boolean;
}

export interface SourceRunExecutionContext {
  run: Run;
  source: Source;
  definition: SourceDefinition;
  checkpoint: unknown | null;
}

/** One provider-neutral Observation ready for durable source fanout. */
export interface SourceObservationAdmission {
  /** Stable within a replayed Run; duplicates retain the provider stableId. */
  observationKey: string;
  stableId: string;
  observedVersion: string;
  resourceKey: { type: string; value: string };
  locator: string | null;
  metadata: Record<string, unknown>;
  suppressionReason: string | null;
  admission: {
    idempotencyKey: string;
    intent: string;
  } | null;
}

interface SourceAdmissionJob {
  id: number;
  resource_id: number | null;
  intent: string | null;
}

export interface SourceRunWindowCommit {
  runId: number;
  observations: readonly SourceObservationAdmission[];
  attemptedCursor: unknown;
  warnings: readonly string[];
  disposition: "success" | "partial" | "retry" | "failed" | "cancelled";
  checkpoint?: unknown;
  healthDetail: string;
  pauseReason?: string;
  /** Fault-injection seam exercised before the Checkpoint statement. */
  beforeCheckpointCommit?: () => void;
  now?: Date;
}

function limitCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

export class SourceRegistry {
  readonly db: Database;

  constructor(store: { readonly db: Database }) {
    this.db = store.db;
  }

  applySourceManifest(
    manifest: SourceManifest,
    options: { actor?: string; reason?: string; now?: Date } = {},
  ): Array<{
    source_id: string;
    database_id: number;
    version: number;
    created: boolean;
    changed: boolean;
  }> {
    if (manifest.schema_version !== SOURCE_MANIFEST_VERSION) {
      throw new CliError(
        "unsupported_source_manifest_version",
        `source manifest schema_version must be ${SOURCE_MANIFEST_VERSION}`,
        { exitCode: 2 },
      );
    }
    const definitions = manifest.sources.map(validateSourceDefinition);
    if (
      new Set(definitions.map((definition) => definition.id)).size !==
      definitions.length
    ) {
      throw new CliError(
        "duplicate_source_id",
        "source manifest contains a duplicate stable source id",
        { exitCode: 2 },
      );
    }
    const actor = this.validatedSourceActor(options.actor ?? "manifest");
    const reason = this.validatedSourceReason(
      options.reason ?? "manifest_apply",
    );
    const timestamp = (options.now ?? new Date()).toISOString();
    const transaction = this.db.transaction(() =>
      definitions.map((definition) =>
        this.applySourceDefinition(definition, actor, reason, timestamp),
      ),
    );
    return transaction.immediate();
  }

  applySourceDefinitions(
    definitions: readonly SourceDefinition[],
    options: { actor?: string; reason?: string; now?: Date } = {},
  ): SourceApplyResult[] {
    return this.applySourceManifest(
      {
        schema_version: SOURCE_MANIFEST_VERSION,
        sources: [...definitions],
      },
      options,
    );
  }

  sourceAuditEvents(stableSourceId: string): SourceAuditEvent[] {
    const source = this.requireSource(stableSourceId);
    return this.db
      .query(
        `SELECT id, source_id, action, actor, reason, definition_version,
                definition_hash, created_at
         FROM source_audit_events WHERE source_id=? ORDER BY id ASC`,
      )
      .all(source.id) as SourceAuditEvent[];
  }

  sourceCheckpoints(stableSourceId: string): SourceCheckpoint[] {
    const source = this.requireSource(stableSourceId);
    return this.db
      .query(
        `SELECT id, source_id, run_id, definition_version, value, committed_at
         FROM source_checkpoints WHERE source_id=? ORDER BY id ASC`,
      )
      .all(source.id) as SourceCheckpoint[];
  }

  pauseSource(input: {
    sourceId: string;
    actor?: string;
    reason?: string;
    now?: Date;
  }): Source {
    return this.setSourcePaused({ ...input, paused: true });
  }

  resumeSource(input: {
    sourceId: string;
    actor?: string;
    reason?: string;
    now?: Date;
  }): Source {
    return this.setSourcePaused({ ...input, paused: false });
  }

  syncSource(input: {
    sourceId: string;
    dueOnly?: boolean;
    dryRun?: boolean;
    now?: Date;
  }): SourceSyncAdmission {
    const now = input.now ?? new Date();
    const transaction = this.db.transaction(() =>
      this.admitSourceSync(
        this.requireSource(input.sourceId),
        now,
        input.dueOnly ?? false,
        input.dryRun ?? false,
      ),
    );
    return transaction.immediate();
  }

  syncDueSources(
    input: { dryRun?: boolean; now?: Date; limit?: number } = {},
  ): SourceSyncAdmission[] {
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const limit = input.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new CliError(
        "bad_source_limit",
        "source schedule evaluation limit must be an integer from 1 to 1000",
        { exitCode: 2 },
      );
    }
    const transaction = this.db.transaction(() => {
      const sources = this.db
        .query(
          `SELECT ${SOURCE_COLUMNS} FROM sources
           WHERE enabled=1 AND paused=0 AND next_due_at IS NOT NULL
             AND next_due_at<=?
           ORDER BY next_due_at ASC, identifier ASC LIMIT ?`,
        )
        .all(timestamp, limit) as Source[];
      return sources.map((source) =>
        isExecutableSourceKind(source.source_type)
          ? this.admitSourceSync(source, now, true, input.dryRun ?? false)
          : {
              source_id: source.identifier,
              source_database_id: source.id,
              status: "unsupported" as const,
              run_id: null,
              job_id: null,
              scheduled_for: source.next_due_at,
              dry_run: input.dryRun ?? false,
            },
      );
    });
    return transaction.immediate();
  }

  sourceRunExecution(runId: number): SourceRunExecutionContext {
    const run = this.requireSourceRun(runId);
    const source = this.db
      .query(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id=?`)
      .get(run.source_id) as Source | null;
    if (source === null || run.source_definition_version === null) {
      throw new CliError(
        "source_run_not_found",
        `source Run ${runId} has no durable source definition`,
      );
    }
    const version = this.db
      .query(
        `SELECT definition FROM source_definition_versions
         WHERE source_id=? AND definition_version=?`,
      )
      .get(source.id, run.source_definition_version) as {
      definition: string;
    } | null;
    if (version === null) {
      throw new CliError(
        "source_definition_not_found",
        `source Run ${runId} definition version is unavailable`,
      );
    }
    let definitionValue: unknown;
    let checkpoint: unknown | null = null;
    try {
      definitionValue = JSON.parse(version.definition) as unknown;
      checkpoint = run.checkpoint === null ? null : JSON.parse(run.checkpoint);
    } catch {
      throw new CliError(
        "invalid_source_state",
        `source Run ${runId} has invalid durable JSON state`,
      );
    }
    return {
      run,
      source,
      definition: validateSourceDefinition(definitionValue),
      checkpoint,
    };
  }

  startSourceRun(input: {
    runId: number;
    attemptedCursor?: unknown;
    now?: Date;
  }): Run {
    const timestamp = (input.now ?? new Date()).toISOString();
    const attemptedCursor =
      input.attemptedCursor === undefined
        ? null
        : this.sourceStateJson(input.attemptedCursor, "attempted cursor");
    const transaction = this.db.transaction((): Run => {
      const run = this.requireSourceRun(input.runId);
      if (run.terminal_outcome !== null) {
        throw new CliError(
          "source_run_terminal",
          `source Run ${input.runId} is already terminal`,
        );
      }
      if (run.state !== "pending" && run.state !== "active") {
        throw new CliError(
          "source_run_not_startable",
          `source Run ${input.runId} cannot start from ${run.state}`,
        );
      }
      this.db
        .query(
          `UPDATE runs SET state='active', started_at=COALESCE(started_at, ?),
             attempted_cursor=COALESCE(?, attempted_cursor), updated_at=?
           WHERE id=?`,
        )
        .run(timestamp, attemptedCursor, timestamp, input.runId);
      return this.requireSourceRun(input.runId);
    });
    return transaction.immediate();
  }

  recordSourceRunProgress(input: {
    runId: number;
    attemptedCursor?: unknown;
    warnings?: readonly string[];
    counts?: SourceRunCounts;
    now?: Date;
  }): Run {
    const timestamp = (input.now ?? new Date()).toISOString();
    const transaction = this.db.transaction((): Run => {
      const run = this.requireSourceRun(input.runId);
      if (run.terminal_outcome !== null) {
        throw new CliError(
          "source_run_terminal",
          `source Run ${input.runId} is already terminal`,
        );
      }
      const counts = input.counts ?? {
        discovered: run.discovered_count,
        admitted: run.admitted_count,
        suppressed: run.suppressed_count,
      };
      this.validateSourceRunCounts(counts);
      const warnings = this.validatedSourceWarnings(
        input.warnings ?? this.parseSourceWarnings(run.warnings),
      );
      const attemptedCursor =
        input.attemptedCursor === undefined
          ? run.attempted_cursor
          : this.sourceStateJson(input.attemptedCursor, "attempted cursor");
      this.db
        .query(
          `UPDATE runs SET attempted_cursor=?, warnings=?, discovered_count=?,
             admitted_count=?, suppressed_count=?, updated_at=? WHERE id=?`,
        )
        .run(
          attemptedCursor,
          JSON.stringify(warnings),
          counts.discovered,
          counts.admitted,
          counts.suppressed,
          timestamp,
          input.runId,
        );
      return this.requireSourceRun(input.runId);
    });
    return transaction.immediate();
  }

  finishSourceRun(input: {
    runId: number;
    outcome: SourceRunOutcome;
    attemptedCursor?: unknown;
    checkpoint?: unknown;
    warnings?: readonly string[];
    counts?: SourceRunCounts;
    healthDetail?: string;
    pauseReason?: string;
    updateSource?: boolean;
    now?: Date;
  }): Run {
    if (
      !["success", "partial", "failed", "cancelled"].includes(input.outcome)
    ) {
      throw new CliError("bad_source_outcome", "invalid source Run outcome", {
        exitCode: 2,
      });
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    const transaction = this.db.transaction((): Run => {
      const run = this.requireSourceRun(input.runId);
      if (run.terminal_outcome !== null) {
        if (run.terminal_outcome === input.outcome) return run;
        throw new CliError(
          "source_run_terminal",
          `source Run ${input.runId} is already terminal`,
        );
      }
      const counts = input.counts ?? {
        discovered: run.discovered_count,
        admitted: run.admitted_count,
        suppressed: run.suppressed_count,
      };
      this.validateSourceRunCounts(counts);
      const warnings = this.validatedSourceWarnings(
        input.warnings ?? this.parseSourceWarnings(run.warnings),
      );
      const attemptedCursor =
        input.attemptedCursor === undefined
          ? run.attempted_cursor
          : this.sourceStateJson(input.attemptedCursor, "attempted cursor");
      let checkpoint: string | null = null;
      if (input.checkpoint !== undefined) {
        const durable = this.db
          .query(
            `SELECT COUNT(*) AS discovered,
                    COALESCE(SUM(CASE
                      WHEN o.suppressed=0 AND d.admission_job_id IS NOT NULL
                      THEN 1 ELSE 0 END), 0) AS admitted,
                    COALESCE(SUM(CASE WHEN o.suppressed=1 THEN 1 ELSE 0 END), 0) AS suppressed
             FROM source_observation_details d
             JOIN observations o ON o.id=d.observation_id
             WHERE d.run_id=?`,
          )
          .get(run.id) as SourceRunCounts;
        if (
          input.outcome !== "success" ||
          counts.discovered !== counts.admitted + counts.suppressed ||
          Number(durable.discovered) !== counts.discovered ||
          Number(durable.admitted) !== counts.admitted ||
          Number(durable.suppressed) !== counts.suppressed
        ) {
          throw new CliError(
            "unsafe_checkpoint",
            "a checkpoint requires a complete successful discovery window with every observation admitted or suppressed",
          );
        }
        checkpoint = this.sourceStateJson(input.checkpoint, "checkpoint");
        this.db
          .query(
            `INSERT INTO source_checkpoints(
               source_id, run_id, definition_version, value, committed_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            run.source_id,
            run.id,
            run.source_definition_version,
            checkpoint,
            timestamp,
          );
      }
      const state =
        input.outcome === "failed"
          ? "failed"
          : input.outcome === "cancelled"
            ? "cancelled"
            : "completed";
      this.db
        .query(
          `UPDATE runs SET state=?, attempted_cursor=?,
             committed_checkpoint=COALESCE(?, committed_checkpoint), warnings=?,
             discovered_count=?, admitted_count=?, suppressed_count=?,
             terminal_outcome=?, finished_at=?, updated_at=? WHERE id=?`,
        )
        .run(
          state,
          attemptedCursor,
          checkpoint,
          JSON.stringify(warnings),
          counts.discovered,
          counts.admitted,
          counts.suppressed,
          input.outcome,
          timestamp,
          timestamp,
          run.id,
        );
      const healthState: SourceHealthState =
        input.outcome === "failed" || input.outcome === "cancelled"
          ? "unhealthy"
          : input.outcome === "partial" || warnings.length > 0
            ? "warning"
            : "healthy";
      const healthDetail =
        input.healthDetail === undefined
          ? (warnings[0] ?? input.outcome)
          : limitCodePoints(sanitizeExternalError(input.healthDetail), 500);
      const pauseReason =
        input.pauseReason === undefined
          ? null
          : this.validatedSourceReason(input.pauseReason);
      if (input.updateSource !== false) {
        this.db
          .query(
            `UPDATE sources SET checkpoint=COALESCE(?, checkpoint),
               health_state=?, health_detail=?, last_evaluated_at=?,
               last_success_at=CASE WHEN ?='success' THEN ? ELSE last_success_at END,
               paused=CASE WHEN ? IS NULL THEN paused ELSE 1 END,
               pause_reason=COALESCE(?, pause_reason), updated_at=? WHERE id=?`,
          )
          .run(
            checkpoint,
            healthState,
            healthDetail,
            timestamp,
            input.outcome,
            timestamp,
            pauseReason,
            pauseReason,
            timestamp,
            run.source_id,
          );
        if (pauseReason !== null) {
          const source = this.db
            .query(
              "SELECT definition_version, definition_hash FROM sources WHERE id=?",
            )
            .get(run.source_id) as {
            definition_version: number;
            definition_hash: string;
          };
          this.db
            .query(
              `INSERT INTO source_audit_events(
                 source_id, action, actor, reason, definition_version,
                 definition_hash, created_at
               ) VALUES (?, 'paused', 'source-worker', ?, ?, ?, ?)`,
            )
            .run(
              run.source_id,
              pauseReason,
              source.definition_version,
              source.definition_hash,
              timestamp,
            );
        }
      }
      return this.requireSourceRun(input.runId);
    });
    return transaction.immediate();
  }

  commitSourceCheckpoint(input: {
    runId: number;
    checkpoint: unknown;
    attemptedCursor?: unknown;
    warnings?: readonly string[];
    counts?: SourceRunCounts;
    now?: Date;
  }): Run {
    return this.finishSourceRun({
      ...input,
      outcome: "success",
    });
  }

  /**
   * Persist a discovery window's Observations and Admissions. A successful
   * Checkpoint shares one SQLite transaction with every resource job or
   * Suppressed observation in the window.
   */
  commitSourceRunWindow(input: SourceRunWindowCommit): Run {
    if (input.observations.length > 10_000) {
      throw new CliError(
        "source_window_too_large",
        "source discovery window exceeds the 10000-Observation bound",
      );
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    const transaction = this.db.transaction((): Run => {
      const context = this.sourceRunExecution(input.runId);
      const runSensitivity =
        SOURCE_SENSITIVITY_RANK[context.source.sensitivity] >
        SOURCE_SENSITIVITY_RANK[context.definition.sensitivity]
          ? context.source.sensitivity
          : context.definition.sensitivity;
      if (context.run.terminal_outcome !== null) {
        if (
          (input.disposition === "success" &&
            context.run.terminal_outcome === "success") ||
          (input.disposition === "partial" &&
            context.run.terminal_outcome === "partial") ||
          (input.disposition === "failed" &&
            context.run.terminal_outcome === "failed") ||
          (input.disposition === "cancelled" &&
            context.run.terminal_outcome === "cancelled")
        ) {
          return context.run;
        }
        throw new CliError(
          "source_run_terminal",
          `source Run ${input.runId} is already terminal`,
        );
      }

      const observationKeys = new Set<string>();
      for (const observation of input.observations) {
        const stableId = String(observation.stableId ?? "").trim();
        const observationKey = String(observation.observationKey ?? "").trim();
        if (
          stableId.length === 0 ||
          Array.from(stableId).length > 512 ||
          observationKey.length === 0 ||
          Array.from(observationKey).length > 600 ||
          observationKeys.has(observationKey)
        ) {
          throw new CliError(
            "bad_source_observation",
            "source Observations require unique bounded Observation keys and stable entry IDs",
          );
        }
        observationKeys.add(observationKey);
        if (
          !observation.resourceKey.type.trim() ||
          !observation.resourceKey.value.trim() ||
          Array.from(observation.resourceKey.type).length > 100 ||
          Array.from(observation.resourceKey.value).length > 4_096
        ) {
          throw new CliError(
            "bad_source_observation",
            "source Observation Resource keys must be bounded and non-empty",
          );
        }
        const metadata = this.sourceStateJson(
          observation.metadata,
          "Observation metadata",
        );
        if (Buffer.byteLength(metadata, "utf8") > 16 * 1024) {
          throw new CliError(
            "bad_source_observation",
            "source Observation metadata exceeds its 16 KiB bound",
          );
        }
        const suppressionReason =
          observation.suppressionReason === null
            ? null
            : this.validatedSourceReason(observation.suppressionReason);
        if ((observation.admission === null) !== (suppressionReason !== null)) {
          throw new CliError(
            "bad_source_observation",
            "every source Observation must have either an Admission or a suppression reason",
          );
        }

        const previous = this.db
          .query(
            `SELECT o.resource_id, d.observed_version
             FROM source_observation_details d
             JOIN observations o ON o.id=d.observation_id
             WHERE d.source_id=? AND d.stable_id=? AND o.suppressed=0
             ORDER BY d.run_id DESC LIMIT 1`,
          )
          .get(context.source.id, stableId) as {
          resource_id: number;
          observed_version: string;
        } | null;
        const observedVersionChanged =
          previous !== null &&
          previous.observed_version !== observation.observedVersion;
        const keyed = this.db
          .query("SELECT id FROM resources WHERE key_type=? AND key_value=?")
          .get(observation.resourceKey.type, observation.resourceKey.value) as {
          id: number;
        } | null;
        const aliased =
          observation.locator === null
            ? null
            : (this.db
                .query(
                  `SELECT resource_id AS id FROM resource_aliases
                   WHERE locator=? ORDER BY id ASC LIMIT 1`,
                )
                .get(observation.locator) as { id: number } | null);
        let resourceId = previous?.resource_id ?? keyed?.id ?? aliased?.id;
        if (resourceId === undefined) {
          resourceId = Number(
            this.db
              .query(
                `INSERT INTO resources(
                   key_type, key_value, kind, sensitivity, created_at, updated_at
                 ) VALUES (?, ?, 'url', ?, ?, ?)`,
              )
              .run(
                observation.resourceKey.type,
                observation.resourceKey.value,
                runSensitivity,
                timestamp,
                timestamp,
              ).lastInsertRowid,
          );
        } else {
          this.db
            .query(
              `UPDATE resources SET sensitivity=CASE
                 WHEN (SELECT rank FROM sensitivity_levels WHERE level=?) >
                      (SELECT rank FROM sensitivity_levels WHERE level=resources.sensitivity)
                 THEN ? ELSE sensitivity END, updated_at=? WHERE id=?`,
            )
            .run(runSensitivity, runSensitivity, timestamp, resourceId);
        }

        this.db
          .query(
            `INSERT INTO resource_aliases(
               resource_id, alias_type, locator, evidence,
               first_observed_at, last_observed_at
             ) VALUES (?, 'source_entry_id', ?, 'source_discovery', ?, ?)
             ON CONFLICT(resource_id, alias_type, locator) DO UPDATE SET
               last_observed_at=excluded.last_observed_at`,
          )
          .run(
            resourceId,
            `${context.source.identifier}:${stableId}`,
            timestamp,
            timestamp,
          );
        if (observation.locator !== null) {
          this.db
            .query(
              `INSERT INTO resource_aliases(
                 resource_id, alias_type, locator, evidence,
                 first_observed_at, last_observed_at
               ) VALUES (?, 'source_observed_url', ?, 'source_discovery', ?, ?)
               ON CONFLICT(resource_id, alias_type, locator) DO UPDATE SET
                 last_observed_at=excluded.last_observed_at`,
            )
            .run(resourceId, observation.locator, timestamp, timestamp);
        }

        const existingDetail = this.db
          .query(
            `SELECT observation_id FROM source_observation_details
             WHERE run_id=? AND observation_key=?`,
          )
          .get(input.runId, observationKey) as {
          observation_id: number;
        } | null;
        let observationId: number;
        if (existingDetail === null) {
          observationId = Number(
            this.db
              .query(
                `INSERT INTO observations(
                   resource_id, source_id, run_id, ingress, observed_locator,
                   suppressed, suppressed_reason, observed_at
                 ) VALUES (?, ?, ?, 'source_sync', ?, ?, ?, ?)`,
              )
              .run(
                resourceId,
                context.source.id,
                input.runId,
                observation.locator,
                suppressionReason === null ? 0 : 1,
                suppressionReason,
                timestamp,
              ).lastInsertRowid,
          );
          this.db
            .query(
              `INSERT INTO source_observation_details(
                 observation_id, source_id, run_id, observation_key, stable_id,
                 observed_version, metadata, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              observationId,
              context.source.id,
              input.runId,
              observationKey,
              stableId,
              observation.observedVersion,
              metadata,
              timestamp,
              timestamp,
            );
        } else {
          observationId = existingDetail.observation_id;
          this.db
            .query(
              `UPDATE observations SET resource_id=?, observed_locator=?,
                 suppressed=?, suppressed_reason=?, observed_at=? WHERE id=?`,
            )
            .run(
              resourceId,
              observation.locator,
              suppressionReason === null ? 0 : 1,
              suppressionReason,
              timestamp,
              observationId,
            );
          this.db
            .query(
              `UPDATE source_observation_details SET observed_version=?,
                 metadata=?, updated_at=? WHERE observation_id=?`,
            )
            .run(
              observation.observedVersion,
              metadata,
              timestamp,
              observationId,
            );
        }

        let admissionJobId: number | null = null;
        if (observation.admission !== null) {
          let job = observedVersionChanged
            ? null
            : (this.db
                .query(
                  `SELECT id, resource_id, intent FROM jobs
                   WHERE resource_id=? AND kind='url'
                   ORDER BY CASE state WHEN 'completed' THEN 0 ELSE 1 END, id ASC
                   LIMIT 1`,
                )
                .get(resourceId) as SourceAdmissionJob | null);
          if (
            job === null &&
            !observedVersionChanged &&
            observation.locator !== null
          ) {
            job = this.db
              .query(
                `SELECT id, resource_id, intent FROM jobs
                 WHERE kind='url' AND intent IS NOT NULL
                   AND json_extract(
                     CASE WHEN json_valid(intent) THEN intent ELSE NULL END,
                     '$.payload.url.url'
                   )=?
                 ORDER BY CASE state WHEN 'completed' THEN 0 ELSE 1 END, id ASC
                 LIMIT 1`,
              )
              .get(observation.locator) as SourceAdmissionJob | null;
          }
          if (job === null) {
            job = this.db
              .query(
                "SELECT id, resource_id, intent FROM jobs WHERE idempotency_key=?",
              )
              .get(
                observation.admission.idempotencyKey,
              ) as SourceAdmissionJob | null;
            if (
              job !== null &&
              (job.intent !== observation.admission.intent ||
                (job.resource_id !== null && job.resource_id !== resourceId))
            ) {
              throw new CliError(
                "idempotency_conflict",
                "source Admission conflicts with an existing durable intent",
              );
            }
            if (job === null) {
              const inserted = this.db
                .query(
                  `INSERT INTO jobs(
                     idempotency_key, kind, intent, resource_id, source_id,
                     run_id, state, sensitivity, run_at, created_at, updated_at
                   ) VALUES (?, 'url', ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
                )
                .run(
                  observation.admission.idempotencyKey,
                  observation.admission.intent,
                  resourceId,
                  context.source.id,
                  input.runId,
                  runSensitivity,
                  timestamp,
                  timestamp,
                  timestamp,
                );
              job = {
                id: Number(inserted.lastInsertRowid),
                resource_id: resourceId,
                intent: observation.admission.intent,
              };
              this.recordTransition(
                job.id,
                null,
                null,
                "queued",
                "source-worker",
                "source_observation_admitted",
                null,
                timestamp,
              );
            }
          }
          if (job !== null) {
            if (job.resource_id !== null && job.resource_id !== resourceId) {
              throw new CliError(
                "resource_identity_conflict",
                "source Admission resolved to a job for a different Resource",
              );
            }
            admissionJobId = job.id;
            this.db
              .query(
                `UPDATE jobs SET resource_id=COALESCE(resource_id, ?),
                   sensitivity=CASE
                     WHEN (SELECT rank FROM sensitivity_levels WHERE level=?) >
                          (SELECT rank FROM sensitivity_levels WHERE level=jobs.sensitivity)
                     THEN ? ELSE sensitivity END, updated_at=? WHERE id=?`,
              )
              .run(
                resourceId,
                runSensitivity,
                runSensitivity,
                timestamp,
                job.id,
              );
          }

          for (const slug of context.definition.collections) {
            this.db
              .query(
                `INSERT OR IGNORE INTO collections(
                   slug, title, sensitivity, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?)`,
              )
              .run(slug, slug, runSensitivity, timestamp, timestamp);
            this.db
              .query(
                `INSERT OR IGNORE INTO collection_memberships(
                   collection_id, resource_id, added_at
                 ) SELECT id, ?, ? FROM collections WHERE slug=?`,
              )
              .run(resourceId, timestamp, slug);
          }
        }
        this.db
          .query(
            `UPDATE source_observation_details SET admission_job_id=?,
               updated_at=? WHERE observation_id=?`,
          )
          .run(admissionJobId, timestamp, observationId);
      }

      const countRows = this.db
        .query(
          `SELECT COUNT(*) AS discovered,
                  COALESCE(SUM(CASE WHEN o.suppressed=0 THEN 1 ELSE 0 END), 0) AS admitted,
                  COALESCE(SUM(CASE WHEN o.suppressed=1 THEN 1 ELSE 0 END), 0) AS suppressed
           FROM source_observation_details d
           JOIN observations o ON o.id=d.observation_id WHERE d.run_id=?`,
        )
        .get(input.runId) as SourceRunCounts;
      const counts: SourceRunCounts = {
        discovered: Number(countRows.discovered),
        admitted: Number(countRows.admitted),
        suppressed: Number(countRows.suppressed),
      };
      if (input.disposition === "success") {
        input.beforeCheckpointCommit?.();
      }
      const currentSource = this.requireSource(context.source.identifier);
      const staleDefinition =
        currentSource.definition_version !==
        context.run.source_definition_version;
      const disposition =
        input.disposition === "success" && staleDefinition
          ? "partial"
          : input.disposition;
      const priorWarnings = this.parseSourceWarnings(
        this.requireSourceRun(input.runId).warnings,
      );
      const mergedWarnings = [
        ...new Set([
          ...priorWarnings,
          ...input.warnings,
          ...(staleDefinition ? ["source_definition_changed_during_run"] : []),
        ]),
      ];
      const warnings = this.validatedSourceWarnings(
        mergedWarnings.length <= 100
          ? mergedWarnings
          : [...mergedWarnings.slice(0, 99), "warnings_truncated"],
      );

      if (disposition === "retry") {
        this.recordSourceRunProgress({
          runId: input.runId,
          attemptedCursor: input.attemptedCursor,
          warnings,
          counts,
          now: new Date(timestamp),
        });
        if (!staleDefinition) {
          this.db
            .query(
              `UPDATE sources SET health_state='warning', health_detail=?,
                 last_evaluated_at=?, updated_at=? WHERE id=?`,
            )
            .run(
              limitCodePoints(sanitizeExternalError(input.healthDetail), 500),
              timestamp,
              timestamp,
              context.source.id,
            );
        }
        return this.requireSourceRun(input.runId);
      }
      return this.finishSourceRun({
        runId: input.runId,
        outcome: disposition,
        attemptedCursor: input.attemptedCursor,
        ...(disposition === "success" ? { checkpoint: input.checkpoint } : {}),
        warnings,
        counts,
        healthDetail: staleDefinition
          ? "source definition changed during discovery; checkpoint withheld"
          : input.healthDetail,
        pauseReason: staleDefinition ? undefined : input.pauseReason,
        updateSource: !staleDefinition,
        now: new Date(timestamp),
      });
    });
    return transaction.immediate();
  }

  private applySourceDefinition(
    input: SourceDefinition,
    actor: string,
    reason: string,
    timestamp: string,
  ): {
    source_id: string;
    database_id: number;
    version: number;
    created: boolean;
    changed: boolean;
  } {
    const definition = validateSourceDefinition(input);
    const definitionJson = JSON.stringify(definition);
    const definitionHash = sourceDefinitionHash(definition);
    const existing = this.loadSource(definition.id);
    if (existing !== null && existing.source_type !== definition.kind) {
      throw new CliError(
        "source_identity_mismatch",
        `stable source id '${definition.id}' is already bound to kind '${existing.source_type}'`,
        { exitCode: 2 },
      );
    }
    if (existing !== null && existing.definition_hash === definitionHash) {
      return {
        source_id: definition.id,
        database_id: existing.id,
        version: existing.definition_version,
        created: false,
        changed: false,
      };
    }
    if (
      existing !== null &&
      existing.definition_hash.length > 0 &&
      definition.version <= existing.definition_version
    ) {
      throw new CliError(
        "source_version_conflict",
        `source '${definition.id}' changed without a higher definition version`,
        { exitCode: 2 },
      );
    }

    let sourceId: number;
    let created = false;
    if (existing === null) {
      const inserted = this.db
        .query(
          `INSERT INTO sources(
             source_type, identifier, display_name, enabled, sensitivity,
             schedule, checkpoint, definition_version, definition,
             definition_hash, collections, limits, credential_refs, paused,
             health_state, next_due_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 'never', ?, ?, ?)`,
        )
        .run(
          definition.kind,
          definition.id,
          definition.display_name,
          definition.enabled ? 1 : 0,
          definition.sensitivity,
          JSON.stringify(definition.schedule),
          definition.version,
          definitionJson,
          definitionHash,
          JSON.stringify(definition.collections),
          JSON.stringify(definition.limits),
          JSON.stringify(definition.credential_refs),
          timestamp,
          timestamp,
          timestamp,
        );
      sourceId = Number(inserted.lastInsertRowid);
      created = true;
    } else {
      sourceId = existing.id;
      const nextDueAt =
        !existing.enabled && definition.enabled
          ? timestamp
          : (existing.next_due_at ?? timestamp);
      this.db
        .query(
          `UPDATE sources SET display_name=?, enabled=?, sensitivity=?,
             schedule=?, definition_version=?, definition=?, definition_hash=?,
             collections=?, limits=?, credential_refs=?, next_due_at=?,
             updated_at=? WHERE id=?`,
        )
        .run(
          definition.display_name,
          definition.enabled ? 1 : 0,
          definition.sensitivity,
          JSON.stringify(definition.schedule),
          definition.version,
          definitionJson,
          definitionHash,
          JSON.stringify(definition.collections),
          JSON.stringify(definition.limits),
          JSON.stringify(definition.credential_refs),
          nextDueAt,
          timestamp,
          sourceId,
        );
    }
    this.db
      .query(
        `INSERT INTO source_definition_versions(
           source_id, definition_version, definition_hash, definition, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        definition.version,
        definitionHash,
        definitionJson,
        timestamp,
      );
    this.db
      .query(
        `INSERT INTO source_audit_events(
           source_id, action, actor, reason, definition_version,
           definition_hash, created_at
         ) VALUES (?, 'config_applied', ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        actor,
        reason,
        definition.version,
        definitionHash,
        timestamp,
      );
    return {
      source_id: definition.id,
      database_id: sourceId,
      version: definition.version,
      created,
      changed: true,
    };
  }

  private setSourcePaused(input: {
    sourceId: string;
    paused: boolean;
    actor?: string;
    reason?: string;
    now?: Date;
  }): Source {
    const actor = this.validatedSourceActor(input.actor ?? "operator");
    const reason = this.validatedSourceReason(
      input.reason ?? (input.paused ? "operator_pause" : "operator_resume"),
    );
    const timestamp = (input.now ?? new Date()).toISOString();
    const transaction = this.db.transaction((): Source => {
      const source = this.requireSource(input.sourceId);
      this.db
        .query(
          `UPDATE sources SET paused=?, pause_reason=?,
             next_due_at=CASE
               WHEN ?=0 AND next_due_at IS NULL THEN ? ELSE next_due_at
             END,
             updated_at=? WHERE id=?`,
        )
        .run(
          input.paused ? 1 : 0,
          input.paused ? reason : null,
          input.paused ? 1 : 0,
          timestamp,
          timestamp,
          source.id,
        );
      this.db
        .query(
          `INSERT INTO source_audit_events(
             source_id, action, actor, reason, definition_version,
             definition_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          source.id,
          input.paused ? "paused" : "resumed",
          actor,
          reason,
          source.definition_version,
          source.definition_hash,
          timestamp,
        );
      return this.requireSource(input.sourceId);
    });
    return transaction.immediate();
  }

  private admitSourceSync(
    source: Source,
    now: Date,
    dueOnly: boolean,
    dryRun: boolean,
  ): SourceSyncAdmission {
    const timestamp = now.toISOString();
    const base = {
      source_id: source.identifier,
      source_database_id: source.id,
      run_id: null,
      job_id: null,
      scheduled_for: source.next_due_at,
      dry_run: dryRun,
    };
    const active = this.db
      .query(
        `SELECT r.id AS run_id, j.id AS job_id, r.scheduled_for
         FROM runs r LEFT JOIN jobs j ON j.run_id=r.id AND j.kind='source_sync'
         WHERE r.source_id=? AND r.run_type='source_sync'
           AND r.state IN ('pending', 'active')
         ORDER BY r.id DESC LIMIT 1`,
      )
      .get(source.id) as {
      run_id: number;
      job_id: number | null;
      scheduled_for: string | null;
    } | null;
    if (active !== null) {
      return {
        ...base,
        status: "duplicate",
        run_id: active.run_id,
        job_id: active.job_id,
        scheduled_for: active.scheduled_for,
      };
    }
    if (!source.enabled) return { ...base, status: "disabled" };
    if (source.paused) return { ...base, status: "paused" };
    if (!isExecutableSourceKind(source.source_type)) {
      return { ...base, status: "unsupported" };
    }
    if (
      dueOnly &&
      (source.next_due_at === null ||
        Date.parse(source.next_due_at) > now.getTime())
    ) {
      return { ...base, status: "not_due" };
    }
    const scheduleKey = dueOnly
      ? `catchup:${source.next_due_at}`
      : `manual:${timestamp}`;
    const scheduledFor = dueOnly ? source.next_due_at : timestamp;
    const prior = this.db
      .query(
        `SELECT r.id AS run_id, j.id AS job_id
         FROM runs r LEFT JOIN jobs j ON j.run_id=r.id AND j.kind='source_sync'
         WHERE r.source_id=? AND r.run_type='source_sync' AND r.schedule_key=?`,
      )
      .get(source.id, scheduleKey) as {
      run_id: number;
      job_id: number | null;
    } | null;
    if (prior !== null) {
      return {
        ...base,
        status: "duplicate",
        run_id: prior.run_id,
        job_id: prior.job_id,
        scheduled_for: scheduledFor,
      };
    }
    if (dryRun) {
      return {
        ...base,
        status: "would_queue",
        scheduled_for: scheduledFor,
      };
    }

    const insertedRun = this.db
      .query(
        `INSERT INTO runs(
           run_type, source_id, state, checkpoint, attempted_cursor,
           committed_checkpoint, warnings, discovered_count, admitted_count,
           suppressed_count, terminal_outcome, source_definition_version,
           schedule_key, scheduled_for, created_at, updated_at
         ) VALUES (
           'source_sync', ?, 'pending', ?, NULL, NULL, '[]', 0, 0, 0,
           NULL, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        source.id,
        source.checkpoint,
        source.definition_version,
        scheduleKey,
        scheduledFor,
        timestamp,
        timestamp,
      );
    const runId = Number(insertedRun.lastInsertRowid);
    const intent = {
      version: SOURCE_RUN_INTENT_VERSION,
      kind: "source_sync" as const,
      source_id: source.id,
      stable_source_id: source.identifier,
      source_kind: source.source_type,
      source_definition_version: source.definition_version,
      run_id: runId,
    };
    const insertedJob = this.db
      .query(
        `INSERT INTO jobs(
           idempotency_key, kind, intent, source_id, run_id, state,
           sensitivity, run_at, created_at, updated_at
         ) VALUES (?, 'source_sync', ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        `source-sync:v1:${source.id}:${scheduleKey}`,
        JSON.stringify(intent),
        source.id,
        runId,
        source.sensitivity,
        timestamp,
        timestamp,
        timestamp,
      );
    const jobId = Number(insertedJob.lastInsertRowid);
    this.recordTransition(
      jobId,
      null,
      null,
      "queued",
      "source-scheduler",
      "source_sync_admitted",
      null,
      timestamp,
    );
    if (dueOnly) {
      const schedule = JSON.parse(source.schedule ?? "{}") as {
        cadence_seconds?: unknown;
      };
      if (
        typeof schedule.cadence_seconds !== "number" ||
        !Number.isInteger(schedule.cadence_seconds) ||
        schedule.cadence_seconds < 1
      ) {
        throw new CliError(
          "invalid_source_schedule",
          `source '${source.identifier}' has invalid durable schedule state`,
        );
      }
      const nextDueAt = new Date(
        now.getTime() +
          sourceCadenceMs(schedule as { cadence_seconds: number }),
      ).toISOString();
      this.db
        .query("UPDATE sources SET next_due_at=?, updated_at=? WHERE id=?")
        .run(nextDueAt, timestamp, source.id);
    }
    return {
      source_id: source.identifier,
      source_database_id: source.id,
      status: "queued",
      run_id: runId,
      job_id: jobId,
      scheduled_for: scheduledFor,
      dry_run: false,
    };
  }

  private loadSource(stableSourceId: string): Source | null {
    return this.db
      .query(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE identifier=?`)
      .get(stableSourceId) as Source | null;
  }

  private requireSource(stableSourceId: string): Source {
    const sourceId = String(stableSourceId ?? "").trim();
    if (sourceId.length === 0) {
      throw new CliError("bad_source_id", "source ID is required", {
        exitCode: 2,
      });
    }
    const source = this.loadSource(sourceId);
    if (source === null) {
      throw new CliError("source_not_found", `source '${sourceId}' not found`);
    }
    return source;
  }

  private requireSourceRun(runId: number): Run {
    if (!Number.isInteger(runId) || runId < 1) {
      throw new CliError("bad_run_id", "source Run ID must be positive", {
        exitCode: 2,
      });
    }
    const run = this.db
      .query(`SELECT ${SOURCE_RUN_COLUMNS} FROM runs WHERE id=?`)
      .get(runId) as Run | null;
    if (
      run === null ||
      run.run_type !== "source_sync" ||
      run.source_id === null
    ) {
      throw new CliError(
        "source_run_not_found",
        `source Run ${runId} not found`,
      );
    }
    return run;
  }

  private sourceStateJson(value: unknown, name: string): string {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = undefined;
    }
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > 64 * 1024
    ) {
      throw new CliError(
        "bad_source_state",
        `${name} must be bounded JSON state`,
        { exitCode: 2 },
      );
    }
    return serialized;
  }

  private validateSourceRunCounts(counts: SourceRunCounts): void {
    if (
      !Number.isInteger(counts.discovered) ||
      !Number.isInteger(counts.admitted) ||
      !Number.isInteger(counts.suppressed) ||
      counts.discovered < 0 ||
      counts.admitted < 0 ||
      counts.suppressed < 0 ||
      counts.admitted + counts.suppressed > counts.discovered
    ) {
      throw new CliError(
        "bad_source_counts",
        "source Run counts must be non-negative and cannot account for more observations than were discovered",
        { exitCode: 2 },
      );
    }
  }

  private parseSourceWarnings(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) &&
        parsed.every((warning) => typeof warning === "string")
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  private validatedSourceWarnings(warnings: readonly string[]): string[] {
    if (warnings.length > 100) {
      throw new CliError(
        "bad_source_warnings",
        "source Run warnings exceed the 100-warning limit",
        { exitCode: 2 },
      );
    }
    return warnings.map((warning) =>
      limitCodePoints(sanitizeExternalError(warning), 500),
    );
  }

  private validatedSourceActor(value: string): string {
    const actor = String(value ?? "").trim();
    if (actor.length === 0 || actor.length > 100) {
      throw new CliError(
        "bad_source_actor",
        "source audit actor must contain 1-100 characters",
        { exitCode: 2 },
      );
    }
    return actor;
  }

  private validatedSourceReason(value: string): string {
    const reason = limitCodePoints(sanitizeExternalError(value), 500).trim();
    if (reason.length === 0) {
      throw new CliError(
        "bad_source_reason",
        "source audit reason is required",
        {
          exitCode: 2,
        },
      );
    }
    return reason;
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
}

export type { SourceManifestOverlay };
