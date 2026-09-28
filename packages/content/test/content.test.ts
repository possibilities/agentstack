import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { serveApi, socketCall, socketPath } from "@agentstack/api";
import { api, contentNetworkConfig } from "../api.js";
import { resolveObjectPath } from "../src/serve.js";
import { listingPage } from "../src/render.js";

test("artifact listing links retain a scoped view prefix and encode entry names", () => {
  const html = listingPage({ title: "Bundle", base: "/a/bundle/v/hash/", entries: ["file name.pdf", "nested/"] });
  assert.ok(html.includes('href="./file%20name.pdf"'));
  assert.ok(html.includes('href="./nested/"'));
  assert.equal(new URL("./file%20name.pdf", "https://host/view/credential/a/bundle/v/hash/").pathname,
    "/view/credential/a/bundle/v/hash/file%20name.pdf");
});

test("isolated vault supports documents, graph, tombstones and static artifacts", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-wiki-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_WIKI_PORT: "0", AGENTSTACK_WIKI_ARTIFACT_PORT: "0" };
  const ctx = await api.createContext(env);
  const call = async (name: string, input: Record<string, unknown>) => {
    const op = api.operations.find((item) => item.name === name);
    assert.ok(op, name);
    return op.output.parse(await op.call(ctx, op.input.parse(input))) as Record<string, any>;
  };
  try {
    const status = await call("content_status", {});
    assert.equal(status.itemPath, "/c/{id}");
    assert.equal(JSON.stringify(status).includes(state), false);
    assert.notEqual(ctx.server.url, ctx.server.artifactUrl);
    const first = await call("new", { title: "First Note", tags: "testing" });
    const second = await call("add", { title: "Second Note", content: "# Second Note\n\nSee [[first-note]]." });
    assert.equal(first.slug, "first-note");
    assert.equal(second.slug, "second-note");
    assert.equal(first.path, undefined);
    await writeFile(join(state, "wiki", "vault", "first-note.md"), "---\ntitle: First Note\n---\n# First Note\n\nIndependently edited keyword.\n");
    assert.equal((await call("search", { query: "Independently" })).hits[0].slug, "first-note");
    assert.equal((await call("search", { query: "Second" })).hits[0].slug, "second-note");
    for (const result of [await call("list", {}), await call("search", { query: "Second" }), await call("graph", {})]) {
      assert.equal(JSON.stringify(result).includes(state), false, "API records do not expose server filesystem paths");
    }
    assert.equal((await call("links", { ref: "second-note" })).outgoing[0].to, "first-note");
    assert.equal((await call("backlinks", { ref: "first-note" })).incoming[0].from, "second-note");
    assert.equal((await fetch(`${ctx.server.url}/d/first-note`)).status, 200);
    const beforeEdit = await call("get", { ref: "first-note" });
    assert.equal(beforeEdit.path, undefined);
    const edited = await call("document_update", { ref: "first-note", expectedDigest: beforeEdit.digest, content: "# First Note\n\nPortable edit." });
    assert.equal(edited.slug, first.slug);
    await assert.rejects(call("document_update", { ref: "first-note", expectedDigest: beforeEdit.digest, content: "stale" }), /document changed/);
    await call("rm", { ref: "first-note", reason: "test" });
    assert.equal((await fetch(`${ctx.server.url}/d/first-note`)).status, 404);
    await call("restore", { ref: "first-note" });
    assert.equal((await fetch(`${ctx.server.url}/d/first-note`)).status, 200);

    const files = [{ name: "index.html", bytes: Buffer.from("<h1>Test bundle</h1>") }, { name: "app.js", bytes: Buffer.from("document.title='Test';") }];
    for (const file of files) {
      const digest = createHash("sha256").update(file.bytes).digest("hex");
      const stage = await call("blob_stage_start", { bytes: file.bytes.length, digest, clientKey: file.name });
      await call("blob_stage_chunk", { id: stage.id, offset: 0, base64: file.bytes.toString("base64") });
      assert.equal((await call("blob_stage_finish", { id: stage.id })).blob, digest);
      assert.equal((await call("blob_stage_finish", { id: stage.id })).blob, digest);
    }
    const publishInput = { name: "test-bundle", kind: "bundle", files: files.map((file) => ({ name: file.name, blob: createHash("sha256").update(file.bytes).digest("hex") })) };
    await assert.rejects(call("artifact_publish", { name: "bad-bundle", files: [{ name: "../escape.html", blob: publishInput.files[0]!.blob }] }), /invalid bundle file name/);
    const published = await call("artifact_publish", publishInput);
    assert.equal(published.status, "created");
    assert.equal((await call("artifacts_show", { name: "test-bundle" })).version, published.version);
    const redirect = await fetch(`${ctx.server.url}${published.version_url}`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), `${ctx.server.artifactUrl}${published.version_url}`);
    const artifact = await fetch(`${ctx.server.artifactUrl}${published.version_url}`);
    assert.equal(artifact.status, 200);
    assert.match(await artifact.text(), /Test bundle/);
    assert.match(artifact.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.equal((await call("artifact_publish", publishInput)).status, "unchanged");
    const manifest = await readFile(join(state, "wiki", "vault", "artifacts", "test-bundle.md"), "utf8");
    assert.match(manifest, /test-bundle/);
    await call("artifacts_rm", { name: "test-bundle", reason: "test" });
    assert.equal((await fetch(`${ctx.server.artifactUrl}${published.version_url}`)).status, 404);
    await call("artifacts_restore", { name: "test-bundle" });
    assert.equal((await fetch(`${ctx.server.artifactUrl}${published.version_url}`)).status, 200);
  } finally {
    await api.closeContext(ctx);
    await rm(state, { recursive: true, force: true });
  }
});

test("artifact paths reject traversal and symlinks outside the content object", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-wiki-path-"));
  const object = join(root, "object");
  try {
    await mkdir(join(object, "sub"), { recursive: true });
    await writeFile(join(root, "secret.txt"), "secret");
    await writeFile(join(object, "sub", "index.html"), "safe");
    await symlink(root, join(object, "escape"));
    await symlink(join(root, "secret.txt"), join(object, "leak.txt"));
    for (const path of ["../secret.txt", "%2e%2e/secret.txt", "sub%2findex.html", "sub/../../secret.txt", "escape/secret.txt", "leak.txt", "index.html%00", "%zz"]) {
      assert.equal(resolveObjectPath(object, path), null, path);
    }
    assert.equal(resolveObjectPath(object, "sub/index.html")?.segments.join("/"), "sub/index.html");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content operations are served over the Package API socket", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-wiki-socket-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_WIKI_PORT: "0", AGENTSTACK_WIKI_ARTIFACT_PORT: "0" };
  const served = await serveApi({ name: "content", transport: "socket", env });
  try {
    const socket = socketPath("content", env);
    const tools = await socketCall(socket, "tools/list") as { tools: { name: string }[] };
    assert.ok(tools.tools.some((tool) => tool.name === "content_status"));
    assert.ok(tools.tools.some((tool) => tool.name === "item_put"));
    assert.ok(tools.tools.some((tool) => tool.name === "artifacts_restore"));
    const status = await socketCall(socket, "tools/call", { name: "content_status", arguments: {} }) as { documentPath: string };
    const created = await socketCall(socket, "tools/call", { name: "new", arguments: { title: "Socket document" } }) as { slug: string };
    assert.equal(created.slug, "socket-document");
    assert.equal(status.documentPath, "/d/{slug}");
    const read = await socketCall(socket, "tools/call", { name: "get", arguments: { ref: created.slug } }) as { content: string; digest: string; path?: string };
    assert.match(read.content, /Socket document/);
    assert.equal(read.path, undefined);
    await assert.rejects(socketCall(socket, "tools/call", { name: "get", arguments: { ref: "absent" } }), /document_not_found/);
  } finally {
    await served.close();
    await rm(state, { recursive: true, force: true });
  }
});

test("content mutations publish content_changed; reads announce only direct vault edits they notice", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-content-events-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_WIKI_PORT: "0", AGENTSTACK_WIKI_ARTIFACT_PORT: "0" };
  const ctx = await api.createContext(env);
  const notices: string[] = [];
  const stop = await api.events!.start(ctx, (topic) => { notices.push(topic); });
  const call = async (name: string, input: Record<string, unknown>) => {
    const op = api.operations.find((item) => item.name === name);
    assert.ok(op, name);
    return op.output.parse(await op.call(ctx, op.input.parse(input))) as Record<string, any>;
  };
  const expectNotices = async (count: number, run: () => Promise<unknown>) => {
    const before = notices.length;
    await run();
    assert.deepEqual(notices.slice(before), Array(count).fill("content_changed"));
  };
  try {
    assert.deepEqual(Object.keys(api.events!.topics), ["content_changed"]);
    await expectNotices(0, () => call("content_status", {}));
    await expectNotices(1, () => call("collection_create", { slug: "notes", title: "Notes" }));
    await expectNotices(0, () => call("collection_list", {}));
    await expectNotices(1, () => call("collection_update", { collection: "notes", title: "Notes", description: "Kept" }));
    let item: Record<string, any> = {};
    await expectNotices(1, async () => { item = await call("item_put", { collection: "notes", name: "a.md", kind: "document", mediaType: "text/markdown", content: "# A" }); });
    await expectNotices(0, () => call("item_list", {}));
    await expectNotices(1, async () => { item = await call("item_move", { id: item.id, collection: null, expectedRevision: item.revision }); });
    await expectNotices(0, () => assert.rejects(call("item_move", { id: item.id, collection: null, expectedRevision: item.revision + 5 }), /revision conflict/));
    await expectNotices(1, () => call("item_delete", { id: item.id, expectedRevision: item.revision }));
    await expectNotices(1, () => call("collection_delete", { collection: "notes" }));
    await expectNotices(1, () => call("new", { title: "Evented" }));
    await expectNotices(0, () => call("list", {}));
    const read = await call("get", { ref: "evented" });
    await expectNotices(1, () => call("document_update", { ref: "evented", expectedDigest: read.digest, content: "# Evented\n\nEdited." }));
    await expectNotices(1, () => call("rm", { ref: "evented", reason: "test" }));
    await expectNotices(1, () => call("restore", { ref: "evented" }));
    await expectNotices(1, () => call("add", { title: "Captured", content: "# Captured" }));
    // A direct edit is announced by the read that commits it, then never again.
    await writeFile(join(state, "wiki", "vault", "evented.md"), "---\ntitle: Evented\n---\n# Evented\n\nDirect.\n");
    await expectNotices(1, () => call("list", {}));
    await expectNotices(0, () => call("list", {}));
    stop?.();
    await expectNotices(0, () => call("new", { title: "After stop" }));
  } finally {
    await api.closeContext(ctx);
    await rm(state, { recursive: true, force: true });
  }
});

test("collections store documents and binary media with fenced edits and shareable URLs", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-content-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_CONTENT_PORT: "0", AGENTSTACK_CONTENT_ARTIFACT_PORT: "0" };
  const ctx = await api.createContext(env);
  const call = async (name: string, input: Record<string, unknown>) => {
    const op = api.operations.find((item) => item.name === name);
    assert.ok(op, name);
    return op.output.parse(await op.call(ctx, op.input.parse(input))) as Record<string, any>;
  };
  try {
    const status = await call("content_status", {});
    assert.equal(status.itemPath, "/c/{id}");
    await call("collection_create", { slug: "team-notes", title: "Team notes" });
    const doc = await call("item_put", { collection: "team-notes", name: "plan.md", kind: "document", mediaType: "text/markdown", content: "# Plan" });
    assert.equal(doc.revision, 1);
    assert.equal((await call("item_get", { id: doc.id, includeData: true })).content, "# Plan");
    assert.equal(await (await fetch(`${ctx.server.artifactUrl}${doc.url}`)).text(), "# Plan");
    assert.equal((await fetch(`${ctx.server.url}${doc.url}`, { redirect: "manual" })).status, 302);
    await assert.rejects(call("item_put", { collection: "team-notes", name: "plan.md", kind: "document", mediaType: "text/markdown", content: "overwrite" }), /already exists/);
    const next = await call("item_put", { collection: "team-notes", id: doc.id, expectedRevision: 1, name: "plan.md", kind: "document", mediaType: "text/markdown", content: "# Revised" });
    assert.equal(next.revision, 2);
    await assert.rejects(call("item_put", { collection: "team-notes", id: doc.id, expectedRevision: 1, name: "plan.md", kind: "document", mediaType: "text/markdown", content: "stale" }), /revision conflict/);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const image = await call("item_put", { collection: "team-notes", name: "image.png", kind: "image", mediaType: "image/png", base64: png.toString("base64") });
    assert.deepEqual(Buffer.from((await call("item_get", { id: image.id, includeData: true })).base64, "base64"), png);
    assert.equal((await fetch(`${ctx.server.artifactUrl}${image.url}`)).headers.get("content-type"), "image/png");
    await assert.rejects(call("item_put", { collection: "team-notes", name: "unsafe.svg", kind: "image", mediaType: "image/svg+xml", base64: "" }), /images must be/);
    assert.equal((await fetch(`${ctx.server.artifactUrl}/c/%2f..`)).status, 404);
    const file = await call("item_put", { collection: "team-notes", name: "source.zip", kind: "file", mediaType: "application/zip", base64: Buffer.from("binary file\0contents").toString("base64") });
    assert.match((await fetch(`${ctx.server.artifactUrl}${file.url}`)).headers.get("content-disposition") ?? "", /attachment/);
    assert.equal((await call("item_list", { collection: "team-notes" })).items.length, 3);
    assert.equal((await call("item_read", { id: file.id, offset: 7, length: 4 })).base64, Buffer.from("file").toString("base64"));
    const firstPage = await call("item_list", { collection: "team-notes", limit: 1 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.nextOffset, 1);
    assert.equal((await call("item_list", { collection: "team-notes", limit: 1, offset: 2 })).nextOffset, null);
    await assert.rejects(call("item_delete", { id: doc.id, expectedRevision: 1 }), /revision conflict/);
    const moved = await call("item_move", { id: next.id, collection: null, expectedRevision: next.revision });
    assert.equal(moved.url, next.url);
    assert.equal(moved.collection, null);
    await call("collection_delete", { collection: "team-notes" });
    assert.equal((await call("item_get", { id: image.id })).collection, null);
    assert.equal((await call("item_list", {})).items.length, 3);
    for (const item of [moved, image, file]) {
      const current = await call("item_get", { id: item.id });
      await call("item_delete", { id: item.id, expectedRevision: current.revision });
    }
    assert.equal((await fetch(`${ctx.server.artifactUrl}${doc.url}`)).status, 404);
    assert.deepEqual((await call("collection_list", {})).collections, []);
  } finally {
    await api.closeContext(ctx);
    await rm(state, { recursive: true, force: true });
  }
});

test("ungrouped items retain their IDs and links through moves and collection deletion", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-ungrouped-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_CONTENT_PORT: "0", AGENTSTACK_CONTENT_ARTIFACT_PORT: "0" };
  const ctx = await api.createContext(env);
  const call = async (name: string, input: Record<string, unknown>) => {
    const op = api.operations.find((entry) => entry.name === name)!;
    return op.output.parse(await op.call(ctx, op.input.parse(input))) as Record<string, any>;
  };
  try {
    const one = await call("item_put", { name: "shared.txt", kind: "document", mediaType: "text/plain", content: "one" });
    const two = await call("item_put", { name: "shared.txt", kind: "document", mediaType: "text/plain", content: "two" });
    assert.equal(one.collection, null);
    assert.notEqual(one.id, two.id);
    assert.equal(one.url, `/c/${one.id}`);
    await call("collection_create", { slug: "notes", title: "Notes" });
    const moved = await call("item_move", { id: one.id, collection: "notes", expectedRevision: 1 });
    assert.equal(moved.url, one.url);
    assert.equal((await call("item_list", { collection: null })).total, 1);
    await assert.rejects(call("item_move", { id: one.id, collection: null, expectedRevision: 1 }), /revision conflict/);
    await call("collection_delete", { collection: "notes" });
    assert.equal((await call("item_get", { id: one.id, includeData: true })).content, "one");
    assert.equal((await call("item_list", {})).total, 2);
    assert.equal(await (await fetch(`${ctx.server.artifactUrl}${one.url}`)).text(), "one");
    const legacy = await fetch(`${ctx.server.artifactUrl}/c/notes/${one.id}`, { redirect: "manual" });
    assert.equal(legacy.headers.get("location"), one.url);
  } finally { await api.closeContext(ctx); await rm(state, { recursive: true, force: true }); }
});

test("resumable staged bytes survive a context restart and support large items by digest", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-stage-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_CONTENT_PORT: "0", AGENTSTACK_CONTENT_ARTIFACT_PORT: "0" };
  const bytes = Buffer.alloc(300_000, 65);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const call = async (ctx: Awaited<ReturnType<typeof api.createContext>>, name: string, input: Record<string, unknown>) => {
    const op = api.operations.find((entry) => entry.name === name)!;
    return op.output.parse(await op.call(ctx, op.input.parse(input))) as Record<string, any>;
  };
  try {
    const first = await api.createContext(env);
    let id: string;
    try {
    const stage = await call(first, "blob_stage_start", { bytes: bytes.length, digest, clientKey: "large-asset" });
      id = stage.id;
      assert.equal((await call(first, "blob_stage_start", { bytes: bytes.length, digest, clientKey: "large-asset" })).id, id);
      await call(first, "blob_stage_chunk", { id, offset: 0, base64: bytes.subarray(0, 200_000).toString("base64") });
      assert.equal((await call(first, "blob_stage_status", { id })).received, 200_000);
      await assert.rejects(call(first, "blob_stage_finish", { id }), /incomplete/);
    } finally { await api.closeContext(first); }
    const second = await api.createContext(env);
    try {
      assert.equal((await call(second, "blob_stage_status", { id })).received, 200_000);
      await call(second, "blob_stage_chunk", { id, offset: 0, base64: bytes.subarray(0, 200_000).toString("base64") });
      await assert.rejects(call(second, "blob_stage_chunk", { id, offset: 0, base64: Buffer.from("different").toString("base64") }), /differs/);
      await call(second, "blob_stage_chunk", { id, offset: 200_000, base64: bytes.subarray(200_000).toString("base64") });
      assert.equal((await call(second, "blob_stage_finish", { id })).blob, digest);
      const item = await call(second, "item_put", { name: "large.bin", kind: "file", mediaType: "application/octet-stream", blob: digest });
      assert.equal(item.bytes, bytes.length);
      assert.equal((await call(second, "item_get", { id: item.id, includeData: true })).base64, null);
      assert.equal((await call(second, "item_read", { id: item.id, offset: 262_144 })).nextOffset, null);
    } finally { await api.closeContext(second); }
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("the original collection schema migrates IDs and byte references without requiring a collection later", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-collection-migration-"));
  const root = join(state, "wiki", "collections");
  await mkdir(join(root, "objects", "ba"), { recursive: true });
  const bytes = Buffer.from("legacy");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(root, "objects", digest.slice(0, 2)), { recursive: true });
  await writeFile(join(root, "objects", digest.slice(0, 2), digest), bytes);
  const id = "a1e7b246-6e12-43ae-8d85-2178bf0bb238";
  const db = new DatabaseSync(join(root, "collections.sqlite3"));
  db.exec("CREATE TABLE collections (slug TEXT PRIMARY KEY, title TEXT, description TEXT, createdAt TEXT, updatedAt TEXT);");
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, collection TEXT NOT NULL REFERENCES collections(slug), name TEXT, kind TEXT, mediaType TEXT, bytes INTEGER, digest TEXT, revision INTEGER, createdAt TEXT, updatedAt TEXT, UNIQUE(collection, name));");
  db.exec("INSERT INTO collections VALUES ('old', 'Old', '', 'now', 'now')");
  db.prepare("INSERT INTO items VALUES (?, 'old', 'legacy.txt', 'document', 'text/plain', 6, ?, 1, 'now', 'now')").run(id, digest);
  db.close();
  const ctx = await api.createContext({ ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_CONTENT_PORT: "0", AGENTSTACK_CONTENT_ARTIFACT_PORT: "0" });
  try {
    assert.equal(ctx.collections.item(id).url, `/c/${id}`);
    ctx.collections.remove("old");
    assert.equal(ctx.collections.item(id).collection, null);
    assert.equal(ctx.collections.bytes(ctx.collections.item(id)).toString(), "legacy");
  } finally { await api.closeContext(ctx); await rm(state, { recursive: true, force: true }); }
});

test("Content backends cannot bind remotely; Access owns authenticated remote ingress", () => {
  assert.throws(() => contentNetworkConfig({ AGENTSTACK_CONTENT_HOST: "0.0.0.0" }), /must bind 127/);
  assert.throws(() => contentNetworkConfig({ AGENTSTACK_CONTENT_DOCUMENT_ORIGIN: "https://same.example", AGENTSTACK_CONTENT_ARTIFACT_ORIGIN: "https://same.example" }), /must differ/);
  assert.throws(() => contentNetworkConfig({ AGENTSTACK_CONTENT_HOST: "0.0.0.0", AGENTSTACK_CONTENT_DOCUMENT_ORIGIN: "https://docs.example", AGENTSTACK_CONTENT_ARTIFACT_ORIGIN: "https://assets.example" }), /must bind 127/);
});

test("configured public origins drive static redirects without appearing in stored item identities", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-public-origin-"));
  const ctx = await api.createContext({ ...process.env, AGENTSTACK_STATE_DIR: state,
    AGENTSTACK_CONTENT_PORT: "0", AGENTSTACK_CONTENT_ARTIFACT_PORT: "0",
    AGENTSTACK_CONTENT_DOCUMENT_ORIGIN: "https://docs.example", AGENTSTACK_CONTENT_ARTIFACT_ORIGIN: "https://assets.example" });
  try {
    const item = ctx.collections.put({ name: "picture.png", kind: "image", mediaType: "image/png", bytes: Buffer.from("image") });
    assert.equal(item.url, `/c/${item.id}`);
    const redirected = await fetch(`http://127.0.0.1:${ctx.server.port}${item.url}`, { redirect: "manual" });
    assert.equal(redirected.headers.get("location"), `https://assets.example${item.url}`);
    assert.equal(ctx.server.url, "https://docs.example");
  } finally { await api.closeContext(ctx); await rm(state, { recursive: true, force: true }); }
});

test("collections survive a context restart without moving the legacy vault", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-content-persist-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_WIKI_PORT: "0", AGENTSTACK_WIKI_ARTIFACT_PORT: "0" };
  try {
    const first = await api.createContext(env);
    let id: string;
    try {
      const create = api.operations.find((op) => op.name === "collection_create")!;
      await create.call(first, create.input.parse({ slug: "shared", title: "Shared" }));
      const put = api.operations.find((op) => op.name === "item_put")!;
      id = (await put.call(first, put.input.parse({ collection: "shared", name: "note.md", kind: "document", mediaType: "text/markdown", content: "persistent" })) as { id: string }).id;
    } finally { await api.closeContext(first); }
    const second = await api.createContext(env);
    try {
      const get = api.operations.find((op) => op.name === "item_get")!;
      const record = await get.call(second, get.input.parse({ id, includeData: true })) as { content: string };
      assert.equal(record.content, "persistent");
      assert.equal((await api.operations.find((op) => op.name === "content_status")!.call(second, {} as never) as { itemPath: string }).itemPath, "/c/{id}");
    } finally { await api.closeContext(second); }
  } finally { await rm(state, { recursive: true, force: true }); }
});
