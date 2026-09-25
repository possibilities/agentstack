/** Slugs are spoken as often as typed, so they stay lowercase ASCII words
 * joined by single hyphens — anything a voice agent could not dictate back
 * is not allowed to reach a filename. */

const MAX_SLUG_LENGTH = 80;

export function slugify(input: string): string {
  const folded = input
    .normalize("NFKD")
    // Combining marks survive NFKD as separate code points; drop them so
    // "Café" and "Cafe" produce the same slug rather than two vault entries.
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const hyphenated = folded
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (hyphenated.length === 0) return "untitled";
  if (hyphenated.length <= MAX_SLUG_LENGTH) return hyphenated;
  const clipped = hyphenated.slice(0, MAX_SLUG_LENGTH);
  const lastBoundary = clipped.lastIndexOf("-");
  return (lastBoundary > 0 ? clipped.slice(0, lastBoundary) : clipped).replace(/-+$/, "");
}

/** The fallback title for a document that never declared one. */
export function humanize(slug: string): string {
  const words = slug.split("-").filter((word) => word.length > 0);
  if (words.length === 0) return "Untitled";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** Tag lists arrive as "a,b" from flags and as arrays from frontmatter. */
export function parseTagList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return normalizeTags(value.split(","));
}

export function normalizeTags(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return typeof values === "string" ? normalizeTags(values.split(",")) : [];
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const tag = slugify(String(value));
    if (tag === "untitled" && String(value).trim().length === 0) continue;
    seen.add(tag);
  }
  return [...seen].sort();
}
