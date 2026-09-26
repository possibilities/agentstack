import { opendirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type ScrapeProvider, scrapeWithAgentscrape } from "./agentscrape.js";
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_MAX_BYTES,
  extractFile,
  inferTitleFromSource,
  looksSensitiveComponent,
} from "./extract.js";
import type { ResearchStore, UpsertDocumentResult } from "./store.js";
import { normalizeTags, sha256Text } from "./text.js";
import { normalizedWebUrl, sourceTypeForUrl } from "./url.js";

export type IngestSourceType = "auto" | "url" | "file" | "directory" | "text";

export const DIRECTORY_TRAVERSAL_LIMIT = 20_000;
export const DIRECTORY_CANDIDATE_LIMIT = 10_000;

export interface IngestOptions {
  source: string;
  sourceType?: IngestSourceType;
  title?: string;
  tags?: unknown;
  notes?: string;
  recursive?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  force?: boolean;
  skipSecrets?: boolean;
  scrape?: ScrapeProvider;
  agentscrapeTimeoutMs?: number;
  /** Test seam; callers cannot raise the production hard limit. */
  directoryTraversalLimit?: number;
  /** Test seam; callers cannot raise the production hard limit. */
  directoryCandidateLimit?: number;
}

export interface DirectoryIngestResult {
  success: true;
  status: "directory_ingested";
  root: string;
  recursive: boolean;
  scanned_candidate_files: number;
  discovered_candidate_files: number;
  traversal_entries: number;
  ingested_count: number;
  errors_count: number;
  errors_sample: Array<{ path: string; error: string }>;
  documents: UpsertDocumentResult[];
  truncated: boolean;
  truncation_reasons: string[];
}

export const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  "vendor",
  "Pods",
]);

interface TraversalState {
  entries: number;
  candidates: number;
  traversalLimit: number;
  candidateLimit: number;
  truncated: boolean;
  reasons: Set<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleFromMarkdown(source: string, markdown: string): string {
  for (const line of markdown.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      return Array.from(stripped.replace(/^#+/, "").trim() || source)
        .slice(0, 500)
        .join("");
    }
    if (stripped) return Array.from(stripped).slice(0, 120).join("");
  }
  return inferTitleFromSource(source);
}

function detectedSourceType(source: string): Exclude<IngestSourceType, "auto"> {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") return "url";
  } catch {
    // It may be a local path or literal text.
  }
  try {
    const stat = statSync(source);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    // Nonexistent paths are intentionally treated as pasted text in auto mode.
  }
  return "text";
}

export async function ingestSource(
  store: ResearchStore,
  options: IngestOptions,
): Promise<UpsertDocumentResult | DirectoryIngestResult> {
  const source = String(options.source ?? "").trim();
  if (!source) throw new Error("source is required");
  let sourceType = (options.sourceType ?? "auto")
    .trim()
    .toLowerCase() as IngestSourceType;
  if (!["auto", "url", "file", "directory", "text"].includes(sourceType)) {
    throw new Error(`unknown source_type: ${sourceType}`);
  }
  if (sourceType === "auto") sourceType = detectedSourceType(source);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("max_bytes must be a positive integer");
  }

  if (sourceType === "text") {
    return store.upsertDocument({
      sourceType: "text",
      sourceUri: `text:${sha256Text(source).slice(0, 16)}`,
      title: options.title || "Pasted note",
      content: source,
      tags: options.tags,
      notes: options.notes,
      force: options.force,
    });
  }
  if (sourceType === "url") {
    const requestedUrl = normalizedWebUrl(source);
    const scrape = options.scrape ?? scrapeWithAgentscrape;
    const scraped = await scrape(requestedUrl, {
      maxMarkdownBytes: maxBytes,
      maxMarkdownCodePoints: maxBytes,
      timeoutMs: options.agentscrapeTimeoutMs,
    });
    const sourceUri = requestedUrl;
    return store.upsertDocument({
      sourceType: sourceTypeForUrl(sourceUri),
      sourceUri,
      title: options.title || titleFromMarkdown(sourceUri, scraped.markdown),
      content: scraped.markdown,
      mediaType: "text/markdown",
      tags: options.tags,
      notes: options.notes,
      force: options.force,
    });
  }
  if (sourceType === "file") {
    const extracted = extractFile(source, {
      maxBytes,
      skipSecrets: options.skipSecrets,
    });
    return store.upsertDocument({
      sourceType: "file",
      sourceUri: extracted.source_uri,
      title: options.title || extracted.title,
      content: extracted.content,
      tags: options.tags,
      notes: options.notes,
      force: options.force,
    });
  }
  return ingestDirectory(store, source, options);
}

function boundedLimit(value: number | undefined, hardLimit: number): number {
  if (value === undefined) return hardLimit;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("directory traversal limits must be positive integers");
  }
  return Math.min(value, hardLimit);
}

function* streamCandidates(
  directory: string,
  recursive: boolean,
  skipSecrets: boolean,
  state: TraversalState,
): Generator<string> {
  const handle = opendirSync(directory);
  try {
    while (!state.truncated) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (state.entries >= state.traversalLimit) {
        state.truncated = true;
        state.reasons.add("traversal_limit");
        break;
      }
      state.entries += 1;
      const path = join(directory, entry.name);
      if (skipSecrets && looksSensitiveComponent(entry.name)) continue;
      if (entry.isDirectory()) {
        if (recursive && !SKIP_DIRS.has(entry.name)) {
          yield* streamCandidates(path, recursive, skipSecrets, state);
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (!statSync(path).isFile()) continue;
        } catch {
          continue;
        }
      }
      if (!DEFAULT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      if (state.candidates >= state.candidateLimit) {
        state.truncated = true;
        state.reasons.add("candidate_limit");
        break;
      }
      state.candidates += 1;
      yield path;
    }
  } finally {
    handle.closeSync();
  }
}

function ingestDirectory(
  store: ResearchStore,
  source: string,
  options: Omit<IngestOptions, "source">,
): DirectoryIngestResult {
  const root = realpathSync(source);
  if (
    options.skipSecrets !== false &&
    root.split(/[\\/]/).some(looksSensitiveComponent)
  ) {
    throw new Error(
      `refusing to ingest likely secret directory: ${basename(root)}`,
    );
  }
  if (!statSync(root).isDirectory())
    throw new Error(`not a directory: ${root}`);
  const recursive = options.recursive !== false;
  const requestedMaxFiles = options.maxFiles ?? 300;
  if (!Number.isInteger(requestedMaxFiles) || requestedMaxFiles < 1) {
    throw new Error("max_files must be a positive integer");
  }
  const maxFiles = Math.min(requestedMaxFiles, 5000);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const successes: UpsertDocumentResult[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let errorsCount = 0;
  let scanned = 0;
  const traversal: TraversalState = {
    entries: 0,
    candidates: 0,
    traversalLimit: boundedLimit(
      options.directoryTraversalLimit,
      DIRECTORY_TRAVERSAL_LIMIT,
    ),
    candidateLimit: boundedLimit(
      options.directoryCandidateLimit,
      DIRECTORY_CANDIDATE_LIMIT,
    ),
    truncated: false,
    reasons: new Set(),
  };

  for (const path of streamCandidates(
    root,
    recursive,
    options.skipSecrets !== false,
    traversal,
  )) {
    if (successes.length >= maxFiles) {
      traversal.truncated = true;
      traversal.reasons.add("max_files");
      break;
    }
    scanned += 1;
    try {
      const extracted = extractFile(path, {
        maxBytes,
        skipSecrets: options.skipSecrets,
      });
      const tags = [...normalizeTags(options.tags), basename(root)];
      successes.push(
        store.upsertDocument({
          sourceType: "file",
          sourceUri: extracted.source_uri,
          title: extracted.title || options.title,
          content: extracted.content,
          tags,
          notes: options.notes,
          force: options.force,
        }),
      );
    } catch (error) {
      errorsCount += 1;
      if (errors.length < 25) errors.push({ path, error: errorMessage(error) });
    }
  }
  if (successes.length > 50) traversal.reasons.add("document_sample");

  return {
    success: true,
    status: "directory_ingested",
    root,
    recursive,
    scanned_candidate_files: scanned,
    discovered_candidate_files: traversal.candidates,
    traversal_entries: traversal.entries,
    ingested_count: successes.length,
    errors_count: errorsCount,
    errors_sample: errors,
    documents: successes.slice(0, 50),
    truncated: traversal.truncated || successes.length > 50,
    truncation_reasons: [...traversal.reasons],
  };
}
