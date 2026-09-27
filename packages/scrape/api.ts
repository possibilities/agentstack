import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { convertHtml, fetchLinks, fetchMarkdown, submitScrapeJob, closeBrowserSession, structuredJson } from "./src/api.js";
import { runAgentBrowser, requireAgentBrowserSuccess, findAgentBrowserExecutable } from "./src/browser.js";
import { canaryInventory, checkPresets } from "./src/canary.js";
import { captureCorpus, testCorpus } from "./src/corpus.js";
import { discoverFeed, discoverFeedLive } from "./src/feed.js";
import { loadRegistry, validatePresetFile } from "./src/presets.js";
import { processQueue, type QueueResult } from "./src/queue.js";
import { resolveDataHome } from "./src/queue-paths.js";
import { findExecutable } from "./src/subprocess.js";
import { convertHtmlDirectory, readRegularFileNoFollow } from "./src/html-files.js";
import { PresetDriftError, PresetOutputError } from "./src/errors.js";
import type { ExtractionEnvelope } from "./src/schemas.js";

const url = z.url().max(8192);
const preset = z.string().min(1).max(100);
const safeResult = z.object({ markdown: z.string(), structured: z.unknown(), links: z.array(z.unknown()).optional() });
const nullableText = z.string().nullable();
const validators = z.strictObject({ etag: nullableText, last_modified: nullableText });
const presetRecord = z.strictObject({
  name: z.string(), summary: z.string(), domain: z.string(), mode: z.enum(["content", "links", "nav-links"]),
  aliases: z.array(z.string()), browser_profile: z.string().optional(), url_patterns: z.array(z.string()),
  handler: z.string().optional(), schema: z.string().optional(), selector: z.string().optional(),
  section_selector: z.string().optional(), category_selector: z.string().optional(), toggle_selector: z.string().optional(),
  source: z.enum(["official", "local"]),
});
const envelope = z.object({
  schema_version: z.literal("1"), status: z.enum(["success", "failure"]), requested_url: z.string(),
  final_url: z.string().nullable(), extractor: z.object({ name: z.string(), version: z.string(), implementation: z.string(), implementation_version: z.string() }),
  artifacts: z.array(z.strictObject({ artifact_type: z.literal("document"), media_type: z.literal("text/markdown"), encoding: z.literal("utf-8"), content: z.string(), size_bytes: z.number().int(), sha256: z.string() })),
  metadata: z.strictObject({ content_type: z.enum(["web_page", "social_post", "article"]), content_kind: z.enum(["post", "thread", "article"]).optional(), content_item_count: z.number().int().optional(), title: z.string(), author_name: z.string(), author_handle: z.string(), published_at: z.string(), source_id: z.string(), warnings: z.array(z.literal("partial_content")) }).nullable(),
  relations: z.array(z.strictObject({ relation_type: z.literal("references"), target_url: z.string() })),
  failure: z.strictObject({ failure_class: z.enum(["invalid_request", "authentication_required", "upstream_unavailable", "timeout", "browser_error", "provider_error", "malformed_provider_output", "empty_content", "output_limit_exceeded", "cancelled", "internal_error"]), retryable: z.boolean(), message: z.string(), evidence: z.string() }).nullable(),
});
const feedResult = z.object({ schema_version: z.literal("1"), status: z.enum(["success", "partial", "failure"]), source_url: z.string(),
  source_format: z.enum(["rss", "atom", "archive", "mixed", "unknown"]), validators,
  cursor: z.strictObject({ validators, newest_seen_at: nullableText, next_url: nullableText }),
  items: z.array(z.strictObject({ stable_id: z.string(), upstream_id: nullableText, identity_source: z.enum(["upstream_id", "canonical_url", "hashed_upstream_id"]), url: nullableText, candidate_urls: z.array(z.string()), title: z.string(), published_at: nullableText, updated_at: nullableText, tombstone: z.boolean() })),
  pagination: z.strictObject({ pages: z.array(z.strictObject({ url: z.string(), page_format: z.enum(["rss", "atom", "archive"]), validators, item_count: z.number().int(), next_url: nullableText })), complete: z.boolean(), stop_reason: z.string(), next_url: nullableText }),
  warnings: z.array(z.strictObject({ code: z.string(), message: z.string(), page_url: z.string().optional() })), absence_implies_deletion: z.literal(false), failure: z.strictObject({ code: z.string(), retryable: z.boolean(), message: z.string() }).nullable() });
const archive = z.strictObject({
  startUrl: url.optional(), entrySelector: z.string(), linkSelector: z.string().optional(), dateSelector: z.string().optional(),
  dateAttribute: z.string().optional(), updatedSelector: z.string().optional(), nextSelector: z.string().optional(),
  idAttribute: z.string().optional(), titleSelector: z.string().optional(), tombstoneSelector: z.string().optional(),
});
const feedOptions = z.strictObject({ sourceUrl: url, sourceKind: z.enum(["auto", "feed", "archive"]).optional(), since: z.string().optional(),
  maxResponseBytes: z.number().int().min(1).max(20_000_000).optional(), maxPages: z.number().int().min(1).max(100).optional(),
  maxItems: z.number().int().min(1).max(10_000).optional(), timeoutSeconds: z.number().min(0.001).max(300).optional(),
  archive: archive.optional(), etag: z.string().optional(), lastModified: z.string().optional(), validatorUrl: url.optional() });
const recordedPage = z.strictObject({ url, content: z.string().max(20_000_000), kind: z.enum(["auto", "feed", "archive"]).optional(),
  validators: z.strictObject({ etag: z.string().nullable().optional(), last_modified: z.string().nullable().optional() }).optional(), effectiveUrl: url.optional() });
const read = { readOnlyHint: true } as const;
interface Context {
  controller: AbortController;
  maintenance: ReturnType<typeof setInterval>;
  work: Promise<QueueResult> | null;
  changed?: () => void;
}
function active(ctx: Context): AbortSignal {
  if (ctx.controller.signal.aborted) throw new Error("scrape_stopping\nScrape is stopping");
  return ctx.controller.signal;
}
async function drain(ctx: Context): Promise<QueueResult> {
  active(ctx);
  if (ctx.work) return ctx.work;
  const work = processQueue({ signal: ctx.controller.signal });
  ctx.work = work;
  try { const result = await work; if (result.processed || result.failed || result.retry_scheduled) ctx.changed?.(); return result; }
  finally { ctx.work = null; }
}
export const api: PackageApi<Context, "scrape_queue_changed"> = {
  operations: [
    operation({ name: "scrape_fetch", description: "Fetch a URL as a bounded extraction envelope. A claimed preset never silently falls back: malformed_provider_output means the content shape or preset output contract changed and the named preset needs review. Browser navigation requires explicit unrestricted egress consent.",
      input: z.strictObject({ url, preset: preset.optional(), generic: z.boolean().optional(), selector: z.string().optional(), media: z.enum(["light", "dark"]).optional(), session: z.string().min(1).max(128).optional(), allowPrivateNetwork: z.boolean().default(false), maxContentBytes: z.number().int().positive().max(5_000_000).optional(), maxRelations: z.number().int().nonnegative().max(2048).optional() }),
      output: envelope, annotations: { openWorldHint: true },
      async call(ctx, input) { return await fetchMarkdown(input.url, { ...input, envelope: true, signal: active(ctx) }) as ExtractionEnvelope; } }),
    operation({ name: "scrape_fetch_file", description: "Extract to an operator-selected local file; can retain sensitive HTML/screenshot evidence for diagnosis. Socket-only: overwrites the destination and may write diagnostic artifacts.",
      input: z.strictObject({ url, destination: z.string().min(1), preset: preset.optional(), generic: z.boolean().optional(), selector: z.string().optional(), media: z.enum(["light", "dark"]).optional(), session: z.string().min(1).max(128).optional(), allowPrivateNetwork: z.boolean().default(false), retainArtifacts: z.boolean().default(false) }),
      output: z.strictObject({ destination: z.string() }),
      async call(ctx, { url, destination, ...options }) {
        const result = await fetchMarkdown(url, { ...options, destination, signal: active(ctx) });
        if ("status" in result) throw new Error("unexpected extraction envelope");
        return { destination };
      } }),
    operation({ name: "scrape_links", description: "Read navigation links or an X timeline through an explicit/automatic preset. Errors on provider drift; no generic fallback for a claimed domain.",
      input: z.strictObject({ url, preset: preset.optional(), sectionSelector: z.string().optional(), categorySelector: z.string().optional(), toggleSelector: z.string().optional(), limit: z.number().int().positive().optional(), maxScrolls: z.number().int().positive().optional(), sinceId: z.string().regex(/^\d+$/).optional(), includeReplies: z.boolean().optional(), includeReposts: z.boolean().optional(), media: z.enum(["light", "dark"]).optional(), session: z.string().min(1).max(128).optional(), allowPrivateNetwork: z.boolean().default(false) }),
      output: safeResult, annotations: { openWorldHint: true },
      async call(ctx, input) {
        try {
          const result = await fetchLinks(input.url, { ...input, signal: active(ctx) });
          return { markdown: result.markdown, structured: structuredJson(result), links: result.links ?? [] };
        } catch (error) {
          if (error instanceof PresetDriftError || error instanceof PresetOutputError)
            throw new Error(`malformed_provider_output\nPreset ${input.preset ?? "matching this URL"} needs update: ${error.message}`);
          throw error;
        }
      } }),
    operation({ name: "scrape_feed_discover", description: "Discover a bounded live public RSS/Atom feed or HTML archive. Conditional validators are bound to the exact effective URL; result includes partial and failure evidence.",
      input: feedOptions.extend({ maxPages: z.number().int().min(1).max(10).optional() }), output: feedResult,
      annotations: { openWorldHint: true }, async call(ctx, input) { return discoverFeedLive({ ...input, signal: active(ctx) }); } }),
    operation({ name: "scrape_feed_parse", description: "Parse recorded feed or archive pages without network access. Responses are supplied as bounded text, never read from ambient file paths.",
      input: z.strictObject({ options: feedOptions.omit({ etag: true, lastModified: true, validatorUrl: true }), initial: recordedPage, pages: z.array(recordedPage).max(100).default([]) }), output: feedResult, annotations: read,
      async call(ctx, input) { active(ctx); return discoverFeed(input.initial, input.options, input.pages); } }),
    operation({ name: "scrape_convert_html", description: "Convert bounded supplied HTML into Markdown offline; writes no files.", input: z.strictObject({ html: z.string().max(8_000_000) }), output: z.strictObject({ markdown: z.string() }), annotations: read,
      async call(ctx, { html }) { active(ctx); return { markdown: convertHtml(html) }; } }),
    operation({ name: "scrape_convert_html_file", description: "Read one regular local HTML file without following a symlink and convert it to Markdown without network access. Socket-only machine path.",
      input: z.strictObject({ path: z.string().min(1) }), output: z.strictObject({ markdown: z.string() }), annotations: read,
      async call(ctx, { path }) { active(ctx); return { markdown: convertHtml(readRegularFileNoFollow(path)) }; } }),
    operation({ name: "scrape_convert_html_directory", description: "Recursively convert a local directory in place using transactional file replacement. Socket-only; mutates operator-selected files.",
      input: z.strictObject({ path: z.string().min(1) }), output: z.strictObject({ converted: z.number().int().nonnegative() }),
      async call(ctx, { path }) { active(ctx); return { converted: convertHtmlDirectory(path) }; } }),
    operation({ name: "scrape_presets_list", description: "List official and isolated AgentStack-local extraction presets, including claimed domains and modes.", input: z.strictObject({}), output: z.strictObject({ presets: z.array(presetRecord) }), annotations: read,
      async call(ctx) { active(ctx); return { presets: loadRegistry().presets }; } }),
    operation({ name: "scrape_preset_show", description: "Inspect one preset's selectors, URL patterns, and output contract.", input: z.strictObject({ name: preset }), output: z.strictObject({ preset: presetRecord.nullable() }), annotations: read,
      async call(ctx, { name }) { active(ctx); return { preset: loadRegistry().byName(name) }; } }),
    operation({ name: "scrape_canary_inventory", description: "List every preset and whether it has a configured live canary. Does not navigate or claim a passing provider.",
      input: z.strictObject({}), output: z.strictObject({ presets: z.array(z.strictObject({ preset: z.string(), configured: z.boolean() })) }), annotations: read,
      async call(ctx) { active(ctx); return { presets: canaryInventory() }; } }),
    operation({ name: "scrape_preset_validate", description: "Validate an operator-supplied local preset file against the exact preset schema. Socket-only: accesses a machine path.",
      input: z.strictObject({ path: z.string().min(1) }), output: z.strictObject({ problems: z.array(z.string()) }), annotations: read,
      async call(ctx, { path }) { active(ctx); return { problems: validatePresetFile(path) }; } }),
    operation({ name: "scrape_corpus_replay", description: "Replay all shipped and AgentStack-local captured preset fixtures offline; failures name the broken preset.",
      input: z.strictObject({ preset: preset.optional() }), output: z.strictObject({ passed: z.number().int(), failed: z.number().int(), lines: z.array(z.string()) }), annotations: read,
      async call(ctx, { preset }) { active(ctx); return testCorpus(preset); } }),
    operation({ name: "scrape_corpus_capture", description: "Capture sensitive provider evidence for one content preset under isolated AgentStack state. Requires explicit browser egress consent; never auto-sanitizes captured raw HTML.",
      input: z.strictObject({ url, preset: preset.optional(), expectFailure: z.string().optional(), allowPrivateNetwork: z.boolean().default(false) }), output: z.strictObject({ path: z.string() }),
      async call(ctx, input) { const path = await captureCorpus(input.url, { ...input, signal: active(ctx) }); return { path }; } }),
    operation({ name: "scrape_presets_check", description: "Run live public canaries. Pass without drift proves only configured samples; not_configured is not success. Requires explicit browser egress consent.",
      input: z.strictObject({ presets: z.array(preset).max(32).optional(), allowPrivateNetwork: z.boolean().default(false) }),
      output: z.strictObject({ checked_at: z.string(), results: z.array(z.object({ preset: z.string(), status: z.enum(["pass", "drift", "operational_failure", "not_configured"]), detail: z.string() })) }),
      async call(ctx, input) { return checkPresets({ ...input, signal: active(ctx) }); } }),
    operation({ name: "scrape_queue_submit", description: "Submit a standalone scrape-to-file job to AgentStack-local queue. Socket-only; output destination is an operator-controlled machine path and is not Brain admission.",
      input: z.strictObject({ url, destination: z.string().min(1), summarize: z.boolean().optional(), frontmatter: z.record(z.string(), z.unknown()).optional(), allowPrivateNetwork: z.boolean().optional() }),
      output: z.strictObject({ path: z.string() }), async call(ctx, { url, destination, ...options }) { active(ctx); const path = submitScrapeJob(url, destination, options); ctx.changed?.(); return { path }; } }),
    operation({ name: "scrape_queue_process", description: "Process ready scrape-to-file records and due retries once; also processed periodically by the owner-managed Scrape child.",
      input: z.strictObject({}), output: z.strictObject({ processed: z.number(), failed: z.number(), retry_scheduled: z.number(), retry_waiting: z.number(), retry_exhausted: z.number() }),
      async call(ctx) { return drain(ctx); } }),
    operation({ name: "scrape_session_open", description: "Open an explicit agent-browser session at about:blank. Socket-only; no authentication is performed.",
      input: z.strictObject({ session: z.string().min(1).max(128) }), output: z.strictObject({ opened: z.literal(true) }),
      async call(ctx, { session }) { active(ctx); requireAgentBrowserSuccess(await runAgentBrowser(["open", "about:blank"], session)); return { opened: true as const }; } }),
    operation({ name: "scrape_session_close", description: "Close an exact operator-selected agent-browser session. Socket-only; do not close a session owned by someone else.",
      input: z.strictObject({ session: z.string().min(1).max(128) }), output: z.strictObject({ closed: z.literal(true) }),
      async call(ctx, { session }) { await closeBrowserSession(session, active(ctx)); return { closed: true as const }; } }),
    operation({ name: "scrape_status", description: "Inspect isolated queue location and optional executable availability without touching providers or browser sessions.",
      input: z.strictObject({}), output: z.strictObject({ stateRoot: z.string(), browser: z.boolean(), github: z.boolean(), pdf: z.boolean(), pandoc: z.boolean(), summary: z.boolean() }), annotations: read,
      async call(ctx) { active(ctx); return { stateRoot: resolveDataHome(), browser: Boolean(findAgentBrowserExecutable()), github: Boolean(findExecutable("gh")), pdf: Boolean(findExecutable("pdftotext")), pandoc: Boolean(findExecutable("pandoc")), summary: Boolean(findExecutable("summaryctl")) }; } }),
  ],
  events: { topics: { scrape_queue_changed: "A scrape-to-file job was submitted or its processing state changed. Re-read scrape_status or inspect the isolated queue." },
    start(ctx, publish) { ctx.changed = () => publish("scrape_queue_changed"); return () => { ctx.changed = undefined; }; } },
  async createContext() {
    const ctx: Context = { controller: new AbortController(), work: null, maintenance: undefined! };
    ctx.maintenance = setInterval(() => { void drain(ctx).catch(() => undefined); }, 60_000);
    ctx.maintenance.unref();
    return ctx;
  },
  async prepareCloseContext(ctx) { ctx.controller.abort(); clearInterval(ctx.maintenance); },
  async closeContext(ctx) { ctx.controller.abort(); clearInterval(ctx.maintenance); await ctx.work?.catch(() => undefined); },
};
