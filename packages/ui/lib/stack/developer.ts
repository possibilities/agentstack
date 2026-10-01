import { relativeTime } from "./derive";
import type { StackState } from "./store";
import type { HarnessRelease, HarnessReleases } from "./types";

/**
 * Developer mode as this page may act on it (ADR 0138): a local page whose open serve connection read the setting as
 * on, with no later failed read. A remote page never reads it; a closed connection or failed read is not authority.
 */
export function developerModeOn(state: Pick<StackState, "remote" | "status" | "serveSettings">): boolean {
  return !state.remote && state.status.serve === "open" && state.serveSettings.error === null && state.serveSettings.data?.developerMode === true;
}

export type ReleaseTone = "success" | "warning" | "destructive" | "muted" | "info";

/**
 * What one harness row says. `label` is the short state; `detail` is the longer line beneath it: a sanitized check
 * diagnostic, or the previous observation when the channel changed. `stale` qualifies a kept version as not current.
 */
export type ReleaseStatus = { label: string; tone: ReleaseTone; detail: string | null; stale: boolean; checking: boolean };

const staleWords: Record<NonNullable<HarnessRelease["staleReason"]>, string> = {
  restart: "since restart",
  expired: "check overdue",
  cache_error: "cache error",
  check_failed: "check failed",
  not_observed: "not observed",
};

/**
 * Classify one observation. A first observation is a baseline ("Observed"), never "up to date"; a later different
 * version is "Changed upstream", which says nothing about what is installed. A kept version after a failure, an
 * interruption or a restart stays visible but is qualified, and a restart never reads as a fresh observation.
 */
export function releaseStatus(row: HarnessRelease, now: number): ReleaseStatus {
  const change = row.changedAt ? `was ${row.previousVersion ?? "unknown"} · ${relativeTime(Date.parse(row.changedAt), now)}` : null;
  const stale = row.version !== null && row.freshness !== "fresh";
  const message = row.error?.message ?? null;
  switch (row.outcome) {
    case "checking":
      return { label: "Checking…", tone: "info", detail: change, stale, checking: true };
    case "interrupted":
      return { label: "Interrupted", tone: "warning", detail: message, stale, checking: false };
    case "failed":
      return row.version !== null
        ? { label: "Stale · check failed", tone: "warning", detail: message, stale: true, checking: false }
        : { label: "Failed", tone: "destructive", detail: message, stale: false, checking: false };
    case "succeeded":
      if (row.version === null || row.freshness === "unobserved") break;
      if (row.freshness === "stale") return { label: row.staleReason ? `Stale · ${staleWords[row.staleReason]}` : "Stale", tone: "warning", detail: change, stale: true, checking: false };
      return row.changedAt
        ? { label: "Changed upstream", tone: "info", detail: change, stale: false, checking: false }
        : { label: "Observed", tone: "success", detail: null, stale: false, checking: false };
    case "not_checked":
      break;
  }
  return { label: "Not checked", tone: "muted", detail: null, stale, checking: false };
}

/** This page's latest Check now: pending until admission settles, then the admission or the refusal. */
export type HarnessCheck = { pending: boolean; admitted: boolean | null; startedAt: string | null; error: string | null };

/** The Developer window's one-line account of how current the observations are. */
export function releasesSummary(releases: StackState["harnessReleases"], check: HarnessCheck | null, now: number): string {
  const at = (value: string) => relativeTime(Date.parse(value), now);
  if (check?.pending) return "Asking the server to start a check…";
  const data = releases.data;
  if (!data) return releases.error ? `Observations unavailable: ${releases.error}` : "Reading cached observations…";
  if (check?.startedAt) return check.admitted ? `Check started ${at(check.startedAt)}` : `Joined the check already running · started ${at(check.startedAt)}`;
  if (data.checking) return `Checking upstream channels · started ${at(data.checking.startedAt)}`;
  return data.lastCompletedAt ? `Last check finished ${at(data.lastCompletedAt)}` : "Not checked yet";
}

/** Whether a snapshot shows the check this page admitted has finished, so the admission note can give way to it. */
export function checkSettled(check: HarnessCheck | null, data: HarnessReleases | null): boolean {
  if (!check?.startedAt || !data || data.checking || !data.lastCompletedAt) return false;
  return Date.parse(data.lastCompletedAt) >= Date.parse(check.startedAt);
}

/** A fixed cadence or limit in its largest whole unit: 21 600 000 → "6 h", 15 000 → "15 s". */
export function periodText(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1_000)} s`;
}

export type SaveProblem = { kind: "conflict" | "failed" | "uncertain"; text: string };

export const settingsConflictText = "Changed elsewhere — showing the current value. Try again if you still want to change it.";

/** Why a developer-mode save did not take: another client saved first, the server refused, or the answer was lost. */
export function settingsSaveProblem(message: string): SaveProblem {
  if (/serve_settings_revision_conflict/.test(message)) return { kind: "conflict", text: settingsConflictText };
  if (/serve_settings_write_failed/.test(message)) return { kind: "failed", text: "Not saved: the server could not store the setting, so nothing changed." };
  if (/connection closed/.test(message)) return { kind: "uncertain", text: "The server connection closed before it answered, so the save may or may not have applied. The setting is read again when it reconnects." };
  return { kind: "failed", text: `Not saved: ${message}` };
}

/** Why Check now did not start a check, in words. */
export function checkProblem(message: string): string {
  if (/developer_mode_disabled/.test(message)) return "Developer mode is off.";
  if (/harness_release_cache_write_failed/.test(message)) return "The release cache could not be saved.";
  return message;
}
