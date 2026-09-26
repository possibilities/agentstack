import { Database } from "../src/sqlite.js";
import { afterEach, test } from "node:test";
import { expect } from "expect";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts.js";
import {
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  type BackupManifest,
  createBackup,
  verifyBackup,
} from "../src/backup.js";
import { ResearchCache } from "../src/db.js";
import { CliError } from "../src/errors.js";
import { RESEARCH_SCHEMA_VERSION, ResearchStore } from "../src/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-backup-test-"));
  roots.push(root);
  return root;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function check(
  result: ReturnType<typeof verifyBackup>,
  name: ReturnType<typeof verifyBackup>["checks"][number]["name"],
): string {
  return (
    result.checks.find((entry) => entry.name === name)?.status ?? "missing"
  );
}

function checkDetail(
  result: ReturnType<typeof verifyBackup>,
  name: ReturnType<typeof verifyBackup>["checks"][number]["name"],
): string {
  return result.checks.find((entry) => entry.name === name)?.detail ?? "";
}

function fileDigest(path: string): { sha256: string; byteSize: number } {
  const content = readFileSync(path);
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    byteSize: content.byteLength,
  };
}

function createBackupFixtureWithSchemaVersion(
  root: string,
  schemaVersion: number,
): { backupPath: string; artifactRoot: string } {
  const artifactRoot = join(root, `artifacts-${schemaVersion}`);
  const store = new ResearchStore(join(root, `research-${schemaVersion}.db`));
  store.upsertDocument({
    sourceType: "text",
    sourceUri: `schema-version:${schemaVersion}`,
    title: `Schema ${schemaVersion}`,
    content: `searchable content for schema version ${schemaVersion}`,
  });
  const backupPath = join(root, `backup-${schemaVersion}`);
  createBackup(store, backupPath, {
    artifactRoot,
    now: new Date("2026-07-18T12:00:00.000Z"),
  });
  store.close();

  const databasePath = join(backupPath, BACKUP_DATABASE_FILE);
  const db = new Database(databasePath);
  db.exec("PRAGMA journal_mode=DELETE");
  db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
    String(schemaVersion),
  );
  db.close();

  const manifestPath = join(backupPath, BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as BackupManifest;
  const database = fileDigest(databasePath);
  manifest.schema_version = schemaVersion;
  manifest.database.sha256 = database.sha256;
  manifest.database.byte_size = database.byteSize;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { backupPath, artifactRoot };
}

function createLegacyV1Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE documents (
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
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_char INTEGER NOT NULL,
      content TEXT NOT NULL,
      UNIQUE(document_id, chunk_index)
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      document_id UNINDEXED,
      chunk_id UNINDEXED,
      title,
      content,
      tags,
      source_uri,
      tokenize='porter unicode61 remove_diacritics 2'
    );
    INSERT INTO documents VALUES (
      1,
      'text',
      'legacy:v1',
      'Legacy v1',
      '[]',
      '',
      'legacy searchable body',
      'legacy-hash',
      22,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO chunks VALUES (1, 1, 0, 0, 22, 'legacy searchable body');
    INSERT INTO chunks_fts(
      rowid,
      document_id,
      chunk_id,
      title,
      content,
      tags,
      source_uri
    ) VALUES (1, 1, 1, 'Legacy v1', 'legacy searchable body', '', 'legacy:v1');
  `);
  db.close();
}

test("a WAL snapshot includes committed writes while an older reader stays active", () => {
  const root = temporaryRoot();
  const dbPath = join(root, "research.db");
  const store = new ResearchStore(dbPath);
  store.upsertDocument({
    sourceType: "text",
    sourceUri: "snapshot:first",
    content: "first committed document",
  });

  const reader = new Database(dbPath, { readonly: true });
  reader.exec("BEGIN");
  expect(reader.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual(
    { count: 1 },
  );

  store.upsertDocument({
    sourceType: "text",
    sourceUri: "snapshot:second",
    content: "second committed document from WAL",
  });
  const backupPath = join(root, "backup");
  createBackup(store, backupPath, {
    artifactRoot: join(root, "artifacts"),
    now: new Date("2026-07-18T12:00:00.000Z"),
  });

  // The pre-existing reader remains usable and keeps its old SQLite snapshot.
  expect(reader.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual(
    { count: 1 },
  );
  reader.exec("ROLLBACK");
  reader.close();

  store.upsertDocument({
    sourceType: "text",
    sourceUri: "snapshot:after",
    content: "committed after the backup boundary",
  });
  store.close();

  const restored = new Database(join(backupPath, BACKUP_DATABASE_FILE), {
    readonly: true,
  });
  expect(
    restored.query("SELECT source_uri FROM documents ORDER BY id").all(),
  ).toEqual([
    { source_uri: "snapshot:first" },
    { source_uri: "snapshot:second" },
  ]);
  expect(restored.query("PRAGMA integrity_check").get()).toEqual({
    integrity_check: "ok",
  });
  restored.close();

  const verified = verifyBackup(backupPath, {
    artifactRoot: join(root, "artifacts"),
  });
  expect(verified.verified).toBe(true);
  expect(verified.checks.every((entry) => entry.status === "ok")).toBe(true);
  expect(mode(backupPath)).toBe(0o700);
  expect(mode(join(backupPath, BACKUP_DATABASE_FILE))).toBe(0o600);
  expect(mode(join(backupPath, BACKUP_MANIFEST_FILE))).toBe(0o600);
});

test("manifest records schema, paths, and Artifact references without content", () => {
  const root = temporaryRoot();
  const dbPath = join(root, "research.db");
  const artifactRoot = join(root, "artifacts");
  const artifacts = new ArtifactStore(artifactRoot);
  const stored = artifacts.captureBytes("PRIVATE ARTIFACT BODY");
  const store = new ResearchStore(dbPath);
  store.upsertDocument({
    sourceType: "url",
    sourceUri: "https://example.test/private?token=DO-NOT-LEAK",
    title: "SECRET TITLE",
    content: "PRIVATE DOCUMENT BODY",
  });
  store.registerStoredArtifact(stored, {
    mediaType: "text/markdown",
    artifactRole: "normalized_markdown",
  });

  const backupPath = join(root, "backup");
  const result = createBackup(store, backupPath, {
    artifactRoot,
    now: new Date("2026-07-18T12:34:56.000Z"),
  });
  store.close();

  const manifestText = readFileSync(result.manifest_path, "utf8");
  const manifest = JSON.parse(manifestText) as BackupManifest;
  expect(manifest).toMatchObject({
    manifest_version: 1,
    kind: "agentstack_brain_backup",
    created_at: "2026-07-18T12:34:56.000Z",
    schema_version: RESEARCH_SCHEMA_VERSION,
    source_paths: { database: dbPath, artifact_store: artifactRoot },
    configuration: {
      sqlite_snapshot: "vacuum_into",
      artifact_addressing: "sha256",
    },
  });
  expect(manifest.required_artifact_digests).toEqual([stored.contentDigest]);
  expect(manifest.artifact_references).toEqual([
    expect.objectContaining({
      digest: stored.contentDigest,
      byte_size: stored.byteSize,
      artifact_role: "normalized_markdown",
      storage_path: stored.storagePath,
    }),
  ]);
  expect(manifestText).not.toContain("PRIVATE ARTIFACT BODY");
  expect(manifestText).not.toContain("PRIVATE DOCUMENT BODY");
  expect(manifestText).not.toContain("SECRET TITLE");
  expect(manifestText).not.toContain("DO-NOT-LEAK");
  expect(verifyBackup(backupPath).verified).toBe(true);
});

test("verification reports schema version relationships", () => {
  const root = temporaryRoot();
  const supportedSchemaVersion = RESEARCH_SCHEMA_VERSION;
  const olderSchemaVersion = 6;
  const newerSchemaVersion = supportedSchemaVersion + 1;

  const currentFixture = createBackupFixtureWithSchemaVersion(
    root,
    supportedSchemaVersion,
  );
  const current = verifyBackup(currentFixture.backupPath, {
    artifactRoot: currentFixture.artifactRoot,
  });
  expect(current.verified).toBe(true);
  expect(current.schema_version).toBe(supportedSchemaVersion);
  expect(current.supported_schema_version).toBe(supportedSchemaVersion);
  expect(current.schema_version_relationship).toBe("current");
  expect(check(current, "schema_version")).toBe("ok");
  expect(checkDetail(current, "schema_version")).toBe(
    `schema version ${supportedSchemaVersion} matches the manifest`,
  );

  const olderFixture = createBackupFixtureWithSchemaVersion(
    root,
    olderSchemaVersion,
  );
  const older = verifyBackup(olderFixture.backupPath, {
    artifactRoot: olderFixture.artifactRoot,
  });
  expect(older.verified).toBe(true);
  expect(older.schema_version).toBe(olderSchemaVersion);
  expect(older.supported_schema_version).toBe(supportedSchemaVersion);
  expect(older.schema_version_relationship).toBe("older-migratable");
  expect(check(older, "schema_version")).toBe("ok");
  expect(checkDetail(older, "schema_version")).toContain("older-migratable");

  const newerFixture = createBackupFixtureWithSchemaVersion(
    root,
    newerSchemaVersion,
  );
  const newer = verifyBackup(newerFixture.backupPath, {
    artifactRoot: newerFixture.artifactRoot,
  });
  expect(newer.verified).toBe(false);
  expect(newer.schema_version).toBe(newerSchemaVersion);
  expect(newer.supported_schema_version).toBe(supportedSchemaVersion);
  expect(newer.schema_version_relationship).toBe("newer-unsupported");
  expect(check(newer, "schema_version")).toBe("failed");
  expect(checkDetail(newer, "schema_version")).toContain("newer-unsupported");
});

test("read-only cache rejects older schema versions with a structured error", () => {
  const root = temporaryRoot();
  const databasePath = join(root, "legacy-v1.db");
  createLegacyV1Database(databasePath);

  let error: unknown;
  try {
    new ResearchCache(databasePath).close();
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("unsupported_schema_version");
  expect((error as Error).message).toContain(
    `research cache schema version 1 is older than supported version ${RESEARCH_SCHEMA_VERSION}`,
  );
});

test("verification detects changed DB bytes, Artifact bytes, and references", () => {
  const root = temporaryRoot();
  const artifactRoot = join(root, "artifacts");
  const artifacts = new ArtifactStore(artifactRoot);
  const stored = artifacts.captureBytes("artifact evidence");
  const store = new ResearchStore(join(root, "research.db"));
  store.upsertDocument({
    sourceType: "text",
    sourceUri: "verify:one",
    content: "searchable retained content",
  });
  store.registerStoredArtifact(stored, {
    mediaType: "text/markdown",
    artifactRole: "normalized_markdown",
  });
  const backupPath = join(root, "backup");
  createBackup(store, backupPath, { artifactRoot });
  store.close();

  const databasePath = join(backupPath, BACKUP_DATABASE_FILE);
  const originalDatabase = readFileSync(databasePath);
  const changedDatabase = Buffer.from(originalDatabase);
  changedDatabase[0] = (changedDatabase[0] ?? 0) ^ 0xff;
  writeFileSync(databasePath, changedDatabase);
  const corruptDatabase = verifyBackup(backupPath, { artifactRoot });
  expect(corruptDatabase.verified).toBe(false);
  expect(check(corruptDatabase, "database_digest")).toBe("failed");
  writeFileSync(databasePath, originalDatabase);
  chmodSync(databasePath, 0o600);

  const artifactPath = artifacts.pathFor(stored.contentDigest);
  writeFileSync(artifactPath, "corrupt evidence");
  const corruptArtifact = verifyBackup(backupPath, { artifactRoot });
  expect(corruptArtifact.verified).toBe(false);
  expect(check(corruptArtifact, "artifact_bytes")).toBe("failed");
  writeFileSync(artifactPath, "artifact evidence");

  const manifestPath = join(backupPath, BACKUP_MANIFEST_FILE);
  const originalManifest = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(originalManifest) as BackupManifest;
  const reference = manifest.artifact_references[0];
  if (reference === undefined)
    throw new Error("fixture manifest has no artifact reference");
  reference.artifact_role = "wrong_role";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const changedReferences = verifyBackup(backupPath, { artifactRoot });
  expect(changedReferences.verified).toBe(false);
  expect(check(changedReferences, "artifact_references")).toBe("failed");
});

test("verification rejects an FTS index that cannot pass an isolated rebuild", () => {
  const root = temporaryRoot();
  const store = new ResearchStore(join(root, "research.db"));
  store.upsertDocument({
    sourceType: "text",
    sourceUri: "fts:one",
    title: "FTS restore",
    content: "retained words for rebuilding",
    tags: ["restore"],
  });
  store.db.exec(`
    DROP TABLE chunks_fts;
    CREATE TABLE chunks_fts (
      document_id INTEGER,
      chunk_id INTEGER,
      title TEXT,
      content TEXT,
      tags TEXT,
      source_uri TEXT
    );
    INSERT INTO chunks_fts(document_id, chunk_id, title, content, tags, source_uri)
    SELECT c.document_id, c.id, d.title, c.content, 'restore', d.source_uri
    FROM chunks c JOIN documents d ON d.id=c.document_id;
  `);
  const backupPath = join(root, "backup");
  createBackup(store, backupPath, {
    artifactRoot: join(root, "artifacts"),
  });
  store.close();

  const result = verifyBackup(backupPath, {
    artifactRoot: join(root, "artifacts"),
  });
  expect(result.verified).toBe(false);
  expect(check(result, "database_integrity")).toBe("ok");
  expect(check(result, "fts_rebuild")).toBe("failed");
});

test("failed creation cleans staging and never overwrites a good backup", () => {
  const root = temporaryRoot();
  const store = new ResearchStore(join(root, "research.db"));
  store.upsertDocument({
    sourceType: "text",
    sourceUri: "atomic:one",
    content: "known good snapshot",
  });
  const artifactRoot = join(root, "artifacts");
  const goodBackup = join(root, "good");
  createBackup(store, goodBackup, { artifactRoot });
  const goodManifest = readFileSync(
    join(goodBackup, BACKUP_MANIFEST_FILE),
    "utf8",
  );
  expect(() => createBackup(store, goodBackup, { artifactRoot })).toThrow(
    "refusing to overwrite",
  );
  expect(readFileSync(join(goodBackup, BACKUP_MANIFEST_FILE), "utf8")).toBe(
    goodManifest,
  );
  expect(verifyBackup(goodBackup, { artifactRoot }).verified).toBe(true);

  const interrupted = join(root, "interrupted");
  store.createConsistentSnapshot = (destinationPath: string) => {
    writeFileSync(destinationPath, "partial");
    throw new Error("simulated interruption");
  };
  expect(() => createBackup(store, interrupted, { artifactRoot })).toThrow(
    "simulated interruption",
  );
  expect(existsSync(interrupted)).toBe(false);
  expect(
    readdirSync(root).some((name) => name.startsWith(".interrupted.tmp-")),
  ).toBe(false);
  store.close();
});
