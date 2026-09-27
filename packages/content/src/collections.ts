/** Mutable, revision-fenced collection entries. SQLite owns metadata; bytes are
 * immutable and content-addressed so a failed update cannot corrupt a reader. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./sqlite.js";

export const MAX_COLLECTION_ITEM_BYTES = 50 * 1024 * 1024;
export const MAX_INLINE_BYTES = 256 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Collection = { slug: string; title: string; description: string; createdAt: string; updatedAt: string };
export type Item = { id: string; collection: string | null; name: string; kind: "document" | "file" | "image";
  mediaType: string; bytes: number; digest: string; revision: number; createdAt: string; updatedAt: string; url: string };
type ItemRow = Omit<Item, "url">;
export type Stage = { id: string; bytes: number; received: number; digest: string; blob: string | null };

function validSlug(slug: string): void {
  if (!SLUG.test(slug) || slug.length > 80) throw new Error("collection slug must be 1–80 lowercase letters, digits or hyphen-separated words");
}
function validName(name: string): void {
  if (!name.trim() || name.length > 255 || /[\u0000-\u001f/\\]/.test(name) || name === "." || name === "..")
    throw new Error("item name must be 1–255 characters, without slashes or control characters");
}
function validCollectionDetails(title: string, description: string): void {
  if (!title.trim() || title.length > 255) throw new Error("collection title must be 1–255 characters");
  if (description.length > 4096) throw new Error("collection description must be at most 4096 characters");
}

export class Collections {
  private readonly db: Database;
  private readonly objects: string;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.objects = join(root, "objects");
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    this.db = new Database(join(root, "collections.sqlite3"), { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`CREATE TABLE IF NOT EXISTS collections (
      slug TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, collection TEXT REFERENCES collections(slug),
      name TEXT NOT NULL, kind TEXT NOT NULL, mediaType TEXT NOT NULL,
      bytes INTEGER NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(collection, name)
    );
    CREATE INDEX IF NOT EXISTS items_collection ON items(collection, name);`);
    // The first Content build required a collection. Rebuild only that table,
    // retaining every ID and byte reference, when opening its existing store.
    const column = (this.db.query("PRAGMA table_info(items)").all() as { name: string; notnull: number }[])
      .find((entry) => entry.name === "collection");
    if (column?.notnull === 1) this.db.transaction(() => {
      this.db.run(`CREATE TABLE items_v2 (
        id TEXT PRIMARY KEY, collection TEXT REFERENCES collections(slug),
        name TEXT NOT NULL, kind TEXT NOT NULL, mediaType TEXT NOT NULL,
        bytes INTEGER NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      INSERT INTO items_v2 SELECT * FROM items;
      DROP TABLE items;
      ALTER TABLE items_v2 RENAME TO items;
      CREATE INDEX items_collection ON items(collection, name);`);
    })();
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS items_group_name ON items(collection, name) WHERE collection IS NOT NULL");
    mkdirSync(join(root, "staging"), { recursive: true, mode: 0o700 });
    this.db.run(`CREATE TABLE IF NOT EXISTS stages (
      id TEXT PRIMARY KEY, clientKey TEXT UNIQUE, bytes INTEGER NOT NULL,
      received INTEGER NOT NULL, digest TEXT NOT NULL, blob TEXT,
      createdAt TEXT NOT NULL
    )`);
  }

  close(): void { this.db.close(); }

  listCollections(limit = 100, offset = 0): Collection[] {
    return this.db.query("SELECT * FROM collections ORDER BY slug LIMIT ? OFFSET ?").all(limit, offset) as Collection[];
  }
  countCollections(): number {
    return (this.db.query("SELECT COUNT(*) AS count FROM collections").get() as { count: number }).count;
  }
  collection(slug: string): Collection {
    validSlug(slug);
    const row = this.db.query("SELECT * FROM collections WHERE slug = ?").get(slug) as Collection | null;
    if (!row) throw new Error(`collection not found: ${slug}`);
    return row;
  }
  create(slug: string, title: string, description: string): Collection {
    validSlug(slug);
    validCollectionDetails(title, description);
    const now = new Date().toISOString();
    try {
      this.db.query("INSERT INTO collections VALUES (?, ?, ?, ?, ?)").run(slug, title, description, now, now);
    } catch (error) {
      if (this.db.query("SELECT 1 FROM collections WHERE slug = ?").get(slug)) throw new Error(`collection already exists: ${slug}`);
      throw error;
    }
    return this.collection(slug);
  }
  update(slug: string, title: string, description: string): Collection {
    this.collection(slug);
    validCollectionDetails(title, description);
    this.db.query("UPDATE collections SET title = ?, description = ?, updatedAt = ? WHERE slug = ?")
      .run(title, description, new Date().toISOString(), slug);
    return this.collection(slug);
  }
  remove(slug: string): void {
    this.collection(slug);
    this.db.transaction(() => {
      this.db.query("UPDATE items SET collection = NULL, revision = revision + 1, updatedAt = ? WHERE collection = ?")
        .run(new Date().toISOString(), slug);
      this.db.query("DELETE FROM collections WHERE slug = ?").run(slug);
    })();
  }

  countItems(collection?: string | null): number {
    const { where, args } = this.scope(collection);
    return (this.db.query(`SELECT COUNT(*) AS count FROM items ${where}`).get(...args) as { count: number }).count;
  }
  listItems(collection?: string | null, limit = 100, offset = 0): Item[] {
    const { where, args } = this.scope(collection);
    return (this.db.query(`SELECT * FROM items ${where} ORDER BY name, id LIMIT ? OFFSET ?`).all(...args, limit, offset) as ItemRow[]).map(withUrl);
  }
  item(id: string): Item {
    const row = this.db.query("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | null;
    if (!row) throw new Error(`item not found: ${id}`);
    return withUrl(row);
  }
  bytes(item: Item): Buffer { return readFileSync(this.objectPath(item.digest)); }
  stream(item: Item): ReturnType<typeof createReadStream> { return createReadStream(this.objectPath(item.digest)); }
  readBytes(item: Item, offset: number, length: number): Buffer {
    if (offset >= item.bytes) return Buffer.alloc(0);
    const buffer = Buffer.alloc(Math.min(length, item.bytes - offset));
    const fd = openSync(this.objectPath(item.digest), "r");
    try { return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, offset)); }
    finally { closeSync(fd); }
  }
  blob(digest: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid content digest");
    return readFileSync(this.objectPath(digest));
  }

  startStage(bytes: number, digest: string, clientKey?: string): Stage {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_COLLECTION_ITEM_BYTES) throw new Error("staged content exceeds 50 MiB limit");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("digest must be a SHA-256 hex string");
    if (clientKey !== undefined && (clientKey.length < 1 || clientKey.length > 128)) throw new Error("clientKey must be 1–128 characters");
    if (clientKey !== undefined) {
      const previous = this.db.query("SELECT * FROM stages WHERE clientKey = ?").get(clientKey) as Stage & { bytes: number; digest: string } | null;
      if (previous) {
        if (previous.bytes !== bytes || previous.digest !== digest) throw new Error("clientKey already belongs to different content");
        return this.stage(previous.id);
      }
    }
    const id = randomUUID();
    writeFileSync(this.stagePath(id), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    try {
      this.db.query("INSERT INTO stages VALUES (?, ?, ?, 0, ?, NULL, ?)")
        .run(id, clientKey ?? null, bytes, digest, new Date().toISOString());
    } catch (error) { rmSync(this.stagePath(id)); throw error; }
    return this.stage(id);
  }
  stage(id: string): Stage {
    const row = this.db.query("SELECT id, bytes, received, digest, blob FROM stages WHERE id = ?").get(id) as Stage | null;
    if (!row) throw new Error(`stage not found: ${id}`);
    return row;
  }
  appendStage(id: string, offset: number, chunk: Buffer): Stage {
    const stage = this.stage(id);
    if (stage.blob) throw new Error("stage already finished");
    if (chunk.length > MAX_INLINE_BYTES || chunk.length === 0) throw new Error("chunk must be 1–256 KiB");
    if (offset < stage.received && offset + chunk.length <= stage.received) {
      const previous = Buffer.alloc(chunk.length);
      const fd = openSync(this.stagePath(id), "r");
      try { readSync(fd, previous, 0, previous.length, offset); }
      finally { closeSync(fd); }
      if (previous.equals(chunk)) return stage;
      throw new Error("chunk differs from bytes already accepted");
    }
    if (offset !== stage.received || offset + chunk.length > stage.bytes) throw new Error(`expected chunk offset ${stage.received}`);
    const fd = openSync(this.stagePath(id), "r+");
    try { writeSync(fd, chunk, 0, chunk.length, offset); }
    finally { closeSync(fd); }
    this.db.query("UPDATE stages SET received = ? WHERE id = ? AND received = ?")
      .run(offset + chunk.length, id, offset);
    return this.stage(id);
  }
  finishStage(id: string): Stage {
    const stage = this.stage(id);
    if (stage.blob) return stage;
    if (stage.received !== stage.bytes) throw new Error(`stage incomplete: ${stage.received}/${stage.bytes}`);
    const bytes = readFileSync(this.stagePath(id));
    if (bytes.length !== stage.bytes || createHash("sha256").update(bytes).digest("hex") !== stage.digest)
      throw new Error("staged content digest mismatch");
    this.storeBlob(bytes, stage.digest);
    this.db.query("UPDATE stages SET blob = ? WHERE id = ?").run(stage.digest, id);
    rmSync(this.stagePath(id));
    return this.stage(id);
  }

  put(input: { collection?: string | null; name: string; kind: Item["kind"]; mediaType: string;
    bytes: Buffer; id?: string; expectedRevision?: number }): Item {
    if (input.collection) this.collection(input.collection);
    validName(input.name);
    if (input.bytes.length > MAX_COLLECTION_ITEM_BYTES) throw new Error("item exceeds 50 MiB limit");
    if (!/^[\x21-\x7e]+\/[\x21-\x7e]+$/.test(input.mediaType) || /[;,\\]/.test(input.mediaType))
      throw new Error("mediaType must be a MIME type without parameters");
    if (input.kind === "image" && !/^image\/(png|jpeg|gif|webp|avif)$/.test(input.mediaType))
      throw new Error("images must be PNG, JPEG, GIF, WebP or AVIF");
    if (input.kind === "document" && !/^(text\/plain|text\/markdown)$/.test(input.mediaType))
      throw new Error("documents must be plain text or Markdown");
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    this.storeBlob(input.bytes, digest);
    const now = new Date().toISOString();
    if (input.id !== undefined) {
      const existing = this.item(input.id);
      if (input.expectedRevision !== existing.revision) throw new Error(`revision conflict: expected ${existing.revision}`);
      const collection = input.collection === undefined ? existing.collection : input.collection;
      try {
        this.db.query(`UPDATE items SET collection = ?, name = ?, kind = ?, mediaType = ?, bytes = ?, digest = ?,
          revision = revision + 1, updatedAt = ? WHERE id = ? AND revision = ?`)
          .run(collection, input.name, input.kind, input.mediaType, input.bytes.length, digest, now, input.id, input.expectedRevision);
      } catch (error) {
        if (this.nameExists(collection, input.name)) throw new Error(`item name already exists: ${input.name}`);
        throw error;
      }
      return this.item(input.id);
    }
    if (input.expectedRevision !== undefined) throw new Error("expectedRevision requires an item id");
    const id = randomUUID();
    try {
      this.db.query("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.collection ?? null, input.name, input.kind, input.mediaType, input.bytes.length, digest, 1, now, now);
    } catch (error) {
      if (this.nameExists(input.collection ?? null, input.name)) throw new Error(`item name already exists: ${input.name}`);
      throw error;
    }
    return this.item(id);
  }
  move(id: string, collection: string | null, expectedRevision: number): Item {
    if (collection) this.collection(collection);
    const item = this.item(id);
    if (item.revision !== expectedRevision) throw new Error(`revision conflict: expected ${item.revision}`);
    try {
      this.db.query("UPDATE items SET collection = ?, revision = revision + 1, updatedAt = ? WHERE id = ? AND revision = ?")
        .run(collection, new Date().toISOString(), id, expectedRevision);
    } catch (error) {
      if (this.nameExists(collection, item.name)) throw new Error(`item name already exists: ${item.name}`);
      throw error;
    }
    return this.item(id);
  }
  removeItem(id: string, expectedRevision: number): void {
    const item = this.item(id);
    if (item.revision !== expectedRevision) throw new Error(`revision conflict: expected ${item.revision}`);
    this.db.query("DELETE FROM items WHERE id = ? AND revision = ?").run(id, expectedRevision);
  }
  private scope(collection?: string | null): { where: string; args: string[] } {
    if (collection === undefined) return { where: "", args: [] };
    if (collection === null) return { where: "WHERE collection IS NULL", args: [] };
    this.collection(collection);
    return { where: "WHERE collection = ?", args: [collection] };
  }
  private nameExists(collection: string | null, name: string): boolean {
    return collection !== null && this.db.query("SELECT 1 FROM items WHERE collection = ? AND name = ?")
      .get(collection, name) !== null;
  }
  private objectPath(digest: string): string { return join(this.objects, digest.slice(0, 2), digest); }
  private stagePath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid stage ID");
    return join(this.root, "staging", id);
  }
  private storeBlob(bytes: Buffer, digest: string): void {
    const path = this.objectPath(digest);
    if (existsSync(path)) return;
    mkdirSync(join(this.objects, digest.slice(0, 2)), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, path);
  }
}

function withUrl(row: ItemRow): Item { return { ...row, url: `/c/${row.id}` }; }
