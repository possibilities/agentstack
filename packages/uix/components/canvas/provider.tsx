"use client";

import { createContext, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SpaceId } from "@/lib/stack/spaces";
import { ChatWindowStore, type ChatWindows } from "@/lib/stack/chat-windows";
import { StackStore, type StackConnections, type StackState } from "@/lib/stack/store";
import type { NodeRef, Snapshot, StackEvent } from "@/lib/stack/types";

const StoreContext = createContext<StackStore | null>(null);
const ChatWindowsContext = createContext<ChatWindowStore | null>(null);

export function StackProvider({ snapshot, children, connections }: { snapshot: Snapshot; children: React.ReactNode; connections?: StackConnections }) {
  const [store] = useState(() => new StackStore(snapshot));
  const [chats] = useState(() => new ChatWindowStore());
  useEffect(() => {
    store.start(connections);
    return () => store.stop();
  }, [store, connections]);
  useEffect(() => {
    if (!snapshot.remote) return;
    void store.syncRemote();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/connect/refresh", { method: "POST", cache: "no-store" }).then(response => {
        if (!response.ok) throw new Error("Remote session expired");
        void store.syncRemote();
      }).catch(() => { window.location.assign("/connect"); });
    };
    const timer = window.setInterval(refresh, 240_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [snapshot.remote, store]);
  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* optional persistence */ }
    chats.attach(storage);
  }, [chats]);
  const bots = useSyncExternalStore(store.subscribe, () => store.getState().bots.data, () => store.getServerState().bots.data);
  useEffect(() => { if (bots) chats.prune(new Set(bots.map((bot) => bot.id))); }, [bots, chats]);
  return <StoreContext value={store}><ChatWindowsContext value={chats}>{children}</ChatWindowsContext></StoreContext>;
}

/** Fleet chat windows and the store that arranges them. */
export function useChatWindows(): { windows: ChatWindows; chats: ChatWindowStore } {
  const chats = use(ChatWindowsContext);
  if (!chats) throw new Error("useChatWindows requires StackProvider");
  const windows = useSyncExternalStore(chats.subscribe, chats.getWindows, chats.getWindows);
  return { windows, chats };
}

export function useStore(): StackStore {
  const store = use(StoreContext);
  if (!store) throw new Error("useStore requires StackProvider");
  return store;
}

export function useStack(): StackState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getServerState);
}

/** Run one Package API operation with per-control pending and error state. */
export function useOperation<T = unknown>(pkg: string, name: string) {
  const store = useStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (args: Record<string, unknown> = {}): Promise<T> => {
    setPending(true);
    setError(null);
    try {
      return await store.call<T>(pkg, name, args);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setPending(false);
    }
  }, [store, pkg, name]);
  return { run, pending, error };
}

/** Event timestamps grouped by the Server id they were scoped to, plus package-level topics. */
export function useActivity(): Map<string, StackEvent[]> {
  const { events } = useStack();
  return useMemo(() => {
    const map = new Map<string, StackEvent[]>();
    for (const event of events) {
      const key = event.scope ? `bot:${event.scope}` : `${event.pkg}:${event.topic}`;
      map.set(key, [...(map.get(key) ?? []), event]);
    }
    return map;
  }, [events]);
}

export function useNow(interval = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

export type WorkbenchValue = {
  space: SpaceId;
  setSpace(space: SpaceId): void;
  selected: NodeRef | null;
  hovered: string | null;
  select(ref: NodeRef | null): void;
  hover(key: string | null): void;
  /** Reveal a spatial card or a dock destination; never implicitly inspect. */
  goTo(ref: NodeRef): void;
  /** The most recent goTo target; matches nodeKey values so cards can flash. */
  flash: { key: string; seq: number } | null;
};

export const WorkbenchContext = createContext<WorkbenchValue | null>(null);

export function useWorkbench(): WorkbenchValue {
  const value = use(WorkbenchContext);
  if (!value) throw new Error("useWorkbench requires WorkbenchContext");
  return value;
}
