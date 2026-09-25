import { Database } from "./sqlite.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { CliError } from "./errors.js";
import type { Environ } from "./paths.js";
import { slugify } from "./slug.js";

export const MANIFEST_SCHEMA_VERSION = 1;

/** A publish that would take minutes to hash is a mistake, not a document
 * store use case; refuse it with somewhere else to put the bytes. */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export const ARTIFACT_KINDS = ["page", "bundle", "media", "render", "evidence"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Editor and VCS droppings would change a bundle's hash without changing the
 * bundle, so they never enter the content address. */
const EXCLUDED_FROM_BUNDLES = new Set([".git", ".DS_Store", ".agentwiki"]);

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT,
  kind TEXT NOT NULL,
  creator TEXT,
  source_repo TEXT,
  source_commit TEXT,
  tags TEXT NOT NULL,
  entry TEXT,
  is_directory INTEGER NOT NULL,
  size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  media_type TEXT,
  created_at TEXT NOT NULL,
  deleted TEXT,
  deleted_reason TEXT,
  reclaimed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS artifacts_name ON artifacts (name);

CREATE TABLE IF NOT EXISTS names (
  name TEXT PRIMARY KEY,
  latest_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface ArtifactRow {
  id: number;
  name: string;
  version: string;
  title: string | null;
  kind: ArtifactKind;
  creator: string | null;
  sourceRepo: string | null;
  sourceCommit: string | null;
  tags: string[];
  entry: string | null;
  isDirectory: boolean;
  size: number;
  fileCount: number;
  mediaType: string | null;
  createdAt: string;
  deleted: string | null;
  deletedReason: string | null;
  reclaimed: boolean;
  latest: boolean;
}

interface RawArtifact {
  id: number;
  name: string;
  version: string;
  title: string | null;
  kind: string;
  creator: string | null;
  source_repo: string | null;
  source_commit: string | null;
  tags: string;
  entry: string | null;
  is_directory: number;
  size: number;
  file_count: number;
  media_type: string | null;
  created_at: string;
  deleted: string | null;
  deleted_reason: string | null;
  reclaimed: number;
  latest_version: string | null;
}

export interface ContentAddress {
  version: string;
  size: number;
  fileCount: number;
  isDirectory: boolean;
  entry: string | null;
  mediaType: string | null;
}

export interface PublishInput {
  name: string;
  path: string;
  kind?: ArtifactKind;
  title?: string;
  tags: string[];
  creator: string | null;
  source: { repo: string | null; commit: string | null };
  now: string;
}

export interface PublishResult {
  row: ArtifactRow;
  status: "created" | "unchanged";
}

export function artifactHome(env: Environ, home: string): string {
  return env["AGENTSTACK_STATE_DIR"]
    ? join(env["AGENTSTACK_STATE_DIR"], "wiki", "artifacts")
    : join(home, ".local", "state", "agentstack", "wiki", "artifacts");
}

export function casDirectory(env: Environ, home: string): string {
  return join(artifactHome(env, home), "cas");
}

export function manifestPath(env: Environ, home: string): string {
  return join(artifactHome(env, home), "manifest.sqlite3");
}

/** Where a version's bytes live. Single files and directories share the hash
 * namespace because their hashes are computed over different preimages. */
export function objectPath(casRoot: string, version: string): string {
  return join(casRoot, version.slice(0, 2), version);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface BundleFile {
  relative: string;
  absolute: string;
  size: number;
  hash: string;
}

function collectBundle(root: string): BundleFile[] {
  const files: BundleFile[] = [];
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
      if (EXCLUDED_FROM_BUNDLES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(absolute);
      files.push({
        relative: relative(root, absolute).split(sep).join("/"),
        absolute,
        size: bytes.length,
        hash: sha256(bytes),
      });
    }
  }
  files.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
  );
  return files;
}

/** A directory's version is the hash of its sorted (hash, path) manifest, so
 * the same tree published from two machines is the same version. */
export function bundleManifestText(files: readonly { relative: string; hash: string }[]): string {
  return files.map((file) => `${file.hash}  ${file.relative}\n`).join("");
}

export function addressOf(path: string): ContentAddress {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    const files = collectBundle(path);
    if (files.length === 0) {
      throw new CliError("empty_artifact", `nothing to publish: ${path} contains no files`);
    }
    const size = files.reduce((total, file) => total + file.size, 0);
    assertWithinCap(size);
    const entry = files.some((file) => file.relative === "index.html") ? "index.html" : null;
    return {
      version: sha256(Buffer.from(bundleManifestText(files), "utf8")),
      size,
      fileCount: files.length,
      isDirectory: true,
      entry,
      mediaType: null,
    };
  }
  assertWithinCap(stats.size);
  const bytes = readFileSync(path);
  return {
    version: sha256(bytes),
    size: bytes.length,
    fileCount: 1,
    isDirectory: false,
    entry: null,
    mediaType: mediaTypeFor(path),
  };
}

function assertWithinCap(size: number): void {
  if (size <= MAX_ARTIFACT_BYTES) return;
  throw new CliError(
    "artifact_too_large",
    `artifact is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB publish cap`,
    "Trim the bundle, or keep the large original outside the artifact store and publish a render of it.",
  );
}

const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".gz": "application/gzip",
  ".zip": "application/zip",
};

export function mediaTypeFor(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function inferKind(path: string, isDirectory: boolean): ArtifactKind {
  if (isDirectory) return "bundle";
  const extension = extname(path).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "page";
  const mediaType = MEDIA_TYPES[extension] ?? "";
  if (
    mediaType.startsWith("image/") ||
    mediaType.startsWith("video/") ||
    mediaType.startsWith("audio/")
  ) {
    return "media";
  }
  return "evidence";
}

/** Provenance the agent would otherwise have to remember to state. */
export function detectSource(cwd: string): { repo: string | null; commit: string | null } {
  const run = (args: string[]): string | null => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) return null;
    const value = (result.stdout ?? "").trim();
    return value === "" ? null : value;
  };
  const commit = run(["rev-parse", "HEAD"]);
  if (commit === null) return { repo: null, commit: null };
  return {
    repo: run(["remote", "get-url", "origin"]) ?? run(["rev-parse", "--show-toplevel"]),
    commit,
  };
}

export class ArtifactStore {
  private constructor(
    private readonly db: Database,
    readonly casRoot: string,
  ) {}

  static open(env: Environ, home: string): ArtifactStore {
    const root = artifactHome(env, home);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(casDirectory(env, home), { recursive: true, mode: 0o700 });
    const db = new Database(manifestPath(env, home), { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    try {
      initializeSchema(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return new ArtifactStore(db, casDirectory(env, home));
  }

  close(): void {
    this.db.close();
  }

  publish(input: PublishInput): PublishResult {
    const source = resolve(input.path);
    let address: ContentAddress;
    try {
      address = addressOf(source);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        "artifact_unreadable",
        `cannot read ${source}: ${(error as Error).message}`,
      );
    }
    const existing = this.version(input.name, address.version);
    this.storeObject(source, address);
    if (existing !== null && existing.deleted === null && !existing.reclaimed) {
      this.setLatest(input.name, address.version, input.now);
      return { row: this.version(input.name, address.version)!, status: "unchanged" };
    }
    const kind = input.kind ?? inferKind(source, address.isDirectory);
    this.db
      .query(
        `INSERT INTO artifacts
           (name, version, title, kind, creator, source_repo, source_commit, tags, entry,
            is_directory, size, file_count, media_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (name, version) DO UPDATE SET
           deleted = NULL, deleted_reason = NULL, reclaimed = 0,
           title = excluded.title, kind = excluded.kind, tags = excluded.tags`,
      )
      .run(
        input.name,
        address.version,
        input.title ?? null,
        kind,
        input.creator,
        input.source.repo,
        input.source.commit,
        JSON.stringify(input.tags),
        address.entry,
        address.isDirectory ? 1 : 0,
        address.size,
        address.fileCount,
        address.mediaType,
        input.now,
      );
    this.setLatest(input.name, address.version, input.now);
    return { row: this.version(input.name, address.version)!, status: "created" };
  }

  /** Objects are written once. An existing object is proof of identical bytes,
   * so a republish never rewrites content that something may be serving. */
  private storeObject(source: string, address: ContentAddress): void {
    const destination = objectPath(this.casRoot, address.version);
    try {
      statSync(destination);
      return;
    } catch {
      // Not stored yet.
    }
    mkdirSync(join(this.casRoot, address.version.slice(0, 2)), { recursive: true, mode: 0o700 });
    const staging = `${destination}.staging.${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    if (address.isDirectory) {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      for (const file of collectBundle(source)) {
        const target = join(staging, file.relative.split("/").join(sep));
        mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
        copyFileSync(file.absolute, target);
      }
    } else {
      copyFileSync(source, staging);
    }
    try {
      renameSync(staging, destination);
    } catch {
      // A concurrent publish of identical bytes won the race; its object is
      // byte-identical by construction, so keep it and drop ours.
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private setLatest(name: string, version: string, now: string): void {
    this.db
      .query(
        `INSERT INTO names (name, latest_version, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET latest_version = excluded.latest_version,
                                          updated_at = excluded.updated_at`,
      )
      .run(name, version, now);
  }

  names(options: { includeDeleted?: boolean } = {}): ArtifactRow[] {
    const rows = this.db
      .query(
        `SELECT artifacts.*, names.latest_version AS latest_version
         FROM names JOIN artifacts
           ON artifacts.name = names.name AND artifacts.version = names.latest_version
         ${options.includeDeleted === true ? "" : "WHERE artifacts.deleted IS NULL"}
         ORDER BY names.updated_at DESC, artifacts.name ASC`,
      )
      .all() as RawArtifact[];
    return rows.map(hydrate);
  }

  versions(name: string): ArtifactRow[] {
    const rows = this.db
      .query(
        `SELECT artifacts.*, names.latest_version AS latest_version
         FROM artifacts LEFT JOIN names ON names.name = artifacts.name
         WHERE artifacts.name = ? ORDER BY artifacts.created_at DESC, artifacts.id DESC`,
      )
      .all(name) as RawArtifact[];
    return rows.map(hydrate);
  }

  latest(name: string): ArtifactRow | null {
    const row = this.db
      .query(
        `SELECT artifacts.*, names.latest_version AS latest_version
         FROM names JOIN artifacts
           ON artifacts.name = names.name AND artifacts.version = names.latest_version
         WHERE names.name = ?`,
      )
      .get(name) as RawArtifact | null;
    return row === null ? null : hydrate(row);
  }

  version(name: string, version: string): ArtifactRow | null {
    const row = this.db
      .query(
        `SELECT artifacts.*, names.latest_version AS latest_version
         FROM artifacts LEFT JOIN names ON names.name = artifacts.name
         WHERE artifacts.name = ? AND artifacts.version = ?`,
      )
      .get(name, version) as RawArtifact | null;
    return row === null ? null : hydrate(row);
  }

  /** Tombstone, never delete: the row and its bytes both survive until gc. */
  tombstone(name: string, version: string | null, reason: string, now: string): ArtifactRow[] {
    const targets = (version === null ? this.versions(name) : [this.version(name, version)]).filter(
      (row): row is ArtifactRow => row !== null && row.deleted === null,
    );
    if (targets.length === 0) {
      throw new CliError(
        "artifact_not_found",
        version === null
          ? `no live artifact named "${name}"`
          : `artifact "${name}" has no live version ${version}`,
        "Run: agentwiki artifacts list --json",
      );
    }
    const update = this.db.query(
      "UPDATE artifacts SET deleted = ?, deleted_reason = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const row of targets) update.run(now, reason, row.id);
      const survivor = this.versions(name).find((row) => row.deleted === null);
      if (survivor === undefined) this.db.query("DELETE FROM names WHERE name = ?").run(name);
      else this.setLatest(name, survivor.version, now);
    })();
    return targets.map((row) => this.version(name, row.version)!);
  }

  restore(name: string, version: string | null, now: string): ArtifactRow[] {
    const all = this.versions(name);
    const targets = (version === null ? all : all.filter((row) => row.version === version)).filter(
      (row) => row.deleted !== null,
    );
    if (targets.length === 0) {
      throw new CliError("artifact_not_found", `no tombstoned artifact "${name}" to restore`);
    }
    const reclaimed = targets.filter((row) => row.reclaimed);
    if (reclaimed.length === targets.length) {
      throw new CliError(
        "content_reclaimed",
        `every tombstoned version of "${name}" was already collected by gc`,
        "Publish the content again under the same name.",
      );
    }
    const update = this.db.query(
      "UPDATE artifacts SET deleted = NULL, deleted_reason = NULL WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const row of targets) {
        if (row.reclaimed) continue;
        update.run(row.id);
      }
      const newest = this.versions(name).find((row) => row.deleted === null);
      if (newest !== undefined) this.setLatest(name, newest.version, now);
    })();
    return this.versions(name).filter((row) =>
      targets.some((target) => target.version === row.version),
    );
  }

  /** Explicit, never automatic: the only path that removes bytes. */
  collect(): {
    versions: { name: string; version: string; bytes: number }[];
    orphans: string[];
    bytes: number;
  } {
    const live = new Set(
      (
        this.db.query("SELECT version FROM artifacts WHERE deleted IS NULL").all() as {
          version: string;
        }[]
      ).map((row) => row.version),
    );
    const collected: { name: string; version: string; bytes: number }[] = [];
    let bytes = 0;
    const dead = this.db
      .query(
        "SELECT name, version, size FROM artifacts WHERE deleted IS NOT NULL AND reclaimed = 0",
      )
      .all() as { name: string; version: string; size: number }[];
    for (const row of dead) {
      if (live.has(row.version)) continue;
      removeObject(this.casRoot, row.version);
      this.db
        .query("UPDATE artifacts SET reclaimed = 1 WHERE name = ? AND version = ?")
        .run(row.name, row.version);
      collected.push({ name: row.name, version: row.version, bytes: row.size });
      bytes += row.size;
    }
    const known = new Set(
      (
        this.db.query("SELECT DISTINCT version FROM artifacts WHERE reclaimed = 0").all() as {
          version: string;
        }[]
      ).map((row) => row.version),
    );
    const orphans: string[] = [];
    for (const version of listObjects(this.casRoot)) {
      if (known.has(version)) continue;
      removeObject(this.casRoot, version);
      orphans.push(version);
    }
    return { versions: collected, orphans, bytes };
  }

  counts(): { names: number; versions: number; tombstoned: number } {
    const names = this.db.query("SELECT COUNT(*) AS n FROM names").get() as { n: number };
    const versions = this.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
    const dead = this.db
      .query("SELECT COUNT(*) AS n FROM artifacts WHERE deleted IS NOT NULL")
      .get() as {
      n: number;
    };
    return { names: names.n, versions: versions.n, tombstoned: dead.n };
  }
}

function listObjects(casRoot: string): string[] {
  const versions: string[] = [];
  let shards: Dirent[];
  try {
    shards = readdirSync(casRoot, { withFileTypes: true });
  } catch {
    return versions;
  }
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(casRoot, shard.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
      versions.push(entry.name);
    }
  }
  return versions;
}

function removeObject(casRoot: string, version: string): void {
  rmSync(objectPath(casRoot, version), { recursive: true, force: true });
}

function initializeSchema(db: Database): void {
  const hasMeta = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1")
    .get();
  if (hasMeta !== null) {
    const current = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
      value: string;
    } | null;
    const version = Number(current?.value ?? 0);
    if (version === MANIFEST_SCHEMA_VERSION) return;
    if (!Number.isInteger(version)) {
      throw new CliError(
        "bad_schema_version",
        "artifact manifest schema_version is not an integer",
      );
    }
    // The manifest is authoritative — unlike the index it cannot be rebuilt
    // from the vault, so a newer version must never be written over.
    if (version > MANIFEST_SCHEMA_VERSION) {
      throw new CliError(
        "unsupported_schema_version",
        `artifact manifest schema version ${version} is newer than supported version ${MANIFEST_SCHEMA_VERSION}`,
        "Upgrade agentwiki; the manifest is authoritative and must not be downgraded.",
      );
    }
  }
  db.transaction(() => {
    db.run(SCHEMA_V1);
    // Future migrations land here as `if (version < N) db.run(MIGRATION_VN)`.
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(MANIFEST_SCHEMA_VERSION),
    );
  })();
}

function hydrate(row: RawArtifact): ArtifactRow {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed))
      tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    title: row.title,
    kind: (ARTIFACT_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as ArtifactKind)
      : "evidence",
    creator: row.creator,
    sourceRepo: row.source_repo,
    sourceCommit: row.source_commit,
    tags,
    entry: row.entry,
    isDirectory: row.is_directory === 1,
    size: row.size,
    fileCount: row.file_count,
    mediaType: row.media_type,
    createdAt: row.created_at,
    deleted: row.deleted,
    deletedReason: row.deleted_reason,
    reclaimed: row.reclaimed === 1,
    latest: row.latest_version === row.version,
  };
}

export function artifactName(raw: string): string {
  const name = slugify(raw);
  if (name === "untitled" && slugify(raw) !== raw) {
    throw new CliError("bad_artifact_name", `"${raw}" has no usable artifact name`);
  }
  return name;
}
