import { join } from "node:path";
import { stateDir } from "@stack/api";
import { z } from "zod";
import { harnessReleaseIntervalMs, harnessReleaseMaxBytes, harnessReleaseTimeoutMs, retainedRelease, serveSettings,
  type HarnessId, type HarnessReleaseError, type HarnessReleases, type RetainedRelease, type ServeSettings } from "./schema.js";
import { observeRelease, releaseProblem, releaseSources } from "./sources.js";
import { readState, writeState } from "./storage.js";

const settingsFile = serveSettings.extend({ schemaVersion: z.literal(1) });
const cacheFile = z.strictObject({ schemaVersion: z.literal(1), lastAttemptAt: z.iso.datetime().nullable(), lastCompletedAt: z.iso.datetime().nullable(),
  observations: z.array(retainedRelease).length(4).refine(rows => new Set(rows.map(row => row.id)).size === 4) });
type Cache = z.infer<typeof cacheFile>;
type Check = { controller: AbortController; startedAt: string };
const emptyRow = (id: HarnessId): RetainedRelease => ({ id, version: null, previousVersion: null, changedAt: null, lastAttemptAt: null,
  lastCompletedAt: null, lastSuccessAt: null, outcome: "not_checked", error: null });

/** Global operator settings and one server-owned, no-turn release observer. */
export class DeveloperService {
  private readonly settingsPath: string;
  private readonly cachePath: string;
  private saved: ServeSettings;
  private cache: Cache;
  private cacheError: HarnessReleaseError | null = null;
  private readonly verified = new Set<HarnessId>();
  private active: Check | undefined;
  private readonly pending = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private closed = false;
  onSettingsChange: (() => void) | undefined;
  onReleasesChange: (() => void) | undefined;

  constructor(env: NodeJS.ProcessEnv) {
    this.settingsPath = join(stateDir(env), "serve", "settings.json");
    this.cachePath = join(stateDir(env), "serve", "harness-releases.json");
    try {
      const stored = readState(this.settingsPath, settingsFile);
      this.saved = stored ? { developerMode: stored.developerMode, revision: stored.revision, updatedAt: stored.updatedAt } : { developerMode: false, revision: 0, updatedAt: null };
    } catch { throw new Error("serve_settings_invalid: global settings could not be read or validated"); }
    this.cache = { schemaVersion: 1, lastAttemptAt: null, lastCompletedAt: null, observations: releaseSources.map(source => emptyRow(source.id)) };
    try { this.cache = readState(this.cachePath, cacheFile) ?? this.cache; }
    catch { this.cacheError = releaseProblem("cache_read_failed"); }
    for (const row of this.cache.observations) if (row.outcome === "checking") {
      row.outcome = "interrupted"; row.error = releaseProblem("interrupted");
    }
  }

  settings(): ServeSettings { return { ...this.saved }; }

  update(input: { developerMode: boolean; expectedRevision: number }): ServeSettings {
    if (this.closed) throw new Error("developer_service_closed");
    if (input.expectedRevision !== this.saved.revision) throw new Error("serve_settings_revision_conflict: read settings before retrying");
    if (input.developerMode === this.saved.developerMode) return this.settings();
    const saved = { developerMode: input.developerMode, revision: this.saved.revision + 1, updatedAt: new Date().toISOString() };
    try { writeState(this.settingsPath, { schemaVersion: 1, ...saved }); }
    catch { throw new Error("serve_settings_write_failed: settings were not applied"); }
    this.saved = saved;
    if (!saved.developerMode) this.interrupt();
    this.notify(this.onSettingsChange);
    this.schedule();
    return this.settings();
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule();
  }

  snapshot(): HarnessReleases {
    this.requireEnabled();
    const now = Date.now();
    return { checking: this.active ? { startedAt: this.active.startedAt } : null,
      intervalMs: harnessReleaseIntervalMs, timeoutMs: harnessReleaseTimeoutMs, maxResponseBytes: harnessReleaseMaxBytes,
      lastAttemptAt: this.cache.lastAttemptAt, lastCompletedAt: this.cache.lastCompletedAt,
      nextCheckAt: this.started && !this.closed ? new Date(this.dueAt()).toISOString() : null,
      cacheError: this.cacheError ? { ...this.cacheError } : null,
      observations: releaseSources.map(source => {
        const row = this.cache.observations.find(row => row.id === source.id)!;
        const staleReason = !row.version ? "not_observed" as const : this.cacheError ? "cache_error" as const
          : row.error ? "check_failed" as const : !this.verified.has(row.id) ? "restart" as const
          : !row.lastSuccessAt || now < Date.parse(row.lastSuccessAt) || now - Date.parse(row.lastSuccessAt) >= harnessReleaseIntervalMs ? "expired" as const : null;
        return { ...structuredClone(row), ...source, freshness: !row.version ? "unobserved" as const : staleReason ? "stale" as const : "fresh" as const, staleReason };
      }) };
  }

  check(): { admitted: boolean; startedAt: string } {
    this.requireEnabled();
    if (this.closed) throw new Error("developer_service_closed");
    if (this.active) return { admitted: false, startedAt: this.active.startedAt };
    clearTimeout(this.timer); this.timer = undefined;
    const startedAt = new Date().toISOString();
    this.cache.lastAttemptAt = startedAt;
    for (const row of this.cache.observations) { row.lastAttemptAt = startedAt; row.outcome = "checking"; }
    // Persist admission before networking, so restart observes interruption and keeps cadence.
    if (!this.persist()) {
      for (const row of this.cache.observations) { row.outcome = "failed"; row.error = releaseProblem("cache_write_failed"); }
      this.notify(this.onReleasesChange); this.schedule();
      throw new Error("harness_release_cache_write_failed: check was not started");
    }
    const check: Check = { controller: new AbortController(), startedAt };
    this.active = check;
    this.notify(this.onReleasesChange);
    const task = this.capture(check);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return { admitted: true, startedAt };
  }

  private async capture(check: Check): Promise<void> {
    await Promise.all(releaseSources.map(async source => {
      const result = await observeRelease(source, check.controller.signal);
      // Disable, close and a subsequent enable/check cannot accept an old completion.
      if (this.active !== check || !this.saved.developerMode || this.closed) return;
      const row = this.cache.observations.find(row => row.id === source.id)!;
      row.lastCompletedAt = new Date().toISOString();
      row.error = result.error;
      row.outcome = result.error ? "failed" : "succeeded";
      if (result.version !== null) {
        if (row.version !== null && row.version !== result.version) { row.previousVersion = row.version; row.changedAt = row.lastCompletedAt; }
        row.version = result.version; row.lastSuccessAt = row.lastCompletedAt;
        this.verified.add(row.id);
      }
      this.persist();
      this.notify(this.onReleasesChange);
    }));
    if (this.active !== check) return;
    this.active = undefined;
    this.cache.lastCompletedAt = new Date().toISOString();
    this.persist();
    this.notify(this.onReleasesChange);
    this.schedule();
  }

  private requireEnabled(): void { if (!this.saved.developerMode) throw new Error("developer_mode_disabled"); }
  private dueAt(): number {
    const now = Date.now(), last = this.cache.lastAttemptAt === null ? null : Date.parse(this.cache.lastAttemptAt);
    // A backwards wall-clock jump must not suppress observations indefinitely.
    return last === null || last > now ? now : last + harnessReleaseIntervalMs;
  }
  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.started || this.closed || !this.saved.developerMode || this.active) return;
    const delay = Math.max(0, this.dueAt() - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.check(); } catch { /* Admission records storage failure and schedules the next bounded attempt. */ }
    }, delay);
    this.timer.unref();
  }
  private persist(): boolean {
    try { writeState(this.cachePath, this.cache); this.cacheError = null; return true; }
    catch { this.cacheError = releaseProblem("cache_write_failed"); return false; }
  }
  private interrupt(): void {
    clearTimeout(this.timer); this.timer = undefined;
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.controller.abort();
    const at = new Date().toISOString();
    for (const row of this.cache.observations) if (row.outcome === "checking") {
      row.outcome = "interrupted"; row.error = releaseProblem("interrupted"); row.lastCompletedAt = at;
    }
    this.cache.lastCompletedAt = at;
    this.persist();
    this.notify(this.onReleasesChange);
  }
  private notify(callback: (() => void) | undefined): void { try { callback?.(); } catch { /* Publication cannot discard state or stop recurrence. */ } }

  async close(): Promise<void> {
    this.closed = true;
    this.interrupt();
    await Promise.all(this.pending);
    this.onSettingsChange = undefined; this.onReleasesChange = undefined;
  }
}
