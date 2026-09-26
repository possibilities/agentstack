import { CliError } from "./errors.js";
import type { ContentKind, SearchMode, Sensitivity } from "./types.js";

export interface QueryFilters {
  tag?: string;
  sourceType?: string;
  contentKind?: ContentKind;
  collection?: string;
  source?: string;
  resourceKind?: string;
  sensitivity?: Sensitivity;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  localPath?: string;
}

const SENSITIVITIES = new Set<Sensitivity>([
  "public",
  "normal",
  "sensitive",
  "private",
]);
const CONTENT_KINDS = new Set<ContentKind>(["post", "thread", "article"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateQueryFilters(filters: QueryFilters): QueryFilters {
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined && value.trim().length === 0) {
      throw new CliError("bad_filter", `${name} filter must not be empty`, {
        exitCode: 2,
      });
    }
  }
  if (
    filters.contentKind !== undefined &&
    !CONTENT_KINDS.has(filters.contentKind)
  ) {
    throw new CliError(
      "bad_content_kind",
      "content-kind must be post, thread, or article",
      { exitCode: 2 },
    );
  }
  if (
    filters.sensitivity !== undefined &&
    !SENSITIVITIES.has(filters.sensitivity)
  ) {
    throw new CliError(
      "bad_sensitivity",
      "sensitivity must be public, normal, sensitive, or private",
      { exitCode: 2 },
    );
  }
  for (const value of [filters.date, filters.dateFrom, filters.dateTo]) {
    if (value !== undefined) validateDate(value);
  }
  return filters;
}

function validateDate(value: string): void {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new CliError("bad_date", `invalid date filter '${value}'`, {
      exitCode: 2,
    });
  }
  if (ISO_DATE.test(value)) {
    const normalized = new Date(`${value}T00:00:00.000Z`)
      .toISOString()
      .slice(0, 10);
    if (normalized !== value) {
      throw new CliError("bad_date", `invalid date filter '${value}'`, {
        exitCode: 2,
      });
    }
  }
}

export function exclusiveDateUpperBound(value: string): string {
  if (!ISO_DATE.test(value)) return value;
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

const FTS_TOKEN = /[\p{L}\p{N}_./:@-]+/gu;

export function normalizeSearchQuery(input: string, mode: SearchMode): string {
  const query = input.trim();
  if (query.length === 0) {
    throw new CliError("empty_query", "search query cannot be empty", {
      exitCode: 2,
    });
  }
  if (mode === "raw") return query;

  const phrases = Array.from(query.matchAll(/"([^"]+)"/g), (m) =>
    (m[1] ?? "").trim(),
  ).filter(Boolean);
  const withoutPhrases = query.replace(/"([^"]+)"/g, " ");
  const terms = Array.from(
    withoutPhrases.matchAll(FTS_TOKEN),
    (m) => m[0],
  ).filter((term) => term.length > 0);
  const atoms = [...phrases.map(quoteFtsPhrase), ...terms.map(quoteFtsPhrase)];
  if (atoms.length === 0) {
    throw new CliError("empty_query", "search query has no searchable terms", {
      exitCode: 2,
    });
  }
  return atoms.join(mode === "all" ? " AND " : " OR ");
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function parseTags(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

export function domainFromUri(sourceUri: string): string | null {
  try {
    const url = new URL(sourceUri);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function clampLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError("bad_limit", "limit must be a positive integer", {
      exitCode: 2,
    });
  }
  return Math.min(n, max);
}

export function nonNegativeOffset(value: number | undefined): number {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError("bad_offset", "offset must be a non-negative integer", {
      exitCode: 2,
    });
  }
  return n;
}

export function truncateContent(
  content: string,
  charLimit: number | null,
): { content: string; omitted: number } {
  if (charLimit === null || content.length <= charLimit)
    return { content, omitted: 0 };
  if (charLimit < 500) {
    throw new CliError("bad_char_limit", "char limit must be at least 500", {
      exitCode: 2,
    });
  }
  const head = Math.floor(charLimit * 0.65);
  const tail = charLimit - head;
  const omitted = content.length - charLimit;
  return {
    content: `${content.slice(0, head)}\n\n[... omitted ${omitted} chars ...]\n\n${content.slice(-tail)}`,
    omitted,
  };
}
