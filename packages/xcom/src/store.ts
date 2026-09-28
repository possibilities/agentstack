import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Post = Record<string, unknown> & { id: string };
export type Scan = { id: number; started_at: string; cutoff: string; mode: string; cursor: string | null;
  visited: string; pages: number; known_streak: number; old_streak: number };
export type Filters = { author?: string; authorId?: string; dateFrom?: string; dateTo?: string;
  archivedFrom?: string; archivedTo?: string; hasArticle?: boolean };
export type Scope = "all" | "tweets" | "articles";
export type Hit = { tweet_id: string; kind: "tweet" | "article"; author_id: string | null;
  author_handle: string | null; created_at: string | null; archived_at: string;
  source_uri: string; score: number; snippet: string; content: string; title: string | null };

function checkPath(path: string, directory: boolean): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
      throw new Error(`xcom state must ${directory ? "be a real directory" : "be a regular file"}: ${path}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function archivePath(env: NodeJS.ProcessEnv): string {
  return join(env.AGENTSTACK_STATE_DIR ?? join(homedir(), ".local", "state", "agentstack"), "xcom", "following.sqlite3");
}

export class ArchiveStore {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    const root = dirname(path);
    checkPath(root, true);
    checkPath(path, false);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON");
      this.install();
    } catch (error) { this.db.close(); throw error; }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private install(): void {
    // The first five tables retain xarchive's layout. A stopped-service SQLite
    // copy (with its sidecars checkpointed) can be adopted later, explicitly.
    this.db.exec(`CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY, created_at TEXT, author_id TEXT, author_handle TEXT,
      text TEXT, payload_json TEXT NOT NULL, archived_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tweets_created_at ON tweets(created_at);
      CREATE INDEX IF NOT EXISTS tweets_author_archived ON tweets(author_id, archived_at);
      CREATE TABLE IF NOT EXISTS scan_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT NOT NULL, cutoff TEXT NOT NULL, mode TEXT NOT NULL,
        cursor TEXT, visited TEXT NOT NULL, pages INTEGER NOT NULL,
        known_streak INTEGER NOT NULL, old_streak INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS head_scan_state (
        id INTEGER PRIMARY KEY CHECK (id = 2), started_at TEXT NOT NULL, cutoff TEXT NOT NULL, mode TEXT NOT NULL,
        cursor TEXT, visited TEXT NOT NULL, pages INTEGER NOT NULL,
        known_streak INTEGER NOT NULL, old_streak INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS articles (
        tweet_id TEXT PRIMARY KEY REFERENCES tweets(id), title TEXT NOT NULL, text TEXT NOT NULL,
        payload_json TEXT NOT NULL, fetched_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS article_attempts (
        tweet_id TEXT PRIMARY KEY REFERENCES tweets(id), attempted_at TEXT NOT NULL, error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, handle TEXT, name TEXT, description TEXT, avatar_url TEXT,
        payload_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS users_handle ON users(handle COLLATE NOCASE);`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(tweets)").all() as { name: string }[]).map(row => row.name));
    if (!["id", "created_at", "author_handle", "text", "payload_json", "archived_at"].every(key => columns.has(key)))
      throw new Error("xcom database has an incompatible tweets schema");
    this.transaction(() => {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts5(
        tweet_id UNINDEXED, title, content, source_uri, tokenize='porter unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
          tweet_id UNINDEXED, title, content, source_uri, tokenize='porter unicode61 remove_diacritics 2');
        DROP TRIGGER IF EXISTS tweets_fts_insert;
        DROP TRIGGER IF EXISTS tweets_fts_update;
        DROP TRIGGER IF EXISTS tweets_fts_delete;
        DROP TRIGGER IF EXISTS xcom_article_insert;
        DROP TRIGGER IF EXISTS xcom_article_update;
        DROP TRIGGER IF EXISTS xcom_article_delete;
        CREATE TRIGGER tweets_fts_insert AFTER INSERT ON tweets BEGIN
          INSERT INTO tweets_fts(rowid, tweet_id, title, content, source_uri)
          VALUES (new.rowid, new.id, COALESCE(new.author_handle, ''), COALESCE(new.text, ''), 'https://x.com/i/status/' || new.id);
        END;
        CREATE TRIGGER tweets_fts_update AFTER UPDATE ON tweets BEGIN
          DELETE FROM tweets_fts WHERE rowid=old.rowid;
          INSERT INTO tweets_fts(rowid, tweet_id, title, content, source_uri)
          VALUES (new.rowid, new.id, COALESCE(new.author_handle, ''), COALESCE(new.text, ''),
            'https://x.com/i/status/' || new.id);
        END;
        CREATE TRIGGER tweets_fts_delete AFTER DELETE ON tweets BEGIN
          DELETE FROM tweets_fts WHERE rowid=old.rowid;
        END;
        CREATE TRIGGER xcom_article_insert AFTER INSERT ON articles BEGIN
          INSERT INTO articles_fts(rowid, tweet_id, title, content, source_uri)
          SELECT t.rowid, t.id, new.title, new.text,
            'https://x.com/i/status/' || t.id FROM tweets t WHERE t.id=new.tweet_id;
        END;
        CREATE TRIGGER xcom_article_update AFTER UPDATE ON articles BEGIN
          DELETE FROM articles_fts WHERE rowid=(SELECT rowid FROM tweets WHERE id=old.tweet_id);
          INSERT INTO articles_fts(rowid, tweet_id, title, content, source_uri)
          SELECT t.rowid, t.id, new.title, new.text,
            'https://x.com/i/status/' || t.id FROM tweets t WHERE t.id=new.tweet_id;
        END;
        CREATE TRIGGER xcom_article_delete AFTER DELETE ON articles BEGIN
          DELETE FROM articles_fts WHERE rowid=(SELECT rowid FROM tweets WHERE id=old.tweet_id);
        END;`);
      if (this.meta("xcom_fts_version") !== "3") this.rebuildIndex();
    });
  }

  rebuildIndex(): number {
    this.db.exec("DELETE FROM tweets_fts; DELETE FROM articles_fts");
    this.db.exec(`INSERT INTO tweets_fts(rowid, tweet_id, title, content, source_uri)
      SELECT t.rowid, t.id, COALESCE(t.author_handle, ''), COALESCE(t.text, ''), 'https://x.com/i/status/' || t.id FROM tweets t;
      INSERT INTO articles_fts(rowid, tweet_id, title, content, source_uri)
      SELECT t.rowid, t.id, a.title, a.text, 'https://x.com/i/status/' || t.id
      FROM articles a JOIN tweets t ON t.id=a.tweet_id;`);
    this.setMeta("xcom_fts_version", "3");
    // Older xarchive snapshots did not have a users projection. Populate the
    // latest observed profile without touching immutable tweet JSON.
    const profiles = this.db.prepare(`SELECT t.author_id, t.author_handle, t.payload_json, t.archived_at,
      (SELECT min(first.archived_at) FROM tweets first WHERE first.author_id=t.author_id) AS first_seen_at
      FROM tweets t WHERE t.author_id IS NOT NULL AND t.rowid=(
        SELECT latest.rowid FROM tweets latest WHERE latest.author_id=t.author_id
        ORDER BY latest.archived_at DESC, latest.rowid DESC LIMIT 1)`).all() as Array<{
          author_id: string; author_handle: string | null; payload_json: string; archived_at: string; first_seen_at: string }>;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of profiles) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const author = payload.author && typeof payload.author === "object" ? payload.author as Record<string, unknown> : {};
      insert.run(row.author_id, row.author_handle,
        typeof author.name === "string" ? author.name : null,
        typeof author.description === "string" ? author.description : null,
        typeof author.profileImageUrl === "string" ? author.profileImageUrl : null,
        JSON.stringify(author), row.first_seen_at, row.archived_at);
    }
    return this.count("tweets_fts");
  }

  count(table: "tweets" | "articles" | "tweets_fts" | "users"): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  meta(key: string): string | null {
    return (this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  scan(id: 1 | 2): Scan | null {
    return (this.db.prepare(`SELECT * FROM ${id === 1 ? "scan_state" : "head_scan_state"} WHERE id=?`).get(id) as Scan | undefined) ?? null;
  }
  begin(id: 1 | 2, now: Date, cutoff: Date): Scan {
    const mode = id === 1 ? "initial" : "incremental";
    this.db.prepare(`INSERT INTO ${id === 1 ? "scan_state" : "head_scan_state"} VALUES (?, ?, ?, ?, NULL, '[]', 0, 0, 0)`)
      .run(id, now.toISOString(), cutoff.toISOString(), mode);
    return this.scan(id)!;
  }
  finish(scan: Scan, reason: string): void {
    this.db.prepare(`DELETE FROM ${scan.id === 1 ? "scan_state" : "head_scan_state"} WHERE id=?`).run(scan.id);
    const prefix = scan.id === 1 ? "last_scan" : "last_head";
    this.setMeta(`${prefix}_stop_reason`, reason);
    this.setMeta(`${prefix}_pages`, String(scan.pages));
    this.setMeta(scan.id === 1 ? "last_complete_start" : "last_head_start", scan.started_at);
  }
  savePage(scan: Scan, posts: Post[], nextCursor: string | null, now: Date): { saved: number; finished: string | null } {
    const visited = JSON.parse(scan.visited) as string[];
    if (nextCursor && (nextCursor === scan.cursor || visited.includes(nextCursor))) throw new Error("feed cursor repeated; scan remains resumable");
    if (nextCursor) visited.push(nextCursor);
    const cutoff = new Date(scan.cutoff).getTime();
    const dates = posts.map(post => postDate(post));
    const oldOnly = posts.length > 0 && dates.every(date => date !== null && date.getTime() < cutoff);
    return this.transaction(() => {
      let saved = 0;
      const insert = this.db.prepare("INSERT OR IGNORE INTO tweets VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i]!;
        const date = dates[i];
        if (date && date.getTime() < cutoff) continue;
        const author = post.author && typeof post.author === "object" ? post.author as Record<string, unknown> : {};
        saved += Number(insert.run(post.id, date?.toISOString() ?? null,
          typeof author.id === "string" ? author.id : typeof author.id === "number" ? String(author.id) : null,
          typeof author.screenName === "string" ? author.screenName : null,
          typeof post.text === "string" ? post.text : null, JSON.stringify(post), now.toISOString()).changes);
        const authorId = author.id;
        if ((typeof authorId === "string" && authorId) || typeof authorId === "number") {
          const id = String(authorId);
          this.db.prepare(`INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET handle=COALESCE(excluded.handle, users.handle),
              name=COALESCE(excluded.name, users.name), description=COALESCE(excluded.description, users.description),
              avatar_url=COALESCE(excluded.avatar_url, users.avatar_url),
              payload_json=excluded.payload_json, last_seen_at=excluded.last_seen_at`).run(id,
            typeof author.screenName === "string" ? author.screenName : null,
            typeof author.name === "string" ? author.name : null,
            typeof author.description === "string" ? author.description : null,
            typeof author.profileImageUrl === "string" ? author.profileImageUrl : null,
            JSON.stringify(author), now.toISOString(), now.toISOString());
        }
      }
      scan.pages++;
      scan.old_streak = oldOnly ? scan.old_streak + 1 : 0;
      scan.known_streak = posts.length && !saved ? scan.known_streak + 1 : 0;
      const reason = !nextCursor ? "feed_end" : scan.old_streak >= 2 ? "older_pages" :
        scan.id === 2 && scan.known_streak >= 2 ? "known_pages" :
        scan.pages >= 1500 ? "page_cap" : null;
      if (reason) this.finish(scan, reason);
      else this.db.prepare(`UPDATE ${scan.id === 1 ? "scan_state" : "head_scan_state"} SET cursor=?, visited=?, pages=?, known_streak=?, old_streak=? WHERE id=?`)
        .run(nextCursor, JSON.stringify(visited), scan.pages, scan.known_streak, scan.old_streak, scan.id);
      return { saved, finished: reason };
    });
  }

  pendingArticles(limit: number, now: Date = new Date()): string[] {
    return (this.db.prepare(`SELECT t.id FROM tweets t LEFT JOIN articles a ON a.tweet_id=t.id
      LEFT JOIN article_attempts tried ON tried.tweet_id=t.id
      WHERE a.tweet_id IS NULL AND json_type(t.payload_json, '$.articleTitle')='text'
        AND (tried.attempted_at IS NULL OR tried.attempted_at < ?)
      ORDER BY tried.attempted_at IS NOT NULL, t.created_at DESC, tried.attempted_at, t.id DESC LIMIT ?`)
      .all(new Date(now.getTime() - 24 * 3_600_000).toISOString(), limit) as { id: string }[]).map(row => row.id);
  }
  saveArticle(id: string, post: Post, now: Date): void {
    const title = post.articleTitle, text = post.articleText;
    if (String(post.id) !== id || typeof title !== "string" || typeof text !== "string" || !text.trim())
      throw new Error("article returned an invalid or empty body");
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO articles VALUES (?, ?, ?, ?, ?)").run(id, title, text, JSON.stringify(post), now.toISOString());
      this.db.prepare("DELETE FROM article_attempts WHERE tweet_id=?").run(id);
    });
  }
  articleMissing(id: string, message: string, now: Date): void {
    this.db.prepare(`INSERT INTO article_attempts VALUES (?, ?, ?) ON CONFLICT(tweet_id)
      DO UPDATE SET attempted_at=excluded.attempted_at, error=excluded.error`).run(id, now.toISOString(), message.slice(0, 500));
  }

  get(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT id, text, author_handle, created_at, payload_json FROM tweets WHERE id=?").get(id) as
      { id: string; text: string | null; author_handle: string | null; created_at: string | null; payload_json: string } | undefined;
    if (!row) return null;
    const article = this.db.prepare("SELECT title, text, fetched_at, payload_json FROM articles WHERE tweet_id=?").get(id) as
      { title: string; text: string; fetched_at: string; payload_json: string } | undefined;
    return { tweet_id: id, source_uri: `https://x.com/i/status/${id}`, author_handle: row.author_handle,
      created_at: row.created_at, content: row.text, payload: JSON.parse(row.payload_json),
      article: article ? { title: article.title, text: article.text, fetched_at: article.fetched_at, payload: JSON.parse(article.payload_json) } : null };
  }

  search(query: string, mode: "any" | "all" | "raw", filters: Filters, limit: number, offset: number,
    sort: "relevance" | "recent", scope: Scope) {
    const normalized = normalizeQuery(query, mode);
    const { where, args } = predicates(filters);
    const sources = scope === "all" ? ["tweets", "articles"] : [scope];
    const parts = sources.map(source => {
      const fts = source === "tweets" ? "tweets_fts" : "articles_fts";
      return `SELECT t.id AS tweet_id, '${source === "tweets" ? "tweet" : "article"}' AS kind,
        t.author_id, t.author_handle, t.created_at, t.archived_at, f.source_uri,
        f.rank AS score, snippet(${fts}, 2, '⟦', '⟧', ' … ', 48) AS snippet, f.content,
        ${source === "tweets" ? "NULL" : "a.title"} AS title
        FROM ${fts} f JOIN tweets t ON t.rowid=f.rowid
        LEFT JOIN articles a ON a.tweet_id=t.id WHERE ${fts} MATCH ? ${where}`;
    });
    let rows: Hit[];
    try {
      rows = this.db.prepare(`SELECT * FROM (${parts.join(" UNION ALL ")})
        ORDER BY ${sort === "recent" ? "created_at DESC, tweet_id DESC, kind" : "score ASC, created_at DESC, tweet_id DESC, kind"}
        LIMIT ? OFFSET ?`).all(...sources.flatMap(() => [normalized, ...args]), limit + 1, offset) as Hit[];
    } catch (error) { throw new Error(`invalid FTS5 query: ${(error as Error).message}`); }
    return { normalized, rows: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }
  list(filters: Filters, limit: number, offset: number) {
    const { where, args } = predicates(filters);
    const rows = this.db.prepare(`SELECT t.id AS tweet_id, t.author_id, t.author_handle, t.created_at, t.archived_at,
      'https://x.com/i/status/' || t.id AS source_uri, t.text AS content,
      a.title AS article_title FROM tweets t LEFT JOIN articles a ON a.tweet_id=t.id
      WHERE 1=1 ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit + 1, offset) as Array<{ tweet_id: string; author_id: string | null;
        author_handle: string | null; created_at: string | null; archived_at: string; source_uri: string;
        content: string | null; article_title: string | null }>;
    return { results: rows.slice(0, limit), next_offset: rows.length > limit ? offset + limit : null };
  }
  users(query: string | undefined, limit: number, offset: number) {
    const needle = query ? `%${query.replace(/^@/, "").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
    const rows = this.db.prepare(`SELECT u.id, u.handle, u.name, u.description, u.avatar_url,
      u.first_seen_at, u.last_seen_at, (SELECT count(*) FROM tweets t WHERE t.author_id=u.id) AS archived_posts
      FROM users u WHERE ? IS NULL OR u.handle LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\'
      ORDER BY u.last_seen_at DESC, u.id DESC LIMIT ? OFFSET ?`)
      .all(needle, needle, needle, limit + 1, offset) as Array<{ id: string; handle: string | null;
        name: string | null; description: string | null; avatar_url: string | null;
        first_seen_at: string; last_seen_at: string; archived_posts: number }>;
    return { results: rows.slice(0, limit), next_offset: rows.length > limit ? offset + limit : null };
  }
  user(id?: string, handle?: string) {
    const row = this.db.prepare(`SELECT u.*, (SELECT count(*) FROM tweets t WHERE t.author_id=u.id) AS archived_posts
      FROM users u WHERE ${id ? "u.id=?" : "u.handle=? COLLATE NOCASE"} ORDER BY u.last_seen_at DESC LIMIT 1`)
      .get(id ?? handle!) as Record<string, unknown> | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload_json as string), payload_json: undefined } : null;
  }
  close(): void { this.db.close(); }
}

function predicates(filters: Filters): { where: string; args: string[] } {
  const parts: string[] = [], args: string[] = [];
  if (filters.author) { parts.push("t.author_handle = ? COLLATE NOCASE"); args.push(filters.author.replace(/^@/, "")); }
  if (filters.authorId) { parts.push("t.author_id = ?"); args.push(filters.authorId); }
  if (filters.dateFrom) { parts.push("t.created_at >= ?"); args.push(filters.dateFrom); }
  if (filters.dateTo) { parts.push("substr(t.created_at, 1, 10) <= ?"); args.push(filters.dateTo); }
  if (filters.archivedFrom) { parts.push("t.archived_at >= ?"); args.push(filters.archivedFrom); }
  if (filters.archivedTo) { parts.push("substr(t.archived_at, 1, 10) <= ?"); args.push(filters.archivedTo); }
  if (filters.hasArticle !== undefined) parts.push(filters.hasArticle ? "a.tweet_id IS NOT NULL" : "a.tweet_id IS NULL");
  return { where: parts.map(part => `AND ${part}`).join(" "), args };
}

export function postDate(post: Post): Date | null {
  const raw = post.createdAtISO ?? post.createdAt;
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function twoMonthsAgo(date: Date): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - 2);
  const monthEnd = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, monthEnd));
  return result;
}

export function normalizeQuery(query: string, mode: "any" | "all" | "raw"): string {
  if (!query.trim()) throw new Error("search query cannot be empty");
  if (mode === "raw") return query.trim();
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map(match => match[1]!.trim()).filter(Boolean);
  const terms = (query.replace(/"[^"]+"/g, " ").match(/[\p{L}\p{N}_./:@-]+/gu) ?? []);
  const atoms = [...phrases, ...terms].map(part => `"${part.replaceAll('"', '""')}"`);
  if (!atoms.length) throw new Error("search query has no searchable terms");
  return atoms.join(mode === "all" ? " AND " : " OR ");
}
