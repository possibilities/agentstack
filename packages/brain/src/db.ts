import type { Database } from "./sqlite.js";
import { existsSync, statSync } from "node:fs";
import { CliError } from "./errors.js";
import type { QueryFilters } from "./query.js";
import {
  clampLimit,
  domainFromUri,
  exclusiveDateUpperBound,
  nonNegativeOffset,
  normalizeSearchQuery,
  parseTags,
  truncateContent,
  validateQueryFilters,
} from "./query.js";
import { openReadonlyDatabase } from "./sqlite.js";
import { RESEARCH_SCHEMA_VERSION } from "./store.js";
import type {
  Attempt,
  ChunkData,
  ContentKind,
  ContextData,
  DocumentData,
  Job,
  JobRecord,
  JobState,
  JobTransition,
  RelationSummary,
  ResourceAlias,
  ResourceRecord,
  SearchData,
  SearchMode,
  SearchResult,
  Sensitivity,
  SourceSummary,
  SourcesData,
  StatsData,
  TagsData,
} from "./types.js";

interface Row {
  [key: string]: unknown;
}

export class ResearchCache {
  readonly dbPath: string;
  readonly db: Database;
  private readonly tableExistsCache = new Map<string, boolean>();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (!existsSync(dbPath)) {
      throw new CliError(
        "db_not_found",
        `research cache DB not found: ${dbPath}`,
        {
          recovery: "Use the Brain Package API; internal operators may pass --db PATH or set AGENTSTACK_STATE_DIR.",
        },
      );
    }
    this.db = openReadonlyDatabase(dbPath);
    try {
      this.rejectUnsupportedSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  stats(options: { topTags: number; recent: number }): StatsData {
    const doc = this.one<{ count: number; total: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size_chars), 0) AS total FROM documents",
    );
    const chunk = this.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM chunks",
    );
    const bySource = this.all<{ source_type: string; count: number }>(
      "SELECT source_type, COUNT(*) AS count FROM documents GROUP BY source_type ORDER BY count DESC, source_type ASC",
    );
    const topTags = this.all<{ tag: string; count: number }>(
      `SELECT j.value AS tag, COUNT(*) AS count
       FROM documents d, json_each(d.tags) AS j
       GROUP BY j.value
       ORDER BY count DESC, tag ASC
       LIMIT ?`,
      [options.topTags],
    );
    const recent = this.all<{
      document_id: number;
      title: string | null;
      source_uri: string;
      source_type: string;
      updated_at: string;
    }>(
      `SELECT id AS document_id, title, source_uri, source_type, updated_at
       FROM documents
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
      [options.recent],
    );
    const relationStats = this.tableExists("document_links")
      ? this.one<{ count: number; failed: number }>(
          `SELECT
             COUNT(*) AS count,
             COALESCE(SUM(CASE
               WHEN COALESCE(LOWER(status), '') = 'failed' OR COALESCE(error, '') <> '' THEN 1
               ELSE 0
             END), 0) AS failed
           FROM document_links`,
        )
      : { count: 0, failed: 0 };
    return {
      db_path: this.dbPath,
      db_size_bytes: statSync(this.dbPath).size,
      document_count: doc.count,
      chunk_count: chunk.count,
      total_chars: doc.total,
      relation_count: relationStats.count,
      failed_relation_count: relationStats.failed,
      by_source_type: bySource,
      top_tags: topTags,
      recent,
    };
  }

  search(
    input: {
      query: string;
      mode: SearchMode;
      limit?: number;
      offset?: number;
    } & QueryFilters,
  ): SearchData {
    const limit = clampLimit(input.limit, 10, 50);
    const offset = nonNegativeOffset(input.offset);
    const normalized = normalizeSearchQuery(input.query, input.mode);
    const queryFilters = validateQueryFilters({
      tag: input.tag,
      sourceType: input.sourceType,
      contentKind: input.contentKind,
      collection: input.collection,
      source: input.source,
      resourceKind: input.resourceKind,
      sensitivity: input.sensitivity,
      date: input.date,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      localPath: input.localPath,
    });
    const hasResources = this.tableExists("resources");
    const params: unknown[] = [normalized];
    const filters: string[] = [];
    const sourceMembership = hasResources
      ? this.sourceMembershipSql("r.id")
      : "0";
    const effectiveSensitivity = hasResources
      ? this.effectiveSensitivitySql("r.id", "r.sensitivity")
      : "'normal'";

    if (queryFilters.tag !== undefined) {
      filters.push(
        "EXISTS (SELECT 1 FROM json_each(d.tags) jt WHERE jt.value = ?)",
      );
      params.push(queryFilters.tag);
    }
    if (queryFilters.sourceType !== undefined) {
      filters.push("d.source_type = ?");
      params.push(queryFilters.sourceType);
    }
    if (queryFilters.contentKind !== undefined) {
      filters.push("d.content_kind = ?");
      params.push(queryFilters.contentKind);
    }
    if (queryFilters.collection !== undefined) {
      filters.push(
        hasResources
          ? `EXISTS (
               SELECT 1 FROM collection_memberships cm
               JOIN collections col ON col.id=cm.collection_id
               WHERE cm.resource_id=r.id AND col.slug=?
             )`
          : "0",
      );
      if (hasResources) params.push(queryFilters.collection);
    }
    if (queryFilters.source !== undefined) {
      filters.push(sourceMembership);
      if (hasResources) {
        params.push(queryFilters.source, queryFilters.source);
      }
    }
    if (queryFilters.resourceKind !== undefined) {
      filters.push(hasResources ? "r.kind = ?" : "d.source_type = ?");
      params.push(queryFilters.resourceKind);
    }
    if (queryFilters.sensitivity !== undefined) {
      filters.push(`${effectiveSensitivity} = ?`);
      params.push(queryFilters.sensitivity);
    }
    if (queryFilters.date !== undefined) {
      filters.push("substr(d.updated_at, 1, 10) = ?");
      params.push(queryFilters.date);
    }
    if (queryFilters.dateFrom !== undefined) {
      filters.push("d.updated_at >= ?");
      params.push(queryFilters.dateFrom);
    }
    if (queryFilters.dateTo !== undefined) {
      const upper = exclusiveDateUpperBound(queryFilters.dateTo);
      filters.push(
        upper === queryFilters.dateTo
          ? "d.updated_at <= ?"
          : "d.updated_at < ?",
      );
      params.push(upper);
    }
    if (queryFilters.localPath !== undefined) {
      filters.push(
        hasResources
          ? `(d.source_uri = ? OR EXISTS (
               SELECT 1 FROM resource_aliases ra
               WHERE ra.resource_id=r.id AND ra.locator=?
             ))`
          : "d.source_uri = ?",
      );
      params.push(queryFilters.localPath);
      if (hasResources) params.push(queryFilters.localPath);
    }

    const where = filters.length === 0 ? "" : ` AND ${filters.join(" AND ")}`;
    params.push(limit + 1, offset);
    // Relies on SQLite's single-MIN/MAX aggregate bare-column rule to select chunk_id/chunk_index/start_char/end_char from the min-rank row; a second aggregate or another bare-column select would make chunk selection (and its snippet/citation) indeterminate.
    const rows = this.all<{
      document_id: number;
      resource_id: number | null;
      resource_kind: string;
      sensitivity: Sensitivity;
      chunk_id: number;
      chunk_index: number;
      title: string | null;
      source_uri: string;
      source_type: string;
      content_kind: ContentKind | null;
      content_item_count: number | null;
      tags: string;
      updated_at: string;
      start_char: number;
      end_char: number;
      score: number;
    }>(
      `SELECT
         d.id AS document_id,
         ${hasResources ? "r.id" : "NULL"} AS resource_id,
         ${hasResources ? "COALESCE(r.kind, d.source_type)" : "d.source_type"} AS resource_kind,
         ${effectiveSensitivity} AS sensitivity,
         c.id AS chunk_id,
         c.chunk_index AS chunk_index,
         d.title AS title,
         d.source_uri AS source_uri,
         d.source_type AS source_type,
         d.content_kind AS content_kind,
         d.content_item_count AS content_item_count,
         d.tags AS tags,
         d.updated_at AS updated_at,
         c.start_char AS start_char,
         c.end_char AS end_char,
         MIN(chunks_fts.rank) AS score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.chunk_id
       JOIN documents d ON d.id = chunks_fts.document_id
       ${hasResources ? "LEFT JOIN resources r ON r.document_id=d.id" : ""}
       WHERE chunks_fts MATCH ?${where}
       GROUP BY d.id
       ORDER BY score ASC, d.updated_at DESC, c.id ASC
       LIMIT ? OFFSET ?`,
      params,
    );
    const page = rows.slice(0, limit);
    const results: SearchResult[] = page.map((row) => {
      const snippet = this.one<{ snippet: string }>(
        `SELECT snippet(chunks_fts, 3, '⟦', '⟧', ' … ', 48) AS snippet
         FROM chunks_fts
         WHERE chunks_fts MATCH ? AND chunk_id=?`,
        [normalized, row.chunk_id],
      ).snippet;
      const provenance = this.resourceProvenance(row.resource_id);
      return {
        ...row,
        tags: parseTags(row.tags),
        collections: provenance.collections,
        sources: provenance.sources,
        relations: this.relationSummaries(
          row.document_id,
          queryFilters.sensitivity,
        ),
        snippet,
      };
    });
    return {
      query: input.query,
      normalized_query: normalized,
      mode: input.mode,
      limit,
      offset,
      filters: this.outputFilters(queryFilters),
      results,
      next_offset: rows.length > limit ? offset + limit : null,
    };
  }

  context(
    input: {
      query: string;
      limit?: number;
      maxChars?: number;
    } & QueryFilters,
  ): ContextData {
    const limit = clampLimit(input.limit, 6, 20);
    const maxChars = input.maxChars ?? 12_000;
    if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 50_000) {
      throw new CliError(
        "bad_max_chars",
        "max-chars must be an integer between 500 and 50000",
        { exitCode: 2 },
      );
    }
    const search = this.search({
      ...input,
      query: input.query,
      mode: "any",
      limit,
      offset: 0,
    });
    let remaining = maxChars;
    let returnedChars = 0;
    let truncated = false;
    const hits = [];
    for (const result of search.results) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const row = this.one<{
        content: string;
      }>("SELECT content FROM chunks WHERE id=?", [result.chunk_id]);
      const points = Array.from(row.content);
      const selected = points.slice(0, remaining).join("");
      const wasTruncated = points.length > remaining;
      returnedChars += Math.min(points.length, remaining);
      remaining -= Math.min(points.length, remaining);
      truncated ||= wasTruncated;
      hits.push({
        document_id: result.document_id,
        resource_id: result.resource_id,
        resource_kind: result.resource_kind,
        sensitivity: result.sensitivity,
        collections: result.collections,
        sources: result.sources,
        relations: result.relations,
        chunk_id: result.chunk_id,
        chunk_index: result.chunk_index,
        title: result.title,
        source_uri: result.source_uri,
        source_type: result.source_type,
        content_kind: result.content_kind,
        content_item_count: result.content_item_count,
        tags: result.tags,
        start_char: result.start_char,
        end_char: result.end_char,
        score: result.score,
        citation: `[document_id:${result.document_id} chunk_id:${result.chunk_id}] ${result.title ?? "Untitled"} — ${result.source_uri}`,
        content: selected,
        truncated: wasTruncated,
      });
    }
    if (hits.length < search.results.length) truncated = true;
    return {
      query: input.query,
      filters: search.filters,
      limit,
      max_chars: maxChars,
      returned_chars: returnedChars,
      truncated,
      hits,
    };
  }

  getDocument(input: {
    documentId?: number;
    sourceUri?: string;
    charLimit: number | null;
  }): DocumentData {
    if (input.documentId === undefined && input.sourceUri === undefined) {
      throw new CliError(
        "missing_selector",
        "get requires --document-id or --source-uri",
        { exitCode: 2 },
      );
    }
    const row =
      input.documentId !== undefined
        ? this.oneOrNull<{
            id: number;
            title: string | null;
            source_uri: string;
            source_type: string;
            content_kind: ContentKind | null;
            content_item_count: number | null;
            tags: string;
            notes: string | null;
            size_chars: number;
            content_hash: string;
            created_at: string;
            updated_at: string;
            content: string;
          }>("SELECT * FROM documents WHERE id = ?", [input.documentId])
        : this.oneOrNull<{
            id: number;
            title: string | null;
            source_uri: string;
            source_type: string;
            content_kind: ContentKind | null;
            content_item_count: number | null;
            tags: string;
            notes: string | null;
            size_chars: number;
            content_hash: string;
            created_at: string;
            updated_at: string;
            content: string;
          }>(
            "SELECT * FROM documents WHERE source_uri = ? ORDER BY updated_at DESC LIMIT 1",
            [input.sourceUri],
          );
    if (row === null) throw new CliError("not_found", "document not found");
    const truncated = truncateContent(row.content, input.charLimit);
    const documentId = row.id;
    return {
      document_id: documentId,
      title: row.title,
      source_uri: row.source_uri,
      source_type: row.source_type,
      content_kind: row.content_kind,
      content_item_count: row.content_item_count,
      tags: parseTags(row.tags),
      notes: row.notes,
      size_chars: row.size_chars,
      content_hash: row.content_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
      content: truncated.content,
      outbound_links: this.documentLinks("from_document_id", documentId),
      inbound_links: this.documentLinks("to_document_id", documentId),
      truncation: {
        requested_char_limit: input.charLimit,
        returned_chars: truncated.content.length,
        omitted_chars: truncated.omitted,
      },
    };
  }

  getChunk(chunkId: number): ChunkData {
    const row = this.oneOrNull<{
      chunk_id: number;
      document_id: number;
      chunk_index: number;
      start_char: number;
      end_char: number;
      content: string;
      title: string | null;
      source_uri: string;
      source_type: string;
      content_kind: ContentKind | null;
      content_item_count: number | null;
      tags: string;
    }>(
      `SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.start_char, c.end_char, c.content,
              d.title, d.source_uri, d.source_type, d.content_kind,
              d.content_item_count, d.tags
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.id = ?`,
      [chunkId],
    );
    if (row === null) throw new CliError("not_found", "chunk not found");
    return { ...row, tags: parseTags(row.tags) };
  }

  tags(limitInput?: number): TagsData {
    const limit = clampLimit(limitInput, 100, 500);
    return {
      tags: this.all<{ tag: string; count: number }>(
        `SELECT j.value AS tag, COUNT(*) AS count
         FROM documents d, json_each(d.tags) AS j
         GROUP BY j.value
         ORDER BY count DESC, tag ASC
         LIMIT ?`,
        [limit],
      ),
    };
  }

  sources(limitInput?: number): SourcesData {
    const limit = clampLimit(limitInput, 100, 500);
    const sourceTypes = this.all<{ source_type: string; count: number }>(
      "SELECT source_type, COUNT(*) AS count FROM documents GROUP BY source_type ORDER BY count DESC, source_type ASC",
    );
    const uris = this.all<{ source_uri: string }>(
      "SELECT source_uri FROM documents",
    );
    const counts = new Map<string, number>();
    for (const row of uris) {
      const domain = domainFromUri(row.source_uri) ?? "local/other";
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return {
      source_types: sourceTypes,
      domains: Array.from(counts.entries())
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
        .slice(0, limit),
    };
  }

  /**
   * Typed view of the durable resource that maps a legacy document, with its
   * observed aliases. Returns null on pre-migration databases; the read path
   * never creates or migrates the resource model.
   */
  resourceForDocument(documentId: number): ResourceRecord | null {
    if (!this.tableExists("resources")) return null;
    const row = this.oneOrNull<{
      id: number;
      key_type: string;
      key_value: string;
      kind: string;
      sensitivity: Sensitivity;
      document_id: number | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, key_type, key_value, kind, sensitivity, document_id,
              created_at, updated_at
       FROM resources WHERE document_id = ?`,
      [documentId],
    );
    if (row === null) return null;
    const aliases: ResourceAlias[] = this.all<{
      id: number;
      resource_id: number;
      alias_type: string;
      locator: string;
      evidence: string | null;
      first_observed_at: string;
      last_observed_at: string;
    }>(
      `SELECT id, resource_id, alias_type, locator, evidence,
              first_observed_at, last_observed_at
       FROM resource_aliases WHERE resource_id = ?
       ORDER BY id ASC`,
      [row.id],
    );
    return { ...row, aliases };
  }

  /**
   * Read-only view of one durable ingestion job with its append-only attempts
   * and audited transitions. Returns null on pre-lifecycle databases; this path
   * only ever reads, so it can never mutate queue, schema, or index state.
   */
  job(jobId: number): JobRecord | null {
    if (!this.tableExists("jobs")) return null;
    const row = this.oneOrNull<Job & Row>("SELECT * FROM jobs WHERE id = ?", [
      jobId,
    ]);
    if (row === null) return null;
    const attempts = this.all<Attempt & Row>(
      "SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number ASC",
      [jobId],
    );
    const transitions = this.all<JobTransition & Row>(
      "SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id ASC",
      [jobId],
    );
    return { ...row, attempts, transitions };
  }

  /**
   * Read-only listing of durable ingestion jobs, optionally by state. The
   * runnable jobs among these form the ingestion queue.
   */
  jobs(filter: { state?: JobState } = {}): Job[] {
    if (!this.tableExists("jobs")) return [];
    if (filter.state !== undefined) {
      return this.all<Job & Row>(
        "SELECT * FROM jobs WHERE state = ? ORDER BY run_at ASC, id ASC",
        [filter.state],
      );
    }
    return this.all<Job & Row>(
      "SELECT * FROM jobs ORDER BY run_at ASC, id ASC",
    );
  }

  private outputFilters(filters: QueryFilters): SearchData["filters"] {
    return {
      ...(filters.tag !== undefined ? { tag: filters.tag } : {}),
      ...(filters.sourceType !== undefined
        ? { source_type: filters.sourceType }
        : {}),
      ...(filters.contentKind !== undefined
        ? { content_kind: filters.contentKind }
        : {}),
      ...(filters.collection !== undefined
        ? { collection: filters.collection }
        : {}),
      ...(filters.source !== undefined ? { source: filters.source } : {}),
      ...(filters.resourceKind !== undefined
        ? { resource_kind: filters.resourceKind }
        : {}),
      ...(filters.sensitivity !== undefined
        ? { sensitivity: filters.sensitivity }
        : {}),
      ...(filters.date !== undefined ? { date: filters.date } : {}),
      ...(filters.dateFrom !== undefined
        ? { date_from: filters.dateFrom }
        : {}),
      ...(filters.dateTo !== undefined ? { date_to: filters.dateTo } : {}),
      ...(filters.localPath !== undefined
        ? { local_path: filters.localPath }
        : {}),
    };
  }

  private sourceConnectionsSql(
    resourceIdSql: string,
    sourceIdSql: string,
  ): string {
    const connections = [
      `EXISTS (
        SELECT 1 FROM observations o
        WHERE o.resource_id=${resourceIdSql}
          AND (o.source_id=${sourceIdSql} OR EXISTS (
            SELECT 1 FROM runs sr
            WHERE sr.id=o.run_id AND sr.source_id=${sourceIdSql}
          ))
      )`,
      `EXISTS (
        SELECT 1 FROM provenance p
        WHERE p.resource_id=${resourceIdSql}
          AND (p.source_id=${sourceIdSql} OR EXISTS (
            SELECT 1 FROM runs sr
            WHERE sr.id=p.run_id AND sr.source_id=${sourceIdSql}
          ))
      )`,
    ];
    if (this.tableExists("jobs")) {
      connections.push(
        `EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.resource_id=${resourceIdSql}
            AND (j.source_id=${sourceIdSql} OR EXISTS (
              SELECT 1 FROM runs sr
              WHERE sr.id=j.run_id AND sr.source_id=${sourceIdSql}
            ))
        )`,
      );
    }
    return `(${connections.join(" OR ")})`;
  }

  private sourceMembershipSql(resourceIdSql: string): string {
    return `EXISTS (
      SELECT 1 FROM sources qs
      WHERE (qs.identifier=? OR qs.source_type || ':' || qs.identifier=?)
        AND ${this.sourceConnectionsSql(resourceIdSql, "qs.id")}
    )`;
  }

  private effectiveSensitivitySql(
    resourceIdSql: string,
    sensitivitySql: string,
  ): string {
    const rank = `MAX(
      COALESCE((SELECT rank FROM sensitivity_levels WHERE level=${sensitivitySql}), 1),
      COALESCE((
        SELECT MAX(csl.rank)
        FROM collection_memberships ecm
        JOIN collections ec ON ec.id=ecm.collection_id
        JOIN sensitivity_levels csl ON csl.level=ec.sensitivity
        WHERE ecm.resource_id=${resourceIdSql}
      ), 0),
      COALESCE((
        SELECT MAX(ssl.rank)
        FROM sources es
        JOIN sensitivity_levels ssl ON ssl.level=es.sensitivity
        WHERE ${this.sourceConnectionsSql(resourceIdSql, "es.id")}
      ), 0)
    )`;
    return `CASE ${rank}
      WHEN 0 THEN 'public'
      WHEN 1 THEN 'normal'
      WHEN 2 THEN 'sensitive'
      WHEN 3 THEN 'private'
    END`;
  }

  private resourceProvenance(resourceId: number | null): {
    collections: string[];
    sources: SourceSummary[];
  } {
    if (resourceId === null || !this.tableExists("resources")) {
      return { collections: [], sources: [] };
    }
    const collections = this.all<{ slug: string }>(
      `SELECT col.slug
       FROM collection_memberships cm
       JOIN collections col ON col.id=cm.collection_id
       WHERE cm.resource_id=?
       ORDER BY col.slug ASC`,
      [resourceId],
    ).map((row) => row.slug);
    const sources = this.all<SourceSummary & Row>(
      `SELECT s.source_type, s.identifier
       FROM sources s
       WHERE ${this.sourceConnectionsSql("?", "s.id")}
       ORDER BY s.source_type ASC, s.identifier ASC`,
      this.tableExists("jobs")
        ? [resourceId, resourceId, resourceId]
        : [resourceId, resourceId],
    );
    return { collections, sources };
  }

  private relationSummaries(
    documentId: number,
    sensitivity?: Sensitivity,
  ): RelationSummary[] {
    if (!this.tableExists("document_links")) return [];
    const hasResources = this.tableExists("resources");
    type RelationRow = {
      relation_id: number;
      direction: "outbound" | "inbound";
      relation_type: string;
      status: string;
      linked_document_id: number;
      linked_resource_id: number | null;
      linked_title: string | null;
      linked_resource_kind: string;
      linked_sensitivity: Sensitivity;
    };
    const linkedSensitivity = hasResources
      ? this.effectiveSensitivitySql("lr.id", "lr.sensitivity")
      : "'normal'";
    const select = (direction: "outbound" | "inbound"): RelationRow[] => {
      const outbound = direction === "outbound";
      return this.all<RelationRow & Row>(
        `SELECT dl.id AS relation_id, '${direction}' AS direction,
                dl.relation_type, dl.status,
                ld.id AS linked_document_id,
                ${hasResources ? "lr.id" : "NULL"} AS linked_resource_id,
                ld.title AS linked_title,
                ${hasResources ? "COALESCE(lr.kind, ld.source_type)" : "ld.source_type"} AS linked_resource_kind,
                ${linkedSensitivity} AS linked_sensitivity
         FROM document_links dl
         JOIN documents ld ON ld.id=dl.${outbound ? "to_document_id" : "from_document_id"}
         ${hasResources ? "LEFT JOIN resources lr ON lr.document_id=ld.id" : ""}
         WHERE dl.${outbound ? "from_document_id" : "to_document_id"}=?
           ${sensitivity === undefined ? "" : `AND ${linkedSensitivity}=?`}
         ORDER BY dl.id ASC
         LIMIT 50`,
        sensitivity === undefined ? [documentId] : [documentId, sensitivity],
      );
    };
    return [...select("outbound"), ...select("inbound")]
      .sort((left, right) => left.relation_id - right.relation_id)
      .slice(0, 50);
  }

  private documentLinks(
    direction: "from_document_id" | "to_document_id",
    documentId: number,
  ): Array<{
    id: number;
    from_document_id: number;
    to_document_id: number | null;
    relation_type: string;
    discovered_url: string | null;
    resolved_url: string | null;
    status: string;
    error: string | null;
    created_at: string;
    updated_at: string;
  }> {
    if (!this.tableExists("document_links")) return [];
    return this.all<{
      id: number;
      from_document_id: number;
      to_document_id: number | null;
      relation_type: string;
      discovered_url: string | null;
      resolved_url: string | null;
      status: string;
      error: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT
         id,
         from_document_id,
         to_document_id,
         relation_type,
         discovered_url,
         resolved_url,
         status,
         error,
         created_at,
         updated_at
       FROM document_links
       WHERE ${direction} = ?
       ORDER BY id ASC`,
      [documentId],
    );
  }

  private rejectUnsupportedSchema(): void {
    if (!this.tableExists("meta")) return;
    const row = this.oneOrNull<{ value: string }>(
      "SELECT value FROM meta WHERE key='schema_version'",
    );
    if (row === null) return;
    const version = Number(row.value);
    if (!Number.isInteger(version)) {
      throw new CliError(
        "bad_schema_version",
        "research cache schema_version is not an integer",
      );
    }
    if (version > RESEARCH_SCHEMA_VERSION) {
      throw new CliError(
        "unsupported_schema_version",
        `research cache schema version ${version} is newer than supported version ${RESEARCH_SCHEMA_VERSION}`,
      );
    }
    if (version < RESEARCH_SCHEMA_VERSION) {
      throw new CliError(
        "unsupported_schema_version",
        `research cache schema version ${version} is older than supported version ${RESEARCH_SCHEMA_VERSION}`,
      );
    }
  }

  private tableExists(name: string): boolean {
    const cached = this.tableExistsCache.get(name);
    if (cached !== undefined) return cached;
    const exists =
      this.oneOrNull<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [name],
      ) !== null;
    this.tableExistsCache.set(name, exists);
    return exists;
  }

  private all<T extends Row>(sql: string, params: unknown[] = []): T[] {
    return this.db.query(sql).all(...(params as never[])) as T[];
  }

  private one<T extends Row>(sql: string, params: unknown[] = []): T {
    return this.db.query(sql).get(...(params as never[])) as T;
  }

  private oneOrNull<T extends Row>(
    sql: string,
    params: unknown[] = [],
  ): T | null {
    return (this.db.query(sql).get(...(params as never[])) as T | null) ?? null;
  }
}
