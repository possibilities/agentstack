"use client";

import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { StackStore, type StackState } from "@/lib/stack/store";
import type { NodeRef, Snapshot, StackEvent } from "@/lib/stack/types";

const StoreContext = createContext<StackStore | null>(null);

export function StackProvider({ snapshot, children }: { snapshot: Snapshot; children: React.ReactNode }) {
  const [store] = useState(() => new StackStore(snapshot));
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return <StoreContext value={store}>{children}</StoreContext>;
}

export function useStack(): StackState {
  const store = use(StoreContext);
  if (!store) throw new Error("useStack requires StackProvider");
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** Event timestamps grouped by the Server id they were scoped to, plus package-level topics. */
export function useActivity(): Map<string, StackEvent[]> {
  const { events } = useStack();
  return useMemo(() => {
    const map = new Map<string, StackEvent[]>();
    for (const event of events) {
      const key = event.scope ? `server:${event.scope}` : `${event.pkg}:${event.topic}`;
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
  selected: NodeRef | null;
  hovered: string | null;
  select(ref: NodeRef | null): void;
  hover(key: string | null): void;
  focus(ref: NodeRef): void;
};

export const WorkbenchContext = createContext<WorkbenchValue | null>(null);

export function useWorkbench(): WorkbenchValue {
  const value = use(WorkbenchContext);
  if (!value) throw new Error("useWorkbench requires WorkbenchContext");
  return value;
}
