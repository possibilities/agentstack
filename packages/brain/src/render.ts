import { formatList } from "./format.js";
import type {
  ChunkData,
  ContextData,
  DocumentData,
  DocumentLink,
  SearchData,
  StatsData,
  TagsData,
} from "./types.js";

export function humanStats(data: StatsData): string {
  return [
    `DB: ${data.db_path}`,
    `Documents: ${data.document_count}`,
    `Chunks: ${data.chunk_count}`,
    `Characters: ${data.total_chars}`,
    `Relations: ${data.relation_count}`,
    `Failed relations: ${data.failed_relation_count}`,
    `DB bytes: ${data.db_size_bytes}`,
    "",
    "By source type:",
    formatList(data.by_source_type, ["source_type", "count"]).trimEnd(),
    "",
    "Top tags:",
    formatList(data.top_tags, ["tag", "count"]).trimEnd(),
    "",
    "Recent:",
    formatList(
      data.recent.map((r) => ({
        id: r.document_id,
        type: r.source_type,
        updated: r.updated_at,
        title: r.title ?? "",
        uri: r.source_uri,
      })),
      ["id", "type", "updated", "title", "uri"],
    ).trimEnd(),
    "",
  ].join("\n");
}

export function humanSearch(data: SearchData): string {
  const lines = [
    `Query: ${data.query}`,
    `Mode: ${data.mode}`,
    `Normalized: ${data.normalized_query}`,
    `Results: ${data.results.length}`,
    "",
  ];
  for (const [i, result] of data.results.entries()) {
    lines.push(
      `${data.offset + i + 1}. document_id=${result.document_id} chunk_id=${result.chunk_id} score=${result.score}`,
    );
    lines.push(`   title: ${result.title ?? "(untitled)"}`);
    lines.push(`   source: ${result.source_uri}`);
    lines.push(
      `   resource: ${result.resource_id ?? "legacy"} / ${result.resource_kind} / ${result.sensitivity}`,
    );
    lines.push(
      `   type/kind/items/tags: ${result.source_type} / ${result.content_kind ?? "unclassified"} / ${result.content_item_count ?? "?"} / ${result.tags.join(", ")}`,
    );
    if (result.collections.length > 0) {
      lines.push(`   collections: ${result.collections.join(", ")}`);
    }
    if (result.sources.length > 0) {
      lines.push(
        `   sources: ${result.sources.map((source) => `${source.source_type}:${source.identifier}`).join(", ")}`,
      );
    }
    for (const relation of result.relations) {
      lines.push(
        `   relation: ${relation.direction} ${relation.relation_type} document_id=${relation.linked_document_id} resource_id=${relation.linked_resource_id ?? "legacy"}`,
      );
    }
    lines.push(`   snippet: ${result.snippet.replaceAll("\n", " ")}`);
    lines.push("");
  }
  if (data.next_offset !== null)
    lines.push(`Next page: --offset ${data.next_offset}\n`);
  return lines.join("\n");
}

export function searchJsonl(data: SearchData): unknown[] {
  return [
    {
      record_type: "meta",
      query: data.query,
      normalized_query: data.normalized_query,
      mode: data.mode,
      limit: data.limit,
      offset: data.offset,
      filters: data.filters,
      next_offset: data.next_offset,
    },
    ...data.results.map((result) => ({ record_type: "result", ...result })),
  ];
}

function humanLinks(title: string, links: DocumentLink[]): string {
  return [
    title,
    formatList(
      links.map((link) => ({
        id: link.id,
        type: link.relation_type,
        status: link.status,
        from: link.from_document_id,
        to: link.to_document_id ?? "",
        discovered: link.discovered_url ?? "",
        resolved: link.resolved_url ?? "",
        error: link.error ?? "",
      })),
      ["id", "type", "status", "from", "to", "discovered", "resolved", "error"],
    ).trimEnd(),
  ].join("\n");
}

export function humanDocument(data: DocumentData): string {
  const sections = [
    `document_id: ${data.document_id}`,
    `title: ${data.title ?? "(untitled)"}`,
    `source_uri: ${data.source_uri}`,
    `source_type: ${data.source_type}`,
    `content_kind: ${data.content_kind ?? "unclassified"}`,
    `content_item_count: ${data.content_item_count ?? "unknown"}`,
    `tags: ${data.tags.join(", ")}`,
    `updated_at: ${data.updated_at}`,
    `chars: ${data.truncation.returned_chars}/${data.size_chars}${data.truncation.omitted_chars > 0 ? ` (${data.truncation.omitted_chars} omitted)` : ""}`,
    "",
    data.content,
    "",
    humanLinks("Outbound links:", data.outbound_links),
    "",
    humanLinks("Inbound links:", data.inbound_links),
    "",
  ];
  return sections.join("\n");
}

export function humanChunk(data: ChunkData): string {
  return [
    `chunk_id: ${data.chunk_id}`,
    `document_id: ${data.document_id}`,
    `chunk_index: ${data.chunk_index}`,
    `title: ${data.title ?? "(untitled)"}`,
    `source_uri: ${data.source_uri}`,
    `source_type: ${data.source_type}`,
    `content_kind: ${data.content_kind ?? "unclassified"}`,
    `content_item_count: ${data.content_item_count ?? "unknown"}`,
    `tags: ${data.tags.join(", ")}`,
    `span: ${data.start_char}-${data.end_char}`,
    "",
    data.content,
    "",
  ].join("\n");
}

export function humanContext(data: ContextData): string {
  const lines = [
    `Query: ${data.query}`,
    `Hits: ${data.hits.length}`,
    `Characters: ${data.returned_chars}/${data.max_chars}`,
    "",
  ];
  for (const [index, hit] of data.hits.entries()) {
    lines.push(`${index + 1}. ${hit.citation}`);
    lines.push(
      `   Resource: ${hit.resource_id ?? "legacy"} / ${hit.resource_kind} / ${hit.sensitivity}`,
    );
    lines.push(
      `   Content: ${hit.content_kind ?? "unclassified"} / ${hit.content_item_count ?? "?"} item(s)`,
    );
    if (hit.collections.length > 0) {
      lines.push(`   Collections: ${hit.collections.join(", ")}`);
    }
    if (hit.sources.length > 0) {
      lines.push(
        `   Sources: ${hit.sources.map((source) => `${source.source_type}:${source.identifier}`).join(", ")}`,
      );
    }
    for (const relation of hit.relations) {
      lines.push(
        `   Relation: ${relation.direction} ${relation.relation_type} document_id=${relation.linked_document_id} resource_id=${relation.linked_resource_id ?? "legacy"}`,
      );
    }
    lines.push(hit.content);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function humanMutation(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function humanTags(data: TagsData): string {
  return formatList(data.tags, ["tag", "count"]);
}
