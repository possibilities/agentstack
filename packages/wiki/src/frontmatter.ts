import { isMap, parseDocument, stringify } from "yaml";

/** A YAML block fenced by --- at the very top of the file. Anything else,
 * including a --- rule further down, is body. */
const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;

export interface SplitDocument {
  /** {} when the file has no frontmatter block, so readers never branch. */
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  body: string;
}

export function splitDocument(text: string): SplitDocument {
  const opening = OPENING.exec(text);
  if (opening === null) return { frontmatter: {}, hasFrontmatter: false, body: text };
  const rest = text.slice(opening[0].length);
  const lines = rest.split("\n");
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!CLOSING.test(line.replace(/\r$/, ""))) {
      consumed += line.length + 1;
      continue;
    }
    const yamlText = rest.slice(0, consumed);
    const body = rest.slice(consumed + line.length + 1);
    let frontmatter: Record<string, unknown> = {};
    try {
      const document = parseDocument(yamlText);
      // A block YAML cannot parse yields no keys rather than half of them:
      // a partial mapping would silently drop tags or a tombstone.
      if (document.errors.length === 0) {
        const parsed = document.toJS() as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, unknown>;
        }
      }
    } catch {
      frontmatter = {};
    }
    return { frontmatter, hasFrontmatter: true, body };
  }
  // An unterminated block is not frontmatter at all.
  return { frontmatter: {}, hasFrontmatter: false, body: text };
}

export function serializeDocument(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body;
  const yamlText = stringify(frontmatter, { lineWidth: 0 });
  return `---\n${yamlText}---\n${body}`;
}

/** Rewrite a file's frontmatter in place: undefined removes a key, everything
 * else sets it. Existing key order and comments survive, because an agent's
 * hand-written block must come back looking like the one it wrote. */
export function editFrontmatter(
  text: string,
  changes: Record<string, unknown | undefined>,
): string {
  const split = splitDocument(text);
  if (!split.hasFrontmatter) {
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) merged[key] = value;
    }
    return serializeDocument(merged, text);
  }
  const opening = OPENING.exec(text)!;
  const rest = text.slice(opening[0].length);
  const lines = rest.split("\n");
  let consumed = 0;
  for (const line of lines) {
    if (!CLOSING.test(line.replace(/\r$/, ""))) {
      consumed += line.length + 1;
      continue;
    }
    const yamlText = rest.slice(0, consumed);
    const body = rest.slice(consumed + line.length + 1);
    const doc = parseDocument(yamlText);
    if (!isMap(doc.contents)) {
      // A scalar or list where a mapping belongs: replace the block wholesale
      // rather than pretending keys can be merged into a non-mapping.
      const replacement: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) replacement[key] = value;
      }
      return serializeDocument(replacement, body);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) doc.delete(key);
      else doc.set(key, value);
    }
    const rendered = doc.toString({ lineWidth: 0 });
    return `---\n${rendered.endsWith("\n") ? rendered : `${rendered}\n`}---\n${body}`;
  }
  return text;
}

export function frontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = frontmatter[key];
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/** Title precedence: declared, then the first ATX heading, then the slug. */
export function documentTitle(
  frontmatter: Record<string, unknown>,
  body: string,
  fallback: string,
): string {
  const declared = frontmatterString(frontmatter, "title");
  if (declared !== undefined) return declared.trim();
  const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  if (heading?.[1] !== undefined && heading[1].trim() !== "") return heading[1].trim();
  return fallback;
}
