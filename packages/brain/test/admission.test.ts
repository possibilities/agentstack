import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitSubmission,
  indexedDocumentForUrl,
  waitForAdmission,
} from "../src/admission.js";
import { ArtifactStore } from "../src/artifacts.js";
import { ResearchStore } from "../src/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): {
  root: string;
  store: ResearchStore;
  artifacts: ArtifactStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-admission-"));
  roots.push(root);
  return {
    root,
    store: new ResearchStore(join(root, "research.db")),
    artifacts: new ArtifactStore(join(root, "artifacts")),
  };
}

test("text admission returns exact queued and duplicate identities without indexing", () => {
  const { store, artifacts } = fixture();
  const intent = {
    version: 1,
    source: "hello",
    kind: "text",
    ingress: "cli",
    idempotencyKey: "hello-once",
  } as const;
  const queued = admitSubmission(store, intent, { artifactStore: artifacts });
  expect(queued).toEqual({
    version: 1,
    status: "queued",
    job_id: 1,
    idempotency_key: "hello-once",
    intent_hash:
      "09b1123940451be8d7b8983172e67b1b2fcf852f4b87f1a7a2a9e5ed748ca64a",
    state: "queued",
  });
  expect(admitSubmission(store, intent, { artifactStore: artifacts })).toEqual({
    ...queued,
    status: "duplicate",
  });
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 1 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("explicit idempotency reuse with changed intent is rejected", () => {
  const { store, artifacts } = fixture();
  admitSubmission(
    store,
    {
      version: 1,
      source: "first",
      kind: "text",
      ingress: "cli",
      idempotencyKey: "same-key",
    },
    { artifactStore: artifacts },
  );
  expect(() =>
    admitSubmission(
      store,
      {
        version: 1,
        source: "second",
        kind: "text",
        ingress: "cli",
        idempotencyKey: "same-key",
      },
      { artifactStore: artifacts },
    ),
  ).toThrow("idempotency_key already belongs to a different intent");
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 1 });
  store.close();
});

test("structurally invalid intent creates no job or Artifact metadata", () => {
  const { store, artifacts } = fixture();
  expect(() =>
    admitSubmission(
      store,
      {
        version: 2 as 1,
        source: "hello",
        kind: "text",
        ingress: "cli",
      },
      { artifactStore: artifacts },
    ),
  ).toThrow("submission version must be 1");
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("file admission snapshots immutable bytes and stores no local path", () => {
  const { root, store, artifacts } = fixture();
  const source = join(root, "private-note.md");
  writeFileSync(source, "hello");
  const result = admitSubmission(
    store,
    {
      version: 1,
      source,
      kind: "file",
      ingress: "cli",
      skipSecrets: false,
    },
    { artifactStore: artifacts },
  );
  writeFileSync(source, "changed");
  expect(
    artifacts.readUtf8(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    ),
  ).toBe("hello");
  const row = store.db
    .query("SELECT intent FROM jobs WHERE id=?")
    .get(result.job_id) as { intent: string };
  expect(row.intent).not.toContain(root);
  expect(row.intent).not.toContain("private-note.md");
  expect(row.intent).toContain(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("directory admission snapshots supported files without parsing them", () => {
  const { root, store, artifacts } = fixture();
  const directory = join(root, "notes");
  mkdirSync(directory);
  writeFileSync(join(directory, "b.md"), "second");
  writeFileSync(join(directory, "a.txt"), "first");
  writeFileSync(join(directory, "ignored.bin"), "ignored");
  const result = admitSubmission(
    store,
    {
      version: 1,
      source: directory,
      kind: "directory",
      ingress: "cli",
    },
    { artifactStore: artifacts },
  );
  expect(result).toMatchObject({ status: "queued", job_id: 1 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 2 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  const row = store.db.query("SELECT intent FROM jobs").get() as {
    intent: string;
  };
  const intent = JSON.parse(row.intent);
  expect(intent.payload.directory.artifacts).toHaveLength(2);
  expect(row.intent).not.toContain(directory);
  store.close();
});

test("wait timeout observes the same active job", async () => {
  const { store, artifacts } = fixture();
  const queued = admitSubmission(
    store,
    { version: 1, source: "waiting", kind: "text", ingress: "cli" },
    { artifactStore: artifacts },
  );
  expect(await waitForAdmission(store, queued, 0)).toEqual({
    ...queued,
    wait_status: "timeout",
  });
  expect(
    store.db.query("SELECT id, state FROM jobs WHERE id=?").get(queued.job_id),
  ).toEqual({ id: queued.job_id, state: "queued" });
  store.close();
});

test("indexedDocumentForUrl matches conservative resource identity only", () => {
  const { store } = fixture();
  const timestamp = "2026-08-07T00:00:00.000Z";
  const tweet = store.upsertDocument({
    sourceType: "tweet",
    sourceUri: "https://x.com/i/status/42",
    title: "Tweet",
    content: "tweet content for identity",
  });
  const article = store.upsertDocument({
    sourceType: "url",
    sourceUri: "https://example.com/post",
    title: "Post",
    content: "generic page content for identity",
  });
  const insert = store.db.query(
    `INSERT INTO resources(
       key_type, key_value, kind, sensitivity, document_id, created_at, updated_at
     ) VALUES (?, ?, 'url', 'normal', ?, ?, ?)`,
  );
  insert.run("x:status", "42", tweet.document_id, timestamp, timestamp);
  insert.run(
    "url",
    "https://example.com/post",
    article.document_id,
    timestamp,
    timestamp,
  );
  // A discovered relation without a materialized document must not count.
  insert.run("url", "https://example.com/api/", null, timestamp, timestamp);

  // Every X status alias converges on the provider identity.
  for (const alias of [
    "https://x.com/i/status/42",
    "https://x.com/someone/status/42",
    "https://twitter.com/other/status/42?s=20",
  ]) {
    expect(indexedDocumentForUrl(store, alias)).toEqual({
      version: 1,
      status: "already_indexed",
      document_id: tweet.document_id,
      resource_key: "x:status:42",
    });
  }
  // Generic URLs match only their conservative normalization.
  expect(
    indexedDocumentForUrl(store, "https://EXAMPLE.com/post#intro"),
  ).toEqual({
    version: 1,
    status: "already_indexed",
    document_id: article.document_id,
    resource_key: "url:https://example.com/post",
  });
  expect(
    indexedDocumentForUrl(store, "https://example.com/post?utm=1"),
  ).toBeNull();
  expect(indexedDocumentForUrl(store, "https://example.com/api/")).toBeNull();
  expect(indexedDocumentForUrl(store, "not a url")).toBeNull();
  expect(indexedDocumentForUrl(store, "/tmp/local-file.md")).toBeNull();
  store.close();
});
