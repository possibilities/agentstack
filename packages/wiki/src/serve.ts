/** Owner-managed, loopback-only HTTP views. Only disk bytes and rendered Vault
 * Markdown are served; requests never execute Artifact code on the server. */

import type { Dirent, Stats } from "node:fs";
import { createReadStream, lstatSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { ArtifactRow, ArtifactStore } from "./artifacts.js";
import { mediaTypeFor, objectPath } from "./artifacts.js";
import { buildGraph, edgesTo } from "./graph.js";
import type { DocumentRow, VaultIndex } from "./index.js";
import type { RenderedDocument } from "./render.js";
import {
  documentPage,
  errorPage,
  escapeHtml,
  indexPage,
  listingPage,
  renderMarkdown,
} from "./render.js";
import { buildLinkLookup, lookupLinkTarget } from "./resolve.js";
import { documentUrl, latestArtifactUrl, origin, versionArtifactUrl } from "./urls.js";

export interface ServeOptions {
  vaultRoot: string;
  casRoot: string;
  index: VaultIndex;
  store: ArtifactStore;
  port: number;
  artifactPort: number;
  host: string;
}

export interface RunningServer {
  port: number;
  artifactPort: number;
  url: string;
  artifactUrl: string;
  stop(): Promise<void>;
}

const NO_CACHE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Artifact bytes are arbitrary published content, so the isolation is the
 * origin itself: they bind their own loopback port, which leaves the vault's
 * documents cross-origin and unreadable while making `'self'` mean this
 * artifact's own origin — so a bundle can still load and fetch its own files,
 * and storage no longer throws the way it did under an opaque origin.
 *
 * Inside that origin the policy is deliberately permissive — inline script,
 * eval, data: and blob: — because a page, bundle or render is expected to run
 * its own JS. What it may not do is reach the network: `connect-src 'self'`
 * denies the document origin, every other loopback port, and the internet, so
 * a hostile artifact has nowhere to send what it can see.
 *
 * The residual risk is that artifacts share this one origin with each other:
 * storage and fetch are common between them. That is the trade for giving
 * them a real origin at all, and it keeps the vault — the part worth
 * protecting — on the other side of an origin boundary. */
const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  // The document origin is only known once its listener is up, and the
  // artifact origin the same — each server needs the other's address for one
  // courtesy hop, so the bindings are filled in after both are listening and
  // read at request time.
  let documentOrigin = "";
  let artifactOrigin = "";

  const artifactServer = await listen(options.artifactPort, options.host, (request) =>
    routeArtifacts(request, options, () => documentOrigin));
  let documentServer: Server;
  try {
    documentServer = await listen(options.port, options.host, (request) =>
      routeDocuments(request, options, () => artifactOrigin));
  } catch (error) {
    await close(artifactServer);
    throw error;
  }

  // Only undefined for a unix-socket server; we always bind a TCP port.
  const port = (documentServer.address() as { port: number }).port;
  const artifactPort = (artifactServer.address() as { port: number }).port;
  documentOrigin = origin(port, options.host);
  artifactOrigin = origin(artifactPort, options.host);

  return {
    port,
    artifactPort,
    url: documentOrigin,
    artifactUrl: artifactOrigin,
    stop: async () => { await Promise.all([close(documentServer), close(artifactServer)]); },
  };
}

function listen(port: number, host: string, route: (request: Request) => Promise<Response>): Promise<Server> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const response = await route(new Request(`http://${host}:${port}${incoming.url ?? "/"}`, { method: incoming.method }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
          .on("error", () => outgoing.destroy())
          .pipe(outgoing);
      } else outgoing.end();
    } catch (error) {
      console.error("wiki serve:", error);
      outgoing.writeHead(500).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server); });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function routeDocuments(
  request: Request,
  options: ServeOptions,
  artifactOrigin: () => string,
): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request);
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/") return handleIndex(request, options);
    if (pathname.startsWith("/d/")) return handleDocument(request, options, pathname.slice(3));
    // Every artifact URL ever cited is a path, written into stub documents and
    // envelopes before the origins split. This hop is what keeps all of them
    // resolving from the front door — temporary, because the artifact port is
    // configurable and a cached permanent redirect would outlive the setting.
    if (pathname.startsWith("/a/")) {
      return redirect(request, `${artifactOrigin()}${pathname}${url.search}`, 302);
    }
    return notFound(request);
  } catch (error) {
    console.error("agentwiki serve: request failed:", error);
    return respond(request, 500, htmlHeaders(NO_CACHE), errorPage(500, "internal server error"));
  }
}

async function routeArtifacts(
  request: Request,
  options: ServeOptions,
  documentOrigin: () => string,
): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request);
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.startsWith("/a/")) return handleArtifact(request, options, pathname, url.search);
    // Nothing else lives here: a human who lands on the artifact origin's root
    // wanted the vault, which is on the other one.
    if (pathname === "/") return redirect(request, `${documentOrigin()}/`, 302);
    return notFound(request);
  } catch (error) {
    console.error("agentwiki serve: request failed:", error);
    return respond(request, 500, htmlHeaders(NO_CACHE), errorPage(500, "internal server error"));
  }
}

/** Agents edit vault files directly; every page that reads the index has to
 * see those edits without a restart. A failed reconcile serves the index as
 * it last stood rather than taking the page down. */
function safeReconcile(index: VaultIndex): void {
  try {
    index.reconcile();
  } catch (error) {
    console.error("agentwiki serve: reconcile failed:", error);
  }
}

function handleIndex(request: Request, options: ServeOptions): Response {
  safeReconcile(options.index);
  const documents = options.index.documents({ limit: 200 }).map((row) => ({
    slug: row.slug,
    title: row.title,
    tags: row.tags,
    updated: row.updated,
  }));
  const artifacts = options.store.names().map((row) => ({
    name: row.name,
    kind: row.kind,
    version: row.version,
    title: row.title,
  }));
  const html = indexPage({ vaultRoot: options.vaultRoot, documents, artifacts });
  return respond(request, 200, htmlHeaders(NO_CACHE), html);
}

function handleDocument(request: Request, options: ServeOptions, rawSlug: string): Response {
  safeReconcile(options.index);
  const slug = decodeOrNull(rawSlug);
  if (slug === null) return notFound(request);
  // documents() excludes tombstones by default, so an unknown slug and a
  // removed one look the same here — both are a plain 404.
  const documents = options.index.documents();
  const row = documents.find((document) => document.slug === slug);
  if (row === undefined) return notFound(request);

  const rendered = renderDocumentBody(row, resolverFor(documents));
  const titles = new Map(documents.map((document) => [document.slug, document.title]));
  const snapshot = buildGraph(
    documents,
    options.index.links().map((link) => ({ sourceId: link.sourceId, target: link.target })),
  );
  const backlinks = edgesTo(snapshot, slug).map((edge) => ({
    slug: edge.from,
    title: titles.get(edge.from) ?? edge.from,
    kind: edge.kind,
  }));

  const html = documentPage({
    title: rendered.title,
    slug: row.slug,
    tags: row.tags,
    updated: row.updated,
    bodyHtml: rendered.html,
    backlinks,
  });
  return respond(request, 200, htmlHeaders(NO_CACHE), html);
}

function renderDocumentBody(
  row: DocumentRow,
  resolveWikilink: (target: string) => string | null,
): RenderedDocument {
  const html = row.markdown
    ? renderMarkdown(row.body, resolveWikilink)
    : `<pre>${escapeHtml(row.body)}</pre>`;
  return { title: row.title, html };
}

/** Wikilinks resolve exactly or normalized, the same rule the CLI's `links`
 * command uses — a fuzzy hit here would render a different page than the
 * one an agent gets back from `agentwiki links`. */
function resolverFor(documents: DocumentRow[]): (target: string) => string | null {
  const lookup = buildLinkLookup(
    documents.map((document) => ({ slug: document.slug, title: document.title })),
  );
  return (target) => {
    const resolved = lookupLinkTarget(lookup, target);
    if (resolved === null || "ambiguous" in resolved) return null;
    return documentUrl(resolved.slug);
  };
}

const VERSION_ROUTE = /^\/a\/([^/]+)\/v\/([^/]+)(\/.*)?$/;
const LATEST_ROUTE = /^\/a\/([^/]+)(\/.*)?$/;

function handleArtifact(
  request: Request,
  options: ServeOptions,
  pathname: string,
  search: string,
): Response {
  const versionMatch = VERSION_ROUTE.exec(pathname);
  if (versionMatch !== null) {
    const name = decodeOrNull(versionMatch[1] ?? "");
    const hash = decodeOrNull(versionMatch[2] ?? "");
    if (name === null || hash === null) return notFound(request);
    const rest = versionMatch[3];
    if (rest === undefined) return redirect(request, `${pathname}/${search}`);
    const subPath = rest === "/" ? "" : rest.slice(1);
    const row = options.store.version(name, hash);
    return serveArtifact(
      request,
      row,
      subPath,
      versionArtifactUrl(name, hash),
      options.casRoot,
      IMMUTABLE,
    );
  }
  const latestMatch = LATEST_ROUTE.exec(pathname);
  if (latestMatch !== null) {
    const name = decodeOrNull(latestMatch[1] ?? "");
    if (name === null) return notFound(request);
    const rest = latestMatch[2];
    if (rest === undefined) return redirect(request, `${pathname}/${search}`);
    const subPath = rest === "/" ? "" : rest.slice(1);
    const row = options.store.latest(name);
    return serveArtifact(request, row, subPath, latestArtifactUrl(name), options.casRoot, NO_CACHE);
  }
  return notFound(request);
}

function serveArtifact(
  request: Request,
  row: ArtifactRow | null,
  subPath: string,
  urlPrefix: string,
  casRoot: string,
  cacheControl: string,
): Response {
  // A tombstoned version stays 404 even though version URLs are otherwise
  // eternal: immutability is about bytes never changing, not about a
  // removal being invisible.
  if (row === null || row.deleted !== null || row.reclaimed) return notFound(request);
  const objectRoot = objectPath(casRoot, row.version);

  if (!row.isDirectory) {
    if (subPath !== "") return notFound(request);
    return serveFileAt(
      request,
      objectRoot,
      row.mediaType ?? "application/octet-stream",
      cacheControl,
    );
  }

  const resolved = resolveObjectPath(objectRoot, subPath);
  if (resolved === null) return notFound(request);
  const stats = resolved.stats;

  if (stats.isDirectory()) {
    if (resolved.segments.length === 0 && row.entry !== null) {
      return serveIndexFile(request, resolved.path, row.entry, cacheControl);
    }
    const base = directoryBase(urlPrefix, resolved.segments);
    return serveDirectory(request, resolved.path, base, cacheControl);
  }
  if (!stats.isFile()) return notFound(request);
  return serveFileAt(request, resolved.path, mediaTypeFor(resolved.path), cacheControl);
}

/** The manifest says this artifact has a root index.html; still lstat it —
 * the same symlink discipline as everywhere else, not an exemption because
 * the manifest already vouches for it. */
function serveIndexFile(
  request: Request,
  directory: string,
  entry: string,
  cacheControl: string,
): Response {
  const indexFile = join(directory, entry);
  const stats = statOrNull(indexFile);
  if (stats === null || stats.isSymbolicLink() || !stats.isFile()) return notFound(request);
  return serveFileAt(request, indexFile, mediaTypeFor(indexFile), cacheControl);
}

/** Normal static-site behavior: a directory with an index.html serves it,
 * anywhere in the tree, not only at the artifact root. */
function serveDirectory(
  request: Request,
  directory: string,
  base: string,
  cacheControl: string,
): Response {
  const indexFile = join(directory, "index.html");
  const stats = statOrNull(indexFile);
  if (stats?.isFile() && !stats.isSymbolicLink()) {
    return serveFileAt(request, indexFile, mediaTypeFor(indexFile), cacheControl);
  }
  const html = listingPage({
    title: `Index of ${base}`,
    base,
    entries: listDirectoryEntries(directory),
  });
  return respond(request, 200, htmlHeaders(cacheControl), html);
}

function listDirectoryEntries(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  // Symlinks are neither isFile() nor isDirectory() under withFileTypes, so
  // they drop out of the listing without a second stat.
  return entries
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}

function serveFileAt(
  request: Request,
  path: string,
  mediaType: string,
  cacheControl: string,
): Response {
  return respond(
    request,
    200,
    {
      "Content-Type": mediaType,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": ARTIFACT_CSP,
    },
    request.method === "HEAD" ? null : Readable.toWeb(createReadStream(path)) as ReadableStream,
  );
}

interface ResolvedObjectPath {
  path: string;
  /** Decoded, validated path segments — reused to build canonical listing
   * URLs without re-deriving them from the request. */
  segments: string[];
  stats: Stats;
}

/** The one place path traversal must be refused outright: decode each
 * segment, reject `.`, `..`, NULs and embedded separators before a single
 * join happens, confirm with `resolve` that the result never left the
 * object root, and — because `lstat` only refuses to follow a symlink in
 * the *last* path component, never an earlier one — lstat every segment on
 * the way down so a symlinked intermediate directory can't smuggle the walk
 * outside the store either. Exported for the traversal test — nothing else
 * outside this module calls it. */
export function resolveObjectPath(objectRoot: string, subPath: string): ResolvedObjectPath | null {
  const root = resolve(objectRoot);
  const rootStats = statOrNull(root);
  if (rootStats === null) return null;
  if (subPath === "") return { path: root, segments: [], stats: rootStats };
  const trimmed = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;
  if (trimmed === "") return { path: root, segments: [], stats: rootStats };

  const segments: string[] = [];
  let current = root;
  let stats = rootStats;
  for (const raw of trimmed.split("/")) {
    const decoded = decodeOrNull(raw);
    if (decoded === null) return null;
    if (decoded === "." || decoded === "..") return null;
    if (decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\")) return null;
    segments.push(decoded);
    const next = resolve(join(current, decoded));
    if (next !== root && !next.startsWith(root + sep)) return null;
    const nextStats = statOrNull(next);
    if (nextStats === null || nextStats.isSymbolicLink()) return null;
    current = next;
    stats = nextStats;
  }
  return { path: current, segments, stats };
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function directoryBase(prefix: string, segments: string[]): string {
  return segments.length === 0 ? prefix : `${prefix}${segments.map(encodeURIComponent).join("/")}/`;
}

function decodeOrNull(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
}

function htmlHeaders(cacheControl: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  };
}

function respond(
  request: Request,
  status: number,
  headers: Record<string, string>,
  body: ConstructorParameters<typeof Response>[0],
): Response {
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

function notFound(request: Request): Response {
  return respond(request, 404, htmlHeaders(NO_CACHE), errorPage(404, "not found"));
}

function methodNotAllowed(request: Request): Response {
  return respond(
    request,
    405,
    { ...htmlHeaders(NO_CACHE), Allow: "GET, HEAD" },
    errorPage(405, "method not allowed"),
  );
}

function redirect(request: Request, location: string, status = 301): Response {
  return respond(
    request,
    status,
    { Location: location, "X-Content-Type-Options": "nosniff" },
    null,
  );
}
