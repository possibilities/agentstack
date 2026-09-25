import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall, socketPath } from "@agentstack/api";
import { api } from "../api.js";
import { resolveObjectPath } from "../src/serve.js";

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
    const status = await call("wiki_status", {});
    assert.equal(status.vault, join(state, "wiki", "vault"));
    assert.equal(status.artifactStore, join(state, "wiki", "artifacts"));
    assert.notEqual(status.documentsUrl, status.artifactsUrl);
    const first = await call("new", { title: "First Note", tags: "testing" });
    const second = await call("add", { title: "Second Note", content: "# Second Note\n\nSee [[first-note]]." });
    assert.equal(first.slug, "first-note");
    assert.equal(second.slug, "second-note");
    await writeFile(first.path, "---\ntitle: First Note\n---\n# First Note\n\nIndependently edited keyword.\n");
    assert.equal((await call("search", { query: "Independently" })).hits[0].slug, "first-note");
    assert.equal((await call("search", { query: "Second" })).hits[0].slug, "second-note");
    assert.equal((await call("links", { ref: "second-note" })).outgoing[0].to, "first-note");
    assert.equal((await call("backlinks", { ref: "first-note" })).incoming[0].from, "second-note");
    assert.equal((await fetch(`${status.documentsUrl}/d/first-note`)).status, 200);
    await call("rm", { ref: "first-note", reason: "test" });
    assert.equal((await fetch(`${status.documentsUrl}/d/first-note`)).status, 404);
    await call("restore", { ref: "first-note" });
    assert.equal((await fetch(`${status.documentsUrl}/d/first-note`)).status, 200);

    const bundle = join(state, "bundle");
    await mkdir(bundle);
    await writeFile(join(bundle, "index.html"), "<h1>Test bundle</h1>");
    await writeFile(join(bundle, "app.js"), "document.title='Test';");
    const published = await call("publish", { path: bundle, name: "test-bundle" });
    assert.equal(published.status, "created");
    assert.equal((await call("artifacts_show", { name: "test-bundle" })).version, published.version);
    const redirect = await fetch(`${status.documentsUrl}${published.version_url}`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), `${status.artifactsUrl}${published.version_url}`);
    const artifact = await fetch(`${status.artifactsUrl}${published.version_url}`);
    assert.equal(artifact.status, 200);
    assert.match(await artifact.text(), /Test bundle/);
    assert.match(artifact.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.equal((await call("publish", { path: bundle, name: "test-bundle" })).status, "unchanged");
    const manifest = await readFile(join(state, "wiki", "vault", "artifacts", "test-bundle.md"), "utf8");
    assert.match(manifest, /test-bundle/);
    await call("artifacts_rm", { name: "test-bundle", reason: "test" });
    assert.equal((await fetch(`${status.artifactsUrl}${published.version_url}`)).status, 404);
    await call("artifacts_restore", { name: "test-bundle" });
    assert.equal((await fetch(`${status.artifactsUrl}${published.version_url}`)).status, 200);
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

test("wiki operations are served over the Package API socket", { timeout: 30_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-wiki-socket-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: state, AGENTSTACK_WIKI_PORT: "0", AGENTSTACK_WIKI_ARTIFACT_PORT: "0" };
  const served = await serveApi({ name: "wiki", transport: "socket", env });
  try {
    const socket = socketPath("wiki", env);
    const tools = await socketCall(socket, "tools/list") as { tools: { name: string }[] };
    assert.ok(tools.tools.some((tool) => tool.name === "wiki_status"));
    assert.ok(tools.tools.some((tool) => tool.name === "artifacts_restore"));
    const status = await socketCall(socket, "tools/call", { name: "wiki_status", arguments: {} }) as { documentsUrl: string };
    const created = await socketCall(socket, "tools/call", { name: "new", arguments: { title: "Socket document" } }) as { slug: string };
    assert.equal(created.slug, "socket-document");
    assert.match(await (await fetch(`${status.documentsUrl}/d/socket-document`)).text(), /Socket document/);
    await assert.rejects(socketCall(socket, "tools/call", { name: "get", arguments: { ref: "absent" } }), /document_not_found/);
  } finally {
    await served.close();
    await rm(state, { recursive: true, force: true });
  }
});
