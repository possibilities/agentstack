import type { ContentItem, ContentItemKind, ContentItemScope, ContentOrigins } from "./types";

/** Mirrors the Content API: base64 transfers and chunks are at most 256 KiB decoded. */
export const inlineLimit = 256 * 1024;
/** Mirrors the Content API's item and staged-upload ceiling. */
export const itemLimit = 50 * 1024 * 1024;
/** Images larger than this are not pulled through the Package API for an inline preview. */
export const imagePreviewLimit = 8 * 1024 * 1024;
/** Document items larger than this are not loaded into the editor. */
export const editableLimit = 4 * 1024 * 1024;
/** The bytes a file preview reads to show text or hex. */
export const peekBytes = 4 * 1024;

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** The item kind and parameterless media type the Content API will accept for a local file. */
export function itemKindFor(name: string, type: string): { kind: ContentItemKind; mediaType: string } {
  const bare = type.split(";")[0]!.trim().toLowerCase();
  if (imageTypes.has(bare)) return { kind: "image", mediaType: bare };
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (bare === "text/markdown" || extension === "md" || extension === "markdown") return { kind: "document", mediaType: "text/markdown" };
  if (bare === "text/plain" || extension === "txt") return { kind: "document", mediaType: "text/plain" };
  const valid = /^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(bare) && !/[;,\\]/.test(bare);
  return { kind: "file", mediaType: valid ? bare : "application/octet-stream" };
}

/** A collection slug from a title: lowercase words joined by hyphens, at most 80 characters. */
export function slugify(title: string): string {
  return title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}

export const validSlug = (slug: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 80;

export function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) { value /= 1_024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Client-side narrowing of the loaded item page by kind and name. */
export function filterItems(items: ContentItem[], kind: ContentItemKind | "all", query: string): ContentItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => (kind === "all" || item.kind === kind) && words.every((word) => item.name.toLowerCase().includes(word)));
}

export const scopeKey = (scope: ContentItemScope): string => scope === undefined ? "all" : scope === null ? "ungrouped" : `collection:${scope}`;

/** Text when the bytes are UTF-8 without control characters other than whitespace; otherwise null. */
export function asText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000e-\u001f\u007f]/.test(text) ? null : text;
  } catch {
    // A multi-byte character cut at the end of a peek is still text.
    if (bytes.length < 4) return null;
    for (let cut = 1; cut <= 3; cut++) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - cut));
        return /[\u0000-\u0008\u000e-\u001f\u007f]/.test(text) ? null : text;
      } catch { /* try a shorter cut */ }
    }
    return null;
  }
}

/** Classic 16-byte rows: offset, hex, printable ASCII. */
export function hexDump(bytes: Uint8Array, rows = 16): string {
  const lines: string[] = [];
  for (let offset = 0; offset < Math.min(bytes.length, rows * 16); offset += 16) {
    const slice = Array.from(bytes.subarray(offset, offset + 16));
    const hex = slice.map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = slice.map((byte) => byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The partial reference being typed after an unclosed `[[` just before the caret, or null.
 * Returns where the reference starts so a choice can replace it.
 */
export function wikilinkQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open < 0) return null;
  const partial = before.slice(open + 2);
  if (/[\]\n|]/.test(partial) || partial.length > 80) return null;
  return { start: open + 2, query: partial };
}

/** Insert a chosen slug for the reference being typed, closing the link. */
export function completeWikilink(text: string, caret: number, slug: string): { text: string; caret: number } | null {
  const found = wikilinkQuery(text, caret);
  if (!found) return null;
  const closed = text.slice(caret).startsWith("]]");
  const insert = closed ? slug : `${slug}]]`;
  return { text: `${text.slice(0, found.start)}${insert}${text.slice(caret)}`, caret: found.start + slug.length + 2 };
}

/** `[[target]]` and `[[target|label]]` become Markdown links whose href names the target document. */
export const wikilinkPrefix = "#content-document:";
export function linkWikilinks(markdown: string): string {
  let fenced = false;
  return markdown.split("\n").map((line) => {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return line.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_match, target: string, label?: string) =>
      `[${(label ?? target).trim().replace(/[[\]]/g, "")}](${wikilinkPrefix}${encodeURIComponent(target.trim())})`);
  }).join("\n");
}

/** Loopback UI pages can open Content's loopback origins; a remote page would need an Access Content handoff. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** An absolute URL on a Content origin, or null when this page cannot reach it. */
export function contentHref(origins: ContentOrigins | null | undefined, which: keyof ContentOrigins, path: string, hostname: string | null): string | null {
  if (!origins || !hostname || !isLoopbackHost(hostname)) return null;
  const base = origins[which];
  try {
    const host = new URL(base).hostname;
    if (!isLoopbackHost(host) && host !== "[::1]") return null;
  } catch { return null; }
  return `${base}${path}`;
}

/** Route templates from `content_status`, filled for one record. */
export function fillRoute(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => encodeURIComponent(values[key] ?? ""));
}

export const defaultRoutes = { documentPath: "/d/{slug}", artifactPath: "/a/{name}/v/{version}/", itemPath: "/c/{id}" };
