"use client";

import { createContext, use } from "react";
import { ChevronDownIcon, GripHorizontalIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nodeKey, type ChannelStatus, type NodeRef } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { StatusDot, Time } from "./primitives";
import { useWorkbench } from "./provider";

export type Accent = "owner" | "auth" | "bots" | "api" | "events";

export const accentTile: Record<Accent, string> = {
  owner: "bg-pkg-owner/15 text-pkg-owner",
  auth: "bg-pkg-auth/15 text-pkg-auth",
  bots: "bg-pkg-bots/15 text-pkg-bots",
  api: "bg-pkg-api/15 text-pkg-api",
  events: "bg-pkg-events/15 text-pkg-events",
};

export const accentText: Record<Accent, string> = {
  owner: "text-pkg-owner",
  auth: "text-pkg-auth",
  bots: "text-pkg-bots",
  api: "text-pkg-api",
  events: "text-pkg-events",
};

export const accentBg: Record<Accent, string> = {
  owner: "bg-pkg-owner",
  auth: "bg-pkg-auth",
  bots: "bg-pkg-bots",
  api: "bg-pkg-api",
  events: "bg-pkg-events",
};

export function accentOf(pkg: string): Accent {
  return pkg in accentTile ? (pkg as Accent) : "owner";
}

export type WindowPlacement = {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  collapsed: boolean;
  animating: boolean;
  dragging: boolean;
  onHeaderPointerDown(event: React.PointerEvent): void;
  onFocusWithin(): void;
  onToggleCollapse(): void;
  register(element: HTMLElement | null): void;
};

export const PlacementContext = createContext<((id: string) => WindowPlacement) | null>(null);

const statusCopy: Record<ChannelStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  open: "Live",
  closed: "Reconnecting…",
};

export function Window({ id, title, subtitle, icon: Icon, accent, count, status, endpoint, updatedAt, error, actions, node, children }: {
  id: string;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: Accent;
  count?: number | null;
  status?: ChannelStatus;
  endpoint?: string;
  updatedAt?: number | null;
  error?: string | null;
  actions?: React.ReactNode;
  /** When the window represents a node, a header tap or the title button inspects it. */
  node?: NodeRef;
  children: React.ReactNode;
}) {
  const placement = use(PlacementContext)?.(id);
  if (!placement) throw new Error("Window requires PlacementContext");
  const { selected, select, flash } = useWorkbench();
  const key = node ? nodeKey(node) : null;
  const isSelected = key !== null && selected !== null && nodeKey(selected) === key;
  const flashing = key !== null && flash?.key === key;
  const toggle = () => {
    if (node) select(isSelected ? null : node);
  };
  const tone = status === "open" ? (error ? "warning" : "success") : status === "closed" ? "destructive" : "muted";
  return (
    <section
      ref={placement.register}
      data-window={id}
      data-node={key ?? undefined}
      aria-labelledby={`window-${id}-title`}
      onPointerDownCapture={placement.onFocusWithin}
      onFocusCapture={placement.onFocusWithin}
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border bg-card/85 text-card-foreground backdrop-blur-xl",
        "shadow-[0_1px_0_0_rgb(255_255_255/0.06)_inset,0_1px_2px_rgb(0_0_0/0.06),0_24px_48px_-24px_rgb(0_0_0/0.28)]",
        "absolute",
        placement.animating && "transition-[left,top] duration-300 ease-out motion-reduce:transition-none",
        placement.dragging && "shadow-[0_1px_0_0_rgb(255_255_255/0.06)_inset,0_40px_80px_-24px_rgb(0_0_0/0.45)] ring-1 ring-foreground/10",
        isSelected && "border-foreground/30 ring-3 ring-ring/25",
      )}
      style={{ left: placement.x, top: placement.y, width: placement.width, maxHeight: placement.height, zIndex: placement.z }}
    >
      {flashing ? <span key={flash!.seq} aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] animate-uix-flash-in" /> : null}
      <header
        onPointerDown={placement.onHeaderPointerDown}
        className={cn(
          "group/header flex shrink-0 cursor-grab items-center gap-3 px-3.5 py-3 select-none active:cursor-grabbing",
          !placement.collapsed && "border-b border-border/60",
        )}
      >
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
          <p className="truncate font-mono text-[0.68rem] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {actions}
          <GripHorizontalIcon aria-hidden className="size-4 text-muted-foreground/0 transition-colors group-hover/header:text-muted-foreground/50" />
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
      {placement.collapsed ? null : <div data-scroll className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-3.5">{children}</div>}
    </section>
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
