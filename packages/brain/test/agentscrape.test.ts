import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withEgressPolicy } from "@stack/scrape/network";
import {
  extractWithAgentscrape, scrapeWithAgentscrape, validateExtractionEnvelope,
  discoverFeedWithAgentscrape,
} from "../src/agentscrape.js";

const fixture = join(import.meta.dirname, "../../test/fixtures/extraction-generic.expected.json");
test("the recorded extraction contract remains compatible with Brain", () => {
  const value = JSON.parse(readFileSync(fixture, "utf8"));
  const parsed = validateExtractionEnvelope(value, "https://example.com/start");
  assert.equal(parsed.status, "success");
  const broken = { ...value, schema_version: "2" };
  assert.throws(() => validateExtractionEnvelope(broken, "https://example.com/start"), /schema version is unsupported/);
});

test("Brain extracts Markdown through the bundled Scrape engine, not a CLI", async () => {
  const server = createServer((_, response) => {
    response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    response.end("# Extracted\n\nBody");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}/page.md`;
    await assert.rejects(extractWithAgentscrape(url), /private_destination/);
    const policy = { privateDestinations: [{ address: "127.0.0.1", port: address.port }] };
    const result = await withEgressPolicy(policy, () => {}, () => extractWithAgentscrape(url));
    assert.equal(result.status, "success");
    assert.equal(result.artifacts[0]?.content, "# Extracted\n\nBody");
    assert.equal(result.artifacts[0]?.sha256, createHash("sha256").update("# Extracted\n\nBody").digest("hex"));
    assert.equal((await withEgressPolicy(policy, () => {}, () => scrapeWithAgentscrape(url))).markdown, "# Extracted\n\nBody");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("recorded feed parsing runs inside the package without network access", async () => {
  const root = mkdtempSync(join(tmpdir(), "stack-scrape-feed-"));
  try {
    const path = join(root, "feed.xml");
    writeFileSync(path, '<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><guid>one</guid><link>https://example.com/one</link><title>One</title></item></channel></rss>');
    const result = await discoverFeedWithAgentscrape({ sourceUrl: "https://example.com/feed.xml", recordedInputFile: path, maxPages: 1, maxItems: 10 });
    assert.equal(result.status, "success");
    assert.equal(result.items.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
