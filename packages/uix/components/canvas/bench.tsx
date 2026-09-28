"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { benchBounds, clamp, settleWindows, snapLocal, snapSize, windowLimits, fitBounds, preserveViewedWindow, raiseWindow, reconcileBench, restoreBenchCamera, viewedWindow, windowHeight, type BenchLayout, type Camera, type SavedBench } from "@/lib/stack/geometry";
import { homeOf, spaces, type SpaceId } from "@/lib/stack/spaces";
import { nodeKey, type NodeRef } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Lines } from "./lines";
import { useChatWindows, useStack } from "./provider";
import { spaceViews } from "./spaces";
import { PlacementContext, type WindowPlacement } from "./window";

/** Screen pixels within which a resized height sticks to the content's natural height. */
const fitDetent = 14;

/** The height a window would take to show all of its content, measured from layout offsets so a stretched or scrolled body does not skew it. */
function naturalHeight(frame: HTMLElement): number | null {
  const body = frame.querySelector<HTMLElement>(":scope > [data-scroll]");
  if (!body) return null;
  const style = getComputedStyle(body);
  const last = body.lastElementChild as HTMLElement | null;
  const content = (last ? last.offsetTop + last.offsetHeight - body.offsetTop : parseFloat(style.paddingTop)) + parseFloat(style.paddingBottom);
  const height = Math.round(frame.offsetHeight - body.offsetHeight + content);
  return height >= windowLimits.minHeight && height <= windowLimits.maxHeight ? height : null;
}

/** Saved entries for windows the current layout does not know yet; the current layout wins. */
function withSaved(layout: BenchLayout, saved: Partial<BenchLayout>): Partial<BenchLayout> {
  const known = (id: string) => id in layout.positions;
  const pick = <T,>(values: Record<string, T> | undefined) => Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => !known(id)));
  return {
    positions: { ...pick(saved.positions), ...layout.positions },
    manual: { ...pick(saved.manual), ...layout.manual },
    collapsed: { ...pick(saved.collapsed), ...layout.collapsed },
    sizes: { ...pick(saved.sizes), ...layout.sizes },
    order: layout.order,
  };
}

/** A live move or resize: the window follows the pointer while its stored layout holds where it will land. */
type Gesture =
  | { id: string; kind: "move"; x: number; y: number; free: boolean }
  | { id: string; kind: "resize"; width?: number; height?: number; fit: number | null; grooved: boolean; free: boolean };

export type BenchControls = { space: SpaceId; fit(): void; tidy(): void; goToNode(ref: NodeRef): void; zoom(factor: number): void };
const legacyStorageKey = "agentstack.uix.bench.v1";

export function Bench({ space, blocked, onControls, onScale, onArrive }: {
  space: SpaceId; blocked: boolean; onControls(controls: BenchControls | null): void; onScale(scale: number): void; onArrive(ref: NodeRef): void;
}) {
  const state = useStack();
  const { windows: chats } = useChatWindows();
  const storageKey = `agentstack.uix.bench.v2.${space}`;
  const regions = spaces.filter((s) => s.id === space).map((s) => ({ ...s, defs: spaceViews[s.id].windows(state, chats) }));
  const signature = JSON.stringify(regions.map((s) => ({ id: s.id, defs: s.defs.map(({ id, width, height, column, fixed }) => ({ id, width, height, column, fixed })) })));
  // Content refreshes cannot affect footprint or layout. Only registration geometry can.
  const structure = useMemo(() => regions.map((region) => ({
    id: region.id, windows: region.defs.map(({ id, width, height, column, fixed }) => ({ id, width, height, column, fixed })),
  })), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const [arrangement, setArrangement] = useState(() => ({ signature, ...reconcileBench(structure) }));
  // The saved layout also holds windows registered after restore, such as reopened chat windows.
  const saved = useRef<Partial<BenchLayout>>({});
  const persistOnHide = useRef<(() => void) | null>(null);
  // Supply new registrations during their first render, then commit before paint.
  // Dragging changes only the local layout; it never derives new region origins.
  const packed = useMemo(() => arrangement.signature === signature ? arrangement : {
    signature, ...reconcileBench(structure, withSaved(arrangement.layout, saved.current)),
  }, [arrangement, signature, structure]);
  const { layout, geometry } = packed;
  // Rendered window heights; content growth pushes the windows below at render time.
  const [heights, setHeights] = useState<Record<string, number>>({});
  const pushes = useMemo(() => settleWindows(packed, heights), [packed, heights]);
  const settled = useMemo(() => ({ layout, pushes }), [layout, pushes]);
  const setLayout = useCallback((update: (layout: BenchLayout) => BenchLayout) => {
    setArrangement((value) => {
      const next = update(value.layout);
      return next === value.layout ? value : { ...value, layout: next };
    });
  }, []);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [ready, setReady] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  // The window gliding from where the pointer left it into its stored spot.
  const [settling, setSettling] = useState<string | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [world, setWorld] = useState<HTMLDivElement | null>(null);
  const viewport = useRef<HTMLElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const registrars = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const observer = useRef<ResizeObserver | null>(null);
  const current = useRef({ camera, packed, structure, space, pushes, heights });
  const animationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const landingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { current.current = { camera, packed, structure, space, pushes, heights }; });
  useEffect(() => {
    const resize = new ResizeObserver((entries) => setHeights((previous) => {
      let next = previous;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const id = el.dataset.window;
        if (!id || next[id] === el.offsetHeight) continue;
        if (next === previous) next = { ...previous };
        next[id] = el.offsetHeight;
      }
      return next;
    }));
    observer.current = resize;
    for (const el of elements.current.values()) resize.observe(el);
    return () => { resize.disconnect(); observer.current = null; };
  }, []);

  const viewportSize = useCallback(() => ({ width: viewport.current?.clientWidth ?? 0, height: viewport.current?.clientHeight ?? 0 }), []);
  const worldBounds = useCallback((only?: SpaceId) => benchBounds(current.current.packed, only, current.current), []);
  const animate = useCallback((next: Camera) => {
    setAnimating(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setCamera(next);
    clearTimeout(animationTimer.current);
    animationTimer.current = setTimeout(() => setAnimating(false), 360);
  }, []);
  const fit = useCallback(() => {
    const el = viewport.current;
    if (el) animate(fitBounds(worldBounds(), el.clientWidth, el.clientHeight));
  }, [animate, worldBounds]);
  const tidy = useCallback(() => {
    const before = current.current;
    const next = { signature: before.packed.signature, ...reconcileBench(before.structure, { ...before.packed.layout, manual: {}, positions: {} }) };
    setArrangement(next);
    setCamera((value) => preserveViewedWindow(value, before.packed, next, viewportSize()));
  }, [viewportSize]);

  const bringToFront = useCallback((id: string) => {
    setLayout((value) => {
      const order = raiseWindow(value.order, id);
      return order === value.order ? value : { ...value, order };
    });
  }, [setLayout]);

  useLayoutEffect(() => {
    // Activity resumes effects when revisiting a bench; retain its in-memory view.
    if (ready) return;
    let stored: SavedBench = {};
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey) ?? "{}");
      if (value && typeof value === "object") stored = value;
    } catch { /* optional persistence */ }
    saved.current = stored.layout && typeof stored.layout === "object" ? stored.layout : {};
    const restored = { signature, ...reconcileBench(structure, stored.layout) };
    setArrangement(restored);
    current.current.packed = restored;
    setCamera(restoreBenchCamera(stored, space, restored, viewportSize()));
    setReady(true);
  }, [ready, storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (arrangement.signature === signature) return;
    setArrangement(packed);
    setCamera((value) => preserveViewedWindow(value, arrangement, packed, viewportSize()));
  }, [arrangement, packed, signature, viewportSize]);

  useEffect(() => {
    if (!ready) return;
    const size = viewportSize();
    const persist = () => {
      const anchor = viewedWindow(packed, camera, size);
      // Camera x is stored in screen coordinates; its logical space prevents cross-space restores.
      try { localStorage.setItem(storageKey, JSON.stringify({ space, layout, anchor, camera })); } catch { /* optional persistence */ }
    };
    persistOnHide.current = persist;
    const timer = setTimeout(persist, 250);
    return () => clearTimeout(timer);
  }, [ready, space, storageKey, layout, camera, packed, viewportSize]);
  // Flush on Activity hide, without synchronously writing on every pan/resize frame.
  useEffect(() => () => { persistOnHide.current?.(); }, []);
  useEffect(() => { onScale(camera.k); }, [camera.k, onScale]);
  useEffect(() => {
    setAnimating(false); setSettling(null); setGesture(null); setDragging(false);
    return () => { clearTimeout(animationTimer.current); clearTimeout(landingTimer.current); clearTimeout(settleTimer.current); dragCleanup.current?.(); };
  }, []);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setCamera((value) => {
      const k = clamp(value.k * factor, 0.3, 1.6);
      return { k, x: px - (px - value.x) * k / value.k, y: py - (py - value.y) * k / value.k };
    });
  }, []);
  const goToNode = useCallback((ref: NodeRef) => {
    const home = homeOf(ref);
    if (home.kind !== "space" || home.space !== space) return;
    setLayout((value) => ({ ...value, collapsed: { ...value.collapsed, [home.window]: false } }));
    clearTimeout(landingTimer.current);
    landingTimer.current = setTimeout(() => {
      const root = viewport.current;
      const frame = elements.current.get(home.window);
      if (!root || !frame) return;
      // Run after the navigation commit so a closing palette's focus return cannot undo the raise.
      bringToFront(home.window);
      const node = frame.querySelector<HTMLElement>(`[data-node="${CSS.escape(nodeKey(ref))}"]`) ?? frame;
      // Reveal inside bounded window bodies without scrolling the page or moving the camera.
      for (let parent = node.parentElement; parent && parent !== frame; parent = parent.parentElement) {
        if (parent.hasAttribute("data-scroll")) {
          const a = node.getBoundingClientRect(), b = parent.getBoundingClientRect();
          parent.scrollTop += (a.top - b.top - Math.max(0, (b.height - a.height) / 2)) / current.current.camera.k;
        }
      }
      const origin = world?.getBoundingClientRect();
      if (!origin) return;
      const rect = node.getBoundingClientRect();
      const scale = current.current.camera.k;
      const k = Math.max(0.8, scale);
      const x = (rect.left - origin.left) / scale;
      const y = (rect.top - origin.top) / scale;
      animate({ k, x: root.clientWidth / 2 - (x + rect.width / scale / 2) * k, y: rect.height / scale * k > root.clientHeight - 148 ? 84 - y * k : (root.clientHeight + 76) / 2 - (y + rect.height / scale / 2) * k });
      onArrive(ref);
    }, 0);
  }, [animate, bringToFront, onArrive, setLayout, space, world]);
  useEffect(() => {
    if (!ready || !world) return;
    onControls({ space, fit, tidy, goToNode, zoom: zoomAt });
    return () => onControls(null);
  }, [ready, world, space, fit, tidy, goToNode, zoomAt, onControls]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      const scroller = (event.target as Element).closest("[data-scroll]");
      if (scroller && !event.ctrlKey && !event.metaKey && scroller.scrollHeight > scroller.clientHeight) return;
      event.preventDefault(); setAnimating(false);
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      else setCamera((value) => ({ ...value, x: value.x - event.deltaX, y: value.y - event.deltaY }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (blocked || event.metaKey || event.ctrlKey || event.altKey || (event.target as Element).closest("input,textarea,select,button,a,[contenteditable=true],[data-dock],[role=dialog],[role=alertdialog]")) return;
      const value = event.key.toLowerCase();
      if (value.startsWith("arrow")) {
        const step = event.shiftKey ? 240 : 64;
        setCamera((camera) => ({ ...camera, x: camera.x + (value === "arrowleft" ? step : value === "arrowright" ? -step : 0), y: camera.y + (value === "arrowup" ? step : value === "arrowdown" ? -step : 0) }));
      } else if (value === "f") fit(); else if (value === "t") tidy(); else if (value === "+" || value === "=") zoomAt(1.2); else if (value === "-") zoomAt(1 / 1.2); else if (value === "0") zoomAt(1 / current.current.camera.k); else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [blocked, fit, tidy, zoomAt]);

  const drag = (event: React.PointerEvent, move: (x: number, y: number, free: boolean) => void, end?: () => void) => {
    event.preventDefault(); setAnimating(false); setDragging(true); dragCleanup.current?.();
    const x = event.clientX, y = event.clientY;
    // Holding Alt/Option places windows freely instead of on the grid.
    const onMove = (next: PointerEvent) => move(next.clientX - x, next.clientY - y, next.altKey);
    const stop = () => { setDragging(false); end?.(); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); dragCleanup.current = null; };
    dragCleanup.current = stop;
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
  };
  /** Release a gesture: the window glides from the pointer into its stored, grid-aligned layout. */
  const release = (id: string) => {
    setGesture((value) => {
      if (value?.id !== id) return value;
      setSettling(id);
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => setSettling(null), 220);
      return null;
    });
  };
  const placement = (id: string): WindowPlacement => {
    const def = geometry.windows.find((d) => d.id === id)!;
    const point = layout.positions[id];
    const origin = geometry.origins[def.space];
    if (!registrars.current.has(id)) registrars.current.set(id, (el) => {
      const previous = elements.current.get(id);
      if (previous && previous !== el) observer.current?.unobserve(previous);
      if (el) { elements.current.set(id, el); observer.current?.observe(el); } else elements.current.delete(id);
    });
    // Resizing, like dragging, changes only the local layout; origins repack on restore or tidy.
    const size = layout.sizes[id];
    const push = pushes[id] ?? 0;
    // Unsized windows grow with their content up to the height limit; a human-set or fixed height is exact.
    const fixed = def.fixed && def.height !== undefined ? def.height : undefined;
    const stored = { x: point.x + origin.x, y: point.y + origin.y + push, width: size?.width ?? def.width, height: size?.height ?? fixed ?? windowLimits.maxHeight, sized: (size?.height ?? fixed) !== undefined };
    const live = gesture?.id === id ? gesture : null;
    // While a gesture runs, the window follows the pointer and an outline marks where it will land.
    const shown = live?.kind === "move" ? { ...stored, x: origin.x + live.x, y: origin.y + live.y }
      : live?.kind === "resize" ? { ...stored, width: live.width ?? stored.width, ...(live.height !== undefined ? { height: live.height, sized: true } : null) }
      : stored;
    const target = live && !live.free && !(live.kind === "resize" && live.grooved)
      ? { x: stored.x, y: stored.y, width: stored.width, height: stored.sized ? stored.height : heights[id] ?? def.height ?? windowHeight } : null;
    return { ...shown, target, settling: settling === id, active: Boolean(live),
      z: layout.order.indexOf(id) + 1, collapsed: Boolean(layout.collapsed[id]), animating, dragging, register: registrars.current.get(id)!,
      onResizePointerDown: (event, edge) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const frame = elements.current.get(id);
        const start = { width: frame?.offsetWidth ?? def.width, height: frame?.offsetHeight ?? def.height ?? windowHeight };
        const k = camera.k;
        let moved = false;
        drag(event, (x, y, free) => {
          moved = true;
          const width = edge === "y" ? undefined : clamp(start.width + x / k, windowLimits.minWidth, windowLimits.maxWidth);
          let height = edge === "x" ? undefined : clamp(start.height + y / k, windowLimits.minHeight, windowLimits.maxHeight);
          // Content can rewrap as the width changes, so the fit is re-measured on every move.
          const fit = height !== undefined && frame ? naturalHeight(frame) : null;
          const grooved = height !== undefined && fit !== null && Math.abs(height - fit) * k <= fitDetent;
          if (grooved) height = fit!;
          setGesture({ id, kind: "resize", width, height, fit, grooved, free });
          setLayout((value) => {
            const next = { ...value.sizes[id] };
            if (width !== undefined) next.width = free ? Math.round(clamp(width, windowLimits.minWidth, windowLimits.maxWidth)) : snapSize(width, windowLimits.minWidth, windowLimits.maxWidth);
            // Released in the groove, the window keeps no height and goes on fitting its content.
            if (grooved) delete next.height;
            else if (height !== undefined) next.height = free ? Math.round(clamp(height, windowLimits.minHeight, windowLimits.maxHeight)) : snapSize(height, windowLimits.minHeight, windowLimits.maxHeight);
            const sizes = { ...value.sizes };
            if (next.width === undefined && next.height === undefined) delete sizes[id];
            else sizes[id] = next;
            return { ...value, sizes };
          });
        }, () => { if (moved) release(id); });
      },
      onResetSize: (edge) => setLayout((value) => {
        const next = { ...value.sizes[id] };
        if (edge !== "y") delete next.width;
        if (edge !== "x") delete next.height;
        const sizes = { ...value.sizes };
        if (next.width === undefined && next.height === undefined) delete sizes[id];
        else sizes[id] = next;
        return { ...value, sizes };
      }),
      onFocusWithin: () => bringToFront(id),
      onToggleCollapse: () => setLayout((value) => ({ ...value, collapsed: { ...value.collapsed, [id]: !value.collapsed[id] } })),
      onHeaderPointerDown: (event) => {
        const interactive = (event.target as Element).closest("button,a,[data-interactive],[tabindex]");
        if (event.button !== 0 || (interactive && event.currentTarget.contains(interactive))) return;
        const k = camera.k;
        let moved = false;
        drag(event, (x, y, free) => {
          if (!moved && Math.abs(x) + Math.abs(y) < 3) return;
          moved = true;
          // Start from where the window is drawn, including any push, so it stays under the pointer.
          const local = { x: point.x + x / k, y: point.y + push + y / k };
          const next = free ? { x: Math.round(local.x), y: Math.round(local.y) } : { x: snapLocal(local.x, origin.x), y: snapLocal(local.y, origin.y) };
          setGesture({ id, kind: "move", x: local.x, y: local.y, free });
          setLayout((value) => ({ ...value, manual: { ...value.manual, [id]: true }, positions: { ...value.positions, [id]: next } }));
        }, () => { if (moved) release(id); });
      },
    };
  };
  return (
    <PlacementContext value={placement}>
      <main ref={viewport} data-canvas="workbench" data-space={space} tabIndex={0} aria-label="Open bench" aria-describedby={`bench-gestures-${space}`} className={cn("canvas-dots fixed inset-y-0 right-[var(--sheet)] left-0 touch-none overflow-hidden overscroll-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", dragging ? "cursor-grabbing" : "cursor-grab")}
        style={{ backgroundSize: `${22 * camera.k}px ${22 * camera.k}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
        onPointerDown={(event) => {
          if ((event.button !== 0 && event.button !== 1) || (event.target as Element).closest("[data-window],[data-chrome]")) return;
          event.currentTarget.focus({ preventScroll: true });
          const start = camera;
          drag(event, (x, y) => setCamera({ ...start, x: start.x + x, y: start.y + y }));
        }}>
        <h1 className="sr-only">AgentStack open bench</h1>
        <p id={`bench-gestures-${space}`} className="sr-only">Drag empty space, scroll, or use arrow keys to pan. Pinch or use plus and minus to zoom. Drag a window edge to resize it; windows snap to the dot grid unless Option is held. F fits the bench; T resets window positions. Select a card name to inspect it. Command K opens navigation.</p>
        <div ref={setWorld} className={cn("absolute top-0 left-0 origin-top-left", !ready && "invisible", animating && "transition-transform duration-300 ease-out motion-reduce:transition-none", dragging && "select-none")}
          style={{ transform: `translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.k})` }}>
          <Lines world={world} scale={camera.k} version={settled} animating={animating || dragging || settling !== null} subtle={false} />
          {regions.map((region) => <Fragment key={region.id}>
            {region.defs.map((def) => <Fragment key={def.id}>{def.element}</Fragment>)}
          </Fragment>)}
        </div>
      </main>
    </PlacementContext>
  );
}
