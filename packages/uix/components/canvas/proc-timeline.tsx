"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartGanttIcon } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { relativeTime, untilTime } from "@/lib/stack/derive";
import { executionView, scheduleGroup, scheduleTitle } from "@/lib/stack/proc";
import { nodeKey, type ProcExecution, type ProcExecutionState, type ProcRun, type ProcScheduleListItem } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { ProcPlaceholder, procUnavailable } from "./proc-shared";
import { useNow, useProcWindows, useStack, useStore, useWorkbench } from "./provider";
import { Window } from "./window";

const hourMs = 3_600_000;

const markTone: Record<ProcExecutionState, string> = {
  running: "bg-pkg-codex", completed: "bg-success", failed: "bg-destructive", refused: "bg-muted-foreground/50", unknown: "border-warning text-warning",
};

const severity: Record<ProcExecutionState, number> = { failed: 4, unknown: 3, refused: 2, running: 1, completed: 0 };

type Lane = { id: string; title: string; executions: ProcExecution[]; schedule: ProcScheduleListItem | null; group: string };

/**
 * Executions on a shared clock: past marks, a running bar, and projected ticks.
 * Schedule lanes order by what needs a person first; direct process runs get
 * their own lane. Reads page across schedules on a trailing throttle.
 */
export function ProcTimelineWindow() {
  const { procSchedules, procRuns, procScheduleGeneration, remote, endpoints, status } = useStack();
  const { procWindows } = useProcWindows();
  const { goTo } = useWorkbench();
  const store = useStore();
  const now = useNow();
  const [range, setRange] = useState(24);
  const [runs, setRuns] = useState<Map<string, ProcExecution>>(new Map);
  const [error, setError] = useState<string | null>(null);
  const throttle = useRef({ at: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined });

  const start = now - range * hourMs;
  const end = now + range * hourMs;
  const unavailable = procUnavailable(remote, endpoints);

  const readAll = useCallback(async (since: string | null) => {
    const found = new Map<string, ProcExecution>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await store.call<{ executions: ProcExecution[]; nextCursor: string | null }>("proc", "proc_execution_list",
        { ...(since ? { since } : {}), ...(cursor ? { cursor } : {}), limit: 100 });
      for (const execution of result.executions) found.set(execution.id, execution);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return found;
  }, [store]);

  const latest = useRef({ runs, range, now });
  latest.current = { runs, range, now };

  // Mount and range changes read the whole window; later bumps merge what's new.
  // The first read can race the channel opening, so a failure retries a few times.
  useEffect(() => {
    let live = true;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      setError(null);
      throttle.current.at = Date.now();
      void readAll(new Date(latest.current.now - range * hourMs).toISOString()).then((found) => { if (live) setRuns(found); }, (cause) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        if (attempts++ < 5) retry = setTimeout(read, 2_000);
      });
    };
    read();
    return () => { live = false; clearTimeout(retry); };
  }, [range, readAll]); // eslint-disable-line react-hooks/exhaustive-deps

  // On a schedule notice, re-read at most once per 5 s (trailing), from the
  // newest known or oldest running start so state flips still arrive. With
  // nothing known (the first read may have raced channel open) re-read the
  // whole range instead of a since that can only ever return empty.
  useEffect(() => {
    const refresh = () => {
      throttle.current.at = Date.now();
      const { runs: known, range: span, now: at } = latest.current;
      const list = [...known.values()];
      const newest = Math.max(0, ...list.map((execution) => Date.parse(execution.startedAt)));
      const running = list.filter((execution) => execution.state === "running").map((execution) => Date.parse(execution.startedAt));
      const since = new Date(known.size === 0 ? at - span * hourMs : Math.min(newest || at, running.length ? Math.min(...running) : newest || at)).toISOString();
      void readAll(since).then((found) => setRuns((value) => {
        const next = new Map(value);
        for (const [id, execution] of found) next.set(id, execution);
        return next;
      }), () => undefined);
    };
    const wait = 5_000 - (Date.now() - throttle.current.at);
    if (wait <= 0) refresh();
    else throttle.current.timer = setTimeout(refresh, wait);
    return () => clearTimeout(throttle.current.timer);
  }, [procScheduleGeneration, readAll]);

  const executions = useMemo(() => [...runs.values()].filter((execution) => Date.parse(execution.startedAt) <= end), [runs, end]);
  const schedules = procSchedules.data ?? [];
  const lanes = useMemo<Lane[]>(() => {
    const inRange = executions.filter((execution) => Date.parse(execution.startedAt) >= start);
    const bySchedule = new Map<string, ProcExecution[]>();
    for (const execution of inRange) {
      const list = bySchedule.get(execution.scheduleId) ?? [];
      list.push(execution);
      bySchedule.set(execution.scheduleId, list);
    }
    const shown = schedules.filter((schedule) => !schedule.removedAt || bySchedule.has(schedule.id));
    const order = (schedule: ProcScheduleListItem) => {
      const group = scheduleGroup(schedule);
      return group === "attention" ? 0 : group === "held" ? 1 : group === "upcoming" ? 2 : 3;
    };
    const sorted = [...shown].sort((a, b) => order(a) - order(b) || (order(a) === 2 ? Date.parse(a.nextAt ?? "") - Date.parse(b.nextAt ?? "") : a.id.localeCompare(b.id)));
    const result: Lane[] = sorted.map((schedule) => ({ id: schedule.id, title: scheduleTitle(schedule), executions: bySchedule.get(schedule.id) ?? [], schedule, group: scheduleGroup(schedule) }));
    const direct = (procRuns.data?.runs ?? []).filter((run) => !run.scheduleId && Date.parse(run.startedAt) >= start);
    if (direct.length) result.push({ id: "direct", title: "Direct runs", executions: [], schedule: null, group: "direct" });
    return result;
  }, [executions, schedules, procRuns.data, start]);
  const directRuns = useMemo(() => (procRuns.data?.runs ?? []).filter((run) => !run.scheduleId && Date.parse(run.startedAt) >= start), [procRuns.data, start]);
  const [track, setTrack] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setTrack(entries[0]!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [unavailable]);

  const click = (execution: ProcExecution) => {
    procWindows.selectSchedule(execution.scheduleId);
    goTo({ kind: "proc-execution", id: execution.id });
  };
  const openRun = (run: ProcRun) => {
    goTo({ kind: "proc-run-window", id: procWindows.showRun(run.id) });
  };

  // Axis labels: hourly for six hours, every two hours for a day.
  const tickStep = range <= 6 ? hourMs : 2 * hourMs;
  const ticks: number[] = [];
  for (let at = Math.ceil(start / tickStep) * tickStep; at <= end; at += tickStep) ticks.push(at);
  const at = (time: number) => `${((time - start) / (end - start)) * 100}%`;

  return (
    <Window id="proc-timeline" title="Timeline" subtitle={`${range} h each way`} icon={ChartGanttIcon} accent="proc"
      status={status.proc} endpoint={endpoints.proc} updatedAt={procSchedules.at} error={error ?? procSchedules.error} empty={!lanes.length}
      actions={
        <NativeSelect size="sm" aria-label="Range" value={String(range)} onChange={(event) => setRange(Number(event.target.value))} className="mr-1">
          <NativeSelectOption value="6">6 h</NativeSelectOption>
          <NativeSelectOption value="24">24 h</NativeSelectOption>
        </NativeSelect>
      }>
      {unavailable ? <ProcPlaceholder title={unavailable} hint="Process output and schedule definitions stay on the AgentStack machine." />
        : !lanes.length && !error ? <ProcPlaceholder title={procSchedules.data ? "No executions in range" : "Reading timeline…"} />
        : (
          <div className="flex flex-col gap-1" aria-label="Schedule execution timeline">
            <div className="flex items-center gap-3">
              <span className="w-36 shrink-0" />
              <div ref={trackRef} className="relative h-4 flex-1 text-[0.6rem] text-muted-foreground">
                {ticks.map((tick) => (
                  <span key={tick} className="absolute -translate-x-1/2 tabular-nums" style={{ left: at(tick) }}>
                    {new Date(tick).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                  </span>
                ))}
              </div>
            </div>
            {lanes.map((lane) => {
              const inRange = lane.executions;
              const failed = inRange.filter((execution) => execution.state === "failed").length;
              const label = `${lane.title}: ${inRange.length} run${inRange.length === 1 ? "" : "s"} in ${range} h${failed ? `, ${failed} failed` : ""}${lane.schedule?.nextAt ? `; next ${untilTime(Date.parse(lane.schedule.nextAt), now)}` : ""}`;
              return (
                <div key={lane.id} className="flex items-center gap-3" aria-label={label}>
                  <span className="w-36 shrink-0 truncate text-[0.7rem] text-muted-foreground" title={lane.title}>{lane.title}</span>
                  <div className="relative h-7 flex-1 overflow-hidden rounded-md border border-border/50 bg-muted/20">
                    {lane.id === "direct" ? (
                      directRuns.map((run) => {
                        const from = Math.max(start, Date.parse(run.startedAt));
                        const to = Math.min(now, run.finishedAt ? Date.parse(run.finishedAt) : now);
                        return (
                          <button key={run.id} type="button" title={`${run.id.slice(0, 8)} · ${run.state} · ${relativeTime(Date.parse(run.startedAt), now)}`}
                            onClick={() => openRun(run)}
                            className={cn("absolute inset-y-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-ring", run.state === "exited" && run.exitCode === 0 ? "bg-success/60" : run.state === "running" || run.state === "starting" ? "bg-pkg-codex/70" : "bg-destructive/60")}
                            style={{ left: at(from), width: `max(4px, ${((to - from) / (end - start)) * 100}%)` }} />
                        );
                      })
                    ) : (
                      <LaneMarks lane={lane} start={start} end={end} now={now} width={track} onPick={click} />
                    )}
                    <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/30" style={{ left: at(now) }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </Window>
  );
}

/** Past execution marks and projected future ticks for one schedule lane. */
function LaneMarks({ lane, start, end, now, width, onPick }: {
  lane: Lane; start: number; end: number; now: number; width: number; onPick(execution: ProcExecution): void;
}) {
  const at = (time: number) => `${((time - start) / (end - start)) * 100}%`;
  const past = lane.executions;
  // More marks than fit at 4px each bin into columns: height is the count, tone the worst state.
  const dense = width > 0 && past.length > width / 4;
  const schedule = lane.schedule;
  const future: number[] = [];
  if (schedule && schedule.nextAt && schedule.enabled && !schedule.removedAt && !schedule.blockedReason) {
    future.push(Date.parse(schedule.nextAt));
    if (schedule.everyMs) {
      for (let tick = Date.parse(schedule.nextAt) + schedule.everyMs; tick <= end && future.length < 200; tick += schedule.everyMs) future.push(tick);
    }
  }
  const held = schedule?.blockedReason && schedule.retryAt && schedule.nextAt ? { from: Date.parse(schedule.nextAt), to: now } : null;
  return (
    <>
      {held && held.from < held.to ? (
        <span title={`held · ${relativeTime(held.from, now)} overdue`} className="absolute inset-y-1.5 rounded-sm bg-[repeating-linear-gradient(45deg,var(--warning)_0_2px,transparent_2px_6px)] opacity-40"
          style={{ left: at(held.from), width: `${((held.to - held.from) / (end - start)) * 100}%` }} />
      ) : null}
      {dense ? (
        <Bins executions={past} start={start} end={end} width={width} />
      ) : (
        past.flatMap((execution) => {
          const atTime = Date.parse(execution.startedAt);
          const view = executionView[execution.state];
          const label = `${view.word} · due ${relativeTime(Date.parse(execution.dueAt), now)} · started ${relativeTime(atTime, now)}${execution.error ? ` · ${execution.error}` : ""}`;
          const mark = (
            execution.state === "failed" ? <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[0.62rem] leading-none font-bold text-destructive">×</span>
              : <span className={cn("absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
                execution.state === "unknown" ? "size-2.5 rounded-full border-2" : execution.state === "refused" ? "h-0.5 w-2.5 rounded-full" : "size-2.5 rounded-full", markTone[execution.state])} />
          );
          return [
            // A running execution's bar reaches to now; the dot caps it.
            ...(execution.state === "running" ? [
              <span key={`${execution.id}:bar`} aria-hidden className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-pkg-codex/40"
                style={{ left: at(atTime), width: `${((Math.min(now, end) - atTime) / (end - start)) * 100}%` }} />,
            ] : []),
            <button key={execution.id} type="button" data-node={nodeKey({ kind: "proc-execution", id: execution.id })} aria-label={label} title={label} onClick={() => onPick(execution)}
              className="absolute top-0 h-full w-4 -translate-x-1/2 focus-visible:outline-2 focus-visible:outline-ring" style={{ left: at(atTime) }}>
              {mark}
            </button>,
          ];
        })
      )}
      {future.map((tick, index) => (
        <span key={tick} aria-hidden title={index === 0 ? `next ${untilTime(tick, now)}` : `projected ${untilTime(tick, now)}`}
          className={cn("absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-muted-foreground/60", index > 0 && "opacity-40")}
          style={{ left: at(tick) }} />
      ))}
    </>
  );
}

const binTone: Record<ProcExecutionState, string> = { failed: "bg-destructive", unknown: "bg-warning", refused: "bg-muted-foreground/50", running: "bg-pkg-codex", completed: "bg-success" };

function Bins({ executions, start, end, width }: { executions: ProcExecution[]; start: number; end: number; width: number }) {
  const bins = useMemo(() => {
    const columns = Math.max(1, Math.floor(width / 4));
    const result: Array<{ count: number; worst: ProcExecutionState; at: number }> = [];
    const map = new Map<number, { count: number; worst: ProcExecutionState }>();
    for (const execution of executions) {
      const column = Math.min(columns - 1, Math.floor(((Date.parse(execution.startedAt) - start) / (end - start)) * columns));
      const bin = map.get(column) ?? { count: 0, worst: "completed" as ProcExecutionState };
      bin.count++;
      if (severity[execution.state] > severity[bin.worst]) bin.worst = execution.state;
      map.set(column, bin);
    }
    for (const [column, bin] of map) result.push({ ...bin, at: column });
    return { columns, list: result };
  }, [executions, start, end, width]);
  return (
    <>
      {bins.list.map((bin) => {
        const counts = executions.filter((execution) => Math.min(bins.columns - 1, Math.floor(((Date.parse(execution.startedAt) - start) / (end - start)) * bins.columns)) === bin.at);
        const states = [...new Set(counts.map((execution) => execution.state))].map((state) => `${counts.filter((execution) => execution.state === state).length} ${executionView[state].word.toLowerCase()}`).join(", ");
        return (
          <span key={bin.at} aria-hidden title={`${bin.count} runs: ${states}`}
            className={cn("absolute bottom-1.5 w-[3px] rounded-sm", binTone[bin.worst])}
            style={{ left: `${(bin.at / bins.columns) * 100}%`, height: `${Math.min(1, bin.count / Math.max(1, ...bins.list.map((item) => item.count))) * 100}%` }} />
        );
      })}
    </>
  );
}
