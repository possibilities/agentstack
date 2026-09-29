"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronRightIcon, SquareTerminalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { filterRuns, groupRuns, ownerOf, procRunGroups, runTitle, runView, scheduleTitle } from "@/lib/stack/proc";
import { nodeKey, type ProcRun } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Flash, StatusDot } from "./primitives";
import { OwnerChip, ProcPlaceholder, procUnavailable, RunAge } from "./proc-shared";
import { useProcWindows, useStack, useStore, useWorkbench } from "./provider";
import { Window } from "./window";

/** Show a run in the window already following it, else the primary Run window, and bring it into view. */
export function useShowProcRun(): (runId: string) => void {
  const { procWindows } = useProcWindows();
  const { goTo } = useWorkbench();
  return useCallback((runId: string) => goTo({ kind: "proc-run-window", id: procWindows.showRun(runId) }), [procWindows, goTo]);
}

/** A run's origin in words — the schedule title or "direct". Rows are one button, so no link here. */
function Origin({ run }: { run: ProcRun }) {
  const { procSchedules } = useStack();
  if (!run.scheduleId) return <span className="shrink-0 text-muted-foreground">direct</span>;
  const schedule = procSchedules.data?.find((item) => item.id === run.scheduleId);
  return <span className="min-w-0 truncate text-muted-foreground" title={`Schedule ${run.scheduleId}`}>{schedule ? scheduleTitle(schedule) : `schedule ${run.scheduleId.slice(0, 8)}`}</span>;
}

/** Every run in proc_run_list's newest page, grouped by what it needs; older pages load on request. */
export function ProcRunsWindow() {
  const { procRuns, procStatus, procSchedules, status, endpoints, remote } = useStack();
  const { runFilter, procWindows } = useProcWindows();
  const store = useStore();
  const show = useShowProcRun();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [older, setOlder] = useState<{ runs: ProcRun[]; cursor: string | null; loading: boolean; error: string | null }>({ runs: [], cursor: null, loading: false, error: null });
  const unavailable = procUnavailable(remote, endpoints);
  const first = procRuns.data;
  const all = [...(first?.runs ?? [])];
  {
    const seen = new Set(all.map((run) => run.id));
    for (const run of older.runs) if (!seen.has(run.id)) { seen.add(run.id); all.push(run); }
  }
  const shown = filterRuns(all, runFilter);
  const groups = groupRuns(shown, Date.now());
  const owners = [...new Set(all.map((run) => {
    const owner = ownerOf(run.createdBy);
    return owner.kind === "bot" ? owner.botId : owner.kind;
  }))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const nextCursor = older.cursor ?? first?.nextCursor ?? null;

  const loadOlder = async () => {
    if (older.loading || !nextCursor) return;
    setOlder((value) => ({ ...value, loading: true, error: null }));
    try {
      const page = await store.call<{ runs: ProcRun[]; nextCursor: string | null }>("proc", "proc_run_list", { cursor: nextCursor, limit: 100 });
      setOlder((value) => ({ runs: [...value.runs, ...page.runs.filter((run) => !all.some((known) => known.id === run.id))], cursor: page.nextCursor, loading: false, error: null }));
    } catch (error) {
      setOlder((value) => ({ ...value, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-run]") ?? [])];
    const index = rows.findIndex((row) => row === document.activeElement);
    const next = index < 0 ? undefined : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    next.focus();
    show(next.dataset.run!);
    event.preventDefault();
  };

  const runningCount = procStatus.data ? `${procStatus.data.running} of ${procStatus.data.capacity} running` : "proc";
  return (
    <Window id="proc-runs" title="Runs" subtitle={procStatus.data ? runningCount : "proc"} icon={SquareTerminalIcon} accent="proc"
      count={procRuns.data ? shown.length : null} status={status.proc} endpoint={endpoints.proc}
      updatedAt={procRuns.at} error={procRuns.error} empty={!all.length}>
      {unavailable ? <ProcPlaceholder title={unavailable} hint="Process output and schedule definitions stay on the Stack machine." />
        : !procRuns.data ? <ProcPlaceholder title={procRuns.error ? "Runs unavailable" : "Reading runs…"} />
        : !all.length ? <ProcPlaceholder title="No process runs yet" hint="Runs appear when a Bot or schedule starts a process." />
        : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect size="sm" aria-label="Owner" className="min-w-0 flex-1" value={runFilter.owner ?? ""}
                onChange={(event) => procWindows.setRunFilter({ owner: event.target.value || undefined })}>
                <NativeSelectOption value="">All owners</NativeSelectOption>
                {owners.map((id) => (
                  <NativeSelectOption key={id} value={id}>
                    {id === "operator" ? "Operator" : id === "system" ? "System" : id === "unattributed" ? "Unattributed" : id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {!shown.length ? <ProcPlaceholder title="No runs match" /> : (
              <div ref={list} onKeyDown={onKeyDown} className="flex flex-col gap-3">
                {procRunGroups.map(({ id, title }) => {
                  const members = groups.get(id)!;
                  if (!members.length) return null;
                  const collapsed = id === "finished" && !open;
                  return (
                    <section key={id} aria-label={title} className="flex flex-col gap-1.5">
                      <button type="button" disabled={id !== "finished"} aria-expanded={id === "finished" ? open : undefined}
                        onClick={() => setOpen((value) => !value)}
                        className="flex items-center gap-1 px-0.5 text-left text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase enabled:hover:text-foreground">
                        {id === "finished" ? <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} /> : null}
                        {title}<span className="tabular-nums">· {members.length}</span>
                      </button>
                      {collapsed ? null : (
                        <ul className="flex flex-col gap-1.5">
                          {members.map((run) => <RunRow key={run.id} run={run} onSelect={() => show(run.id)} />)}
                        </ul>
                      )}
                    </section>
                  );
                })}
                {nextCursor ? (
                  <Button variant="ghost" size="sm" className="self-center" disabled={older.loading} onClick={() => void loadOlder()}>
                    {older.loading ? <Spinner data-icon="inline-start" /> : null}Load older
                  </Button>
                ) : null}
                {older.error ? <p className="px-0.5 text-[0.7rem] text-destructive">{older.error}</p> : null}
              </div>
            )}
          </>
        )}
    </Window>
  );
}

function RunRow({ run, onSelect }: { run: ProcRun; onSelect(): void }) {
  const view = runView(run);
  const key = nodeKey({ kind: "proc-run", id: run.id });
  const titled = Boolean(run.label);
  return (
    <li data-node={key} className="relative">
      <Flash id={key} />
      <button type="button" data-run={run.id} onClick={onSelect}
        className="flex w-full gap-2 rounded-xl border px-2.5 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          <StatusDot tone={view.tone} label={view.word} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 text-[0.68rem] text-muted-foreground">{view.word}</span>
            <span className="min-w-0 flex-1 truncate text-[0.8rem] font-medium">{runTitle(run)}</span>
            {run.outputTruncated ? <Badge variant="secondary" className="shrink-0 text-[0.6rem]">truncated</Badge> : null}
          </span>
          {titled && run.command ? <span className="min-w-0 truncate font-mono text-[0.68rem] text-muted-foreground">{run.command}</span> : null}
          <span className="flex min-w-0 items-center gap-1.5 text-[0.68rem] text-muted-foreground">
            <OwnerChip actor={run.createdBy} static />
            <Origin run={run} />
            <RunAge run={run} className="shrink-0" />
            <span className="shrink-0 tabular-nums">{run.lineCount.toLocaleString()} lines</span>
          </span>
        </span>
      </button>
    </li>
  );
}
