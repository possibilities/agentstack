import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

// Load the pure stack modules directly without a Next build. Their
// bundler-style imports need extensions when loaded by Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { checkProblem, checkSettled, developerModeOn, periodText, releasesSummary, releaseStatus, settingsConflictText, settingsSaveProblem } = await import("../lib/stack/developer.ts");

const now = Date.parse("2026-10-01T12:00:00.000Z");
const ago = (ms) => new Date(now - ms).toISOString();
const failure = { code: "network_error", message: "The public release channel could not be reached." };
const row = (extra = {}) => ({ id: "codex", title: "Codex", sourceUrl: "https://registry.npmjs.org/@openai/codex/latest", packageName: "@openai/codex", channel: "npm-latest",
  version: null, previousVersion: null, changedAt: null, lastAttemptAt: null, lastCompletedAt: null, lastSuccessAt: null,
  outcome: "not_checked", error: null, freshness: "unobserved", staleReason: null, ...extra });
const status = (extra) => releaseStatus(row(extra), now);

test("each outcome and freshness reads as one distinct state, and a kept version is qualified rather than hidden", () => {
  assert.deepEqual(status({}), { label: "Not checked", tone: "muted", detail: null, stale: false, checking: false });
  assert.deepEqual(status({ outcome: "checking" }), { label: "Checking…", tone: "info", detail: null, stale: false, checking: true });

  // The first success is a baseline; a later different version is a channel change with the previous one beside it.
  const seen = { version: "0.50.0", lastSuccessAt: ago(60_000), outcome: "succeeded", freshness: "fresh" };
  assert.deepEqual(status(seen), { label: "Observed", tone: "success", detail: null, stale: false, checking: false });
  assert.deepEqual(status({ ...seen, previousVersion: "0.49.0", changedAt: ago(3 * 3_600_000) }),
    { label: "Changed upstream", tone: "info", detail: "was 0.49.0 · 3h ago", stale: false, checking: false });

  // Retained successes that are not fresh say why, and keep any change evidence.
  assert.equal(status({ ...seen, freshness: "stale", staleReason: "restart" }).label, "Stale · since restart");
  assert.equal(status({ ...seen, freshness: "stale", staleReason: "expired" }).label, "Stale · check overdue");
  assert.equal(status({ ...seen, freshness: "stale", staleReason: "cache_error" }).label, "Stale · cache error");
  assert.deepEqual(status({ ...seen, freshness: "stale", staleReason: "restart", previousVersion: "0.49.0", changedAt: ago(86_400_000) }),
    { label: "Stale · since restart", tone: "warning", detail: "was 0.49.0 · 1d ago", stale: true, checking: false });

  // A failure after a good observation keeps the value as stale; one with no observation is a plain failure. Each shows its own message.
  assert.deepEqual(status({ ...seen, outcome: "failed", error: failure, freshness: "stale", staleReason: "check_failed" }),
    { label: "Stale · check failed", tone: "warning", detail: failure.message, stale: true, checking: false });
  assert.deepEqual(status({ outcome: "failed", error: { code: "rate_limited", message: "Rate limited." } }),
    { label: "Failed", tone: "destructive", detail: "Rate limited.", stale: false, checking: false });

  const interrupted = { code: "interrupted", message: "The check was interrupted by disable, shutdown or restart; any last good release is retained." };
  assert.deepEqual(status({ ...seen, outcome: "interrupted", error: interrupted, freshness: "stale", staleReason: "check_failed" }),
    { label: "Interrupted", tone: "warning", detail: interrupted.message, stale: true, checking: false });
  assert.deepEqual(status({ outcome: "interrupted", error: interrupted }), { label: "Interrupted", tone: "warning", detail: interrupted.message, stale: false, checking: false });

  // A check in progress over a stale value keeps it qualified and keeps the change evidence, not the previous error.
  assert.deepEqual(status({ ...seen, outcome: "checking", error: failure, freshness: "stale", staleReason: "check_failed", previousVersion: "0.49.0", changedAt: ago(7_200_000) }),
    { label: "Checking…", tone: "info", detail: "was 0.49.0 · 2h ago", stale: true, checking: true });
});

test("across every outcome, freshness and evidence combination, only a fresh success reads as current and nothing claims an install", () => {
  const forbidden = /update available|installed|up to date|upgrade/i;
  for (const outcome of ["not_checked", "checking", "succeeded", "failed", "interrupted"])
    for (const freshness of ["unobserved", "fresh", "stale"])
      for (const staleReason of [null, "not_observed", "restart", "check_failed", "expired", "cache_error"])
        for (const version of [null, "2.0.14"])
          for (const changedAt of [null, ago(60_000)])
            for (const error of [null, failure]) {
              const state = status({ outcome, freshness, staleReason, version, changedAt, previousVersion: changedAt ? "2.0.13" : null, error });
              const text = `${state.label} ${state.detail ?? ""}`;
              assert.doesNotMatch(text, forbidden, text);
              if (["Observed", "Changed upstream"].includes(state.label)) assert.ok(outcome === "succeeded" && freshness === "fresh" && version !== null, text);
              if (state.label.startsWith("Stale")) assert.ok(version !== null && state.stale, text);
              if (state.stale) assert.notEqual(state.label, "Observed");
              if (version === null) assert.equal(state.stale, false, "nothing to qualify without a value");
            }
});

test("the window summary follows admission, joining and settlement without claiming completion", () => {
  const releases = (data) => ({ data, error: null, at: 1 });
  const snapshot = (extra = {}) => ({ checking: null, intervalMs: 21_600_000, timeoutMs: 15_000, maxResponseBytes: 262_144, lastAttemptAt: null, lastCompletedAt: null,
    nextCheckAt: null, cacheError: null, observations: [], ...extra });
  const started = ago(2_000);
  assert.equal(releasesSummary(releases(null), null, now), "Reading cached observations…");
  assert.equal(releasesSummary({ data: null, error: "developer_mode_disabled", at: 1 }, null, now), "Observations unavailable: developer_mode_disabled");
  assert.equal(releasesSummary(releases(snapshot()), { pending: true, admitted: null, startedAt: null, error: null }, now), "Asking the server to start a check…");
  assert.equal(releasesSummary(releases(snapshot({ checking: { startedAt: started } })), { pending: false, admitted: true, startedAt: started, error: null }, now), "Check started just now");
  assert.equal(releasesSummary(releases(snapshot({ checking: { startedAt: ago(90_000) } })), { pending: false, admitted: false, startedAt: ago(90_000), error: null }, now),
    "Joined the check already running · started 1m ago");
  assert.equal(releasesSummary(releases(snapshot({ checking: { startedAt: ago(90_000) } })), null, now), "Checking upstream channels · started 1m ago");
  assert.equal(releasesSummary(releases(snapshot({ lastCompletedAt: ago(120_000) })), null, now), "Last check finished 2m ago");
  assert.equal(releasesSummary(releases(snapshot()), null, now), "Not checked yet");

  const check = { pending: false, admitted: true, startedAt: started, error: null };
  assert.equal(checkSettled(check, snapshot({ checking: { startedAt: started } })), false, "still running");
  assert.equal(checkSettled(check, snapshot({ lastCompletedAt: ago(60_000) })), false, "a snapshot from before the admitted check");
  assert.equal(checkSettled(check, snapshot({ lastCompletedAt: ago(1_000) })), true);
  assert.equal(checkSettled({ ...check, startedAt: null, error: "developer_mode_disabled" }, snapshot({ lastCompletedAt: ago(1_000) })), false, "a refusal is not a check");
});

test("fixed limits, settings authority and refusal texts", () => {
  assert.equal(periodText(21_600_000), "6 h");
  assert.equal(periodText(15_000), "15 s");
  assert.equal(periodText(90_000), "90 s");
  const local = { remote: undefined, status: { serve: "open" }, serveSettings: { data: { developerMode: true, revision: 1, updatedAt: ago(0) }, error: null, at: 1 } };
  assert.equal(developerModeOn(local), true);
  assert.equal(developerModeOn({ ...local, status: { serve: "closed" } }), false, "a closed connection is not authority");
  assert.equal(developerModeOn({ ...local, serveSettings: { ...local.serveSettings, error: "read failed" } }), false, "nor is a failed read");
  assert.equal(developerModeOn({ ...local, remote: { scope: "control", scopes: [], contentOrigins: {} } }), false, "remote pages never use it");
  assert.equal(developerModeOn({ ...local, serveSettings: { data: null, error: null, at: null } }), false, "unknown is not on");
  assert.deepEqual(settingsSaveProblem("serve_settings_revision_conflict: read settings before retrying"), { kind: "conflict", text: settingsConflictText });
  assert.equal(settingsSaveProblem("serve_settings_write_failed: settings were not applied").kind, "failed");
  assert.equal(settingsSaveProblem("connection closed").kind, "uncertain", "a lost answer may still have saved");
  assert.equal(checkProblem("harness_release_cache_write_failed: check was not started"), "The release cache could not be saved.");
  assert.equal(checkProblem("developer_mode_disabled"), "Developer mode is off.");
});
