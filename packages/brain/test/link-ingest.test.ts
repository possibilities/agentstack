import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { expect } from "expect";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableSubmissionIntent } from "../src/admission.js";
import { AgentscrapeExtractionError } from "../src/agentscrape.js";
import { ArtifactStore } from "../src/artifacts.js";
import { LINKED_FAN_OUT_LIMIT } from "../src/link-ingest.js";
import { ResearchStore } from "../src/store.js";
import type {
  ExtractionRelation,
  ExtractionSuccess,
  HistoricalExtractorIdentity,
  Job,
} from "../src/types.js";
import { canonicalizeSource } from "../src/url.js";
import { runWorker } from "../src/worker.js";

const roots: string[] = [];
const T0 = new Date("2026-07-19T00:00:00.000Z");

function at(milliseconds: number): Date {
  return new Date(T0.getTime() + milliseconds);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function setup(): {
  store: ResearchStore;
  artifacts: ArtifactStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-link-"));
  roots.push(root);
  return {
    store: new ResearchStore(join(root, "research.db")),
    artifacts: new ArtifactStore(join(root, "artifacts")),
  };
}

type HistoricalExtractionFixture = Omit<ExtractionSuccess, "extractor"> & {
  extractor: HistoricalExtractorIdentity;
};

async function installHistoricalFixture(
  artifacts: ArtifactStore,
  jobId: number,
  name: string,
): Promise<HistoricalExtractionFixture> {
  const fixture = JSON.parse(readFileSync(
    join(import.meta.dirname, "../../test/fixtures", name), "utf8",
  )) as HistoricalExtractionFixture;
  const descriptor = fixture.artifacts[0];
  const stored = artifacts.captureBytes(descriptor.content, {
    expectedDigest: descriptor.sha256,
  });
  artifacts.writeUrlExtraction(jobId, {
    record_version: 1,
    requested_url: fixture.requested_url,
    final_url: fixture.final_url,
    extractor: fixture.extractor,
    artifact: {
      artifact_type: descriptor.artifact_type,
      media_type: descriptor.media_type,
      encoding: descriptor.encoding,
      size_bytes: descriptor.size_bytes,
      sha256: descriptor.sha256,
      artifact_role: "extracted_markdown",
      storage_path: stored.storagePath,
    },
    metadata: fixture.metadata,
    relations: fixture.relations,
  });
  return fixture;
}
function intent(
  url: string,
  ingress = "test-ingress",
): DurableSubmissionIntent {
  return {
    version: 1,
    kind: "url",
    ingress,
    collections: [],
    payload: { url: { url } },
    options: { tags: [], force: false, max_bytes: 1_000_000 },
  };
}

function enqueue(
  store: ResearchStore,
  url: string,
  key: string,
  ingress = "test-ingress",
): Job {
  return store.enqueueJob({
    idempotencyKey: key,
    kind: "url",
    intent: intent(url, ingress),
    now: T0,
  }).job;
}

function envelope(
  url: string,
  relations: ExtractionRelation[] = [],
  options: {
    title?: string;
    contentType?: "web_page" | "social_post" | "article";
  } = {},
): ExtractionSuccess {
  const content = `# ${options.title ?? "Extracted"}\n\nContent from ${url}`;
  return {
    schema_version: "1",
    status: "success",
    requested_url: url,
    final_url: url,
    extractor: {
      name: "agentscrape",
      version: "1.0.0",
      implementation: "test-fixture",
      implementation_version: "1",
    },
    artifacts: [
      {
        artifact_type: "document",
        media_type: "text/markdown",
        encoding: "utf-8",
        content,
        size_bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    metadata: {
      content_type: options.contentType ?? "web_page",
      title: options.title ?? "Extracted",
      author_name: "",
      author_handle: "",
      published_at: "",
      source_id: "",
      warnings: [],
    },
    relations,
    failure: null,
  };
}

test("X status and article URL forms canonicalize to stable native identities", () => {
  expect(
    canonicalizeSource("https://twitter.com/old/status/123?ref=home"),
  ).toEqual(["tweet", "https://x.com/i/status/123"]);
  expect(canonicalizeSource("https://x.com/writer/articles/987")).toEqual([
    "tweet_article",
    "https://x.com/i/article/987",
  ]);
});

test("generic roots ignore Markdown URLs and extractor relations for automatic fanout", async () => {
  const { store, artifacts } = setup();
  const url = "https://example.com/root";
  enqueue(store, url, "generic-root");
  const calls: string[] = [];
  const result = await runWorker(store, {
    once: true,
    workerId: "generic-worker",
    now: () => T0,
    artifactStore: artifacts,
    extract: async (requested) => {
      calls.push(requested);
      const extracted = envelope(requested, [
        {
          relation_type: "references",
          target_url: "https://child.example/from-envelope",
        },
      ]);
      extracted.artifacts[0].content +=
        "\n\nMarkdown-only https://child.example/from-markdown";
      extracted.artifacts[0].size_bytes = Buffer.byteLength(
        extracted.artifacts[0].content,
      );
      extracted.artifacts[0].sha256 = createHash("sha256")
        .update(extracted.artifacts[0].content)
        .digest("hex");
      return extracted;
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(calls).toEqual([url]);
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resource_relations").get(),
  ).toEqual({ count: 0 });
  expect(
    store.db
      .query(
        `SELECT observed_locator, suppressed_reason FROM observations
         WHERE suppressed=1`,
      )
      .get(),
  ).toEqual({
    observed_locator: "https://child.example/from-envelope",
    suppressed_reason: "ineligible_root",
  });
  expect(
    store.db
      .query(
        `SELECT COUNT(*) AS count FROM resource_aliases
         WHERE locator='https://child.example/from-markdown'`,
      )
      .get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("historical extraction fixture provenance remains readable after worker indexing", async () => {
  const { store, artifacts } = setup();
  const queued = enqueue(
    store,
    "https://twitter.com/original_handle/status/123?ref=timeline",
    "fixture-root",
    "linkctl",
  );
  const root = await installHistoricalFixture(
    artifacts,
    queued.id,
    "prescraped_x_tweet.json",
  );
  const calls: string[] = [];
  const result = await runWorker(store, {
    once: true,
    workerId: "fixture-worker",
    now: () => T0,
    artifactStore: artifacts,
    extract: async (url) => {
      calls.push(url);
      return envelope(url);
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 4, completed: 4, failed: 0 });
  expect(calls).toEqual([
    "https://example.com/story",
    "https://x.com/i/article/987",
    "https://x.com/i/status/456",
  ]);
  expect(
    store.db
      .query(
        `SELECT relation_type, observed_url FROM resource_relations
         ORDER BY discovery_ordinal`,
      )
      .all(),
  ).toEqual([
    {
      relation_type: "content_link",
      observed_url: "https://example.com/story",
    },
    {
      relation_type: "article",
      observed_url: "https://twitter.com/writer/articles/987",
    },
    {
      relation_type: "quoted_post",
      observed_url: "https://twitter.com/peer/status/456",
    },
  ]);
  expect(
    store.db
      .query(
        `SELECT discovery_ordinal, suppressed_reason FROM observations
         WHERE suppressed=1 ORDER BY discovery_ordinal`,
      )
      .all(),
  ).toEqual([
    { discovery_ordinal: 1, suppressed_reason: "duplicate_destination" },
    { discovery_ordinal: 2, suppressed_reason: "self_reference" },
    { discovery_ordinal: 3, suppressed_reason: "excluded_x_chrome" },
    { discovery_ordinal: 6, suppressed_reason: "excluded_media" },
    { discovery_ordinal: 7, suppressed_reason: "unsafe_destination" },
  ]);
  expect(
    store.db
      .query(
        `SELECT key_type, key_value FROM resources
         WHERE key_type LIKE 'x:%' ORDER BY key_type, key_value`,
      )
      .all(),
  ).toEqual([
    { key_type: "x:article", key_value: "987" },
    { key_type: "x:status", key_value: "123" },
    { key_type: "x:status", key_value: "456" },
  ]);
  const provenance = store.db
    .query(
      `SELECT ingress, raw_metadata FROM provenance
       WHERE evidence_type='url_extraction' AND raw_metadata LIKE '%historical-fixture%'`,
    )
    .get() as { ingress: string; raw_metadata: string };
  expect(provenance.ingress).toBe("linkctl");
  expect(JSON.parse(provenance.raw_metadata).extractor).toEqual({
    name: "historical-extractor",
    version: "0.9.0",
    implementation: "archived-provider",
    implementation_version: "historical-fixture",
  });
  expect(root.extractor.name).toBe("historical-extractor");
  store.close();
});

test("historical X article fixture remains readable without child intent", async () => {
  const { store, artifacts } = setup();
  const queued = enqueue(
    store,
    "https://twitter.com/writer/article/987?utm_source=timeline",
    "zero-relations",
    "linkctl",
  );
  await installHistoricalFixture(
    artifacts,
    queued.id,
    "prescraped_x_article.json",
  );
  const result = await runWorker(store, {
    once: true,
    workerId: "zero-worker",
    now: () => T0,
    artifactStore: artifacts,
    extract: async () => {
      throw new Error(
        "historical extraction must not invoke the live provider",
      );
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 1 });
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(
    store.db
      .query(
        "SELECT title, source_type, content_kind, content_item_count FROM documents",
      )
      .get(),
  ).toEqual({
    title: "A Structured X Article",
    source_type: "tweet_article",
    content_kind: "article",
    content_item_count: 1,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM observations").get(),
  ).toEqual({ count: 0 });
  const provenance = store.db
    .query(
      `SELECT ingress, raw_metadata FROM provenance
       WHERE evidence_type='url_extraction' AND raw_metadata LIKE '%historical-fixture%'`,
    )
    .get() as { ingress: string; raw_metadata: string };
  expect(provenance.ingress).toBe("linkctl");
  expect(JSON.parse(provenance.raw_metadata).extractor).toEqual({
    name: "historical-extractor",
    version: "0.9.0",
    implementation: "archived-provider",
    implementation_version: "historical-fixture",
  });
  store.close();
});

test("fanout admits exactly 25 children and durably suppresses every excess discovery", async () => {
  const { store, artifacts } = setup();
  const rootUrl = "https://x.com/person/status/500";
  const discovered = Array.from(
    { length: LINKED_FAN_OUT_LIMIT + 5 },
    (_, index) => `https://child.example/story-${index + 1}`,
  );
  enqueue(store, rootUrl, "bounded-root");
  const calls: string[] = [];
  const result = await runWorker(store, {
    once: true,
    workerId: "bounded-worker",
    now: () => T0,
    artifactStore: artifacts,
    extract: async (url) => {
      calls.push(url);
      return url === rootUrl
        ? envelope(
            url,
            discovered.map((target_url) => ({
              relation_type: "references",
              target_url,
            })),
            { contentType: "social_post" },
          )
        : envelope(url);
    },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({
    claimed: LINKED_FAN_OUT_LIMIT + 1,
    completed: LINKED_FAN_OUT_LIMIT + 1,
  });
  expect(calls).toEqual([rootUrl, ...discovered.slice(0, 25)]);
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 26,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resource_relations").get(),
  ).toEqual({ count: 25 });
  expect(
    store.db
      .query(
        `SELECT COUNT(*) AS count FROM observations
         WHERE suppressed=1 AND suppressed_reason='fanout_limit'`,
      )
      .get(),
  ).toEqual({ count: 5 });
  store.close();
});

test("two parents share one child lifecycle while retaining independent provenance and replay is inert", async () => {
  const { store, artifacts } = setup();
  const shared = "https://shared.example/story";
  const parentOne = "https://x.com/person/status/1";
  const parentTwo = "https://twitter.com/person/status/2";
  const first = enqueue(store, parentOne, "parent-one", "saved-one");
  const second = enqueue(store, parentTwo, "parent-two", "saved-two");
  const calls: string[] = [];
  const extract = async (url: string): Promise<ExtractionSuccess> => {
    calls.push(url);
    return url === shared
      ? envelope(url)
      : envelope(url, [{ relation_type: "references", target_url: shared }], {
          contentType: "social_post",
        });
  };
  await runWorker(store, {
    once: true,
    workerId: "shared-worker",
    now: () => T0,
    artifactStore: artifacts,
    extract,
    installSignalHandlers: false,
  });

  expect(calls).toEqual([parentOne, parentTwo, shared]);
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 3,
  });
  expect(
    store.db
      .query(
        `SELECT source_job_id FROM resource_relations
         ORDER BY source_job_id`,
      )
      .all(),
  ).toEqual([{ source_job_id: first.id }, { source_job_id: second.id }]);
  expect(
    store.db
      .query(
        `SELECT ingress FROM observations
         WHERE observed_locator=? ORDER BY source_job_id`,
      )
      .all(shared),
  ).toEqual([{ ingress: "saved-one" }, { ingress: "saved-two" }]);
  expect(
    store.db
      .query(
        `SELECT COUNT(DISTINCT to_resource_id) AS count
         FROM resource_relations`,
      )
      .get(),
  ).toEqual({ count: 1 });

  const replay = await runWorker(store, {
    once: true,
    workerId: "replay-worker",
    now: () => at(1),
    artifactStore: artifacts,
    extract,
    installSignalHandlers: false,
  });
  expect(replay).toMatchObject({ claimed: 0, completed: 0 });
  expect(calls).toEqual([parentOne, parentTwo, shared]);
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM observations").get(),
  ).toEqual({ count: 2 });
  store.close();
});

test("child failure and retry never re-extract the parent and survive parent document deletion", async () => {
  const { store, artifacts } = setup();
  const rootUrl = "https://x.com/person/status/700";
  const childUrl = "https://child.example/retry";
  const parent = enqueue(store, rootUrl, "retry-parent");
  const calls: string[] = [];
  let childFails = true;
  const extract = async (url: string): Promise<ExtractionSuccess> => {
    calls.push(url);
    if (url === childUrl && childFails) {
      throw new AgentscrapeExtractionError(
        "child temporarily unavailable",
        "item_transient",
        "item",
      );
    }
    return url === rootUrl
      ? envelope(url, [{ relation_type: "references", target_url: childUrl }], {
          contentType: "social_post",
        })
      : envelope(url);
  };
  const policy = {
    itemBaseMs: 1_000,
    itemCapMs: 1_000,
    jitterRatio: 0,
  };
  const first = await runWorker(store, {
    once: true,
    workerId: "first-child-attempt",
    now: () => T0,
    artifactStore: artifacts,
    extract,
    policy,
    installSignalHandlers: false,
  });

  expect(first).toMatchObject({ claimed: 2, completed: 1, failed: 1 });
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(parent.id),
  ).toEqual({ state: "completed", attempt_count: 1 });
  const child = store.db
    .query("SELECT id, state, attempt_count FROM jobs WHERE id<>?")
    .get(parent.id) as { id: number; state: string; attempt_count: number };
  expect(child).toMatchObject({ state: "retry_wait", attempt_count: 1 });

  const parentResource = store.db
    .query("SELECT resource_id FROM jobs WHERE id=?")
    .get(parent.id) as { resource_id: number };
  const parentDocument = store.db
    .query("SELECT document_id FROM resources WHERE id=?")
    .get(parentResource.resource_id) as { document_id: number };
  store.deleteDocument({
    documentId: parentDocument.document_id,
    confirm: "delete",
  });
  // Deleting the parent document purges the parent Resource (ADR 0018), and the
  // schema cascades the relation with it: a relation whose source no longer
  // exists describes nothing. What must survive is the child's own work, which
  // the retry below asserts — it completes without re-extracting the parent.
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resource_relations").get(),
  ).toEqual({ count: 0 });

  childFails = false;
  const retry = await runWorker(store, {
    once: true,
    workerId: "second-child-attempt",
    now: () => at(1_000),
    artifactStore: artifacts,
    extract,
    policy,
    installSignalHandlers: false,
  });
  expect(retry).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(calls).toEqual([rootUrl, childUrl, childUrl]);
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(parent.id),
  ).toEqual({ state: "completed", attempt_count: 1 });
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(child.id),
  ).toEqual({ state: "completed", attempt_count: 2 });
  // The retry does not resurrect the relation either: its source Resource was
  // purged, and the child's own Resource and document are what it produces.
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resource_relations").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("an admitted X child records but does not enqueue a second automatic hop", async () => {
  const { store, artifacts } = setup();
  const rootUrl = "https://x.com/person/status/800";
  const childUrl = "https://x.com/other/status/801";
  const grandchildUrl = "https://grandchild.example/story";
  enqueue(store, rootUrl, "one-hop-root");
  const calls: string[] = [];
  await runWorker(store, {
    once: true,
    workerId: "one-hop-worker",
    now: () => T0,
    artifactStore: artifacts,
    extract: async (url) => {
      calls.push(url);
      return envelope(
        url,
        url === rootUrl
          ? [{ relation_type: "references", target_url: childUrl }]
          : [{ relation_type: "references", target_url: grandchildUrl }],
        { contentType: "social_post" },
      );
    },
    installSignalHandlers: false,
  });

  expect(calls).toEqual([rootUrl, "https://x.com/i/status/801"]);
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 2,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resource_relations").get(),
  ).toEqual({ count: 1 });
  expect(
    store.db
      .query(
        `SELECT observed_locator, suppressed_reason FROM observations
         WHERE suppressed=1`,
      )
      .get(),
  ).toEqual({
    observed_locator: grandchildUrl,
    suppressed_reason: "one_hop_limit",
  });
  store.close();
});

test("a fanout write failure rolls back parent indexing, relations, observations, and child jobs", async () => {
  const { store, artifacts } = setup();
  const rootUrl = "https://x.com/person/status/900";
  const childUrl = "https://child.example/atomic";
  const parent = enqueue(store, rootUrl, "atomic-root");
  const commitFanout = store.commitUrlFanout.bind(store);
  store.commitUrlFanout = ((input) => {
    commitFanout(input);
    throw new Error("simulated fanout storage temporarily unavailable");
  }) as ResearchStore["commitUrlFanout"];

  const result = await runWorker(store, {
    once: true,
    workerId: "atomic-worker",
    now: () => T0,
    artifactStore: artifacts,
    extract: async (url) =>
      envelope(url, [{ relation_type: "references", target_url: childUrl }], {
        contentType: "social_post",
      }),
    policy: { infraBaseMs: 1_000, infraCapMs: 1_000, jitterRatio: 0 },
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
  expect(
    store.db.query("SELECT state FROM jobs WHERE id=?").get(parent.id),
  ).toEqual({ state: "retry_wait" });
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  for (const table of [
    "documents",
    "resources",
    "resource_relations",
    "observations",
    "provenance",
  ]) {
    expect(
      store.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    ).toEqual({ count: 0 });
  }
  store.close();
});
