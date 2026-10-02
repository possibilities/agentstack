import { shortId } from "./derive";
import type { Bot, NodeRef, WorkActivity, WorkActor, WorkAdmission, WorkItem, WorkReference, WorkState, WorkTree, WorkTreeRow } from "./types";

/**
 * HUD presentation helpers. Work state is a semantic declaration, never a runtime
 * phase: nothing here infers completion, activity or approval from counts, Worker
 * phases or focus. Rollups are counts, not percentages.
 */

export type HudTone = "success" | "warning" | "destructive" | "muted" | "info";

export const workStates: WorkState[] = ["planned", "active", "blocked", "waiting", "paused", "review", "completed", "cancelled"];
export const terminalStates = new Set<WorkState>(["completed", "cancelled"]);
export const isTerminal = (state: WorkState): boolean => terminalStates.has(state);

export const stateView: Record<WorkState, { word: string; tone: HudTone }> = {
  planned: { word: "Planned", tone: "muted" },
  active: { word: "Active", tone: "info" },
  blocked: { word: "Blocked", tone: "destructive" },
  waiting: { word: "Waiting", tone: "warning" },
  paused: { word: "Paused", tone: "muted" },
  review: { word: "Review", tone: "warning" },
  completed: { word: "Completed", tone: "success" },
  cancelled: { word: "Cancelled", tone: "muted" },
};

export const priorities: WorkItem["priority"][] = ["low", "normal", "high", "urgent"];
export const attentionKinds: WorkItem["attention"][] = ["none", "human", "agent"];
export const noteKinds = ["note", "progress", "result", "decision", "handoff"] as const;
export type NoteKind = typeof noteKinds[number];
export const linkRelations: WorkItem["links"][number]["relation"][] = ["lead", "contributor", "context", "evidence", "output", "related"];

/** The whole loaded hierarchy. `complete` is false when more rows exist than were read. */
export type HudTree = { rows: WorkTreeRow[]; total: number; snapshot: number; complete: boolean };

type Call = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

/**
 * Read up to `budget` preorder rows, fenced by the first page's snapshot. A change
 * between pages restarts at offset zero rather than combining generations.
 */
export async function loadTree(call: Call, budget: number, attempts = 3): Promise<HudTree> {
  for (let attempt = 1; ; attempt++) {
    try {
      const rows: WorkTreeRow[] = [];
      let page = await call<WorkTree>("work_tree", { offset: 0, limit: 200 });
      rows.push(...page.rows);
      while (page.nextOffset !== null && rows.length < budget) {
        page = await call<WorkTree>("work_tree", { offset: page.nextOffset, limit: Math.min(200, budget - rows.length), snapshot: page.snapshot });
        rows.push(...page.rows);
      }
      return { rows, total: page.total, snapshot: page.snapshot, complete: page.nextOffset === null };
    } catch (error) {
      if (attempt >= attempts || !/work_snapshot_changed/.test(String(error instanceof Error ? error.message : error))) throw error;
    }
  }
}

export type TreeView = "open" | "attention" | "all";
export type TreeFilter = { view: TreeView; query: string };
/** A shown row. `context` rows do not match the filter; they keep a match's real ancestry visible. */
export type VisibleRow = { row: WorkTreeRow; context: boolean; collapsed: boolean };
export type TreeWindow = { rows: VisibleRow[]; hiddenClosed: number; hiddenFiltered: number; hiddenCollapsed: number; rootMissing: boolean };

export function needsLook(item: Pick<WorkItem, "state" | "attention">): boolean {
  return item.attention !== "none" || item.state === "blocked" || item.state === "waiting" || item.state === "review";
}

function matchesQuery(item: WorkItem, query: string): boolean {
  if (!query) return true;
  const text = `${item.title}\n${item.summary}\n${item.objective}\n${item.nextAction}\n${item.labels.join(" ")}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

/**
 * What the Work tree shows. Filtering never re-parents a row: every shown match
 * keeps its real ancestors, marked as context when they do not match themselves.
 * Hidden counts explain what the filter, collapse or subtree focus left out.
 */
export function treeWindow(rows: WorkTreeRow[], filter: TreeFilter, collapsed: ReadonlySet<string>, rootId: string | null): TreeWindow {
  let scoped = rows;
  let rootMissing = false;
  if (rootId) {
    const start = rows.findIndex((row) => row.item.id === rootId);
    if (start < 0) rootMissing = true;
    else {
      const depth = rows[start].depth;
      let end = start + 1;
      while (end < rows.length && rows[end].depth > depth) end++;
      scoped = rows.slice(start, end);
    }
  }
  const query = filter.query.trim();
  const matches = (item: WorkItem) => (filter.view === "all" || (filter.view === "open" ? !isTerminal(item.state) : needsLook(item) && !isTerminal(item.state))) && matchesQuery(item, query);
  // Preorder: a row's ancestors are the nearest earlier rows at each shallower depth.
  const include = new Set<number>();
  const stack: number[] = [];
  let hiddenClosed = 0, hiddenFiltered = 0;
  scoped.forEach((row, index) => {
    while (stack.length && scoped[stack.at(-1)!].depth >= row.depth) stack.pop();
    if (matches(row.item)) {
      include.add(index);
      for (const ancestor of stack) include.add(ancestor);
    }
    stack.push(index);
  });
  scoped.forEach((row, index) => {
    if (include.has(index)) return;
    if (filter.view === "open" && isTerminal(row.item.state) && matchesQuery(row.item, query)) hiddenClosed++;
    else hiddenFiltered++;
  });
  const shown: VisibleRow[] = [];
  let hiddenCollapsed = 0;
  let skipDepth: number | null = null;
  scoped.forEach((row, index) => {
    if (!include.has(index)) return;
    if (skipDepth !== null && row.depth > skipDepth) { hiddenCollapsed++; return; }
    skipDepth = null;
    const isCollapsed = collapsed.has(row.item.id) && row.childCount > 0;
    shown.push({ row, context: !matches(row.item), collapsed: isCollapsed });
    if (isCollapsed) skipDepth = row.depth;
  });
  return { rows: shown, hiddenClosed, hiddenFiltered, hiddenCollapsed, rootMissing };
}

export function rowIndex(rows: WorkTreeRow[]): Map<string, WorkTreeRow> {
  return new Map(rows.map((row) => [row.item.id, row]));
}

/** Nearest parent first; stops at a parent the loaded rows do not include. */
export function ancestorsOf(id: string, byId: Map<string, WorkTreeRow>): WorkItem[] {
  const result: WorkItem[] = [];
  const seen = new Set<string>([id]);
  let parent = byId.get(id)?.item.parentId ?? null;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const row = byId.get(parent);
    if (!row) break;
    result.push(row.item);
    parent = row.item.parentId;
  }
  return result;
}

/** Every loaded descendant in preorder. */
export function descendantsOf(id: string, rows: WorkTreeRow[]): WorkTreeRow[] {
  const start = rows.findIndex((row) => row.item.id === id);
  if (start < 0) return [];
  const result: WorkTreeRow[] = [];
  for (let index = start + 1; index < rows.length && rows[index].depth > rows[start].depth; index++) result.push(rows[index]);
  return result;
}

/** Ordered siblings under one parent, as the tree orders them. */
export function siblingsOf(parentId: string | null, rows: WorkTreeRow[]): WorkItem[] {
  return rows.filter((row) => row.item.parentId === parentId).map((row) => row.item);
}

/** An order value that sorts between two neighbors; either may be missing. */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - 10;
  if (after === undefined) return before + 10;
  return (before + after) / 2;
}

/**
 * The order edits that move an item one place up or down among its ordered siblings,
 * or null at the edge. Usually one edit; when neighbors share an order value (ties
 * sort by creation), the siblings are renumbered so the move is exact.
 */
export function stepOrder(item: WorkItem, siblings: WorkItem[], direction: -1 | 1): Array<{ item: WorkItem; order: number }> | null {
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= siblings.length) return null;
  const others = siblings.filter((sibling) => sibling.id !== item.id);
  const before = others[target - 1]?.order, after = others[target]?.order;
  if (before === undefined || after === undefined || before < after) return [{ item, order: orderBetween(before, after) }];
  const next = [...others.slice(0, target), item, ...others.slice(target)];
  return next.flatMap((sibling, position) => sibling.order === position * 10 ? [] : [{ item: sibling, order: position * 10 }]);
}

/** The order that appends a new child after its last sibling. */
export function appendOrder(parentId: string | null, rows: WorkTreeRow[]): number {
  const siblings = siblingsOf(parentId, rows);
  return siblings.length ? Math.max(...siblings.map((item) => item.order)) + 10 : 0;
}

/** Completed ancestors that must reopen in the same batch when this item reopens. */
export function reopenAncestors(id: string, byId: Map<string, WorkTreeRow>): WorkItem[] {
  return ancestorsOf(id, byId).filter((item) => item.state === "completed").reverse();
}

/** Open descendants that must close in the same batch before this item can complete. */
export function openDescendants(id: string, rows: WorkTreeRow[]): WorkItem[] {
  return descendantsOf(id, rows).map((row) => row.item).filter((item) => !isTerminal(item.state));
}

/** A title as text. A tombstone's replacement "[cleared]" reads as what it is rather than as a title someone wrote. */
export const workTitle = (item: Pick<WorkItem, "title" | "contentClearedAt">): string => item.contentClearedAt ? "Content cleared" : item.title;

/** What `hud_history_plan` clears: collaboration bodies only, or the item itself as a permanent tombstone as well. */
export type HistoryScope = "journal_bodies" | "item_and_journal";
export type HistoryChoice = "item" | "subtree";
/** One plan selects at most this many items. */
export const historyLimit = 100;

export type HistoryItems = {
  /** The exact items one plan would select: tombstoned items already hold nothing to clear and are left out. */
  ids: string[];
  /** Tombstoned items inside the choice, left out. */
  cleared: number;
  /** The loaded rows may not include the whole subtree, so a subtree choice would silently select less than it says. */
  partial: boolean;
  overLimit: boolean;
};

/**
 * The exact items a history plan selects for one item: only itself, or itself and every descendant. Descendants come
 * from the loaded hierarchy, so a subtree reaching the end of a partly loaded tree is reported rather than guessed.
 * Items already tombstoned are excluded; the plan still checks every descendant, so nothing is cleared by omission.
 */
export function historyItems(rows: WorkTreeRow[], item: WorkItem, choice: HistoryChoice, complete: boolean): HistoryItems {
  const start = rows.findIndex((row) => row.item.id === item.id);
  const below = choice === "subtree" ? descendantsOf(item.id, rows).map((row) => row.item) : [];
  const chosen = [item, ...below];
  const open = chosen.filter((entry) => !entry.contentClearedAt);
  // A subtree that ends at the last loaded row may continue in rows that were never read.
  const partial = choice === "subtree" && (start < 0 || (!complete && start + below.length === rows.length - 1));
  return { ids: open.map((entry) => entry.id), cleared: chosen.length - open.length, partial, overLimit: open.length > historyLimit };
}

/**
 * One recovery slot per item. The scope and choice are frozen while a flow is past idle, so a retained running, partial
 * or unknown receipt is always shown for the decision that made it, whichever scope that was.
 */
export const historyKey = (id: string): string => `hud:history:${id}`;

/** A new parent may not be the item itself or one of its descendants. */
export function parentChoices(id: string | null, rows: WorkTreeRow[]): WorkItem[] {
  const excluded = new Set(id ? [id, ...descendantsOf(id, rows).map((row) => row.item.id)] : []);
  return rows.map((row) => row.item).filter((item) => !excluded.has(item.id));
}

export type HudFailure = { kind: "conflict" | "refused" | "uncertain" | "unsent"; code: string | null; text: string };

const failureCopy: Record<string, string> = {
  work_revision_conflict: "Someone changed this item since you started. Your draft is kept; compare it with the current version.",
  work_focus_conflict: "This Chat's focus changed since it was read. Review the current focus and choose again.",
  work_request_conflict: "This request ID already recorded different input. Nothing was changed by this attempt.",
  work_not_ready: "It can't complete yet: every descendant must be closed and every dependency completed.",
  work_reopen_required: "Closed work must reopen before its objective, parent or dependencies change.",
  work_closed: "Closed work can't be chosen here. Reopen it or choose open work.",
  work_cycle: "That would make the hierarchy and dependencies circular.",
  work_depth_limit: "Nesting is limited to 128 levels.",
  work_exists: "An item with this ID already exists; a previous attempt probably created it.",
  work_not_found: "That work item no longer exists.",
  work_reference_missing: "A dependency or linked work item no longer exists.",
  work_duplicate_dependency: "A dependency is listed twice.",
  work_links_limit: "An item holds at most 64 links.",
  work_metadata_limit: "An item holds at most 32 metadata namespaces.",
  work_snapshot_changed: "The hierarchy changed while it was being read; it will be read again.",
  hud_reference_invalid: "A linked Bot, Chat or Worker doesn't match what Stack knows now.",
  hud_focus_target_required: "Choose an exact Bot Chat.",
};

/**
 * What a failed HUD call means for the retained request. A server refusal is
 * definite; a lost connection leaves the outcome unknown, so the same requestId
 * and input must be retried, never a new one.
 */
export function hudFailure(error: unknown): HudFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/connection closed/i.test(message)) return { kind: "uncertain", code: null, text: "The connection closed before an answer arrived. It may have applied." };
  if (/not connected/i.test(message)) return { kind: "unsent", code: null, text: "HUD isn't connected; nothing was sent." };
  const code = /^(\w+):?/.exec(message)?.[1] ?? null;
  const known = code && failureCopy[code];
  const kind = code === "work_revision_conflict" || code === "work_focus_conflict" ? "conflict" : "refused";
  return { kind, code: known ? code : null, text: known || message };
}

export function actorLabel(actor: WorkActor | null | undefined): string {
  if (!actor) return "nobody";
  return actor.kind === "operator" ? "Operator" : actor.botId;
}

/** Where a typed reference leads in the UI. `node` is absent when no card or window represents it. */
export type ReferenceView = { label: string; detail: string | null; node: NodeRef | null; external: string | null };

/** Generic Package API locators the UI can resolve to one of its own records. Others stay inspectable text. */
const resourceKinds: Record<string, Record<string, NodeRef["kind"]>> = {
  content: { document: "document", artifact: "artifact", item: "item", collection: "collection" },
  brain: { document: "research-document", source: "research-source", job: "ingestion-job" },
  proc: { schedule: "proc-schedule", run: "proc-run", execution: "proc-execution" },
  browse: { profile: "browser-profile", handoff: "browser-handoff" },
  notify: { notification: "notification" },
  roles: { role: "role" },
  scrape: { preset: "preset" },
};

export function referenceView(ref: WorkReference, titles?: Map<string, string>): ReferenceView {
  switch (ref.kind) {
    case "operator": return { label: "Operator", detail: null, node: null, external: null };
    case "bot": return { label: ref.botId, detail: `root ${shortId(ref.mainThreadId)}`, node: { kind: "bot", id: ref.botId }, external: null };
    case "chat": return { label: `${ref.botId} chat`, detail: ref.threadId === ref.mainThreadId ? "main thread" : `thread ${shortId(ref.threadId)}`, node: null, external: null };
    case "worker": return { label: `Worker ${shortId(ref.workerId, 6)}`, detail: ref.turnId ? `turn ${shortId(ref.turnId)}` : null, node: { kind: "worker", id: ref.workerId }, external: null };
    case "work": return { label: titles?.get(ref.workItemId) ?? `Work ${shortId(ref.workItemId)}`, detail: null, node: { kind: "work-item", id: ref.workItemId }, external: null };
    case "url": return { label: ref.url.replace(/^https?:\/\//, ""), detail: null, node: null, external: ref.url };
    case "resource": {
      const kind = resourceKinds[ref.package]?.[ref.resource];
      return { label: `${ref.package}/${ref.resource} ${ref.id}`, detail: ref.version ? `version ${ref.version.slice(0, 12)}` : null,
        node: kind ? { kind, id: ref.id } as NodeRef : null, external: null };
    }
  }
}

/**
 * Whether a declared Chat still belongs to the Bot identity it names. A retained
 * link or focus can outlive its Bot or a root replacement; only the same root is
 * the same Chat.
 */
export function chatIdentity(target: { botId: string; mainThreadId: string }, bots: Bot[] | null): "current" | "replaced" | "missing" | "unknown" {
  if (!bots) return "unknown";
  const bot = bots.find((item) => item.id === target.botId);
  if (!bot) return "missing";
  return bot.mainThreadId === target.mainThreadId ? "current" : "replaced";
}

const turnWords: Record<WorkAdmission["turnPhase"], string> = {
  queued: "Queued", running: "Running", awaiting_input: "Awaiting input", cancelling: "Cancelling",
  completed: "Completed", cancelled: "Cancelled", failed: "Failed", unknown: "Outcome unknown",
};

/**
 * One captured admission, described without stretching it: a completed earlier turn is
 * history even when its Worker now runs another, and an older scope is evidence about
 * an earlier objective, not an invalid or completed one.
 */
export function admissionView(entry: WorkAdmission, currentScope: number): { turn: string; tone: HudTone; live: boolean; historical: boolean; scope: string | null } {
  const live = ["queued", "running", "awaiting_input", "cancelling"].includes(entry.turnPhase);
  const tone: HudTone = live ? "info" : entry.turnPhase === "completed" ? "success" : entry.turnPhase === "failed" ? "destructive" : entry.turnPhase === "unknown" ? "warning" : "muted";
  const scope = entry.context.scopeRevision < currentScope ? `Admitted for scope ${entry.context.scopeRevision}; now ${currentScope}` : null;
  return { turn: turnWords[entry.turnPhase], tone, live, historical: !entry.current || !live, scope };
}

/** A journal value as short text; objects collapse to JSON. */
export function valueText(value: unknown, limit = 160): string {
  const text = value === null || value === undefined ? "—" : typeof value === "string" ? (value || "“”") : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const activityWords: Record<WorkActivity["kind"], string> = {
  created: "Created", updated: "Edited", metadata: "Agent metadata", note: "Note", progress: "Progress",
  result: "Result", decision: "Decision", handoff: "Handoff", focus: "Chat focus", maintenance: "Content cleared",
};
export const activityWord = (kind: WorkActivity["kind"]): string => activityWords[kind];
/** Scope-versioned notes whose meaning depends on the objective they were recorded against. */
export const scopedNotes = new Set<WorkActivity["kind"]>(["result", "decision", "handoff"]);

export type AttentionGroup = { id: "human" | "agent" | "blocked" | "review" | "waiting"; title: string; rows: WorkTreeRow[] };

/**
 * Open work that asks for someone, grouped by who or what it waits on. A human marker
 * is an explicit request for a look, not a notification or an approval prompt.
 */
export function attentionGroups(rows: WorkTreeRow[]): AttentionGroup[] {
  const open = rows.filter((row) => !isTerminal(row.item.state));
  const taken = new Set<string>();
  const take = (predicate: (row: WorkTreeRow) => boolean) => open.filter((row) => !taken.has(row.item.id) && predicate(row)).map((row) => { taken.add(row.item.id); return row; });
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
  const sort = (list: WorkTreeRow[]) => list.sort((a, b) => rank[a.item.priority] - rank[b.item.priority] || b.item.updatedAt - a.item.updatedAt);
  return [
    { id: "human" as const, title: "Needs a human", rows: sort(take((row) => row.item.attention === "human")) },
    { id: "review" as const, title: "In review", rows: sort(take((row) => row.item.state === "review")) },
    { id: "blocked" as const, title: "Blocked", rows: sort(take((row) => row.item.state === "blocked" || row.unmetDependencies.length > 0 && row.item.state !== "planned")) },
    { id: "agent" as const, title: "Needs an agent", rows: sort(take((row) => row.item.attention === "agent")) },
    { id: "waiting" as const, title: "Waiting", rows: sort(take((row) => row.item.state === "waiting")) },
  ].filter((group) => group.rows.length);
}

/** Why the HUD space deserves a look, for the Spaces menu. */
export function hudAttention(tree: HudTree | null): string[] {
  const human = tree?.rows.filter((row) => row.item.attention === "human" && !isTerminal(row.item.state)).length ?? 0;
  return human ? [`${human} item${human === 1 ? "" : "s"} marked for a human`] : [];
}

/** Parse `a, b, c` into a de-duplicated label list. */
export function parseLabels(text: string): string[] {
  return [...new Set(text.split(",").map((label) => label.trim()).filter(Boolean))];
}
