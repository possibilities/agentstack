"use client";

import { createContext, use } from "react";
import { ChevronDownIcon, GripHorizontalIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nodeKey, type ChannelStatus, type NodeRef } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { StatusDot, Time } from "./primitives";
import { useWorkbench } from "./provider";

export type Accent = "owner" | "auth" | "bots" | "api" | "events" | "roles" | "notify" | "content" | "worker" | "scrape";

export const accentTile: Record<Accent, string> = {
  owner: "bg-pkg-owner/15 text-pkg-owner",
  auth: "bg-pkg-auth/15 text-pkg-auth",
  bots: "bg-pkg-bots/15 text-pkg-bots",
  api: "bg-pkg-api/15 text-pkg-api",
  events: "bg-pkg-events/15 text-pkg-events",
  roles: "bg-pkg-roles/15 text-pkg-roles",
  notify: "bg-pkg-notify/15 text-pkg-notify",
  content: "bg-pkg-content/15 text-pkg-content",
  worker: "bg-pkg-worker/15 text-pkg-worker",
  scrape: "bg-pkg-scrape/15 text-pkg-scrape",
};

export const accentText: Record<Accent, string> = {
  owner: "text-pkg-owner",
  auth: "text-pkg-auth",
  bots: "text-pkg-bots",
  api: "text-pkg-api",
  events: "text-pkg-events",
  roles: "text-pkg-roles",
  notify: "text-pkg-notify",
  content: "text-pkg-content",
  worker: "text-pkg-worker",
  scrape: "text-pkg-scrape",
};

export const accentBg: Record<Accent, string> = {
  owner: "bg-pkg-owner",
  auth: "bg-pkg-auth",
  bots: "bg-pkg-bots",
  api: "bg-pkg-api",
  events: "bg-pkg-events",
  roles: "bg-pkg-roles",
  notify: "bg-pkg-notify",
  content: "bg-pkg-content",
  worker: "bg-pkg-worker",
  scrape: "bg-pkg-scrape",
};

export function accentOf(pkg: string): Accent {
  return pkg in accentTile ? (pkg as Accent) : "owner";
}

export type WindowPlacement = {
  x: number;
  y: number;
  z: number;
  width: number;
  /** The exact height once a human sizes the window; otherwise the ceiling content can grow to. */
  height: number;
  sized: boolean;
  collapsed: boolean;
  animating: boolean;
  dragging: boolean;
  /** This window is the one being moved or resized; it follows the pointer untransitioned. */
  active: boolean;
  /** Just released: gliding into its stored spot. */
  settling: boolean;
  /** Where a live gesture will land on the grid. */
  target: { x: number; y: number; width: number; height: number } | null;
  onHeaderPointerDown(event: React.PointerEvent): void;
  onResizePointerDown(event: React.PointerEvent, edge: ResizeEdge): void;
  onResetSize(edge: ResizeEdge): void;
  onFocusWithin(): void;
  onToggleCollapse(): void;
  register(element: HTMLElement | null): void;
};

export type ResizeEdge = "x" | "y" | "xy";

export const PlacementContext = createContext<((id: string) => WindowPlacement) | null>(null);

const statusCopy: Record<ChannelStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  open: "Live",
  closed: "Reconnecting…",
};

export function Window({ id, title, subtitle, icon: Icon, accent, count, status, endpoint, updatedAt, error, actions, footer, node, reveal, bleed = false, empty = false, children }: {
  id: string;
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
  count?: number | null;
  status?: ChannelStatus;
  endpoint?: string;
  updatedAt?: number | null;
  error?: string | null;
  /** Showing only a placeholder: fit it, treating a human-set height as a ceiling. */
  /** Creation controls, pinned below the body so the header stays for identity and status. */
  footer?: React.ReactNode;
  empty?: boolean;
  actions?: React.ReactNode;
  /** When the window represents a node, a header tap or the title button inspects it. */
  node?: NodeRef;
  /** A navigation destination that flashes the window; alone, it does not make the window inspectable. */
  reveal?: NodeRef;
  /** The body has no padding or scrolling of its own; the content manages both. */
  bleed?: boolean;
  children: React.ReactNode;
}) {
  const placement = use(PlacementContext)?.(id);
  if (!placement) throw new Error("Window requires PlacementContext");
  const { selected, select, flash } = useWorkbench();
  const key = node ? nodeKey(node) : reveal ? nodeKey(reveal) : null;
  const isSelected = node !== undefined && selected !== null && nodeKey(selected) === key;
  const flashing = flash !== null && (flash.key === key || (reveal !== undefined && flash.key === nodeKey(reveal)));
  const toggle = () => {
    if (node) select(isSelected ? null : node);
  };
  const tone = status === "open" ? (error ? "warning" : "success") : status === "closed" ? "destructive" : "muted";
  return (
    <>
    {placement.target ? (
      <div aria-hidden data-drop-target={id} className="pointer-events-none absolute rounded-2xl border-2 border-dashed border-foreground/15 bg-foreground/[0.03]"
        style={{ left: placement.target.x, top: placement.target.y, width: placement.target.width, height: placement.target.height, zIndex: placement.z }} />
    ) : null}
    <section
      ref={placement.register}
      data-window={id}
      data-node={key ?? undefined}
      aria-labelledby={`window-${id}-title`}
      onPointerDownCapture={placement.onFocusWithin}
      onFocusCapture={placement.onFocusWithin}
      className={cn(
        // The bench's grab cursor stops at the window edge; only the header's empty surface drags.
        "flex cursor-auto flex-col overflow-hidden rounded-2xl border bg-card/85 text-card-foreground backdrop-blur-xl",
        "shadow-[0_1px_0_0_rgb(255_255_255/0.06)_inset,0_1px_2px_rgb(0_0_0/0.06),0_24px_48px_-24px_rgb(0_0_0/0.28)]",
        "absolute",
        placement.animating && "transition-[left,top] duration-300 ease-out motion-reduce:transition-none",
        // Released windows glide into place; windows pushed aside by a gesture move smoothly too.
        placement.settling && "transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none",
        placement.dragging && !placement.active && !placement.animating && "transition-[top] duration-200 ease-out motion-reduce:transition-none",
        placement.dragging && "shadow-[0_1px_0_0_rgb(255_255_255/0.06)_inset,0_40px_80px_-24px_rgb(0_0_0/0.45)] ring-1 ring-foreground/10",
        isSelected && "border-foreground/30 ring-3 ring-ring/25",
      )}
      style={{ left: placement.x, top: placement.y, width: placement.width, [placement.sized && !placement.collapsed && !empty ? "height" : "maxHeight"]: placement.height, zIndex: placement.z }}
    >
      {flashing ? <span key={flash!.seq} aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] animate-uix-flash-in" /> : null}
      <header
        onPointerDown={placement.onHeaderPointerDown}
        className={cn(
          "group/header relative flex shrink-0 cursor-grab items-center gap-3 px-3.5 py-3 select-none active:cursor-grabbing",
          // Controls the drag ignores (see onHeaderPointerDown) keep their own cursor.
          "[&_:where(button,[data-interactive],[tabindex])]:cursor-default",
          !placement.collapsed && "border-b border-border/60",
        )}
      >
        {/* The drag hint overlays the header's top edge so it never holds a slot among the controls. */}
        <GripHorizontalIcon aria-hidden className="pointer-events-none absolute top-0 left-1/2 size-3.5 -translate-x-1/2 text-muted-foreground/0 transition-colors group-hover/header:text-muted-foreground/50" />
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", accentTile[accent])}>
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 id={`window-${id}-title`} className="flex items-center gap-2 text-sm leading-tight font-semibold tracking-tight">
            {node ? (
              <button type="button" aria-pressed={isSelected} aria-label={`Inspect ${title}`} onClick={toggle}
                className="rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring">
                {title}
              </button>
            ) : title}
            {count !== undefined && count !== null ? (
              <span className="rounded-full bg-muted px-1.5 py-px text-[0.68rem] font-medium text-muted-foreground tabular-nums">{count}</span>
            ) : null}
          </h2>
          {subtitle ? <p className="truncate font-mono text-[0.68rem] text-muted-foreground">{subtitle}</p> : null}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {status ? (
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="flex size-7 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring" />}>
                <StatusDot tone={tone} label={statusCopy[status]} />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="flex-col items-start gap-0.5">
                <span className="font-medium">{error ? `${statusCopy[status]} · last read failed` : statusCopy[status]}</span>
                {error ? <span className="opacity-70">{error}</span> : null}
                {endpoint ? <span className="font-mono opacity-70">{endpoint}</span> : null}
                {updatedAt ? <span className="opacity-70">Read <Time at={updatedAt} /></span> : null}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <button
            type="button"
            aria-label={placement.collapsed ? `Expand ${title}` : `Collapse ${title}`}
            aria-expanded={!placement.collapsed}
            onClick={placement.onToggleCollapse}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronDownIcon className={cn("size-4 transition-transform duration-200", placement.collapsed && "-rotate-90")} />
          </button>
        </div>
      </header>
      {placement.collapsed ? null : <div data-scroll className={cn("flex min-h-0 flex-1 flex-col", bleed ? "overflow-hidden" : "gap-4 overflow-y-auto overscroll-contain p-3.5")}>{children}</div>}
      {placement.collapsed || !footer ? null : <footer className="shrink-0 border-t border-border/60 p-1.5">{footer}</footer>}
      {placement.collapsed ? null : <ResizeHandles title={title} placement={placement} />}
    </section>
    </>
  );
}

/** The full-width create button in a window footer. */
export const footerButton = "w-full justify-center text-muted-foreground hover:text-foreground";

/** Edge and corner grips inside the rounded clip; double-click one to return that dimension to its default. */
function ResizeHandles({ title, placement }: { title: string; placement: WindowPlacement }) {
  const grip = (edge: ResizeEdge, className: string, children?: React.ReactNode) => (
    <span aria-hidden data-interactive="" title={`Resize ${title}`}
      onPointerDown={(event) => placement.onResizePointerDown(event, edge)}
      onDoubleClick={() => placement.onResetSize(edge)}
      className={cn("absolute z-20 touch-none", className)}>
      {children}
    </span>
  );
  return (
    <>
      {grip("x", "inset-y-5 right-0 w-1.5 cursor-ew-resize")}
      {grip("y", "inset-x-5 bottom-0 h-1.5 cursor-ns-resize")}
      {grip("xy", "group/grip right-1 bottom-1 flex size-4 cursor-nwse-resize items-end justify-end p-0.5",
        <svg viewBox="0 0 8 8" className="size-2 text-muted-foreground/0 transition-colors group-hover/grip:text-muted-foreground/70 [section:hover_&]:text-muted-foreground/30">
          <path d="M7 1 1 7M7 4 4 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>)}
    </>
  );
}

export function Section({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2 px-0.5">
        <h3 className="text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}
