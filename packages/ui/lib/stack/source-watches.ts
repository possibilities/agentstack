import { buildFilter, canonicalJson, describeFilter, filterIsEmpty, type FilterDraft } from "./source";
import type { GithubDelivery, GithubFilter, GithubWatch, GithubWatchRead } from "./types";

/*
 * The Source space's watch logic: a frozen definition for review before creation, the consumption inbox, and the review
 * boundary an acknowledgement may name. Nothing here reads the network on its own; the inbox is handed its reads.
 *
 * Acknowledgement is the only thing that advances a watch's consumption cursor, and only a person's explicit act reaches
 * it: opening, reading, refreshing, a notice, a reconnect, a poll or a native admission never calls it. The cursor moves
 * through exactly the rows the person marked as reviewed, against the cursor those rows were read from.
 */

/* ---------- Creation: one frozen definition ---------- */

export const maxWatchLabel = 200;
export const maxWatches = 128;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sequencePattern = /^(?:0|[1-9]\d{0,15})$/;

export type WatchStart = { kind: "now" } | { kind: "after"; text: string };
export type WatchDraft = { id: string; label: string; filter: FilterDraft; start: WatchStart };
export type WatchCreateInput = { id: string; label: string; filter: GithubFilter; start: "now" | number };

/** The exact request, deep-frozen, and the exact text the review shows. Neither changes after review. */
export type FrozenWatch = { input: Readonly<WatchCreateInput>; json: string; filterJson: string };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * A draft as the request the owner will see, or the reasons it is not yet one. The result is a copy, frozen: editing the
 * draft afterwards cannot change what was reviewed, so the review step either sends this or goes back to edit.
 */
export function freezeWatch(draft: WatchDraft, latest: number | null): { ok: true; frozen: FrozenWatch; notes: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!uuidPattern.test(draft.id)) errors.push("The watch ID is not a UUID");
  const label = draft.label.trim();
  if (!label) errors.push("Give the watch a label");
  else if (label.length > maxWatchLabel) errors.push(`A label holds at most ${maxWatchLabel} characters`);
  const { filter, errors: filterErrors } = buildFilter(draft.filter);
  errors.push(...filterErrors);
  let start: "now" | number = "now";
  if (draft.start.kind === "after") {
    const text = draft.start.text.trim();
    if (!sequencePattern.test(text) || !Number.isSafeInteger(Number(text))) errors.push("Backfill starts after a whole sequence number, such as 0 or 41");
    else {
      start = Number(text);
      if (latest !== null && start > latest) errors.push(`Sequence ${start} is beyond the newest arrival (#${latest}); a watch cannot start in the future`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const input: WatchCreateInput = { id: draft.id.toLowerCase(), label, filter: JSON.parse(canonicalJson(filter)) as GithubFilter, start };
  const frozen: FrozenWatch = { input: deepFreeze(input), json: canonicalJson(input, 2), filterJson: canonicalJson(input.filter, 2) };
  const notes: string[] = [];
  if (filterIsEmpty(filter)) notes.push("No field is filled in, so every delivery after the start matches.");
  if (start !== "now" && filter.predicates?.length) {
    notes.push("Backfill cannot match a payload predicate against a delivery whose original payload was cleared: those deliveries are skipped, and a later clearing never changes matches already recorded.");
  }
  return { ok: true, frozen, notes };
}

/** What the chosen start means, in the owner's words. */
export function startWords(start: "now" | number, latest: number | null): string {
  if (start === "now") return `Starts now: the owner fixes the start at the newest arrival when it creates the watch${latest !== null ? ` (#${latest} when last read)` : ""}. Nothing already stored is examined.`;
  const span = latest !== null && latest > start ? `, retained deliveries #${start + 1} through #${latest} at most` : "";
  return `Backfills from after #${start}${span}: retained deliveries after that sequence that match are in the inbox from the start. Arrivals after creation match as usual.`;
}

/** A filter on one line, for lists and confirmations. */
export function filterSummary(filter: GithubFilter, endpointLabel: (id: string) => string = (id) => id): string {
  if (filterIsEmpty(filter)) return "Every delivery";
  return describeFilter(filter, endpointLabel).map((item) => `${item.label}: ${item.values.join(" or ")}`).join(" · ");
}

/** Copyable requests for one watch. None of them acknowledges anything, and no operator action wakes a Bot or Worker. */
export function watchExamples(id: string): { subscribe: string; poll: string; listen: string } {
  const rpc = (requestId: number, method: string, params: Record<string, unknown>) => canonicalJson({ id: requestId, jsonrpc: "2.0", method, params }, 2);
  return {
    subscribe: canonicalJson({ topic: "github_watches_changed", scope: `watch:${id}`, readOperation: "github_watch_read", readArguments: { id } }, 2),
    poll: rpc(2, "events/poll", { name: "github_delivery", arguments: { id }, cursor: null }),
    listen: rpc(3, "tools/call", { name: "events_listen", arguments: { name: "github_delivery", arguments: { id }, policy: "native" } }),
  };
}

/* ---------- The review boundary ---------- */

export type ReviewPlan = {
  /** The last sequence of the unbroken run of marked entries that starts at the oldest loaded one. Null when that entry is not marked. */
  through: number | null;
  first: number | null;
  /** Entries the acknowledgement would cover. */
  count: number;
  /** Entries in that run whose details were never opened: marked reviewed, not looked at. */
  skipped: number[];
  /** Marked entries after an unmarked one. They are not covered by any acknowledgement until everything before them is marked too. */
  stranded: number[];
};

/**
 * What acknowledging would cover. Consumption is a cursor, so it can only move through an unbroken run from the oldest
 * pending entry: marking a later entry first never lets it be acknowledged past one that was not reviewed.
 */
export function reviewPlan(entries: readonly Pick<GithubDelivery, "sequence">[], marked: readonly number[], opened: readonly number[]): ReviewPlan {
  const reviewed = new Set(marked), seen = new Set(opened);
  let run = 0;
  while (run < entries.length && reviewed.has(entries[run]!.sequence)) run++;
  const covered = entries.slice(0, run);
  return {
    through: run ? covered[run - 1]!.sequence : null, first: run ? covered[0]!.sequence : null, count: run,
    skipped: covered.filter((entry) => !seen.has(entry.sequence)).map((entry) => entry.sequence),
    stranded: entries.slice(run).filter((entry) => reviewed.has(entry.sequence)).map((entry) => entry.sequence),
  };
}

export const toggleMark = (marked: readonly number[], sequence: number, on: boolean): number[] =>
  on ? [...new Set([...marked, sequence])].sort((a, b) => a - b) : marked.filter((item) => item !== sequence);

/** Mark this entry and every older loaded one: one deliberate act that covers the run, which the confirmation then lists as unopened. */
export function markThrough(entries: readonly Pick<GithubDelivery, "sequence">[], marked: readonly number[], sequence: number): number[] {
  const upTo = entries.filter((entry) => entry.sequence <= sequence).map((entry) => entry.sequence);
  return [...new Set([...marked, ...upTo])].sort((a, b) => a - b);
}

/* ---------- The inbox ---------- */

export const inboxPageSize = 25;
const refreshPage = 50;
const maxRefreshPages = 40;

export type InboxRead = (input: { id: string; after?: number; limit: number }) => Promise<GithubWatchRead>;
export type InboxAcknowledge = (input: { id: string; through: number; expectedAcknowledgedThrough: number }) => Promise<GithubWatch>;

/** What the person is told after something happened to the cursor they reviewed against. Cleared by the next explicit act. */
export type InboxNotice =
  /** The owner refused an acknowledgement: another consumer had moved the cursor. The inbox was read again; review starts over. */
  | { kind: "conflict"; attempted: number; expected: number; now: number | null; code: string }
  /** The cursor moved somewhere else while reading. The rows were replaced; review starts over. */
  | { kind: "moved"; from: number; to: number }
  | { kind: "acknowledged"; through: number; count: number; skipped: number[]; confirmedByReading: boolean }
  /** The cursor changed but not to what was requested, or the owner refused the request for another reason; nothing is assumed. */
  | { kind: "refused"; attempted: number; error: string }
  /** The request may or may not have been applied and the cursor could not be read back. Nothing is assumed. */
  | { kind: "unknown"; attempted: number; expected: number; error: string };

export type InboxState = {
  /** Increments with every fresh load; an answer for an older one is dropped. */
  session: number;
  watchId: string | null;
  watch: GithubWatch | null;
  /** The acknowledged cursor the loaded rows follow. A different cursor on the owner means these rows are no longer its pending run. */
  base: number | null;
  entries: GithubDelivery[];
  /** Pending entries and the matched high-water as of the latest read. Later arrivals move them; the loaded rows never move. */
  pending: number | null;
  through: number | null;
  /** The matched high-water when this inbox was first read. Beyond it, matches arrived while someone was reading. */
  firstThrough: number | null;
  nextCursor: number | null;
  busy: "first" | "more" | "refresh" | "ack" | null;
  error: string | null;
  /** The watch was removed (or never existed): its ID is retired. */
  gone: boolean;
  marked: number[];
  opened: number[];
  notice: InboxNotice | null;
};

export const initialInbox: InboxState = { session: 0, watchId: null, watch: null, base: null, entries: [], pending: null, through: null, firstThrough: null, nextCursor: null,
  busy: null, error: null, gone: false, marked: [], opened: [], notice: null };

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isGone = (text: string) => /github_watch_not_found/.test(text);

/** Matches the owner has recorded that this view has not loaded yet; only meaningful while the rows follow the owner's cursor. */
export function unloaded(state: Pick<InboxState, "pending" | "entries" | "watch" | "base">): number {
  if (state.pending === null || !state.watch || state.base !== state.watch.acknowledgedThrough) return 0;
  return Math.max(0, state.pending - state.entries.length);
}

/** Whether an acknowledgement through the reviewed run may be offered now, and the plan it would cover. */
export function acknowledgement(state: InboxState): { plan: ReviewPlan; allowed: boolean; reason: string | null } {
  const plan = reviewPlan(state.entries, state.marked, state.opened);
  if (state.busy) return { plan, allowed: false, reason: "Wait for the current read to finish." };
  if (!state.watch || state.base === null || state.base !== state.watch.acknowledgedThrough) return { plan, allowed: false, reason: "The cursor moved after these rows were read; read the inbox again." };
  if (plan.through === null) return { plan, allowed: false, reason: "Mark the oldest pending entry as reviewed first." };
  return { plan, allowed: true, reason: null };
}

/**
 * One watch's consumption inbox over `github_watch_read`: the oldest pending summaries, paged with `after`. It is not a pinned
 * snapshot, because the owner offers no `through` for it: matches may arrive at any time and are appended only when asked,
 * and the loaded rows never move. Reviewing marks entries; acknowledging is the one call that advances the cursor, with the
 * cursor these rows were read from as its compare-and-set. A refused or surprising cursor replaces the rows and clears every
 * mark, so review is done again against what is really pending.
 */
export class WatchInbox {
  private current: InboxState = initialInbox;
  private readonly listeners = new Set<() => void>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly read: InboxRead;
  private readonly acknowledgeCursor: InboxAcknowledge;
  private readonly limit: number;

  constructor(read: InboxRead, acknowledge: InboxAcknowledge, limit = inboxPageSize) {
    this.read = read;
    this.acknowledgeCursor = acknowledge;
    this.limit = limit;
  }

  getState = (): InboxState => this.current;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<InboxState>): void { this.current = { ...this.current, ...patch }; for (const listener of this.listeners) listener(); }

  /** A fresh inbox for `id`: nothing from another watch, and no mark, survives. */
  open(id: string): Promise<void> {
    if (this.current.watchId === id && this.current.session > 0) return Promise.resolve();
    return this.load(id, {});
  }

  /** Read again from the owner's cursor, as a new decision: every mark is cleared. */
  reload(): Promise<void> {
    return this.current.watchId ? this.load(this.current.watchId, {}) : Promise.resolve();
  }

  close(): void {
    this.cancelTimer();
    this.current = { ...initialInbox, session: this.current.session + 1 };
    for (const listener of this.listeners) listener();
  }

  dispose(): void { this.cancelTimer(); }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.dirty = false; }

  private async load(id: string, keep: { marked?: number[]; opened?: number[]; notice?: InboxNotice | null }): Promise<void> {
    this.cancelTimer();
    const session = this.current.session + 1;
    this.current = { ...initialInbox, session, watchId: id, busy: "first", notice: keep.notice ?? null };
    for (const listener of this.listeners) listener();
    try {
      const page = await this.read({ id, limit: this.limit });
      if (session !== this.current.session) return;
      const held = new Set(page.entries.map((entry) => entry.sequence));
      this.set({ busy: null, watch: page.watch, base: page.watch.acknowledgedThrough, entries: page.entries, pending: page.pending, through: page.through, firstThrough: page.through,
        nextCursor: page.nextCursor, marked: (keep.marked ?? []).filter((sequence) => held.has(sequence)), opened: (keep.opened ?? []).filter((sequence) => held.has(sequence)) });
    } catch (error) {
      if (session !== this.current.session) return;
      const text = message(error);
      this.set(isGone(text) ? { busy: null, gone: true } : { busy: null, error: text });
    }
    if (session === this.current.session) this.afterBusy();
  }

  /** The next page after the last row loaded (the owner's exclusive `nextCursor`, or the last row when the end was reached and more arrived). */
  async more(): Promise<void> {
    const state = this.current;
    if (state.busy || !state.watchId || state.base === null) return;
    const { session } = state;
    const after = state.nextCursor ?? state.entries.at(-1)?.sequence;
    this.set({ busy: "more", error: null });
    try {
      const page = await this.read({ id: state.watchId, ...(after !== undefined ? { after } : {}), limit: this.limit });
      if (session !== this.current.session) return;
      if (page.watch.acknowledgedThrough !== state.base) { await this.moved(session, state.base, page.watch.acknowledgedThrough); return; }
      const last = this.current.entries.at(-1)?.sequence ?? 0;
      this.set({ busy: null, watch: page.watch, entries: [...this.current.entries, ...page.entries.filter((entry) => entry.sequence > last)], pending: page.pending, through: page.through, nextCursor: page.nextCursor });
    } catch (error) {
      if (session !== this.current.session) return;
      const text = message(error);
      this.set(isGone(text) ? { busy: null, gone: true } : { busy: null, error: text });
    }
    if (session === this.current.session) this.afterBusy();
  }

  /** Ask for a refresh after a notice or reconnect. Notices coalesce; a burst reads once. A refresh never acknowledges. */
  invalidate(delay = 250): void {
    if (!this.current.watchId) return;
    this.dirty = true;
    if (this.timer || this.current.busy) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay);
  }

  private afterBusy(): void {
    if (this.dirty) { this.dirty = false; void this.refresh(); }
  }

  /**
   * Re-read the loaded range from the owner's cursor and replace the summaries in place (a cleanup changes a row's cleared
   * marker), taking the pending count and matched high-water from the answer. Later matches are not appended. If the owner's
   * cursor is not the one these rows follow, they are replaced and review starts over.
   */
  async refresh(): Promise<void> {
    this.dirty = false;
    const state = this.current;
    if (!state.watchId) return;
    if (state.busy) { this.dirty = true; return; }
    if (state.base === null) { await this.load(state.watchId, {}); return; }
    const { session, watchId, base } = state;
    const last = state.entries.at(-1)?.sequence ?? 0;
    this.set({ busy: "refresh" });
    try {
      const seen = new Map<number, GithubDelivery>();
      let after: number | undefined;
      let answer: GithubWatchRead | null = null;
      for (let pages = 0; pages < maxRefreshPages; pages++) {
        const page = await this.read({ id: watchId, ...(after !== undefined ? { after } : {}), limit: refreshPage });
        if (session !== this.current.session) return;
        answer = page;
        if (page.watch.acknowledgedThrough !== base) break;
        for (const entry of page.entries) seen.set(entry.sequence, entry);
        if (page.nextCursor === null || page.nextCursor >= last) break;
        after = page.nextCursor;
      }
      if (!answer) { this.set({ busy: null }); return; }
      if (answer.watch.acknowledgedThrough !== base) { await this.moved(session, base, answer.watch.acknowledgedThrough); return; }
      this.set({ busy: null, error: null, watch: answer.watch, pending: answer.pending, through: answer.through, entries: this.current.entries.map((entry) => seen.get(entry.sequence) ?? entry) });
    } catch (error) {
      if (session !== this.current.session) return;
      const text = message(error);
      this.set(isGone(text) ? { busy: null, gone: true } : { busy: null, error: text });
    }
    if (session === this.current.session) this.afterBusy();
  }

  private moved(session: number, from: number, to: number): Promise<void> {
    if (session !== this.current.session || !this.current.watchId) return Promise.resolve();
    return this.load(this.current.watchId, { notice: { kind: "moved", from, to } });
  }

  /* ----- review: marks only; nothing here reaches the owner ----- */

  mark(sequence: number, on: boolean): void {
    if (this.current.busy === "ack") return;
    this.set({ marked: toggleMark(this.current.marked, sequence, on), notice: null });
  }

  markThrough(sequence: number): void {
    if (this.current.busy === "ack") return;
    this.set({ marked: markThrough(this.current.entries, this.current.marked, sequence), notice: null });
  }

  clearMarks(): void { if (this.current.busy !== "ack") this.set({ marked: [], notice: null }); }

  /** Record that an entry's details were looked at. Opening is not marking and never acknowledges. */
  markOpened(sequence: number): void {
    if (!this.current.opened.includes(sequence)) this.set({ opened: [...this.current.opened, sequence] });
  }

  dismissNotice(): void { if (this.current.notice) this.set({ notice: null }); }

  /* ----- acknowledgement ----- */

  /**
   * Advance the watch's consumption cursor through the reviewed run, once, against the cursor these rows were read from.
   * It refuses unless that run is exactly what the person reviewed (and `through`, when given, is its end), and it is never
   * retried: a refusal or an unconfirmed result is shown, and the person decides.
   */
  async acknowledge(through?: number): Promise<"acknowledged" | "refused" | "conflict" | "unknown" | "not-offered"> {
    const state = this.current;
    const offer = acknowledgement(state);
    if (!offer.allowed || offer.plan.through === null || !state.watchId || state.base === null) return "not-offered";
    if (through !== undefined && through !== offer.plan.through) return "not-offered";
    if (offer.plan.through <= state.base) return "not-offered";
    const { session, watchId, base } = state;
    const target = offer.plan.through;
    this.set({ busy: "ack", error: null, notice: null });
    try {
      await this.acknowledgeCursor({ id: watchId, through: target, expectedAcknowledgedThrough: base });
    } catch (error) {
      if (session !== this.current.session) return "unknown";
      const text = message(error);
      if (isGone(text)) { this.set({ busy: null, gone: true }); return "refused"; }
      if (/github_watch_cursor_changed|github_cursor_invalid/.test(text)) {
        const code = /github_watch_cursor_changed/.test(text) ? "github_watch_cursor_changed" : "github_cursor_invalid";
        await this.load(watchId, { notice: { kind: "conflict", attempted: target, expected: base, now: null, code } });
        const now = this.current.watch?.acknowledgedThrough ?? null;
        if (this.current.notice?.kind === "conflict") this.set({ notice: { ...this.current.notice, now } });
        return "conflict";
      }
      return this.readBack(session, watchId, base, target, offer.plan, text);
    }
    if (session !== this.current.session) return "acknowledged";
    await this.load(watchId, { marked: state.marked, opened: state.opened, notice: { kind: "acknowledged", through: target, count: offer.plan.count, skipped: offer.plan.skipped, confirmedByReading: false } });
    return "acknowledged";
  }

  /** The owner's answer was lost or refused for another reason: read the cursor to learn what happened, and assume nothing. */
  private async readBack(session: number, id: string, base: number, target: number, plan: ReviewPlan, error: string): Promise<"acknowledged" | "refused" | "conflict" | "unknown"> {
    let page: GithubWatchRead;
    try { page = await this.read({ id, limit: this.limit }); } catch {
      if (session === this.current.session) this.set({ busy: null, notice: { kind: "unknown", attempted: target, expected: base, error } });
      return "unknown";
    }
    if (session !== this.current.session) return "unknown";
    const now = page.watch.acknowledgedThrough;
    if (now === base) {
      // Nothing moved: the request did not take effect. The rows and marks are still the reviewed ones.
      this.set({ busy: null, watch: page.watch, pending: page.pending, through: page.through, notice: { kind: "refused", attempted: target, error } });
      return "refused";
    }
    if (now === target) {
      await this.load(id, { marked: this.current.marked, opened: this.current.opened, notice: { kind: "acknowledged", through: target, count: plan.count, skipped: plan.skipped, confirmedByReading: true } });
      return "acknowledged";
    }
    await this.load(id, { notice: { kind: "conflict", attempted: target, expected: base, now, code: "cursor_elsewhere" } });
    return "conflict";
  }
}
