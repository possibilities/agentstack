import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi } from "@agentstack/api";
import { serveDocs } from "../src/server.js";
import { renderDocs } from "../src/render.js";

test("the reference renders all current Package APIs from the discovery socket", { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-docs-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const discovery = await serveApi({ name: "api", transport: "socket", env });
  const docs = await serveDocs({ env });
  try {
    const response = await fetch(docs.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    for (const name of ["auth", "bots", "roles", "owner", "usage", "workers"]) assert.match(html, new RegExp(`id="package-${name}"`));
    assert.doesNotMatch(html, /id="package-api"/);
    assert.match(html, /bot_start/);
    assert.match(html, /bot_defaults_set/);
    assert.match(html, /accounts_changed/);
    assert.match(html, /events\/subscribe/);
    assert.match(html, /&quot;topics&quot;: \[/);
    assert.match(html, /id="events-bots"[\s\S]*?voice_changed/);
    assert.match(html, /JSON Schema/);
    assert.match(html, /Generated from <code>api\.docs_snapshot<\/code>/);
    const revision = await fetch(new URL("revision", docs.url));
    assert.equal(revision.status, 200);
    assert.match(html, new RegExp((await revision.json() as { revision: string }).revision));
    assert.match(html, /rel="alternate" type="text\/markdown" href="\/index\.md"/);
    assert.match(response.headers.get("link") ?? "", /<\/index\.md>; rel="alternate"; type="text\/markdown"/);
    assert.equal((await fetch(new URL("llms.txt", docs.url))).status, 404);
    const markdown = await fetch(new URL("index.md", docs.url));
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers.get("content-type") ?? "", /text\/markdown/);
    const markdownText = await markdown.text();
    assert.match(markdownText, /^# Package API reference/m);
    assert.match(markdownText, /^## auth$/m);
    assert.match(markdownText, /`bot_start`/);
    assert.match(markdownText, /`bot_defaults_get`/);
    assert.match(markdownText, /`accounts_changed`/);
    assert.match(markdownText, /```json\n[\s\S]*"method": "events\/subscribe"/);
    assert.equal((await fetch(new URL(".md", docs.url))).status, 200);
    assert.equal((await fetch(new URL("missing.md", docs.url))).status, 404);
    const css = await fetch(new URL("site.css", docs.url));
    assert.equal(css.status, 200);
    const stylesheet = await css.text();
    assert.match(stylesheet, /\.schema-grid/);
    assert.match(stylesheet, /@media \(prefers-color-scheme: dark\)/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    const badHost = await new Promise<number>((resolve, reject) => {
      const client = request(docs.url, { headers: { Host: "example.com" } }, (reply) => {
        reply.resume();
        resolve(reply.statusCode ?? 0);
      });
      client.once("error", reject);
      client.end();
    });
    assert.equal(badHost, 403);
    await discovery.close();
    const unavailable = await fetch(docs.url);
    assert.equal(unavailable.status, 503);
    const unavailableHtml = await unavailable.text();
    assert.match(unavailableHtml, /Discovery API unavailable/);
    assert.match(unavailableHtml, /<meta name="color-scheme" content="light dark">/);
    const unavailableMarkdown = await fetch(new URL("index.md", docs.url));
    assert.equal(unavailableMarkdown.status, 503);
    assert.match(unavailableMarkdown.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(await unavailableMarkdown.text(), /# Discovery API unavailable/);
  } finally {
    await docs.close();
    await discovery.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("API-authored text is escaped in the generated reference", () => {
  const html = renderDocs([{
    name: "sample", packageName: "@agentstack/sample", description: "<script>bad()</script>",
    operations: [{ name: "sample_list", description: "<img src=x>", annotations: {}, inputSchema: {}, outputSchema: {} }],
    events: { sample_changed: "<b>bad</b>" }, eventScope: null, transports: [],
  }], "revision");
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
});

test("the owner-mounted reference keeps assets and live revision under /docs", { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-docs-mounted-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const discovery = await serveApi({ name: "api", transport: "socket", env });
  const docs = await serveDocs({ env, basePath: "/docs" });
  try {
    assert.match(docs.url, /\/docs$/);
    const page = await fetch(docs.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-base-path="\/docs"/);
    assert.match(html, /href="\/docs\/site\.css"/);
    assert.match(html, /src="\/docs\/site\.js"/);
    assert.equal((await fetch(`${docs.url}/revision`)).status, 200);
    const script = await fetch(`${docs.url}/site.js`);
    assert.match(await script.text(), /dataset\.basePath/);
    assert.match(html, /href="\/docs\/index\.md"/);
    const markdown = await fetch(`${docs.url}/index.md`);
    assert.equal(markdown.status, 200);
    assert.match(await markdown.text(), /^# Package API reference/m);
    const alias = await fetch(`${docs.url.slice(0, -"/docs".length)}/docs.md`);
    assert.equal(alias.status, 200);
    assert.match(alias.headers.get("content-type") ?? "", /text\/markdown/);
    assert.equal((await fetch(new URL("/site.css", docs.url))).status, 404);
    assert.equal((await fetch(new URL("/", docs.url))).status, 404);
    assert.equal((await fetch(new URL("/index.md", docs.url))).status, 404);
    assert.equal((await fetch(`${docs.url}/llms.txt`)).status, 404);
  } finally {
    await docs.close();
    await discovery.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
