"use client";

import { createContext, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { blankSnapshot, destinationIdentity, destinationStorages, type Destination, type DestinationIdentity, type ScopedStorage } from "@/lib/stack/destination";
import type { SpaceId } from "@/lib/stack/spaces";
import { ChatWindowStore, type ChatWindows } from "@/lib/stack/chat-windows";
import { WorkerWindowStore, type TurnFocus, type WorkerWindows } from "@/lib/stack/worker-windows";
import { ViewerWindowStore, type ControlGrants, type HandoffActions, type ViewerWindows } from "@/lib/stack/browse-viewers";
import { ProcWindowStore, type ProcRunWindows } from "@/lib/stack/proc-windows";
import { HudViewStore, type HudView } from "@/lib/stack/hud-view";
import type { ProcRunFilter, ProcScheduleFilter } from "@/lib/stack/proc";
import type { WorkerFilter } from "@/lib/stack/workers";
import { StackStore, type StackConnections, type StackState } from "@/lib/stack/store";
import type { NodeRef, Snapshot, StackEvent } from "@/lib/stack/types";

const StoreContext = createContext<StackStore | null>(null);
const ChatWindowsContext = createContext<ChatWindowStore | null>(null);
const WorkerWindowsContext = createContext<WorkerWindowStore | null>(null);
const ViewerWindowsContext = createContext<ViewerWindowStore | null>(null);
const ProcWindowsContext = createContext<ProcWindowStore | null>(null);
const HudViewContext = createContext<HudViewStore | null>(null);

/** This tree's destination: the complete identity once the server has named itself, and storage that belongs to it alone. */
type DestinationValue = { identity: DestinationIdentity | null; local: ScopedStorage | null; session: ScopedStorage | null };
const DestinationContext = createContext<DestinationValue>({ identity: null, local: null, session: null });

/**
 * The browser storage this page may use, scoped to its destination. Both areas are null until the server has named
 * itself, so a store, draft or recovery record never reads or writes under an unknown namespace.
 */
export function useDestination(): DestinationValue {
  return use(DestinationContext);
}

/**
 * Everything the Canvas keeps in memory or in the browser belongs to one destination. When the server behind this
 * origin turns out to be a different one, the whole tree is replaced with a blank snapshot for it: nothing already
 * loaded, drafted, queued or recorded carries across (ADR 0167).
 */
export function StackProvider({ snapshot, children, connections }: { snapshot: Snapshot; children: React.ReactNode; connections?: StackConnections }) {
  const [epoch, setEpoch] = useState({ seed: snapshot, generation: 0 });
  const replace = useCallback((next: Destination) => setEpoch((held) => ({ seed: blankSnapshot(held.seed, next), generation: held.generation + 1 })), []);
  return <StackTree key={epoch.generation} snapshot={epoch.seed} connections={connections} onMoved={replace}>{children}</StackTree>;
}

function StackTree({ snapshot, children, connections, onMoved }: { snapshot: Snapshot; children: React.ReactNode; connections?: StackConnections; onMoved(next: Destination): void }) {
  const [store] = useState(() => new StackStore(snapshot));
  const [chats] = useState(() => new ChatWindowStore());
  const [workerWindows] = useState(() => new WorkerWindowStore());
  const [viewers] = useState(() => new ViewerWindowStore());
  const [procWindows] = useState(() => new ProcWindowStore());
  const [hudView] = useState(() => new HudViewStore());
  const destination = useSyncExternalStore(store.subscribe, () => store.getState().destination, () => store.getServerState().destination);
  const identity = useMemo(() => destinationIdentity(destination), [destination]);
  const scope = identity ? `${identity.serverId} ${identity.authority} ${identity.origin}` : null;
  // Storage objects are only wrappers; the browser is touched when a store or view uses them, after mount.
  const value = useMemo<DestinationValue>(() => ({ identity, ...destinationStorages(identity) }), [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    store.onDestinationMoved(onMoved);
    return () => store.onDestinationMoved(null);
  }, [store, onMoved]);
  // Persisted state is restored after hydration, and only from this destination's storage. Until the server has
  // named itself every store is detached: nothing is read, written or recovered.
  useEffect(() => {
    store.attachStorage(value.local);
    chats.attach(value.local);
    workerWindows.attach(value.local);
    viewers.attach(value.local);
    procWindows.attach(value.local);
    hudView.attach(value.local);
  }, [store, chats, workerWindows, viewers, procWindows, hudView, value.local]);
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
  const bots = useSyncExternalStore(store.subscribe, () => store.getState().bots.data, () => store.getServerState().bots.data);
  useEffect(() => { if (bots) chats.prune(new Set(bots.map((bot) => bot.id))); }, [bots, chats]);
  const workers = useSyncExternalStore(store.subscribe, () => store.getState().workerSessions.data, () => store.getServerState().workerSessions.data);
  useEffect(() => { if (workers) workerWindows.prune(new Set(workers.map((worker) => worker.id))); }, [workers, workerWindows]);
  const profiles = useSyncExternalStore(store.subscribe, () => store.getState().browserProfiles.data, () => store.getServerState().browserProfiles.data);
  useEffect(() => { if (profiles) viewers.prune(new Set(profiles.map((profile) => profile.id))); }, [profiles, viewers]);
  // A grant ends when its handoff leaves human control; the API has revoked it by then.
  const handoffs = useSyncExternalStore(store.subscribe, () => store.getState().browserHandoffs.data, () => store.getServerState().browserHandoffs.data);
  useEffect(() => { if (handoffs) viewers.pruneGrants(new Set(handoffs.filter((item) => item.state === "human_controlling").map((item) => item.id))); }, [handoffs, viewers]);
  return <DestinationContext value={value}><StoreContext value={store}><ChatWindowsContext value={chats}><WorkerWindowsContext value={workerWindows}><ViewerWindowsContext value={viewers}><ProcWindowsContext value={procWindows}><HudViewContext value={hudView}>{children}</HudViewContext></ProcWindowsContext></ViewerWindowsContext></WorkerWindowsContext></ChatWindowsContext></StoreContext></DestinationContext>;
}

/** Fleet chat windows and the store that arranges them. */
export function useChatWindows(): { windows: ChatWindows; chats: ChatWindowStore } {
  const chats = use(ChatWindowsContext);
  if (!chats) throw new Error("useChatWindows requires StackProvider");
  const windows = useSyncExternalStore(chats.subscribe, chats.getWindows, chats.getServerWindows);
  return { windows, chats };
}

/** Workers-space windows, the store that arranges them, the Workers list's filter, and any exact-turn focus request. */
export function useWorkerWindows(): { windows: WorkerWindows; filter: WorkerFilter; turnFocus: TurnFocus | null; workerWindows: WorkerWindowStore } {
  const workerWindows = use(WorkerWindowsContext);
  if (!workerWindows) throw new Error("useWorkerWindows requires StackProvider");
  const windows = useSyncExternalStore(workerWindows.subscribe, workerWindows.getWindows, workerWindows.getServerWindows);
  const filter = useSyncExternalStore(workerWindows.subscribe, workerWindows.getFilter, workerWindows.getServerFilter);
  const turnFocus = useSyncExternalStore(workerWindows.subscribe, workerWindows.getTurnFocus, workerWindows.getServerTurnFocus);
  return { windows, filter, turnFocus, workerWindows };
}

/** Proc-space Run windows, the Schedule selection and the lists' filters. */
export function useProcWindows(): { windows: ProcRunWindows; selectedScheduleId: string | null; scheduleFilter: ProcScheduleFilter; runFilter: ProcRunFilter; procWindows: ProcWindowStore } {
  const procWindows = use(ProcWindowsContext);
  if (!procWindows) throw new Error("useProcWindows requires StackProvider");
  const windows = useSyncExternalStore(procWindows.subscribe, procWindows.getWindows, procWindows.getServerWindows);
  const selectedScheduleId = useSyncExternalStore(procWindows.subscribe, procWindows.getSelected, procWindows.getServerSelected);
  const scheduleFilter = useSyncExternalStore(procWindows.subscribe, procWindows.getScheduleFilter, procWindows.getServerScheduleFilter);
  const runFilter = useSyncExternalStore(procWindows.subscribe, procWindows.getRunFilter, procWindows.getServerRunFilter);
  return { windows, selectedScheduleId, scheduleFilter, runFilter, procWindows };
}

/** The HUD space's selected Work item, collapsed branches, subtree focus and tree filter. */
export function useHudView(): { view: HudView; hudView: HudViewStore } {
  const hudView = use(HudViewContext);
  if (!hudView) throw new Error("useHudView requires StackProvider");
  const view = useSyncExternalStore(hudView.subscribe, hudView.getView, hudView.getServerView);
  return { view, hudView };
}

/** Browse viewer windows, this page's human control grants, and the store that arranges them. */
export function useViewerWindows(): { windows: ViewerWindows; grants: ControlGrants; actions: HandoffActions; viewers: ViewerWindowStore } {
  const viewers = use(ViewerWindowsContext);
  if (!viewers) throw new Error("useViewerWindows requires StackProvider");
  const windows = useSyncExternalStore(viewers.subscribe, viewers.getWindows, viewers.getServerWindows);
  const grants = useSyncExternalStore(viewers.subscribe, viewers.getGrants, viewers.getServerGrants);
  const actions = useSyncExternalStore(viewers.subscribe, viewers.getActions, viewers.getServerActions);
  return { windows, grants, actions, viewers };
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
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
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
