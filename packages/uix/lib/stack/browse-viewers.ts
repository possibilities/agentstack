import type { BrowseCallError } from "./browse";

/**
 * Which Browser profile each Browse viewer window shows, and this page's human control grants.
 * The primary viewer always exists and is the one choosing a profile switches; additional viewers
 * keep their own profile until closed. The arrangement is browser-local and optional: losing it
 * only resets it. Grants are human input URLs and live only in this page's memory.
 */
export type ViewerWindow = { id: string; profileId: string | null };
export type ViewerWindows = readonly ViewerWindow[];
/** Human control URLs by handoff ID, from this page's own take. */
export type ControlGrants = Readonly<Record<string, string>>;
/** This page's latest take or finish per handoff: in flight, or failed with the choice a retry reuses. */
export type HandoffActionState = { kind: "take" | "finish"; choice: { outcome?: "completed" | "skipped"; note?: string }; pending: boolean; error: BrowseCallError | null };
export type HandoffActions = Readonly<Record<string, HandoffActionState>>;

export const primaryViewer = "browse-viewer";
const storageKey = "agentstack.uix.browse-viewers.v1";

type Listener = () => void;

// Benches hydrate lazily, possibly after the saved arrangement is restored: hydration must see what the server rendered.
const serverWindows: ViewerWindows = [{ id: primaryViewer, profileId: null }];
const serverGrants: ControlGrants = {};
const serverActions: HandoffActions = {};

export class ViewerWindowStore {
  private windows: ViewerWindows = [{ id: primaryViewer, profileId: null }];
  private grants: ControlGrants = {};
  private actions: HandoffActions = {};
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

  getWindows = (): ViewerWindows => this.windows;
  getGrants = (): ControlGrants => this.grants;
  getActions = (): HandoffActions => this.actions;
  getServerWindows = (): ViewerWindows => serverWindows;
  getServerGrants = (): ControlGrants => serverGrants;
  getServerActions = (): HandoffActions => serverActions;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reveal the viewer already showing this profile, else switch the primary one to it. Returns the window to reveal. */
  show(profileId: string): string {
    const existing = this.windows.find((window) => window.profileId === profileId);
    if (existing) return existing.id;
    this.set(this.windows.map((window) => window.id === primaryViewer ? { ...window, profileId } : window));
    return primaryViewer;
  }

  /** Add a viewer for this profile beside the others. Returns its ID. */
  open(profileId: string | null): string {
    const taken = new Set(this.windows.map((window) => window.id));
    let n = 2;
    while (taken.has(`${primaryViewer}-${n}`)) n++;
    const id = `${primaryViewer}-${n}`;
    this.set([...this.windows, { id, profileId }]);
    return id;
  }

  setProfile(id: string, profileId: string | null): void {
    this.set(this.windows.map((window) => window.id === id ? { ...window, profileId } : window));
  }

  /** The primary viewer stays; closing it clears its profile instead. Closing never resolves a handoff. */
  close(id: string): void {
    this.set(id === primaryViewer ? this.windows.map((window) => window.id === id ? { ...window, profileId: null } : window) : this.windows.filter((window) => window.id !== id));
  }

  /** Forget viewers whose profile was deleted; the primary empties instead. */
  prune(profileIds: ReadonlySet<string>): void {
    const next = this.windows.flatMap((window) => !window.profileId || profileIds.has(window.profileId) ? [window] : window.id === primaryViewer ? [{ ...window, profileId: null }] : []);
    if (next.length !== this.windows.length || next.some((window, index) => window !== this.windows[index])) this.set(next);
  }

  grant(handoffId: string, url: string | null): void {
    if ((this.grants[handoffId] ?? null) === url) return;
    const next = { ...this.grants };
    if (url) next[handoffId] = url; else delete next[handoffId];
    this.grants = next;
    this.emit();
  }

  setAction(handoffId: string, state: HandoffActionState | null): void {
    const next = { ...this.actions };
    if (state) next[handoffId] = state; else delete next[handoffId];
    this.actions = next;
    this.emit();
  }

  /** Drop grants for handoffs no longer under human control; the API has revoked them. */
  pruneGrants(controlling: ReadonlySet<string>): void {
    const stale = Object.keys(this.grants).filter((id) => !controlling.has(id));
    if (!stale.length) return;
    const next = { ...this.grants };
    for (const id of stale) delete next[id];
    this.grants = next;
    this.emit();
  }

  private set(windows: ViewerWindow[]): void {
    this.windows = windows;
    try { this.storage?.setItem(storageKey, JSON.stringify(windows)); } catch { /* optional persistence */ }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalize(saved: unknown[]): ViewerWindow[] {
  const seen = new Set<string>();
  const windows: ViewerWindow[] = [];
  const pattern = new RegExp(`^${primaryViewer}(-[1-9][0-9]*)?$`);
  for (const value of saved) {
    if (!value || typeof value !== "object") continue;
    const { id, profileId } = value as Record<string, unknown>;
    if (typeof id !== "string" || !pattern.test(id) || seen.has(id)) continue;
    seen.add(id);
    windows.push({ id, profileId: typeof profileId === "string" && profileId ? profileId : null });
  }
  const primary = windows.find((window) => window.id === primaryViewer) ?? { id: primaryViewer, profileId: null };
  return [primary, ...windows.filter((window) => window.id !== primaryViewer)];
}
