"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "cn";

/** Semantic tone, never package identity. Words always carry the state; tone only reinforces it. */
export type Tone = "muted" | "neutral" | "progress" | "success" | "attention" | "danger";

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden data-tone={tone} className={cn("client-dot", className)} />;
}

export function StatusChip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span data-tone={tone} className={cn("client-chip", className)}><StatusDot tone={tone} />{children}</span>;
}

/** A bordered surface. `tone` tints it only when it needs attention. */
export function Panel({ labelledBy, tone, className, children }: { labelledBy: string; tone?: Tone; className?: string; children: ReactNode }) {
  return <section aria-labelledby={labelledBy} data-tone={tone} className={cn("client-panel", className)}>{children}</section>;
}

export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("client-panel-body", className)}>{children}</div>;
}

/** Closing strip for the panel's governing note and its control. */
export function PanelFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("client-panel-footer", className)}>{children}</div>;
}

export function PanelTitle({ id, description, aside, children }: { id: string; description?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return <div className="client-panel-title">
    <div className="flex min-w-0 flex-col gap-1">
      <h2 id={id} className="text-base font-semibold tracking-tight">{children}</h2>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
    {aside}
  </div>;
}

/** Label/value pairs. Values stay selectable and wrap at any width. */
export type Fact = [ReactNode, ReactNode, { mono?: boolean; key?: string; selectable?: boolean; selectableClassName?: string }?];
export function Facts({ items, className }: { items: Fact[]; className?: string }) {
  return <dl className={cn("client-facts", className)}>
    {items.map(([term, value, options], index) => <div key={options?.key ?? index} className="contents">
      <dt>{term}</dt><dd className={options?.mono ? "font-mono text-[0.8125rem]" : undefined}>{options?.selectable && typeof value === "string"
        ? <textarea readOnly rows={1} aria-label={typeof term === "string" ? term : "Recorded value"} className={cn("client-selectable", options.selectableClassName)} value={value} /> : value}</dd>
    </div>)}
  </dl>;
}

/** Why a control is unavailable, next to it. */
export function Hint({ id, children }: { id?: string; children: ReactNode }) {
  return children ? <p id={id} className="text-sm text-muted-foreground">{children}</p> : null;
}

export type StepStatus = "done" | "current" | "pending" | "failed" | "unknown" | "unclaimed";
export type Step = { key: string; label: string; status: StepStatus; note?: string };
const stepWords: Record<StepStatus, string> = { done: "done", current: "current", pending: "not started", failed: "failed", unknown: "outcome unknown", unclaimed: "not observed" };

/** An ordered stage sequence. Positions are recorded stages, never estimated progress. */
export function Steps({ label, steps }: { label: string; steps: Step[] }) {
  return <ol aria-label={label} className="client-steps">
    {steps.map(step => <li key={step.key} data-status={step.status} aria-current={step.status === "current" || step.status === "failed" || step.status === "unknown" ? "step" : undefined}>
      <span aria-hidden className="client-step-marker">
        {step.status === "done" ? <CheckIcon /> : step.status === "failed" ? <XIcon /> : step.status === "unknown" ? "?" : null}
      </span>
      <span className="client-step-label">{step.label}</span>
      <span className="sr-only">, {stepWords[step.status]}</span>
      {step.note ? <span aria-hidden className="client-step-note">{step.note}</span> : null}
    </li>)}
  </ol>;
}

/** Re-renders periodically so relative times do not go stale; null until mounted. */
export function useNow(interval = 30_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/** Shared age/expiry units; future values round up, recorded ages round normally. */
export function relativeTime(at: number, now: number) {
  const delta = at - now, future = delta > 0, elapsed = Math.abs(delta);
  if (!future && elapsed < 45_000) return "just now";
  if (!future && elapsed >= 7 * 86_400_000) return new Date(at).toLocaleDateString();
  const [unit, duration]: [string, number] = elapsed < 3_600_000 ? ["min", 60_000] : elapsed < 86_400_000 ? ["h", 3_600_000] : ["day", 86_400_000];
  const count = Math.max(1, (future ? Math.ceil : Math.round)(elapsed / duration));
  const label = unit === "day" ? (future ? (count === 1 ? "day" : "days") : "d") : unit;
  const text = `${count} ${label}`;
  return future ? `in ${text}` : `${text} ago`;
}

export function RelativeTime({ at, now, className }: { at: number; now: number | null; className?: string }) {
  const exact = new Date(at).toLocaleString();
  return <time dateTime={new Date(at).toISOString()} title={exact} className={cn("tabular-nums", className)}>{now === null ? exact : relativeTime(at, now)}</time>;
}

/** Live, polite observation freshness line. */
export function ObservationStatus({ loading, at, className }: { loading: boolean; at: number | null; className?: string }) {
  return <p role="status" aria-live="polite" className={cn("text-xs text-muted-foreground tabular-nums", className)}>
    {loading ? "Loading client observation…" : at !== null ? `Last observation: ${new Date(at).toLocaleTimeString()}` : "No client observation available."}
  </p>;
}
