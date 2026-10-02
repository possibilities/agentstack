"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ClipboardListIcon, RefreshCwIcon, RotateCwIcon, WrenchIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime } from "@/lib/stack/derive";
import { formatDuration } from "@/lib/stack/resources";
import { planReadiness, receiptTone, receiptWords, StateFlowController, type StateFlow, type StateFlowOptions } from "@/lib/stack/state";
import type { StateOutcome, StatePlan, StateReceipt } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, StatusDot, type Tone } from "./primitives";
import { useNow } from "./provider";

/*
 * The shared owner maintenance flow (docs/state-control.md, ADR 0135): prepare → preview → apply → receipt.
 * Each owner view supplies its own operations; nothing here chooses an owner or an operation.
 */

const labelClass = "text-[0.68rem] font-medium tracking-[0.06em] text-muted-foreground uppercase";

function List({ title, items, tone, empty }: { title: string; items: string[]; tone?: "destructive" | "warning"; empty?: string }) {
  if (!items.length && !empty) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className={labelClass}>{title}{items.length ? <span className="ml-1 tabular-nums">{items.length}</span> : null}</span>
      {items.length ? (
        <ul className={cn("flex max-h-40 flex-col gap-0.5 overflow-auto text-xs", tone === "destructive" && "text-destructive", tone === "warning" && "text-foreground")}>
          {items.map((item, index) => <li key={`${index}:${item}`} className="break-words">{item}</li>)}
        </ul>
      ) : <p className="text-xs text-muted-foreground">{empty}</p>}
    </div>
  );
}

function Identity({ label, value }: { label: string; value: string }) {
  return (
    <div className="group/row flex min-w-0 items-center gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ml-auto min-w-0 truncate font-mono text-[0.7rem]" title={value}>{value}</span>
      <CopyButton value={value} label={label.toLowerCase()} className="-mr-1.5" />
    </div>
  );
}

/** One plan as the owner prepared it: exact scope, blockers, retained copies, regeneration, revision and expiry. */
export function StatePlanReview({ plan, now }: { plan: StatePlan; now: number }) {
  const readiness = planReadiness(plan, now);
  const expires = Date.parse(plan.expiresAt);
  return (
    <section aria-label={`${plan.ownerPackage} plan ${plan.action}`} className="flex flex-col gap-2.5 rounded-lg border bg-background/60 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[0.8rem] font-semibold">{plan.action}</span>
        <span className="text-xs text-muted-foreground">{plan.ownerPackage}{plan.subject ? ` · ${plan.subject.kind} ${plan.subject.id}` : ""}</span>
        <span className={cn("ml-auto text-xs tabular-nums", readiness.expired ? "text-destructive" : "text-muted-foreground")} title={new Date(expires).toLocaleString()}>
          {readiness.expired ? `Expired ${relativeTime(expires, now)}` : `Expires in ${formatDuration((expires - now) / 1000)}`}
        </span>
      </div>
      <List title="Exact resources" items={plan.resources} empty="The plan names no resources." />
      <List title="Blocked by" items={plan.blockedBy} tone="destructive" />
      <List title="Retained copies" items={plan.retained} empty="The owner reports no retained copies." />
      <List title="Regeneration" items={plan.regeneration} empty="The owner reports nothing that regenerates." />
      <div className="flex flex-col">
        <Identity label="Plan" value={plan.id} />
        <Identity label="Revision" value={plan.revision} />
      </div>
    </section>
  );
}

const outcomeTone: Record<StateOutcome["outcome"], Tone> = { removed: "success", retained: "muted", blocked: "destructive", unknown: "warning", pending: "info" };

/** One durable receipt. Partial and unknown stay uncertain: the per-resource outcomes are the evidence. */
export function StateReceiptView({ receipt, now }: { receipt: StateReceipt; now: number }) {
  const tone = receiptTone(receipt.status);
  return (
    <section aria-label={`${receipt.ownerPackage} receipt ${receipt.status}`} className="flex flex-col gap-2.5 rounded-lg border bg-background/60 p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <StatusDot tone={tone} pulse={receipt.status === "running"} />
        <span className="text-[0.8rem] font-semibold capitalize">{receipt.status}</span>
        <span className="font-mono text-xs text-muted-foreground">{receipt.action}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {receipt.completedAt ? `Finished ${relativeTime(Date.parse(receipt.completedAt), now)}` : `Started ${relativeTime(Date.parse(receipt.startedAt), now)}`}
        </span>
      </div>
      <p className={cn("text-xs", tone === "warning" || tone === "destructive" ? "text-foreground" : "text-muted-foreground")}>{receiptWords[receipt.status]}</p>
      <div className="flex flex-col gap-1">
        <span className={labelClass}>Outcomes<span className="ml-1 tabular-nums">{receipt.outcomes.length}</span></span>
        {receipt.outcomes.length ? (
          <ul aria-label="Outcomes" className="flex max-h-56 flex-col gap-1 overflow-auto">
            {receipt.outcomes.map((outcome, index) => (
              <li key={`${index}:${outcome.resource}`} className="flex flex-col gap-px text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <StatusDot tone={outcomeTone[outcome.outcome]} label={outcome.outcome} />
                  <span className="shrink-0 font-medium">{outcome.outcome}</span>
                  <span className="min-w-0 truncate font-mono text-[0.7rem]" title={outcome.resource}>{outcome.resource}</span>
                </span>
                {outcome.detail ? <span className="pl-3 break-words text-muted-foreground">{outcome.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted-foreground">{receipt.status === "running" ? "No outcomes recorded yet." : "The receipt records no per-resource outcomes."}</p>}
      </div>
      <List title="Retained copies" items={receipt.retained} />
      <List title="Regeneration" items={receipt.regeneration} />
      <div className="flex flex-col">
        <Identity label="Request" value={receipt.requestId} />
        <Identity label="Plan" value={receipt.planId} />
      </div>
    </section>
  );
}

export type StateFlowControls = {
  flow: StateFlow;
  prepare(): void;
  apply(): void;
  retry(): void;
  readReceipt(): void;
  reset(): void;
};

/**
 * Owner-agnostic state for one maintenance selection (a `StateFlowController`). The owner's callbacks are the only
 * calls it makes. `observe` is any owner invalidation, such as an event generation: a running receipt is read
 * again when it changes; nothing polls.
 */
export function useStateFlow<Extra extends Record<string, string> = Record<string, never>>({ observe, ...options }: StateFlowOptions<Extra> & { observe?: unknown }): StateFlowControls {
  const controller = useMemo(() => new StateFlowController<Extra>(options), [options.recoveryKey]);
  controller.update(options);
  const flow = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  // Unmounting only drops in-flight results; a saved request stays recoverable.
  useEffect(() => { void controller.recover(); return () => controller.detach(); }, [controller]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void controller.observe();
  }, [observe, controller]);
  return {
    flow,
    prepare: () => void controller.prepare(),
    apply: () => void controller.apply(),
    retry: () => void controller.retry(),
    readReceipt: () => void controller.readReceipt(),
    reset: () => controller.reset(),
  };
}

/**
 * The whole flow for one owner selection: a prepare control, the plan preview with its apply control, and the
 * receipt or uncertainty afterwards. `unavailable` disables preparing with its reason (remote, disconnected,
 * nothing selected). Downstream views pass their owner's explicit operations.
 */
export function StateMaintenance<Extra extends Record<string, string> = Record<string, never>>({ label, applyLabel = "Apply this plan", unavailable, className, ...options }: StateFlowOptions<Extra> & { observe?: unknown } & {
  /** The decision being prepared, e.g. "Prepare workspace clear". */
  label: string;
  applyLabel?: string;
  unavailable?: string | null;
  className?: string;
}) {
  const controls = useStateFlow(options);
  return <StateFlowView controls={controls} label={label} applyLabel={applyLabel} unavailable={unavailable} className={className} />;
}

export function StateFlowView({ controls, label, applyLabel = "Apply this plan", unavailable, className, receiptOnlyRecovery = false }: {
   controls: StateFlowControls; label: string; applyLabel?: string; unavailable?: string | null; className?: string;
   /** External effects must be inspected, not rearmed, after an uncertain admission or an unsettled receipt. */
   receiptOnlyRecovery?: boolean;
}) {
  const now = useNow(15_000);
  const { flow } = controls;
  const prepareButton = (text: string, variant: "outline" | "ghost" = "outline") => (
    <Button size="sm" variant={variant} disabled={!!unavailable} title={unavailable ?? undefined} onClick={controls.prepare}>
      <ClipboardListIcon data-icon="inline-start" />{text}
    </Button>
  );
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-live="polite">
      {flow.phase === "idle" ? (
        <div className="flex flex-col gap-1">
          <div>{prepareButton(label)}</div>
          {unavailable ? <p className="text-xs text-muted-foreground">{unavailable}</p> : null}
        </div>
      ) : null}
      {flow.phase === "preparing" ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner />Preparing a plan…</p> : null}
      {flow.phase === "prepare-failed" ? (
        <Alert variant="destructive">
          <AlertTitle>No plan</AlertTitle>
          <AlertDescription>{flow.error}</AlertDescription>
          <div className="mt-1.5 flex gap-1.5">{prepareButton("Prepare again")}<Button size="sm" variant="ghost" onClick={controls.reset}>Cancel</Button></div>
        </Alert>
      ) : null}
      {flow.phase === "preview" ? (() => {
        const readiness = planReadiness(flow.plan, now);
        return (
          <>
            <StatePlanReview plan={flow.plan} now={now} />
            {readiness.reason || unavailable ? <p role="status" className="text-xs text-destructive">{readiness.reason ?? unavailable}</p> : null}
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="destructive" disabled={!readiness.canApply || !!unavailable} title={readiness.reason ?? unavailable ?? undefined} onClick={controls.apply}>{applyLabel}</Button>
              {readiness.expired || readiness.blocked ? prepareButton("Prepare a new plan", "ghost") : null}
              <Button size="sm" variant="ghost" onClick={controls.reset}><XIcon data-icon="inline-start" />Discard plan</Button>
            </div>
          </>
        );
      })() : null}
      {flow.phase === "applying" || flow.phase === "checking" ? (
        <>
          {flow.plan ? <StatePlanReview plan={flow.plan} now={now} /> : null}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner />
            {flow.phase === "applying" ? "Applying…" : "Reading the owner's receipt for this request…"}
            <span className="ml-auto font-mono text-[0.7rem]" title={flow.input.requestId}>request {flow.input.requestId.slice(0, 8)}</span>
          </p>
        </>
      ) : null}
      {flow.phase === "uncertain" ? (
        <>
          <Alert className="border-warning/50">
            <AlertTitle>Result not confirmed</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <span>{flow.error}</span>
              <span>{receiptOnlyRecovery ? "Inspect the exact resources and read this request’s receipt again. No resend or new plan is offered while the result is unconfirmed." : "The request may not have reached the owner. Read its receipt again, or send exactly the same request again; the owner admits one request ID once. Choosing differently needs a new plan."}</span>
            </AlertDescription>
          </Alert>
          <div className="flex flex-col rounded-lg border bg-background/60 p-2.5">
            <Identity label="Request" value={flow.input.requestId} />
            <Identity label="Plan" value={flow.input.planId} />
            <Identity label="Revision" value={flow.input.expectedRevision} />
            {Object.entries(flow.input).filter(([name]) => !["requestId", "planId", "expectedRevision"].includes(name)).map(([name, value]) => <Identity key={name} label={name} value={String(value)} />)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={controls.readReceipt}><RefreshCwIcon data-icon="inline-start" />Read receipt</Button>
            {!receiptOnlyRecovery ? <Button size="sm" variant="outline" disabled={!!unavailable} onClick={controls.retry}><RotateCwIcon data-icon="inline-start" />Send identical request</Button> : null}
            {!receiptOnlyRecovery ? prepareButton("Prepare a new plan", "ghost") : null}
          </div>
        </>
      ) : null}
      {flow.phase === "receipt" ? (
        <>
          <StateReceiptView receipt={flow.receipt} now={now} />
          <div className="flex flex-wrap gap-1.5">
            {flow.receipt.status === "running" || (receiptOnlyRecovery && (flow.receipt.status === "partial" || flow.receipt.status === "unknown")) ? <Button size="sm" variant="outline" onClick={controls.readReceipt}><RefreshCwIcon data-icon="inline-start" />Read receipt again</Button> : null}
            {flow.receipt.status === "blocked" || (!receiptOnlyRecovery && (flow.receipt.status === "partial" || flow.receipt.status === "unknown")) ? prepareButton("Prepare a new plan", "ghost") : null}
            {!receiptOnlyRecovery || flow.receipt.status === "completed" || flow.receipt.status === "blocked" ? <Button size="sm" variant="ghost" onClick={controls.reset}>Close receipt</Button> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The collapsed "Maintenance" disclosure an owner view puts at the end of a record's detail. Nothing destructive shows
 * until it is opened, but it opens itself, and stays open, while a flow inside it is past idle: a retained running,
 * partial or unknown receipt must never hide behind a closed disclosure.
 */
export function MaintenanceDisclosure({ children, active = false, aside, title = "Maintenance", className, onOpenChange }: {
  children: React.ReactNode; active?: boolean; aside?: string; title?: string; className?: string;
  /** Lets a view show row selection controls only while maintenance is open. */
  onOpenChange?(open: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open || active} onToggle={(event) => { setOpen(event.currentTarget.open); onOpenChange?.(event.currentTarget.open); }} className={cn("group/maintenance rounded-lg border border-dashed", className)}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <WrenchIcon aria-hidden className="size-3.5" />{title}
        {aside ? <span className="ml-auto text-[0.66rem]">{aside}</span> : null}
      </summary>
      <div className="flex flex-col gap-2 border-t border-dashed p-2.5">{children}</div>
    </details>
  );
}

/**
 * An explicit choice between named options, unset until the operator picks one. A hint sits beneath its option and is
 * announced with it. Disabled while a flow is past idle, so a displayed plan never disagrees with what is chosen.
 */
export function Choice<T extends string>({ label, value, options, disabled, onChange }: {
  label: string; value: T | null; options: [T, React.ReactNode, string?, boolean?][]; disabled: boolean; onChange(value: T): void;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {options.map(([option, text, note, off]) => (
        <div key={option} className="flex flex-col gap-0.5">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`${id}-${label}`} checked={value === option} disabled={disabled || off} aria-describedby={note ? `${id}-${option}` : undefined} onChange={() => onChange(option)} />{text}
          </label>
          {note ? <p id={`${id}-${option}`} className="pl-5 text-[0.68rem] text-pretty text-muted-foreground">{note}</p> : null}
        </div>
      ))}
    </div>
  );
}
