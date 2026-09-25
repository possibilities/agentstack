import { CliError } from "./errors.js";
import { slugify } from "./slug.js";

/** A ref is whatever a human said out loud. Resolution walks from the most
 * literal reading to the loosest, and stops at the first tier that matches —
 * a fuzzy hit never competes with an exact slug. */
export type MatchTier = "slug" | "title" | "normalized" | "fuzzy" | "words";

export interface RefCandidate {
  slug: string;
  title: string;
}

export interface RefMatch<T extends RefCandidate> {
  candidate: T;
  tier: MatchTier;
  score: number;
}

const TIER_ORDER: readonly MatchTier[] = ["slug", "title", "normalized", "fuzzy", "words"];
const TIER_SCORE: Record<MatchTier, number> = {
  slug: 100,
  title: 90,
  normalized: 80,
  fuzzy: 60,
  words: 40,
};

const LEADING_ARTICLE = /^(?:a|an|the)-/;

/** Leading articles are the one word people drop when speaking a title. */
function normalizeRef(value: string): string {
  return slugify(value).replace(LEADING_ARTICLE, "");
}

/** People drop the middle of a title, not just its article: "the bluetooth
 * trap" is how someone asks for bluetooth-q30-hfp-trap out loud. Requiring
 * the spoken words in order keeps this from matching a rearrangement. */
function wordsInOrder(needle: string, haystack: string): boolean {
  const wanted = needle.split("-").filter((word) => word !== "");
  if (wanted.length < 2) return false;
  const available = haystack.split("-");
  let at = 0;
  for (const word of wanted) {
    const found = available.indexOf(word, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

function tierOf(ref: string, candidate: RefCandidate): MatchTier | null {
  if (candidate.slug === ref) return "slug";
  if (candidate.title === ref) return "title";
  const normalized = normalizeRef(ref);
  if (normalized === "") return null;
  const slug = normalizeRef(candidate.slug);
  const title = normalizeRef(candidate.title);
  if (slug === normalized || title === normalized) return "normalized";
  if (slug.includes(normalized) || title.includes(normalized)) return "fuzzy";
  if (wordsInOrder(normalized, slug) || wordsInOrder(normalized, title)) return "words";
  return null;
}

/** All matches across every tier, best first — the data behind `resolve`. */
export function rankRefMatches<T extends RefCandidate>(
  ref: string,
  candidates: readonly T[],
): RefMatch<T>[] {
  const normalized = normalizeRef(ref);
  const matches: RefMatch<T>[] = [];
  for (const candidate of candidates) {
    const tier = tierOf(ref, candidate);
    if (tier === null) continue;
    // Within a tier, the candidate that has least text beyond the phrase is
    // the one the speaker most likely meant.
    const slack = Math.max(0, normalizeRef(candidate.slug).length - normalized.length);
    matches.push({ candidate, tier, score: TIER_SCORE[tier] - Math.min(slack, 20) / 100 });
  }
  matches.sort(
    (left, right) =>
      right.score - left.score || left.candidate.slug.localeCompare(right.candidate.slug),
  );
  return matches;
}

/** Wikilinks are written, not spoken, so they resolve exactly or normalized
 * and never fuzzily: a typo in a link should surface as dangling in doctor
 * rather than silently point at the nearest neighbour. */
export function buildLinkLookup(candidates: readonly RefCandidate[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  const add = (key: string, slug: string): void => {
    if (key === "") return;
    const slugs = lookup.get(key);
    if (slugs === undefined) lookup.set(key, [slug]);
    else if (!slugs.includes(slug)) slugs.push(slug);
  };
  for (const candidate of candidates) {
    add(`s:${candidate.slug}`, candidate.slug);
    add(`t:${candidate.title}`, candidate.slug);
    add(`n:${normalizeRef(candidate.slug)}`, candidate.slug);
    add(`n:${normalizeRef(candidate.title)}`, candidate.slug);
  }
  return lookup;
}

export function lookupLinkTarget(
  lookup: Map<string, string[]>,
  target: string,
): { slug: string } | { ambiguous: string[] } | null {
  const trimmed = target.trim();
  for (const key of [`s:${trimmed}`, `t:${trimmed}`, `n:${normalizeRef(trimmed)}`]) {
    const slugs = lookup.get(key);
    if (slugs === undefined || slugs.length === 0) continue;
    return slugs.length === 1 ? { slug: slugs[0]! } : { ambiguous: [...slugs].sort() };
  }
  return null;
}

/** Exactly one document, or an error that names the alternatives — a voice
 * agent has to be able to read the ambiguity back to the speaker. */
export function resolveRef<T extends RefCandidate>(ref: string, candidates: readonly T[]): T {
  const matches = rankRefMatches(ref, candidates);
  for (const tier of TIER_ORDER) {
    const tierMatches = matches.filter((match) => match.tier === tier);
    if (tierMatches.length === 0) continue;
    if (tierMatches.length === 1) return tierMatches[0]!.candidate;
    const names = tierMatches.map((match) => match.candidate.slug);
    throw new CliError(
      "ambiguous_ref",
      `"${ref}" matches ${names.length} documents: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`,
      `Use one of those slugs, or run: agentwiki resolve "${ref}" --json`,
    );
  }
  throw new CliError(
    "document_not_found",
    `no document matches "${ref}"`,
    `Run: agentwiki search "${ref}" --json`,
  );
}
