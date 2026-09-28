import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { ArchiveStore, archivePath, type Filters } from "./src/store.js";
import { ArchiveSync, cliProvider } from "./src/sync.js";

export type XcomContext = { store: ArchiveStore; sync: ArchiveSync; autoSync: boolean };

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "date must be a valid YYYY-MM-DD");
const filters = z.strictObject({
  author: z.string().min(1).max(100).optional().describe("Observed author handle, with or without @; case-insensitive."),
  authorId: z.string().min(1).max(100).optional().describe("Stable observed author ID; avoids ambiguity when handles change."),
  dateFrom: isoDay.optional().describe("Inclusive post creation date (UTC)."),
  dateTo: isoDay.optional().describe("Inclusive post creation date (UTC)."),
  archivedFrom: isoDay.optional().describe("Inclusive first-archived date (UTC), not post creation date."),
  archivedTo: isoDay.optional().describe("Inclusive first-archived date (UTC)."),
  hasArticle: z.boolean().optional().describe("Limit to posts with a fetched full article body, or without one. For article-only search this is implicit."),
});
const pagination = z.strictObject({ limit: z.number().int().min(1).max(50).default(10), offset: z.number().int().min(0).max(1_000_000).default(0) });
const searchInput = filters.extend({
  query: z.string().min(1).max(2000), mode: z.enum(["any", "all", "raw"]).default("any"),
  scope: z.enum(["all", "tweets", "articles"]).default("all").describe("Search tweet text, full X Article title/body, or both; each matching kind is a separate hit."),
  sort: z.enum(["relevance", "recent"]).default("relevance").describe("FTS5 rank or newest post creation time first; no semantic vectors."),
  ...pagination.shape,
});
const hit = z.object({ tweet_id: z.string(), kind: z.enum(["tweet", "article"]), author_id: z.string().nullable(),
  author_handle: z.string().nullable(), created_at: z.string().nullable(), archived_at: z.string(),
  source_uri: z.string(), score: z.number(), snippet: z.string(), title: z.string().nullable() });
const read = { readOnlyHint: true } as const;

function checkFilters(input: Filters): void {
  if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) throw new Error("dateFrom is later than dateTo");
  if (input.archivedFrom && input.archivedTo && input.archivedFrom > input.archivedTo) throw new Error("archivedFrom is later than archivedTo");
  if (input.author?.replace(/^@/, "").trim() === "") throw new Error("author handle cannot be empty");
}

export const api: PackageApi<XcomContext> = {
  operations: [
    operation({ name: "xcom_status", description: "Inspect archive counts, active sync, last head/backfill stop reasons and saved cursors. Coverage is best-effort, not a complete following graph or proof of every post in the two-month window.",
      input: z.strictObject({}), output: z.object({ database: z.string(), auto_sync: z.boolean(), tweets: z.number(), articles: z.number(), users: z.number(),
        sync: z.object({ running: z.boolean(), mode: z.enum(["head", "backfill", "articles"]).nullable(), started_at: z.string().nullable(),
          last_finished_at: z.string().nullable(), last_error: z.string().nullable(), pages: z.number(), new_posts: z.number(), new_articles: z.number() }),
        head: z.object({ started_at: z.string().nullable(), cursor: z.string().nullable(), pages: z.number(), last_start: z.string().nullable(), stop_reason: z.string().nullable() }),
        backfill: z.object({ started_at: z.string().nullable(), cursor: z.string().nullable(), pages: z.number(), last_start: z.string().nullable(), stop_reason: z.string().nullable() }) }), annotations: read,
      async call(ctx) {
        const scan = ctx.store.scan(1), head = ctx.store.scan(2);
        return { database: ctx.store.path, auto_sync: ctx.autoSync, tweets: ctx.store.count("tweets"), articles: ctx.store.count("articles"), users: ctx.store.count("users"),
          sync: { ...ctx.sync.state },
          head: { started_at: head?.started_at ?? null, cursor: head?.cursor ?? null, pages: head?.pages ?? 0,
            last_start: ctx.store.meta("last_head_start"), stop_reason: ctx.store.meta("last_head_stop_reason") },
          backfill: { started_at: scan?.started_at ?? null, cursor: scan?.cursor ?? null, pages: scan?.pages ?? 0,
            last_start: ctx.store.meta("last_complete_start"), stop_reason: ctx.store.meta("last_scan_stop_reason") } };
      } }),
    operation({ name: "xcom_sync", description: "Start a nonblocking following-feed scan. Head refresh begins at the latest posts; backfill resumes its durable cursor, or starts a fresh two-calendar-month rescan if finished. Each run saves up to 50 pages and its cursor (1500 total per scan). Auto prioritizes a due head refresh. Admission is not completion; inspect xcom_status. Uses the authenticated local twitter CLI with paced requests.",
      input: z.strictObject({ mode: z.enum(["auto", "head", "backfill"]).default("auto") }),
      output: z.object({ started: z.boolean(), mode: z.enum(["head", "backfill", "articles"]).nullable() }),
      async call(ctx, { mode }) { return ctx.sync.start(mode); } }),
    operation({ name: "xcom_articles_sync", description: "Start nonblocking catch-up for up to 50 unfetched full X Articles on archived posts. The feed only includes article titles; this uses the authenticated local twitter CLI. Inspect xcom_status for completion or errors.",
      input: z.strictObject({}), output: z.object({ started: z.boolean(), mode: z.enum(["head", "backfill", "articles"]).nullable() }),
      async call(ctx) { return ctx.sync.start("articles"); } }),
    operation({ name: "xcom_search", description: "Search archived tweet text and/or fetched full X Article title/body with FTS5, not embeddings. Filter by author ID/handle, post or archive date range, and article availability. Returns ranked highlighted snippets or newest first with bounded pagination. Feed coverage is best-effort.",
      input: searchInput, output: z.object({ query: z.string(), normalized_query: z.string(), mode: z.string(), scope: z.string(), sort: z.string(),
        filters, limit: z.number(), offset: z.number(), results: z.array(hit), next_offset: z.number().nullable() }), annotations: read,
      async call(ctx, { query, mode, scope, sort, limit, offset, ...selected }) {
        checkFilters(selected);
        const result = ctx.store.search(query, mode, selected, limit, offset, sort, scope);
        return { query, normalized_query: result.normalized, mode, scope, sort, filters: selected, limit, offset,
          results: result.rows.map(({ content: _content, ...row }) => row), next_offset: result.nextOffset };
      } }),
    operation({ name: "xcom_context", description: "Find citation-ready tweet and/or full-article text with the same FTS5 and author/time filters as xcom_search. Enforces a total character budget and reports truncation; citation anchors are stable tweet IDs and X status URLs.",
      input: searchInput.omit({ offset: true }).extend({ limit: z.number().int().min(1).max(20).default(6), maxChars: z.number().int().min(500).max(50_000).default(12_000) }),
      output: z.object({ query: z.string(), scope: z.string(), filters, returned_chars: z.number(), truncated: z.boolean(),
        hits: z.array(hit.extend({ citation: z.string(), content: z.string(), truncated: z.boolean() })) }), annotations: read,
      async call(ctx, { query, mode, scope, sort, limit, maxChars, ...selected }) {
        checkFilters(selected);
        const result = ctx.store.search(query, mode, selected, limit, 0, sort, scope);
        let remaining = maxChars;
        const hits = [];
        for (const row of result.rows) {
          if (!remaining) break;
          const { content, ...fields } = row;
          const selectedText = content.slice(0, remaining);
          remaining -= selectedText.length;
          hits.push({ ...fields, citation: `[tweet_id:${row.tweet_id}:${row.kind}] ${row.source_uri}`,
            content: selectedText, truncated: selectedText.length < content.length });
        }
        return { query, scope, filters: selected, returned_chars: maxChars - remaining,
          truncated: result.nextOffset !== null || hits.length < result.rows.length || hits.some(hit => hit.truncated), hits };
      } }),
    operation({ name: "xcom_list", description: "Traverse archived posts newest first without a search term. Filter by observed author ID/handle, post/first-archive UTC dates and fetched-article availability. Returns bounded tweet text and article titles, not full article bodies.",
      input: filters.extend(pagination.shape), output: z.object({ results: z.array(z.object({ tweet_id: z.string(), author_id: z.string().nullable(),
        author_handle: z.string().nullable(), created_at: z.string().nullable(), archived_at: z.string(), source_uri: z.string(),
        content: z.string().nullable(), article_title: z.string().nullable() })), next_offset: z.number().nullable() }), annotations: read,
      async call(ctx, { limit, offset, ...selected }) { checkFilters(selected); return ctx.store.list(selected, limit, offset); } }),
    operation({ name: "xcom_get", description: "Read one archived tweet by stable ID, including original feed JSON and the full X Article body/JSON when fetched. This never fetches from X; absent IDs fail rather than creating records.",
      input: z.strictObject({ tweetId: z.string().min(1).max(100) }), output: z.object({ tweet_id: z.string(), source_uri: z.string(),
        author_handle: z.string().nullable(), created_at: z.string().nullable(), content: z.string().nullable(), payload: z.unknown(),
        article: z.object({ title: z.string(), text: z.string(), fetched_at: z.string(), payload: z.unknown() }).nullable() }), annotations: read,
      async call(ctx, { tweetId }) { const item = ctx.store.get(tweetId); if (!item) throw new Error(`tweet not found: ${tweetId}`); return item as never; } }),
    operation({ name: "xcom_users", description: "Browse observed post authors by optional handle/name fragment, most recently seen first. This is not an authoritative list of accounts followed; the following feed can contain reposts or omit users.",
      input: pagination.extend({ query: z.string().min(1).max(100).optional() }),
      output: z.object({ results: z.array(z.object({ id: z.string(), handle: z.string().nullable(), name: z.string().nullable(),
        description: z.string().nullable(), avatar_url: z.string().nullable(), first_seen_at: z.string(), last_seen_at: z.string(),
        archived_posts: z.number() })), next_offset: z.number().nullable() }), annotations: read,
      async call(ctx, { query, limit, offset }) { return ctx.store.users(query, limit, offset); } }),
    operation({ name: "xcom_user_get", description: "Read the latest observed profile snapshot and archived-post count for one author ID or handle. Handle reuse is ambiguous; prefer stable author ID. This is an observation from cached feed pages, not a live X lookup or proof of following.",
      input: z.strictObject({ id: z.string().min(1).optional(), handle: z.string().min(1).optional() }),
      output: z.object({ id: z.string(), handle: z.string().nullable(), name: z.string().nullable(), description: z.string().nullable(),
        avatar_url: z.string().nullable(), first_seen_at: z.string(), last_seen_at: z.string(), archived_posts: z.number(), payload: z.unknown() }), annotations: read,
      async call(ctx, { id, handle }) {
        if (Boolean(id) === Boolean(handle)) throw new Error("provide exactly one id or handle");
        const item = ctx.store.user(id, handle?.replace(/^@/, ""));
        if (!item) throw new Error("observed author not found");
        return item as never;
      } }),
    operation({ name: "xcom_reindex", description: "Repair both local FTS5 projections and the observed-author catalog after a stopped-service database copy. Expensive on large archives; socket-only operator maintenance. Does not fetch or change source posts.",
      input: z.strictObject({}), output: z.object({ indexed_tweets: z.number(), indexed_articles: z.number(), users: z.number() }),
      async call(ctx) { return ctx.store.transaction(() => { ctx.store.rebuildIndex(); return { indexed_tweets: ctx.store.count("tweets_fts"),
        indexed_articles: ctx.store.count("articles"), users: ctx.store.count("users") }; }); } }),
  ],
  async createContext(env) {
    const store = new ArchiveStore(archivePath(env));
    const setting = env.AGENTSTACK_XCOM_AUTO_SYNC ?? "0";
    if (setting !== "0" && setting !== "1") { store.close(); throw new Error("AGENTSTACK_XCOM_AUTO_SYNC must be 0 or 1"); }
    const autoSync = setting === "1";
    const sync = new ArchiveSync(store, cliProvider(env.AGENTSTACK_XCOM_TWITTER ?? "twitter"), { auto: autoSync });
    return { store, sync, autoSync };
  },
  prepareCloseContext(ctx) { ctx.sync.controller.abort(); },
  async closeContext(ctx) { try { await ctx.sync.close(); } finally { ctx.store.close(); } },
};
