import { afterEach, test } from "node:test";
import { expect } from "expect";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactStore,
  ArtifactStoreError,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from "../src/artifacts.js";
import { sanitizeArtifactError } from "../src/sanitize.js";
import { ResearchStore } from "../src/store.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-artifact-test-"));
  temporaryRoots.push(root);
  return root;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function resource(
  store: ResearchStore,
  key: string,
  sensitivity = "normal",
): number {
  const now = "2026-07-18T00:00:00.000Z";
  return Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, sensitivity, created_at, updated_at
         ) VALUES ('test', ?, 'file', ?, ?, ?)`,
      )
      .run(key, sensitivity, now, now).lastInsertRowid,
  );
}

test("promotion uses a known SHA-256 address, atomically deduplicates, and is private", () => {
  const root = temporaryRoot();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const first = artifacts.stageBytes("abc");
  const second = artifacts.stageBytes("abc");

  // Independently known SHA-256("abc"), not computed through production code.
  const expected =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  expect(first).toMatchObject({ contentDigest: expected, byteSize: 3 });
  const promotedFirst = artifacts.promote(first);
  const firstInode = statSync(artifacts.pathFor(expected)).ino;
  const promotedSecond = artifacts.promote(second);

  expect(promotedFirst).toEqual(promotedSecond);
  expect(promotedFirst.storagePath).toBe(`sha256/ba/78/${expected}`);
  expect(statSync(artifacts.pathFor(expected)).ino).toBe(firstInode);
  expect(readFileSync(artifacts.pathFor(expected), "utf8")).toBe("abc");
  expect(readdirSync(artifacts.stagingRoot)).toEqual([]);
  expect(mode(artifacts.root)).toBe(PRIVATE_DIRECTORY_MODE);
  expect(mode(artifacts.stagingRoot)).toBe(PRIVATE_DIRECTORY_MODE);
  expect(mode(artifacts.objectsRoot)).toBe(PRIVATE_DIRECTORY_MODE);
  expect(mode(join(artifacts.objectsRoot, "ba"))).toBe(PRIVATE_DIRECTORY_MODE);
  expect(mode(artifacts.pathFor(expected))).toBe(PRIVATE_FILE_MODE);
});

test("digest mismatch and a changed staged file never promote bytes", () => {
  const artifacts = new ArtifactStore(join(temporaryRoot(), "artifacts"));
  const wrongDigest = "0".repeat(64);
  expect(() =>
    artifacts.stageBytes("abc", { expectedDigest: wrongDigest }),
  ).toThrow(ArtifactStoreError);
  expect(() => artifacts.stageBytes("abc", { maxBytes: 2 })).toThrow(
    "exceeds the byte limit",
  );
  expect(() =>
    artifacts.stageBytes("abc", { expectedDigest: "not-a-digest" }),
  ).toThrow("invalid SHA-256");
  expect(readdirSync(artifacts.stagingRoot)).toEqual([]);
  expect(existsSync(artifacts.pathFor(wrongDigest))).toBe(false);

  const staged = artifacts.stageBytes("abc");
  writeFileSync(join(artifacts.stagingRoot, staged.stagingId), "tampered", {
    mode: PRIVATE_FILE_MODE,
  });
  expect(() => artifacts.promote(staged)).toThrow(
    "changed before verification",
  );
  expect(existsSync(artifacts.pathFor(staged.contentDigest))).toBe(false);
});

test("a local-file intent retains an immutable snapshot after its source changes", () => {
  const root = temporaryRoot();
  const source = join(root, "private-source.md");
  writeFileSync(source, "hello", { mode: PRIVATE_FILE_MODE });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const snapshot = artifacts.snapshotLocalFile(source, {
    mediaType: "text/markdown",
    now: new Date("2026-07-18T12:00:00.000Z"),
  });
  // Independently known SHA-256("hello").
  expect(snapshot.contentDigest).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );

  writeFileSync(source, "replacement");
  unlinkSync(source);
  expect(artifacts.readUtf8(snapshot.contentDigest)).toBe("hello");

  const store = new ResearchStore(join(root, "research.db"));
  const resourceId = resource(store, "local-1", "private");
  const admitted = store.enqueueLocalFileSnapshot({
    idempotencyKey: "local-file-1",
    snapshot,
    artifactStore: artifacts,
    resourceId,
    sensitivity: "normal",
    now: new Date("2026-07-18T12:00:01.000Z"),
  });
  expect(admitted.created).toBe(true);
  expect(admitted.artifact.sensitivity).toBe("private");
  const intent = JSON.parse(admitted.job.intent ?? "null") as Record<
    string,
    unknown
  >;
  expect(intent).toEqual({
    artifact_id: admitted.artifact.id,
    content_digest: snapshot.contentDigest,
    byte_size: 5,
    media_type: "text/markdown",
    artifact_role: "original",
  });
  expect(admitted.job.intent).not.toContain(root);
  expect(admitted.job.intent).not.toContain("private-source.md");
  store.close();
});

test("local snapshots reject symlinks without leaking the private path", () => {
  const root = temporaryRoot();
  const target = join(root, "secret.txt");
  const link = join(root, "link.txt");
  writeFileSync(target, "secret");
  symlinkSync(target, link);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  expect(() => artifacts.snapshotLocalFile(link)).toThrow("not a symlink");
  const diagnostic = sanitizeArtifactError(
    new Error(`could not read ${target}: token=super-secret`),
    [root],
  );
  expect(diagnostic).not.toContain(root);
  expect(diagnostic).not.toContain("super-secret");
  expect(diagnostic).toContain("[PRIVATE_PATH]");
});

test("typed registration keeps Resources separate and records derivation", () => {
  const root = temporaryRoot();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const stored = artifacts.captureBytes("hello");
  const store = new ResearchStore(join(root, "research.db"));
  const firstResource = resource(store, "resource-a");
  const secondResource = resource(store, "resource-b", "sensitive");

  const first = store.registerStoredArtifact(stored, {
    mediaType: "text/plain",
    artifactRole: "original",
    resourceId: firstResource,
    sensitivity: "public",
  });
  const second = store.registerStoredArtifact(stored, {
    mediaType: "text/plain",
    artifactRole: "original",
    resourceId: secondResource,
    sensitivity: "normal",
  });
  expect(second.artifact.id).toBe(first.artifact.id);
  expect(second.artifact.sensitivity).toBe("sensitive");
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 1 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resource_artifacts").get(),
  ).toEqual({ count: 2 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resources").get(),
  ).toEqual({ count: 2 });

  const normalized = store.registerStoredArtifact(stored, {
    mediaType: "text/markdown",
    artifactRole: "normalized_markdown",
    resourceId: firstResource,
    derivedFromArtifactId: first.artifact.id,
    derivationType: "text_normalization",
  });
  expect(normalized.derivationCreated).toBe(true);
  expect(
    store.db
      .query(
        `SELECT artifact_id, parent_artifact_id, derivation_type
         FROM artifact_derivations`,
      )
      .get(),
  ).toEqual({
    artifact_id: normalized.artifact.id,
    parent_artifact_id: first.artifact.id,
    derivation_type: "text_normalization",
  });

  const withProvenance = {
    mediaType: "text/plain",
    artifactRole: "original",
    resourceId: firstResource,
    provenance: {
      evidenceType: "local_snapshot",
      ingress: "test",
      rawMetadata: { stable: true },
    },
  } as const;
  store.registerStoredArtifact(stored, withProvenance);
  store.registerStoredArtifact(stored, withProvenance);
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM provenance").get(),
  ).toEqual({ count: 1 });
  expect(store.reconcileArtifactStore(artifacts).promotedOrphans).toEqual([]);
  store.close();
});

test("normalized Artifact bytes rebuild indexed content fully offline", () => {
  const root = temporaryRoot();
  const source = join(root, "gone.md");
  writeFileSync(source, "hello");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const snapshot = artifacts.snapshotLocalFile(source, {
    mediaType: "text/markdown",
  });
  unlinkSync(source);

  const store = new ResearchStore(join(root, "research.db"));
  const registered = store.registerStoredArtifact(snapshot, {
    mediaType: "text/markdown",
    artifactRole: "normalized_markdown",
  });
  const rebuilt = store.rebuildDocumentFromArtifact({
    artifactId: registered.artifact.id,
    artifactStore: artifacts,
    title: "Offline",
  });
  expect(rebuilt.status).toBe("created");
  expect(
    store.db
      .query("SELECT content FROM documents WHERE id=?")
      .get(rebuilt.document_id),
  ).toEqual({ content: "hello" });
  expect(
    store.db
      .query("SELECT content FROM chunks_fts WHERE document_id=?")
      .get(rebuilt.document_id),
  ).toEqual({ content: "hello" });
  store.close();
});

test("reconciliation reports and safely repairs stale staging, orphans, and modes", () => {
  const root = temporaryRoot();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const interrupted = artifacts.stageBytes("interrupted");
  const stagingPath = join(artifacts.stagingRoot, interrupted.stagingId);
  const orphan = artifacts.captureBytes("abc");
  const old = new Date("2026-07-01T00:00:00.000Z");
  utimesSync(stagingPath, old, old);
  utimesSync(artifacts.pathFor(orphan.contentDigest), old, old);
  chmodSync(stagingPath, 0o644);
  chmodSync(artifacts.pathFor(orphan.contentDigest), 0o644);

  const report = artifacts.reconcile([], {
    now: new Date("2026-07-18T00:00:00.000Z"),
    staleStagingAgeMs: 1_000,
    repairPermissions: true,
  });
  expect(report.staleStaging).toEqual([
    expect.objectContaining({ id: interrupted.stagingId, removed: false }),
  ]);
  expect(report.promotedOrphans).toEqual([
    expect.objectContaining({ id: orphan.contentDigest, removed: false }),
  ]);
  expect(report.permissionDrift).toHaveLength(2);
  expect(report.permissionDrift.every((entry) => entry.repaired)).toBe(true);
  expect(mode(stagingPath)).toBe(PRIVATE_FILE_MODE);
  expect(mode(artifacts.pathFor(orphan.contentDigest))).toBe(PRIVATE_FILE_MODE);

  expect(() => artifacts.reconcile([], { deleteOrphans: true })).toThrow(
    "orphanRetentionMs is required",
  );
  const cleaned = artifacts.reconcile([], {
    now: new Date("2026-07-18T00:00:00.000Z"),
    staleStagingAgeMs: 1_000,
    deleteStaleStaging: true,
    deleteOrphans: true,
    orphanRetentionMs: 1_000,
  });
  expect(cleaned.staleStaging[0]?.removed).toBe(true);
  expect(cleaned.promotedOrphans[0]?.removed).toBe(true);
  expect(lstatSync(artifacts.root).isDirectory()).toBe(true);
  expect(existsSync(stagingPath)).toBe(false);
  expect(existsSync(artifacts.pathFor(orphan.contentDigest))).toBe(false);
});

test("reconciliation never deletes an orphan whose bytes mismatch its address", () => {
  const artifacts = new ArtifactStore(join(temporaryRoot(), "artifacts"));
  const stored = artifacts.captureBytes("abc");
  writeFileSync(artifacts.pathFor(stored.contentDigest), "corrupt");
  const report = artifacts.reconcile([], {
    deleteOrphans: true,
    orphanRetentionMs: 0,
    verifyPromoted: true,
  });
  expect(report.integrityDefects).toEqual([
    {
      digest: stored.contentDigest,
      code: "digest_mismatch",
      detail: "content-addressed Artifact failed SHA-256 verification",
    },
  ]);
  expect(report.promotedOrphans[0]?.removed).toBe(false);
  expect(existsSync(artifacts.pathFor(stored.contentDigest))).toBe(true);
});

test("re-promoting identical content leaves the stored Artifact untouched", () => {
  const root = temporaryRoot();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const first = artifacts.captureBytes("identical content");
  const path = join(root, "artifacts", first.storagePath);
  const before = statSync(path, { bigint: true });

  // Content addressing means a second capture of the same bytes resolves to
  // this same inode. Promotion must not rewrite metadata it does not need to:
  // a gratuitous chmod moves ctime, and a concurrent promotion reading this
  // inode watches ctime to decide whether the file changed while it was being
  // verified. It would see a change nobody made and fail a correct submission.
  const second = artifacts.captureBytes("identical content");
  const after = statSync(path, { bigint: true });

  expect(second.contentDigest).toBe(first.contentDigest);
  expect(second.storagePath).toBe(first.storagePath);
  expect(after.ino).toBe(before.ino);
  expect(after.ctimeNs).toBe(before.ctimeNs);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(statSync(path).mode & 0o777).toBe(PRIVATE_FILE_MODE);
});

test("promotion still repairs a stored Artifact whose mode drifted", () => {
  const root = temporaryRoot();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const stored = artifacts.captureBytes("drifting content");
  const path = join(root, "artifacts", stored.storagePath);
  chmodSync(path, 0o644);

  // Skipping the redundant chmod must not become skipping a needed one.
  artifacts.captureBytes("drifting content");
  expect(statSync(path).mode & 0o777).toBe(PRIVATE_FILE_MODE);
});
