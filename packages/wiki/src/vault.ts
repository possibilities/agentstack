import type { Dirent, Stats } from "node:fs";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { documentTitle, frontmatterString, splitDocument } from "./frontmatter.js";
import type { Environ } from "./paths.js";
import { expandTilde } from "./paths.js";
import { normalizeTags, slugify } from "./slug.js";

export const DEFAULT_VAULT = "~/wiki";
export const VAULT_STATE_DIRECTORY = ".agentwiki";
export const ARTIFACT_DIRECTORY = "artifacts";

/** Precedence is the house rule everywhere: flag, then environment, then the
 * default — an unset option is never sent forward as an empty one. */
export function resolveVaultRoot(env: Environ, home: string, flag: string | undefined): string {
  const chosen = flag ?? env["AGENTWIKI_VAULT"] ?? DEFAULT_VAULT;
  return resolve(expandTilde(chosen, home));
}

export function indexPath(root: string): string {
  return join(root, VAULT_STATE_DIRECTORY, "index.sqlite3");
}

export function templatesDirectory(root: string): string {
  return join(root, VAULT_STATE_DIRECTORY, "templates");
}

/** Directories only. Making the vault a git repository is `ensureGit`, which
 * runs on every write rather than only here: a vault that already existed must
 * still gain a history. */
export function ensureVault(root: string): { created: boolean } {
  let created = false;
  try {
    statSync(root);
  } catch {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    created = true;
  }
  mkdirSync(join(root, VAULT_STATE_DIRECTORY), { recursive: true, mode: 0o700 });
  return { created };
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".xz",
  ".7z",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  ".m4a",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".sqlite3",
  ".db",
  ".wasm",
  ".so",
  ".dylib",
  ".bin",
]);

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface VaultFile {
  /** Vault-relative, POSIX-separated: the index key and the wire spelling. */
  path: string;
  absolute: string;
  size: number;
  mtimeMs: number;
}

/** Dotted names are the vault's own bookkeeping (and the agent's editor
 * leftovers); the walk never descends into them. */
export function walkVault(root: string): VaultFile[] {
  const files: VaultFile[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const directory = queue.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let stats: Stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      files.push({
        path: relative(root, absolute).split(sep).join("/"),
        absolute,
        size: stats.size,
        mtimeMs: Math.round(stats.mtimeMs),
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

export interface ParsedVaultDocument {
  path: string;
  slug: string;
  title: string;
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
  created: string | null;
  updated: string | null;
  deleted: string | null;
  deletedReason: string | null;
  markdown: boolean;
  size: number;
  mtimeMs: number;
}

/** Bytes that are not text belong in artifacts; the sniff keeps a stray
 * binary from poisoning the search index with mojibake. */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

export function readVaultDocument(file: VaultFile): ParsedVaultDocument | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file.absolute);
  } catch {
    return null;
  }
  if (looksBinary(bytes)) return null;
  return parseVaultDocument(file, bytes.toString("utf8"));
}

export function parseVaultDocument(file: VaultFile, text: string): ParsedVaultDocument {
  const markdown = isMarkdownPath(file.path);
  const slug = slugify(basename(file.path, extname(file.path)));
  const split = markdown
    ? splitDocument(text)
    : { frontmatter: {}, hasFrontmatter: false, body: text };
  const title = markdown
    ? documentTitle(split.frontmatter, split.body, humanizeFilename(file.path))
    : humanizeFilename(file.path);
  return {
    path: file.path,
    slug,
    title,
    tags: normalizeTags(split.frontmatter["tags"]),
    body: split.body,
    frontmatter: split.frontmatter,
    created: frontmatterString(split.frontmatter, "created") ?? null,
    updated: frontmatterString(split.frontmatter, "updated") ?? null,
    deleted: frontmatterString(split.frontmatter, "deleted") ?? null,
    deletedReason: frontmatterString(split.frontmatter, "deleted_reason") ?? null,
    markdown,
    size: file.size,
    mtimeMs: file.mtimeMs,
  };
}

function humanizeFilename(path: string): string {
  const name = basename(path, extname(path));
  return name.replace(/[-_]+/g, " ").trim() || path;
}

export function artifactStubPath(root: string, name: string): string {
  return join(root, ARTIFACT_DIRECTORY, `${slugify(name)}.md`);
}
