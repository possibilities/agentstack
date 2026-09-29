import { Channel } from "./channel";
import type { StackStore } from "./store";
import { activityOf, applyLive, applyNewest, applyOlder, emptyTranscript, entriesOf, historyRow, liveRow, turnEnds,
  type ChatActivity, type ChatEntry, type ChatTurnEnd, type TranscriptRow, type TranscriptState } from "./transcript";
import type { Bot, MainChatItems, MainChatLive } from "./types";

export type MainChatStatus = "loading" | "ready" | "stopped" | "no-thread" | "missing" | "error";

export type MainChatView = {
  botId: string;
  threadId: string | null;
  status: MainChatStatus;
  error: string | null;
  entries: ChatEntry[];
  turnEnds: ReadonlyMap<string, ChatTurnEnd>;
  active: (ChatActivity & { turnId: string; startedAt: number | null }) | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** Increments when older entries are prepended, so a view can hold its reading position. */
  prepends: number;
};

/** Enough visible history to fill a tall window before the reader asks for more. */
const wantedEntries = 24;
const pageSize = 50;
const maxInitialPages = 8;
/** Switching back to a recently shown Bot reuses its transcript instantly. */
const linger = 60_000;

type Identity = { url: string | null; threadId: string | null; running: boolean };

function identity(bot: Bot | undefined): Identity {
  const running = bot?.state === "running" && !bot.recoveryIssue && Boolean(bot.runningAccount);
  return { url: running ? bot!.url : null, threadId: bot?.mainThreadId ?? null, running };
}

/**
 * Follows one Bot's main thread for any number of chat windows: native history
 * pages newest first, then incremental live reads after each coalesced
 * `chat_live_changed` notice. History refreshes after `chats_changed`.
 * Notices carry nothing, so every (re)subscription resnapshots.
 */
export class MainChatFeed {
  readonly botId: string;
  private store: StackStore;
  private listeners = new Set<() => void>();
  private channel: Channel | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private current: Identity = { url: null, threadId: null, running: false };
  /** Bot inventory state the current connection was derived from. */
  private key = "";
  private generation = 0;
  private transcript: TranscriptState = emptyTranscript;
  private cache = new Map<string, { row: TranscriptRow; entry: ChatEntry | null }>();
  private cursor: string | null = null;
  private live: { instance: string; revision: number } | null = null;
  private activeTurnId: string | null = null;
  private activeTurnStartedAt: number | null = null;
  private inflight = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  /** Without chat_live_changed (an older server), follow an active turn by polling. */
  private poll: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private view: MainChatView;

  constructor(store: StackStore, botId: string) {
    this.store = store;
    this.botId = botId;
    this.view = { botId, threadId: null, status: "loading", error: null, entries: [], turnEnds: new Map(), active: null, hasOlder: false, loadingOlder: false, prepends: 0 };
  }

  getView = (): MainChatView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.unsubscribeStore = this.store.subscribe(() => this.sync());
    this.sync(true);
  }

  dispose(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.channel?.dispose();
    this.channel = null;
    this.generation++;
    if (this.poll) clearTimeout(this.poll);
  }

  /** Page one step further back; a no-op while one is running or history is exhausted. */
  loadOlder = (): void => {
    if (!this.cursor || this.view.loadingOlder) return;
    this.set({ loadingOlder: true });
    const generation = this.generation;
    void this.olderPage().catch((error: Error) => this.fail(generation, error)).finally(() => {
      if (generation === this.generation) this.set({ loadingOlder: false });
    });
  };

  private sync(force = false): void {
    const bots = this.store.getState().bots.data;
    const bot = bots?.find((item) => item.id === this.botId);
    const next = identity(bot);
    const key = JSON.stringify([bots ? 1 : 0, bot ? 1 : 0, next.url, next.threadId, next.running]);
    if (!force && key === this.key) return;
    this.key = key;
    this.current = next;
    this.generation++;
    this.channel?.dispose();
    this.channel = null;
    if (this.poll) clearTimeout(this.poll);
    this.transcript = emptyTranscript;
    this.cache = new Map();
    this.cursor = null;
    this.live = null;
    this.activeTurnId = null;
    this.activeTurnStartedAt = null;
    this.inflight.clear();
    this.dirty.clear();
    const status: MainChatStatus = !this.store.getState().bots.data ? "loading" : !bot ? "missing" : !next.running ? "stopped" : !next.threadId ? "no-thread" : "loading";
    this.view = { ...this.view, threadId: next.threadId, status, error: null, entries: [], turnEnds: new Map(), active: null, hasOlder: false, loadingOlder: false };
    this.emit();
    if (status !== "loading" || !bot) return;
    const endpoint = this.store.getState().endpoints.bots;
    if (!endpoint) return this.set({ status: "error", error: "bots WebSocket is not configured" });
    const generation = this.generation;
    const channel = new Channel(endpoint, "bots", {
      onOpen: () => { if (generation === this.generation) this.snapshot(); },
      onNotice: (topic) => {
        if (generation !== this.generation) return;
        // Polling notices turn starts through chats_changed.
        if (topic === "chat_live_changed" || (topic === "chats_changed" && this.polling)) this.run("live", () => this.readLive());
        if (topic === "chats_changed") this.run("newest", () => this.readNewest());
      },
      onError: () => {
        // An server without chat_live_changed rejects the whole subscription.
        if (generation !== this.generation || this.polling) return;
        this.polling = true;
        channel.subscribe(["chats_changed"], this.botId);
        this.run("live", () => this.readLive());
      },
    });
    this.channel = channel;
    channel.subscribe(this.polling ? ["chats_changed"] : ["chats_changed", "chat_live_changed"], this.botId).connect();
  }

  private snapshot(): void {
    const generation = this.generation;
    this.live = null;
    this.cursor = null;
    this.transcript = emptyTranscript;
    this.cache = new Map();
    void (async () => {
      await this.readLive();
      await this.readNewest();
      // Tool-heavy threads can hold few messages per page.
      for (let page = 1; page < maxInitialPages && this.cursor && this.view.entries.length < wantedEntries && generation === this.generation; page++) await this.olderPage();
      if (generation === this.generation) this.set({ status: "ready", error: null });
    })().catch((error: Error) => this.fail(generation, error));
  }

  /** Coalesce reads of one kind: at most one running and one queued. */
  private run(kind: string, read: () => Promise<void>): void {
    if (this.inflight.has(kind)) { this.dirty.add(kind); return; }
    const generation = this.generation;
    const task = read().catch((error: Error) => this.fail(generation, error)).finally(() => {
      if (this.inflight.get(kind) === task) this.inflight.delete(kind);
      if (generation === this.generation && this.dirty.delete(kind)) this.run(kind, read);
    });
    this.inflight.set(kind, task);
  }

  private call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const channel = this.channel;
    if (!channel || channel.status !== "open") return Promise.reject(new Error("bots WebSocket is not connected"));
    return channel.call<T>(name, { botId: this.botId, ...args });
  }

  private async readLive(): Promise<void> {
    const generation = this.generation;
    const result = await this.call<MainChatLive>("chat_main_live", this.live ? { after: this.live } : {});
    if (generation !== this.generation || result.threadId !== this.current.threadId) return;
    // An older server has no incremental reads and rejects `after`: every reply is a full snapshot.
    const incremental = typeof result.reset === "boolean";
    const reset = result.reset ?? true;
    const now = Date.now();
    const rows = result.items.flatMap((entry) => liveRow(entry, now) ?? []);
    this.live = result.instance && incremental ? { instance: result.instance, revision: result.revision } : null;
    const ended = this.activeTurnId !== null && result.activeTurnId !== this.activeTurnId;
    this.activeTurnId = result.activeTurnId;
    this.activeTurnStartedAt = result.activeTurnStartedAt ?? this.activeTurnStartedAt ?? (result.activeTurnId ? now : null);
    if (!result.activeTurnId) this.activeTurnStartedAt = null;
    this.commit(applyLive(this.transcript, rows, reset));
    // A finished turn's canonical items and times arrive through history.
    if (ended) this.run("newest", () => this.readNewest());
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    if (!this.polling || !this.activeTurnId) return;
    const generation = this.generation;
    this.poll = setTimeout(() => { if (generation === this.generation) this.run("live", () => this.readLive()); }, 120);
  }

  private async readNewest(): Promise<void> {
    const generation = this.generation;
    const rows: TranscriptRow[] = [];
    let cursor: string | undefined;
    // Without canonical rows yet, the newest page starts the transcript.
    const fresh = !this.transcript.order.some((key) => this.transcript.rows.get(key)!.final);
    // Otherwise page back until the newest pages reach rows already shown.
    for (let page = 0; page < maxInitialPages; page++) {
      const result = await this.call<MainChatItems>("chat_main_items", { limit: pageSize, ...(cursor ? { cursor } : {}) });
      if (generation !== this.generation || result.threadId !== this.current.threadId) return;
      rows.push(...result.data.flatMap((entry) => historyRow(entry, this.activeTurnId) ?? []));
      cursor = result.nextCursor ?? undefined;
      if (fresh || !cursor || rows.some((row) => this.transcript.rows.get(row.key)?.final)) break;
    }
    const { state, contiguous } = applyNewest(this.transcript, rows);
    if (fresh || !contiguous) this.cursor = cursor ?? null;
    this.commit(state);
    if (!contiguous) {
      this.live = null;
      await this.readLive();
    }
  }

  private async olderPage(): Promise<void> {
    const generation = this.generation;
    const cursor = this.cursor;
    if (!cursor) return;
    const result = await this.call<MainChatItems>("chat_main_items", { limit: pageSize, cursor });
    if (generation !== this.generation || result.threadId !== this.current.threadId || this.cursor !== cursor) return;
    this.cursor = result.nextCursor;
    const before = this.view.entries.length;
    this.commit(applyOlder(this.transcript, result.data.flatMap((entry) => historyRow(entry, this.activeTurnId) ?? [])));
    if (this.view.entries.length !== before) this.set({ prepends: this.view.prepends + 1 });
  }

  private commit(state: TranscriptState): void {
    const changed = state !== this.transcript;
    this.transcript = state;
    const { entries, cache } = changed ? entriesOf(state, this.cache) : { entries: this.view.entries, cache: this.cache };
    this.cache = cache;
    const same = entries.length === this.view.entries.length && entries.every((entry, index) => entry === this.view.entries[index]);
    const activity = activityOf(state, this.activeTurnId);
    const active = activity && this.activeTurnId ? { ...activity, turnId: this.activeTurnId, startedAt: this.activeTurnStartedAt } : null;
    const previous = this.view.active;
    const activeSame = previous === active || (previous && active && previous.turnId === active.turnId && previous.phase === active.phase
      && previous.headline === active.headline && previous.startedAt === active.startedAt);
    const hasOlder = this.cursor !== null;
    if (same && activeSame && hasOlder === this.view.hasOlder && !changed) return;
    this.set({ entries: same ? this.view.entries : entries, turnEnds: turnEnds(state, entries, this.activeTurnId),
      active: activeSame ? previous : active, hasOlder });
  }

  private fail(generation: number, error: Error): void {
    if (generation !== this.generation) return;
    // A stopped or restarted Bot resolves through bots_changed; keep showing what was read.
    this.set({ status: this.view.entries.length ? "ready" : "error", error: error.message });
  }

  private set(patch: Partial<MainChatView>): void {
    this.view = { ...this.view, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

type Held = { feed: MainChatFeed; holders: number; timer: ReturnType<typeof setTimeout> | null };
const feeds = new WeakMap<StackStore, Map<string, Held>>();

/** Share one feed per Bot across chat windows; release lingers so switching back is instant. */
export function holdMainChat(store: StackStore, botId: string): { feed: MainChatFeed; release(): void } {
  let byBot = feeds.get(store);
  if (!byBot) feeds.set(store, byBot = new Map());
  let held = byBot.get(botId);
  if (!held) {
    const feed = new MainChatFeed(store, botId);
    feed.start();
    held = { feed, holders: 0, timer: null };
    byBot.set(botId, held);
  }
  const entry = held;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.holders++;
  let released = false;
  return {
    feed: entry.feed,
    release() {
      if (released) return;
      released = true;
      if (--entry.holders > 0) return;
      entry.timer = setTimeout(() => {
        if (entry.holders > 0) return;
        entry.feed.dispose();
        byBot!.delete(botId);
      }, linger);
    },
  };
}
