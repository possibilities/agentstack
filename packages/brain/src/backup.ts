import { Database } from "./sqlite.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  isSafeArtifactStoragePath,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  SHA256_DIGEST_PATTERN,
} from "./artifacts.js";
import { CliError } from "./errors.js";
import { openReadonlyDatabase } from "./sqlite.js";
import { RESEARCH_SCHEMA_VERSION, type ResearchStore } from "./store.js";

const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_DATABASE_FILE = "database.sqlite";
export const BACKUP_MANIFEST_FILE = "manifest.json";

const HASH_BUFFER_BYTES = 64 * 1024;

export interface BackupArtifactReference {
  artifact_id: number;
  digest: string;
  byte_size: number;
  artifact_role: string;
  storage_path: string;
}

export interface BackupManifest {
  manifest_version: typeof BACKUP_MANIFEST_VERSION;
  kind: "agentstack_brain_backup";
  created_at: string;
  snapshot_started_at: string;
  snapshot_completed_at: string;
  schema_version: number;
  source_paths: {
    database: string;
    artifact_store: string;
  };
  database: {
    file: typeof BACKUP_DATABASE_FILE;
    sha256: string;
    byte_size: number;
  };
  required_artifact_digests: string[];
  artifact_references: BackupArtifactReference[];
  configuration: {
    sqlite_snapshot: "vacuum_into";
    artifact_addressing: "sha256";
  };
}

export interface BackupCreateResult {
  backup_path: string;
  manifest_path: string;
  database_path: string;
  created_at: string;
  schema_version: number;
  database_sha256: string;
  artifact_count: number;
}

export type BackupSchemaVersionRelationship =
  | "current"
  | "older-migratable"
  | "newer-unsupported";

export interface BackupCheck {
  name:
    | "database_digest"
    | "database_integrity"
    | "schema_version"
    | "artifact_references"
    | "artifact_bytes"
    | "fts_rebuild";
  status: "ok" | "failed";
  detail: string;
}

export interface BackupVerifyResult {
  verified: boolean;
  backup_path: string;
  created_at: string;
  schema_version: number;
  supported_schema_version: number;
  schema_version_relationship: BackupSchemaVersionRelationship;
  database_sha256: string;
  artifact_inventory_sha256: string;
  artifact_count: number;
  artifacts_checked: number;
  checks: BackupCheck[];
}

interface CreateBackupOptions {
  artifactRoot: string;
  now?: Date;
}

interface VerifyBackupOptions {
  artifactRoot?: string;
}

interface FileHash {
  sha256: string;
  byteSize: number;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writePrivateFile(path: string, content: string): void {
  const bytes = Buffer.from(content, "utf8");
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    PRIVATE_FILE_MODE,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, PRIVATE_FILE_MODE);
}

function hashRegularFile(path: string): FileHash {
  let fd: number | undefined;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("file is not a regular file");
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = statSync(path, { bigint: true });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let byteSize = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      byteSize += count;
      hash.update(buffer.subarray(0, count));
    }
    const after = statSync(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("file changed while it was being verified");
    }
    return { sha256: hash.digest("hex"), byteSize };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function snapshotMetadata(databasePath: string): {
  schemaVersion: number;
  references: BackupArtifactReference[];
} {
  const db = openReadonlyDatabase(databasePath);
  try {
    const schema = db
      .query("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string } | null;
    const schemaVersion = Number(schema?.value);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      throw new CliError(
        "backup_invalid_schema",
        "snapshot schema_version is missing or invalid",
      );
    }
    const rows = db
      .query(
        `SELECT id, content_hash, byte_size, artifact_role, storage_path
         FROM artifacts ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      content_hash: string;
      byte_size: number;
      artifact_role: string;
      storage_path: string | null;
    }>;
    const references = rows.map((row): BackupArtifactReference => {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        !SHA256_DIGEST_PATTERN.test(row.content_hash) ||
        !Number.isSafeInteger(row.byte_size) ||
        row.byte_size < 0 ||
        typeof row.artifact_role !== "string" ||
        row.artifact_role.length === 0 ||
        row.storage_path === null ||
        !isSafeArtifactStoragePath(row.storage_path, row.content_hash)
      ) {
        throw new CliError(
          "backup_invalid_artifact_reference",
          "snapshot contains an invalid Artifact reference",
        );
      }
      return {
        artifact_id: row.id,
        digest: row.content_hash,
        byte_size: row.byte_size,
        artifact_role: row.artifact_role,
        storage_path: row.storage_path,
      };
    });
    return { schemaVersion, references };
  } finally {
    db.close();
  }
}

function uniqueDigests(references: BackupArtifactReference[]): string[] {
  return [...new Set(references.map((reference) => reference.digest))].sort();
}

function verifyArtifactFiles(
  root: string,
  references: BackupArtifactReference[],
): { checked: number; failed: number } {
  const byDigest = new Map<string, BackupArtifactReference>();
  let failed = 0;
  for (const reference of references) {
    if (
      !SHA256_DIGEST_PATTERN.test(reference.digest) ||
      !isSafeArtifactStoragePath(reference.storage_path, reference.digest)
    ) {
      failed += 1;
      continue;
    }
    const existing = byDigest.get(reference.digest);
    if (existing !== undefined) {
      if (
        existing.byte_size !== reference.byte_size ||
        existing.storage_path !== reference.storage_path
      ) {
        failed += 1;
      }
      continue;
    }
    byDigest.set(reference.digest, reference);
  }
  for (const reference of byDigest.values()) {
    try {
      const actual = hashRegularFile(join(root, reference.storage_path));
      if (
        actual.sha256 !== reference.digest ||
        actual.byteSize !== reference.byte_size
      ) {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { checked: byDigest.size, failed };
}

function schemaVersionRelationship(
  schemaVersion: number,
): BackupSchemaVersionRelationship {
  if (schemaVersion === RESEARCH_SCHEMA_VERSION) return "current";
  if (schemaVersion < RESEARCH_SCHEMA_VERSION) return "older-migratable";
  return "newer-unsupported";
}

function schemaVersionCheckDetail(
  schemaVersion: number,
  relationship: BackupSchemaVersionRelationship,
): string {
  if (relationship === "current") {
    return `schema version ${schemaVersion} matches the manifest`;
  }
  if (relationship === "older-migratable") {
    return `schema version ${schemaVersion} matches the manifest and is older-migratable; supported version is ${RESEARCH_SCHEMA_VERSION}`;
  }
  return `schema version ${schemaVersion} matches the manifest but is newer-unsupported; supported version is ${RESEARCH_SCHEMA_VERSION}`;
}

/**
 * Build a private backup bundle and publish it with one directory rename. The
 * source DB remains online: ResearchStore coordinates a SQLite snapshot that
 * includes committed WAL pages without copying the live database file.
 */
export function createBackup(
  store: ResearchStore,
  destination: string,
  options: CreateBackupOptions,
): BackupCreateResult {
  const backupPath = resolve(destination);
  if (pathExists(backupPath)) {
    throw new CliError(
      "backup_exists",
      "backup destination already exists; refusing to overwrite it",
    );
  }
  const parent = dirname(backupPath);
  mkdirSync(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stagingPath = join(
    parent,
    `.${basename(backupPath)}.tmp-${randomUUID()}`,
  );
  mkdirSync(stagingPath, { mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(stagingPath, PRIVATE_DIRECTORY_MODE);
  const startedAt = (options.now ?? new Date()).toISOString();
  const stagedDatabase = join(stagingPath, BACKUP_DATABASE_FILE);
  let published = false;
  try {
    store.createConsistentSnapshot(stagedDatabase);
    chmodSync(stagedDatabase, PRIVATE_FILE_MODE);
    fsyncFile(stagedDatabase);

    const { schemaVersion, references } = snapshotMetadata(stagedDatabase);
    const artifactRoot = resolve(options.artifactRoot);
    const artifacts = verifyArtifactFiles(artifactRoot, references);
    if (artifacts.failed > 0) {
      throw new CliError(
        "backup_artifacts_unavailable",
        `${artifacts.failed} required Artifact object(s) are missing or corrupt`,
      );
    }
    const database = hashRegularFile(stagedDatabase);
    const completedAt = (options.now ?? new Date()).toISOString();
    const manifest: BackupManifest = {
      manifest_version: BACKUP_MANIFEST_VERSION,
      kind: "agentstack_brain_backup",
      created_at: completedAt,
      snapshot_started_at: startedAt,
      snapshot_completed_at: completedAt,
      schema_version: schemaVersion,
      source_paths: {
        database: resolve(store.dbPath),
        artifact_store: artifactRoot,
      },
      database: {
        file: BACKUP_DATABASE_FILE,
        sha256: database.sha256,
        byte_size: database.byteSize,
      },
      required_artifact_digests: uniqueDigests(references),
      artifact_references: references,
      configuration: {
        sqlite_snapshot: "vacuum_into",
        artifact_addressing: "sha256",
      },
    };
    writePrivateFile(
      join(stagingPath, BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    fsyncDirectory(stagingPath);
    renameSync(stagingPath, backupPath);
    published = true;
    fsyncDirectory(parent);
    return {
      backup_path: backupPath,
      manifest_path: join(backupPath, BACKUP_MANIFEST_FILE),
      database_path: join(backupPath, BACKUP_DATABASE_FILE),
      created_at: completedAt,
      schema_version: schemaVersion,
      database_sha256: database.sha256,
      artifact_count: manifest.required_artifact_digests.length,
    };
  } catch (error) {
    if (!published) rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBackupManifest(backupPath: string): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(join(backupPath, BACKUP_MANIFEST_FILE), "utf8"),
    );
  } catch {
    throw new CliError(
      "backup_manifest_invalid",
      "backup manifest is missing or is not valid JSON",
    );
  }
  if (
    !isObject(raw) ||
    raw.manifest_version !== BACKUP_MANIFEST_VERSION ||
    raw.kind !== "agentstack_brain_backup" ||
    typeof raw.created_at !== "string" ||
    !Number.isFinite(Date.parse(raw.created_at)) ||
    typeof raw.snapshot_started_at !== "string" ||
    !Number.isFinite(Date.parse(raw.snapshot_started_at)) ||
    typeof raw.snapshot_completed_at !== "string" ||
    !Number.isFinite(Date.parse(raw.snapshot_completed_at)) ||
    !Number.isSafeInteger(raw.schema_version) ||
    !isObject(raw.source_paths) ||
    typeof raw.source_paths.database !== "string" ||
    typeof raw.source_paths.artifact_store !== "string" ||
    !isObject(raw.database) ||
    raw.database.file !== BACKUP_DATABASE_FILE ||
    typeof raw.database.sha256 !== "string" ||
    !SHA256_DIGEST_PATTERN.test(raw.database.sha256) ||
    !Number.isSafeInteger(raw.database.byte_size) ||
    Number(raw.database.byte_size) < 0 ||
    !Array.isArray(raw.required_artifact_digests) ||
    !Array.isArray(raw.artifact_references) ||
    !isObject(raw.configuration) ||
    raw.configuration.sqlite_snapshot !== "vacuum_into" ||
    raw.configuration.artifact_addressing !== "sha256"
  ) {
    throw new CliError(
      "backup_manifest_invalid",
      "backup manifest does not match the supported format",
    );
  }
  const requiredArtifactDigests = raw.required_artifact_digests;
  if (
    requiredArtifactDigests.some(
      (digest) =>
        typeof digest !== "string" || !SHA256_DIGEST_PATTERN.test(digest),
    )
  ) {
    throw new CliError(
      "backup_manifest_invalid",
      "backup manifest contains an invalid required Artifact digest",
    );
  }
  const references: BackupArtifactReference[] = [];
  for (const value of raw.artifact_references) {
    if (
      !isObject(value) ||
      !Number.isSafeInteger(value.artifact_id) ||
      Number(value.artifact_id) < 1 ||
      typeof value.digest !== "string" ||
      !SHA256_DIGEST_PATTERN.test(value.digest) ||
      !Number.isSafeInteger(value.byte_size) ||
      Number(value.byte_size) < 0 ||
      typeof value.artifact_role !== "string" ||
      value.artifact_role.length === 0 ||
      typeof value.storage_path !== "string" ||
      !isSafeArtifactStoragePath(value.storage_path, value.digest)
    ) {
      throw new CliError(
        "backup_manifest_invalid",
        "backup manifest contains an invalid Artifact reference",
      );
    }
    references.push({
      artifact_id: Number(value.artifact_id),
      digest: value.digest,
      byte_size: Number(value.byte_size),
      artifact_role: value.artifact_role,
      storage_path: value.storage_path,
    });
  }
  const expectedDigests = uniqueDigests(references);
  const listedDigests = [...new Set(requiredArtifactDigests)].sort();
  if (
    listedDigests.length !== requiredArtifactDigests.length ||
    JSON.stringify(listedDigests) !== JSON.stringify(expectedDigests)
  ) {
    throw new CliError(
      "backup_manifest_invalid",
      "required Artifact digests do not match the reference manifest",
    );
  }
  return {
    manifest_version: BACKUP_MANIFEST_VERSION,
    kind: "agentstack_brain_backup",
    created_at: raw.created_at,
    snapshot_started_at: raw.snapshot_started_at,
    snapshot_completed_at: raw.snapshot_completed_at,
    schema_version: Number(raw.schema_version),
    source_paths: {
      database: raw.source_paths.database,
      artifact_store: raw.source_paths.artifact_store,
    },
    database: {
      file: BACKUP_DATABASE_FILE,
      sha256: raw.database.sha256,
      byte_size: Number(raw.database.byte_size),
    },
    required_artifact_digests: listedDigests,
    artifact_references: references,
    configuration: {
      sqlite_snapshot: "vacuum_into",
      artifact_addressing: "sha256",
    },
  };
}

function databaseArtifactReferences(db: Database): BackupArtifactReference[] {
  return (
    db
      .query(
        `SELECT id AS artifact_id, content_hash AS digest, byte_size,
                artifact_role, storage_path
         FROM artifacts ORDER BY id`,
      )
      .all() as BackupArtifactReference[]
  ).map((reference) => ({
    artifact_id: Number(reference.artifact_id),
    digest: reference.digest,
    byte_size: Number(reference.byte_size),
    artifact_role: reference.artifact_role,
    storage_path: reference.storage_path,
  }));
}

function checkFtsRebuild(db: Database): void {
  const counts = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM chunks) AS chunks,
         (SELECT COUNT(*) FROM chunks_fts) AS fts,
         (SELECT COUNT(*)
          FROM chunks c
          LEFT JOIN chunks_fts f ON f.rowid=c.id
          JOIN documents d ON d.id=c.document_id
          WHERE f.rowid IS NULL
             OR CAST(f.document_id AS INTEGER) <> c.document_id
             OR CAST(f.chunk_id AS INTEGER) <> c.id
             OR COALESCE(f.title, '') <> COALESCE(d.title, '')
             OR f.content <> c.content
             OR f.tags <> COALESCE(
                  (SELECT group_concat(j.value, ' ') FROM json_each(d.tags) j),
                  ''
                )
             OR f.source_uri <> d.source_uri) AS mismatched`,
    )
    .get() as { chunks: number; fts: number; mismatched: number };
  if (counts.chunks !== counts.fts || counts.mismatched !== 0) {
    throw new Error("stored FTS rows do not match retained indexed content");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
    db.exec("DELETE FROM chunks_fts");
    db.exec(`
      INSERT INTO chunks_fts(
        rowid, document_id, chunk_id, title, content, tags, source_uri
      )
      SELECT c.id, c.document_id, c.id, d.title, c.content,
             COALESCE(
               (SELECT group_concat(j.value, ' ') FROM json_each(d.tags) j),
               ''
             ),
             d.source_uri
      FROM chunks c
      JOIN documents d ON d.id=c.document_id
      ORDER BY c.id
    `);
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
    const rebuilt = db
      .query("SELECT COUNT(*) AS count FROM chunks_fts")
      .get() as {
      count: number;
    };
    if (rebuilt.count !== counts.chunks) {
      throw new Error("rebuilt FTS row count does not match retained chunks");
    }
  } finally {
    db.exec("ROLLBACK");
  }
}

function failedDatabaseChecks(detail: string): BackupCheck[] {
  return [
    { name: "database_integrity", status: "failed", detail },
    { name: "schema_version", status: "failed", detail },
    { name: "artifact_references", status: "failed", detail },
    { name: "fts_rebuild", status: "failed", detail },
  ];
}

/**
 * Verify a restore without ever opening the backup's source database through
 * SQLite. The database bytes are copied to a private temporary directory; all
 * integrity and destructive FTS rebuild checks run only on that isolated copy.
 */
export function verifyBackup(
  backup: string,
  options: VerifyBackupOptions = {},
): BackupVerifyResult {
  const backupPath = resolve(backup);
  const manifest = readBackupManifest(backupPath);
  const relationship = schemaVersionRelationship(manifest.schema_version);
  const sourceDatabase = join(backupPath, manifest.database.file);
  const checks: BackupCheck[] = [];
  let sourceHash: FileHash | undefined;
  try {
    sourceHash = hashRegularFile(sourceDatabase);
  } catch {
    // Report a verification defect rather than turning expected corruption into
    // an unstructured CLI failure.
  }
  const digestOk =
    sourceHash !== undefined &&
    sourceHash.sha256 === manifest.database.sha256 &&
    sourceHash.byteSize === manifest.database.byte_size;
  checks.push({
    name: "database_digest",
    status: digestOk ? "ok" : "failed",
    detail: digestOk
      ? "database bytes match the manifest"
      : "database bytes are missing, changed, or corrupt",
  });

  const temporary = mkdtempSync(join(tmpdir(), "agentstack-brain-backup-verify-"));
  chmodSync(temporary, PRIVATE_DIRECTORY_MODE);
  const restoredDatabase = join(temporary, BACKUP_DATABASE_FILE);
  try {
    if (sourceHash === undefined) {
      checks.push(...failedDatabaseChecks("restored database is unavailable"));
    } else {
      try {
        copyFileSync(sourceDatabase, restoredDatabase, constants.COPYFILE_EXCL);
        chmodSync(restoredDatabase, PRIVATE_FILE_MODE);
        const restoredHash = hashRegularFile(restoredDatabase);
        if (
          restoredHash.sha256 !== manifest.database.sha256 ||
          restoredHash.byteSize !== manifest.database.byte_size
        ) {
          throw new Error("isolated restore does not match the manifest");
        }
        const db = new Database(restoredDatabase, { strict: true });
        try {
          let integrityOk = false;
          try {
            const rows = db.query("PRAGMA integrity_check").all() as Array<{
              integrity_check: string;
            }>;
            integrityOk =
              rows.length === 1 && rows[0]?.integrity_check === "ok";
          } catch {
            integrityOk = false;
          }
          checks.push({
            name: "database_integrity",
            status: integrityOk ? "ok" : "failed",
            detail: integrityOk
              ? "SQLite integrity_check returned ok"
              : "SQLite integrity_check failed",
          });

          let schemaVersion: number | undefined;
          try {
            const row = db
              .query("SELECT value FROM meta WHERE key='schema_version'")
              .get() as { value: string } | null;
            schemaVersion = Number(row?.value);
          } catch {
            schemaVersion = undefined;
          }
          const schemaMatchesManifest =
            Number.isSafeInteger(schemaVersion) &&
            schemaVersion === manifest.schema_version;
          const schemaOk =
            schemaMatchesManifest && relationship !== "newer-unsupported";
          const schemaDetail = schemaMatchesManifest
            ? schemaVersionCheckDetail(manifest.schema_version, relationship)
            : "restored schema version does not match the manifest";
          checks.push({
            name: "schema_version",
            status: schemaOk ? "ok" : "failed",
            detail: schemaDetail,
          });

          let referencesOk = false;
          try {
            const actual = databaseArtifactReferences(db);
            referencesOk =
              JSON.stringify(actual) ===
                JSON.stringify(manifest.artifact_references) &&
              JSON.stringify(uniqueDigests(actual)) ===
                JSON.stringify(manifest.required_artifact_digests);
          } catch {
            referencesOk = false;
          }
          checks.push({
            name: "artifact_references",
            status: referencesOk ? "ok" : "failed",
            detail: referencesOk
              ? `${manifest.artifact_references.length} Artifact reference(s) match the manifest`
              : "restored Artifact references do not match the manifest",
          });

          let ftsOk = false;
          try {
            checkFtsRebuild(db);
            ftsOk = true;
          } catch {
            ftsOk = false;
          }
          checks.push({
            name: "fts_rebuild",
            status: ftsOk ? "ok" : "failed",
            detail: ftsOk
              ? "FTS integrity and isolated rebuild checks passed"
              : "FTS cannot be verified and rebuilt from retained indexed content",
          });
        } finally {
          db.close();
        }
      } catch {
        checks.push(
          ...failedDatabaseChecks(
            "isolated database restore could not be opened",
          ),
        );
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const artifactRoot = resolve(
    options.artifactRoot ?? manifest.source_paths.artifact_store,
  );
  const artifacts = verifyArtifactFiles(
    artifactRoot,
    manifest.artifact_references,
  );
  checks.push({
    name: "artifact_bytes",
    status: artifacts.failed === 0 ? "ok" : "failed",
    detail:
      artifacts.failed === 0
        ? `${artifacts.checked} required Artifact object(s) passed digest verification`
        : `${artifacts.failed} required Artifact object(s) are missing, invalid, or corrupt`,
  });

  return {
    verified: checks.every((check) => check.status === "ok"),
    backup_path: backupPath,
    created_at: manifest.created_at,
    schema_version: manifest.schema_version,
    supported_schema_version: RESEARCH_SCHEMA_VERSION,
    schema_version_relationship: relationship,
    database_sha256: manifest.database.sha256,
    artifact_inventory_sha256: createHash("sha256")
      .update(`${manifest.required_artifact_digests.join("\n")}\n`)
      .digest("hex"),
    artifact_count: manifest.required_artifact_digests.length,
    artifacts_checked: artifacts.checked,
    checks,
  };
}
