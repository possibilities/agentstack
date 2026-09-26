"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { benchBounds, clamp, snapExtent, snapLocal, windowLimits, compensateLeft, fitBounds, preserveViewedWindow, raiseWindow, reconcileBench, restoreBenchCamera, viewedWindow, windowHeight, type BenchLayout, type Camera, type SavedBench } from "@/lib/stack/geometry";
import { homeOf, spaces, type SpaceId } from "@/lib/stack/spaces";
import { nodeKey, type NodeRef } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Lines } from "./lines";
import { useStack } from "./provider";
import { spaceViews } from "./spaces";
import { PlacementContext, type WindowPlacement } from "./window";

export type BenchControls = { fit(): void; tidy(): void; goToSpace(space: SpaceId): void; goToNode(ref: NodeRef): void; zoom(factor: number): void };
const storageKey = "agentstack.uix.bench.v1";

export function Bench({ space, left, blocked, onControls, onScale, onArrive }: {
  space: SpaceId; left: number; blocked: boolean; onControls(controls: BenchControls | null): void; onScale(scale: number): void; onArrive(ref: NodeRef): void;
}) {
  const state = useStack();
  const regions = spaces.map((s) => ({ ...s, defs: spaceViews[s.id].windows(state) }));
  const signature = JSON.stringify(regions.map((s) => ({ id: s.id, defs: s.defs.map(({ id, width, height, column }) => ({ id, width, height, column })) })));
  // Content refreshes cannot affect footprint or layout. Only registration geometry can.
  const structure = useMemo(() => regions.map((region) => ({
    id: region.id, windows: region.defs.map(({ id, width, height, column }) => ({ id, width, height, column })),
  })), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const [arrangement, setArrangement] = useState(() => ({ signature, ...reconcileBench(structure) }));
  // Supply new registrations during their first render, then commit before paint.
  // Dragging changes only the local layout; it never derives new region origins.
  const packed = useMemo(() => arrangement.signature === signature ? arrangement : {
    signature, ...reconcileBench(structure, arrangement.layout),
  }, [arrangement, signature, structure]);
  const { layout, geometry } = packed;
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
  const [world, setWorld] = useState<HTMLDivElement | null>(null);
  const viewport = useRef<HTMLElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const registrars = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const current = useRef({ camera, packed, structure, space });
  const animationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const landingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { current.current = { camera, packed, structure, space }; });

  const viewportSize = useCallback(() => ({ width: viewport.current?.clientWidth ?? 0, height: viewport.current?.clientHeight ?? 0 }), []);
  const worldBounds = useCallback((only?: SpaceId) => benchBounds(current.current.packed, only), []);
  const animate = useCallback((next: Camera) => {
    setAnimating(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setCamera(next);
    clearTimeout(animationTimer.current);
    animationTimer.current = setTimeout(() => setAnimating(false), 360);
  }, []);
  const goToSpace = useCallback((id: SpaceId) => {
    const el = viewport.current;
    if (el) animate(fitBounds(worldBounds(id), el.clientWidth, el.clientHeight, 0.65));
  }, [animate, worldBounds]);
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
    let saved: SavedBench = {};
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      if (value && typeof value === "object") saved = value;
    } catch { /* optional persistence */ }
    const restored = { signature, ...reconcileBench(structure, saved.layout) };
    setArrangement(restored);
    current.current.packed = restored;
    setCamera(restoreBenchCamera(saved, space, restored, viewportSize(), left));
    setReady(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (arrangement.signature === signature) return;
    setArrangement(packed);
    setCamera((value) => preserveViewedWindow(value, arrangement, packed, viewportSize()));
  }, [arrangement, packed, signature, viewportSize]);

  const previousLeft = useRef(left);
  useLayoutEffect(() => {
    if (previousLeft.current === left) return;
    const before = previousLeft.current;
    previousLeft.current = left;
    setAnimating(false);
    setCamera((value) => compensateLeft(value, before, left));
  }, [left]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      const anchor = viewedWindow(packed, camera, viewportSize());
      // Camera x is stored in screen coordinates; its logical space prevents cross-space restores.
      try { localStorage.setItem(storageKey, JSON.stringify({ space, layout, anchor, camera: { ...camera, x: camera.x + left } })); } catch { /* optional persistence */ }
    }, 250);
    return () => clearTimeout(timer);
  }, [ready, space, layout, camera, left, packed, viewportSize]);
  useEffect(() => { onScale(camera.k); }, [camera.k, onScale]);
  useEffect(() => () => { clearTimeout(animationTimer.current); clearTimeout(landingTimer.current); dragCleanup.current?.(); }, []);

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
    if (home.kind !== "space") return;
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
  }, [animate, bringToFront, onArrive, setLayout, world]);
  useEffect(() => {
    if (!ready || !world) return;
    onControls({ fit, tidy, goToSpace, goToNode, zoom: zoomAt });
    return () => onControls(null);
  }, [ready, world, fit, tidy, goToSpace, goToNode, zoomAt, onControls]);
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

  const drag = (event: React.PointerEvent, move: (x: number, y: number, free: boolean) => void) => {
    event.preventDefault(); setAnimating(false); setDragging(true); dragCleanup.current?.();
    const x = event.clientX, y = event.clientY;
    // Holding Alt/Option places windows freely instead of on the grid.
    const onMove = (next: PointerEvent) => move(next.clientX - x, next.clientY - y, next.altKey);
    const stop = () => { setDragging(false); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); dragCleanup.current = null; };
    dragCleanup.current = stop;
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
  };
  const placement = (id: string): WindowPlacement => {
    const def = geometry.windows.find((d) => d.id === id)!;
    const point = layout.positions[id];
    const origin = geometry.origins[def.space];
    if (!registrars.current.has(id)) registrars.current.set(id, (el) => { if (el) elements.current.set(id, el); else elements.current.delete(id); });
    // Resizing, like dragging, changes only the local layout; origins repack on restore or tidy.
    const size = layout.sizes[id];
    return { x: point.x + origin.x, y: point.y + origin.y, width: size?.width ?? def.width, height: size?.height ?? def.height ?? windowHeight, sized: size?.height !== undefined,
      z: layout.order.indexOf(id) + 1, collapsed: Boolean(layout.collapsed[id]), animating, dragging, register: registrars.current.get(id)!,
      onResizePointerDown: (event, edge) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const frame = elements.current.get(id);
        const start = { width: frame?.offsetWidth ?? def.width, height: frame?.offsetHeight ?? def.height ?? windowHeight };
        const k = camera.k;
        const world = { x: point.x + origin.x, y: point.y + origin.y };
        drag(event, (x, y, free) => setLayout((value) => {
          const previous = value.sizes[id] ?? {};
          const width = start.width + x / k, height = start.height + y / k;
          const next = {
            width: edge === "y" ? previous.width : Math.round(clamp(free ? width : snapExtent(world.x, width), windowLimits.minWidth, windowLimits.maxWidth)),
            height: edge === "x" ? previous.height : Math.round(clamp(free ? height : snapExtent(world.y, height), windowLimits.minHeight, windowLimits.maxHeight)),
          };
          return { ...value, sizes: { ...value.sizes, [id]: next } };
        }));
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
        drag(event, (x, y, free) => {
          if (Math.abs(x) + Math.abs(y) < 3) return;
          const local = { x: point.x + x / k, y: point.y + y / k };
          const next = free ? { x: Math.round(local.x), y: Math.round(local.y) } : { x: snapLocal(local.x, origin.x), y: snapLocal(local.y, origin.y) };
          setLayout((value) => ({ ...value, manual: { ...value.manual, [id]: true }, positions: { ...value.positions, [id]: next } }));
        });
      },
    };
  };
  return (
    <PlacementContext value={placement}>
      <main ref={viewport} data-canvas="workbench" tabIndex={0} aria-label="Open bench" aria-describedby="bench-gestures" className={cn("canvas-dots fixed inset-y-0 right-[var(--sheet)] left-[var(--system)] touch-none overflow-hidden overscroll-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", dragging ? "cursor-grabbing" : "cursor-grab")}
        style={{ backgroundSize: `${22 * camera.k}px ${22 * camera.k}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
        onPointerDown={(event) => {
          if ((event.button !== 0 && event.button !== 1) || (event.target as Element).closest("[data-window],[data-chrome]")) return;
          event.currentTarget.focus({ preventScroll: true });
          const start = camera;
          drag(event, (x, y) => setCamera({ ...start, x: start.x + x, y: start.y + y }));
        }}>
        <h1 className="sr-only">AgentStack open bench</h1>
        <p id="bench-gestures" className="sr-only">Drag empty space, scroll, or use arrow keys to pan. Pinch or use plus and minus to zoom. Drag a window edge to resize it; windows snap to the dot grid unless Option is held. F fits the bench; T resets window positions. Select a card name to inspect it. Command K opens navigation.</p>
        <div ref={setWorld} className={cn("absolute top-0 left-0 origin-top-left", !ready && "invisible", animating && "transition-transform duration-300 ease-out motion-reduce:transition-none", dragging && "select-none")}
          style={{ transform: `translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.k})` }}>
          <Lines world={world} scale={camera.k} version={layout} animating={animating || dragging} subtle={false} />
          {regions.map((region) => {
            const origin = geometry.origins[region.id];
            const bounds = geometry.regions.find((entry) => entry.id === region.id)!.bounds;
            return <Fragment key={region.id}>
              <h2 className="absolute text-sm font-medium tracking-wide text-muted-foreground" style={{ left: origin.x + bounds.x, top: origin.y + bounds.y - 36 }}>{region.title}</h2>
              {region.defs.map((def) => <Fragment key={def.id}>{def.element}</Fragment>)}
            </Fragment>;
          })}
        </div>
      </main>
    </PlacementContext>
  );
}
