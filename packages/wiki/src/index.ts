import { Database } from "./sqlite.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "./errors.js";
import { extractWikilinks } from "./links.js";
import type { ParsedVaultDocument } from "./vault.js";
import { indexPath, readVaultDocument, walkVault } from "./vault.js";

/** The index is derived: every column here is recomputed from a vault file,
 * and deleting the database loses nothing but time. */
export const INDEX_SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL,
  body TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  created TEXT,
  updated TEXT,
  deleted TEXT,
  deleted_reason TEXT,
  markdown INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_slug ON documents (slug);
CREATE INDEX IF NOT EXISTS documents_deleted ON documents (deleted);

CREATE TABLE IF NOT EXISTS links (
  source_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  alias TEXT
);
CREATE INDEX IF NOT EXISTS links_source ON links (source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
  USING fts5(slug, title, tags, body, tokenize='porter unicode61');
`;

export interface DocumentRow {
  id: number;
  path: string;
  slug: string;
  title: string;
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
  created: string | null;
  updated: string | null;
  deleted: string | null;
  deletedReason: string | null;
  markdown: boolean;
  size: number;
  mtimeMs: number;
}

export interface SearchHit {
  slug: string;
  title: string;
  path: string;
  tags: string[];
  snippet: string;
  score: number;
}

export interface LinkRow {
  sourceId: number;
  sourceSlug: string;
  target: string;
  alias: string | null;
}

export interface ReconcileReport {
  scanned: number;
  indexed: number;
  removed: number;
}

interface RawDocument {
  id: number;
  path: string;
  slug: string;
  title: string;
  tags: string;
  body: string;
  frontmatter: string;
  created: string | null;
  updated: string | null;
  deleted: string | null;
  deleted_reason: string | null;
  markdown: number;
  size: number;
  mtime_ms: number;
}

const LIVE = "documents.deleted IS NULL";

export class VaultIndex {
  private constructor(
    private readonly db: Database,
    readonly root: string,
  ) {}

  static open(root: string): VaultIndex {
    const path = indexPath(root);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");
    try {
      initializeSchema(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return new VaultIndex(db, root);
  }

  close(): void {
    this.db.close();
  }

  /** Agents edit vault files directly, so every read path pays this first.
   * Only files whose size or mtime moved are reparsed. */
  reconcile(): ReconcileReport {
    const files = walkVault(this.root);
    const known = new Map<string, { id: number; size: number; mtime_ms: number }>();
    for (const row of this.db.query("SELECT id, path, size, mtime_ms FROM documents").all() as {
      id: number;
      path: string;
      size: number;
      mtime_ms: number;
    }[]) {
      known.set(row.path, { id: row.id, size: row.size, mtime_ms: row.mtime_ms });
    }
    let indexed = 0;
    const present = new Set<string>();
    const apply = this.db.transaction(() => {
      for (const file of files) {
        const existing = known.get(file.path);
        if (
          existing !== undefined &&
          existing.size === file.size &&
          existing.mtime_ms === file.mtimeMs
        ) {
          present.add(file.path);
          continue;
        }
        const parsed = readVaultDocument(file);
        if (parsed === null) continue;
        this.upsert(parsed);
        present.add(file.path);
        indexed++;
      }
      let removed = 0;
      for (const [path, row] of known) {
        if (present.has(path)) continue;
        this.deleteRow(row.id);
        removed++;
      }
      return removed;
    });
    const removed = apply();
    return { scanned: files.length, indexed, removed };
  }

  /** A full rebuild is the escape hatch when the index is doubted at all. */
  rebuild(): ReconcileReport {
    this.db.transaction(() => {
      this.db.run("DELETE FROM documents");
      this.db.run("DELETE FROM links");
      this.db.run("DELETE FROM documents_fts");
    })();
    return this.reconcile();
  }

  private upsert(parsed: ParsedVaultDocument): void {
    this.db
      .query(
        `INSERT INTO documents
           (path, slug, title, tags, body, frontmatter, created, updated, deleted,
            deleted_reason, markdown, size, mtime_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (path) DO UPDATE SET
           slug = excluded.slug, title = excluded.title, tags = excluded.tags,
           body = excluded.body, frontmatter = excluded.frontmatter,
           created = excluded.created, updated = excluded.updated,
           deleted = excluded.deleted, deleted_reason = excluded.deleted_reason,
           markdown = excluded.markdown, size = excluded.size, mtime_ms = excluded.mtime_ms`,
      )
      .run(
        parsed.path,
        parsed.slug,
        parsed.title,
        JSON.stringify(parsed.tags),
        parsed.body,
        JSON.stringify(parsed.frontmatter),
        parsed.created,
        parsed.updated,
        parsed.deleted,
        parsed.deletedReason,
        parsed.markdown ? 1 : 0,
        parsed.size,
        parsed.mtimeMs,
      );
    const row = this.db.query("SELECT id FROM documents WHERE path = ?").get(parsed.path) as {
      id: number;
    } | null;
    if (row === null) return;
    this.db.query("DELETE FROM links WHERE source_id = ?").run(row.id);
    if (parsed.markdown) {
      const insert = this.db.query("INSERT INTO links (source_id, target, alias) VALUES (?, ?, ?)");
      for (const link of extractWikilinks(parsed.body)) {
        insert.run(row.id, link.target, link.alias ?? null);
      }
    }
    this.db.query("DELETE FROM documents_fts WHERE rowid = ?").run(row.id);
    this.db
      .query("INSERT INTO documents_fts (rowid, slug, title, tags, body) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, parsed.slug, parsed.title, parsed.tags.join(" "), parsed.body);
  }

  private deleteRow(id: number): void {
    this.db.query("DELETE FROM links WHERE source_id = ?").run(id);
    this.db.query("DELETE FROM documents_fts WHERE rowid = ?").run(id);
    this.db.query("DELETE FROM documents WHERE id = ?").run(id);
  }

  /** Tombstoned documents are excluded here, once, so no caller can forget. */
  documents(
    options: { includeDeleted?: boolean; tag?: string; limit?: number } = {},
  ): DocumentRow[] {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.includeDeleted !== true) clauses.push(LIVE);
    if (options.tag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(documents.tags) WHERE value = ?)");
      parameters.push(options.tag);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) parameters.push(options.limit);
    const rows = this.db
      .query(
        `SELECT * FROM documents ${where}
         ORDER BY COALESCE(updated, created, '') DESC, mtime_ms DESC, slug ASC${limit}`,
      )
      .all(...parameters) as RawDocument[];
    return rows.map(hydrate);
  }

  byPath(path: string): DocumentRow | null {
    const row = this.db
      .query("SELECT * FROM documents WHERE path = ?")
      .get(path) as RawDocument | null;
    return row === null ? null : hydrate(row);
  }

  search(options: { query: string; tag?: string; limit: number }): SearchHit[] {
    const match = toFtsQuery(options.query);
    if (match === null) {
      throw new CliError("empty_query", "search needs at least one searchable term");
    }
    const parameters: (string | number)[] = [match];
    let tagClause = "";
    if (options.tag !== undefined) {
      tagClause = " AND EXISTS (SELECT 1 FROM json_each(documents.tags) WHERE value = ?)";
      parameters.push(options.tag);
    }
    parameters.push(options.limit);
    let rows: {
      slug: string;
      title: string;
      path: string;
      tags: string;
      snippet: string;
      score: number;
    }[];
    try {
      rows = this.db
        .query(
          `SELECT documents.slug AS slug, documents.title AS title, documents.path AS path,
                  documents.tags AS tags,
                  snippet(documents_fts, 3, '[', ']', ' … ', 14) AS snippet,
                  bm25(documents_fts) AS score
           FROM documents_fts
           JOIN documents ON documents.id = documents_fts.rowid
           WHERE documents_fts MATCH ?1 AND ${LIVE}${tagClause}
           ORDER BY score ASC LIMIT ?${options.tag === undefined ? 2 : 3}`,
        )
        .all(...parameters) as typeof rows;
    } catch (error) {
      throw new CliError(
        "bad_query",
        `search could not parse "${options.query}": ${(error as Error).message}`,
        "Try plain words; quotes and NEAR/AND/OR are FTS5 syntax.",
      );
    }
    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      path: row.path,
      tags: parseTagsJson(row.tags),
      snippet: row.snippet.replace(/\s+/g, " ").trim(),
      score: row.score,
    }));
  }

  tagCounts(): { tag: string; documents: number }[] {
    return this.db
      .query(
        `SELECT value AS tag, COUNT(*) AS documents
         FROM documents, json_each(documents.tags)
         WHERE ${LIVE}
         GROUP BY value ORDER BY documents DESC, tag ASC`,
      )
      .all() as { tag: string; documents: number }[];
  }

  /** Links are stored raw; resolution needs the whole vault, so it happens
   * at read time against the current candidate set. */
  links(): LinkRow[] {
    const rows = this.db
      .query(
        `SELECT links.source_id AS sourceId, documents.slug AS sourceSlug,
                links.target AS target, links.alias AS alias
         FROM links JOIN documents ON documents.id = links.source_id
         WHERE ${LIVE}
         ORDER BY documents.slug ASC, links.rowid ASC`,
      )
      .all() as LinkRow[];
    return rows;
  }

  duplicateSlugs(): { slug: string; paths: string[] }[] {
    const rows = this.db
      .query(
        `SELECT slug, GROUP_CONCAT(path, char(10)) AS paths
         FROM documents WHERE ${LIVE}
         GROUP BY slug HAVING COUNT(*) > 1 ORDER BY slug ASC`,
      )
      .all() as { slug: string; paths: string }[];
    return rows.map((row) => ({ slug: row.slug, paths: row.paths.split("\n") }));
  }

  counts(): { documents: number; tombstoned: number; links: number } {
    const live = this.db.query(`SELECT COUNT(*) AS n FROM documents WHERE ${LIVE}`).get() as {
      n: number;
    };
    const dead = this.db
      .query("SELECT COUNT(*) AS n FROM documents WHERE deleted IS NOT NULL")
      .get() as {
      n: number;
    };
    const links = this.db.query("SELECT COUNT(*) AS n FROM links").get() as { n: number };
    return { documents: live.n, tombstoned: dead.n, links: links.n };
  }
}

function initializeSchema(db: Database): void {
  const hasMeta = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1")
    .get();
  if (hasMeta !== null) {
    const current = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
      value: string;
    } | null;
    const version = Number(current?.value ?? 0);
    if (version === INDEX_SCHEMA_VERSION) return;
    if (!Number.isInteger(version)) {
      throw new CliError("bad_schema_version", "index schema_version is not an integer");
    }
    // Refuse loudly rather than truncating what a newer build wrote: the
    // index is rebuildable, but a downgrade must be the operator's choice.
    if (version > INDEX_SCHEMA_VERSION) {
      throw new CliError(
        "unsupported_schema_version",
        `index schema version ${version} is newer than supported version ${INDEX_SCHEMA_VERSION}`,
        "Upgrade agentwiki, or delete the index and run: agentwiki reindex",
      );
    }
  }
  db.transaction(() => {
    db.run(SCHEMA_V1);
    // Future migrations land here as `if (version < N) db.exec(MIGRATION_VN)`.
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(INDEX_SCHEMA_VERSION),
    );
  })();
}

function hydrate(row: RawDocument): DocumentRow {
  return {
    id: row.id,
    path: row.path,
    slug: row.slug,
    title: row.title,
    tags: parseTagsJson(row.tags),
    body: row.body,
    frontmatter: parseFrontmatterJson(row.frontmatter),
    created: row.created,
    updated: row.updated,
    deleted: row.deleted,
    deletedReason: row.deleted_reason,
    markdown: row.markdown === 1,
    size: row.size,
    mtimeMs: row.mtime_ms,
  };
}

function parseTagsJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function parseFrontmatterJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A row written by a build that stored something else is still usable.
  }
  return {};
}

/** Spoken queries are not FTS5 expressions. Every term is quoted so that
 * apostrophes, hyphens and stray operators search instead of failing;
 * a trailing * is the one operator kept, because prefix search is useful. */
export function toFtsQuery(query: string): string | null {
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const prefix = raw.endsWith("*");
    const bare = (prefix ? raw.slice(0, -1) : raw).replace(/"/g, "");
    if (!/[\p{L}\p{N}]/u.test(bare)) continue;
    terms.push(`"${bare}"${prefix ? "*" : ""}`);
  }
  return terms.length === 0 ? null : terms.join(" ");
}
