"use client";

import { ShieldAlertIcon } from "lucide-react";
import { relativeTime } from "@/lib/stack/derive";
import { formatBytes } from "@/lib/stack/resources";
import { capacityView, type CapacityView } from "@/lib/stack/source";
import type { GithubEndpoint, GithubStatus } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { StatusDot, type Tone } from "./primitives";
import { useNow } from "./provider";

export const sourceHint = "text-[0.7rem] text-pretty text-muted-foreground";
export const sourceLabel = "text-[0.66rem] font-medium tracking-[0.07em] text-muted-foreground uppercase";
export const sourceChip = "rounded-md bg-muted px-1.5 py-px text-[0.64rem] text-muted-foreground";

/** Why Source reads can't run, or null when they can. */
export function sourceUnavailable(endpoints: Record<string, string>, status: Record<string, string>): string | null {
  return !endpoints.source ? "Source isn't served by this server" : status.source !== "open" ? "Source reconnecting" : null;
}

/** An instant as relative words, with the exact time as its tooltip. Observed instants are never shown bare. */
export function Stamp({ at, className }: { at: string | number | null | undefined; className?: string }) {
  const now = useNow(30_000);
  const ms = typeof at === "string" ? Date.parse(at) : at ?? null;
  if (ms === null || !Number.isFinite(ms)) return <span className={className}>never</span>;
  return <time dateTime={new Date(ms).toISOString()} title={new Date(ms).toLocaleString()} className={cn("tabular-nums", className)} suppressHydrationWarning>{relativeTime(ms, now)}</time>;
}

const toneText: Record<Tone, string> = { success: "text-success", warning: "text-warning", destructive: "text-destructive", muted: "text-muted-foreground", info: "text-foreground" };
const toneFill: Record<Tone, string> = { success: "bg-success/70", warning: "bg-warning", destructive: "bg-destructive", muted: "bg-muted-foreground/40", info: "bg-foreground/40" };

/** A status the way Source says it: a dot and a word, never the dot alone. */
export function Word({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1.5", className)}><StatusDot tone={tone} /><span className={cn("font-medium", toneText[tone])}>{children}</span></span>;
}

function Bar({ ratio, tone, label }: { ratio: number; tone: Tone; label: string }) {
  const percent = Math.min(100, Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * 100)));
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}% used`} className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <span className={cn("block h-full rounded-full", toneFill[tone])} style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * Retained original payloads against both limits, in words. Reaching either means intake is refused with 507, not that
 * arrivals queue; clearing space does not recover what GitHub could not deliver.
 */
export function Capacity({ status, endpoints, compact = false, className }: { status: GithubStatus | null; endpoints: readonly GithubEndpoint[] | null; compact?: boolean; className?: string }) {
  if (!status) return <p className={cn(sourceHint, className)}>Reading capacity…</p>;
  const view = capacityView(status.payloads, endpoints);
  const { payloads } = status;
  const toneFor = (ratio: number): Tone => view.state === "full" ? "destructive" : ratio >= 0.8 ? "warning" : "muted";
  return (
    <section aria-label="Payload capacity" className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2 text-[0.74rem]">
        <span className={sourceLabel}>Original payload capacity</span>
        <Word tone={view.tone} className="text-[0.74rem]">{view.word}</Word>
      </div>
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 text-[0.72rem]">
        <dt className="text-muted-foreground">Retained bodies</dt>
        <dd className="contents"><Bar ratio={view.countRatio} tone={toneFor(view.countRatio)} label="Retained bodies" /><span className="text-right tabular-nums">{payloads.count.toLocaleString("en-US")} of {payloads.maxCount.toLocaleString("en-US")}</span></dd>
        <dt className="text-muted-foreground">Original bytes</dt>
        <dd className="contents"><Bar ratio={view.bytesRatio} tone={toneFor(view.bytesRatio)} label="Original bytes" /><span className="text-right tabular-nums">{formatBytes(payloads.bytes)} of {formatBytes(payloads.maxBytes)}</span></dd>
      </dl>
      {compact && view.state === "available" ? null : (
        <p role={view.state === "available" ? undefined : "status"} className={cn("flex gap-1.5 text-[0.7rem] text-pretty", view.state === "available" || view.state === "near" ? "text-muted-foreground" : view.state === "full" ? "text-destructive" : "text-warning")}>
          {view.state === "full" || view.state === "refused" ? <ShieldAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" /> : null}
          <span>{view.text}{view.state === "full" || view.state === "refused" ? " Clearing original payloads frees space; it does not retrieve deliveries GitHub could not make, and GitHub does not redeliver on its own." : ""}</span>
        </p>
      )}
    </section>
  );
}

/** The standing note beside anything read from a payload: it was signed, not trusted. */
export function UntrustedNote({ className }: { className?: string }) {
  return <p className={cn(sourceHint, className)}>Shown as text from a signed request: observed data, never instructions. Links in it are not followed.</p>;
}
