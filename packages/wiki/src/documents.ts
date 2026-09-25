import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { ArtifactStore } from "./artifacts.js";
import type { CommandResult, Context } from "./context.js";
import { openIndex } from "./context.js";
import { CliError, UsageError } from "./errors.js";
import type { ParsedFlags } from "./flags.js";
import { documentTitle, editFrontmatter, serializeDocument, splitDocument } from "./frontmatter.js";
import type { GitReport } from "./git.js";
import { gitReport } from "./git.js";
import type { GraphSnapshot } from "./graph.js";
import { buildGraph, edgesFrom, edgesTo, orphanSlugs } from "./graph.js";
import type { DocumentRow, VaultIndex } from "./index.js";
import { rankRefMatches, resolveRef } from "./resolve.js";
import { normalizeTags, parseTagList, slugify } from "./slug.js";
import { indexPath, isMarkdownPath, templatesDirectory } from "./vault.js";

const DEFAULT_LIMIT = 20;

export function phrase(flags: ParsedFlags, what: string): string {
  // Positionals are joined rather than required to be one argument: a voice
  // agent relays "the bluetooth trap", not a shell-quoted string.
  const value = flags.positional.join(" ").trim();
  if (value === "") throw new UsageError(`${what} is required`);
  return value;
}

function limitOf(flags: ParsedFlags): number {
  const raw = flags.values["limit"];
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1)
    throw new UsageError(`--limit must be a positive integer`);
  return limit;
}

function tagOf(flags: ParsedFlags): string | undefined {
  const raw = flags.values["tag"];
  return raw === undefined ? undefined : slugify(raw);
}

function candidates(index: VaultIndex, includeDeleted = false): DocumentRow[] {
  return index.documents(includeDeleted ? { includeDeleted: true } : {});
}

function findDocument(index: VaultIndex, ref: string, includeDeleted = false): DocumentRow {
  return resolveRef(ref, candidates(index, includeDeleted));
}

function snapshotOf(index: VaultIndex): GraphSnapshot {
  return buildGraph(
    index.documents(),
    index.links().map((link) => ({ sourceId: link.sourceId, target: link.target })),
  );
}

function titlesOf(index: VaultIndex): Map<string, string> {
  return new Map(index.documents().map((document) => [document.slug, document.title]));
}

function bodyFromDisk(absolute: string, markdown: boolean): string {
  const text = readFileSync(absolute, "utf8");
  return markdown ? splitDocument(text).body : text;
}

/** Every write path stamps `updated`; `created` is set once and never moved. */
function stamp(now: string, existing: Record<string, unknown>): Record<string, unknown> {
  return { created: existing["created"] ?? now, updated: now };
}

function uniqueSlug(root: string, base: string, extension: string): { slug: string; path: string } {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    const path = join(root, `${slug}${extension}`);
    if (!existsSync(path)) return { slug, path };
  }
  throw new CliError("slug_exhausted", `cannot find a free slug near "${base}"`);
}

export function newDocument(context: Context, flags: ParsedFlags): CommandResult {
  const title = phrase(flags, "a title");
  const slug = slugify(title);
  const index = openIndex(context, { create: true });
  try {
    const path = join(context.vaultRoot, `${slug}.md`);
    if (existsSync(path)) {
      throw new CliError(
        "document_exists",
        `${slug}.md already exists`,
        `Read it with: agentwiki get ${slug} — or capture alongside it with: agentwiki add`,
      );
    }
    const now = context.now();
    const tags = parseTagList(flags.values["tags"]);
    const template = loadTemplate(context.vaultRoot, flags.values["template"], title, slug, now);
    const frontmatter: Record<string, unknown> = { ...template.frontmatter, title };
    if (tags.length > 0 || Array.isArray(frontmatter["tags"])) {
      frontmatter["tags"] = normalizeTags([...tags, ...normalizeTags(frontmatter["tags"])]);
    }
    Object.assign(frontmatter, stamp(now, {}));
    writeFileSync(path, serializeDocument(frontmatter, template.body), { mode: 0o600 });
    index.reconcile();
    return {
      data: { slug, title, path, tags: normalizeTags(frontmatter["tags"]), created: now },
      human: `created ${slug}\n${path}`,
    };
  } finally {
    index.close();
  }
}

function loadTemplate(
  root: string,
  name: string | undefined,
  title: string,
  slug: string,
  now: string,
): { frontmatter: Record<string, unknown>; body: string } {
  if (name === undefined) return { frontmatter: {}, body: `# ${title}\n\n` };
  const path = join(templatesDirectory(root), `${slugify(name)}.md`);
  if (!existsSync(path)) {
    throw new CliError(
      "template_not_found",
      `no template "${name}" in ${templatesDirectory(root)}`,
      "Templates are plain markdown files; create one there and retry.",
    );
  }
  const split = splitDocument(readFileSync(path, "utf8"));
  const substitute = (text: string): string =>
    text
      .replaceAll("{{title}}", title)
      .replaceAll("{{slug}}", slug)
      .replaceAll("{{date}}", now.slice(0, 10))
      .replaceAll("{{now}}", now);
  const frontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(split.frontmatter)) {
    frontmatter[key] = typeof value === "string" ? substitute(value) : value;
  }
  return { frontmatter, body: substitute(split.body) };
}

export async function addDocument(context: Context, flags: ParsedFlags): Promise<CommandResult> {
  if (flags.positional.length > 1) throw new UsageError("add takes at most one file");
  const source = flags.positional[0];
  const inline = flags.values["content"];
  if (inline !== undefined && source !== undefined) {
    throw new UsageError("add takes a file or --content, not both");
  }
  let text: string;
  let sourceExtension = ".md";
  if (inline !== undefined) {
    // An out-of-process caller has no pipe, so the body must be reachable
    // through argv: --content is the only channel such a caller always has.
    text = inline;
  } else if (source === undefined) {
    if (context.stdinIsTerminal) {
      throw new UsageError("add needs a file argument, --content, or content on stdin");
    }
    text = await context.readStdin();
  } else {
    const path = isAbsolute(source) ? source : resolvePath(context.cwd, source);
    if (!existsSync(path)) throw new CliError("file_not_found", `no such file: ${source}`);
    text = readFileSync(path, "utf8");
    if (!isMarkdownPath(path) && extname(path) !== "")
      sourceExtension = extname(path).toLowerCase();
  }
  if (text.trim() === "")
    throw new CliError("empty_document", "refusing to capture an empty document");

  const index = openIndex(context, { create: true });
  try {
    const now = context.now();
    const markdown = sourceExtension === ".md";
    const split = markdown
      ? splitDocument(text)
      : { frontmatter: {}, hasFrontmatter: false, body: text };
    const fallback = source === undefined ? "Captured note" : basename(source, extname(source));
    const title = flags.values["title"] ?? documentTitle(split.frontmatter, split.body, fallback);
    const tags = normalizeTags([
      ...parseTagList(flags.values["tags"]),
      ...normalizeTags(split.frontmatter["tags"]),
    ]);
    // Capture must not fail on a name clash the way `new` does: the agent is
    // mid-thought, so the slug slides instead of the command erroring.
    const target = uniqueSlug(context.vaultRoot, slugify(title), sourceExtension);
    if (markdown) {
      const frontmatter: Record<string, unknown> = { ...split.frontmatter, title };
      if (tags.length > 0) frontmatter["tags"] = tags;
      Object.assign(frontmatter, stamp(now, split.frontmatter));
      writeFileSync(target.path, serializeDocument(frontmatter, split.body), { mode: 0o600 });
    } else {
      writeFileSync(target.path, text, { mode: 0o600 });
    }
    index.reconcile();
    return {
      data: {
        slug: target.slug,
        title,
        path: target.path,
        tags,
        markdown,
        bytes: Buffer.byteLength(text, "utf8"),
      },
      human: `added ${target.slug}\n${target.path}`,
    };
  } finally {
    index.close();
  }
}

export function getDocument(context: Context, flags: ParsedFlags): CommandResult {
  const ref = phrase(flags, "a ref");
  const index = openIndex(context, { create: false });
  try {
    const document = findDocument(index, ref);
    const absolute = join(context.vaultRoot, document.path);
    const metaOnly = flags.bools.has("meta-only");
    const data: Record<string, unknown> = {
      slug: document.slug,
      title: document.title,
      path: absolute,
      tags: document.tags,
      created: document.created,
      updated: document.updated,
      frontmatter: document.frontmatter,
      bytes: document.size,
    };
    // Read the file rather than the indexed copy: get is the command an agent
    // trusts to hand back exactly what is on disk right now.
    const body = metaOnly ? "" : bodyFromDisk(absolute, document.markdown);
    if (!metaOnly) data["content"] = body;
    const header = `# ${document.title}\nslug: ${document.slug}\npath: ${absolute}\ntags: ${
      document.tags.length === 0 ? "—" : document.tags.join(", ")
    }`;
    return { data, human: metaOnly ? header : `${header}\n\n${body.trimEnd()}` };
  } finally {
    index.close();
  }
}

export function documentPath(context: Context, flags: ParsedFlags): CommandResult {
  const ref = phrase(flags, "a ref");
  const index = openIndex(context, { create: false });
  try {
    const document = findDocument(index, ref);
    const absolute = join(context.vaultRoot, document.path);
    return { data: { slug: document.slug, path: absolute }, human: absolute };
  } finally {
    index.close();
  }
}

export function listDocuments(context: Context, flags: ParsedFlags): CommandResult {
  if (flags.positional.length > 0) throw new UsageError("list takes no positional arguments");
  const index = openIndex(context, { create: false });
  try {
    const tag = tagOf(flags);
    const rows = index.documents({ limit: limitOf(flags), ...(tag === undefined ? {} : { tag }) });
    const records = rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      path: join(context.vaultRoot, row.path),
      tags: row.tags,
      updated: row.updated,
      bytes: row.size,
    }));
    const human =
      records.length === 0
        ? "no documents"
        : records.map((row) => `${row.slug.padEnd(28)} ${row.title}`).join("\n");
    return { data: { documents: records, count: records.length }, human, records };
  } finally {
    index.close();
  }
}

export function searchDocuments(context: Context, flags: ParsedFlags): CommandResult {
  const query = phrase(flags, "a query");
  const index = openIndex(context, { create: false });
  try {
    const tag = tagOf(flags);
    const hits = index.search({
      query,
      limit: limitOf(flags),
      ...(tag === undefined ? {} : { tag }),
    });
    const records = hits.map((hit) => ({
      slug: hit.slug,
      title: hit.title,
      path: join(context.vaultRoot, hit.path),
      tags: hit.tags,
      snippet: hit.snippet,
      score: hit.score,
    }));
    const human =
      records.length === 0
        ? `no documents match "${query}"`
        : records.map((hit) => `${hit.slug}\n  ${hit.title}\n  ${hit.snippet}`).join("\n");
    return { data: { query, hits: records, count: records.length }, human, records };
  } finally {
    index.close();
  }
}

export function listTags(context: Context, flags: ParsedFlags): CommandResult {
  if (flags.positional.length > 0) throw new UsageError("tags takes no positional arguments");
  const index = openIndex(context, { create: false });
  try {
    const tags = index.tagCounts();
    const human =
      tags.length === 0
        ? "no tags"
        : tags.map((tag) => `${String(tag.documents).padStart(4)}  ${tag.tag}`).join("\n");
    return { data: { tags, count: tags.length }, human };
  } finally {
    index.close();
  }
}

/** The disambiguation call: never an error for a phrase that matches nothing,
 * because a voice agent asks this precisely to find out. */
export function resolveCommand(context: Context, flags: ParsedFlags): CommandResult {
  const ref = phrase(flags, "a phrase");
  const index = openIndex(context, { create: false });
  try {
    const matches = rankRefMatches(ref, candidates(index)).slice(0, limitOf(flags));
    const records = matches.map((match) => ({
      slug: match.candidate.slug,
      title: match.candidate.title,
      path: join(context.vaultRoot, match.candidate.path),
      match: match.tier,
      score: Number(match.score.toFixed(2)),
    }));
    const human =
      records.length === 0
        ? `nothing matches "${ref}"`
        : records
            .map((row) => `${row.match.padEnd(11)} ${row.slug.padEnd(28)} ${row.title}`)
            .join("\n");
    return { data: { ref, candidates: records, count: records.length }, human, records };
  } finally {
    index.close();
  }
}

export function documentLinks(context: Context, flags: ParsedFlags): CommandResult {
  const ref = phrase(flags, "a ref");
  const index = openIndex(context, { create: false });
  try {
    const document = findDocument(index, ref);
    const snapshot = snapshotOf(index);
    const titles = titlesOf(index);
    const outgoing = edgesFrom(snapshot, document.slug).map((edge) => ({
      to: edge.to,
      title: titles.get(edge.to) ?? edge.to,
      kind: edge.kind,
    }));
    const dangling = snapshot.dangling.filter((link) => link.from === document.slug);
    const human = [
      ...outgoing.map((edge) => `${edge.kind.padEnd(9)} → ${edge.to.padEnd(28)} ${edge.title}`),
      ...dangling.map((link) => `dangling  → ${link.target} (${link.reason})`),
    ];
    return {
      data: { slug: document.slug, title: document.title, outgoing, dangling },
      human: human.length === 0 ? "no outgoing links" : human.join("\n"),
    };
  } finally {
    index.close();
  }
}

export function documentBacklinks(context: Context, flags: ParsedFlags): CommandResult {
  const ref = phrase(flags, "a ref");
  const index = openIndex(context, { create: false });
  try {
    const document = findDocument(index, ref);
    const snapshot = snapshotOf(index);
    const titles = titlesOf(index);
    const incoming = edgesTo(snapshot, document.slug).map((edge) => ({
      from: edge.from,
      title: titles.get(edge.from) ?? edge.from,
      kind: edge.kind,
    }));
    const human =
      incoming.length === 0
        ? "no backlinks"
        : incoming
            .map((edge) => `${edge.kind.padEnd(9)} ← ${edge.from.padEnd(28)} ${edge.title}`)
            .join("\n");
    return { data: { slug: document.slug, title: document.title, incoming }, human };
  } finally {
    index.close();
  }
}

export function graphCommand(context: Context, flags: ParsedFlags): CommandResult {
  if (flags.positional.length > 0) throw new UsageError("graph takes no positional arguments");
  const index = openIndex(context, { create: false });
  try {
    const snapshot = snapshotOf(index);
    // Every other command hands back an absolute path an agent can open;
    // the graph export must not be the one that speaks vault-relative.
    const nodes = snapshot.nodes.map((node) => ({
      ...node,
      path: join(context.vaultRoot, node.path),
    }));
    return {
      data: { ...snapshot, nodes },
      human: `${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges, ${snapshot.dangling.length} dangling`,
    };
  } finally {
    index.close();
  }
}

function gitLine(report: GitReport): string {
  if (!report.repo) return "not a repository — the next write makes it one";
  const remote = report.remote ?? "no remote (nothing to push to)";
  const backlog =
    report.unpushed === null
      ? "no upstream"
      : report.unpushed === 0
        ? "pushed"
        : `${report.unpushed} unpushed`;
  return `${report.branch ?? "detached"}, ${remote}, ${backlog}`;
}

export function doctorCommand(context: Context, flags: ParsedFlags): CommandResult {
  if (flags.positional.length > 0) throw new UsageError("doctor takes no positional arguments");
  const index = openIndex(context, { create: false });
  const store = ArtifactStore.open(context.env, context.home);
  try {
    const counts = index.counts();
    const snapshot = snapshotOf(index);
    const duplicates = index.duplicateSlugs();
    const orphans = orphanSlugs(snapshot);
    const dangling = snapshot.dangling.filter((link) => link.reason === "unresolved");
    const ambiguous = snapshot.dangling.filter((link) => link.reason === "ambiguous");
    const stubs = brokenArtifactStubs(index, store);
    const issues = dangling.length + ambiguous.length + duplicates.length + stubs.length;
    const data = {
      vault: context.vaultRoot,
      index: {
        path: indexPath(context.vaultRoot),
        documents: counts.documents,
        tombstoned: counts.tombstoned,
        wikilinks: counts.links,
      },
      dangling,
      ambiguous_links: ambiguous,
      duplicate_slugs: duplicates,
      orphans,
      broken_artifact_stubs: stubs,
      // Reported, but never folded into `healthy`: an unpushed vault is a
      // configuration state, not a defect in the vault itself.
      git: gitReport(context.vaultRoot),
      healthy: issues === 0,
    };
    const lines = [
      `vault      ${context.vaultRoot}`,
      `documents  ${counts.documents} live, ${counts.tombstoned} tombstoned`,
      `graph      ${snapshot.edges.length} edges, ${orphans.length} orphans`,
      `dangling   ${dangling.length}${dangling.length === 0 ? "" : `: ${dangling.map((link) => `${link.from} → ${link.target}`).join(", ")}`}`,
      `ambiguous  ${ambiguous.length}${ambiguous.length === 0 ? "" : `: ${ambiguous.map((link) => `${link.from} → ${link.target}`).join(", ")}`}`,
      `duplicates ${duplicates.length}${duplicates.length === 0 ? "" : `: ${duplicates.map((row) => row.slug).join(", ")}`}`,
      `stubs      ${stubs.length === 0 ? "ok" : stubs.join(", ")}`,
      `git        ${gitLine(data.git)}`,
    ];
    return { data, human: lines.join("\n") };
  } finally {
    store.close();
    index.close();
  }
}

/** A stub whose frontmatter names an artifact the manifest no longer serves
 * is the one inconsistency the vault cannot repair on its own: the vault says
 * the artifact exists, and only the manifest knows it does not. */
function brokenArtifactStubs(index: VaultIndex, store: ArtifactStore): string[] {
  const broken: string[] = [];
  for (const document of index.documents()) {
    const name = document.frontmatter["artifact"];
    if (typeof name !== "string") continue;
    const version = document.frontmatter["version"];
    const row = typeof version === "string" ? store.version(name, version) : store.latest(name);
    if (row !== null && row.deleted === null) continue;
    broken.push(
      `${document.slug} (${name}${typeof version === "string" ? `@${version.slice(0, 12)}` : ""})`,
    );
  }
  return broken;
}

export function reindexCommand(context: Context, flags: ParsedFlags): CommandResult {
  if (flags.positional.length > 0) throw new UsageError("reindex takes no positional arguments");
  const index = openIndex(context, { create: false });
  try {
    const report = index.rebuild();
    const counts = index.counts();
    return {
      data: { ...report, documents: counts.documents, index: indexPath(context.vaultRoot) },
      human: `rebuilt ${indexPath(context.vaultRoot)}\n${report.scanned} files scanned, ${counts.documents} documents indexed`,
    };
  } finally {
    index.close();
  }
}

export function removeDocument(context: Context, flags: ParsedFlags): CommandResult {
  const ref = phrase(flags, "a ref");
  const reason = flags.values["reason"];
  if (reason === undefined || reason.trim() === "") {
    throw new UsageError("rm requires --reason (a tombstone records why)");
  }
  const index = openIndex(context, { create: false });
  try {
    const document = findDocument(index, ref);
    const absolute = join(context.vaultRoot, document.path);
    if (!document.markdown) {
      throw new CliError(
        "not_markdown",
        `${document.path} is not markdown, so it cannot carry a tombstone`,
        "Move the file out of the vault, or convert it to markdown first.",
      );
    }
    const now = context.now();
    const text = readFileSync(absolute, "utf8");
    writeFileSync(
      absolute,
      editFrontmatter(text, { deleted: now, deleted_reason: reason, updated: now }),
      {
        mode: 0o600,
      },
    );
    index.reconcile();
    return {
      data: { slug: document.slug, title: document.title, path: absolute, deleted: now, reason },
      human: `tombstoned ${document.slug} (${reason})\nthe file is untouched at ${absolute}; restore with: agentwiki restore ${document.slug}`,
    };
  } finally {
    index.close();
  }
}

export function restoreDocument(context: Context, flags: ParsedFlags): CommandResult {
  const ref = phrase(flags, "a ref");
  const index = openIndex(context, { create: false });
  try {
    const tombstoned = index
      .documents({ includeDeleted: true })
      .filter((row) => row.deleted !== null);
    if (tombstoned.length === 0) {
      throw new CliError("no_tombstones", "no tombstoned documents to restore");
    }
    const document = resolveRef(ref, tombstoned);
    const absolute = join(context.vaultRoot, document.path);
    const now = context.now();
    const text = readFileSync(absolute, "utf8");
    writeFileSync(
      absolute,
      editFrontmatter(text, { deleted: undefined, deleted_reason: undefined, updated: now }),
      { mode: 0o600 },
    );
    index.reconcile();
    return {
      data: { slug: document.slug, title: document.title, path: absolute, restored: now },
      human: `restored ${document.slug}`,
    };
  } finally {
    index.close();
  }
}

/** Shared by publish: the stub is a document like any other, so it is written
 * through the same frontmatter editor an agent would use by hand. */
export function writeArtifactStub(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): { created: boolean } {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, serializeDocument(frontmatter, body), { mode: 0o600 });
    return { created: true };
  }
  // An agent may have written notes under the stub; only the generated keys
  // move, never the prose.
  const existing = readFileSync(path, "utf8");
  writeFileSync(path, editFrontmatter(existing, frontmatter), { mode: 0o600 });
  return { created: false };
}
