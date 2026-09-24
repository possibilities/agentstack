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
    for (const name of ["auth", "bots", "codex", "owner"]) assert.match(html, new RegExp(`id="package-${name}"`));
    assert.doesNotMatch(html, /id="package-api"/);
    assert.match(html, /server_start/);
    assert.match(html, /accounts_changed/);
    assert.match(html, /events\/subscribe/);
    assert.match(html, /&quot;topics&quot;: \[/);
    assert.match(html, /JSON Schema/);
    const revision = await fetch(new URL("revision", docs.url));
    assert.equal(revision.status, 200);
    assert.match(html, new RegExp((await revision.json() as { revision: string }).revision));
    const css = await fetch(new URL("site.css", docs.url));
    assert.equal(css.status, 200);
    assert.match(await css.text(), /\.schema-grid/);
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
    assert.match(await unavailable.text(), /Discovery API unavailable/);
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
    events: { sample_changed: "<b>bad</b>" }, transports: [],
  }], "revision");
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;b&gt;bad&lt;\/b&gt;/);
});
