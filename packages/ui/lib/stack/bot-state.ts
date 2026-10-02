import { stateOperations, type StateOperations } from "./state";
import type { StateEntry, StateFile, StateFileRead } from "./types";

/**
 * A Bot's owner state (`bot_state_read` and its detailed reads) and its maintenance actions (docs/state-control.md,
 * ADR 0135). Everything a view holds is keyed by the Bot incarnation, so a reused Bot ID never shows old data.
 */

export type BotStateRead = { incarnation: string; generation: string; maintenanceRequestId: string | null; entries: StateEntry[] };
export type BotHistoryGeneration = { generation: string; mainThreadId: string | null; active: boolean; ownership: "stack" | "shared"; createdAt: string; retiredAt: string | null; purgedAt: string | null };
export type BotQueueEntry = { id: string; threadId: string; state: "pending" | "dispatching" | "sent" | "unknown" | "cancelled"; bytes: number;
  admissionDigest: string; generation: string | null; contentClearedAt: string | null };
export type BotLaunch = { count: number; revision: string; arguments: string[] | null; roleId: string | null; roleRevision: number | null; running: boolean };
export type BotUpload = { botId: string; id: string; name: string; bytes: number; sha256: string; offset: number; path: string | null };

export type BotStateAction =
  | { kind: "workspace_clear"; selection: { all: true } | { paths: string[] } }
  | { kind: "session_reset"; history: "retain" | "purge" }
  | { kind: "history_clear"; generation: string }
  | { kind: "log_clear" }
  | { kind: "launch_args_clear" }
  | { kind: "upload_remove"; uploadId: string }
  | { kind: "recovery_discard"; directory: string }
  | { kind: "queue_bodies_clear"; selection: { ids: string[] } | { generation: string } };

/** The Bot's own plan, apply (`bot_<kind>`) and receipt operations for one exact action. Every apply carries `botId`. */
export function botStateOperations(call: <T>(pkg: string, name: string, args?: Record<string, unknown>) => Promise<T>, botId: string, action: BotStateAction): StateOperations<{ botId: string }> {
  return stateOperations<{ botId: string }>(call, "bots", { plan: "bot_state_plan", apply: `bot_${action.kind}`, receipt: "bot_state_receipt_get" }, { botId, action });
}

/**
 * One recovery slot per incarnation and decision; a reused Bot ID has another incarnation and so no old receipt. Queue
 * selections have one slot each for exact IDs and for a retired generation: the selection is frozen while a flow is past
 * idle, so a retained receipt is always shown for the decision that made it, even after a reload.
 */
export function botStateKey(incarnation: string, action: BotStateAction): string {
  const detail = action.kind === "workspace_clear" ? ("all" in action.selection ? ":all" : ":paths") : action.kind === "history_clear" ? `:${action.generation}` : action.kind === "upload_remove" ? `:${action.uploadId}` : action.kind === "recovery_discard" ? `:${action.directory}`
    : action.kind === "queue_bodies_clear" ? ("ids" in action.selection ? ":ids" : ":generation") : "";
  return `bots:${incarnation}:${action.kind}${detail}`;
}

export { firstPage, nextPage, type Page, type PageRead } from "./state";

/** Optional stores answer `revision: "absent"` when never created: empty, not unavailable. */
export const absentStore = (page: { revision: string }) => page.revision === "absent";

export type Preview = { kind: "text"; text: string } | { kind: "binary" };

/**
 * Decode one chunk for display as plain text only. NUL bytes or invalid UTF-8 are shown as binary metadata; nothing
 * is ever interpreted as HTML. A chunk boundary may split a multi-byte character, so a trailing partial one is allowed.
 */
export function decodeChunk(read: Pick<StateFileRead, "data">): Preview {
  const binary = atob(read.data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.includes(0)) return { kind: "binary" };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }) };
  } catch { return { kind: "binary" }; }
}

/** A partial filesystem cleanup retains its selection here for inspection. */
export const quarantined = (file: Pick<StateFile, "path">) => /(^|\/)\.stack-clear-[0-9a-f-]{36}$/.test(file.path);

export const fileName = (path: string) => path.split("/").at(-1) ?? path;
export const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";

/** Toggle one path; a path inside an already selected directory is covered by it, so it cannot be selected too. */
export function toggleSelection(selected: readonly string[], path: string): string[] {
  if (selected.includes(path)) return selected.filter((item) => item !== path);
  return [...selected.filter((item) => !item.startsWith(`${path}/`)), path].sort();
}
export const coveredBy = (selected: readonly string[], path: string) => selected.find((item) => path.startsWith(`${item}/`)) ?? null;

export function botEntry(state: BotStateRead | null, category: "workspace" | "conversation" | "queue" | "uploads" | "launch" | "log" | "recovery"): StateEntry | null {
  return state?.entries.find((entry) => entry.id.endsWith(`:${category}`)) ?? null;
}

/** Only a ledger-owned workspace carries Stack deletion authority; a supplied cwd is read-only here. */
export const workspaceOwned = (state: BotStateRead | null) => botEntry(state, "workspace")?.ownership === "stack";

/**
 * The cleanup blockers `bot_state_read` reports for this Bot (Bot lifecycle and Worker, Browse, Proc and Serve
 * dependencies), from any maintenance action link. An unavailable owner is a blocker, never an empty answer.
 */
export function botBlockers(state: BotStateRead | null): string[] {
  const conversation = botEntry(state, "conversation");
  return conversation?.actions[0]?.blockedBy ?? [];
}

/** Retired, Stack-owned and not yet purged: the only generations a separate history clear can select. */
export function purgeable(generation: BotHistoryGeneration): boolean {
  return !generation.active && generation.ownership === "stack" && !generation.purgedAt;
}

/** One queue-body plan selects at most this many exact entries. */
export const queueBodyLimit = 100;

/**
 * Why one entry cannot be selected for an exact-ID queue-body plan, or null when it can. Pending and dispatching entries
 * block the plan until they are cancelled or reconciled, and a cleared body has nothing left to clear. An unknown
 * admission is clearable but stays unknown: it is never a retry hint.
 */
export function queueUnclearable(entry: Pick<BotQueueEntry, "state" | "contentClearedAt">): string | null {
  if (entry.contentClearedAt) return "Body already cleared";
  if (entry.state === "pending" || entry.state === "dispatching") return "Pending and dispatching entries block body cleanup. Cancel or reconcile it first.";
  return null;
}

/** Generations a queue-body plan can name: retired ones of this incarnation. The active generation never qualifies. */
export const retiredGenerations = (rows: readonly BotHistoryGeneration[]): BotHistoryGeneration[] => rows.filter((row) => !row.active && row.retiredAt !== null);

export const queueWords: Record<BotQueueEntry["state"], string> = {
  pending: "Waiting to send", dispatching: "Sending now", sent: "Admitted to Codex", cancelled: "Cancelled; never sent",
  unknown: "Admission unknown. This is not a retry hint: the input may already be in the conversation.",
};
