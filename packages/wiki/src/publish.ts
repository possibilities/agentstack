import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ArtifactKind, ArtifactRow } from "./artifacts.js";
import { ARTIFACT_KINDS, ArtifactStore, artifactName, detectSource } from "./artifacts.js";
import type { CommandResult, Context } from "./context.js";
import { formatBytes, openIndex } from "./context.js";
import { writeArtifactStub } from "./documents.js";
import { CliError, UsageError } from "./errors.js";
import type { ParsedFlags } from "./flags.js";
import { editFrontmatter } from "./frontmatter.js";
import { normalizeTags, parseTagList } from "./slug.js";
import {
  absolute,
  DEFAULT_ARTIFACT_PORT,
  DEFAULT_PORT,
  latestArtifactUrl,
  versionArtifactUrl,
} from "./urls.js";
import { artifactStubPath } from "./vault.js";

function portValue(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new UsageError(`${flag} must be 1..65535`);
  return port;
}

export function portOf(flags: ParsedFlags): number {
  return portValue(flags.values["port"], DEFAULT_PORT, "--port");
}

export function artifactPortOf(flags: ParsedFlags): number {
  return portValue(flags.values["artifact-port"], DEFAULT_ARTIFACT_PORT, "--artifact-port");
}

function kindOf(flags: ParsedFlags): ArtifactKind | undefined {
  const raw = flags.values["kind"];
  if (raw === undefined) return undefined;
  if (!(ARTIFACT_KINDS as readonly string[]).includes(raw)) {
    throw new UsageError(`--kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
  }
  return raw as ArtifactKind;
}

function describe(row: ArtifactRow): Record<string, unknown> {
  return {
    name: row.name,
    version: row.version,
    title: row.title,
    kind: row.kind,
    creator: row.creator,
    source: row.sourceRepo === null ? null : `${row.sourceRepo}@${row.sourceCommit ?? "unknown"}`,
    tags: row.tags,
    entry: row.entry,
    directory: row.isDirectory,
    files: row.fileCount,
    bytes: row.size,
    media_type: row.mediaType,
    created_at: row.createdAt,
    latest: row.latest,
    deleted: row.deleted,
    deleted_reason: row.deletedReason,
    reclaimed: row.reclaimed,
    url: latestArtifactUrl(row.name),
    version_url: versionArtifactUrl(row.name, row.version),
  };
}

export function publishCommand(context: Context, flags: ParsedFlags): CommandResult {
  if (flags.positional.length !== 1)
    throw new UsageError("publish takes exactly one file or directory");
  const rawName = flags.values["name"];
  if (rawName === undefined) throw new UsageError("publish requires --name");
  const name = artifactName(rawName);
  const source = flags.positional[0]!;
  const path = isAbsolute(source) ? source : resolvePath(context.cwd, source);
  if (!existsSync(path))
    throw new CliError("artifact_not_readable", `no such file or directory: ${source}`);

  const store = ArtifactStore.open(context.env, context.home);
  const index = openIndex(context, { create: true });
  try {
    const kind = kindOf(flags);
    const title = flags.values["title"];
    const now = context.now();
    const result = store.publish({
      name,
      path,
      // Both spellings are accepted: documents take --tags, and an agent
      // reaching for publish will reach for the one it just used.
      tags: normalizeTags([
        ...parseTagList(flags.values["tag"]),
        ...parseTagList(flags.values["tags"]),
      ]),
      creator: context.env["AGENTWIKI_CREATOR"] ?? context.env["USER"] ?? null,
      source: detectSource(context.cwd),
      now,
      ...(kind === undefined ? {} : { kind }),
      ...(title === undefined ? {} : { title }),
    });
    const stub = writeStub(context, result.row, now);
    index.reconcile();
    const data = { ...describe(result.row), status: result.status, stub };
    return {
      data,
      human: [
        `${result.status === "created" ? "published" : "unchanged"} ${name}@${result.row.version.slice(0, 12)}`,
        `${result.row.kind}, ${result.row.fileCount} file${result.row.fileCount === 1 ? "" : "s"}, ${formatBytes(result.row.size)}`,
        `latest   ${latestArtifactUrl(name)}`,
        `version  ${versionArtifactUrl(name, result.row.version)}`,
        `stub     ${stub}`,
      ].join("\n"),
    };
  } finally {
    index.close();
    store.close();
  }
}

/** The stub is what puts an artifact inside the document graph: it is
 * searchable, taggable and linkable exactly like anything else in the vault. */
function writeStub(context: Context, row: ArtifactRow, now: string): string {
  const path = artifactStubPath(context.vaultRoot, row.name);
  const frontmatter: Record<string, unknown> = {
    title: row.title ?? row.name,
    tags: ["artifact", ...row.tags],
    artifact: row.name,
    version: row.version,
    kind: row.kind,
    url: latestArtifactUrl(row.name),
    source: row.sourceRepo === null ? null : `${row.sourceRepo}@${row.sourceCommit ?? "unknown"}`,
    created: now,
    updated: now,
  };
  const body = [
    `# ${row.title ?? row.name}`,
    "",
    `${row.kind} artifact, ${row.fileCount} file${row.fileCount === 1 ? "" : "s"}, ${formatBytes(row.size)}.`,
    "",
    `- latest: \`${latestArtifactUrl(row.name)}\``,
    `- this version: \`${versionArtifactUrl(row.name, row.version)}\``,
    "",
  ].join("\n");
  writeArtifactStub(path, frontmatter, body);
  return path;
}

/** The stub represents the artifact inside the graph, so the two tombstone
 * together: a live document promising a dead artifact is the one lie the
 * vault could tell. Only the last live version takes the stub with it. */
function stampStub(
  context: Context,
  name: string,
  reason: string | null,
  now: string,
): string | null {
  const path = artifactStubPath(context.vaultRoot, name);
  if (!existsSync(path)) return null;
  const changes =
    reason === null
      ? { deleted: undefined, deleted_reason: undefined, updated: now }
      : { deleted: now, deleted_reason: reason, updated: now };
  writeFileSync(path, editFrontmatter(readFileSync(path, "utf8"), changes), { mode: 0o600 });
  return path;
}

export function artifactsCommand(context: Context, flags: ParsedFlags): CommandResult {
  const subcommand = flags.positional[0] ?? "list";
  const rest = flags.positional.slice(1);
  const store = ArtifactStore.open(context.env, context.home);
  try {
    if (subcommand === "list") {
      if (rest.length > 0) throw new UsageError("artifacts list takes no arguments");
      const names = store.names();
      const rows = names.map(describe);
      const human =
        names.length === 0
          ? "no artifacts"
          : names
              .map(
                (row) =>
                  `${row.name.padEnd(24)} ${row.kind.padEnd(9)} ${row.version.slice(0, 12)}  ${formatBytes(row.size)}`,
              )
              .join("\n");
      return { data: { artifacts: rows, count: rows.length }, human, records: rows };
    }
    const name = rest.join(" ").trim();
    if (name === "") throw new UsageError(`artifacts ${subcommand} requires a name`);
    if (subcommand === "versions") {
      const rows = store.versions(artifactName(name));
      if (rows.length === 0) throw notFound(name);
      const human = rows
        .map(
          (row) =>
            `${row.version.slice(0, 12)}  ${row.latest ? "latest" : "      "}  ${row.createdAt}  ${formatBytes(row.size)}${row.deleted === null ? "" : "  tombstoned"}`,
        )
        .join("\n");
      return {
        data: { name: rows[0]!.name, versions: rows.map(describe) },
        human,
        records: rows.map(describe),
      };
    }
    if (subcommand === "show") {
      const row = store.latest(artifactName(name)) ?? store.versions(artifactName(name))[0];
      if (row === undefined || row === null) throw notFound(name);
      const detail = describe(row);
      const human = Object.entries(detail)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(
          ([key, value]) =>
            `${key.padEnd(12)} ${Array.isArray(value) ? value.join(", ") : String(value)}`,
        )
        .join("\n");
      return { data: detail, human };
    }
    if (subcommand === "rm") {
      const reason = flags.values["reason"];
      if (reason === undefined || reason.trim() === "") {
        throw new UsageError("artifacts rm requires --reason (a tombstone records why)");
      }
      const now = context.now();
      const rows = store.tombstone(
        artifactName(name),
        flags.values["version"] ?? null,
        reason,
        now,
      );
      const target = rows[0]!.name;
      const live = store.versions(target).some((row) => row.deleted === null);
      const stub = live ? null : stampStub(context, target, reason, now);
      return {
        data: { name: target, tombstoned: rows.map(describe), reason, stub },
        human: `tombstoned ${rows.length} version${rows.length === 1 ? "" : "s"} of ${target}${stub === null ? "" : `\nstub tombstoned at ${stub}`}\nbytes stay until: agentwiki gc`,
      };
    }
    if (subcommand === "restore") {
      const now = context.now();
      const rows = store.restore(artifactName(name), flags.values["version"] ?? null, now);
      const stub = stampStub(context, rows[0]!.name, null, now);
      return {
        data: { name: rows[0]!.name, restored: rows.map(describe), stub },
        human: `restored ${rows.length} version${rows.length === 1 ? "" : "s"} of ${rows[0]!.name}`,
      };
    }
    throw new UsageError(
      `unknown artifacts subcommand "${subcommand}" (list, versions, show, rm, restore)`,
    );
  } finally {
    store.close();
  }
}

function notFound(name: string): CliError {
  return new CliError(
    "artifact_not_found",
    `no artifact named "${name}"`,
    "Run: agentwiki artifacts list",
  );
}

export async function openCommand(context: Context, flags: ParsedFlags): Promise<CommandResult> {
  if (flags.positional.length === 0) throw new UsageError("open requires an artifact name");
  const name = artifactName(flags.positional.join(" ").trim());
  const store = ArtifactStore.open(context.env, context.home);
  let row: ArtifactRow | null;
  try {
    row = store.latest(name);
  } finally {
    store.close();
  }
  if (row === null) throw notFound(name);
  const port = portOf(flags);
  const url = absolute(port, latestArtifactUrl(name));
  if (!(await serverIsUp(port))) {
    throw new CliError(
      "server_not_running",
      `nothing is serving ${url}`,
      `Start it first: agentwiki serve${port === DEFAULT_PORT ? "" : ` --port ${port}`}`,
    );
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  return { data: { name, url, version: row.version }, human: url };
}

async function serverIsUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(absolute(port, "/"), {
      signal: AbortSignal.timeout(1500),
    });
    // Any HTTP answer proves something is listening; the status does not
    // matter, only that `open` will land somewhere.
    return response.status > 0;
  } catch {
    return false;
  }
}

export function gcCommand(context: Context, flags: ParsedFlags): CommandResult {
  if (flags.positional.length > 0) throw new UsageError("gc takes no positional arguments");
  const store = ArtifactStore.open(context.env, context.home);
  try {
    const report = store.collect();
    return {
      data: {
        reclaimed: report.versions,
        orphans: report.orphans,
        bytes: report.bytes,
        human_bytes: formatBytes(report.bytes),
      },
      human:
        report.versions.length === 0 && report.orphans.length === 0
          ? "nothing to reclaim"
          : `reclaimed ${report.versions.length} tombstoned version${report.versions.length === 1 ? "" : "s"} and ${report.orphans.length} orphan object${report.orphans.length === 1 ? "" : "s"} (${formatBytes(report.bytes)})`,
    };
  } finally {
    store.close();
  }
}
