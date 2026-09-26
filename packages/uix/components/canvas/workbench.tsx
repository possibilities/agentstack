"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, ChevronDownIcon, CpuIcon, LayersIcon, LayoutDashboardIcon, MinusIcon, PanelLeftIcon, PanelRightIcon, PlusIcon, ScanIcon, SearchIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { activeSurface, dockGeometry, dockMinimum, type BenchSurface } from "@/lib/stack/geometry";
import { emptyLocation, locationHref, navigateTo, parseLocation, type BenchLocation } from "@/lib/stack/navigation";
import { homeOf, spaceAttention, spaceHref, spaces, spaceTitle, type SpaceId } from "@/lib/stack/spaces";
import { nodeKey, type NodeRef, type Snapshot } from "@/lib/stack/types";
import { AuthActionsProvider } from "./auth-actions";
import { BotActionsProvider } from "./bot-actions";
import { Dock, useDockSizes } from "./dock";
import { Inspector } from "./inspector";
import { Palette, type PaletteAction } from "./palette";
import { StackProvider, useStack, WorkbenchContext, type WorkbenchValue } from "./provider";
import { Reference } from "./reference";
import { SystemPanel } from "./system-panel";
import { Bench, type BenchControls } from "./bench";
import { CallLauncher, VoiceProvider } from "./voice";

export function Workbench({ snapshot, initialSpace, initialFocus, initialLocation }: { snapshot: Snapshot; initialSpace: SpaceId; initialFocus: NodeRef | null; initialLocation?: BenchLocation }) {
  const start = initialLocation ?? (initialFocus ? navigateTo(emptyLocation(initialSpace), initialFocus) : emptyLocation(initialSpace));
  return <StackProvider snapshot={snapshot}><Shell initialLocation={start} /></StackProvider>;
}

function Shell({ initialLocation }: { initialLocation: BenchLocation }) {
  const [location, setLocation] = useState(initialLocation);
  const locationRef = useRef(location);
  const referenceReturn = useRef<HTMLElement | null>(null);
  const systemReturn = useRef<HTMLElement | null>(null);
  const inspectorReturn = useRef<HTMLElement | null>(null);
  const [hovered, hover] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ key: string; seq: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sequence = useRef(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [controls, setControls] = useState<BenchControls | null>(null);
  const controlsRef = useRef<BenchControls | null>(null);
  const pending = useRef<{ space: SpaceId; ref: NodeRef | null } | null>({ space: initialLocation.space, ref: initialLocation.focus });
  const [scale, setScale] = useState(1);
  const [screenWidth, setScreenWidth] = useState(1200);
  const [sizes, setSizes] = useDockSizes();
  const [expanded, setExpanded] = useState(false);
  const [surface, setSurface] = useState<BenchSurface>(() => activeSurface(undefined, openDocks(initialLocation)));
  const surfaceRef = useRef(surface);
  const benchFocusFrame = useRef<number | undefined>(undefined);
  const rightOpen = Boolean(location.reference || location.inspect);
  const { overlay, systemVisible, rightVisible, leftWidth, leftMax, rightWidth, rightMax, left, right } = dockGeometry({
    screenWidth, ...openDocks(location), surface, systemWidth: sizes.system,
    rightWidth: location.reference ? sizes.reference : sizes.inspector, expanded: expanded && Boolean(location.reference),
  });

  useLayoutEffect(() => {
    const initialSurface = activeSurface(new URLSearchParams(window.location.search).get("surface"), openDocks(initialLocation));
    surfaceRef.current = initialSurface;
    setSurface(initialSurface);
    setScreenWidth(window.innerWidth);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const update = () => setScreenWidth(window.innerWidth);
    update(); window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const flashNow = useCallback((ref: NodeRef) => {
    setFlash({ key: nodeKey(ref), seq: ++sequence.current });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1400);
  }, []);
  useEffect(() => () => {
    clearTimeout(flashTimer.current);
    if (benchFocusFrame.current !== undefined) cancelAnimationFrame(benchFocusFrame.current);
  }, []);
  const focusBench = useCallback(() => {
    if (benchFocusFrame.current !== undefined) cancelAnimationFrame(benchFocusFrame.current);
    benchFocusFrame.current = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-canvas=workbench]")?.focus({ preventScroll: true });
      benchFocusFrame.current = undefined;
    });
  }, []);
  const reportControls = useCallback((next: BenchControls | null) => {
    controlsRef.current = next; setControls(next);
    if (next && pending.current) {
      const target = pending.current; pending.current = null;
      if (target.ref) next.goToNode(target.ref);
      // Default load restores the saved camera; only explicit navigation fits a region.
    }
  }, []);
  const write = useCallback((next: BenchLocation, requestedSurface: BenchSurface = surfaceRef.current) => {
    const nextSurface = activeSurface(requestedSurface, openDocks(next));
    const url = new URL(locationHref(next), window.location.origin);
    url.searchParams.set("surface", nextSurface);
    const href = `${url.pathname}${url.search}`;
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.pushState(null, "", href);
    locationRef.current = next; setLocation(next);
    surfaceRef.current = nextSurface; setSurface(nextSurface);
    document.title = `AgentStack · ${next.reference && nextSurface === "right" ? "API reference" : spaceTitle(next.space)}`;
  }, []);
  const setSpace = useCallback((space: SpaceId) => {
    write({ ...locationRef.current, space, focus: null }, "bench");
    controlsRef.current?.goToSpace(space);
    focusBench();
  }, [focusBench, write]);
  const goTo = useCallback((ref: NodeRef) => {
    const home = homeOf(ref);
    if (home.kind === "reference" && !locationRef.current.reference) referenceReturn.current = document.activeElement as HTMLElement;
    if (home.kind === "reference" && !locationRef.current.reference && !locationRef.current.inspect) inspectorReturn.current = document.activeElement as HTMLElement;
    if (home.kind === "system" && !locationRef.current.system) systemReturn.current = document.activeElement as HTMLElement;
    write(navigateTo(locationRef.current, ref), home.kind === "space" ? "bench" : home.kind === "system" ? "left" : "right");
    if (home.kind === "space") {
      if (controlsRef.current) controlsRef.current.goToNode(ref);
      else pending.current = { space: home.space, ref };
      focusBench();
    } else if (home.kind === "system") flashNow(ref);
  }, [flashNow, focusBench, write]);
  const select = useCallback((ref: NodeRef | null) => {
    if (ref && homeOf(ref).kind === "reference") { goTo(ref); return; }
    if (ref && !locationRef.current.inspect && !locationRef.current.reference) inspectorReturn.current = document.activeElement as HTMLElement;
    write({ ...locationRef.current, inspect: ref, reference: null }, "right");
  }, [goTo, write]);
  // A removed record closes its inspection without disturbing an open reference.
  const dropInspect = useCallback((ref: NodeRef) => {
    const current = locationRef.current;
    if (current.inspect && nodeKey(current.inspect) === nodeKey(ref)) write({ ...current, inspect: null });
  }, [write]);
  const openSystem = useCallback(() => {
    if (!locationRef.current.system) systemReturn.current = document.activeElement as HTMLElement;
    write({ ...locationRef.current, system: locationRef.current.system ?? "open" }, "left");
  }, [write]);
  const openReference = useCallback(() => {
    if (!locationRef.current.reference) referenceReturn.current = document.activeElement as HTMLElement;
    if (!locationRef.current.reference && !locationRef.current.inspect) inspectorReturn.current = document.activeElement as HTMLElement;
    write({ ...locationRef.current, reference: locationRef.current.reference ?? "overview" }, "right");
  }, [write]);
  const referenceOverview = useCallback(() => write({ ...locationRef.current, reference: "overview" }, "right"), [write]);
  const openInspector = useCallback(() => {
    if (!locationRef.current.inspect) return;
    inspectorReturn.current = document.activeElement as HTMLElement;
    write({ ...locationRef.current, reference: null }, "right");
  }, [write]);
  const closeSystem = useCallback(() => write({ ...locationRef.current, system: null }), [write]);
  const closeRight = useCallback(() => {
    const current = locationRef.current;
    write(current.reference ? { ...current, reference: null } : { ...current, inspect: null });
    if (current.reference && current.inspect) requestAnimationFrame(() => {
      const target = referenceReturn.current;
      if (target?.isConnected && !target.closest("[inert],[hidden]")) target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>("[data-inspector-heading]")?.focus({ preventScroll: true });
    });
  }, [write]);

  useEffect(() => {
    const pop = () => {
      const query = new URLSearchParams(window.location.search);
      const next = parseLocation(window.location.pathname, query);
      if (!next) return;
      const previous = locationRef.current;
      locationRef.current = next; setLocation(next);
      const nextSurface = activeSurface(query.get("surface"), openDocks(next));
      surfaceRef.current = nextSurface; setSurface(nextSurface);
      document.title = `AgentStack · ${next.reference && nextSurface === "right" ? "API reference" : spaceTitle(next.space)}`;
      // Dock/inspection history must never move the camera.
      if (nodeKeyOrNull(next.focus) !== nodeKeyOrNull(previous.focus) || next.space !== previous.space) {
        if (next.focus) controlsRef.current?.goToNode(next.focus);
        else controlsRef.current?.goToSpace(next.space);
      }
      if (nextSurface === "bench") focusBench();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [focusBench]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen((value) => !value); return; }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || paletteOpen || (event.target as Element).closest("input,textarea,select,button,a,[contenteditable=true],[role=dialog],[role=alertdialog]")) return;
      if (event.key === "Escape") {
        if (rightVisible) closeRight(); else if (systemVisible) closeSystem(); else return;
        event.preventDefault();
      }
      const space = spaces.find((s) => s.key === event.key);
      if (space) setSpace(space.id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [paletteOpen, rightVisible, systemVisible, closeRight, closeSystem, setSpace]);

  const actions: PaletteAction[] = useMemo(() => [
    { id: "system", label: "Open System dock", icon: CpuIcon, run: openSystem },
    { id: "reference", label: "Open API reference", icon: BookOpenIcon, run: openReference },
    ...(location.inspect ? [{ id: "inspector", label: "Return to inspector", icon: PanelRightIcon, run: openInspector }] : []),
    ...(controls ? [
      { id: "fit", label: "Fit bench", shortcut: "F", icon: ScanIcon, run: controls.fit },
      { id: "tidy", label: "Reset local window positions", shortcut: "T", icon: LayoutDashboardIcon, run: controls.tidy },
    ] : []),
  ], [controls, location.inspect, openSystem, openReference, openInspector]);
  const workbench: WorkbenchValue = useMemo(() => ({ space: location.space, setSpace, selected: location.inspect, hovered, select, hover, goTo, flash }), [location.space, location.inspect, setSpace, hovered, select, goTo, flash]);
  return <div className="contents" style={{ "--system": `${left}px`, "--sheet": `${right}px` } as React.CSSProperties}>
    <WorkbenchContext value={workbench}><AuthActionsProvider><VoiceProvider><BotActionsProvider>
      <Bench space={location.space} left={left} blocked={paletteOpen} onControls={reportControls} onScale={setScale} onArrive={flashNow} />
      <TopBar space={location.space} setSpace={setSpace} compact={screenWidth - left - right < 440} system={systemVisible} reference={Boolean(location.reference) && rightVisible} inspectorAvailable={overlay && Boolean(location.inspect) && !rightVisible} openInspector={openInspector} toggleSystem={systemVisible ? closeSystem : openSystem} toggleReference={Boolean(location.reference) && rightVisible ? closeRight : openReference} openPalette={() => setPaletteOpen(true)} fit={() => controls?.fit()} />
      <div data-chrome className="fixed bottom-4 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-card/95 p-1 shadow-sm" style={{ left: "calc(var(--system) + (100% - var(--system) - var(--sheet))/2)" }}>
        <Tool label="Zoom out" onClick={() => controls?.zoom(1 / 1.2)}><MinusIcon /></Tool>
        <Button variant="ghost" size="sm" aria-label="Actual size" className="w-14 tabular-nums" onClick={() => controls?.zoom(1 / scale)}>{Math.round(scale * 100)}%</Button>
        <Tool label="Zoom in" onClick={() => controls?.zoom(1.2)}><PlusIcon /></Tool>
        <Separator orientation="vertical" className="mx-1 h-5! self-center" />
        <Tool label="Fit bench (F)" onClick={() => controls?.fit()}><ScanIcon /></Tool>
        <Tool label="Reset window positions (T)" onClick={() => controls?.tidy()}><LayoutDashboardIcon /></Tool>
      </div>
      <Dock side="left" label="System" open={systemVisible} overlay={overlay} width={leftWidth} min={dockMinimum.left} max={leftMax} onResize={(system) => setSizes((s) => ({ ...s, system }))} onClose={closeSystem} returnFocus={systemReturn} restoreFocusOnHide={!location.system && (!overlay || surface === "bench")}>
        <SystemPanel target={location.system} visible={systemVisible} onClose={closeSystem} />
      </Dock>
      <Dock side="right" label={location.reference ? "API reference" : "Inspector"} open={rightVisible} overlay={overlay} width={rightWidth} min={dockMinimum.right} max={rightMax}
        onResize={(width) => { setExpanded(false); setSizes((s) => ({ ...s, [location.reference ? "reference" : "inspector"]: width })); }} onClose={closeRight} returnFocus={inspectorReturn} restoreFocusOnHide={!rightOpen && (!overlay || surface === "bench")}>
        <Inspector hidden={Boolean(location.reference)} onGone={dropInspect} />
        {location.reference ? <Reference target={location.reference} onOverview={referenceOverview} onClose={closeRight} hasInspection={Boolean(location.inspect)} expanded={expanded} onExpand={() => setExpanded((value) => !value)} /> : null}
      </Dock>
      <Palette open={paletteOpen} onOpenChange={setPaletteOpen} actions={actions} />
    </BotActionsProvider></VoiceProvider></AuthActionsProvider></WorkbenchContext>
  </div>;
}

const nodeKeyOrNull = (ref: NodeRef | null) => ref ? nodeKey(ref) : null;
const openDocks = (location: BenchLocation) => ({ systemOpen: Boolean(location.system), rightOpen: Boolean(location.reference || location.inspect) });
function Tool({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

/** Places and tools are separate: the Spaces menu moves the camera; System and API open docks on their own edges. */
function TopBar({ space, setSpace, compact, system, reference, inspectorAvailable, openInspector, toggleSystem, toggleReference, openPalette, fit }: {
  space: SpaceId; setSpace(space: SpaceId): void; compact: boolean; system: boolean; reference: boolean; inspectorAvailable: boolean; openInspector(): void; toggleSystem(): void; toggleReference(): void; openPalette(): void; fit(): void;
}) {
  const state = useStack();
  const attention = spaceAttention(state);
  const closed = Object.entries(state.status).filter(([, status]) => status === "closed").map(([name]) => `${name} reconnecting`);
  const reasons = [...new Set([...attention.system, ...closed])];
  const elsewhere = spaces.some((item) => item.id !== (space as string) && (attention as Record<string, string[]>)[item.id].length > 0);
  const dot = <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="needs attention" />;
  return <header data-chrome className="pointer-events-none fixed top-3 z-30 flex items-start justify-between gap-2" style={{ left: "calc(var(--system) + 12px)", right: "calc(var(--sheet) + 12px)" }}>
    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-card/95 p-1 shadow-sm">
      <Tooltip><TooltipTrigger render={<Button data-dock-trigger="left" variant="ghost" size="sm" aria-label="Show System" aria-pressed={system} onClick={toggleSystem} className="aria-pressed:bg-muted" />}>
        <PanelLeftIcon data-icon="inline-start" />{!compact ? "System" : null}{reasons.length ? dot : null}
      </TooltipTrigger><TooltipContent side="bottom" className="max-w-80">{reasons.length ? reasons.join(" · ") : "Processes, connections, activity"}</TooltipContent></Tooltip>
      {!compact ? <Separator orientation="vertical" className="mx-0.5 h-5! self-center" /> : null}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={`Spaces · ${spaceTitle(space)}`} className="gap-1.5 font-semibold" />}>
          <LayersIcon data-icon="inline-start" />{!compact ? spaceTitle(space) : null}{attention[space].length || elsewhere ? dot : null}<ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Spaces</DropdownMenuLabel>
            {spaces.map((item) => (
              <DropdownMenuItem key={item.id} aria-current={item.id === space ? "location" : undefined} title={attention[item.id].join(" · ") || undefined}
                render={<a href={spaceHref(item.id)} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); setSpace(item.id); } }} />}>
                <LayersIcon />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 font-medium">{item.title}{attention[item.id].length ? dot : null}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                </span>
                <DropdownMenuShortcut>{item.key}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={fit}><ScanIcon />Show all<DropdownMenuShortcut>F</DropdownMenuShortcut></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {/* Mirrors the left pill: same surface, same ghost buttons, the dock toggle on the outer edge. */}
    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-card/95 p-1 shadow-sm">
      {!compact ? <CallLauncher /> : null}
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Jump to (Command K)" onClick={openPalette} />}><SearchIcon /></TooltipTrigger><TooltipContent side="bottom">Jump to <kbd className="ml-1 font-sans opacity-70">⌘K</kbd></TooltipContent></Tooltip>
      {inspectorAvailable ? <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Return to inspector" onClick={openInspector} />}><PanelRightIcon /></TooltipTrigger><TooltipContent side="bottom">Inspector</TooltipContent></Tooltip> : null}
      {!compact ? <Separator orientation="vertical" className="mx-0.5 h-5! self-center" /> : null}
      <Tooltip><TooltipTrigger render={<Button data-dock-trigger="right" variant="ghost" size="sm" aria-label="Show API reference" aria-pressed={reference} onClick={toggleReference} className="aria-pressed:bg-muted" />}>
        <BookOpenIcon data-icon="inline-start" />{!compact ? "API" : null}{attention.api.length ? dot : null}
      </TooltipTrigger><TooltipContent side="bottom" className="max-w-80">{attention.api.length ? attention.api.join(" · ") : "Package API reference"}</TooltipContent></Tooltip>
    </div>
  </header>;
}
