import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { unzipSync } from "fflate";
import { findExecutable } from "./executable.js";
import { sanitizeExternalError } from "./sanitize.js";
import { cleanText } from "./text.js";

export const DEFAULT_MAX_BYTES = 5_000_000;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".org",
  ".adoc",
  ".html",
  ".htm",
  ".xml",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".log",
  ".py",
  ".pyi",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".m",
  ".mm",
  ".sql",
  ".graphql",
  ".gql",
  ".vue",
  ".svelte",
]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".epub"]);
export const DEFAULT_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
]);

const SECRET_PATTERNS = [
  /^\.env($|\.)/i,
  /(^|[-_.])(secret|secrets|credential|credentials|token|tokens|apikey|api_key|password|passwd)([-_.]|$)/i,
  /id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /auth\.json$/i,
  /cookies?\.txt$/i,
];

export interface ExtractedSource {
  source_type: "file" | "url" | "url_text" | "url_pdf";
  source_uri: string;
  title: string;
  content: string;
  size_bytes?: number;
  content_type?: string;
}

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);

export function looksSensitiveComponent(name: string): boolean {
  return (
    SENSITIVE_DIRECTORY_NAMES.has(name.toLowerCase()) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(name))
  );
}

export function isProbablyBinary(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  const sample = data.subarray(0, 4096);
  if (sample.includes(0)) return true;
  let textish = 0;
  for (const byte of sample) {
    if (
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126) ||
      byte >= 128
    ) {
      textish += 1;
    }
  }
  return textish / sample.length < 0.75;
}

export function decodeBytes(data: Uint8Array): string {
  for (const encoding of ["utf-8", "macintosh"] as const) {
    try {
      return new TextDecoder(encoding as never, { fatal: true }).decode(data);
    } catch {
      // Try the next legacy fallback.
    }
  }
  let latin1 = "";
  const blockSize = 8192;
  for (let offset = 0; offset < data.length; offset += blockSize) {
    latin1 += String.fromCharCode(...data.subarray(offset, offset + blockSize));
  }
  return latin1;
}

function validEntityCodePoint(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
  );
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    const value = Number.parseInt(entity.slice(2), 16);
    return validEntityCodePoint(value)
      ? String.fromCodePoint(value)
      : `&${entity};`;
  }
  if (entity.startsWith("#")) {
    const value = Number.parseInt(entity.slice(1), 10);
    return validEntityCodePoint(value)
      ? String.fromCodePoint(value)
      : `&${entity};`;
  }
  return named[entity.toLowerCase()] ?? `&${entity};`;
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) =>
    decodeEntity(entity),
  );
}

export function extractHtmlText(html: string): {
  content: string;
  title: string | null;
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? cleanText(
        decodeHtmlEntities((titleMatch[1] ?? "").replace(/<[^>]+>/g, " ")),
      )
    : null;
  const withoutNoise = html.replace(
    /<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  const withBreaks = withoutNoise
    .replace(
      /<\/?(?:p|div|article|section|main|header|footer|aside|h[1-6]|li|tr|blockquote)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<br\s*\/?\s*>/gi, "\n");
  return {
    content: cleanText(decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))),
    title: title || null,
  };
}

function safeArchive(
  data: Uint8Array,
  wanted: (name: string) => boolean,
  maxBytes: number,
): Record<string, Uint8Array> {
  let selectedBytes = 0;
  const files = unzipSync(data, {
    filter(file) {
      const normalizedName = file.name.replaceAll("\\", "/");
      if (
        file.name.length > 1024 ||
        file.name.includes("\0") ||
        normalizedName.startsWith("/") ||
        normalizedName.split("/").includes("..")
      ) {
        throw new Error("unsafe filename in ZIP container");
      }
      if (!wanted(file.name)) return false;
      selectedBytes += file.originalSize;
      if (file.originalSize > maxBytes || selectedBytes > maxBytes) {
        throw new Error(
          `expanded document is larger than max_bytes (${maxBytes})`,
        );
      }
      return true;
    },
  });
  let actualSelectedBytes = 0;
  for (const entry of Object.values(files)) {
    actualSelectedBytes += entry.byteLength;
    if (entry.byteLength > maxBytes || actualSelectedBytes > maxBytes) {
      throw new Error(
        `expanded document is larger than max_bytes (${maxBytes})`,
      );
    }
  }
  return files;
}

export function extractDocxBytes(data: Uint8Array, maxBytes: number): string {
  const files = safeArchive(
    data,
    (name) => name.replaceAll("\\", "/") === "word/document.xml",
    maxBytes,
  );
  const entry = Object.entries(files).find(
    ([name]) => name.replaceAll("\\", "/") === "word/document.xml",
  )?.[1];
  if (!entry) throw new Error("DOCX has no word/document.xml");
  const xml = decodeBytes(entry)
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")
    .replace(/<w:br\b[^>]*\/>/gi, "\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return cleanText(decodeHtmlEntities(xml));
}

export function extractEpubBytes(data: Uint8Array, maxBytes: number): string {
  const files = safeArchive(
    data,
    (name) => /\.(?:html?|xhtml)$/i.test(name),
    maxBytes,
  );
  const parts: string[] = [];
  for (const [, bytes] of Object.entries(files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const extracted = extractHtmlText(decodeBytes(bytes)).content;
    if (extracted) parts.push(extracted);
  }
  return cleanText(parts.join("\n\n"));
}

function sanitizedPdfError(value: unknown, resolvedPath: string): string {
  const withoutInputPath =
    value instanceof Error
      ? new Error(
          value.message.replaceAll(resolvedPath, basename(resolvedPath)),
        )
      : String(value ?? "").replaceAll(resolvedPath, basename(resolvedPath));
  return sanitizeExternalError(withoutInputPath);
}

export function extractPdf(path: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const resolvedPath = realpathSync(path);
  const size = statSync(resolvedPath).size;
  if (maxBytes > 0 && size > Math.max(maxBytes, 1_000_000)) {
    throw new Error(`PDF is larger than max_bytes (${size} > ${maxBytes})`);
  }
  const executable = findExecutable("pdftotext");
  if (!executable) {
    throw new Error("pdftotext is not installed; install poppler or skip PDFs");
  }
  const result = spawnSync(executable, ["-layout", resolvedPath, "-"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: Math.max(maxBytes * 4, 4_000_000),
  });
  if (result.error)
    throw new Error(sanitizedPdfError(result.error, resolvedPath));
  if (result.status !== 0) {
    throw new Error(
      sanitizedPdfError(result.stderr || "pdftotext failed", resolvedPath),
    );
  }
  return cleanText(result.stdout);
}

export function inferTitleFromSource(source: string): string {
  if (!source) return "Untitled";
  try {
    const url = new URL(source);
    const name = url.pathname.split("/").filter(Boolean).at(-1) || url.hostname;
    return decodeURIComponent(name) || url.hostname;
  } catch {
    return basename(source) || source.slice(0, 80);
  }
}

export function extractFile(
  path: string,
  options: { maxBytes?: number; skipSecrets?: boolean } = {},
): ExtractedSource {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const resolved = realpathSync(path);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`not a file: ${resolved}`);
  if (
    options.skipSecrets !== false &&
    resolved.split(/[\\/]/).some(looksSensitiveComponent)
  ) {
    throw new Error(
      `refusing to ingest likely secret file: ${basename(resolved)}`,
    );
  }
  const extension = extname(resolved).toLowerCase();
  if (!DEFAULT_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported extension '${extension}'`);
  }
  if (extension !== ".pdf" && stat.size > maxBytes) {
    throw new Error(
      `file is larger than max_bytes (${stat.size} > ${maxBytes})`,
    );
  }

  let content: string;
  let title = basename(resolved);
  if (extension === ".pdf") {
    content = extractPdf(resolved, maxBytes);
  } else {
    const data = readFileSync(resolved);
    if (extension === ".docx") content = extractDocxBytes(data, maxBytes);
    else if (extension === ".epub") content = extractEpubBytes(data, maxBytes);
    else {
      if (isProbablyBinary(data)) throw new Error("file appears to be binary");
      const decoded = decodeBytes(data);
      if ([".html", ".htm", ".xml"].includes(extension)) {
        const extracted = extractHtmlText(decoded);
        content = extracted.content;
        title = extracted.title || title;
      } else content = cleanText(decoded);
    }
  }
  return {
    source_type: "file",
    source_uri: resolved,
    title,
    content,
    size_bytes: stat.size,
  };
}
