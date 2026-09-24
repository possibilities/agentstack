"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  BookOpenIcon,
  BotIcon,
  CpuIcon,
  KeyRoundIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  MinusIcon,
  MousePointer2Icon,
  PlusIcon,
  ScanIcon,
  SearchIcon,
  ServerIcon,
  SquareDashedMousePointerIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nodeKey, type NodeRef, type Snapshot } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { AuthActionsProvider } from "./auth-actions";
import { Inspector } from "./inspector";
import { Lines } from "./lines";
import { Palette, type PaletteAction } from "./palette";
import { StatusDot } from "./primitives";
import { StackProvider, useStack, WorkbenchContext, type Mode, type WorkbenchValue } from "./provider";
import { accentTile, PlacementContext, type Accent, type WindowPlacement } from "./window";
import { AccountsWindow, ActivityWindow, ApiWindow, BotsWindow, ServersWindow, SystemWindow } from "./windows";

type Point = { x: number; y: number };
type View = Point & { k: number };
type Layout = { positions: Record<string, Point>; collapsed: Record<string, boolean>; order: string[] };

type WindowDef = { id: string; title: string; icon: React.ComponentType<{ className?: string }>; accent: Accent; width: number; column: number; render: React.ComponentType };

const windows: WindowDef[] = [
  { id: "system", title: "System", icon: CpuIcon, accent: "owner", width: 340, column: 0, render: SystemWindow },
  { id: "activity", title: "Activity", icon: ActivityIcon, accent: "events", width: 340, column: 0, render: ActivityWindow },
  { id: "accounts", title: "Accounts", icon: KeyRoundIcon, accent: "auth", width: 320, column: 1, render: AccountsWindow },
  { id: "servers", title: "Servers", icon: ServerIcon, accent: "codex", width: 380, column: 2, render: ServersWindow },
  { id: "bots", title: "Bots", icon: BotIcon, accent: "bots", width: 340, column: 3, render: BotsWindow },
  { id: "api", title: "API", icon: BookOpenIcon, accent: "api", width: 420, column: 4, render: ApiWindow },
];
const renderers = new Map(windows.map((item) => [item.id, item.render]));
const gridOrder = ["system", "accounts", "servers", "bots", "activity", "api"];
const homeWindow: Record<NodeRef["kind"], string> = {
  owner: "system", child: "system", account: "accounts", login: "accounts", server: "servers", bot: "bots", package: "api", operation: "api",
};

const storageKey = "agentstack.uix.canvas.v1";
const gapX = 72;
const gapY = 24;
const top = 76;
const gridGap = 20;
const gridMinColumn = 340;
const pad = 32;
const minScale = 0.3;
const maxScale = 1.6;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function initialLayout(): Layout {
  let x = 0;
  const positions: Record<string, Point> = {};
  for (let column = 0; column <= 4; column += 1) {
    const members = windows.filter((item) => item.column === column);
    members.forEach((item, index) => { positions[item.id] = { x, y: index * 520 }; });
    x += Math.max(...members.map((item) => item.width)) + gapX;
  }
  return { positions, collapsed: {}, order: windows.map((item) => item.id) };
}

export function Workbench({ snapshot }: { snapshot: Snapshot }) {
  return (
    <StackProvider snapshot={snapshot}>
      <Shell />
    </StackProvider>
  );
}

function Shell() {
  const viewport = useRef<HTMLElement>(null);
  const [world, setWorld] = useState<HTMLDivElement | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const registrars = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const [mode, setMode] = useState<Mode>("canvas");
  const [view, setView] = useState<View>({ x: pad, y: top, k: 1 });
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const [ready, setReady] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const viewRef = useRef(view);
  const layoutRef = useRef(layout);
  const animationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    viewRef.current = view;
    layoutRef.current = layout;
  });

  const animate = useCallback((change: () => void) => {
    setAnimating(true);
    change();
    clearTimeout(animationTimer.current);
    animationTimer.current = setTimeout(() => setAnimating(false), 560);
  }, []);

  const size = (id: string) => {
    const element = elements.current.get(id);
    return { width: element?.offsetWidth ?? windows.find((item) => item.id === id)!.width, height: element?.offsetHeight ?? 400 };
  };

  const tidied = useCallback((): Record<string, Point> => {
    const positions: Record<string, Point> = {};
    let x = 0;
    for (let column = 0; column <= 4; column += 1) {
      let y = 0;
      const members = windows.filter((item) => item.column === column);
      for (const item of members) {
        positions[item.id] = { x, y };
        y += size(item.id).height + gapY;
      }
      x += Math.max(...members.map((item) => item.width)) + gapX;
    }
    return positions;
  }, []);

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
  }, []);

  /** Opening view: the live columns fill the width at a readable scale; the API catalog peeks in from the right. */
  const primaryView = useCallback((positions: Record<string, Point>): View => {
    const element = viewport.current;
    if (!element) return viewRef.current;
    const live = windows.filter((item) => item.column <= 3);
    const minX = Math.min(...live.map((item) => positions[item.id].x));
    const maxX = Math.max(...live.map((item) => positions[item.id].x + size(item.id).width));
    const availableWidth = element.clientWidth - pad * 2;
    const k = clamp(availableWidth / (maxX - minX), 0.8, 1);
    return { k, x: pad + Math.max(0, (availableWidth - (maxX - minX) * k) / 2) - minX * k, y: top - Math.min(...live.map((item) => positions[item.id].y)) * k };
  }, []);

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

  // Restore saved arrangement before first paint; otherwise tidy and fit.
  useLayoutEffect(() => {
    let saved: { mode?: Mode; layout?: Partial<Layout>; view?: View } = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      saved = {};
    }
    const fresh = tidied();
    const positions = { ...fresh, ...saved.layout?.positions };
    const next: Layout = {
      positions,
      collapsed: saved.layout?.collapsed ?? {},
      order: [...new Set([...(saved.layout?.order ?? []), ...windows.map((item) => item.id)])].filter((id) => windows.some((item) => item.id === id)),
    };
    setLayout(next);
    setView(saved.view ?? primaryView(positions));
    setMode(saved.mode ?? (window.innerWidth < 900 ? "grid" : "canvas"));
    setReady(true);
  }, [primaryView, tidied]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => localStorage.setItem(storageKey, JSON.stringify({ mode, layout, view })), 250);
    return () => clearTimeout(timer);
  }, [ready, mode, layout, view]);

  // Grid mode: masonry columns, each window placed in reading order into the shortest column.
  const [gridColumns, setGridColumns] = useState<string[][]>([gridOrder]);
  useLayoutEffect(() => {
    if (mode !== "grid" || !world) return;
    let frame = 0;
    const arrange = () => {
      const count = clamp(Math.floor((world.clientWidth + gridGap) / (gridMinColumn + gridGap)), 1, 4);
      const heights = new Array<number>(count).fill(0);
      const columns = Array.from({ length: count }, () => [] as string[]);
      for (const id of gridOrder) {
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
  }, [mode, world, gridColumns]);

  const focusWindow = useCallback((id: string) => {
    const element = viewport.current;
    const position = layoutRef.current.positions[id];
    if (!element || !position) return;
    const k = Math.max(viewRef.current.k, 0.8);
    animate(() => setView({ k, x: element.clientWidth / 2 - (position.x + size(id).width / 2) * k, y: top + 12 - position.y * k }));
  }, [animate]);

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

  const select = useCallback((ref: NodeRef | null) => setSelected(ref), []);

  const focus = useCallback((ref: NodeRef) => {
    setSelected(ref);
    const home = homeWindow[ref.kind];
    const wasCollapsed = layoutRef.current.collapsed[home];
    if (wasCollapsed) setLayout((current) => ({ ...current, collapsed: { ...current.collapsed, [home]: false } }));
    setTimeout(() => {
      const node = document.querySelector(`[data-node="${CSS.escape(nodeKey(ref))}"]`) ?? document.querySelector(`[data-window="${home}"]`);
      if (!node) return;
      if (mode === "grid" || !world) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      const current = viewRef.current;
      const origin = world.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const cx = (rect.left + rect.width / 2 - origin.left) / current.k;
      const cy = (rect.top + rect.height / 2 - origin.top) / current.k;
      const element = viewport.current!;
      const k = current.k < 0.7 ? 1 : current.k;
      const visibleWidth = element.clientWidth - (element.clientWidth > 900 ? 440 : 0);
      animate(() => setView({ k, x: visibleWidth / 2 - cx * k, y: (element.clientHeight + top) / 2 - cy * k }));
    }, wasCollapsed ? 60 : 0);
  }, [animate, mode, world]);

  const toggleMode = useCallback(() => setMode((current) => current === "canvas" ? "grid" : "canvas"), []);

  const actions: PaletteAction[] = useMemo(() => [
    { id: "fit", label: "Fit everything in view", shortcut: "F", icon: ScanIcon, run: fit },
    { id: "tidy", label: "Tidy windows", shortcut: "T", icon: LayoutDashboardIcon, run: tidy },
    { id: "mode", label: mode === "canvas" ? "Switch to grid" : "Switch to canvas", shortcut: "G", icon: mode === "canvas" ? LayoutGridIcon : SquareDashedMousePointerIcon, run: toggleMode },
  ], [fit, tidy, toggleMode, mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || paletteOpen || target.closest("input,textarea,[contenteditable=true],[role=dialog],[role=alertdialog]")) return;
      const key = event.key.toLowerCase();
      if (key === "g") toggleMode();
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
      if (!moved) setSelected(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const placement = useCallback((id: string): WindowPlacement => {
    const item = windows.find((entry) => entry.id === id)!;
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
      onHeaderPointerDown: (event) => {
        if (event.button !== 0 || (event.target as Element).closest("button,a,[data-interactive],[tabindex]")) return;
        event.preventDefault();
        const start = { px: event.clientX, py: event.clientY, ...position };
        setDragging(id);
        const move = (next: PointerEvent) => {
          const k = viewRef.current.k;
          setLayout((current) => ({
            ...current,
            positions: { ...current.positions, [id]: { x: Math.round(start.x + (next.clientX - start.px) / k), y: Math.round(start.y + (next.clientY - start.py) / k) } },
          }));
        };
        const up = () => {
          setDragging(null);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
    };
  }, [animating, dragging, layout, mode]);

  const workbench: WorkbenchValue = useMemo(() => ({ mode, selected, hovered, select, hover: setHovered, focus }), [mode, selected, hovered, select, focus]);
  const canvas = mode === "canvas";

  return (
    <WorkbenchContext value={workbench}>
      <AuthActionsProvider>
        <PlacementContext value={placement}>
          <main
            ref={viewport}
            data-canvas="workbench"
            onPointerDown={onBackgroundPointerDown}
            className={cn("canvas-dots", canvas ? "fixed inset-0 touch-none overflow-hidden overscroll-none" : "min-h-dvh", canvas && (panning ? "cursor-grabbing" : "cursor-grab"))}
            style={canvas ? { backgroundSize: `${22 * view.k}px ${22 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` } : { backgroundSize: "22px 22px" }}
          >
            <div aria-hidden className="pointer-events-none fixed inset-0 bg-[radial-gradient(90%_60%_at_50%_-10%,color-mix(in_oklch,var(--pkg-codex)_9%,transparent),transparent_70%)]" />
            <h1 className="sr-only">AgentStack canvas</h1>
            {canvas ? (
              <div
                ref={setWorld}
                className={cn("absolute top-0 left-0 origin-top-left transition-opacity duration-500", ready ? "opacity-100" : "opacity-0", animating && "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]", dragging && "select-none")}
                style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})` }}
              >
                <Lines world={world} scale={view.k} version={[layout, mode]} animating={animating || dragging !== null} subtle={false} />
                {windows.map(({ id, render: Render }) => <Render key={id} />)}
              </div>
            ) : (
              <div className={cn("relative mx-auto max-w-[1760px] px-4 pt-20 pb-16 transition-opacity duration-500 sm:px-6", ready ? "opacity-100" : "opacity-0")}>
                <div ref={setWorld} className="relative">
                  <Lines world={world} scale={1} version={[layout, mode, gridColumns]} animating={false} subtle />
                  <div className="flex items-start gap-5">
                    {gridColumns.map((column, index) => (
                      <div key={index} className="flex min-w-0 flex-1 flex-col gap-5">
                        {column.map((id) => {
                          const Render = renderers.get(id)!;
                          return <Render key={id} />;
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </main>
          {canvas && ready ? <OffscreenHints view={view} positions={layout.positions} collapsed={layout.collapsed} size={size} viewport={viewport.current} onFocus={focusWindow} /> : null}
          <TopBar mode={mode} setMode={setMode} openPalette={() => setPaletteOpen(true)} />
          {canvas ? <CanvasToolbar scale={view.k} zoom={(factor) => animate(() => zoomAt(factor))} fit={fit} tidy={tidy} /> : null}
          <Inspector />
          <Palette open={paletteOpen} onOpenChange={setPaletteOpen} actions={actions} />
        </PlacementContext>
      </AuthActionsProvider>
    </WorkbenchContext>
  );
}

const packageOrder = ["owner", "auth", "codex", "bots", "api"];

function TopBar({ mode, setMode, openPalette }: { mode: Mode; setMode(mode: Mode): void; openPalette(): void }) {
  const { status, endpoints, scoped } = useStack();
  const live = packageOrder.filter((name) => status[name] === "open").length;
  const scopedLive = Object.values(scoped).filter((value) => value.status === "open").length;
  return (
    <div data-chrome className="pointer-events-none fixed inset-x-3 top-3 z-30 flex items-start justify-between gap-3">
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border bg-card/80 py-1.5 pr-3 pl-1.5 shadow-sm backdrop-blur-xl sm:gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background shadow-inner">
          <LayersIcon className="size-4" />
        </span>
        <div className="hidden flex-col leading-tight sm:flex">
          <span className="text-sm font-semibold tracking-tight">AgentStack</span>
          <span className="text-[0.68rem] text-muted-foreground">Live canvas</span>
        </div>
        <Separator orientation="vertical" className="mx-0.5 hidden h-6! self-center sm:block" />
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring" />}>
            <span className="flex items-center gap-1">
              {packageOrder.map((name) => (
                <StatusDot key={name} tone={status[name] === "open" ? "success" : status[name] === "closed" ? "destructive" : endpoints[name] ? "muted" : "warning"} />
              ))}
            </span>
            <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">{live}/{packageOrder.length} live</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex-col items-stretch gap-1 py-2">
            {packageOrder.map((name) => (
              <span key={name} className="flex items-center justify-between gap-6">
                <span className="font-medium">{name}</span>
                <span className="opacity-70">{endpoints[name] ? status[name] ?? "idle" : "no WebSocket endpoint"}</span>
              </span>
            ))}
            <span className="mt-1 border-t border-background/20 pt-1 opacity-70">{scopedLive} scoped Server subscription{scopedLive === 1 ? "" : "s"}</span>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="pointer-events-auto flex items-center gap-2">
        <Button variant="outline" className="h-10 gap-2 rounded-xl bg-card/80 pr-1.5 pl-3 text-muted-foreground shadow-sm backdrop-blur-xl" onClick={openPalette}>
          <SearchIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Jump to…</span>
          <Kbd>⌘K</Kbd>
        </Button>
        <ToggleGroup
          value={[mode]}
          onValueChange={(value) => { if (value[0]) setMode(value[0] as Mode); }}
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
function OffscreenHints({ view, positions, collapsed, size, viewport, onFocus }: {
  view: View;
  positions: Record<string, Point>;
  collapsed: Record<string, boolean>;
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
  const hints = windows.flatMap((item) => {
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
      <div data-chrome className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-card/80 p-1 shadow-sm backdrop-blur-xl">
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
