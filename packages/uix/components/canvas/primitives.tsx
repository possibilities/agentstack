"use client";

import { useState } from "react";
import { BotIcon, CheckIcon, CopyIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hueOf, relativeTime } from "@/lib/stack/derive";
import { nodeKey, type Bot, type ChannelStatus, type NodeRef, type StackEvent } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useNow, useWorkbench } from "./provider";

export type Tone = "success" | "warning" | "destructive" | "muted" | "info";

const toneClass: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/40",
  info: "bg-pkg-codex",
};

/**
 * Honest WebSocket channel text: `status` only has entries for the channels
 * this page opened, so an endpoint with no entry was never connected here.
 */
export function channelLabel(endpoint: string | undefined, channel: ChannelStatus | undefined): { label: string; tone: Tone } {
  if (!endpoint) return { label: "no WebSocket", tone: "warning" };
  if (channel === undefined) return { label: "not opened by this page", tone: "muted" };
  return { label: channel, tone: channel === "open" ? "success" : channel === "closed" ? "destructive" : "muted" };
}

export function StatusDot({ tone, pulse, className, label }: { tone: Tone; pulse?: boolean; className?: string; label?: string }) {
  return (
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse ? <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", toneClass[tone])} /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", toneClass[tone])} />
    </span>
  );
}

/** A soft identity orb whose colors derive from an ID. */
export function Orb({ id, size = "md", className }: { id: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const hue = hueOf(id);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block shrink-0 rounded-full shadow-[inset_0_1px_1px_rgb(255_255_255/0.35),0_1px_2px_rgb(0_0_0/0.2)]",
        size === "sm" && "size-3.5",
        size === "md" && "size-7",
        size === "lg" && "size-10",
        className,
      )}
      style={{
        background: `radial-gradient(120% 120% at 30% 25%, oklch(0.9 0.08 ${hue}) 0%, oklch(0.68 0.16 ${hue}) 45%, oklch(0.5 0.17 ${(hue + 40) % 360}) 100%)`,
      }}
    />
  );
}

export function accountColor(id: string): string {
  return `oklch(0.68 0.15 ${hueOf(id)})`;
}

/** The numbered bot tile, with its liveness dot. Resize through className. */
export function BotTile({ bot, pulse, className }: { bot?: Bot; pulse?: boolean; className?: string }) {
  const number = bot ? /^bot-(\d+)$/.exec(bot.id)?.[1] : null;
  return (
    <span className={cn("relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-pkg-bots/12 font-mono text-lg font-semibold text-pkg-bots ring-1 ring-pkg-bots/25 ring-inset", className)}>
      {number ?? <BotIcon className="size-5" />}
      {bot ? (
        <StatusDot
          tone={bot.recoveryIssue ? "warning" : bot.state === "running" ? "success" : "muted"}
          pulse={pulse}
          className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-card"
          label={bot.recoveryIssue ? "Needs inspection" : bot.state}
        />
      ) : null}
    </span>
  );
}

export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Copy ${label}`}
            className={cn(
              "relative z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring",
              copied && "opacity-100",
              className,
            )}
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_200);
              });
            }}
          />
        }
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}

export function Time({ at, className }: { at: number | null; className?: string }) {
  const now = useNow();
  return (
    <time suppressHydrationWarning dateTime={at ? new Date(at).toISOString() : undefined} className={cn("tabular-nums", className)}>
      {relativeTime(at, now)}
    </time>
  );
}

/** Label/value row; the label carries the schema description as a tooltip. */
export function Row({ label, hint, children, copy, mono, className }: {
  label: string;
  hint?: string | null;
  children: React.ReactNode;
  copy?: string | null;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("group/row flex min-h-6 items-center gap-3 text-[0.8rem]", className)}>
      <dt className="shrink-0 text-muted-foreground">
        {hint ? (
          <Tooltip>
            <TooltipTrigger render={<span data-interactive="" className="relative z-10 cursor-help decoration-muted-foreground/40 decoration-dotted underline-offset-4 hover:underline" />}>{label}</TooltipTrigger>
            <TooltipContent side="left" className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
        ) : label}
      </dt>
      <dd className={cn("ml-auto min-w-0 truncate text-right", mono && "font-mono text-[0.75rem]")}>{children}</dd>
      {copy ? <CopyButton value={copy} label={label.toLowerCase()} className="-mr-1.5" /> : null}
    </div>
  );
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <span aria-hidden className={cn("flex h-4 items-end gap-px", className)}>
      {values.map((value, index) => (
        <span
          key={index}
          className={cn("w-1 rounded-[1px] transition-[height] duration-500", value ? "bg-current" : "bg-current opacity-15")}
          style={{ height: `${value ? 25 + (value / max) * 75 : 12}%` }}
        />
      ))}
    </span>
  );
}

/**
 * A selectable card on the canvas. Nothing inside it inspects by default —
 * put a NodeTitle on its visible name for the explicit inspect control.
 */
export function NodeCard({ node, label, children, className, lastEvent, accent, variant = "card" }: {
  node: NodeRef;
  label: string;
  children: React.ReactNode;
  className?: string;
  lastEvent?: StackEvent;
  accent?: string;
  variant?: "card" | "row";
}) {
  const { selected, hovered, select, hover, flash } = useWorkbench();
  const key = nodeKey(node);
  const isSelected = selected !== null && nodeKey(selected) === key;
  const flashing = flash?.key === key;
  return (
    <article
      data-node={key}
      onPointerEnter={() => hover(key)}
      onPointerLeave={() => hover(null)}
      style={accent ? ({ "--ping": accent } as React.CSSProperties) : undefined}
      className={cn(
        "group/card relative transition-[border-color,box-shadow,background-color] duration-200",
        variant === "card" && "rounded-xl border bg-background/60 p-3 duration-300 hover:border-foreground/15 hover:bg-background/90 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98]",
        variant === "card" && hovered === key && "border-foreground/15",
        variant === "card" && isSelected && "border-foreground/30 bg-background shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_25%,transparent)]",
        variant === "row" && "rounded-lg px-2 py-1.5 hover:bg-muted/70",
        variant === "row" && isSelected && "bg-muted",
        className,
      )}
    >
      {lastEvent ? <span key={lastEvent.seq} aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] animate-uix-ping" /> : null}
      {flashing ? <span key={flash!.seq} aria-hidden className="pointer-events-none absolute -inset-1 rounded-[inherit] animate-uix-flash" /> : null}
      <div className="relative flex flex-col gap-2">{children}</div>
    </article>
  );
}

/** The card's visible name and its only inspect control — toggles selection, or navigates when `onActivate` is set. */
export function NodeTitle({ node, label, children, className, onActivate }: {
  node: NodeRef;
  label: string;
  children: React.ReactNode;
  className?: string;
  onActivate?: () => void;
}) {
  const { selected, select } = useWorkbench();
  const isSelected = selected !== null && nodeKey(selected) === nodeKey(node);
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      aria-label={`${onActivate ? "Go to" : "Inspect"} ${label}`}
      onClick={() => (onActivate ? onActivate() : select(isSelected ? null : node))}
      className={cn("rounded-sm text-left decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring", className)}
    >
      {children}
    </button>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center">
      <Icon className="size-5 text-muted-foreground/70" />
      <p className="text-sm font-medium">{title}</p>
      {children ? <p className="text-xs text-pretty text-muted-foreground">{children}</p> : null}
    </div>
  );
}
