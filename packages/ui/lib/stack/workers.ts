import { shortId } from "./derive";
import type { WorkerEventReceipt, WorkerListItem, WorkerSession, WorkerTool, WorkerTranscriptEntry, WorkerTurn } from "./types";

/** worker_list's `botId` for Workers the local operator started rather than a Bot. */
export const localOperator = "_local_operator";

export function workerOrigin(botId: string): string {
  return botId === localOperator ? "Operator" : botId;
}

/** Workers take no durable ordinal; one is named by its repository and short ID. */
export function workerLabel(worker: Pick<WorkerSession, "id" | "repo">): string {
  const name = worker.repo.replace(/\/+$/, "").split("/").pop() || worker.repo;
  return `${name} · ${shortId(worker.id, 6)}`;
}

export type WorkerGroup = "attention" | "running" | "idle" | "closed";

export const workerGroups: Array<{ id: WorkerGroup; title: string }> = [
  { id: "attention", title: "Needs attention" },
  { id: "running", title: "Running" },
  { id: "idle", title: "Idle" },
  { id: "closed", title: "Closed" },
];

/**
 * Why a Worker is worth a look, from worker_list alone; null when it is not.
 * Its Bot, not the UI, answers permissions and recovers it.
 */
export function workerAttention(worker: Pick<WorkerSession, "phase" | "issue"> & { pendingPermissions?: number }): string | null {
  const pending = worker.pendingPermissions ?? 0;
  if (pending > 1 && worker.phase !== "closed") return `Waiting for its Bot to answer ${pending} permission requests`;
  switch (worker.phase) {
    case "awaiting_input": return "Waiting for its Bot to answer a permission request";
    case "needs_recovery": return worker.issue ?? "Needs recovery";
    case "failed": return worker.issue ?? "Failed";
    default: return null;
  }
}

/**
 * A turn whose outcome is unknown stays so until a later turn, even after its Bot
 * has inspected the worktree and resumed, so it is a note rather than attention.
 */
export function workerNote(worker: Pick<WorkerListItem, "phase" | "turn">): string | null {
  return worker.phase !== "closed" && worker.turn?.phase === "unknown" ? "Last turn outcome unknown" : null;
}

export function workerGroup(worker: Pick<WorkerSession, "phase" | "issue">): WorkerGroup {
  if (workerAttention(worker)) return "attention";
  if (worker.phase === "closed") return "closed";
  if (worker.phase === "idle") return "idle";
  return "running";
}

export type WorkerFilter = { botId?: string; accountId?: string };

export function filterWorkers<T extends WorkerSession>(workers: T[], filter: WorkerFilter): T[] {
  return workers.filter((worker) => (!filter.botId || worker.botId === filter.botId) && (!filter.accountId || worker.accountId === filter.accountId));
}

/** Workers by group, most recently updated first. */
export function groupWorkers<T extends WorkerSession>(workers: T[]): Map<WorkerGroup, T[]> {
  const groups = new Map<WorkerGroup, T[]>(workerGroups.map(({ id }) => [id, []]));
  for (const worker of [...workers].sort((a, b) => b.updatedAt - a.updatedAt)) groups.get(workerGroup(worker))!.push(worker);
  return groups;
}

export type PlanEntry = { content: string; status: string | null; priority: string | null };

export type ConversationItem =
  | { kind: "user" | "agent" | "event" | "turn" | "notice" | "other"; key: string; text: string; at: number }
  | { kind: "tool"; key: string; title: string; status: string | null; updates: number; at: number }
  | { kind: "plan"; key: string; entries: PlanEntry[] | null; text: string; at: number };

export type ConversationTurn = { turnId: string; items: ConversationItem[] };

const toolStatuses = new Set(["pending", "in_progress", "completed", "failed"]);

/** The Worker writes a tool line as `title · status`; a missing title falls back to the tool call ID. */
export function parseToolLine(text: string, tools?: ReadonlyMap<string, WorkerTool>): { title: string; status: string | null } {
  const split = text.lastIndexOf(" · ");
  const status = split > 0 && toolStatuses.has(text.slice(split + 3)) ? text.slice(split + 3) : null;
  const title = status ? text.slice(0, split) : text;
  return { title: tools?.get(title)?.title ?? title, status };
}

export function parsePlan(text: string): PlanEntry[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return null;
    return value.map((entry) => {
      const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      return {
        content: typeof record.content === "string" ? record.content : JSON.stringify(entry),
        status: typeof record.status === "string" ? record.status : null,
        priority: typeof record.priority === "string" ? record.priority : null,
      };
    });
  } catch {
    // A plan past the transcript's 16,000-character cut is no longer valid JSON.
    return null;
  }
}

/**
 * worker_read entries as turns of readable items. Agent and user text arrive
 * in chunks and are joined; consecutive updates of one tool and consecutive
 * plan updates collapse to their latest state. `tools` names tool lines that
 * only carry a tool call ID.
 */
export function conversation(entries: readonly WorkerTranscriptEntry[], tools?: ReadonlyMap<string, WorkerTool>): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const entry of entries) {
    let turn = turns.at(-1);
    if (!turn || turn.turnId !== entry.turnId) turns.push(turn = { turnId: entry.turnId, items: [] });
    const last = turn.items.at(-1);
    const key = `${entry.seq}`;
    if (entry.kind === "agent" || entry.kind === "user" || entry.kind === "event") {
      if (last?.kind === entry.kind) turn.items[turn.items.length - 1] = { ...last, text: last.text + entry.text, at: entry.at };
      else turn.items.push({ kind: entry.kind, key, text: entry.text, at: entry.at });
    } else if (entry.kind === "tool") {
      const { title, status } = parseToolLine(entry.text, tools);
      if (last?.kind === "tool" && last.title === title) turn.items[turn.items.length - 1] = { ...last, status: status ?? last.status, updates: last.updates + 1, at: entry.at };
      else turn.items.push({ kind: "tool", key, title, status, updates: 1, at: entry.at });
    } else if (entry.kind === "plan") {
      const item = { kind: "plan" as const, key, entries: parsePlan(entry.text), text: entry.text, at: entry.at };
      if (last?.kind === "plan") turn.items[turn.items.length - 1] = { ...item, key: last.key };
      else turn.items.push(item);
    } else {
      turn.items.push({ kind: entry.kind === "turn" || entry.kind === "notice" ? entry.kind : "other", key, text: entry.text, at: entry.at });
    }
  }
  return turns;
}

/** Append a page after `known`, ignoring entries already held (a re-read can overlap). */
export function appendBySeq<T extends { seq: number }>(known: readonly T[], page: readonly T[]): T[] {
  const last = known.at(-1)?.seq ?? 0;
  const fresh = page.filter((entry) => entry.seq > last);
  return fresh.length ? [...known, ...fresh] : known as T[];
}

/** Requested and natively observed settings disagree; null observations are unknown, not a mismatch. */
export function settingsMismatch(requested: { model: string | null; effort: string | null }, observed: { model: string | null; effort: string | null } | null): boolean {
  if (!observed) return false;
  return Boolean((observed.model && requested.model && observed.model !== requested.model)
    || (observed.effort && requested.effort && observed.effort !== requested.effort));
}

/**
 * The identity sets that mark a turn as an event turn: receipt `turnId`s, plus `deliveryId`s —
 * an event turn's requestId is its receipt's deliveryId.
 */
export function eventTurns(receipts: readonly WorkerEventReceipt[]): { turnIds: ReadonlySet<string>; deliveryIds: ReadonlySet<string> } {
  return {
    turnIds: new Set(receipts.flatMap((receipt) => receipt.turnId ? [receipt.turnId] : [])),
    deliveryIds: new Set(receipts.map((receipt) => receipt.deliveryId)),
  };
}

/** The delivery receipt that dispatched an event turn, if one is recorded for it. */
export function eventReceiptFor(turn: Pick<WorkerTurn, "id" | "requestId">, receipts: readonly WorkerEventReceipt[]): WorkerEventReceipt | null {
  return receipts.find((receipt) => receipt.turnId === turn.id || receipt.deliveryId === turn.requestId) ?? null;
}

/** Milliseconds as a short span: 45s, 3m 12s, 2h 5m. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
