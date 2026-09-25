"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  MinusIcon,
  MousePointer2Icon,
  PlusIcon,
  ScanIcon,
  SearchIcon,
  SquareDashedMousePointerIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { brandMarkDarkUrl, brandMarkLightUrl } from "@/lib/brand";
import { homeOf, parseNodeKey, parseSpacePath, spaceAttention, spaceHref, spaces, spaceTitle, type SpaceId } from "@/lib/stack/spaces";
import { nodeKey, type NodeRef, type Snapshot } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { AuthActionsProvider } from "./auth-actions";
import { Inspector } from "./inspector";
import { Lines } from "./lines";
import { Palette, type PaletteAction } from "./palette";
import { StatusDot } from "./primitives";
import { StackProvider, useStack, useWorkbench, WorkbenchContext, type Mode, type WorkbenchValue } from "./provider";
import { spaceViews, type WindowDef } from "./spaces";
import { accentTile, PlacementContext, type WindowPlacement } from "./window";
import { CallLauncher, VoiceProvider } from "./voice";

type Point = { x: number; y: number };
type View = Point & { k: number };
type Layout = { positions: Record<string, Point>; collapsed: Record<string, boolean>; order: string[] };

/** View controls a mounted space reports upward for the shared chrome to use. */
export type SpaceControls = {
  mode: Mode;
  setMode(mode: Mode): void;
  fit(): void;
  tidy(): void;
  goToNode(ref: NodeRef, onLanded?: () => void): void;
};

type Persisted = { spaces?: Partial<Record<SpaceId, { mode?: Mode; layout?: Partial<Layout>; view?: View }>> };

const storageKey = "agentstack.uix.canvas.v2";
const legacyStorageKey = "agentstack.uix.canvas.v1";
const gapX = 72;
const gapY = 24;
const top = 76;
const gridGap = 20;
const gridMinColumn = 340;
const pad = 32;
const minScale = 0.3;
const maxScale = 1.6;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const pageTitle = (space: SpaceId) => `AgentStack · ${spaceTitle(space)}`;

function initialLayout(defs: WindowDef[]): Layout {
  let x = 0;
  const positions: Record<string, Point> = {};
  const maxColumn = Math.max(0, ...defs.map((item) => item.column));
  for (let column = 0; column <= maxColumn; column += 1) {
    const members = defs.filter((item) => item.column === column);
    if (!members.length) continue;
    members.forEach((item, index) => { positions[item.id] = { x, y: index * 520 }; });
    x += Math.max(...members.map((item) => item.width)) + gapX;
  }
  return { positions, collapsed: {}, order: defs.map((item) => item.id) };
}

export function Workbench({ snapshot, initialSpace, initialFocus }: { snapshot: Snapshot; initialSpace: SpaceId; initialFocus: NodeRef | null }) {
  return (
    <StackProvider snapshot={snapshot}>
      <Shell initialSpace={initialSpace} initialFocus={initialFocus} />
    </StackProvider>
  );
}

function Shell({ initialSpace, initialFocus }: { initialSpace: SpaceId; initialFocus: NodeRef | null }) {
  const [space, setSpaceState] = useState<SpaceId>(initialSpace);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [controls, setControls] = useState<SpaceControls | null>(null);
  const [flash, setFlash] = useState<{ key: string; seq: number } | null>(null);
  const [wide, setWide] = useState(false);
  const spaceRef = useRef(space);
  const controlsRef = useRef<SpaceControls | null>(null);
  const flashSeq = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A node to pan to and flash once the active space's canvas reports ready. */
  const pendingGoTo = useRef<NodeRef | null>(initialFocus);

  const reportControls = useCallback((next: SpaceControls | null) => {
    controlsRef.current = next;
    setControls(next);
  }, []);

  // The inspector is an edge sheet: the canvas area shrinks by its width on wide screens.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const flashNow = useCallback((ref: NodeRef) => {
    setFlash({ key: nodeKey(ref), seq: ++flashSeq.current });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1400);
  }, []);

  // Every space switch — tabs, keys, palette, cross-space goTo — closes the sheet.
  const switchSpace = useCallback((next: SpaceId, ref?: NodeRef | null) => {
    window.history.pushState(null, "", spaceHref(next, ref));
    document.title = pageTitle(next);
    spaceRef.current = next;
    setSelected(null);
    setSpaceState(next);
  }, []);

  const setSpace = useCallback((next: SpaceId) => {
    if (next !== spaceRef.current) switchSpace(next);
  }, [switchSpace]);

  const consumePendingGoTo = useCallback(() => {
    const ref = pendingGoTo.current;
    pendingGoTo.current = null;
    return ref;
  }, []);

  const goTo = useCallback((ref: NodeRef) => {
    const home = homeOf(ref);
    if (home.space === spaceRef.current) {
      window.history.replaceState(null, "", spaceHref(home.space, ref));
      const canvas = controlsRef.current;
      if (canvas) canvas.goToNode(ref, () => flashNow(ref));
      else pendingGoTo.current = ref;
    } else {
      pendingGoTo.current = ref;
      switchSpace(home.space, ref);
    }
  }, [switchSpace, flashNow]);

  // Back/forward: re-parse the location and sync without reloading the page.
  useEffect(() => {
    const onPop = () => {
      const next = parseSpacePath(window.location.pathname);
      if (!next) return;
      const raw = new URLSearchParams(window.location.search).get("focus");
      const ref = raw ? parseNodeKey(raw) : null;
      document.title = pageTitle(next);
      if (next !== spaceRef.current) {
        if (ref) pendingGoTo.current = ref;
        spaceRef.current = next;
        setSelected(null);
        setSpaceState(next);
      } else if (ref) {
        const canvas = controlsRef.current;
        if (canvas) canvas.goToNode(ref, () => flashNow(ref));
        else pendingGoTo.current = ref;
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [flashNow]);

  const select = useCallback((ref: NodeRef | null) => setSelected(ref), []);

  // Global keys: ⌘K palette, digits switch spaces. Canvas keys live in SpaceCanvas.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || paletteOpen || target.closest("input,textarea,[contenteditable=true],[role=dialog],[role=alertdialog]")) return;
      const targetSpace = spaces.find((item) => item.key === event.key);
      if (targetSpace) setSpace(targetSpace.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setSpace]);

  const actions: PaletteAction[] = useMemo(() => {
    if (!controls) return [];
    return [
      { id: "fit", label: "Fit everything in view", shortcut: "F", icon: ScanIcon, run: controls.fit },
      { id: "tidy", label: "Tidy windows", shortcut: "T", icon: LayoutDashboardIcon, run: controls.tidy },
      { id: "mode", label: controls.mode === "canvas" ? "Switch to grid" : "Switch to canvas", shortcut: "G", icon: controls.mode === "canvas" ? LayoutGridIcon : SquareDashedMousePointerIcon, run: () => controls.setMode(controls.mode === "canvas" ? "grid" : "canvas") },
    ];
  }, [controls]);

  const workbench: WorkbenchValue = useMemo(() => ({
    mode: controls?.mode ?? "canvas",
    space,
    setSpace,
    selected,
    hovered,
    select,
    hover: setHovered,
    goTo,
    flash,
  }), [controls?.mode, space, setSpace, selected, hovered, select, goTo, flash]);

  return (
    <div className="contents" style={{ "--sheet": selected && wide ? "420px" : "0px" } as React.CSSProperties}>
      <WorkbenchContext value={workbench}>
        <AuthActionsProvider>
          <VoiceProvider>
            <SpaceCanvas key={space} space={space} paletteOpen={paletteOpen} consumePendingGoTo={consumePendingGoTo} onArrive={flashNow} onControls={reportControls} />
            <TopBar space={space} setSpace={setSpace} controls={controls} openPalette={() => setPaletteOpen(true)} />
            <Inspector />
            <Palette open={paletteOpen} onOpenChange={setPaletteOpen} actions={actions} />
          </VoiceProvider>
        </AuthActionsProvider>
      </WorkbenchContext>
    </div>
  );
}

function SpaceCanvas({ space, paletteOpen, consumePendingGoTo, onArrive, onControls }: {
  space: SpaceId;
  paletteOpen: boolean;
  consumePendingGoTo(): NodeRef | null;
  onArrive(ref: NodeRef): void;
  onControls(controls: SpaceControls | null): void;
}) {
  const state = useStack();
  const { select } = useWorkbench();
  const defs = useMemo(() => spaceViews[space].windows(state), [space, state.catalog.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewport = useRef<HTMLElement>(null);
  const [world, setWorld] = useState<HTMLDivElement | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const registrars = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const [mode, setMode] = useState<Mode>("canvas");
  const [view, setView] = useState<View>({ x: pad, y: top, k: 1 });
  const [layout, setLayout] = useState<Layout>(() => initialLayout(defs));
  const [ready, setReady] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const viewRef = useRef(view);
  const layoutRef = useRef(layout);
  const defsRef = useRef(defs);
  const animationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    viewRef.current = view;
    layoutRef.current = layout;
    defsRef.current = defs;
  });

  const animate = useCallback((change: () => void) => {
    setAnimating(true);
    change();
    clearTimeout(animationTimer.current);
    animationTimer.current = setTimeout(() => setAnimating(false), 560);
  }, []);

  const size = useCallback((id: string) => {
    const element = elements.current.get(id);
    return { width: element?.offsetWidth ?? defsRef.current.find((item) => item.id === id)?.width ?? 400, height: element?.offsetHeight ?? 400 };
  }, []);

  const tidied = useCallback((): Record<string, Point> => {
    const positions: Record<string, Point> = {};
    let x = 0;
    const defsNow = defsRef.current;
    const maxColumn = Math.max(0, ...defsNow.map((item) => item.column));
    for (let column = 0; column <= maxColumn; column += 1) {
      const members = defsNow.filter((item) => item.column === column);
      if (!members.length) continue;
      let y = 0;
      for (const item of members) {
        positions[item.id] = { x, y };
        y += size(item.id).height + gapY;
      }
      x += Math.max(...members.map((item) => item.width)) + gapX;
    }
    return positions;
  }, [size]);

  const fitted = useCallback((positions: Record<string, Point>, minK = minScale): View => {
    const element = viewport.current;
    if (!element) return viewRef.current;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, point] of Object.entries(positions)) {
      const { width, height } = size(id);
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x + width); maxY = Math.max(maxY, point.y + height);
    }
    const availableWidth = element.clientWidth - pad * 2;
    const availableHeight = element.clientHeight - top - pad;
    const k = clamp(Math.min(availableWidth / (maxX - minX), availableHeight / (maxY - minY), 1), minK, 1);
    const width = (maxX - minX) * k;
    const x = width <= availableWidth ? pad + (availableWidth - width) / 2 - minX * k : pad - minX * k;
    return { x, y: top - minY * k, k };
  }, [size]);

  /** Opening view: the first columns fill the width at a readable scale; the rest peek in from the right. */
  const primaryView = useCallback((positions: Record<string, Point>): View => {
    const element = viewport.current;
    if (!element) return viewRef.current;
    const defsNow = defsRef.current;
    const maxColumn = Math.max(0, ...defsNow.map((item) => item.column));
    const primary = defsNow.filter((item) => item.column <= Math.min(maxColumn, 2));
    if (!primary.length) return viewRef.current;
    const minX = Math.min(...primary.map((item) => positions[item.id]?.x ?? 0));
    const maxX = Math.max(...primary.map((item) => (positions[item.id]?.x ?? 0) + size(item.id).width));
    const minY = Math.min(...primary.map((item) => positions[item.id]?.y ?? 0));
    const availableWidth = element.clientWidth - pad * 2;
    const k = clamp(availableWidth / (maxX - minX), 0.8, 1);
    return { k, x: pad + Math.max(0, (availableWidth - (maxX - minX) * k) / 2) - minX * k, y: top - minY * k };
  }, [size]);

  const tidy = useCallback(() => animate(() => {
    const positions = tidied();
    setLayout((current) => ({ ...current, positions }));
    setView(primaryView(positions));
  }), [animate, primaryView, tidied]);
  const fit = useCallback(() => animate(() => setView(fitted(layoutRef.current.positions))), [animate, fitted]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const element = viewport.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setView((current) => {
      const k = clamp(current.k * factor, minScale, maxScale);
      return { k, x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k) };
    });
  }, []);

  // Restore this space's saved arrangement before first paint; otherwise tidy and fit.
  useLayoutEffect(() => {
    let saved: Persisted = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      saved = {};
    }
    localStorage.removeItem(legacyStorageKey);
    const slice = saved.spaces?.[space] ?? {};
    const present = new Set(defsRef.current.map((item) => item.id));
    const fresh = tidied();
    const positions = { ...fresh };
    for (const [id, point] of Object.entries(slice.layout?.positions ?? {})) if (present.has(id)) positions[id] = point;
    const collapsed = Object.fromEntries(Object.entries(slice.layout?.collapsed ?? {}).filter(([id]) => present.has(id)));
    const order = [...new Set([...(slice.layout?.order ?? []), ...defsRef.current.map((item) => item.id)])].filter((id) => present.has(id));
    setLayout({ positions, collapsed, order });
    setView(slice.view ?? primaryView(positions));
    setMode(slice.mode ?? (window.innerWidth < 900 ? "grid" : "canvas"));
    setReady(true);
  }, [space, primaryView, tidied]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      let all: Persisted = {};
      try {
        all = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      } catch {
        all = {};
      }
      all.spaces = { ...all.spaces, [space]: { mode, layout, view } };
      localStorage.setItem(storageKey, JSON.stringify(all));
    }, 250);
    return () => clearTimeout(timer);
  }, [ready, space, mode, layout, view]);

  // Windows come and go with the data (e.g. the API catalog): keep positions for
  // the ids still present, fill missing ones from the tidied layout, drop stale order entries.
  useEffect(() => {
    setLayout((current) => {
      const present = new Set(defs.map((item) => item.id));
      const missing = defs.some((item) => !current.positions[item.id]);
      const stale = current.order.some((id) => !present.has(id))
        || Object.keys(current.positions).some((id) => !present.has(id))
        || Object.keys(current.collapsed).some((id) => !present.has(id));
      if (!missing && !stale) return current;
      const fresh = tidied();
      const positions: Record<string, Point> = {};
      for (const id of present) positions[id] = current.positions[id] ?? fresh[id];
      const collapsed = Object.fromEntries(Object.entries(current.collapsed).filter(([id]) => present.has(id)));
      const order = [...current.order.filter((id) => present.has(id)), ...defs.map((item) => item.id).filter((id) => !current.order.includes(id))];
      return { positions, collapsed, order };
    });
  }, [defs, tidied]);

  const focusWindow = useCallback((id: string) => {
    const element = viewport.current;
    const position = layoutRef.current.positions[id];
    if (!element || !position) return;
    const k = Math.max(viewRef.current.k, 0.8);
    animate(() => setView({ k, x: element.clientWidth / 2 - (position.x + size(id).width / 2) * k, y: top + 12 - position.y * k }));
  }, [animate, size]);

  // Wheel pans, pinch or modifier-wheel zooms; scrollable lists keep their own scrolling.
  useEffect(() => {
    const element = viewport.current;
    if (!element || mode !== "canvas") return;
    const onWheel = (event: WheelEvent) => {
      const scroller = (event.target as Element).closest("[data-scroll]");
      if (scroller && !event.ctrlKey && !event.metaKey && scroller.scrollHeight > scroller.clientHeight) return;
      if ((event.target as Element).closest("[data-chrome],[role=dialog]")) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      else setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [mode, zoomAt]);

  /** Expand the node's home window if collapsed, then center the node (or scroll to it in grid mode). */
  const goToNode = useCallback((ref: NodeRef, onLanded?: () => void) => {
    const home = homeOf(ref).window;
    const wasCollapsed = layoutRef.current.collapsed[home];
    if (wasCollapsed) setLayout((current) => ({ ...current, collapsed: { ...current.collapsed, [home]: false } }));
    setTimeout(() => {
      const key = CSS.escape(nodeKey(ref));
      // A window that is itself the node (package:<name>) wins over a row carrying the same key.
      const node = document.querySelector(`[data-node="${key}"][data-window]`) ?? document.querySelector(`[data-node="${key}"]`) ?? document.querySelector(`[data-window="${CSS.escape(home)}"]`);
      if (!node) return;
      if (mode === "grid" || !world) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => onLanded?.(), 450);
        return;
      }
      const current = viewRef.current;
      const origin = world.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const cx = (rect.left + rect.width / 2 - origin.left) / current.k;
      const cy = (rect.top + rect.height / 2 - origin.top) / current.k;
      const element = viewport.current!;
      const k = current.k < 0.7 ? 1 : current.k;
      // The viewport already ends where the sheet begins, so its width is the visible width.
      animate(() => setView({ k, x: element.clientWidth / 2 - cx * k, y: (element.clientHeight + top) / 2 - cy * k }));
      setTimeout(() => onLanded?.(), 520);
    }, wasCollapsed ? 60 : 0);
  }, [animate, mode, world]);

  // A cross-space goTo (or the URL's ?focus= on load) lands here once mounted.
  useEffect(() => {
    if (!ready) return;
    const ref = consumePendingGoTo();
    if (ref) goToNode(ref, () => onArrive(ref));
  }, [ready, consumePendingGoTo, goToNode, onArrive]);

  const toggleMode = useCallback(() => setMode((current) => current === "canvas" ? "grid" : "canvas"), []);

  // Report this space's controls upward so the shared TopBar and Palette operate it.
  useEffect(() => {
    const next: SpaceControls = { mode, setMode, fit, tidy, goToNode };
    onControls(next);
    return () => onControls(null);
  }, [mode, fit, tidy, goToNode, onControls]);

  // Canvas keys: G toggles mode; F/T/+/-/0 only apply in canvas mode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || paletteOpen || target.closest("input,textarea,[contenteditable=true],[role=dialog],[role=alertdialog]")) return;
      const key = event.key.toLowerCase();
      if (key === "g") {
        toggleMode();
        return;
      }
      if (mode !== "canvas") return;
      if (key === "f") fit();
      else if (key === "t") tidy();
      else if (key === "=" || key === "+") animate(() => zoomAt(1.2));
      else if (key === "-") animate(() => zoomAt(1 / 1.2));
      else if (key === "0") animate(() => zoomAt(1 / viewRef.current.k));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [animate, fit, mode, paletteOpen, tidy, toggleMode, zoomAt]);

  const onBackgroundPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (mode !== "canvas" || (event.button !== 0 && event.button !== 1)) return;
    if ((event.target as Element).closest("[data-window],[data-chrome]")) return;
    const start = { px: event.clientX, py: event.clientY, x: view.x, y: view.y };
    let moved = false;
    setPanning(true);
    const move = (next: PointerEvent) => {
      if (Math.abs(next.clientX - start.px) + Math.abs(next.clientY - start.py) > 3) moved = true;
      setView((current) => ({ ...current, x: start.x + next.clientX - start.px, y: start.y + next.clientY - start.py }));
    };
    const up = () => {
      setPanning(false);
      if (!moved) select(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const placement = useCallback((id: string): WindowPlacement => {
    const item = defsRef.current.find((entry) => entry.id === id)!;
    const position = layout.positions[id] ?? { x: 0, y: 0 };
    if (!registrars.current.has(id)) {
      registrars.current.set(id, (element) => {
        if (element) elements.current.set(id, element);
        else elements.current.delete(id);
      });
    }
    return {
      mode,
      ...position,
      z: layout.order.indexOf(id) + 1,
      width: item.width,
      collapsed: Boolean(layout.collapsed[id]),
      animating,
      dragging: dragging === id,
      register: registrars.current.get(id)!,
      onFocusWithin: () => {
        if (layoutRef.current.order.at(-1) !== id) setLayout((current) => ({ ...current, order: [...current.order.filter((entry) => entry !== id), id] }));
      },
      onToggleCollapse: () => setLayout((current) => ({ ...current, collapsed: { ...current.collapsed, [id]: !current.collapsed[id] } })),
      onHeaderPointerDown: (event, onTap) => {
        if (event.button !== 0 || (event.target as Element).closest("button,a,[data-interactive],[tabindex]")) return;
        event.preventDefault();
        const start = { px: event.clientX, py: event.clientY, ...position };
        let moved = false;
        setDragging(id);
        const move = (next: PointerEvent) => {
          if (Math.abs(next.clientX - start.px) + Math.abs(next.clientY - start.py) <= 3) return;
          moved = true;
          const k = viewRef.current.k;
          setLayout((current) => ({
            ...current,
            positions: { ...current.positions, [id]: { x: Math.round(start.x + (next.clientX - start.px) / k), y: Math.round(start.y + (next.clientY - start.py) / k) } },
          }));
        };
        const up = () => {
          setDragging(null);
          if (!moved) onTap?.();
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
    };
  }, [animating, dragging, layout, mode]);

  // Grid mode: masonry columns, each window placed in reading order into the shortest column.
  const [gridColumns, setGridColumns] = useState<string[][]>(() => [defs.map((item) => item.id)]);
  useLayoutEffect(() => {
    if (mode !== "grid" || !world) return;
    let frame = 0;
    const arrange = () => {
      const count = clamp(Math.floor((world.clientWidth + gridGap) / (gridMinColumn + gridGap)), 1, 4);
      const heights = new Array<number>(count).fill(0);
      const columns = Array.from({ length: count }, () => [] as string[]);
      for (const id of defsRef.current.map((item) => item.id)) {
        const index = heights.indexOf(Math.min(...heights));
        columns[index].push(id);
        heights[index] += (elements.current.get(id)?.offsetHeight ?? 400) + gridGap;
      }
      setGridColumns((current) => JSON.stringify(current) === JSON.stringify(columns) ? current : columns);
    };
    arrange();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(arrange);
    });
    observer.observe(world);
    for (const element of elements.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [mode, world, gridColumns, defs]);

  const canvas = mode === "canvas";

  return (
    <PlacementContext value={placement}>
      <main
        ref={viewport}
        data-canvas="workbench"
        onPointerDown={onBackgroundPointerDown}
        className={cn(
          "canvas-dots",
          canvas
            ? "fixed inset-y-0 left-0 right-[var(--sheet)] touch-none overflow-hidden overscroll-none transition-[right] duration-200 ease-out motion-reduce:transition-none"
            : "min-h-dvh mr-[var(--sheet)] transition-[margin-right] duration-200 ease-out motion-reduce:transition-none",
          canvas && (panning ? "cursor-grabbing" : "cursor-grab"),
        )}
        style={canvas ? { backgroundSize: `${22 * view.k}px ${22 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` } : { backgroundSize: "22px 22px" }}
      >
        <div aria-hidden className="pointer-events-none fixed inset-0 bg-[radial-gradient(90%_60%_at_50%_-10%,color-mix(in_oklch,var(--pkg-bots)_9%,transparent),transparent_70%)]" />
        <h1 className="sr-only">{`AgentStack ${spaceTitle(space)} canvas`}</h1>
        {canvas ? (
          <div
            ref={setWorld}
            className={cn("absolute top-0 left-0 origin-top-left transition-opacity duration-500", ready ? "opacity-100" : "opacity-0", animating && "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]", dragging && "select-none")}
            style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})` }}
          >
            <Lines world={world} scale={view.k} version={[layout, mode]} animating={animating || dragging !== null} subtle={false} />
            {defs.map(({ id, element }) => <Fragment key={id}>{element}</Fragment>)}
          </div>
        ) : (
          <div className={cn("relative mx-auto max-w-[1760px] px-4 pt-20 pb-16 transition-opacity duration-500 sm:px-6", ready ? "opacity-100" : "opacity-0")}>
            <div ref={setWorld} className="relative">
              <Lines world={world} scale={1} version={[layout, mode, gridColumns]} animating={false} subtle />
              <div className="flex items-start gap-5">
                {gridColumns.map((column, index) => (
                  <div key={index} className="flex min-w-0 flex-1 flex-col gap-5">
                    {column.map((id) => {
                      const def = defs.find((item) => item.id === id);
                      return def ? <Fragment key={id}>{def.element}</Fragment> : null;
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
      {canvas && ready ? <OffscreenHints view={view} positions={layout.positions} collapsed={layout.collapsed} defs={defs} size={size} viewport={viewport.current} onFocus={focusWindow} /> : null}
      {canvas ? <CanvasToolbar scale={view.k} zoom={(factor) => animate(() => zoomAt(factor))} fit={fit} tidy={tidy} /> : null}
    </PlacementContext>
  );
}

function TopBar({ space, setSpace, controls, openPalette }: { space: SpaceId; setSpace(space: SpaceId): void; controls: SpaceControls | null; openPalette(): void }) {
  const state = useStack();
  const { status, endpoints, scoped, catalog } = state;
  // Every Package API with a WebSocket endpoint, in catalog order (unknowns last, alphabetical).
  const packageOrder = useMemo(() => {
    const order = new Map((catalog.data ?? []).map((doc, index) => [doc.name, index]));
    return Object.keys(endpoints).sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
  }, [catalog.data, endpoints]);
  const attention = useMemo(() => spaceAttention(state), [state]);
  // Only channels this page opened have a status entry; endpoints without one were never connected here.
  const opened = packageOrder.filter((name) => status[name] !== undefined);
  const unopened = packageOrder.filter((name) => status[name] === undefined);
  const live = opened.filter((name) => status[name] === "open").length;
  const scopedLive = Object.values(scoped).filter((value) => value.status === "open").length;
  const mode = controls?.mode ?? "canvas";
  return (
    <div data-chrome
      className="pointer-events-none fixed top-3 left-3 z-30 flex items-start justify-between gap-3 transition-[right] duration-200 ease-out motion-reduce:transition-none"
      style={{ right: "calc(var(--sheet) + 0.75rem)" }}>
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border bg-card/80 py-1.5 pr-3 pl-1.5 shadow-sm backdrop-blur-xl sm:gap-3">
        <picture className="flex size-9 shrink-0 items-center justify-center">
          <source media="(prefers-color-scheme: dark)" srcSet={brandMarkDarkUrl} />
          <img src={brandMarkLightUrl} width={28} height={28} alt="AgentStack" className="size-7" />
        </picture>
        <div className="hidden flex-col leading-tight lg:flex">
          <span className="text-sm font-semibold tracking-tight">AgentStack</span>
        </div>
        <nav aria-label="Spaces" className="flex items-center gap-0.5">
          {spaces.map((item) => {
            const Icon = spaceViews[item.id].icon;
            const active = item.id === space;
            const reasons = attention[item.id];
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger
                  render={
                    <a
                      href={spaceHref(item.id)}
                      aria-current={active ? "page" : undefined}
                      onClick={(event) => {
                        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
                          event.preventDefault();
                          setSpace(item.id);
                        }
                      }}
                      className={cn(
                        "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" />
                      <span className="hidden md:inline">{item.title}</span>
                      {reasons.length ? (
                        <>
                          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
                          <span className="sr-only">needs attention</span>
                        </>
                      ) : null}
                    </a>
                  }
                />
                <TooltipContent side="bottom" className="flex-col items-start gap-1">
                  <span>{item.title} <Kbd>{item.key}</Kbd></span>
                  {reasons.map((reason) => <span key={reason} className="text-warning">{reason}</span>)}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
        <Separator orientation="vertical" className="mx-0.5 hidden h-6! self-center sm:block" />
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring" />}>
            <span className="flex items-center gap-1">
              {opened.map((name) => (
                <StatusDot key={name} tone={status[name] === "open" ? "success" : status[name] === "closed" ? "destructive" : "muted"} />
              ))}
            </span>
            <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">{live}/{opened.length} live</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex-col items-stretch gap-1 py-2">
            {opened.map((name) => (
              <span key={name} className="flex items-center justify-between gap-6">
                <span className="font-medium">{name}</span>
                <span className="opacity-70">{status[name]}</span>
              </span>
            ))}
            {unopened.length ? <span className="opacity-60">Not opened by this page: {unopened.join(", ")}</span> : null}
            <span className="mt-1 border-t border-background/20 pt-1 opacity-70">{scopedLive} scoped bot subscription{scopedLive === 1 ? "" : "s"}</span>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="pointer-events-auto flex items-center gap-2">
        <CallLauncher />
        <Button variant="outline" className="h-10 gap-2 rounded-xl bg-card/80 pr-1.5 pl-3 text-muted-foreground shadow-sm backdrop-blur-xl" onClick={openPalette}>
          <SearchIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Jump to…</span>
          <Kbd>⌘K</Kbd>
        </Button>
        <ToggleGroup
          value={[mode]}
          onValueChange={(value) => { if (value[0]) controls?.setMode(value[0] as Mode); }}
          className="h-10 rounded-xl border bg-card/80 p-1 shadow-sm backdrop-blur-xl"
          aria-label="Layout"
        >
          <Tooltip>
            <TooltipTrigger render={<ToggleGroupItem value="canvas" aria-label="Canvas" className="h-8 rounded-lg px-2.5" />}>
              <SquareDashedMousePointerIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">Canvas <Kbd>G</Kbd></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<ToggleGroupItem value="grid" aria-label="Grid" className="h-8 rounded-lg px-2.5" />}>
              <LayoutGridIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">Grid <Kbd>G</Kbd></TooltipContent>
          </Tooltip>
        </ToggleGroup>
      </div>
    </div>
  );
}

/** Edge chips for windows panned out of view; clicking one brings it back. */
function OffscreenHints({ view, positions, collapsed, defs, size, viewport, onFocus }: {
  view: View;
  positions: Record<string, Point>;
  collapsed: Record<string, boolean>;
  defs: WindowDef[];
  size(id: string): { width: number; height: number };
  viewport: HTMLElement | null;
  onFocus(id: string): void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const onResize = () => setTick((tick) => tick + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  if (!viewport) return null;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const margin = 48;
  const hints = defs.flatMap((item) => {
    const position = positions[item.id];
    if (!position) return [];
    const box = size(item.id);
    const left = view.x + position.x * view.k;
    const top_ = view.y + position.y * view.k;
    const right = left + box.width * view.k;
    const bottom = top_ + box.height * view.k;
    if (right > margin && left < width - margin && bottom > top + margin && top_ < height - margin) return [];
    const cx = (left + right) / 2;
    const cy = (Math.max(top_, top) + Math.min(bottom, height)) / 2;
    return [{
      item,
      x: clamp(cx, 90, width - 90),
      y: clamp(cy, top + 24, height - 84),
      angle: (Math.atan2(cy - height / 2, cx - width / 2) * 180) / Math.PI,
    }];
  });
  return hints.map(({ item, x, y, angle }) => (
    <button
      key={item.id}
      type="button"
      data-chrome
      onClick={() => onFocus(item.id)}
      className="fixed z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border bg-card/85 py-1 pr-2 pl-1 text-xs font-medium shadow-sm backdrop-blur-xl transition-[left,top,box-shadow] duration-300 animate-in fade-in-0 zoom-in-95 hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring"
      style={{ left: x, top: y }}
    >
      <span className={cn("flex size-5 items-center justify-center rounded-full", accentTile[item.accent])}><item.icon className="size-3" /></span>
      {item.title}
      {collapsed[item.id] ? <span className="text-muted-foreground">· collapsed</span> : null}
      <ArrowRightIcon className="size-3 text-muted-foreground" style={{ transform: `rotate(${angle}deg)` }} />
    </button>
  ));
}

function ToolbarButton({ label, shortcut, onClick, children }: { label: string; shortcut?: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}{shortcut ? <Kbd>{shortcut}</Kbd> : null}</TooltipContent>
    </Tooltip>
  );
}

function CanvasToolbar({ scale, zoom, fit, tidy }: { scale: number; zoom(factor: number): void; fit(): void; tidy(): void }) {
  return (
    <>
      <div data-chrome className="fixed bottom-4 left-[calc((100%-var(--sheet))/2)] z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-card/80 p-1 shadow-sm backdrop-blur-xl transition-[left] duration-200 ease-out motion-reduce:transition-none">
        <ToolbarButton label="Zoom out" shortcut="−" onClick={() => zoom(1 / 1.2)}><MinusIcon /></ToolbarButton>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="sm" className="w-14 font-mono text-xs tabular-nums" onClick={() => zoom(1 / scale)} />}>
            {Math.round(scale * 100)}%
          </TooltipTrigger>
          <TooltipContent>Actual size <Kbd>0</Kbd></TooltipContent>
        </Tooltip>
        <ToolbarButton label="Zoom in" shortcut="+" onClick={() => zoom(1.2)}><PlusIcon /></ToolbarButton>
        <Separator orientation="vertical" className="mx-1 h-5! self-center" />
        <ToolbarButton label="Fit everything" shortcut="F" onClick={fit}><ScanIcon /></ToolbarButton>
        <ToolbarButton label="Tidy windows" shortcut="T" onClick={tidy}><LayoutDashboardIcon /></ToolbarButton>
        <Separator orientation="vertical" className="mx-1 h-5! self-center" />
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Canvas gestures" />}><MousePointer2Icon /></TooltipTrigger>
          <TooltipContent className="flex-col items-start gap-1 py-2">
            <span>Drag empty space or scroll to pan</span>
            <span>Pinch or <Kbd>⌘</Kbd> scroll to zoom</span>
            <span>Drag a window header to arrange</span>
            <span>Click a card to inspect · <Kbd>⌘K</Kbd> to jump</span>
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}
