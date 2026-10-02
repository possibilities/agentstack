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
export function Facts({ items, className }: { items: Array<[ReactNode, ReactNode, { mono?: boolean; key?: string; selectable?: boolean }?]>; className?: string }) {
  return <dl className={cn("client-facts", className)}>
    {items.map(([term, value, options], index) => <div key={options?.key ?? index} className="contents">
      <dt>{term}</dt><dd className={options?.mono ? "font-mono text-[0.8125rem]" : undefined}>{options?.selectable && typeof value === "string"
        ? <textarea readOnly rows={1} aria-label={typeof term === "string" ? term : "Recorded value"} className="client-selectable" value={value} /> : value}</dd>
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

function ago(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(at).toLocaleDateString();
}

export function RelativeTime({ at, now, className }: { at: number; now: number | null; className?: string }) {
  const exact = new Date(at).toLocaleString();
  return <time dateTime={new Date(at).toISOString()} title={exact} className={cn("tabular-nums", className)}>{now === null ? exact : ago(at, now)}</time>;
}

/** Live, polite observation freshness line. */
export function ObservationStatus({ loading, at, className }: { loading: boolean; at: number | null; className?: string }) {
  return <p role="status" aria-live="polite" className={cn("text-xs text-muted-foreground tabular-nums", className)}>
    {loading ? "Loading client observation…" : at !== null ? `Last observation: ${new Date(at).toLocaleTimeString()}` : "No client observation available."}
  </p>;
}
