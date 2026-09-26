import { Database } from "../src/sqlite.js";
import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchCache } from "../src/db.js";
import { normalizeSearchQuery, parseTags, truncateContent } from "../src/query.js";
import { ResearchStore } from "../src/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error("fixture value is missing");
  return value;
}

test("normalizes any queries into quoted OR atoms", () => {
  expect(normalizeSearchQuery("agent memory systems", "any")).toBe(
    '"agent" OR "memory" OR "systems"',
  );
});

test("normalizes all queries into quoted AND atoms and keeps phrases", () => {
  expect(normalizeSearchQuery('"agent memory" systems', "all")).toBe(
    '"agent memory" AND "systems"',
  );
});

test("raw queries pass through", () => {
  expect(normalizeSearchQuery("agent NEAR memory", "raw")).toBe(
    "agent NEAR memory",
  );
});

test("parseTags tolerates malformed JSON", () => {
  expect(parseTags('["a","b",3]')).toEqual(["a", "b"]);
  expect(parseTags("not-json")).toEqual([]);
});

test("truncateContent uses head/tail windows", () => {
  const input = "a".repeat(1000) + "b".repeat(1000);
  const out = truncateContent(input, 1000);
  expect(out.omitted).toBe(1000);
  expect(out.content).toContain("omitted 1000 chars");
  expect(out.content.endsWith("b".repeat(350))).toBe(true);
});

function retrievalFixture(): {
  path: string;
  firstDocumentId: number;
  secondDocumentId: number;
} {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-query-"));
  tempDirs.push(dir);
  const path = join(dir, "research.db");
  const store = new ResearchStore(path);
  const first = store.upsertDocument({
    sourceType: "file",
    sourceUri: "/vault/first.md",
    title: "First resource",
    content: `${"rankingterm ".repeat(500)} first-only-content`,
    contentKind: "thread",
    contentItemCount: 3,
  });
  const second = store.upsertDocument({
    sourceType: "scraped_url",
    sourceUri: "https://example.test/second",
    title: "Second resource",
    content: "rankingterm second-only-content",
    contentKind: "article",
    contentItemCount: 1,
  });
  const now = "2025-04-03T00:00:00.000Z";
  store.db
    .query("UPDATE documents SET updated_at=? WHERE id=?")
    .run("2025-04-01T12:00:00.000Z", first.document_id);
  store.db
    .query("UPDATE documents SET updated_at=? WHERE id=?")
    .run("2025-04-02T12:00:00.000Z", second.document_id);
  store.db
    .query(
      `INSERT INTO resources(key_type, key_value, kind, sensitivity, document_id, created_at, updated_at)
       VALUES ('local_path', '/vault/first.md', 'note', 'normal', ?, ?, ?),
              ('url', 'https://example.test/second', 'article', 'public', ?, ?, ?)`,
    )
    .run(first.document_id, now, now, second.document_id, now, now);
  const resources = store.db
    .query("SELECT id, document_id FROM resources ORDER BY id")
    .all() as Array<{ id: number; document_id: number }>;
  const firstResourceId = required(
    resources.find((row) => row.document_id === first.document_id),
  ).id;
  const secondResourceId = required(
    resources.find((row) => row.document_id === second.document_id),
  ).id;
  store.db
    .query(
      `INSERT INTO resource_aliases(resource_id, alias_type, locator, first_observed_at, last_observed_at)
       VALUES (?, 'local_path', '/vault/first.md', ?, ?)`,
    )
    .run(firstResourceId, now, now);
  store.db.exec(`
    INSERT INTO collections(slug, title, sensitivity, created_at, updated_at) VALUES
      ('shared', 'Shared', 'public', '${now}', '${now}'),
      ('restricted', 'Restricted', 'sensitive', '${now}', '${now}');
  `);
  store.db
    .query(
      `INSERT INTO collection_memberships(collection_id, resource_id, added_at)
       SELECT id, ?, ? FROM collections WHERE slug='shared'`,
    )
    .run(firstResourceId, now);
  store.db
    .query(
      `INSERT INTO collection_memberships(collection_id, resource_id, added_at)
       SELECT id, ?, ? FROM collections WHERE slug='restricted'`,
    )
    .run(firstResourceId, now);
  store.db
    .query(
      `INSERT INTO collection_memberships(collection_id, resource_id, added_at)
       SELECT id, ?, ? FROM collections WHERE slug='shared'`,
    )
    .run(secondResourceId, now);
  store.db.exec(`
    INSERT INTO sources(source_type, identifier, sensitivity, created_at, updated_at) VALUES
      ('feed', 'shared-feed', 'public', '${now}', '${now}'),
      ('filesystem', 'vault', 'normal', '${now}', '${now}');
  `);
  const sources = store.db
    .query("SELECT id, identifier FROM sources ORDER BY id")
    .all() as Array<{ id: number; identifier: string }>;
  const sharedSourceId = required(
    sources.find((row) => row.identifier === "shared-feed"),
  ).id;
  const vaultSourceId = required(
    sources.find((row) => row.identifier === "vault"),
  ).id;
  for (const [resourceId, sourceId, locator] of [
    [firstResourceId, sharedSourceId, "first-shared"],
    [firstResourceId, vaultSourceId, "first-vault"],
    [secondResourceId, sharedSourceId, "second-shared"],
  ] as const) {
    store.db
      .query(
        `INSERT INTO observations(resource_id, source_id, ingress, observed_locator, observed_at)
         VALUES (?, ?, 'source-scheduler', ?, ?)`,
      )
      .run(resourceId, sourceId, locator, now);
  }
  store.db
    .query(
      `INSERT INTO document_links(
         from_document_id, to_document_id, relation_type, discovered_url,
         resolved_url, status, created_at, updated_at
       ) VALUES (?, ?, 'citation', 'https://example.test/second',
                 'https://example.test/second', 'success', ?, ?)`,
    )
    .run(first.document_id, second.document_id, now, now);
  store.close();
  return {
    path,
    firstDocumentId: first.document_id,
    secondDocumentId: second.document_id,
  };
}

test("typed retrieval filters, deduplicates resources, and keeps relations separate", () => {
  const fixture = retrievalFixture();
  const before = new Database(fixture.path, { readonly: true });
  const counts = before
    .query(
      "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM chunks) AS chunks",
    )
    .get();
  before.close();

  const cache = new ResearchCache(fixture.path);
  const shared = cache.search({
    query: "rankingterm",
    mode: "any",
    collection: "shared",
  });
  expect(shared.results.map((result) => result.document_id).sort()).toEqual(
    [fixture.firstDocumentId, fixture.secondDocumentId].sort(),
  );
  expect(new Set(shared.results.map((result) => result.resource_id)).size).toBe(
    2,
  );
  expect(
    shared.results.find(
      (result) => result.document_id === fixture.firstDocumentId,
    )?.collections,
  ).toEqual(["restricted", "shared"]);
  expect(
    cache
      .search({ query: "rankingterm", mode: "any", source: "vault" })
      .results.map((result) => result.document_id),
  ).toEqual([fixture.firstDocumentId]);
  expect(
    cache
      .search({ query: "rankingterm", mode: "any", resourceKind: "article" })
      .results.map((result) => result.document_id),
  ).toEqual([fixture.secondDocumentId]);
  const threads = cache.search({
    query: "rankingterm",
    mode: "any",
    contentKind: "thread",
  });
  expect(threads.filters).toEqual({ content_kind: "thread" });
  expect(threads.results).toMatchObject([
    {
      document_id: fixture.firstDocumentId,
      content_kind: "thread",
      content_item_count: 3,
    },
  ]);
  expect(
    cache
      .search({ query: "rankingterm", mode: "any", sensitivity: "sensitive" })
      .results.map((result) => result.document_id),
  ).toEqual([fixture.firstDocumentId]);
  expect(
    cache
      .search({ query: "rankingterm", mode: "any", date: "2025-04-02" })
      .results.map((result) => result.document_id),
  ).toEqual([fixture.secondDocumentId]);
  expect(
    cache
      .search({
        query: "rankingterm",
        mode: "any",
        dateFrom: "2025-04-01",
        dateTo: "2025-04-01",
      })
      .results.map((result) => result.document_id),
  ).toEqual([fixture.firstDocumentId]);
  expect(
    cache
      .search({
        query: "rankingterm",
        mode: "any",
        localPath: "/vault/first.md",
      })
      .results.map((result) => result.document_id),
  ).toEqual([fixture.firstDocumentId]);

  const unfilteredFirst = required(
    shared.results.find(
      (result) => result.document_id === fixture.firstDocumentId,
    ),
  );
  const unfilteredSecond = required(
    shared.results.find(
      (result) => result.document_id === fixture.secondDocumentId,
    ),
  );
  expect(unfilteredFirst.relations[0]).toMatchObject({
    direction: "outbound",
    relation_type: "citation",
    linked_document_id: fixture.secondDocumentId,
  });
  expect(unfilteredSecond.relations[0]).toMatchObject({
    direction: "inbound",
    relation_type: "citation",
    linked_document_id: fixture.firstDocumentId,
  });
  expect(
    cache.search({
      query: "rankingterm",
      mode: "any",
      sensitivity: "sensitive",
    }).results[0]?.relations,
  ).toEqual([]);

  const context = cache.context({
    query: "rankingterm",
    collection: "shared",
    limit: 2,
    maxChars: 5000,
  });
  expect(context.hits).toHaveLength(2);
  expect(
    context.hits.every(
      (hit) =>
        !hit.content.includes("second-only-content") ||
        hit.document_id === fixture.secondDocumentId,
    ),
  ).toBe(true);
  cache.close();

  const after = new Database(fixture.path, { readonly: true });
  expect(
    after
      .query(
        "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM chunks) AS chunks",
      )
      .get(),
  ).toEqual(counts);
  after.close();
});

test("Markdown retrieval includes heading breadcrumbs without changing text token search", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentstack-brain-query-markdown-"));
  tempDirs.push(dir);
  const path = join(dir, "research.db");
  const store = new ResearchStore(path);
  const markdown = store.upsertDocument({
    sourceType: "file",
    sourceUri: "/vault/structured.md",
    content: `# Parent Breadcrumb\n\n## Child Section\n\nleafexacttoken appears here.`,
  });
  const text = store.upsertDocument({
    sourceType: "text",
    sourceUri: "text:exact-token",
    content: "nonmarkdownexacttoken remains searchable",
  });
  store.close();

  const cache = new ResearchCache(path);
  const context = cache.context({
    query: "leafexacttoken",
    maxChars: 1000,
  });
  expect(context.hits).toHaveLength(1);
  expect(context.hits[0]).toMatchObject({
    document_id: markdown.document_id,
  });
  expect(context.hits[0]?.content.startsWith(
    "# Parent Breadcrumb\n## Child Section\n\n",
  )).toBe(true);
  expect(
    cache.search({ query: "nonmarkdownexacttoken", mode: "all" }).results[0]
      ?.document_id,
  ).toBe(text.document_id);
  cache.close();
});
