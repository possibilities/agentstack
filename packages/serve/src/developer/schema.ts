import { z } from "zod";

export const harnessReleaseIntervalMs = 6 * 60 * 60 * 1000;
export const harnessReleaseTimeoutMs = 15_000;
export const harnessReleaseMaxBytes = 256 * 1024;
export const harnessId = z.enum(["opencode", "codex", "claude", "devin"]);
export type HarnessId = z.infer<typeof harnessId>;
const at = z.iso.datetime().nullable();
// Accept release identifiers, never provider text, URLs, HTML or control characters.
export const releaseVersion = z.string().max(100).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
export const serveSettings = z.strictObject({
  developerMode: z.boolean().describe("Default false. Enables developer-only release reads and checks, and the server-owned periodic observer."),
  revision: z.number().int().nonnegative().describe("Optimistic revision; zero until the first saved change."),
  updatedAt: at,
});
export type ServeSettings = z.infer<typeof serveSettings>;
export const harnessReleaseError = z.strictObject({
  code: z.enum(["timeout", "network_error", "http_error", "rate_limited", "response_too_large", "invalid_response", "interrupted", "cache_read_failed", "cache_write_failed"]),
  message: z.string().describe("Sanitized diagnostic; never raw provider content or exception text."),
});
export type HarnessReleaseError = z.infer<typeof harnessReleaseError>;
export const retainedRelease = z.strictObject({
  id: harnessId,
  version: releaseVersion.nullable().describe("Last successfully observed upstream channel release. Not an installed version or Stack fork pin."),
  previousVersion: releaseVersion.nullable().describe("Immediately preceding different observed version; null until a change has been observed."),
  changedAt: at.describe("When a different version was first observed; null for the initial observation. Channel changes need not be upgrades."),
  lastAttemptAt: at,
  lastCompletedAt: at,
  lastSuccessAt: at,
  outcome: z.enum(["not_checked", "checking", "succeeded", "failed", "interrupted"]),
  error: harnessReleaseError.nullable(),
});
export type RetainedRelease = z.infer<typeof retainedRelease>;
export const harnessReleases = z.strictObject({
  checking: z.strictObject({ startedAt: z.iso.datetime() }).nullable(),
  intervalMs: z.literal(harnessReleaseIntervalMs),
  timeoutMs: z.literal(harnessReleaseTimeoutMs),
  maxResponseBytes: z.literal(harnessReleaseMaxBytes),
  lastAttemptAt: at,
  lastCompletedAt: at,
  nextCheckAt: at.describe("Next scheduled attempt while this server is running; missed intervals coalesce into one check."),
  cacheError: harnessReleaseError.nullable().describe("A retained-cache read/write failure. In-memory observations can be newer than persisted state."),
  observations: z.array(retainedRelease.extend({
    title: z.string(),
    sourceUrl: z.url().describe("Fixed authoritative public channel checked for this harness."),
    packageName: z.string().nullable().describe("Validated npm package identity; null for the Devin manifest."),
    channel: z.enum(["npm-latest", "devin-current"]),
    freshness: z.enum(["unobserved", "fresh", "stale"]),
    staleReason: z.enum(["not_observed", "restart", "check_failed", "expired", "cache_error"]).nullable(),
  })),
});
export type HarnessReleases = z.infer<typeof harnessReleases>;
