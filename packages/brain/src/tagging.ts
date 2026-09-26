import { domainFromUri } from "./query.js";
import { normalizeTags } from "./text.js";

/**
 * Curated, extensible starting vocabulary for structural tags. Keep every
 * value lean, lowercase, and dot-free (the unicode61 tokenizer backing
 * chunks_fts splits on `.`, so a dotted tag like `youtube.com` would never
 * match as one token).
 */
const SOURCE_TYPE_TAGS: Readonly<Record<string, readonly string[]>> = {
  x: ["x", "social"],
};

/**
 * Exact-host lookup. Deliberately omits x.com/twitter.com even though
 * source_type "x" documents resolve a domain there too: source_type already
 * contributes "x"/"social", and mapping the domain as well would only add a
 * confusing duplicate (dedup would hide it, but the omission is intentional,
 * not incidental).
 */
const DOMAIN_TAGS: Readonly<Record<string, readonly string[]>> = {
  "github.com": ["github", "code"],
  "gist.github.com": ["github", "code"],
  "youtube.com": ["youtube", "video"],
  "reddit.com": ["reddit", "social"],
};

export interface StructuralTagInput {
  /** The document's currently stored tags (any shape normalizeTags accepts). */
  existingTags: unknown;
  sourceType: string;
  sourceUri: string;
  /** Collection slugs the document's resource currently belongs to. */
  collectionSlugs: readonly string[];
}

function canonicalHost(host: string): string {
  return host.replace(/^(?:www\.|m\.)/, "");
}

function isDotFree(tag: string): boolean {
  return !tag.includes(".");
}

function sourceTypeTags(sourceType: string): string[] {
  const tags = SOURCE_TYPE_TAGS[sourceType.trim().toLowerCase()] ?? [];
  return [...tags].filter(isDotFree).sort();
}

function domainTags(sourceUri: string): string[] {
  const host = domainFromUri(sourceUri);
  if (host === null) return [];
  const tags = DOMAIN_TAGS[canonicalHost(host)] ?? [];
  return [...tags].filter(isDotFree).sort();
}

function collectionTags(collectionSlugs: readonly string[]): string[] {
  return [...collectionSlugs].filter(isDotFree).sort();
}

/**
 * Deterministically derive a document's structural tags from source_type,
 * URL domain, and collection membership, unioned with its existing tags
 * (always preserving `legacy-recovery` and any pre-existing user tag).
 *
 * Emission order is load-bearing for idempotency: existing tags first in
 * their stored order, then structural tags grouped source_type -> domain ->
 * collection, each group sorted. normalizeTags dedupes but does not sort, so
 * retag re-runs are only byte-identical because this function itself always
 * produces the same order for the same inputs.
 */
export function deriveStructuralTags(input: StructuralTagInput): string[] {
  const existing = normalizeTags(input.existingTags);
  const combined = [
    ...existing,
    ...sourceTypeTags(input.sourceType),
    ...domainTags(input.sourceUri),
    ...collectionTags(input.collectionSlugs),
  ];
  return normalizeTags(combined);
}
