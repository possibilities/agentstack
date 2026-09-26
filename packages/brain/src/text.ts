import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { ChunkBlockType } from "./types.js";

export type { ChunkBlockType } from "./types.js";

const DEFAULT_CHUNK_CHARS = 3200;
const DEFAULT_CHUNK_OVERLAP = 350;
export const TEXT_CHUNKER_VERSION = "text-v1";
export const MARKDOWN_CHUNKER_VERSION = "markdown-block-v1";

export interface TextChunk {
  start: number;
  end: number;
  content: string;
  startLine: number;
  endLine: number;
  blockTypes: ChunkBlockType[];
  headingPath: string[];
  structuralAnchor: string;
  revisionDigest: string;
  chunkerVersion: string;
  chunkDigest: string;
  duplicateOrdinal: number;
  chunkIdentity: string;
}

interface PendingChunk {
  start: number;
  end: number;
  content: string;
  startLine: number;
  endLine: number;
  blockTypes: ChunkBlockType[];
  headingPath: string[];
  structuralAnchor: string;
}

interface MarkdownPoint {
  line: number;
  column: number;
  offset?: number;
}

interface MarkdownNode {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: {
    start: MarkdownPoint;
    end: MarkdownPoint;
  };
}

interface HeadingCrumb {
  level: number;
  label: string;
  segment: string;
}

interface StructuralBlock {
  type: ChunkBlockType;
  raw: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

interface Section {
  anchor: string;
  headingPath: HeadingCrumb[];
  blocks: StructuralBlock[];
}

interface BlockFragment extends Omit<StructuralBlock, "raw"> {
  body: string;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const replace =
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31);
    return replace ? " " : character;
  }).join("");
}

export function cleanMarkdown(value: string): string {
  return replaceControlCharacters(
    (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  ).trim();
}

export function cleanText(value: string): string {
  const normalized = replaceControlCharacters(
    (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  );
  if (isMarkdownContent({ content: normalized })) return normalized.trim();
  return normalized
    .replace(/[ \t]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeTags(tags: unknown): string[] {
  let raw: string[];
  if (tags === null || tags === undefined) raw = [];
  else if (typeof tags === "string") raw = tags.split(/[,#]\s*|\s+#/);
  else if (Array.isArray(tags)) raw = tags.map(String);
  else raw = [String(tags)];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of raw) {
    const tag = item
      .trim()
      .toLowerCase()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_.-]/g, "");
    if (tag.length > 0 && !seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  return normalized;
}

export function isMarkdownContent(input: {
  sourceType?: string;
  sourceUri?: string;
  mediaType?: string | null;
  content?: string;
}): boolean {
  const mediaType = ((input.mediaType ?? "").split(";", 1)[0] ?? "")
    .trim()
    .toLowerCase();
  if (
    mediaType === "text/markdown" ||
    mediaType === "text/x-markdown" ||
    mediaType === "application/markdown"
  ) {
    return true;
  }
  const uri = ((input.sourceUri ?? "").split(/[?#]/, 1)[0] ?? "").toLowerCase();
  if (uri.endsWith(".md") || uri.endsWith(".markdown")) return true;
  const sourceType = (input.sourceType ?? "").trim().toLowerCase();
  if (["url", "scraped_url", "tweet", "tweet_article"].includes(sourceType)) {
    return true;
  }
  const content = input.content ?? "";
  if (/^(?: {0,3})(?:`{3,}|~{3,})(?:\S.*)?$/m.test(content)) return true;
  if (/^ {0,3}#{1,6}[ \t]+\S/m.test(content)) return true;
  if (/^ {0,3}>[ \t]?\S/m.test(content)) return true;
  if (/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+\S/m.test(content)) return true;
  if (/^\s*\|?.+\|.+\|?\s*\n\s*\|?\s*:?-{3,}/m.test(content)) {
    return true;
  }
  return false;
}

function validateChunkOptions(chunkChars: number, overlap?: number): void {
  if (!Number.isInteger(chunkChars) || chunkChars < 1) {
    throw new Error("chunkChars must be a positive integer");
  }
  if (
    overlap !== undefined &&
    (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkChars)
  ) {
    throw new Error(
      "overlap must be a non-negative integer smaller than chunkChars",
    );
  }
}

function codePointLineMap(points: string[]): Uint32Array {
  const lines = new Uint32Array(points.length + 1);
  let line = 1;
  lines[0] = line;
  for (const [index, point] of points.entries()) {
    if (point === "\n") line += 1;
    lines[index + 1] = line;
  }
  return lines;
}

function finalizeChunks(
  chunks: PendingChunk[],
  revisionDigest: string,
  chunkerVersion: string,
): TextChunk[] {
  const digestCounts = new Map<string, number>();
  const anchorCounts = new Map<string, number>();
  return chunks.map((chunk) => {
    const chunkDigest = sha256Text(chunk.content);
    const duplicateOrdinal = digestCounts.get(chunkDigest) ?? 0;
    digestCounts.set(chunkDigest, duplicateOrdinal + 1);
    const anchorOrdinal = anchorCounts.get(chunk.structuralAnchor) ?? 0;
    anchorCounts.set(chunk.structuralAnchor, anchorOrdinal + 1);
    const chunkIdentity = sha256Text(
      [
        chunkerVersion,
        revisionDigest,
        chunk.structuralAnchor,
        String(anchorOrdinal),
        chunkDigest,
        String(chunk.start),
        String(chunk.end),
      ].join("\0"),
    );
    return {
      ...chunk,
      revisionDigest,
      chunkerVersion,
      chunkDigest,
      duplicateOrdinal,
      chunkIdentity,
    };
  });
}

function lastBoundary(window: string): { offset: number; width: number } {
  const paragraph = window.lastIndexOf("\n\n");
  const sentence = window.lastIndexOf(". ");
  const newline = window.lastIndexOf("\n");
  const utf16Offset = Math.max(paragraph, sentence, newline);
  if (utf16Offset < 0) return { offset: -1, width: 0 };
  return {
    offset: codePointLength(window.slice(0, utf16Offset)),
    width: utf16Offset === paragraph ? 2 : 1,
  };
}

export function chunkText(
  text: string,
  chunkChars = DEFAULT_CHUNK_CHARS,
  overlap = DEFAULT_CHUNK_OVERLAP,
  revisionDigest = sha256Text(text ?? ""),
): TextChunk[] {
  validateChunkOptions(chunkChars, overlap);
  const source = text ?? "";
  const points = Array.from(source);
  if (points.length === 0) return [];
  const lines = codePointLineMap(points);
  const chunks: PendingChunk[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + chunkChars);
    if (end < points.length) {
      const boundary = lastBoundary(points.slice(start, end).join(""));
      if (boundary.offset > chunkChars * 0.55) {
        end = start + boundary.offset + boundary.width;
      }
    }
    const content = points.slice(start, end).join("").trim();
    if (content.length > 0) {
      const index = chunks.length;
      chunks.push({
        start,
        end,
        content,
        startLine: lines[start] ?? 1,
        endLine: lines[Math.max(start, end - 1)] ?? lines.at(-1) ?? 1,
        blockTypes: ["text"],
        headingPath: [],
        structuralAnchor: `text:${index + 1}`,
      });
    }
    if (end >= points.length) break;
    const previousStart = chunks.at(-1)?.start ?? start;
    const previousEnd = chunks.at(-1)?.end ?? end;
    start = Math.max(0, end - overlap);
    if (start <= previousStart) start = previousEnd;
  }
  return finalizeChunks(chunks, revisionDigest, TEXT_CHUNKER_VERSION);
}

function markdownBlockType(type: string): ChunkBlockType {
  if (type === "heading") return "heading";
  if (type === "paragraph") return "paragraph";
  if (type === "list") return "list";
  if (type === "code") return "code";
  if (type === "table") return "table";
  if (type === "blockquote") return "blockquote";
  if (type === "thematicBreak") return "thematic_break";
  if (type === "html") return "html";
  if (type === "definition") return "definition";
  return "other";
}

function headingLabel(node: MarkdownNode): string {
  const values: string[] = [];
  const visit = (child: MarkdownNode): void => {
    if (typeof child.value === "string") values.push(child.value);
    else if (typeof child.alt === "string") values.push(child.alt);
    for (const nested of child.children ?? []) visit(nested);
  };
  visit(node);
  return values.join("").replace(/\s+/g, " ").trim() || "Untitled section";
}

function anchorSlug(label: string): string {
  const slug = label
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function utf16ToCodePointMap(value: string): Uint32Array {
  const map = new Uint32Array(value.length + 1);
  let codePoints = 0;
  let index = 0;
  while (index < value.length) {
    const width = (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    map[index] = codePoints;
    if (width === 2) map[index + 1] = codePoints;
    index += width;
    codePoints += 1;
    map[index] = codePoints;
  }
  return map;
}

function parseSections(markdown: string): Section[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as MarkdownNode;
  const offsetMap = utf16ToCodePointMap(markdown);
  const sections: Section[] = [];
  const headingStack: HeadingCrumb[] = [];
  const anchorOccurrences = new Map<string, number>();
  let current: Section = {
    anchor: "#preamble",
    headingPath: [],
    blocks: [],
  };

  for (const node of tree.children ?? []) {
    const position = node.position;
    if (
      position?.start.offset === undefined ||
      position.end.offset === undefined
    ) {
      continue;
    }
    if (node.type === "heading") {
      if (current.blocks.length > 0) sections.push(current);
      const level = Math.min(6, Math.max(1, node.depth ?? 1));
      while (
        headingStack.length > 0 &&
        (headingStack.at(-1)?.level ?? 0) >= level
      ) {
        headingStack.pop();
      }
      const label = headingLabel(node);
      const parentAnchor = headingStack.map((crumb) => crumb.segment).join("/");
      const slug = anchorSlug(label);
      const baseAnchor = [parentAnchor, slug].filter(Boolean).join("/");
      const occurrence = (anchorOccurrences.get(baseAnchor) ?? 0) + 1;
      anchorOccurrences.set(baseAnchor, occurrence);
      const segment = occurrence === 1 ? slug : `${slug}~${occurrence}`;
      headingStack.push({ level, label, segment });
      current = {
        anchor: `#${headingStack.map((crumb) => crumb.segment).join("/")}`,
        headingPath: headingStack.map((crumb) => ({ ...crumb })),
        blocks: [],
      };
    }
    const startUtf16 = position.start.offset;
    const endUtf16 = position.end.offset;
    current.blocks.push({
      type: markdownBlockType(node.type),
      raw: markdown.slice(startUtf16, endUtf16),
      start: offsetMap[startUtf16] ?? 0,
      end: offsetMap[endUtf16] ?? offsetMap[offsetMap.length - 1] ?? 0,
      startLine: position.start.line,
      endLine: position.end.line,
    });
  }
  if (current.blocks.length > 0) sections.push(current);
  return sections;
}

function boundedBreadcrumb(path: HeadingCrumb[], chunkChars: number): string {
  if (path.length === 0) return "";
  const full = path
    .map((crumb) => `${"#".repeat(crumb.level)} ${crumb.label}`)
    .join("\n");
  const limit = Math.max(1, Math.floor(chunkChars * 0.4));
  const points = Array.from(full);
  if (points.length <= limit) return full;
  if (limit === 1) return "…";
  return `${points
    .slice(0, limit - 1)
    .join("")
    .trimEnd()}…`;
}

function relativeLineOffsets(raw: string): Array<{
  text: string;
  start: number;
  end: number;
  lineOffset: number;
}> {
  const lines = raw.split("\n");
  const output = [];
  let offset = 0;
  for (const [lineOffset, text] of lines.entries()) {
    const length = codePointLength(text);
    output.push({ text, start: offset, end: offset + length, lineOffset });
    offset += length + (lineOffset < lines.length - 1 ? 1 : 0);
  }
  return output;
}

function splitLongText(
  text: string,
  limit: number,
): Array<{ body: string; start: number; end: number }> {
  const points = Array.from(text);
  const parts: Array<{ body: string; start: number; end: number }> = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + limit);
    if (end < points.length) {
      const window = points.slice(start, end).join("");
      const candidates = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("\n"),
        window.lastIndexOf(" "),
      ];
      const boundary = Math.max(...candidates);
      if (boundary >= limit * 0.55) {
        end = start + codePointLength(window.slice(0, boundary + 1));
      }
    }
    const body = points.slice(start, end).join("").trim();
    if (body.length > 0) parts.push({ body, start, end });
    start = end;
  }
  return parts;
}

function rawFragments(
  block: StructuralBlock,
  maxBodyChars: number,
): BlockFragment[] {
  if (codePointLength(block.raw) <= maxBodyChars) {
    return [{ ...block, body: block.raw }];
  }
  const points = Array.from(block.raw);
  const lineAt: number[] = new Array(points.length + 1);
  let lineOffset = 0;
  lineAt[0] = 0;
  for (const [index, point] of points.entries()) {
    if (point === "\n") lineOffset += 1;
    lineAt[index + 1] = lineOffset;
  }
  return splitLongText(block.raw, maxBodyChars).map((part) => ({
    type: block.type,
    body: part.body,
    start: block.start + part.start,
    end: block.start + part.end,
    startLine: block.startLine + (lineAt[part.start] ?? 0),
    endLine: block.startLine + (lineAt[part.end] ?? lineOffset),
  }));
}

function codeFragments(
  block: StructuralBlock,
  maxBodyChars: number,
): BlockFragment[] {
  const lines = relativeLineOffsets(block.raw);
  const opening = lines[0]?.text ?? "";
  const fence = opening.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
  const closing = lines.at(-1)?.text ?? "";
  if (
    fence === undefined ||
    !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(closing)
  ) {
    return rawFragments(block, maxBodyChars);
  }
  const wrapperLength = codePointLength(opening) + codePointLength(closing) + 2;
  const bodyLimit = maxBodyChars - wrapperLength;
  if (bodyLimit < 1) return rawFragments(block, maxBodyChars);
  const inner = lines.slice(1, -1);
  if (inner.length === 0) return [{ ...block, body: block.raw }];
  const parts: Array<{ lines: typeof inner; text: string }> = [];
  let selected: typeof inner = [];
  let selectedLength = 0;
  const flush = (): void => {
    if (selected.length === 0) return;
    parts.push({
      lines: selected,
      text: selected.map((line) => line.text).join("\n"),
    });
    selected = [];
    selectedLength = 0;
  };
  for (const line of inner) {
    const length = codePointLength(line.text) + (selected.length > 0 ? 1 : 0);
    if (codePointLength(line.text) > bodyLimit) {
      flush();
      for (const part of splitLongText(line.text, bodyLimit)) {
        parts.push({
          lines: [
            {
              ...line,
              text: part.body,
              start: line.start + part.start,
              end: line.start + part.end,
            },
          ],
          text: part.body,
        });
      }
    } else {
      if (selected.length > 0 && selectedLength + length > bodyLimit) flush();
      selected.push(line);
      selectedLength +=
        codePointLength(line.text) + (selected.length > 1 ? 1 : 0);
    }
  }
  flush();
  return parts.map((part, index) => {
    const first = part.lines[0];
    const last = part.lines.at(-1) ?? first;
    return {
      type: "code",
      body: `${opening}\n${part.text}\n${closing}`,
      start: index === 0 ? block.start : block.start + (first?.start ?? 0),
      end:
        index === parts.length - 1 ? block.end : block.start + (last?.end ?? 0),
      startLine:
        index === 0
          ? block.startLine
          : block.startLine + (first?.lineOffset ?? 0),
      endLine:
        index === parts.length - 1
          ? block.endLine
          : block.startLine + (last?.lineOffset ?? 0),
    };
  });
}

function tableFragments(
  block: StructuralBlock,
  maxBodyChars: number,
): BlockFragment[] {
  const lines = relativeLineOffsets(block.raw);
  const [headerLine, delimiterLine] = lines;
  if (
    lines.length < 3 ||
    headerLine === undefined ||
    delimiterLine === undefined
  ) {
    return rawFragments(block, maxBodyChars);
  }
  const header = `${headerLine.text}\n${delimiterLine.text}`;
  const rowLimit = maxBodyChars - codePointLength(header) - 1;
  if (rowLimit < 1) return rawFragments(block, maxBodyChars);
  const rows = lines.slice(2);
  const parts: Array<typeof rows> = [];
  let selected: typeof rows = [];
  let length = 0;
  const flush = (): void => {
    if (selected.length > 0) parts.push(selected);
    selected = [];
    length = 0;
  };
  for (const row of rows) {
    if (codePointLength(row.text) > rowLimit) {
      flush();
      return rawFragments(block, maxBodyChars);
    }
    const addition = codePointLength(row.text) + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && length + addition > rowLimit) flush();
    selected.push(row);
    length += codePointLength(row.text) + (selected.length > 1 ? 1 : 0);
  }
  flush();
  return parts.map((part, index) => {
    const first = part[0];
    const last = part.at(-1) ?? first;
    return {
      type: "table",
      body: `${header}\n${part.map((line) => line.text).join("\n")}`,
      start: index === 0 ? block.start : block.start + (first?.start ?? 0),
      end: block.start + (last?.end ?? 0),
      startLine:
        index === 0
          ? block.startLine
          : block.startLine + (first?.lineOffset ?? 0),
      endLine: block.startLine + (last?.lineOffset ?? 0),
    };
  });
}

function fragmentBlock(
  block: StructuralBlock,
  maxBodyChars: number,
): BlockFragment[] {
  if (block.type === "heading") {
    return [
      {
        type: block.type,
        body: "",
        start: block.start,
        end: block.end,
        startLine: block.startLine,
        endLine: block.endLine,
      },
    ];
  }
  if (codePointLength(block.raw) <= maxBodyChars) {
    return [{ ...block, body: block.raw }];
  }
  if (block.type === "code") return codeFragments(block, maxBodyChars);
  if (block.type === "table") return tableFragments(block, maxBodyChars);
  return rawFragments(block, maxBodyChars);
}

function uniqueBlockTypes(fragments: BlockFragment[]): ChunkBlockType[] {
  const seen = new Set<ChunkBlockType>();
  const output: ChunkBlockType[] = [];
  for (const fragment of fragments) {
    if (!seen.has(fragment.type)) {
      seen.add(fragment.type);
      output.push(fragment.type);
    }
  }
  return output;
}

export function chunkMarkdown(
  markdown: string,
  chunkChars = DEFAULT_CHUNK_CHARS,
  revisionDigest = sha256Text(markdown ?? ""),
): TextChunk[] {
  validateChunkOptions(chunkChars);
  const source = markdown ?? "";
  if (source.length === 0) return [];
  const pending: PendingChunk[] = [];
  for (const section of parseSections(source)) {
    const breadcrumb = boundedBreadcrumb(section.headingPath, chunkChars);
    const separatorLength = breadcrumb.length > 0 ? 2 : 0;
    const maxBodyChars = Math.max(
      1,
      chunkChars - codePointLength(breadcrumb) - separatorLength,
    );
    const fragments = section.blocks.flatMap((block) =>
      fragmentBlock(block, maxBodyChars),
    );
    let selected: BlockFragment[] = [];
    let bodyLength = 0;
    const flush = (): void => {
      if (selected.length === 0) return;
      const body = selected
        .map((fragment) => fragment.body)
        .filter((value) => value.length > 0)
        .join("\n\n");
      const content = [breadcrumb, body].filter(Boolean).join("\n\n");
      const first = selected[0];
      const last = selected.at(-1) ?? first;
      if (first === undefined || last === undefined) return;
      pending.push({
        start: first.start,
        end: last.end,
        content,
        startLine: first.startLine,
        endLine: last.endLine,
        blockTypes: uniqueBlockTypes(selected),
        headingPath: section.headingPath.map((crumb) => crumb.label),
        structuralAnchor: section.anchor,
      });
      selected = [];
      bodyLength = 0;
    };
    for (const fragment of fragments) {
      const fragmentLength = codePointLength(fragment.body);
      const addition =
        fragmentLength + (bodyLength > 0 && fragmentLength > 0 ? 2 : 0);
      if (
        selected.length > 0 &&
        fragmentLength > 0 &&
        bodyLength + addition > maxBodyChars
      ) {
        flush();
      }
      selected.push(fragment);
      bodyLength +=
        fragmentLength + (bodyLength > 0 && fragmentLength > 0 ? 2 : 0);
    }
    flush();
  }
  return finalizeChunks(pending, revisionDigest, MARKDOWN_CHUNKER_VERSION);
}
