import { spawn, spawnSync } from "./process.js";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "../src/sqlite.js";
import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ResearchCache } from "../src/db.js";
import { CliError } from "../src/errors.js";
import { ResearchStore } from "../src/store.js";
import { chunkText } from "../src/text.js";
import type { ClaimResult } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-store-"));
  dirs.push(dir);
  return join(dir, "research.db");
}

function createV1(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, source_uri TEXT NOT NULL,
      title TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, size_chars INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(source_type, source_uri)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL, start_char INTEGER NOT NULL, end_char INTEGER NOT NULL,
      content TEXT NOT NULL, UNIQUE(document_id, chunk_index)
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      document_id UNINDEXED, chunk_id UNINDEXED, title, content, tags, source_uri,
      tokenize='porter unicode61 remove_diacritics 2'
    );
    INSERT INTO documents VALUES (
      7, 'text', 'text:legacy', 'Legacy', '[]', '', 'legacy searchable body',
      'legacy-hash', 22, '2026-01-01', '2026-01-01'
    );
    INSERT INTO chunks VALUES (9, 7, 0, 0, 22, 'legacy searchable body');
    INSERT INTO chunks_fts(rowid, document_id, chunk_id, title, content, tags, source_uri)
      VALUES (9, 7, 9, 'Legacy', 'legacy searchable body', '', 'text:legacy');
  `);
  db.close();
}

function createV11Article(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '11');
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, source_uri TEXT NOT NULL,
      title TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, size_chars INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, revision_digest TEXT NOT NULL DEFAULT '',
      UNIQUE(source_type, source_uri)
    );
    CREATE TABLE resources (
      id INTEGER PRIMARY KEY, key_type TEXT NOT NULL, key_value TEXT NOT NULL,
      kind TEXT NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'normal',
      document_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE provenance (
      id INTEGER PRIMARY KEY, resource_id INTEGER NOT NULL, evidence_type TEXT NOT NULL,
      source_id INTEGER, run_id INTEGER, artifact_id INTEGER, relation_id INTEGER,
      ingress TEXT, raw_metadata TEXT, observed_at TEXT NOT NULL
    );
    INSERT INTO documents VALUES
      (7, 'tweet', 'https://x.com/i/status/7', 'Article', '[]', '', 'article body',
       'hash', 12, '2026-01-01', '2026-01-01', 'revision'),
      (8, 'tweet', 'https://x.com/i/status/8', 'Post', '[]', '', 'post body',
       'hash-2', 9, '2026-01-01', '2026-01-01', 'revision-2');
    INSERT INTO resources VALUES
      (9, 'x:status', '7', 'url', 'normal', 7, '2026-01-01', '2026-01-01'),
      (10, 'x:status', '8', 'url', 'normal', 8, '2026-01-01', '2026-01-01');
    INSERT INTO provenance VALUES
      (11, 9, 'url_extraction', NULL, NULL, NULL, NULL, 'test',
       '{"extractor":{"implementation":"x-article"},"metadata":{"content_type":"article"}}',
       '2026-01-01'),
      (12, 10, 'url_extraction', NULL, NULL, NULL, NULL, 'test',
       '{"extractor":{"implementation":"x-tweet"},"metadata":{"content_type":"social_post"}}',
       '2026-01-01');
  `);
  db.close();
}

function createV2(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '2');
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, source_uri TEXT NOT NULL,
      title TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, size_chars INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(source_type, source_uri)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL, start_char INTEGER NOT NULL, end_char INTEGER NOT NULL,
      content TEXT NOT NULL, UNIQUE(document_id, chunk_index)
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      document_id UNINDEXED, chunk_id UNINDEXED, title, content, tags, source_uri,
      tokenize='porter unicode61 remove_diacritics 2'
    );
    CREATE TABLE document_links (
      id INTEGER PRIMARY KEY,
      from_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      to_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      relation_type TEXT NOT NULL, discovered_url TEXT NOT NULL, resolved_url TEXT,
      status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(from_document_id, relation_type, discovered_url)
    );
    INSERT INTO documents VALUES
      (3, 'url', 'https://a.example/post', 'A', '[]', '', 'alpha body', 'ha', 10, '2026-02-01', '2026-02-01'),
      (5, 'url', 'https://b.example/post', 'B', '[]', '', 'beta body', 'hb', 9, '2026-02-02', '2026-02-02');
    INSERT INTO chunks VALUES
      (11, 3, 0, 0, 10, 'alpha body'),
      (13, 5, 0, 0, 9, 'beta body');
    INSERT INTO chunks_fts(rowid, document_id, chunk_id, title, content, tags, source_uri) VALUES
      (11, 3, 11, 'A', 'alpha body', '', 'https://a.example/post'),
      (13, 5, 13, 'B', 'beta body', '', 'https://b.example/post');
    INSERT INTO document_links VALUES
      (2, 3, 5, 'content_link', 'https://a.example/child', 'https://b.example/post', 'success', NULL, '2026-02-03', '2026-02-03');
  `);
  db.close();
}

test("writable store migrates v1 additively and preserves IDs and FTS", () => {
  const path = tempDb();
  createV1(path);
  const store = new ResearchStore(path);
  store.close();

  const db = new Database(path, { readonly: true });
  expect(
    db.query("SELECT value FROM meta WHERE key='schema_version'").get(),
  ).toEqual({
    value: "12",
  });
  expect(db.query("SELECT id FROM documents").get()).toEqual({ id: 7 });
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE name='document_links'")
      .get(),
  ).toEqual({ name: "document_links" });
  db.close();

  const cache = new ResearchCache(path);
  expect(
    cache.search({ query: "searchable", mode: "any" }).results[0]?.document_id,
  ).toBe(7);
  // Legacy document 7 gains a durable resource whose exact submitted URI is
  // preserved as a first-class alias without inventing a normalized identity.
  const resource = cache.resourceForDocument(7);
  expect(resource).not.toBeNull();
  expect(resource?.document_id).toBe(7);
  expect(resource?.key_type).toBe("legacy_document");
  expect(resource?.key_value).toBe("7");
  expect(resource?.kind).toBe("text");
  expect(resource?.sensitivity).toBe("normal");
  expect(
    resource?.aliases.map((alias) => [alias.alias_type, alias.locator]),
  ).toEqual([["legacy_source_uri", "text:legacy"]]);
  cache.close();
});

test("v12 migration backfills exact Article classification from extraction provenance", () => {
  const path = tempDb();
  createV11Article(path);
  const store = new ResearchStore(path);
  store.close();

  const db = new Database(path);
  expect(
    db.query("SELECT value FROM meta WHERE key='schema_version'").get(),
  ).toEqual({
    value: "12",
  });
  expect(
    db
      .query(
        "SELECT content_kind, content_item_count FROM documents WHERE id=7",
      )
      .get(),
  ).toEqual({ content_kind: "article", content_item_count: 1 });
  expect(
    db
      .query(
        "SELECT content_kind, content_item_count FROM documents WHERE id=8",
      )
      .get(),
  ).toEqual({ content_kind: null, content_item_count: null });
  expect(() =>
    db
      .query(
        "UPDATE documents SET content_kind='thread', content_item_count=1 WHERE id=8",
      )
      .run(),
  ).toThrow("invalid document content classification");
  db.close();
});

test("upsert persists parser classification and preserves it when unspecified", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "tweet",
    sourceUri: "https://x.com/i/status/1",
    title: "One",
    content: "alpha searchable content",
    contentKind: "thread",
    contentItemCount: 2,
    tags: ["Alpha", "alpha", "two words"],
  });
  expect(created).toMatchObject({
    status: "created",
    content_kind: "thread",
    content_item_count: 2,
  });
  expect(created.tags).toEqual(["alpha", "two-words"]);
  const unchanged = store.upsertDocument({
    sourceType: "tweet",
    sourceUri: "https://x.com/i/status/1",
    title: "One",
    content: "alpha searchable content",
    tags: ["Alpha", "alpha", "two words"],
  });
  expect(unchanged).toMatchObject({
    status: "unchanged",
    document_id: created.document_id,
    content_kind: "thread",
    content_item_count: 2,
  });
  const updated = store.upsertDocument({
    sourceType: "tweet",
    sourceUri: "https://x.com/i/status/1",
    title: "One",
    content: "replacement beta content",
    tags: ["alpha", "two words"],
  });
  expect(updated).toMatchObject({
    status: "updated",
    document_id: created.document_id,
    content_kind: "thread",
    content_item_count: 2,
  });
  expect(() =>
    store.upsertDocument({
      sourceType: "tweet",
      sourceUri: "https://x.com/i/status/2",
      content: "invalid thread",
      contentKind: "thread",
      contentItemCount: 1,
    }),
  ).toThrow("at least 2");
  store.close();

  const cache = new ResearchCache(path);
  expect(cache.search({ query: "beta", mode: "any" }).results[0]).toMatchObject(
    {
      content_kind: "thread",
      content_item_count: 2,
    },
  );
  expect(
    cache.search({ query: "searchable", mode: "any" }).results,
  ).toHaveLength(0);
  cache.close();
});

test("chunk offsets and size_chars count Unicode code points, including non-BMP", () => {
  const text = `${"a".repeat(1900)}😀 paragraph. ${"b".repeat(1900)}🧠 end`;
  const chunks = chunkText(text);
  const points = Array.from(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(points.slice(chunk.start, chunk.end).join("").trim()).toBe(
      chunk.content,
    );
  }

  const path = tempDb();
  const store = new ResearchStore(path);
  const result = store.upsertDocument({
    sourceType: "text",
    sourceUri: "text:unicode",
    content: text,
  });
  expect(result.size_chars).toBe(points.length);
  store.close();
  const db = new Database(path, { readonly: true });
  const rows = db
    .query(
      "SELECT start_char, end_char, content FROM chunks ORDER BY chunk_index",
    )
    .all() as Array<{
    start_char: number;
    end_char: number;
    content: string;
  }>;
  for (const row of rows) {
    expect(points.slice(row.start_char, row.end_char).join("").trim()).toBe(
      row.content,
    );
  }
  db.close();
});

test("failed relation retries in place, shared targets survive delete as null links", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const parentA = store.upsertDocument({
    sourceType: "text",
    sourceUri: "a",
    content: "parent a",
  });
  const parentB = store.upsertDocument({
    sourceType: "text",
    sourceUri: "b",
    content: "parent b",
  });
  const child = store.upsertDocument({
    sourceType: "text",
    sourceUri: "child",
    content: "child",
  });
  const failed = store.upsertDocumentLink({
    fromDocumentId: parentA.document_id,
    discoveredUrl: "https://example.com/child",
    status: "failed",
    error: "temporary",
  });
  const retried = store.upsertDocumentLink({
    fromDocumentId: parentA.document_id,
    discoveredUrl: "https://example.com/child",
    toDocumentId: child.document_id,
    status: "success",
  });
  store.upsertDocumentLink({
    fromDocumentId: parentB.document_id,
    discoveredUrl: "https://example.com/child",
    toDocumentId: child.document_id,
    status: "success",
  });
  expect(retried.id).toBe(failed.id);
  store.deleteDocument({ documentId: child.document_id, confirm: "delete" });
  const links = store.db
    .query("SELECT to_document_id, status FROM document_links ORDER BY id")
    .all();
  expect(links).toEqual([
    { to_document_id: null, status: "success" },
    { to_document_id: null, status: "success" },
  ]);
  store.close();
});

test("immediate write transactions serialize concurrent equivalent admissions", async () => {
  const path = tempDb();
  const initialized = new ResearchStore(path);
  initialized.close();
  const repo = join(import.meta.dirname, "..");
  const processes = Array.from({ length: 4 }, () =>
    spawn({
      cmd: [
        process.execPath,
        "src/cli.js",
        "ingest",
        "concurrent stable text",
        "--source-type",
        "text",
        "--json",
        "--db",
        path,
      ],
      cwd: repo,
      env: { ...process.env, AGENTSTACK_STATE_DIR: join(dirname(path), "data") },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    processes.map(async (process) => ({
      exitCode: await process.exited,
      stdout: await new Response(process.stdout).text(),
      stderr: await new Response(process.stderr).text(),
    })),
  );
  expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
  const statuses = results.map(
    (result) => JSON.parse(result.stdout).data.status,
  );
  expect(statuses.filter((status) => status === "queued")).toHaveLength(1);
  expect(statuses.filter((status) => status === "duplicate")).toHaveLength(3);
  const db = new Database(path, { readonly: true });
  expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({
    count: 1,
  });
  expect(db.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual({
    count: 0,
  });
  db.close();
});

test("newer schema versions are rejected", () => {
  const path = tempDb();
  const db = new Database(path);
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','13')",
  );
  db.close();
  expect(() => new ResearchStore(path)).toThrow("newer than supported");
  expect(() => new ResearchCache(path)).toThrow("newer than supported");
});

test("migration maps legacy documents and relation provenance", () => {
  const path = tempDb();
  createV2(path);
  const store = new ResearchStore(path);
  store.close();

  const cache = new ResearchCache(path);
  expect(cache.resourceForDocument(3)?.aliases.map((a) => a.locator)).toEqual([
    "https://a.example/post",
  ]);
  expect(cache.resourceForDocument(5)?.aliases.map((a) => a.locator)).toEqual([
    "https://b.example/post",
  ]);
  cache.close();

  const db = new Database(path, { readonly: true });
  // The existing relation is untouched and mapped as provenance on the
  // originating resource, preserving its identity without inventing evidence.
  expect(db.query("SELECT COUNT(*) AS c FROM document_links").get()).toEqual({
    c: 1,
  });
  expect(
    db
      .query(
        `SELECT p.evidence_type, p.relation_id, p.raw_metadata
         FROM provenance p JOIN resources r ON r.id = p.resource_id
         WHERE r.document_id = 3`,
      )
      .get(),
  ).toEqual({
    evidence_type: "legacy_relation",
    relation_id: 2,
    raw_metadata: "https://a.example/child",
  });
  db.close();
});

test("read-only cache rejects a legacy v2 database without migrating it", () => {
  const path = tempDb();
  createV2(path);
  let error: unknown;
  try {
    new ResearchCache(path).close();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("unsupported_schema_version");
  expect((error as Error).message).toContain("older than supported");

  // The database is untouched: still v2, with no resource model created.
  const db = new Database(path, { readonly: true });
  expect(
    db.query("SELECT value FROM meta WHERE key='schema_version'").get(),
  ).toEqual({ value: "2" });
  expect(
    db
      .query("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='resources'")
      .get(),
  ).toEqual({ c: 0 });
  db.close();
});

test("equal artifact digests and canonical URLs never merge resources", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const now = "2026-03-01";
  const insertResource = (keyValue: string): number =>
    Number(
      store.db
        .query(
          `INSERT INTO resources(key_type, key_value, kind, created_at, updated_at)
           VALUES ('url', ?, 'url', ?, ?)`,
        )
        .run(keyValue, now, now).lastInsertRowid,
    );
  const a = insertResource("url:https://a.example/");
  const b = insertResource("url:https://b.example/");
  const artifact = Number(
    store.db
      .query(
        `INSERT INTO artifacts(content_hash, media_type, byte_size, artifact_role, created_at)
         VALUES ('sha256:shared', 'text/markdown', 12, 'normalized_markdown', ?)`,
      )
      .run(now).lastInsertRowid,
  );
  // The same immutable bytes attach to two distinct resources, and the same
  // observed canonical URL is a per-resource alias on both.
  for (const id of [a, b]) {
    store.db
      .query(
        "INSERT INTO resource_artifacts(resource_id, artifact_id, observed_at) VALUES (?, ?, ?)",
      )
      .run(id, artifact, now);
    store.db
      .query(
        `INSERT INTO resource_aliases(resource_id, alias_type, locator, first_observed_at, last_observed_at)
         VALUES (?, 'publisher_canonical', 'https://canonical.example/x', ?, ?)`,
      )
      .run(id, now, now);
  }
  expect(a).not.toBe(b);
  expect(store.db.query("SELECT COUNT(*) AS c FROM resources").get()).toEqual({
    c: 2,
  });
  expect(store.db.query("SELECT COUNT(*) AS c FROM artifacts").get()).toEqual({
    c: 1,
  });
  expect(
    store.db
      .query(
        "SELECT COUNT(DISTINCT resource_id) AS c FROM resource_aliases WHERE locator = 'https://canonical.example/x'",
      )
      .get(),
  ).toEqual({ c: 2 });
  store.close();
});

test("domain constraints enforce cardinality, uniqueness, and sensitivity", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const now = "2026-04-01";
  const insertResource = (keyValue: string, sensitivity = "normal"): number =>
    Number(
      store.db
        .query(
          `INSERT INTO resources(key_type, key_value, kind, sensitivity, created_at, updated_at)
           VALUES ('url', ?, 'url', ?, ?, ?)`,
        )
        .run(keyValue, sensitivity, now, now).lastInsertRowid,
    );
  const r1 = insertResource("url:https://one.example/");

  // A typed resource key is unique: identity cannot silently merge.
  expect(() => insertResource("url:https://one.example/")).toThrow();
  // Sensitivity is drawn from a closed vocabulary, enforced by foreign key.
  expect(() => insertResource("url:https://two.example/", "secret")).toThrow();

  // A suppressed observation must carry a durable reason rather than vanish.
  expect(() =>
    store.db
      .query(
        `INSERT INTO observations(resource_id, ingress, suppressed, observed_at)
         VALUES (?, 'cli', 1, ?)`,
      )
      .run(r1, now),
  ).toThrow();
  store.db
    .query(
      `INSERT INTO observations(resource_id, ingress, suppressed, suppressed_reason, observed_at)
       VALUES (?, 'cli', 1, 'per-source limit', ?)`,
    )
    .run(r1, now);

  // Ordered membership positions are unique within a collection; the legacy
  // positional identifier rides along as an external reference, not a key.
  const collection = Number(
    store.db
      .query(
        `INSERT INTO collections(slug, title, created_at, updated_at)
         VALUES ('saved-links', 'Saved links', ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  );
  const r2 = insertResource("url:https://three.example/");
  store.db
    .query(
      `INSERT INTO collection_memberships(collection_id, resource_id, position, external_ref, added_at)
       VALUES (?, ?, 0, 'link-00001', ?)`,
    )
    .run(collection, r1, now);
  expect(() =>
    store.db
      .query(
        `INSERT INTO collection_memberships(collection_id, resource_id, position, added_at)
         VALUES (?, ?, 0, ?)`,
      )
      .run(collection, r2, now),
  ).toThrow();
  store.close();
});

// ---- Durable ingestion job lifecycle (ADR 0004) ----

const T0 = new Date("2026-05-01T00:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);
// jitterRatio 0 alone still multiplies by random(); force a fully deterministic
// backoff so run_at math is exact under a fake clock.
const NO_JITTER = { jitterRatio: 0 } as const;
const noRandom = (): number => 0;

function mustClaim(
  store: ResearchStore,
  opts: Parameters<ResearchStore["claimJob"]>[0],
): Extract<ClaimResult, { claimed: true }> {
  const result = store.claimJob(opts);
  if (!result.claimed)
    throw new Error("expected a claim but the queue was empty");
  return result;
}

test("admission creates or identifies a durable job idempotently", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const first = store.enqueueJob({
    idempotencyKey: "text:hello",
    kind: "text",
    intent: { text: "durable hello" },
    now: T0,
  });
  expect(first.created).toBe(true);
  expect(first.job.state).toBe("queued");
  expect(first.job.intent).toBe(JSON.stringify({ text: "durable hello" }));

  const replay = store.enqueueJob({
    idempotencyKey: "text:hello",
    kind: "text",
    intent: { text: "durable hello" },
    now: at(1000),
  });
  expect(replay.created).toBe(false);
  expect(replay.job.id).toBe(first.job.id);
  expect(store.db.query("SELECT COUNT(*) AS c FROM jobs").get()).toEqual({
    c: 1,
  });

  const transitions = store.db
    .query(
      "SELECT from_state, to_state, actor, reason FROM job_transitions WHERE job_id=?",
    )
    .all(first.job.id);
  expect(transitions).toEqual([
    {
      from_state: null,
      to_state: "queued",
      actor: "system",
      reason: "admitted",
    },
  ]);
  store.close();
});

test("concurrent claimers cannot obtain the same active lease", async () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  store.enqueueJob({ idempotencyKey: "race", kind: "url" });
  store.close();

  const scriptPath = join(dirname(path), "race-claim.ts");
  const storeModule = join(import.meta.dirname, "..", "src", "store.js");
  writeFileSync(
    scriptPath,
    `import { ResearchStore } from ${JSON.stringify(storeModule)};
const store = new ResearchStore(process.argv[2]);
try {
  const result = store.claimJob({ worker: "pid-" + process.pid });
  process.stdout.write(
    JSON.stringify(
      result.claimed
        ? { claimed: true, token: result.fencing_token }
        : { claimed: false },
    ),
  );
} finally {
  store.close();
}
`,
  );

  const processes = Array.from({ length: 6 }, () =>
    spawn({
      cmd: [process.execPath, scriptPath, path],
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    processes.map(async (process) => ({
      exitCode: await process.exited,
      stdout: await new Response(process.stdout).text(),
      stderr: await new Response(process.stderr).text(),
    })),
  );
  expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0, 0, 0]);

  const claims = results.map((result) => JSON.parse(result.stdout));
  expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);

  const db = new Database(path, { readonly: true });
  // Exactly one leased attempt exists and the job is running: no double-claim.
  expect(db.query("SELECT COUNT(*) AS c FROM attempts").get()).toEqual({
    c: 1,
  });
  expect(
    db.query("SELECT state FROM jobs WHERE idempotency_key='race'").get(),
  ).toEqual({ state: "running" });
  db.close();
});

test("expired leases go stale, recover, and fence late workers by token", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const { job } = store.enqueueJob({
    idempotencyKey: "fence",
    kind: "url",
    now: T0,
  });

  const first = mustClaim(store, { worker: "w1", now: at(0), leaseMs: 1000 });
  expect(first.job.state).toBe("running");

  // A heartbeat inside the lease extends it to now+leaseMs.
  const beat = store.heartbeat({
    fencingToken: first.fencing_token,
    now: at(500),
    leaseMs: 1000,
  });
  expect(beat.ok).toBe(true);

  // Past the extended lease the token is stale: no heartbeat, no completion.
  const staleBeat = store.heartbeat({
    fencingToken: first.fencing_token,
    now: at(2000),
    leaseMs: 1000,
  });
  expect(staleBeat.ok).toBe(false);
  if (!staleBeat.ok) expect(staleBeat.reason).toBe("stale");
  const staleComplete = store.completeJob({
    fencingToken: first.fencing_token,
    now: at(2000),
  });
  expect(staleComplete.ok).toBe(false);
  if (!staleComplete.ok) expect(staleComplete.reason).toBe("stale");

  // Recovery marks the crashed attempt stale and schedules an infra retry that
  // does not consume the bounded item budget.
  const recovered = store.recoverExpiredLeases({
    now: at(2000),
    policy: { infraBaseMs: 1000, infraCapMs: 4000, ...NO_JITTER },
    random: noRandom,
  });
  expect(recovered).toEqual([
    {
      job_id: job.id,
      attempt_id: first.fencing_token,
      disposition: "retry_wait",
    },
  ]);
  expect(
    store.db
      .query("SELECT state, run_at, item_retry_count FROM jobs WHERE id=?")
      .get(job.id),
  ).toEqual({
    state: "retry_wait",
    run_at: at(3000).toISOString(),
    item_retry_count: 0,
  });
  expect(
    store.db
      .query("SELECT state FROM attempts WHERE id=?")
      .get(first.fencing_token),
  ).toEqual({ state: "stale" });

  // A second claim mints a strictly higher fencing token.
  const second = mustClaim(store, {
    worker: "w2",
    now: at(3000),
    leaseMs: 1000,
  });
  expect(second.fencing_token).toBeGreaterThan(first.fencing_token);

  // The late first worker is now fenced by the newer token.
  const fenced = store.completeJob({
    fencingToken: first.fencing_token,
    now: at(3000),
  });
  expect(fenced.ok).toBe(false);
  if (!fenced.ok) expect(fenced.reason).toBe("fenced");

  const done = store.completeJob({
    fencingToken: second.fencing_token,
    now: at(3000),
  });
  expect(done.ok).toBe(true);
  if (done.ok) expect(done.idempotent).toBe(false);
  expect(store.db.query("SELECT COUNT(*) AS c FROM attempts").get()).toEqual({
    c: 2,
  });
  store.close();
});

test("infrastructure failures retry indefinitely while item retries exhaust to blocked", () => {
  const path = tempDb();
  const store = new ResearchStore(path);

  // Infrastructure failures never exhaust: ten cycles stay in retry_wait with
  // the item budget untouched.
  const infra = store.enqueueJob({
    idempotencyKey: "infra",
    kind: "url",
    now: T0,
  });
  let now = T0;
  for (let cycle = 0; cycle < 10; cycle++) {
    const claim = mustClaim(store, { worker: "w", now, leaseMs: 1000 });
    const failed = store.failAttempt({
      fencingToken: claim.fencing_token,
      failureClass: "infra",
      summary: "agentscrape unavailable",
      now,
      policy: { infraBaseMs: 1000, infraCapMs: 8000, ...NO_JITTER },
      random: noRandom,
    });
    if (!failed.ok) throw new Error("expected an infra retry");
    expect(failed.disposition).toBe("retry_wait");
    now = new Date(Date.parse(failed.job.run_at));
  }
  expect(
    store.db
      .query(
        "SELECT state, attempt_count, item_retry_count FROM jobs WHERE id=?",
      )
      .get(infra.job.id),
  ).toEqual({ state: "retry_wait", attempt_count: 10, item_retry_count: 0 });

  // Item-specific transient failures consume a bounded budget, then block for a
  // human instead of churning forever.
  const item = store.enqueueJob({
    idempotencyKey: "item",
    kind: "url",
    now: T0,
  });
  const policy = {
    maxItemRetries: 3,
    itemBaseMs: 1000,
    itemCapMs: 8000,
    ...NO_JITTER,
  };
  now = T0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = mustClaim(store, { worker: "w", now, leaseMs: 1000 });
    const failed = store.failAttempt({
      fencingToken: claim.fencing_token,
      failureClass: "item_transient",
      summary: "429 throttled",
      now,
      policy,
      random: noRandom,
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.disposition).toBe(attempt < 3 ? "retry_wait" : "blocked");
      now = new Date(Date.parse(failed.job.run_at));
    }
  }
  expect(
    store.db
      .query(
        "SELECT state, block_reason, item_retry_count FROM jobs WHERE id=?",
      )
      .get(item.job.id),
  ).toEqual({
    state: "blocked",
    block_reason: "item_retry_exhausted",
    item_retry_count: 3,
  });
  store.close();
});

test("manual retry preserves the job and prior attempts", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const { job } = store.enqueueJob({
    idempotencyKey: "retry",
    kind: "url",
    now: T0,
  });

  const first = mustClaim(store, { worker: "w1", now: at(0), leaseMs: 1000 });
  const failed = store.failAttempt({
    fencingToken: first.fencing_token,
    failureClass: "permanent",
    summary: "unsupported content",
    now: at(10),
  });
  expect(failed.ok).toBe(true);
  if (failed.ok) expect(failed.disposition).toBe("failed");

  const requeued = store.retryJob({
    jobId: job.id,
    actor: "operator",
    now: at(20),
  });
  expect(requeued.state).toBe("queued");
  // The original job id and its prior attempt survive the requeue untouched.
  expect(requeued.id).toBe(job.id);
  expect(requeued.attempt_count).toBe(1);
  expect(
    store.db
      .query("SELECT COUNT(*) AS c FROM attempts WHERE job_id=?")
      .get(job.id),
  ).toEqual({ c: 1 });
  expect(
    store.db
      .query(
        "SELECT COUNT(*) AS c FROM job_transitions WHERE job_id=? AND actor='operator' AND reason='manual_retry'",
      )
      .get(job.id),
  ).toEqual({ c: 1 });

  // The next claim appends a second attempt rather than rewriting the first.
  const second = mustClaim(store, { worker: "w2", now: at(30), leaseMs: 1000 });
  expect(second.attempt.attempt_number).toBe(2);
  expect(
    store.db
      .query("SELECT COUNT(*) AS c FROM attempts WHERE job_id=?")
      .get(job.id),
  ).toEqual({ c: 2 });
  store.close();
});

test("cancel, exclude, reopen, and sensitive inspection append audited transitions", () => {
  const path = tempDb();
  const store = new ResearchStore(path);

  // Sensitive inspection appends audit evidence without changing state, and the
  // recorded detail is sanitized of credentials.
  const sensitive = store.enqueueJob({
    idempotencyKey: "sensitive",
    kind: "file",
    sensitivity: "sensitive",
    now: T0,
  });
  store.recordSensitiveInspection({
    jobId: sensitive.job.id,
    actor: "mike",
    detail: "previewed payload authorization: bearer sk-secret-123",
    now: at(1),
  });
  const audit = store.db
    .query(
      "SELECT from_state, to_state, actor, reason, detail FROM job_transitions WHERE job_id=? AND reason='sensitive_inspection'",
    )
    .get(sensitive.job.id) as {
    from_state: string;
    to_state: string;
    actor: string;
    reason: string;
    detail: string;
  };
  expect(audit.from_state).toBe("queued");
  expect(audit.to_state).toBe("queued");
  expect(audit.actor).toBe("mike");
  expect(audit.detail).toContain("[REDACTED]");
  expect(audit.detail).not.toContain("sk-secret-123");
  expect(
    store.db.query("SELECT state FROM jobs WHERE id=?").get(sensitive.job.id),
  ).toEqual({ state: "queued" });

  // Cancel then reopen: both are durable audited transitions.
  const cancelled = store.cancelJob({
    jobId: sensitive.job.id,
    actor: "operator",
    reason: "user withdrew",
    now: at(2),
  });
  expect(cancelled.ok).toBe(true);
  const reopened = store.reopenJob({ jobId: sensitive.job.id, now: at(3) });
  expect(reopened.state).toBe("queued");

  // Exclude then reopen.
  const excluded = store.excludeJob({
    jobId: sensitive.job.id,
    reason: "duplicate corpus",
    now: at(4),
  });
  expect(excluded.state).toBe("excluded");
  expect(excluded.block_reason).toBe("duplicate corpus");
  const reopenedAgain = store.reopenJob({
    jobId: sensitive.job.id,
    now: at(5),
  });
  expect(reopenedAgain.state).toBe("queued");

  const reasons = store.db
    .query("SELECT reason FROM job_transitions WHERE job_id=? ORDER BY id ASC")
    .all(sensitive.job.id)
    .map((row) => (row as { reason: string }).reason);
  expect(reasons).toEqual([
    "admitted",
    "sensitive_inspection",
    "user withdrew",
    "reopened",
    "duplicate corpus",
    "reopened",
  ]);
  store.close();
});

test("cancellation is a fenced compare-and-swap against completion", () => {
  const path = tempDb();
  const store = new ResearchStore(path);

  // Cancel loses to an already-committed completion.
  const winner = store.enqueueJob({
    idempotencyKey: "win",
    kind: "url",
    now: T0,
  });
  const claimW = mustClaim(store, { worker: "w", now: at(0), leaseMs: 1000 });
  expect(
    store.completeJob({ fencingToken: claimW.fencing_token, now: at(1) }).ok,
  ).toBe(true);
  const lateCancel = store.cancelJob({ jobId: winner.job.id, now: at(2) });
  expect(lateCancel.ok).toBe(false);
  if (!lateCancel.ok) expect(lateCancel.reason).toBe("already_completed");

  // Cancel wins over a still-running worker, which is then fenced and cannot
  // commit any resource effects.
  const loser = store.enqueueJob({
    idempotencyKey: "lose",
    kind: "url",
    now: T0,
  });
  const claimL = mustClaim(store, { worker: "w", now: at(0), leaseMs: 1000 });
  const cancel = store.cancelJob({ jobId: loser.job.id, now: at(1) });
  expect(cancel.ok).toBe(true);
  expect(
    store.db
      .query("SELECT state FROM attempts WHERE id=?")
      .get(claimL.fencing_token),
  ).toEqual({ state: "cancelled" });
  const fencedComplete = store.completeJob({
    fencingToken: claimL.fencing_token,
    now: at(2),
    apply: (db) => {
      db.query(
        "INSERT INTO resources(key_type, key_value, kind, created_at, updated_at) VALUES ('url', 'must-not-exist', 'url', '2026-05-01', '2026-05-01')",
      ).run();
    },
  });
  expect(fencedComplete.ok).toBe(false);
  if (!fencedComplete.ok) expect(fencedComplete.reason).toBe("terminal");
  expect(store.db.query("SELECT COUNT(*) AS c FROM resources").get()).toEqual({
    c: 0,
  });
  store.close();
});

test("idempotent completion cannot duplicate resource or provenance effects", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const { job } = store.enqueueJob({
    idempotencyKey: "once",
    kind: "url",
    now: T0,
  });
  const claim = mustClaim(store, { worker: "w", now: at(0), leaseMs: 1000 });

  const apply = (db: Database): void => {
    const resourceId = Number(
      db
        .query(
          "INSERT INTO resources(key_type, key_value, kind, created_at, updated_at) VALUES ('url', 'once', 'url', '2026-05-01', '2026-05-01')",
        )
        .run().lastInsertRowid,
    );
    db.query(
      "INSERT INTO provenance(resource_id, evidence_type, ingress, observed_at) VALUES (?, 'admitted', 'cli', '2026-05-01')",
    ).run(resourceId);
  };

  const first = store.completeJob({
    fencingToken: claim.fencing_token,
    resourceId: 1,
    apply,
    now: at(1),
  });
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.idempotent).toBe(false);

  // Replaying completion with the same token is a no-op: apply never re-runs.
  const replay = store.completeJob({
    fencingToken: claim.fencing_token,
    resourceId: 1,
    apply,
    now: at(2),
  });
  expect(replay.ok).toBe(true);
  if (replay.ok) expect(replay.idempotent).toBe(true);

  expect(store.db.query("SELECT COUNT(*) AS c FROM resources").get()).toEqual({
    c: 1,
  });
  expect(store.db.query("SELECT COUNT(*) AS c FROM provenance").get()).toEqual({
    c: 1,
  });
  expect(
    store.db
      .query(
        "SELECT COUNT(*) AS c FROM job_transitions WHERE job_id=? AND to_state='completed'",
      )
      .get(job.id),
  ).toEqual({ c: 1 });
  store.close();
});

test("illegal job transitions are rejected", () => {
  const path = tempDb();
  const store = new ResearchStore(path);

  const running = store.enqueueJob({
    idempotencyKey: "run",
    kind: "url",
    now: T0,
  });
  mustClaim(store, { worker: "w", now: at(0), leaseMs: 1000 });
  // A running job cannot be excluded; it must be cancelled instead.
  expect(() =>
    store.excludeJob({ jobId: running.job.id, reason: "x" }),
  ).toThrow("illegal job transition running -> excluded");

  const done = store.enqueueJob({
    idempotencyKey: "fin",
    kind: "url",
    now: T0,
  });
  const claim = mustClaim(store, { worker: "w", now: at(0), leaseMs: 1000 });
  store.completeJob({ fencingToken: claim.fencing_token, now: at(1) });
  // A completed job is terminal: it cannot be retried.
  expect(() => store.retryJob({ jobId: done.job.id })).toThrow(
    "illegal job transition completed -> queued",
  );

  const queued = store.enqueueJob({
    idempotencyKey: "q",
    kind: "url",
    now: T0,
  });
  // A queued job is already runnable: reopening it is not a legal transition.
  expect(() => store.reopenJob({ jobId: queued.job.id })).toThrow(
    "illegal job transition queued -> queued",
  );
  store.close();
});

test("read-only cache observes the job lifecycle without mutating it", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const { job } = store.enqueueJob({
    idempotencyKey: "observe",
    kind: "url",
    now: T0,
  });
  const claim = mustClaim(store, { worker: "w", now: at(0), leaseMs: 1000 });
  store.completeJob({ fencingToken: claim.fencing_token, now: at(1) });
  store.close();

  const cache = new ResearchCache(path);
  const record = cache.job(job.id);
  expect(record?.state).toBe("completed");
  expect(record?.attempts.map((attempt) => attempt.state)).toEqual([
    "succeeded",
  ]);
  expect(record?.transitions.map((transition) => transition.to_state)).toEqual([
    "queued",
    "running",
    "completed",
  ]);
  expect(cache.jobs({ state: "completed" })).toHaveLength(1);
  expect(cache.jobs({ state: "queued" })).toHaveLength(0);

  // The read connection cannot mutate durable ingestion state.
  expect(() =>
    cache.db.query("UPDATE jobs SET state='queued' WHERE id=?").run(job.id),
  ).toThrow();
  cache.close();

  // Pre-current databases are rejected before any read path can hit missing schema.
  const legacyPath = tempDb();
  createV2(legacyPath);
  expect(() => new ResearchCache(legacyPath)).toThrow("older than supported");
});
