import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { corpusSelection, queueMaintenanceActions, driftedPreset, jobLabel, parseFrontmatter, presetPreview, scrapeCallError, scrapeLocalReason } = await import("../lib/stack/scrape.ts");

test("queue maintenance distinguishes pending, failed, retrying and receipt-retired generations", () => {
  assert.deepEqual(queueMaintenanceActions({ state: "pending" }), ["cancel"]);
  assert.deepEqual(queueMaintenanceActions({ state: "failed" }), ["retry", "discard"]);
  assert.deepEqual(queueMaintenanceActions({ state: "retrying" }), []);
  for (const state of ["pending", "failed", "retrying"]) {
    assert.deepEqual(queueMaintenanceActions({ state, maintenanceFence: { status: "unknown" } }), ["discard"]);
  }
});

test("corpus selection binds exact observed final captures and never directories, siblings or shipped fixtures", () => {
  const rows = [{ preset: "x-tweet", id: "sample-001" }, { preset: "x-tweet", id: "sample-002" }, { preset: "x-article", id: "sample-003" }];
  assert.deepEqual(corpusSelection(rows, "x-tweet", ["sample-002"]), [{ preset: "x-tweet", id: "sample-002" }]);
  for (const ids of [[], ["sample-003"], ["sample-001", "sample-001"], ["sample-004"], ["fixture-001"], ["../sample-001"], [".capture-tmp"], ["sample-001", "sample-002", ...Array(99).fill("sample-004")]]) {
    assert.equal(corpusSelection(rows, "x-tweet", ids), null);
  }
  assert.equal(corpusSelection(rows.slice(1), "x-tweet", ["sample-001"]), null);
  assert.equal(corpusSelection(rows, "../x-tweet", ["sample-001"]), null);
});

const preset = (name, domain, patterns, aliases = []) => ({ name, summary: "", domain, mode: "content", aliases, url_patterns: patterns, source: "official" });
const presets = [
  preset("x-tweet", "x.com", ["^https?://(?:www\\.)?(?:x\\.com|twitter\\.com)/\\w+/status/\\d+(?:[/?].*)?$"], ["twitter.com"]),
  preset("x-timeline", "x.com", [], ["twitter.com"]),
  { ...preset("docs-sidebar", "*", []), mode: "links" },
];

test("the preset preview mirrors automatic selection, including fail-closed claimed hosts", () => {
  assert.deepEqual(presetPreview("https://x.com/someone/status/123", presets), { kind: "match", presets: ["x-tweet"] });
  assert.deepEqual(presetPreview("https://www.twitter.com/someone/status/123#frag", presets), { kind: "match", presets: ["x-tweet"] });
  assert.deepEqual(presetPreview("https://x.com/someone", presets), { kind: "claimed", domain: "x.com" });
  assert.deepEqual(presetPreview("https://example.com/post", presets), { kind: "generic" });
  assert.deepEqual(presetPreview("ftp://example.com", presets), { kind: "invalid" });
  assert.deepEqual(presetPreview("https://user:pw@example.com", presets), { kind: "invalid" });
  assert.deepEqual(presetPreview("not a url", presets), { kind: "invalid" });
});

test("a drift failure names a preset only when it exists", () => {
  const failure = { failure_class: "malformed_provider_output", message: "x-tweet: post structure changed", evidence: "Preset needs update: x-tweet" };
  assert.equal(driftedPreset(failure, "x-tweet", presets), "x-tweet");
  assert.equal(driftedPreset({ ...failure, evidence: "", message: "changed" }, "gone", presets), null);
  assert.equal(driftedPreset({ ...failure, failure_class: "timeout" }, "x-tweet", presets), null);
});

test("a timed-out or dropped call is uncertain; a refused or answered one is definite", () => {
  assert.deepEqual(scrapeCallError(new Error("socket call timed out: tools/call")).uncertain, true);
  assert.deepEqual(scrapeCallError(new Error("connection closed")).uncertain, true);
  assert.deepEqual(scrapeCallError(new Error("scrape WebSocket is not connected")).uncertain, false);
  assert.deepEqual(scrapeCallError(new Error("malformed_provider_output\nPreset x-tweet needs update: shape")), { text: "Preset needs update. Preset x-tweet needs update: shape", uncertain: false });
  assert.deepEqual(scrapeCallError(new Error("scrape_stopping\nScrape is stopping")), { text: "Scrape is stopping", uncertain: false });
});

test("remote sessions are told Scrape's network and file operations stay local", () => {
  assert.equal(scrapeLocalReason(undefined), null);
  assert.equal(scrapeLocalReason({ scope: "control", scopes: [] }), "Available only on the local UI");
});

test("queue labels and frontmatter parsing", () => {
  assert.equal(jobLabel({ url: "https://example.com/a/b?q=1", file: "f.yaml" }), "example.com/a/b");
  assert.equal(jobLabel({ url: null, file: "f.yaml" }), "f.yaml");
  assert.deepEqual(parseFrontmatter("source: reading list\n\ntags: a, b:c\n"), { source: "reading list", tags: "a, b:c" });
  assert.deepEqual(parseFrontmatter(""), {});
  assert.equal(parseFrontmatter("no colon here"), null);
  assert.equal(parseFrontmatter(": value"), null);
});
