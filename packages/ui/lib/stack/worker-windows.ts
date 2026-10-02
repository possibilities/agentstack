import type { WorkerFilter } from "./workers";

/**
 * Which Worker each Workers-space window shows, and the Workers list's filter.
 * The primary window always exists and is the one choosing a Worker switches;
 * additional windows keep their own Worker until closed. The arrangement is
 * browser-local and optional: losing it only resets it. The filter is not kept.
 */
export type WorkerWindow = { id: string; workerId: string | null };
export type WorkerWindows = readonly WorkerWindow[];
/** An exact-turn focus request for one Worker window; transient, never persisted. `seq` distinguishes repeat focuses. */
export type TurnFocus = { windowId: string; workerId: string; turnId: string; seq: number };

export const primaryWorker = "worker";
const storageKey = "stack.uix.workers.v1";

type Listener = () => void;

export class WorkerWindowStore {
  private windows: WorkerWindows = [{ id: primaryWorker, workerId: null }];
  private filter: WorkerFilter = {};
  private turnFocus: TurnFocus | null = null;
  private focusSeq = 0;
  private readonly serverWindows = this.windows;
  private readonly serverFilter = this.filter;
  private listeners = new Set<Listener>();
  private storage: Pick<Storage, "getItem" | "setItem"> | null = null;

  /** Restore after hydration, so the first client render matches the server's. */
  attach(storage: Pick<Storage, "getItem" | "setItem"> | null): void {
    this.storage = storage;
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
      if (Array.isArray(saved)) {
        this.windows = normalize(saved);
        this.emit();
      }
    } catch { /* optional persistence */ }
  }

  getWindows = (): WorkerWindows => this.windows;
  getFilter = (): WorkerFilter => this.filter;
  getTurnFocus = (): TurnFocus | null => this.turnFocus;
  /** Benches may hydrate after attach; keep the snapshots SSR rendered. */
  getServerWindows = (): WorkerWindows => this.serverWindows;
  getServerFilter = (): WorkerFilter => this.serverFilter;
  /** Turn focus is never persisted; SSR always renders without one. */
  getServerTurnFocus = (): TurnFocus | null => null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reveal the window already showing this Worker, else switch the primary window to it. Returns the window to reveal. */
  show(workerId: string): string {
    const existing = this.windows.find((window) => window.workerId === workerId);
    if (existing) return existing.id;
    this.set(this.windows.map((window) => window.id === primaryWorker ? { ...window, workerId } : window));
    return primaryWorker;
  }

  /** Reveal the window showing this Worker and focus one exact turn in its Turns view. Returns the window to reveal. */
  showTurn(workerId: string, turnId: string): string {
    const id = this.show(workerId);
    this.turnFocus = { windowId: id, workerId, turnId, seq: ++this.focusSeq };
    this.emit();
    return id;
  }

  /** Add a window for this Worker beside the others. Returns its ID. */
  open(workerId: string | null): string {
    const taken = new Set(this.windows.map((window) => window.id));
    let n = 2;
    while (taken.has(`worker-${n}`)) n++;
    const id = `worker-${n}`;
    this.set([...this.windows, { id, workerId }]);
    return id;
  }

  setWorker(id: string, workerId: string | null): void {
    this.set(this.windows.map((window) => window.id === id ? { ...window, workerId } : window));
  }

  /** The primary window stays; closing it clears its Worker instead. */
  close(id: string): void {
    this.set(id === primaryWorker ? this.windows.map((window) => window.id === id ? { ...window, workerId: null } : window) : this.windows.filter((window) => window.id !== id));
  }

  /** Forget windows whose Worker was removed; the primary empties instead. */
  prune(workerIds: ReadonlySet<string>): void {
    const next = this.windows.flatMap((window) => !window.workerId || workerIds.has(window.workerId) ? [window] : window.id === primaryWorker ? [{ ...window, workerId: null }] : []);
    if (next.length !== this.windows.length || next.some((window, index) => window !== this.windows[index])) this.set(next);
  }

  setFilter(filter: WorkerFilter): void {
    this.filter = filter;
    this.emit();
  }

  private set(windows: WorkerWindow[]): void {
    this.windows = windows;
    try { this.storage?.setItem(storageKey, JSON.stringify(windows)); } catch { /* optional persistence */ }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalize(saved: unknown[]): WorkerWindow[] {
  const seen = new Set<string>();
  const windows: WorkerWindow[] = [];
  for (const value of saved) {
    if (!value || typeof value !== "object") continue;
    const { id, workerId } = value as Record<string, unknown>;
    if (typeof id !== "string" || !/^worker(-[1-9][0-9]*)?$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    windows.push({ id, workerId: typeof workerId === "string" && workerId ? workerId : null });
  }
  const primary = windows.find((window) => window.id === primaryWorker) ?? { id: primaryWorker, workerId: null };
  return [primary, ...windows.filter((window) => window.id !== primaryWorker)];
}
