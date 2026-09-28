import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api } from "../api.js";
import { serveApi, socketCall } from "@agentstack/api";
import { FeedError } from "../src/feed.js";
import { ArchiveStore, twoMonthsAgo, type Post } from "../src/store.js";
import { ArchiveSync, type Provider } from "../src/sync.js";

const now = new Date("2026-09-28T12:00:00Z");
const post = (id: string, text = `post ${id}`, date = "2026-09-25T12:00:00Z", extra: Record<string, unknown> = {}): Post =>
  ({ id, text, createdAtISO: date, author: { id: "7", screenName: "example", name: "Example", description: "bio" }, ...extra });
const call = async (store: ArchiveStore, name: string, input: Record<string, unknown>) => {
  const operation = api.operations.find(item => item.name === name)!;
  const ctx = { store, sync: {} as ArchiveSync, autoSync: false };
  return operation.output.parse(await operation.call(ctx, operation.input.parse(input))) as Record<string, any>;
};

async function withStore(body: (store: ArchiveStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "xcom-test-"));
  const store = new ArchiveStore(join(root, "xcom", "following.sqlite3"));
  try { await body(store); } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test("full articles have a separate FTS projection, rich filters, user observations and citation budgets", async () => {
  await withStore(async store => {
    const head = store.begin(2, now, twoMonthsAgo(now));
    store.savePage(head, [post("100", "database tutorial", undefined, { articleTitle: "Long Read" }),
      post("200", "database update", "2026-09-26T12:00:00Z", { author: { id: "8", screenName: "other", name: "Other" } })], null, now);
    assert.equal((await call(store, "xcom_articles_pending", { authorId: "7" })).results[0].title, "Long Read");
    assert.equal((await call(store, "xcom_search", { query: "database", articleState: "unfetched" })).results.length, 1);
    assert.equal((await call(store, "xcom_search", { query: "database", articleState: "none" })).results.length, 1);
    store.saveArticle("100", { id: "100", articleTitle: "Vector systems", articleText: "Neural retrieval through dense representations" }, now);
    assert.equal((await call(store, "xcom_articles_pending", {})).results.length, 0);
    assert.equal((await call(store, "xcom_search", { query: "database", articleState: "fetched" })).results.length, 1);
    assert.equal(store.count("tweets_fts"), 2);
    assert.equal(store.count("users"), 2);
    const tweet = await call(store, "xcom_search", { query: "database", scope: "tweets", authorId: "7", dateFrom: "2026-09-01" });
    assert.deepEqual(tweet.results.map((r: any) => [r.tweet_id, r.kind]), [["100", "tweet"]]);
    const article = await call(store, "xcom_search", { query: "neural", scope: "articles", author: "@example", hasArticle: true });
    assert.deepEqual(article.results.map((r: any) => [r.tweet_id, r.kind]), [["100", "article"]]);
    assert.equal((await call(store, "xcom_search", { query: "neural", scope: "tweets" })).results.length, 0);
    assert.equal((await call(store, "xcom_search", { query: "neural", scope: "articles", dateTo: "2026-09-01" })).results.length, 0);
    const context = await call(store, "xcom_context", { query: "retrieval", scope: "articles" });
    assert.match(context.hits[0].content, /Neural retrieval/);
    assert.match(context.hits[0].citation, /tweet_id:100:article/);
    assert.equal((await call(store, "xcom_list", { hasArticle: true })).results.length, 1);
    assert.equal((await call(store, "xcom_get", { tweetId: "100" })).article.text, "Neural retrieval through dense representations");
    assert.equal((await call(store, "xcom_users", { query: "exam" })).results[0].archived_posts, 1);
    assert.equal((await call(store, "xcom_user_get", { handle: "@example" })).payload.description, "bio");
    store.db.prepare("UPDATE articles SET text=? WHERE tweet_id=?").run("Completely different corpus", "100");
    assert.equal((await call(store, "xcom_search", { query: "retrieval", scope: "articles" })).results.length, 0);
    assert.equal((await call(store, "xcom_search", { query: "corpus", scope: "articles" })).results.length, 1);
    store.db.prepare("DELETE FROM articles WHERE tweet_id=?").run("100");
    assert.equal((await call(store, "xcom_search", { query: "corpus", scope: "articles" })).results.length, 0);
    assert.equal((await call(store, "xcom_search", { query: "database", scope: "tweets" })).results.length, 2);
    assert.equal((await call(store, "xcom_articles_pending", {})).results.length, 1);
    assert.equal(store.articleCounts().unfetched, 1);
    store.articleMissing("100", "not_found", now);
    assert.equal((await call(store, "xcom_articles_pending", {})).results[0].error, "not_found");
    assert.equal(store.pendingArticles(10, now).length, 0);
    await assert.rejects(call(store, "xcom_search", { query: "database", dateFrom: "2026-09-30", dateTo: "2026-09-01" }), /later/);
    await assert.rejects(call(store, "xcom_list", { hasArticle: true, articleState: "fetched" }), /not both/);
  });
});

test("a copied xarchive schema and existing FTS triggers are upgraded without changing posts or cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "xcom-copy-"));
  const path = join(root, "following.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE tweets (id TEXT PRIMARY KEY, created_at TEXT, author_id TEXT, author_handle TEXT,
    text TEXT, payload_json TEXT NOT NULL, archived_at TEXT NOT NULL);
    CREATE TABLE scan_state (id INTEGER PRIMARY KEY CHECK (id=1), started_at TEXT NOT NULL,
    cutoff TEXT NOT NULL, mode TEXT NOT NULL, cursor TEXT, visited TEXT NOT NULL,
    pages INTEGER NOT NULL, known_streak INTEGER NOT NULL, old_streak INTEGER NOT NULL);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE articles (tweet_id TEXT PRIMARY KEY REFERENCES tweets(id), title TEXT NOT NULL,
      text TEXT NOT NULL, payload_json TEXT NOT NULL, fetched_at TEXT NOT NULL);
    CREATE TABLE article_attempts (tweet_id TEXT PRIMARY KEY REFERENCES tweets(id), attempted_at TEXT NOT NULL, error TEXT NOT NULL);
    CREATE VIRTUAL TABLE tweets_fts USING fts5(tweet_id UNINDEXED, title, content, source_uri,
      tokenize='porter unicode61 remove_diacritics 2');
    CREATE TRIGGER tweets_fts_insert AFTER INSERT ON tweets BEGIN
      INSERT INTO tweets_fts(rowid, tweet_id, title, content, source_uri)
      VALUES (new.rowid, new.id, COALESCE(new.author_handle, ''), COALESCE(new.text, ''), 'https://x.com/i/status/' || new.id);
    END;`);
  legacy.prepare("INSERT INTO tweets VALUES (?, ?, ?, ?, ?, ?, ?)").run("old", now.toISOString(), "7", "example", "history", JSON.stringify(post("old", "history")), now.toISOString());
  legacy.prepare("INSERT INTO articles VALUES (?, ?, ?, ?, ?)").run("old", "Archive", "migration text", "{}", now.toISOString());
  legacy.prepare("INSERT INTO scan_state VALUES (1, ?, ?, 'initial', 'saved', '[\"saved\"]', 1, 0, 0)")
    .run(now.toISOString(), twoMonthsAgo(now).toISOString());
  legacy.close();
  const store = new ArchiveStore(path);
  try {
    assert.equal(store.scan(1)?.cursor, "saved");
    assert.equal((await call(store, "xcom_search", { query: "migration", scope: "articles" })).results.length, 1);
    assert.equal((await call(store, "xcom_search", { query: "history", scope: "tweets" })).results.length, 1);
    store.begin(2, now, twoMonthsAgo(now)); // legacy CHECK(id=1) must not block head scans
    assert.equal(store.scan(2)?.id, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("head refresh is independent of resumable backfill, failed pages keep their cursor, and repeats fail closed", async () => {
  await withStore(async store => {
    const seen: Array<string | null> = [];
    let fail = true;
    const provider: Provider = {
      async page(cursor) {
        seen.push(cursor);
        if (cursor === null) return { posts: [post("recent")], nextCursor: "c1" };
        if (fail) throw new FeedError("rate_limit", false);
        return { posts: [post("older")], nextCursor: null };
      },
      async article() { throw new Error("not called"); },
    };
    const sync = new ArchiveSync(store, provider, { auto: false, now: () => now, delayMin: 0, delayMax: 0, sleep: async () => {} });
    const wait = async () => { while (sync.state.running) await new Promise(resolve => setTimeout(resolve, 1)); };
    assert.deepEqual(sync.start("backfill"), { started: true, mode: "backfill" });
    await wait();
    assert.match(sync.state.last_error!, /rate_limit/);
    assert.equal(store.scan(1)?.cursor, "c1");
    sync.start("head"); await wait();
    assert.equal(store.scan(1)?.cursor, "c1");
    fail = false;
    sync.start("backfill"); await wait();
    assert.equal(store.scan(1), null);
    assert.deepEqual(seen, [null, "c1", null, "c1", "c1"]);
    assert.equal(store.count("tweets"), 2);
    await sync.close();
  });
});

test("calendar two-month cutoff clips month ends", () => {
  assert.equal(twoMonthsAgo(new Date("2026-03-31T12:00:00Z")).toISOString(), "2026-01-31T12:00:00.000Z");
  assert.equal(twoMonthsAgo(new Date("2026-04-30T12:00:00Z")).toISOString(), "2026-02-28T12:00:00.000Z");
});

test("fifty-page batch retains head cursor and explicit backfill can rescan the rolling window", async () => {
  await withStore(async store => {
    const cursors: Array<string | null> = [];
    const provider: Provider = {
      async page(cursor) {
        cursors.push(cursor);
        const page = cursor === null ? 0 : Number(cursor);
        return { posts: [post(String(page), `batch ${page}`)], nextCursor: page === 51 ? null : String(page + 1) };
      }, async article() { throw new Error("not called"); },
    };
    const sync = new ArchiveSync(store, provider, { auto: false, now: () => now, delayMin: 0, delayMax: 0 });
    const wait = async () => { while (sync.state.running) await new Promise(resolve => setTimeout(resolve, 1)); };
    sync.start("head"); await wait();
    assert.equal(store.scan(2)?.cursor, "50");
    assert.equal(store.scan(2)?.pages, 50);
    sync.start("head"); await wait();
    assert.equal(cursors[50], "50");
    assert.equal(store.scan(2), null);
    sync.start("backfill"); await wait();
    assert.equal(store.scan(1)?.cursor, "50");
    sync.start("backfill"); await wait();
    assert.equal(store.scan(1), null);
    assert.equal(store.meta("last_complete_start"), now.toISOString());
    sync.start("backfill"); await wait();
    assert.equal(cursors.at(-1), "49"); // a new rolling scan, not a no-op
    assert.equal(store.scan(1)?.cursor, "50");
    await sync.close();
  });
});

test("shared socket serves typed xcom operations in disposable state without touching a real CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "xcom-socket-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root,
    AGENTSTACK_XCOM_TWITTER: join(root, "does-not-exist-twitter") };
  const server = await serveApi({ name: "xcom", transport: "socket", env });
  try {
    const path = join(root, "sockets", "xcom.sock");
    assert.equal(server.socketPath, path);
    const tools = await socketCall(path, "tools/list") as { tools: Array<{ name: string }> };
    assert.ok(tools.tools.some(tool => tool.name === "xcom_users"));
    const status = await socketCall(path, "tools/call", { name: "xcom_status", arguments: {} }) as { database: string; tweets: number; auto_sync: boolean };
    assert.equal(status.database, join(root, "xcom", "following.sqlite3"));
    assert.equal(status.tweets, 0);
    assert.equal(status.auto_sync, false);
    const search = await socketCall(path, "tools/call", { name: "xcom_search", arguments: { query: "research", scope: "articles" } }) as { results: unknown[] };
    assert.deepEqual(search.results, []);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
