"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClockIcon } from "lucide-react";
import { relativeTime, untilTime } from "@/lib/stack/derive";
import { blockedCopy, executionView, ownerOf, runView, type ProcTone } from "@/lib/stack/proc";
import type { ProcActor, ProcAuthority, ProcExecutionSummary, ProcRun } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { NodeLink } from "./primitives";
import { useNow } from "./provider";

/** Why Proc controls can't run here, or null when they can. Proc is owner-local: output and schedule definitions never reach remote sessions. */
export function procUnavailable(remote: unknown, endpoints: Record<string, string>): string | null {
  if (remote) return "Available only on the local UIX";
  if (!endpoints.proc) return "Proc isn't served by this owner";
  return null;
}

export function ProcPlaceholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
      <CalendarClockIcon className="size-5 text-muted-foreground/70" />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Who a Proc record belongs to: a Bot links to its Fleet card; the rest are words. */
export function OwnerChip({ actor, className, static: asText }: { actor: ProcAuthority | ProcActor | null; className?: string; static?: boolean }) {
  const owner = ownerOf(actor);
  if (owner.kind === "bot") {
    if (asText) return <span className={cn("inline-flex h-5 items-center rounded-md bg-muted/70 px-1.5 font-mono text-[0.66rem] text-foreground/80", className)}>{owner.botId}</span>;
    return (
      <NodeLink node={{ kind: "bot", id: owner.botId }} label={`Bot ${owner.botId}`}
        className={cn("inline-flex h-5 items-center rounded-md bg-muted/70 px-1.5 font-mono text-[0.66rem] text-foreground/80", className)}>
        {owner.botId}
      </NodeLink>
    );
  }
  const label = owner.kind === "operator" ? "Operator" : owner.kind === "system" ? "System" : "Unattributed";
  return <span className={cn("inline-flex h-5 items-center rounded-md bg-muted/70 px-1.5 text-[0.66rem] text-muted-foreground", className)}>{label}</span>;
}

const markShape: Record<string, string> = { running: "●", completed: "●", failed: "×", refused: "–", unknown: "○" };
const markTone: Record<string, string> = {
  running: "text-pkg-codex", completed: "text-success", failed: "text-destructive", refused: "text-muted-foreground/60", unknown: "text-warning",
};

/**
 * A schedule's recent executions as up to 12 small marks, oldest left. Each
 * mark's shape names the outcome, so state never depends on color alone.
 */
export function OutcomeStrip({ recent, now }: { recent: ProcExecutionSummary[]; now: number }) {
  const cells = recent.slice(0, 12).reverse();
  if (!cells.length) return null;
  const counts = new Map<string, number>();
  for (const cell of cells) counts.set(cell.state, (counts.get(cell.state) ?? 0) + 1);
  const summary = [...counts.entries()].map(([state, count]) => `${count} ${executionView[state as keyof typeof executionView]?.word.toLowerCase() ?? state}`).join(", ");
  return (
    <span role="img" aria-label={`Last ${cells.length} run${cells.length === 1 ? "" : "s"}: ${summary}`} title={summary}
      className="flex items-center gap-1">
      {cells.map((cell) => {
        const view = executionView[cell.state];
        const started = Date.parse(cell.startedAt);
        const detail = `${relativeTime(started, now)} · ${view.word}${cell.error ? ` · ${cell.error}` : ""}`;
        return (
          <span key={cell.id} title={detail} aria-hidden
            className={cn("inline-flex h-3 w-3 items-center justify-center text-[0.62rem] leading-none font-semibold", markTone[cell.state])}>
            {markShape[cell.state]}
          </span>
        );
      })}
    </span>
  );
}

/** "in 4m 32s" for a blocked schedule's retry time; counts down each second. */
export function RetryIn({ at }: { at: string }) {
  const now = useNow();
  const remaining = Math.max(0, Date.parse(at) - now);
  const seconds = Math.ceil(remaining / 1_000);
  const text = remaining <= 0 ? "due now" : `in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <time dateTime={at} className="tabular-nums">{text}</time>;
}

/** Coarse relative text for a past ISO time, with the absolute time in the title. */
export function Since({ at, className }: { at: string | null; className?: string }) {
  const now = useNow();
  return <time dateTime={at ?? undefined} title={at ? new Date(at).toLocaleString() : undefined} className={cn("tabular-nums", className)}>{relativeTime(at ? Date.parse(at) : null, now)}</time>;
}

/** Coarse relative text for a future ISO time, with the absolute time in the title. */
export function Due({ at, className }: { at: string | null; className?: string }) {
  const now = useNow();
  return <time dateTime={at ?? undefined} title={at ? new Date(at).toLocaleString() : undefined} className={cn("tabular-nums", className)}>{untilTime(at ? Date.parse(at) : null, now)}</time>;
}

/** A run's elapsed time while live, or its duration once terminal. Ticks only while running. */
export function RunAge({ run, className }: { run: Pick<ProcRun, "state" | "startedAt" | "finishedAt">; className?: string }) {
  const live = run.state === "starting" || run.state === "running";
  const now = useNow(live ? 1_000 : 60_000);
  const started = Date.parse(run.startedAt);
  const end = live ? now : run.finishedAt ? Date.parse(run.finishedAt) : now;
  const seconds = Math.max(0, Math.floor((end - started) / 1_000));
  const text = seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`;
  return <span className={cn("tabular-nums", className)}>{live ? `for ${text}` : text}</span>;
}

/** The shared tone scale: success, warning, destructive, muted and info dots. */
export function toneDot(tone: ProcTone): string {
  return { success: "bg-success", warning: "bg-warning", destructive: "bg-destructive", muted: "bg-muted-foreground/40", info: "bg-pkg-codex" }[tone];
}

/** A snapshot read that repeats on each generation; overlapping reads coalesce into one follow-up. */
export function useProcSnapshot<T>(key: string | null, generation: number, read: () => Promise<T>): { data: T | null; error: string | null; at: number | null } {
  const [value, setValue] = useState<{ key: string | null; data: T | null; error: string | null; at: number | null }>({ key, data: null, error: null, at: null });
  const flight = useRef({ key, running: false, again: false });
  const readRef = useRef(read);
  readRef.current = read;
  const run = useCallback(async () => {
    const state = flight.current;
    if (state.running) { state.again = true; return; }
    state.running = true;
    const runKey = state.key;
    try {
      const data = await readRef.current();
      if (flight.current.key === runKey) setValue({ key: runKey, data, error: null, at: Date.now() });
    } catch (error) {
      if (flight.current.key === runKey) setValue((current) => ({ key: runKey, data: current.key === runKey ? current.data : null, error: error instanceof Error ? error.message : String(error), at: Date.now() }));
    } finally {
      state.running = false;
      if (state.again && flight.current === state) { state.again = false; void run(); }
    }
  }, []);
  useEffect(() => {
    if (flight.current.key !== key) flight.current = { key, running: false, again: false };
    if (key) void run();
  }, [key, generation, run]);
  return value.key === key ? value : { data: null, error: null, at: null };
}


