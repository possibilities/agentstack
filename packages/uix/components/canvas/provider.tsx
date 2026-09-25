"use client";

import { createContext, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SpaceId } from "@/lib/stack/spaces";
import { StackStore, type StackConnections, type StackState } from "@/lib/stack/store";
import type { NodeRef, Snapshot, StackEvent } from "@/lib/stack/types";

const StoreContext = createContext<StackStore | null>(null);

export function StackProvider({ snapshot, children, connections }: { snapshot: Snapshot; children: React.ReactNode; connections?: StackConnections }) {
  const [store] = useState(() => new StackStore(snapshot));
  useEffect(() => {
    store.start(connections);
    return () => store.stop();
  }, [store, connections]);
  return <StoreContext value={store}>{children}</StoreContext>;
}

export function useStore(): StackStore {
  const store = use(StoreContext);
  if (!store) throw new Error("useStore requires StackProvider");
  return store;
}

export function useStack(): StackState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
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

export type Mode = "canvas" | "grid";

export type WorkbenchValue = {
  mode: Mode;
  space: SpaceId;
  setSpace(space: SpaceId): void;
  selected: NodeRef | null;
  hovered: string | null;
  select(ref: NodeRef | null): void;
  hover(key: string | null): void;
  /** Navigate to a node's card — switches space and pans, never selects. */
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
