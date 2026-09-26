/**
 * A Bot main-thread transcript assembled from native history pages and the
 * live projection. Rows keep native `(turnId, item.id)` identity and order;
 * unchanged rows and entries keep object identity so views can memoize them.
 */
type Raw = Record<string, unknown>;

export type TranscriptRow = {
  key: string;
  turnId: string;
  item: Raw;
  /** Canonical content that a live draft must not replace. */
  final: boolean;
  omitted: boolean;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

export type TranscriptState = { order: readonly string[]; rows: ReadonlyMap<string, TranscriptRow> };

export type ChatEntry = {
  key: string;
  turnId: string;
  kind: "human" | "assistant";
  text: string;
  /** Non-text inputs in their original order, such as images and file mentions. */
  attachments: string[];
  /** Still receiving streamed text. */
  streaming: boolean;
  omitted: boolean;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

/** The last entry of a finished turn carries the turn's span. */
export type ChatTurnEnd = { turnId: string; startedAtMs: number | null; completedAtMs: number | null };

export const emptyTranscript: TranscriptState = { order: [], rows: new Map() };

const object = (value: unknown): Raw => value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const time = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
export const rowKey = (turnId: string, itemId: string) => `${turnId}\u0000${itemId}`;

/** One `chat_main_items` entry; entries without identity are dropped. */
export function historyRow(entry: Raw, activeTurnId: string | null): TranscriptRow | null {
  const item = object(entry.item);
  const turnId = text(entry.turnId);
  const id = text(item.id);
  if (!turnId || !id) return null;
  const completedAtMs = time(entry.completedAtMs);
  return { key: rowKey(turnId, id), turnId, item, omitted: entry.omitted === true,
    // History is canonical once complete; a row in the active turn without a completion time may still grow.
    final: completedAtMs !== null || turnId !== activeTurnId,
    startedAtMs: time(entry.startedAtMs), completedAtMs };
}

export function liveRow(entry: { turnId: string; item: Raw; completed: boolean; omitted: boolean }, now: number): TranscriptRow | null {
  const id = text(entry.item.id);
  if (!entry.turnId || !id) return null;
  return { key: rowKey(entry.turnId, id), turnId: entry.turnId, item: entry.item, omitted: entry.omitted,
    final: entry.completed && !entry.omitted, startedAtMs: null, completedAtMs: entry.completed ? now : null };
}

/** Keep canonical content over drafts and real content over omitted summaries; carry known times forward. */
function merged(previous: TranscriptRow | undefined, next: TranscriptRow): TranscriptRow {
  if (!previous) return next;
  if (previous.final && !next.final) return previous;
  if (next.omitted && !previous.omitted) return { ...previous, final: previous.final || next.final };
  const row = { ...next, startedAtMs: next.startedAtMs ?? previous.startedAtMs,
    completedAtMs: next.final && next.completedAtMs === null ? previous.completedAtMs : next.completedAtMs ?? previous.completedAtMs };
  return sameRow(previous, row) ? previous : row;
}

function sameRow(a: TranscriptRow, b: TranscriptRow): boolean {
  return a.final === b.final && a.omitted === b.omitted && a.startedAtMs === b.startedAtMs && a.completedAtMs === b.completedAtMs
    && (a.item === b.item || JSON.stringify(a.item) === JSON.stringify(b.item));
}

function upsert(rows: Map<string, TranscriptRow>, row: TranscriptRow): void {
  const next = merged(rows.get(row.key), row);
  if (next !== rows.get(row.key)) rows.set(row.key, next);
}

/**
 * Apply the newest history page(s), newest first. They form a contiguous
 * suffix of the thread: rows before the first overlap keep their place, rows
 * the page does not name (live drafts not yet persisted) stay after it.
 * Without any overlap an existing transcript is replaced, since a gap cannot
 * be proven absent; the caller then pages older history again.
 */
export function applyNewest(state: TranscriptState, page: TranscriptRow[]): { state: TranscriptState; contiguous: boolean } {
  const suffix = [...page].reverse();
  const keys = new Set(suffix.map((row) => row.key));
  const first = state.order.findIndex((key) => keys.has(key));
  if (first < 0 && suffix.length && state.order.some((key) => state.rows.get(key)!.final)) return { state: fromRows(suffix), contiguous: false };
  const rows = new Map(state.rows);
  for (const row of suffix) upsert(rows, row);
  // With no overlap, everything known is an unpersisted draft and therefore newer.
  const head = first < 0 ? [] : state.order.slice(0, first);
  const tail = (first < 0 ? state.order : state.order.slice(first)).filter((key) => !keys.has(key));
  const order = [...head, ...suffix.map((row) => row.key), ...tail];
  return { state: finish(state, order, rows), contiguous: true };
}

/** Prepend an older history page (newest first), skipping rows already known. */
export function applyOlder(state: TranscriptState, page: TranscriptRow[]): TranscriptState {
  const rows = new Map(state.rows);
  const older: string[] = [];
  for (const row of [...page].reverse()) {
    if (!rows.has(row.key)) older.push(row.key);
    upsert(rows, row);
  }
  return finish(state, [...older, ...state.order], rows);
}

/** Apply live rows in native start order; unknown rows append. A reset first drops rows that are not canonical. */
export function applyLive(state: TranscriptState, live: TranscriptRow[], reset: boolean): TranscriptState {
  const rows = new Map(state.rows);
  let order = [...state.order];
  if (reset) {
    order = order.filter((key) => rows.get(key)?.final);
    for (const key of rows.keys()) if (!rows.get(key)!.final) rows.delete(key);
  }
  for (const row of live) {
    if (!rows.has(row.key)) order.push(row.key);
    upsert(rows, row);
  }
  return finish(state, order, rows);
}

function fromRows(rows: TranscriptRow[]): TranscriptState {
  return { order: rows.map((row) => row.key), rows: new Map(rows.map((row) => [row.key, row])) };
}

function finish(state: TranscriptState, order: string[], rows: Map<string, TranscriptRow>): TranscriptState {
  const sameOrder = order.length === state.order.length && order.every((key, index) => key === state.order[index]);
  const sameRows = rows.size === state.rows.size && [...rows].every(([key, row]) => state.rows.get(key) === row);
  return sameOrder && sameRows ? state : { order: sameOrder ? state.order : order, rows: sameRows ? state.rows : rows };
}

function inputLabel(part: Raw): string | null {
  const name = text(part.name) || text(part.path).split("/").at(-1) || "";
  switch (part.type) {
    case "image": return "image";
    case "localImage": return name ? `image ${name}` : "image";
    case "audio": case "localAudio": return "audio";
    case "mention": return `@${name}`;
    case "skill": return `$${name}`;
    default: return null;
  }
}

/** Human and assistant text only; every other native item stays out of the chat. */
export function entryOf(row: TranscriptRow): ChatEntry | null {
  const { item } = row;
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content.map(object) : [];
    const body = content.flatMap((part) => part.type === "text" && text(part.text) ? [text(part.text)] : []).join("\n\n");
    const attachments = content.flatMap((part) => inputLabel(part) ?? []);
    if (!body && !attachments.length && !row.omitted) return null;
    return { key: row.key, turnId: row.turnId, kind: "human", text: body, attachments, streaming: false, omitted: row.omitted,
      startedAtMs: row.startedAtMs, completedAtMs: row.completedAtMs };
  }
  if (item.type === "agentMessage") {
    return { key: row.key, turnId: row.turnId, kind: "assistant", text: text(item.text), attachments: [], streaming: !row.final && !row.omitted,
      omitted: row.omitted, startedAtMs: row.startedAtMs, completedAtMs: row.completedAtMs };
  }
  return null;
}

/** Entries keep identity while their row is unchanged. */
export function entriesOf(state: TranscriptState, previous: ReadonlyMap<string, { row: TranscriptRow; entry: ChatEntry | null }>): {
  entries: ChatEntry[]; cache: Map<string, { row: TranscriptRow; entry: ChatEntry | null }>;
} {
  const cache = new Map<string, { row: TranscriptRow; entry: ChatEntry | null }>();
  const entries: ChatEntry[] = [];
  for (const key of state.order) {
    const row = state.rows.get(key)!;
    const cached = previous.get(key);
    const entry = cached?.row === row ? cached.entry : entryOf(row);
    cache.set(key, { row, entry });
    if (entry && (entry.text || entry.attachments.length || entry.omitted)) entries.push(entry);
  }
  return { entries, cache };
}

/** Span of each finished turn, keyed by the key of its last visible entry. */
export function turnEnds(state: TranscriptState, entries: ChatEntry[], activeTurnId: string | null): Map<string, ChatTurnEnd> {
  const ends = new Map<string, ChatTurnEnd>();
  const spans = new Map<string, { start: number | null; end: number | null }>();
  for (const key of state.order) {
    const row = state.rows.get(key)!;
    const span = spans.get(row.turnId) ?? { start: null, end: null };
    span.start ??= row.startedAtMs;
    if (row.completedAtMs !== null) span.end = Math.max(span.end ?? 0, row.completedAtMs);
    spans.set(row.turnId, span);
  }
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const next = entries[index + 1];
    if (entry.kind !== "assistant" || entry.turnId === activeTurnId || next?.turnId === entry.turnId) continue;
    const span = spans.get(entry.turnId);
    ends.set(entry.key, { turnId: entry.turnId, startedAtMs: span?.start ?? null, completedAtMs: span?.end ?? null });
  }
  return ends;
}

export type ChatActivity = { phase: "thinking" | "working" | "responding"; headline: string | null };

/** What the active turn is doing now, from its latest row, plus the newest reasoning summary heading. */
export function activityOf(state: TranscriptState, activeTurnId: string | null): ChatActivity | null {
  if (!activeTurnId) return null;
  let latest: TranscriptRow | null = null;
  let headline: string | null = null;
  for (let index = state.order.length - 1; index >= 0; index--) {
    const row = state.rows.get(state.order[index])!;
    if (row.turnId !== activeTurnId) continue;
    latest ??= row;
    if (row.item.type === "reasoning" && headline === null) headline = reasoningHeadline(row.item);
    if (headline !== null) break;
  }
  const phase = latest && !latest.final && latest.item.type === "reasoning" ? "thinking"
    : latest && !latest.final && latest.item.type === "agentMessage" ? "responding"
    : latest?.item.type === "reasoning" ? "thinking" : "working";
  return { phase, headline };
}

/** Reasoning summaries open with a bold heading; otherwise use the first line. */
export function reasoningHeadline(item: Raw): string | null {
  const parts = Array.isArray(item.summary) ? item.summary.map(text).filter((part) => part.trim()) : [];
  const last = parts.at(-1);
  if (!last) return null;
  const bold = /^\s*\*\*(.+?)\*\*/.exec(last)?.[1];
  const line = (bold ?? last.trim().split("\n")[0]).replace(/[*_`]/g, "").trim();
  return line ? line.slice(0, 120) : null;
}
