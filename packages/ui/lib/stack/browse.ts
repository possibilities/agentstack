import type { BrowserController, BrowserHandoff, BrowserProfile, BrowserToolchain, BrowserVolume } from "./types";

export type SiteDataCategory = "cookies" | "storage" | "cache";

/** Validate the entered scope before any owner call; never turn a page URL into a wider origin. */
export function siteDataOrigins(text: string): { origins: string[]; error: string | null } {
  const values = text.trim() ? text.trim().split(/\s*\n\s*/) : [];
  if (!values.length || values.length > 50) return { origins: [], error: "Enter 1–50 exact HTTP(S) origins, one per line." };
  const origins: string[] = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if (value.length > 2048 || !/^https?:\/\/[^/?#@\\\s]+$/i.test(value) || url.username || url.password || !url.hostname) throw new Error();
      origins.push(url.origin);
    } catch { return { origins: [], error: "Use exact credential-free HTTP(S) origins, without paths, query strings or fragments." }; }
  }
  return { origins: [...new Set(origins)].sort(), error: null };
}

/** An old selection must not silently include missing, open or already-redacted history. */
export function handoffContentSelection(rows: readonly BrowserHandoff[], ids: readonly string[]): boolean {
  return ids.length > 0 && ids.length <= 100 && new Set(ids).size === ids.length
    && ids.every((id) => !!id && rows.some((row) => row.id === id && row.state === "resolved" && !row.contentClearedAt));
}

export function volumeSelection(rows: readonly BrowserVolume[], ids: readonly string[]): boolean {
  return ids.length > 0 && ids.length <= 100 && new Set(ids).size === ids.length
    && ids.every((id) => !!id && rows.some((row) => row.id === id && row.blockedBy.length === 0));
}

/** Remote Access sessions never receive `browse`: headful browser control stays on the local UI. */
export function browseLocalReason(remote: unknown): string | null {
  return remote ? "Available only on the local UI" : null;
}

export type BrowseCallError = { text: string; uncertain: boolean; stale: boolean };

/**
 * A rejected browse call. A timeout or dropped connection may leave the action running on the
 * socket, so its outcome is unknown: keep the intent for an identical retry, never resend it
 * automatically. A stale revision means someone else acted first.
 */
export function browseCallError(error: unknown): BrowseCallError {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|connection closed/i.test(message)) return { text: `Outcome unknown: ${message}`, uncertain: true, stale: false };
  if (/stale handoff revision/i.test(message)) return { text: "This handoff changed since you looked. Check its state before acting again.", uncertain: false, stale: true };
  return { text: message, uncertain: false, stale: false };
}

export const handoffStates: Record<BrowserHandoff["state"], { label: string; tone: "info" | "warning" | "success" | "muted" | "destructive" }> = {
  preparing: { label: "Draining automation", tone: "muted" },
  awaiting_human: { label: "Waiting for you", tone: "warning" },
  human_controlling: { label: "You have control", tone: "info" },
  returning: { label: "Returning to the Bot", tone: "muted" },
  resolved: { label: "Resolved", tone: "success" },
};

export const handoffOutcomes: Record<NonNullable<BrowserHandoff["outcome"]>, string> = {
  completed: "Completed · reported",
  skipped: "Skipped",
  cancelled: "Cancelled by the Bot",
};

const stateOrder: BrowserHandoff["state"][] = ["awaiting_human", "human_controlling", "returning", "preparing"];

/** Unresolved handoffs grouped by state, oldest first within each; resolved ones newest first. */
export function groupHandoffs(handoffs: readonly BrowserHandoff[]): { open: Array<{ state: BrowserHandoff["state"]; handoffs: BrowserHandoff[] }>; resolved: BrowserHandoff[] } {
  const byAge = (a: BrowserHandoff, b: BrowserHandoff) => Date.parse(a.createdAt) - Date.parse(b.createdAt);
  const open = stateOrder.map((state) => ({ state, handoffs: handoffs.filter((item) => item.state === state).sort(byAge) })).filter((group) => group.handoffs.length);
  const resolved = handoffs.filter((item) => item.state === "resolved").sort((a, b) => Date.parse(b.resolvedAt ?? b.createdAt) - Date.parse(a.resolvedAt ?? a.createdAt));
  return { open, resolved };
}

/** The unresolved handoff holding a profile; there is at most one. */
export function heldBy(profileId: string, handoffs: readonly BrowserHandoff[] | null): BrowserHandoff | null {
  return handoffs?.find((item) => item.profileId === profileId && item.state !== "resolved") ?? null;
}

/** A Bot's handoff that needs a human now: waiting, or under human control. */
export function botHandoff(botId: string, handoffs: readonly BrowserHandoff[] | null): BrowserHandoff | null {
  return handoffs?.find((item) => item.botId === botId && (item.state === "awaiting_human" || item.state === "human_controlling")) ?? null;
}

export function controllerKey(controller: Pick<BrowserController, "botId" | "instance" | "session">): string {
  return `${controller.botId}/${controller.instance}/${controller.session}`;
}

/** Profile display name: its label, else a short ID. */
export function profileName(profile: Pick<BrowserProfile, "id" | "label"> | null | undefined, id?: string): string {
  return profile?.label || (profile?.id ?? id ?? "").slice(0, 8) || "profile";
}

/** Why a profile cannot be deleted, mirroring the API's refusals; null when deletion may proceed. */
export function deleteBlock(profile: BrowserProfile, controllers: readonly BrowserController[] | null, handoffs: readonly BrowserHandoff[] | null): string | null {
  if (profile.default && profile.botId) return "A Bot's default profile can't be deleted";
  if (heldBy(profile.id, handoffs)) return "A handoff holds this profile";
  if (controllers?.some((item) => item.profileId === profile.id || item.actualProfileId === profile.id)) return "A controller has this profile selected";
  return null;
}

/** Profiles grouped by owning Bot (numeric order), then unassigned; defaults first within each. */
export function groupProfiles(profiles: readonly BrowserProfile[]): Array<{ botId: string | null; profiles: BrowserProfile[] }> {
  const groups = new Map<string | null, BrowserProfile[]>();
  for (const profile of profiles) groups.set(profile.botId, [...(groups.get(profile.botId) ?? []), profile]);
  const order = (profile: BrowserProfile) => (profile.default ? 0 : 1);
  return [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, undefined, { numeric: true })))
    .map(([botId, list]) => ({ botId, profiles: list.sort((x, y) => order(x) - order(y) || x.createdAt.localeCompare(y.createdAt)) }));
}

export type HandoffArgs = { id: string; expectedRevision: number; requestId: string; outcome?: "completed" | "skipped"; note?: string };
/** One intended take or finish, with the exact arguments an identical retry must resend. */
export type HandoffIntent = { kind: "take" | "finish"; args: HandoffArgs };

const intentKey = (handoffId: string) => `stack.uix.browse.intent.${handoffId}`;

export function loadIntent(storage: Pick<Storage, "getItem"> | null, handoffId: string): HandoffIntent | null {
  try {
    const value = JSON.parse(storage?.getItem(intentKey(handoffId)) ?? "null") as HandoffIntent | null;
    return value && (value.kind === "take" || value.kind === "finish") && value.args?.id === handoffId && typeof value.args.requestId === "string" ? value : null;
  } catch { return null; }
}

export function saveIntent(storage: Pick<Storage, "setItem" | "removeItem"> | null, intent: HandoffIntent | null, handoffId: string): void {
  try {
    if (intent) storage?.setItem(intentKey(handoffId), JSON.stringify(intent));
    else storage?.removeItem(intentKey(handoffId));
  } catch { /* optional persistence: losing it only loses an identical retry */ }
}

/**
 * The arguments for an action. A stored intent of the same kind and choice is reused unchanged,
 * which is how the API recognises a retry: when its revision still matches, when the page's own
 * take already moved the handoff to human control, or when its finish is still returning.
 */
export function intentFor(kind: "take" | "finish", handoff: BrowserHandoff, stored: HandoffIntent | null, choice: { outcome?: "completed" | "skipped"; note?: string }, mint: () => string): HandoffIntent {
  const note = choice.note?.trim() || undefined;
  if (stored && stored.kind === kind && stored.args.outcome === choice.outcome && stored.args.note === note) {
    const retry = stored.args.expectedRevision === handoff.revision
      || (kind === "take" && handoff.state === "human_controlling")
      || (kind === "finish" && (handoff.state === "returning" || handoff.state === "resolved"));
    if (retry) return stored;
  }
  const args: HandoffArgs = { id: handoff.id, expectedRevision: handoff.revision, requestId: mint() };
  if (kind === "finish") { args.outcome = choice.outcome; if (note) args.note = note; }
  return { kind, args };
}

/** Human-readable reasons the Browse space needs attention. */
export function browseAttention(handoffs: readonly BrowserHandoff[] | null, profiles: readonly BrowserProfile[] | null, toolchain: BrowserToolchain | null): string[] {
  const reasons: string[] = [];
  for (const item of handoffs ?? []) {
    if (item.state === "awaiting_human") reasons.push(`${item.botId} needs browser help`);
    if (item.state !== "resolved" && item.issue) reasons.push(`${item.botId} handoff: ${item.issue}`);
  }
  for (const profile of profiles ?? []) if (profile.state === "failed") reasons.push(`${profileName(profile)} browser failed`);
  if (toolchain && !toolchain.hypeman.some((item) => item.selected)) reasons.push("No local Hypeman selected");
  return reasons;
}
