import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { operation, type PackageApi } from "@stack/api";
import { ARTIFACT_KINDS, ArtifactStore, MAX_ARTIFACT_BYTES } from "./src/artifacts.js";
import { Collections, MAX_COLLECTION_ITEM_BYTES, MAX_INLINE_BYTES } from "./src/collections.js";
import type { Context, Handler } from "./src/context.js";
import { nowIso, openIndex } from "./src/context.js";
import { buildContract } from "./src/contract.js";
import * as documents from "./src/documents.js";
import { CliError, UsageError } from "./src/errors.js";
import { commitVault, ensureGit, gitReport, pushVault, syncVault } from "./src/git.js";
import { agentTools, invocationFor } from "./src/mcp-tools.js";
import * as publish from "./src/publish.js";
import { parseTagList } from "./src/slug.js";
import { startServer, type RunningServer } from "./src/serve.js";
import { DEFAULT_ARTIFACT_PORT, DEFAULT_HOST, DEFAULT_PORT } from "./src/urls.js";
import { ensureVault } from "./src/vault.js";

type ContentContext = { command: Context; server: RunningServer; index: ReturnType<typeof openIndex>; store: ArtifactStore; collections: Collections;
  /** Set while the events transport is running; every successful content mutation calls it. */
  changed?: () => void };

export const topics = {
  content_changed: "Content documents, items, collections or artifacts changed; re-read what you show. Direct edits to vault files are noticed on the next content operation.",
} as const;

/** Operations whose success changes what a reader sees. Blob stages are private upload state and change nothing visible. */
const mutating = new Set(["collection_create", "collection_update", "collection_delete", "item_put", "item_move", "item_delete",
  "document_update", "new", "add", "rm", "restore", "artifacts_rm", "artifacts_restore", "artifact_publish", "gc"]);

/** Publish content_changed after each successful mutation, and after any operation that noticed a direct vault edit. */
function announced<Op extends { name: string; call(ctx: ContentContext, input: any, invocation?: any): Promise<any> }>(op: Op): Op {
  if (!mutating.has(op.name)) return op;
  const call = op.call;
  return { ...op, async call(ctx: ContentContext, input: unknown, invocation?: unknown) {
    const result = await call(ctx, input, invocation);
    ctx.changed?.();
    return result;
  } };
}

const collectionSchema = z.object({ slug: z.string(), title: z.string(), description: z.string(), createdAt: z.string(), updatedAt: z.string() });
const itemSchema = z.object({ id: z.string(), collection: z.string().nullable(), name: z.string(), kind: z.enum(["document", "file", "image"]),
  mediaType: z.string(), bytes: z.number(), digest: z.string(), revision: z.number(), createdAt: z.string(), updatedAt: z.string(), url: z.string() });
const collectionKey = z.strictObject({ collection: z.string().describe("Lowercase collection slug") });
const itemKey = z.strictObject({ id: z.string().describe("Stable item ID independent of collection membership") });
const expectedRevision = z.number().int().positive().describe("Revision returned by item_get; prevents overwriting another editor's changes");

function decodeBase64(encoded: string): Buffer {
  if (encoded.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("base64 must be valid and at most 256 KiB decoded; stage larger bytes in chunks");
  return Buffer.from(encoded, "base64");
}

function itemBytes(ctx: ContentContext, input: { kind: "document" | "file" | "image"; content?: string; base64?: string; blob?: string }): Buffer {
  const supplied = [input.content, input.base64, input.blob].filter((value) => value !== undefined);
  if (supplied.length !== 1) throw new Error("provide exactly one of content, base64, or blob");
  if (input.kind === "document" && input.base64 !== undefined) throw new Error("documents require UTF-8 content or a staged blob");
  if (input.kind !== "document" && input.content !== undefined) throw new Error("files and images require base64 or a staged blob");
  const bytes = input.content !== undefined ? Buffer.from(input.content, "utf8")
    : input.base64 !== undefined ? decodeBase64(input.base64) : ctx.collections.blob(input.blob!);
  if (input.kind === "document") new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return bytes;
}

const putInput = z.strictObject({ collection: z.string().nullable().optional().describe("Optional group; null means ungrouped"),
  name: z.string().describe("Unique within a collection; ungrouped items use IDs"), kind: z.enum(["document", "file", "image"]),
  mediaType: z.string().describe("MIME type, e.g. text/markdown or image/png"), content: z.string().optional().describe("UTF-8 document body"),
  base64: z.string().optional().describe("Base64 file or image bytes, up to 256 KiB"), blob: z.string().optional().describe("SHA-256 digest from blob_stage_finish; supports up to 50 MiB") });

const stageSchema = z.object({ id: z.string(), bytes: z.number(), received: z.number(), digest: z.string(), blob: z.string().nullable() });
const stageKey = z.strictObject({ id: z.string().describe("Stable stage ID from blob_stage_start") });
const stageOperations = [
  operation({ name: "blob_stage_start", description: "Begin a durable, resumable upload by declared byte count and SHA-256. An optional clientKey deduplicates uncertain starts.",
    input: z.strictObject({ bytes: z.number().int().min(0).max(MAX_COLLECTION_ITEM_BYTES), digest: z.string(), clientKey: z.string().optional() }),
    output: stageSchema, annotations: { title: "Start content upload" },
    async call(ctx: ContentContext, input) { return ctx.collections.startStage(input.bytes, input.digest, input.clientKey); } }),
  operation({ name: "blob_stage_status", description: "Read upload progress after a lost response; never guess the next offset.",
    input: stageKey, output: stageSchema, annotations: { title: "Read upload progress", readOnlyHint: true },
    async call(ctx: ContentContext, input) { return ctx.collections.stage(input.id); } }),
  operation({ name: "blob_stage_chunk", description: "Append up to 256 KiB at the exact acknowledged byte offset. Identical repeated chunks are harmless.",
    input: stageKey.extend({ offset: z.number().int().min(0), base64: z.string() }), output: stageSchema,
    annotations: { title: "Upload content chunk" },
    async call(ctx: ContentContext, input) { return ctx.collections.appendStage(input.id, input.offset, decodeBase64(input.base64)); } }),
  operation({ name: "blob_stage_finish", description: "Verify the complete upload and return its portable content digest for item_put or artifact_publish. Repeating finish is harmless.",
    input: stageKey, output: stageSchema, annotations: { title: "Finish content upload" },
    async call(ctx: ContentContext, input) { return ctx.collections.finishStage(input.id); } }),
];

const artifactSchema = z.looseObject({ name: z.string(), version: z.string(), kind: z.string(), url: z.string(), version_url: z.string(), status: z.enum(["created", "unchanged"]) });
const artifactPublish = operation({
  name: "artifact_publish", description: "Publish a static file or whole site from portable staged content digests, never a server-local path. File paths are relative names inside the bundle; citations use immutable version_url paths.",
  input: z.strictObject({ name: z.string(), kind: z.enum(ARTIFACT_KINDS).optional(), title: z.string().optional(), tags: z.array(z.string()).default([]),
    files: z.array(z.strictObject({ name: z.string(), blob: z.string() })).min(1).max(1000) }),
  output: artifactSchema, annotations: { title: "Publish static content" },
  async call(ctx: ContentContext, input) {
    const directory = join(ctx.collections.root, "publish", randomUUID());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      let total = 0;
      const names = new Set<string>();
      for (const file of input.files) {
        const segments = file.name.split("/");
        if (file.name.length > 512 || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || segment === "node_modules" || segment.includes("\\") || /[\u0000-\u001f]/.test(segment)))
          throw new Error(`invalid bundle file name: ${file.name}`);
        if (names.has(file.name)) throw new Error(`duplicate bundle file name: ${file.name}`);
        names.add(file.name);
        const bytes = ctx.collections.blob(file.blob);
        total += bytes.length;
        if (total > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds 50 MiB limit");
        const target = join(directory, ...segments);
        mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
      }
      const single = input.files.length === 1 && input.kind !== "bundle";
      const source = single ? join(directory, ...input.files[0]!.name.split("/")) : directory;
      const result = publish.publishCommand({ ...ctx.command, cwd: directory }, { positional: [source], bools: new Set(), values: {
        name: input.name, ...(input.kind ? { kind: input.kind } : {}), ...(input.title ? { title: input.title } : {}),
        tags: parseTagList(input.tags.join(",")).join(","),
      } });
      syncVault(ctx.command.vaultRoot);
      const { stub: _stub, ...data } = result.data as Record<string, unknown>;
      return artifactSchema.parse(data);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
});

const collectionOperations = [
  operation({ name: "collection_create", description: "Create a named collection to organize documents, files and images.",
    input: z.strictObject({ slug: z.string(), title: z.string(), description: z.string().default("") }), output: collectionSchema,
    annotations: { title: "Create collection" }, async call(ctx: ContentContext, input) { return ctx.collections.create(input.slug, input.title, input.description); } }),
  operation({ name: "collection_list", description: "Page through content collections; use nextOffset for the next page.",
    input: z.strictObject({ limit: z.number().int().min(1).max(200).default(100), offset: z.number().int().min(0).default(0) }),
    output: z.object({ collections: z.array(collectionSchema), total: z.number(), nextOffset: z.number().nullable() }),
    annotations: { title: "List collections", readOnlyHint: true },
    async call(ctx: ContentContext, input) {
      const collections = ctx.collections.listCollections(input.limit, input.offset);
      const total = ctx.collections.countCollections();
      return { collections, total, nextOffset: input.offset + collections.length < total ? input.offset + collections.length : null };
    } }),
  operation({ name: "collection_get", description: "Read a collection's metadata.", input: collectionKey,
    output: collectionSchema, annotations: { title: "Get collection", readOnlyHint: true },
    async call(ctx: ContentContext, input) { return ctx.collections.collection(input.collection); } }),
  operation({ name: "collection_update", description: "Change a collection's title and description without moving its items.",
    input: collectionKey.extend({ title: z.string(), description: z.string() }), output: collectionSchema,
    annotations: { title: "Update collection" }, async call(ctx: ContentContext, input) { return ctx.collections.update(input.collection, input.title, input.description); } }),
  operation({ name: "collection_delete", description: "Remove a collection without deleting its items; items become ungrouped and retain their IDs and URLs.", input: collectionKey,
    output: z.object({ deleted: z.boolean() }), annotations: { title: "Delete collection", destructiveHint: true },
    async call(ctx: ContentContext, input) { ctx.collections.remove(input.collection); return { deleted: true }; } }),
  operation({ name: "item_put", description: "Create or revision-fenced update of a document, file or image, optionally grouped in a collection. Supply id and expectedRevision together to update; existing names are never silently overwritten. Use item_move to regroup without changing bytes or ID.",
    input: putInput.extend({ id: z.string().optional(), expectedRevision: expectedRevision.optional() }), output: itemSchema,
    annotations: { title: "Store collection item" }, async call(ctx: ContentContext, input) {
      if ((input.id === undefined) !== (input.expectedRevision === undefined)) throw new Error("id and expectedRevision must be supplied together");
      return ctx.collections.put({ ...input, bytes: itemBytes(ctx, input) });
    } }),
  operation({ name: "item_list", description: "Page through all item metadata; filter by collection slug, or null for ungrouped items. Omit collection to include both. Use nextOffset for the next page.",
    input: z.strictObject({ collection: z.string().nullable().optional(), limit: z.number().int().min(1).max(200).default(100), offset: z.number().int().min(0).default(0) }),
    output: z.object({ items: z.array(itemSchema), total: z.number(), nextOffset: z.number().nullable() }),
    annotations: { title: "List collection items", readOnlyHint: true },
    async call(ctx: ContentContext, input) {
      const items = ctx.collections.listItems(input.collection, input.limit, input.offset);
      const total = ctx.collections.countItems(input.collection);
      return { items, total, nextOffset: input.offset + items.length < total ? input.offset + items.length : null };
    } }),
  operation({ name: "item_get", description: "Read an item by stable ID, independent of collection, and optionally its body. Binary content up to 256 KiB is returned as base64; larger items use the static URL path. MCP also presents included content as native text, image or resource blocks.",
    input: itemKey.extend({ includeData: z.boolean().default(false) }), output: itemSchema.extend({ content: z.string().nullable(), base64: z.string().nullable() }),
    annotations: { title: "Read collection item", readOnlyHint: true }, async call(ctx: ContentContext, input) {
      const item = ctx.collections.item(input.id);
      const bytes = input.includeData && item.bytes <= MAX_INLINE_BYTES ? ctx.collections.bytes(item) : null;
      return { ...item, content: bytes && item.kind === "document" ? bytes.toString("utf8") : null,
        base64: bytes && item.kind !== "document" ? bytes.toString("base64") : null };
    },
    mcpContent(ctx, _input, item) {
      const { content, base64, ...metadata } = item;
      const uri = new URL(item.url, ctx.server.artifactUrl).href;
      const summary = { type: "text" as const, text: JSON.stringify(metadata) };
      if (item.kind === "document" && content !== null)
        return [summary, { type: "resource" as const, resource: { uri, mimeType: item.mediaType, text: content } }];
      if (item.kind === "image" && base64 !== null)
        return [summary, { type: "image" as const, data: base64, mimeType: item.mediaType }];
      if (item.kind === "file" && base64 !== null)
        return [summary, { type: "resource" as const, resource: { uri, mimeType: item.mediaType, blob: base64 } }];
      return [summary, { type: "resource_link" as const, uri, name: item.name, mimeType: item.mediaType, size: item.bytes }];
    } }),
  operation({ name: "item_move", description: "Put an item in a collection or set collection to null to ungroup it. The stable ID and URL do not change; expectedRevision fences concurrent edits.",
    input: itemKey.extend({ collection: z.string().nullable(), expectedRevision }), output: itemSchema,
    annotations: { title: "Move item between collections" },
    async call(ctx: ContentContext, input) { return ctx.collections.move(input.id, input.collection, input.expectedRevision); } }),
  operation({ name: "item_delete", description: "Delete an item by stable ID only at the revision read by the caller. Previously shared URL stops resolving; no collection is deleted.",
    input: itemKey.extend({ expectedRevision }), output: z.object({ deleted: z.boolean() }),
    annotations: { title: "Delete collection item", destructiveHint: true },
    async call(ctx: ContentContext, input) { ctx.collections.removeItem(input.id, input.expectedRevision); return { deleted: true }; } }),
];

const handlers: Record<string, Handler> = {
  new: documents.newDocument, add: documents.addDocument, get: documents.getDocument,
  path: documents.documentPath, list: documents.listDocuments, search: documents.searchDocuments,
  tags: documents.listTags, resolve: documents.resolveCommand, links: documents.documentLinks,
  backlinks: documents.documentBacklinks, graph: documents.graphCommand, doctor: documents.doctorCommand,
  reindex: documents.reindexCommand, rm: documents.removeDocument, restore: documents.restoreDocument,
  publish: publish.publishCommand, artifacts: publish.artifactsCommand, gc: publish.gcCommand,
  commit: (context, flags) => {
    if (flags.positional.length) throw new UsageError("commit takes no positional arguments");
    ensureGit(context.vaultRoot);
    const committed = commitVault(context.vaultRoot, flags.values["message"]);
    if (committed) pushVault(context.vaultRoot);
    return { data: { committed, ...gitReport(context.vaultRoot) }, human: "" };
  },
};

const row = z.looseObject({ slug: z.string(), title: z.string() });
const artifact = z.looseObject({ name: z.string(), version: z.string(), kind: z.string(), url: z.string(), version_url: z.string() });
const outputSchemas: Record<string, z.ZodType> = {
  new: row,
  add: row.extend({ markdown: z.boolean(), bytes: z.number() }),
  get: row.extend({ digest: z.string(), content: z.string().optional(), frontmatter: z.record(z.string(), z.unknown()) }),
  list: z.object({ documents: z.array(row.extend({ tags: z.array(z.string()) })), count: z.number() }),
  search: z.object({ query: z.string(), hits: z.array(row.extend({ snippet: z.string(), score: z.number() })), count: z.number() }),
  tags: z.object({ tags: z.array(z.object({ tag: z.string(), documents: z.number() })), count: z.number() }),
  resolve: z.object({ ref: z.string(), candidates: z.array(row.extend({ match: z.string(), score: z.number() })), count: z.number() }),
  links: row.extend({ outgoing: z.array(z.object({ to: z.string(), title: z.string(), kind: z.string() })), dangling: z.array(z.unknown()) }),
  backlinks: row.extend({ incoming: z.array(z.object({ from: z.string(), title: z.string(), kind: z.string() })) }),
  graph: z.looseObject({ nodes: z.array(z.unknown()), edges: z.array(z.unknown()), dangling: z.array(z.unknown()) }),
  rm: row.extend({ deleted: z.string(), reason: z.string() }),
  restore: row.extend({ restored: z.string() }),
  artifacts_list: z.object({ artifacts: z.array(artifact), count: z.number() }),
  artifacts_versions: z.object({ name: z.string(), versions: z.array(artifact) }),
  artifacts_show: artifact,
  artifacts_rm: z.object({ name: z.string(), tombstoned: z.array(artifact), reason: z.string() }),
  artifacts_restore: z.object({ name: z.string(), restored: z.array(artifact) }),
  gc: z.looseObject({ reclaimed: z.array(z.unknown()), orphans: z.array(z.string()), bytes: z.number() }),
  commit: z.looseObject({ committed: z.boolean(), repo: z.boolean(), clean: z.boolean() }),
};

const contract = buildContract({ vaultRoot: "<Stack state>/wiki/vault", artifactHome: "<Stack state>/wiki/artifacts" });
const localOnlyCommands = new Set(["path", "publish", "doctor", "reindex", "commit"]);
function portableData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableData);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["path", "paths", "stub", "vault"].includes(key))
    .map(([key, entry]) => [key, key === "source" && typeof entry === "string" && (/^(\/|file:)/.test(entry) || /^[a-zA-Z]:\\/.test(entry)) ? null : portableData(entry)]));
  return value;
}
const commandOperations = agentTools(contract)
  .filter((tool) => tool.name !== "guide" && !localOnlyCommands.has(tool.name))
  .map((tool) => {
    const output = outputSchemas[tool.name];
    if (!output || !handlers[tool.path[0]!]) throw new Error(`unmapped content operation: ${tool.name}`);
    return operation({
      name: tool.name, description: `${tool.leaf.summary}. ${tool.leaf.guidance ?? ""}`.slice(0, 400).trim(),
      input: tool.name === "add" ? z.strictObject({ content: z.string(), title: z.string().optional(), tags: z.string().optional() }) : tool.input, output,
      annotations: { title: tool.title, ...tool.annotations },
      async call(ctx: ContentContext, input: Record<string, unknown>) {
        const invocation = invocationFor(tool, input);
        try {
          const result = await handlers[invocation.name]!(ctx.command, invocation.flags);
          // As with the original vault, the next API call records edits made directly
          // to vault files. The fresh Stack vault has no remote by default. A read
          // that commits a direct edit announces it; mutations announce themselves.
          if (syncVault(ctx.command.vaultRoot) && !mutating.has(tool.name)) ctx.changed?.();
          const data = portableData(result.data) as Record<string, unknown>;
          if (tool.name === "get") data.digest = createHash("sha256").update(readFileSync((result.data as { path: string }).path)).digest("hex");
          return data;
        } catch (error) {
          if (error instanceof CliError) {
            throw new Error([error.code, error.message, error.recovery].filter(Boolean).join("\n"));
          }
          throw error;
        }
      },
    });
  });

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < 0 || value > 65535 || env[name] === "") {
    throw new Error(`${name} must be a port from 0 to 65535`);
  }
  return value;
}

export function contentNetworkConfig(env: NodeJS.ProcessEnv): { host: string; documentOrigin?: string; artifactOrigin?: string } {
  const host = env.STACK_CONTENT_HOST ?? DEFAULT_HOST;
  if (host !== "127.0.0.1") throw new Error("Content backend must bind 127.0.0.1; configure remote clients through Access");
  const parseOrigin = (value: string | undefined, name: string): string | undefined => {
    if (value === undefined) return undefined;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP(S) origin`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin)
      throw new Error(`${name} must be an HTTP(S) origin with no path, credentials or query`);
    return url.origin;
  };
  const documentOrigin = parseOrigin(env.STACK_CONTENT_DOCUMENT_ORIGIN, "STACK_CONTENT_DOCUMENT_ORIGIN");
  const artifactOrigin = parseOrigin(env.STACK_CONTENT_ARTIFACT_ORIGIN, "STACK_CONTENT_ARTIFACT_ORIGIN");
  if ((documentOrigin === undefined) !== (artifactOrigin === undefined)) throw new Error("content document and artifact origins must be configured together");
  if (documentOrigin && documentOrigin === artifactOrigin) throw new Error("content document and artifact origins must differ");
  if (![DEFAULT_HOST, "localhost"].includes(host) && !documentOrigin)
    throw new Error("non-loopback content hosts require explicit document and artifact origins");
  return { host, ...(documentOrigin ? { documentOrigin, artifactOrigin } : {}) };
}

type AnyContentOperation = PackageApi<ContentContext>["operations"][number];

const documentRoutes = [
  { method: "GET/HEAD", path: "/", format: "text/html; charset=utf-8", description: "List rendered vault documents." },
  { method: "GET/HEAD", path: "/d/*", format: "text/html; charset=utf-8", description: "Render a vault document by slug." },
  { method: "GET/HEAD", path: "/a/*", format: "302 redirect", description: "Redirect a cited artifact path to the separate artifact origin." },
  { method: "GET/HEAD", path: "/c/*", format: "302 redirect", description: "Redirect a collection item path to the separate artifact origin." },
] as const;
const artifactRoutes = [
  { method: "GET/HEAD", path: "/a/*", format: "artifact media type", description: "Serve published artifact bytes or a static site at its versioned or latest path." },
  { method: "GET/HEAD", path: "/c/*", format: "item media type", description: "Serve a content item by stable ID; legacy collection paths redirect." },
  { method: "GET/HEAD", path: "/", format: "302 redirect", description: "Redirect to the document origin." },
] as const;

export const api: PackageApi<ContentContext, keyof typeof topics> = {
  http: [
    { name: "documents", kind: "static", authentication: "none", description: "Same-user loopback backend only. Remote documents require the separate authenticated Access ingress.", routes: documentRoutes },
    { name: "artifacts", kind: "static", authentication: "none", description: "Same-user loopback artifact backend only. Access authenticates remote requests on a separate isolated origin.", routes: artifactRoutes },
  ],
  operations: ([
    operation({
      name: "content_status", description: "Read portable route templates for documents, sites and items. Item IDs and paths do not depend on a host, port, collection or filesystem location.",
      input: z.strictObject({}),
      output: z.object({ documentPath: z.string(), artifactPath: z.string(), itemPath: z.string() }),
      annotations: { title: "Read content status", readOnlyHint: true },
      async call() { return { documentPath: "/d/{slug}", artifactPath: "/a/{name}/v/{version}/", itemPath: "/c/{id}" }; },
    }),
    ...stageOperations,
    ...collectionOperations,
    artifactPublish,
    operation({ name: "document_update", description: "Edit a wiki document by slug or unambiguous reference. expectedDigest from get fences direct and API edits; no server-local path is needed.",
      input: z.strictObject({ ref: z.string(), expectedDigest: z.string(), content: z.string() }),
      output: z.object({ slug: z.string(), title: z.string(), digest: z.string(), updated: z.string() }),
      annotations: { title: "Edit wiki document" },
      async call(ctx, input) { const result = documents.updateDocument(ctx.command, input.ref, input.expectedDigest, input.content); syncVault(ctx.command.vaultRoot); return result; } }),
    operation({ name: "item_read", description: "Read a bounded byte range of any item by stable ID. This works through the Package API even if no static URL is reachable.",
      input: itemKey.extend({ offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(MAX_INLINE_BYTES).default(MAX_INLINE_BYTES), expectedRevision: expectedRevision.optional() }),
      output: z.object({ id: z.string(), digest: z.string(), revision: z.number(), base64: z.string(), total: z.number(), nextOffset: z.number().nullable() }),
      annotations: { title: "Read item bytes", readOnlyHint: true },
      async call(ctx, input) {
        const item = ctx.collections.item(input.id);
        if (input.expectedRevision !== undefined && input.expectedRevision !== item.revision) throw new Error(`revision conflict: expected ${item.revision}`);
        const bytes = ctx.collections.readBytes(item, input.offset, input.length);
        return { id: item.id, digest: item.digest, revision: item.revision, base64: bytes.toString("base64"), total: item.bytes,
          nextOffset: input.offset + bytes.length < item.bytes ? input.offset + bytes.length : null };
      } }),
    ...commandOperations,
  ] as AnyContentOperation[]).map(announced),
  events: {
    topics,
    start(ctx, publish) { ctx.changed = () => publish("content_changed"); return () => { ctx.changed = undefined; }; },
  },
  async createContext(env) {
    const home = homedir();
    const state = env.STACK_STATE_DIR ?? join(home, ".local", "state", "stack");
    const vaultRoot = join(state, "wiki", "vault");
    ensureVault(vaultRoot);
    const command: Context = { env, home, cwd: process.cwd(), vaultRoot, now: nowIso,
      readStdin: async () => { throw new UsageError("use content or file; the Package API has no stdin"); }, stdinIsTerminal: true };
    const index = openIndex(command, { create: false });
    let store: ArtifactStore | undefined;
    let collections: Collections | undefined;
    try {
      store = ArtifactStore.open(env, home);
      collections = new Collections(join(state, "wiki", "collections"));
      const documentPort = port(env, env.STACK_CONTENT_PORT === undefined ? "STACK_WIKI_PORT" : "STACK_CONTENT_PORT", DEFAULT_PORT);
      const artifactPort = port(env, env.STACK_CONTENT_ARTIFACT_PORT === undefined ? "STACK_WIKI_ARTIFACT_PORT" : "STACK_CONTENT_ARTIFACT_PORT", DEFAULT_ARTIFACT_PORT);
      if (documentPort !== 0 && documentPort === artifactPort) throw new Error("content document and artifact ports must differ");
      const server = await startServer({ vaultRoot, casRoot: store.casRoot, index, store, collections,
        port: documentPort, artifactPort, ...contentNetworkConfig(env), routes: {
          documents: documentRoutes, artifacts: artifactRoutes,
        } });
      return { command, server, index, store, collections };
    } catch (error) { collections?.close(); store?.close(); index.close(); throw error; }
  },
  async closeContext(ctx) {
    try { await ctx.server.stop(); }
    finally { ctx.collections.close(); ctx.store.close(); ctx.index.close(); }
  },
};
