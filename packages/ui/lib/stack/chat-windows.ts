/**
 * Which Bot each Fleet chat window shows. The primary window always exists and
 * is the one a Bot card switches; additional windows keep their own Bot until
 * closed. Browser-local and optional: losing it only resets the arrangement.
 */
export type ChatWindow = { id: string; botId: string | null };
export type ChatWindows = readonly ChatWindow[];

export const primaryChat = "chat";
/** Names within a destination's storage (destination.ts adds the namespace). */
const storageKey = "uix.chats.v1";

type Listener = () => void;

export class ChatWindowStore {
  private windows: ChatWindows = [{ id: primaryChat, botId: null }];
  private readonly serverWindows = this.windows;
  private listeners = new Set<Listener>();
  private storage: Pick<Storage, "getItem" | "setItem"> | null = null;

  /** Restore after hydration, so the first client render matches the server's. */
  attach(storage: Pick<Storage, "getItem" | "setItem"> | null): void {
    this.storage = storage;
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
      if (Array.isArray(saved)) {
        this.windows = normalize(saved);
        for (const listener of this.listeners) listener();
      }
    } catch { /* optional persistence */ }
  }

  getWindows = (): ChatWindows => this.windows;
  /** Benches may hydrate after attach; keep the snapshot SSR rendered. */
  getServerWindows = (): ChatWindows => this.serverWindows;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reveal the window already showing this Bot, else switch the primary window to it. Returns the window to reveal. */
  show(botId: string): string {
    const existing = this.windows.find((window) => window.botId === botId);
    if (existing) return existing.id;
    this.set(this.windows.map((window) => window.id === primaryChat ? { ...window, botId } : window));
    return primaryChat;
  }

  /** Add a window for this Bot beside the others. Returns its ID. */
  open(botId: string | null): string {
    const taken = new Set(this.windows.map((window) => window.id));
    let n = 2;
    while (taken.has(`chat-${n}`)) n++;
    const id = `chat-${n}`;
    this.set([...this.windows, { id, botId }]);
    return id;
  }

  setBot(id: string, botId: string | null): void {
    this.set(this.windows.map((window) => window.id === id ? { ...window, botId } : window));
  }

  /** The primary window stays; closing it clears its Bot instead. */
  close(id: string): void {
    this.set(id === primaryChat ? this.windows.map((window) => window.id === id ? { ...window, botId: null } : window) : this.windows.filter((window) => window.id !== id));
  }

  /** Forget windows whose Bot was removed; the primary empties instead. */
  prune(botIds: ReadonlySet<string>): void {
    const next = this.windows.flatMap((window) => !window.botId || botIds.has(window.botId) ? [window] : window.id === primaryChat ? [{ ...window, botId: null }] : []);
    if (next.length !== this.windows.length || next.some((window, index) => window !== this.windows[index])) this.set(next);
  }

  private set(windows: ChatWindow[]): void {
    this.windows = windows;
    try { this.storage?.setItem(storageKey, JSON.stringify(windows)); } catch { /* optional persistence */ }
    for (const listener of this.listeners) listener();
  }
}

function normalize(saved: unknown[]): ChatWindow[] {
  const seen = new Set<string>();
  const windows: ChatWindow[] = [];
  for (const value of saved) {
    if (!value || typeof value !== "object") continue;
    const { id, botId } = value as Record<string, unknown>;
    if (typeof id !== "string" || !/^chat(-[1-9][0-9]*)?$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    windows.push({ id, botId: typeof botId === "string" && botId ? botId : null });
  }
  const primary = windows.find((window) => window.id === primaryChat) ?? { id: primaryChat, botId: null };
  return [primary, ...windows.filter((window) => window.id !== primaryChat)];
}
