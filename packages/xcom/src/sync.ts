import { setTimeout as delay } from "node:timers/promises";
import { FeedError, fetchArticle, fetchPage, type FeedPage } from "./feed.js";
import { ArchiveStore, twoMonthsAgo, type Post } from "./store.js";

export type SyncMode = "auto" | "head" | "backfill" | "articles";
export type SyncState = { running: boolean; mode: Exclude<SyncMode, "auto"> | null;
  started_at: string | null; last_finished_at: string | null; last_error: string | null;
  pages: number; new_posts: number; new_articles: number };
export type Provider = { page(cursor: string | null, signal: AbortSignal): Promise<FeedPage>;
  article(id: string, signal: AbortSignal): Promise<Post> };

const HOUR = 3_600_000;
const HEAD_INTERVAL = 6 * HOUR;
const RETRIES = [60_000, 120_000, 240_000];

export class ArchiveSync {
  readonly controller = new AbortController();
  readonly state: SyncState = { running: false, mode: null, started_at: null, last_finished_at: null,
    last_error: null, pages: 0, new_posts: 0, new_articles: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private task: Promise<void> | null = null;
  private lastCall = 0;
  private runController = new AbortController();
  private get signal() { return AbortSignal.any([this.controller.signal, this.runController.signal]); }
  get paused() { return this.store.meta("paused") === "true"; }
  control(paused: boolean) { this.store.setMeta("paused", String(paused)); if (paused) this.runController.abort(); return { paused, running: this.state.running }; }
  requireQuiescent() { if (!this.paused || this.task) throw new Error("Pause Xcom and wait for running=false before state maintenance"); }

  constructor(readonly store: ArchiveStore, readonly provider: Provider,
    readonly options: { now?: () => Date; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
      delayMin?: number; delayMax?: number; auto?: boolean } = {}) {
    if (options.auto !== false) {
      this.timer = setInterval(() => { this.start("auto"); }, HOUR);
      this.timer.unref();
      queueMicrotask(() => { if (!this.controller.signal.aborted) this.start("auto"); });
    }
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private async sleep(ms: number): Promise<void> {
    if (this.options.sleep) await this.options.sleep(ms, this.signal);
    else await delay(ms, undefined, { signal: this.signal });
    this.signal.throwIfAborted();
  }
  private async paced<T>(call: () => Promise<T>): Promise<T> {
    const min = this.options.delayMin ?? 20_000, max = this.options.delayMax ?? 40_000;
    if (this.lastCall) await this.sleep(Math.max(0, this.lastCall + min + Math.random() * (max - min) - Date.now()));
    this.lastCall = Date.now();
    this.signal.throwIfAborted();
    return call();
  }
  private async retry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0;; attempt++) {
      try { return await this.paced(call); }
      catch (error) {
        if (!(error instanceof FeedError) || !error.transient || attempt === RETRIES.length) throw error;
        await this.sleep(RETRIES[attempt]! * (1 + Math.random() * 0.2));
      }
    }
  }
  private choose(mode: SyncMode): Exclude<SyncMode, "auto"> | null {
    if (mode !== "auto") return mode;
    const last = this.store.meta("last_head_start");
    if (this.store.scan(2) || !last || this.now().getTime() - Date.parse(last) >= HEAD_INTERVAL) return "head";
    if (this.store.scan(1) || !this.store.meta("last_complete_start")) return "backfill";
    // Unfetched article bodies can be caught up between head runs.
    return this.store.pendingArticles(1, this.now()).length ? "articles" : null;
  }
  start(mode: SyncMode): { started: boolean; mode: Exclude<SyncMode, "auto"> | null } {
    if (this.controller.signal.aborted) throw new Error("xcom is stopping");
    if (this.paused) return { started: false, mode: null };
    if (this.task) return { started: false, mode: this.state.mode };
    this.runController = new AbortController();
    const chosen = this.choose(mode);
    if (!chosen) return { started: false, mode: null };
    Object.assign(this.state, { running: true, mode: chosen, started_at: this.now().toISOString(),
      last_error: null, pages: 0, new_posts: 0, new_articles: 0 });
    this.task = this.run(chosen).catch(error => {
      if (!this.controller.signal.aborted) this.state.last_error = String((error as Error).message).slice(0, 350);
    }).finally(() => {
      this.state.running = false;
      this.state.last_finished_at = this.now().toISOString();
      this.task = null;
    });
    return { started: true, mode: chosen };
  }
  private async run(mode: Exclude<SyncMode, "auto">): Promise<void> {
    if (mode !== "articles") {
      const id = mode === "backfill" ? 1 : 2;
      let scan = this.store.scan(id);
      if (!scan) {
        scan = this.store.begin(id, this.now(), twoMonthsAgo(this.now()));
      }
      const budget = 50;
      for (let i = 0; i < budget && !this.controller.signal.aborted; i++) {
        if (scan.pages >= 1500) { this.store.transaction(() => this.store.finish(scan!, "page_cap")); break; }
        // A failed page never advances its cursor. No page is silently skipped.
        const page = await this.retry(() => this.provider.page(scan!.cursor, this.signal));
        this.signal.throwIfAborted();
        const result = this.store.savePage(scan, page.posts, page.nextCursor, this.now());
        this.state.pages++;
        this.state.new_posts += result.saved;
        if (result.finished) break;
        // A bounded batch retains the cursor; the next wake resumes it. Dropping
        // the cursor here could permanently skip posts beyond the first batch.
        scan = this.store.scan(id)!;
      }
    }
    if (!this.controller.signal.aborted) await this.articles(mode === "articles" ? 50 : 10);
  }
  private async articles(limit: number): Promise<void> {
    for (const id of this.store.pendingArticles(limit, this.now())) {
      if (this.controller.signal.aborted) break;
      try {
        const article = await this.retry(() => this.provider.article(id, this.signal));
        this.signal.throwIfAborted();
        this.store.saveArticle(id, article, this.now());
        this.state.new_articles++;
      } catch (error) {
        this.signal.throwIfAborted();
        if (error instanceof FeedError && error.code === "not_found") {
          this.store.articleMissing(id, error.message, this.now());
          continue;
        }
        // Feed progress remains committed; article failures are reported and retried later.
        throw error;
      }
    }
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.task;
  }
}

export function cliProvider(binary: string): Provider {
  return { page: (cursor, signal) => fetchPage(binary, cursor, signal),
    article: (id, signal) => fetchArticle(binary, id, signal) };
}
