import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { api } from "../api.js";
import { findAgentBrowserExecutable } from "../src/browser.js";
import { canaryInventory } from "../src/canary.js";
import { testCorpus } from "../src/corpus.js";
import { buildFailureEnvelope } from "../src/envelope.js";
import { PresetDriftError } from "../src/errors.js";
import { loadRegistry, selectPreset } from "../src/presets.js";
import { resolveDataHome } from "../src/queue-paths.js";

const state = mkdtempSync(join(tmpdir(), "stack-scrape-api-"));
const previous = process.env.STACK_STATE_DIR;
process.env.STACK_STATE_DIR = state;
test.after(() => {
  if (previous === undefined) delete process.env.STACK_STATE_DIR;
  else process.env.STACK_STATE_DIR = previous;
  rmSync(state, { recursive: true, force: true });
});

test("every shipped preset has replayable evidence and the corpus remains green", async () => {
  const names = loadRegistry().presets.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["chatgpt-conversation", "deepwiki-search-conversation", "deepwiki-wiki-page", "docs-section-nav", "docs-sidebar", "x-article", "x-profile", "x-timeline", "x-tweet"]);
  const result = await testCorpus();
  assert.equal(result.failed, 0, result.lines.join("\n"));
  for (const name of names) assert.ok(result.lines.some((line) => line.includes(`${name}/`)), name);
  const canaries = canaryInventory();
  assert.equal(canaries.length, names.length);
  assert.deepEqual(canaries.filter((item) => item.configured).map((item) => item.preset), ["deepwiki-wiki-page"]);
});

test("a changed provider shape is an actionable failure, never a generic success", () => {
  const failure = buildFailureEnvelope(new PresetDriftError("x-tweet: post structure changed"), {
    requestedUrl: "https://x.com/example/status/123", implementation: "x-tweet",
  });
  assert.equal(failure.status, "failure");
  assert.equal(failure.artifacts.length, 0);
  assert.equal(failure.failure?.failure_class, "malformed_provider_output");
  assert.equal(failure.failure?.retryable, false);
  assert.match(failure.failure!.evidence, /Preset needs update: x-tweet/);
  assert.equal(failure.extractor.implementation, "x-tweet");
  assert.throws(() => selectPreset("https://x.com/example/unmatched", loadRegistry()), /preset-owned domain/);
});

test("scrape exports only Package API operations and defaults to isolated Stack state", async () => {
  assert.equal(resolveDataHome(), join(state, "scrape"));
  assert.equal(api.operations.some((entry) => entry.name === "scrape_fetch"), true);
  assert.equal(api.operations.some((entry) => entry.name === "scrape_queue_submit"), true);
  const ctx = await api.createContext!({} as never);
  try {
    const status = api.operations.find((entry) => entry.name === "scrape_status")!;
    const value = await status.call(ctx, {});
    assert.equal((value as { stateRoot: string }).stateRoot, join(state, "scrape"));
  } finally { await api.prepareCloseContext?.(ctx); await api.closeContext?.(ctx); }
});

test("Scrape prefers Stack's private browser toolchain without launching it", () => {
  const candidates: string[] = [];
  const selected = findAgentBrowserExecutable(state, undefined, (candidate) => {
    candidates.push(candidate);
    return candidate.includes("/browser/toolchain/current/") ? candidate : null;
  });
  assert.equal(selected, candidates[0]);
  assert.match(selected ?? "", /\/browser\/toolchain\/current\/node_modules\/agent-browser\/bin\//);
});

test("operator-only file conversion uses supplied local HTML without network access", async () => {
  const htmlPath = join(state, "source.html");
  writeFileSync(htmlPath, "<main><h1>Offline</h1><p>From file</p></main>");
  const ctx = await api.createContext!({} as never);
  try {
    const operation = api.operations.find((entry) => entry.name === "scrape_convert_html_file")!;
    const result = await operation.call(ctx, { path: htmlPath });
    assert.equal(operation.output.safeParse(result).success, true);
    assert.match((result as { markdown: string }).markdown, /# Offline/);
  } finally { await api.prepareCloseContext?.(ctx); await api.closeContext?.(ctx); }
});

test("typed Package API exposes a local direct-Markdown result and classified refusal", async () => {
  const server = createServer((_, response) => {
    response.setHeader("content-type", "text/markdown; charset=utf-8");
    response.end("# Local document\n\nBody");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const ctx = await api.createContext!({} as never);
  try {
    const operation = api.operations.find((entry) => entry.name === "scrape_fetch")!;
    const url = `http://127.0.0.1:${address.port}/local.md`;
    const refused = await operation.call(ctx, { url, allowPrivateNetwork: false });
    assert.equal(operation.output.safeParse(refused).success, true);
    assert.equal((refused as { failure: { failure_class: string } }).failure.failure_class, "invalid_request");
    const extracted = await operation.call(ctx, { url, allowPrivateNetwork: true });
    assert.equal(operation.output.safeParse(extracted).success, true);
    assert.equal((extracted as { artifacts: Array<{ content: string }> }).artifacts[0]?.content, "# Local document\n\nBody");
    const destination = join(state, "local.md");
    const fileOperation = api.operations.find((entry) => entry.name === "scrape_fetch_file")!;
    const saved = await fileOperation.call(ctx, { url, destination, allowPrivateNetwork: true, retainArtifacts: false });
    assert.equal(fileOperation.output.safeParse(saved).success, true);
    assert.equal(readFileSync(destination, "utf8"), "# Local document\n\nBody");
  } finally {
    await api.prepareCloseContext?.(ctx);
    await api.closeContext?.(ctx);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
