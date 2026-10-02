import type { ProcRunFilter, ProcScheduleFilter } from "./proc";

/**
 * Which run each Proc-space Run window shows, which schedule the Schedule window
 * follows, and the Schedules and Runs lists' filters. The primary Run window
 * always exists and is the one choosing a run switches; additional windows keep
 * their run until closed. The arrangement and selection are browser-local and
 * optional: losing them only resets them. The filters are not kept.
 */
export type ProcRunWindow = { id: string; runId: string | null };
export type ProcRunWindows = readonly ProcRunWindow[];

export const primaryProcRun = "proc-run";
const storageKey = "uix.proc.v1";

type Saved = { windows?: unknown; selectedScheduleId?: unknown };
type Listener = () => void;

export class ProcWindowStore {
  private windows: ProcRunWindows = [{ id: primaryProcRun, runId: null }];
  private selected: string | null = null;
  private scheduleFilter: ProcScheduleFilter = {};
  private runFilter: ProcRunFilter = {};
  private readonly serverWindows = this.windows;
  private readonly serverScheduleFilter = this.scheduleFilter;
  private readonly serverRunFilter = this.runFilter;
  private listeners = new Set<Listener>();
  private storage: Pick<Storage, "getItem" | "setItem"> | null = null;

  /** Restore after hydration, so the first client render matches the server's. */
  attach(storage: Pick<Storage, "getItem" | "setItem"> | null): void {
    this.storage = storage;
    try {
      const saved: Saved = JSON.parse(storage?.getItem(storageKey) ?? "null") ?? {};
      if (Array.isArray(saved.windows)) this.windows = normalize(saved.windows);
      if (typeof saved.selectedScheduleId === "string" && saved.selectedScheduleId) this.selected = saved.selectedScheduleId;
      this.emit();
    } catch { /* optional persistence */ }
  }

  getWindows = (): ProcRunWindows => this.windows;
  getSelected = (): string | null => this.selected;
  getScheduleFilter = (): ProcScheduleFilter => this.scheduleFilter;
  getRunFilter = (): ProcRunFilter => this.runFilter;
  /** Benches may hydrate after attach; keep the snapshots SSR rendered. */
  getServerWindows = (): ProcRunWindows => this.serverWindows;
  getServerSelected = (): string | null => null;
  getServerScheduleFilter = (): ProcScheduleFilter => this.serverScheduleFilter;
  getServerRunFilter = (): ProcRunFilter => this.serverRunFilter;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reveal the window already showing this run, else switch the primary window to it. Returns the window to reveal. */
  showRun(runId: string): string {
    const existing = this.windows.find((window) => window.runId === runId);
    if (existing) return existing.id;
    this.setWindows(this.windows.map((window) => window.id === primaryProcRun ? { ...window, runId } : window));
    return primaryProcRun;
  }

  /** Add a window for this run beside the others. Returns its ID. */
  open(runId: string | null): string {
    const taken = new Set(this.windows.map((window) => window.id));
    let n = 2;
    while (taken.has(`proc-run-${n}`)) n++;
    const id = `proc-run-${n}`;
    this.setWindows([...this.windows, { id, runId }]);
    return id;
  }

  /** The primary window stays; closing it clears its run instead. */
  close(id: string): void {
    this.setWindows(id === primaryProcRun
      ? this.windows.map((window) => window.id === id ? { ...window, runId: null } : window)
      : this.windows.filter((window) => window.id !== id));
  }

  /** The Schedule window follows this selection. */
  selectSchedule(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.persist();
    this.emit();
  }

  setScheduleFilter(filter: ProcScheduleFilter): void {
    this.scheduleFilter = filter;
    this.emit();
  }

  setRunFilter(filter: ProcRunFilter): void {
    this.runFilter = filter;
    this.emit();
  }

  private setWindows(windows: ProcRunWindow[]): void {
    this.windows = windows;
    this.persist();
    this.emit();
  }

  private persist(): void {
    try {
      this.storage?.setItem(storageKey, JSON.stringify({ windows: this.windows, selectedScheduleId: this.selected } satisfies Saved));
    } catch { /* optional persistence */ }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalize(saved: unknown[]): ProcRunWindow[] {
  const seen = new Set<string>();
  const windows: ProcRunWindow[] = [];
  for (const value of saved) {
    if (!value || typeof value !== "object") continue;
    const { id, runId } = value as Record<string, unknown>;
    if (typeof id !== "string" || !/^proc-run(-[1-9][0-9]*)?$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    windows.push({ id, runId: typeof runId === "string" && runId ? runId : null });
  }
  const primary = windows.find((window) => window.id === primaryProcRun) ?? { id: primaryProcRun, runId: null };
  return [primary, ...windows.filter((window) => window.id !== primaryProcRun)];
}
