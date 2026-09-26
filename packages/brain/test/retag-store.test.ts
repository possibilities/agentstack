import type { Database } from "../src/sqlite.js";
import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchCache } from "../src/db.js";
import { ResearchStore } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-retag-"));
  dirs.push(dir);
  return join(dir, "research.db");
}

function ftsRow(
  db: Database,
  documentId: number,
): { title: string | null; content: string; tags: string; source_uri: string } {
  return db
    .query(
      `SELECT title, content, tags, source_uri FROM chunks_fts
       WHERE document_id=? ORDER BY rowid`,
    )
    .get(documentId) as {
    title: string | null;
    content: string;
    tags: string;
    source_uri: string;
  };
}

test("retag derives structural tags, writes documents.tags and chunks_fts.tags in one pass", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "url",
    sourceUri: "https://github.com/foo/bar",
    content: "readme body",
    tags: ["legacy-recovery"],
  });

  const result = store.retagDocument(created.document_id);
  expect(result).toMatchObject({
    success: true,
    status: "updated",
    document_id: created.document_id,
    tags: ["legacy-recovery", "code", "github"],
  });

  const documentRow = store.db
    .query("SELECT tags FROM documents WHERE id=?")
    .get(created.document_id) as { tags: string };
  expect(documentRow.tags).toBe('["legacy-recovery", "code", "github"]');

  const fts = ftsRow(store.db, created.document_id);
  expect(fts.tags).toBe("legacy-recovery code github");
  expect(fts.content).toBe("readme body");
  expect(fts.title).toBe(created.title);
  expect(fts.source_uri).toBe("https://github.com/foo/bar");

  store.close();
});

test("retagging twice is byte-identical: the second run is a no-op", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "x",
    sourceUri: "https://x.com/user/status/123",
    content: "a tweet",
    tags: ["legacy-recovery"],
  });

  const first = store.retagDocument(created.document_id);
  expect(first.status).toBe("updated");
  const documentRowAfterFirst = store.db
    .query("SELECT tags FROM documents WHERE id=?")
    .get(created.document_id) as { tags: string };
  const ftsAfterFirst = ftsRow(store.db, created.document_id);

  const second = store.retagDocument(created.document_id);
  expect(second).toEqual({
    success: true,
    status: "unchanged",
    document_id: created.document_id,
    tags: first.tags,
  });

  const documentRowAfterSecond = store.db
    .query("SELECT tags FROM documents WHERE id=?")
    .get(created.document_id) as { tags: string };
  const ftsAfterSecond = ftsRow(store.db, created.document_id);
  expect(documentRowAfterSecond).toEqual(documentRowAfterFirst);
  expect(ftsAfterSecond).toEqual(ftsAfterFirst);

  store.close();
});

test("a document is retrievable by a newly derived structural tag through the FTS search path", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "url",
    sourceUri: "https://youtube.com/watch?v=abc",
    content: "a recorded talk with no special search markers",
  });
  store.retagDocument(created.document_id);
  store.close();

  const cache = new ResearchCache(path);
  // "video" appears nowhere but the derived tags column, so a hit here can
  // only have come from chunks_fts.tags.
  const byFts = cache.search({ query: "video", mode: "any" });
  expect(byFts.results.map((r) => r.document_id)).toContain(
    created.document_id,
  );
  const byTagFilter = cache.search({
    query: "recorded",
    mode: "any",
    tag: "video",
  });
  expect(byTagFilter.results.map((r) => r.document_id)).toContain(
    created.document_id,
  );
  cache.close();
});

test("collection membership contributes a structural tag via the resources join", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "url",
    sourceUri: "https://example.com/saved",
    content: "saved link body",
  });
  const now = "2026-01-01T00:00:00.000Z";
  store.db
    .query(
      "INSERT INTO resources(key_type, key_value, kind, document_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "legacy_document",
      String(created.document_id),
      "url",
      created.document_id,
      now,
      now,
    );
  const resourceId = Number(
    (
      store.db
        .query("SELECT id FROM resources WHERE document_id=?")
        .get(created.document_id) as { id: number }
    ).id,
  );
  store.db
    .query(
      "INSERT INTO collections(slug, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("legacy-links", "Legacy links", now, now);
  const collectionId = Number(
    (
      store.db
        .query("SELECT id FROM collections WHERE slug=?")
        .get("legacy-links") as { id: number }
    ).id,
  );
  store.db
    .query(
      "INSERT INTO collection_memberships(collection_id, resource_id, added_at) VALUES (?, ?, ?)",
    )
    .run(collectionId, resourceId, now);

  const result = store.retagDocument(created.document_id);
  expect(result.tags).toEqual(["legacy-links"]);

  store.close();
});

test("retag does not crash on a pre-migration DB lacking the resources table", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "url",
    sourceUri: "https://github.com/foo/bar",
    content: "some content",
    tags: ["legacy-recovery"],
  });
  store.db.exec("DROP TABLE resources");

  const result = store.retagDocument(created.document_id);
  expect(result.status).toBe("updated");
  expect(result.tags).toEqual(["legacy-recovery", "code", "github"]);

  store.close();
});
