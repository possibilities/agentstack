"use client";

import { ProcClear } from "./proc-maintenance";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, CopyPlusIcon, OctagonXIcon, SearchIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortId } from "@/lib/stack/derive";
import { procExitLabels, procExitParts } from "@/lib/stack/completion";
import { errorCopy, formatLimitBytes, isActiveRun, joinPartials, lineGaps, ownerLabel, ownerOf, runTitle, runView, scheduleTitle, stripAnsi, type OutputGap, type ProcDisplayLine } from "@/lib/stack/proc";
import { localOperation } from "@/lib/stack/state";
import type { ProcOutputLine, ProcOutputPage, ProcRun, ProcRunDetail, ProcRunObservation } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, NodeLink, Row, StatusDot } from "./primitives";
import { OwnerChip, ProcPlaceholder, procUnavailable, useProcSnapshot } from "./proc-shared";
import { useNow, useProcWindows, useStack, useStore, useWorkbench } from "./provider";
import { BotWatch, useObservedRead } from "./watch-receipts";
import { Window } from "./window";

const pageSize = 100;

/** Keep a run's scoped output subscription and re-read it on each bump while a window shows it. */
function useWatchedRun(id: string | null): number {
  const store = useStore();
  const { procRunGenerations } = useStack();
  useEffect(() => id ? store.watchProcRun(id) : undefined, [store, id]);
  return id ? procRunGenerations[id] ?? 0 : 0;
}

/** One process run: its identity, exit state and bounded retained output. */
export function ProcRunWindow({ id }: { id: string }) {
  const { windows, procWindows } = useProcWindows();
  const { remote, endpoints, resources } = useStack();
  const { goTo } = useWorkbench();
  const runId = windows.find((window) => window.id === id)?.runId ?? null;
  const generation = useWatchedRun(runId);
  const store = useStore();
  const detail = useProcSnapshot<ProcRunDetail>(runId, generation, () => store.call<ProcRunDetail>("proc", "proc_run_get", { id: runId! }));
  const run = detail.data ?? null;
  const primary = id === "proc-run";
  // A completed output clear remounts the log so nothing loaded before it stays on screen.
  const [outputEpoch, setOutputEpoch] = useState(0);
  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open in new window" className="text-muted-foreground"
          onClick={() => goTo({ kind: "proc-run-window", id: procWindows.open(runId) })} />}>
          <CopyPlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in new window</TooltipContent>
      </Tooltip>
      {primary ? null : (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Close Run window" className="text-muted-foreground" onClick={() => procWindows.close(id)} />}>
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      )}
    </>
  );
  return (
    <Window id={id} title={run ? runTitle(run) : "Run"} subtitle={run ? `${run.id.slice(0, 8)} · ${runView(run).word}` : "proc"} icon={SquareTerminalIcon} accent="proc"
      node={run ? { kind: "proc-run", id: run.id } : undefined} reveal={{ kind: "proc-run-window", id }} bleed actions={actions}
      footer={run && isActiveRun(run) && !remote ? <StopControl run={run} /> : undefined}>
      {remote ? <ProcPlaceholder title="Available only on the local UI" hint="Process output and schedule definitions stay on the Stack machine." />
        : !endpoints.proc ? <ProcPlaceholder title="Proc isn't served by this server" />
        : !runId ? <ProcPlaceholder title="Choose a run" hint="Pick one in the Runs list." />
        : detail.error && !run ? <ProcPlaceholder title="Run unavailable" hint={detail.error} />
        : !run ? <ProcPlaceholder title="Reading run…" />
        : (
          <>
            <RunHeader run={run} processes={resources.data?.processes ?? []} generation={generation} />
            <ExitWatch run={run} generation={generation} />
            {isActiveRun(run) ? null : <div className="flex flex-col px-3 pb-1"><ProcClear key={run.id} kind="run_output" id={run.id} onReceipt={() => setOutputEpoch((value) => value + 1)} /></div>}
            <OutputLog key={`${run.id}:${run.retainOutput}:${outputEpoch}`} run={run} generation={generation} />
          </>
        )}
    </Window>
  );
}

function RunHeader({ run, processes, generation }: { run: ProcRunDetail; processes: Array<{ id: string; pid: number }>; generation: number }) {
  const { procSchedules } = useStack();
  const { procWindows } = useProcWindows();
  const { goTo } = useWorkbench();
  const view = runView(run);
  const now = useNow(isActiveRun(run) ? 1_000 : 60_000);
  const process = run.process;
  const observed = run.pid !== null ? processes.find((item) => item.pid === run.pid) : undefined;
  const timeoutAt = isActiveRun(run) && process?.timeoutMs ? Date.parse(run.startedAt) + process.timeoutMs : null;
  const remaining = timeoutAt ? Math.max(0, timeoutAt - now) : null;
  const owner = ownerOf(run.createdBy);
  const schedule = run.scheduleId ? procSchedules.data?.find((item) => item.id === run.scheduleId) : null;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[0.8rem]">
        <StatusDot tone={view.tone} label={view.word} />
        <span className="font-medium">{view.word}</span>
        <span className="ml-auto flex items-center gap-1 font-mono text-[0.68rem] text-muted-foreground">
          {shortId(run.id)}<CopyButton value={run.id} label="run ID" className="size-5 opacity-100" />
        </span>
      </div>
      <dl className="flex flex-col">
        <Row label="Command" mono copy={process ? [process.command, ...process.args].join(" ") : run.command}>
          {process ? `${process.command}${process.args.length ? ` ${process.args.join(" ")}` : ""}` : run.command ?? "—"}
        </Row>
        <Row label="Working directory" mono copy={process?.cwd ?? null}>{process?.cwd ?? "—"}</Row>
        {process?.envKeys.length ? (
          <Row label="Environment" hint="Names only; values aren't kept"><span className="font-mono">{process.envKeys.join(", ")}</span></Row>
        ) : null}
        <Row label="Timeout">
          {process?.timeoutMs ? (
            remaining !== null ? `stops in ${Math.floor(remaining / 60_000)}m ${Math.floor((remaining % 60_000) / 1_000)}s` : `${Math.round(process.timeoutMs / 1_000)}s`
          ) : "none"}
        </Row>
        <Row label="Process" mono>
          {run.pid !== null
            ? observed ? <NodeLink node={{ kind: "process", id: observed.id }} label={`pid ${run.pid}`}>pid {run.pid}</NodeLink> : `pid ${run.pid}`
            : "—"}
        </Row>
        {run.exitCode !== null || run.signal || run.state === "unknown" ? (
          <Row label="Exit">{[run.exitCode !== null ? `code ${run.exitCode}` : null, run.signal ? `signal ${run.signal}` : null,
            run.state === "unknown" ? "Unknown (not a proven failure)" : null].filter(Boolean).join(" · ")}</Row>
        ) : null}
        <Row label="Started">{new Date(Date.parse(run.startedAt)).toLocaleString()}</Row>
        {run.finishedAt ? <Row label="Finished">{new Date(Date.parse(run.finishedAt)).toLocaleString()}</Row> : null}
        <Row label="Owner">
          {owner.kind === "bot" ? <OwnerChip actor={run.createdBy} /> : ownerLabel(owner)}
        </Row>
        <Row label="Origin">
          {run.scheduleId ? (
            <button type="button" className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => { procWindows.selectSchedule(run.scheduleId); goTo({ kind: "proc-schedule", id: run.scheduleId! }); }}>
              {schedule ? scheduleTitle(schedule) : `schedule ${run.scheduleId.slice(0, 8)}`}
            </button>
          ) : "direct"}
        </Row>
      </dl>
      {isActiveRun(run) ? null : <p className="text-[0.68rem] text-pretty text-muted-foreground">Process exit isn't Work completion.</p>}
      {run.error ? <p className="text-[0.72rem] text-pretty text-warning">{errorCopy(run.error)}</p> : null}
    </div>
  );
}

/**
 * The exact run's exit observation and its Bot watch, separate from output: `proc_run_completion({id})`
 * is the compact exit projection — exited, failed, cancelled or unknown with code/signal and timing.
 * Unknown is not a proven failure. A retained receipt exists only when the Bot asked for a watch;
 * operator admissions show "No Bot watch requested".
 */
function ExitWatch({ run, generation }: { run: ProcRunDetail; generation: number }) {
  const state = useStack();
  const store = useStore();
  const access = localOperation(state, "proc", "proc_run_completion");
  const read = useObservedRead<ProcRunObservation>(access.available ? `run-completion:${run.id}` : null, `${generation}:${run.state}`,
    () => store.call<ProcRunObservation>("proc", "proc_run_completion", { id: run.id }));
  const result = read.data?.result ?? null;
  const view = result ? procExitLabels[result.state as keyof typeof procExitLabels] ?? { label: result.state, description: "" } : null;
  return (
    <section aria-label="Exit watch" className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3.5 py-2.5">
      <h3 className="text-[0.66rem] font-medium tracking-[0.06em] text-muted-foreground uppercase">Exit watch</h3>
      {!access.available ? <p className="text-[0.72rem] text-pretty text-muted-foreground">{access.reason}</p>
        : read.error ? <p className="text-[0.72rem] text-pretty text-destructive">Exit observation unavailable: {read.error}</p>
        : read.loading || !read.data ? <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3" />Reading exit…</p>
        : !result || !view ? <p className="text-[0.72rem] text-pretty text-muted-foreground">No exit observed yet — the run is starting or running.</p>
        : (
          <>
            <div className="flex items-center gap-2 text-[0.75rem]">
              <StatusDot tone={result.state === "exited" ? "success" : result.state === "cancelled" ? "muted" : result.state === "unknown" ? "warning" : "destructive"} label={view.label} />
              <span className="font-medium" title={view.description}>{view.label}</span>
            </div>
            <dl className="flex flex-col">
              <Row label="Facts" mono>{procExitParts(result).join(" · ") || "—"}</Row>
              <Row label="Started">{new Date(Date.parse(result.startedAt)).toLocaleString()}</Row>
              {result.finishedAt ? <Row label="Finished">{new Date(Date.parse(result.finishedAt)).toLocaleString()}</Row> : null}
            </dl>
            <p className="text-[0.68rem] text-pretty text-muted-foreground">Exit facts only — a terminal exit isn't Work completion.</p>
          </>
        )}
      <BotWatch pkg="proc" recordId={run.id} observe={`${generation}:${run.state}`} />
    </section>
  );
}

type LogState = {
  key: string | null;
  lines: ProcOutputLine[];
  /** Gaps by the first missing seq. */
  gaps: Map<number, OutputGap>;
  /** Whether the tail read has run. */
  tail: boolean;
  running: boolean;
  again: boolean;
};

/** Merge pages by seq so repeated and overlapping reads stay ordered. */
function mergeLines(existing: ProcOutputLine[], next: ProcOutputLine[]): ProcOutputLine[] {
  if (!next.length) return existing;
  const map = new Map(existing.map((line) => [line.seq, line]));
  for (const line of next) map.set(line.seq, line);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Bounded output pages by seq. The initial read covers the last ~200 lines and
 * continues to the end; each generation bump reads forward from the last seq.
 */
function OutputLog({ run, generation }: { run: ProcRunDetail; generation: number }) {
  const store = useStore();
  const { procStatus } = useStack();
  const scroll = useRef<HTMLDivElement>(null);
  const [stream, setStream] = useState<"" | "stdout" | "stderr">("");
  const [wrap, setWrap] = useState(true);
  const [find, setFind] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [earlier, setEarlier] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [readError, setReadError] = useState<string | null>(null);
  const state = useRef<LogState>({ key: null, lines: [], gaps: new Map(), tail: false, running: false, again: false });
  const [lineVersion, bumpLines] = useState(0);
  const atEnd = useRef(true);

  const key = run.id;
  useEffect(() => () => { state.current.key = null; }, []);
  if (state.current.key !== key) {
    state.current = { key, lines: [], gaps: new Map(), tail: false, running: false, again: false };
    atEnd.current = true;
    setReadError(null);
  }

  const readForward = useCallback(async () => {
    const s = state.current;
    if (s.running) { s.again = true; return; }
    s.running = true;
    try {
      // The first read covers the tail; follow-ups continue from the last seq. Merge into the live
      // state — a remount or key-change reset may replace state.current while a read is in flight.
      let after = s.tail ? (s.lines.at(-1)?.seq ?? 0) : Math.max(0, run.lineCount - 200);
      for (let page = 0; page < 50; page++) {
        const result = await store.call<ProcOutputPage>("proc", "proc_run_read", { id: key, after, limit: pageSize });
        const live = state.current;
        if (live.key !== key) return;
        for (const gap of lineGaps(after, result.lines, result.gap)) live.gaps.set(gap.from, gap);
        live.lines = mergeLines(live.lines, result.lines);
        live.tail = true;
        after = result.nextAfter;
        if (result.lines.length < pageSize) break;
      }
      setReadError(null);
    } catch (error) {
      if (state.current.key === key) setReadError(error instanceof Error ? error.message : String(error));
    } finally {
      const live = state.current;
      if (live.key === key) {
        live.running = false;
        bumpLines((value) => value + 1);
        if (live.again || s.again) { live.again = false; s.again = false; void readForward(); }
      }
    }
  }, [key, run.lineCount, store]);

  useEffect(() => { void readForward(); }, [key, generation, readForward]);

  const loadEarlier = async () => {
    const s = state.current;
    const first = s.lines[0];
    if (!first || first.seq <= 1) return;
    setEarlier({ loading: true, error: null });
    const after = Math.max(0, first.seq - 1 - pageSize);
    try {
      const result = await store.call<ProcOutputPage>("proc", "proc_run_read", { id: key, after, limit: first.seq - 1 - after });
      const live = state.current;
      if (live.key !== key) return;
      for (const gap of lineGaps(after, result.lines, result.gap)) live.gaps.set(gap.from, gap);
      live.lines = mergeLines(result.lines, live.lines);
      // Keep the reader where they were after the prepend.
      const element = scroll.current;
      const before = element ? element.scrollHeight - element.scrollTop : 0;
      bumpLines((value) => value + 1);
      requestAnimationFrame(() => { if (element) element.scrollTop = element.scrollHeight - before; });
      setEarlier({ loading: false, error: null });
    } catch (error) {
      setEarlier({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const display = useMemo(() => joinPartials(state.current.lines), [lineVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => stream ? display.filter((line) => line.stream === stream) : display, [display, stream]);
  const query = find.trim();
  const matchRows = useMemo(() => query ? visible.filter((line) => line.text.toLowerCase().includes(query.toLowerCase())) : [], [visible, query]);

  // Gap banners sit before the first visible row at or after the missing seq; an unbounded tail gap renders after the last row.
  const gapMarks = useMemo(() => {
    const before = new Map<number, OutputGap[]>();
    const tail: OutputGap[] = [];
    for (const gap of state.current.gaps.values()) {
      const target = visible.find((line) => line.seq >= gap.from)?.seq;
      if (target !== undefined) {
        const list = before.get(target) ?? [];
        list.push(gap);
        before.set(target, list);
      } else if (gap.afterSeq >= (visible.at(-1)?.seq ?? 0)) {
        tail.push(gap);
      }
    }
    return { before, tail };
  }, [visible, lineVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the tail while within 24px of the bottom.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [display]);
  const onScroll = () => {
    const element = scroll.current;
    if (!element) return;
    atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };

  const copyAll = async () => {
    const lines: ProcOutputLine[] = [];
    let after = 0;
    for (let page = 0; page < 120; page++) {
      const result = await store.call<ProcOutputPage>("proc", "proc_run_read", { id: key, after, limit: pageSize });
      lines.push(...result.lines);
      if (result.lines.length < pageSize) break;
      after = result.nextAfter;
    }
    return joinPartials(lines).map((line) => line.text).join("\n");
  };

  const limits = procStatus.data?.output;
  const firstSeq = state.current.lines[0]?.seq ?? 0;
  const missingBanner = !isActiveRun(run) && !run.retainOutput && run.lineCount > 0 && !state.current.lines.length;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
        <NativeSelect size="sm" aria-label="Stream" value={stream} onChange={(event) => { setStream(event.target.value as "" | "stdout" | "stderr"); setMatchIndex(0); }}>
          <NativeSelectOption value="">All output</NativeSelectOption>
          <NativeSelectOption value="stdout">stdout</NativeSelectOption>
          <NativeSelectOption value="stderr">stderr</NativeSelectOption>
        </NativeSelect>
        <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}
          className={cn("h-7 rounded-lg border px-2 text-[0.72rem] focus-visible:outline-2 focus-visible:outline-ring", wrap ? "border-foreground/20 bg-muted/60" : "text-muted-foreground")}>
          Wrap
        </button>
        <div className="relative flex min-w-32 flex-1 items-center">
          <SearchIcon aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
          <Input value={find} onChange={(event) => { setFind(event.target.value); setMatchIndex(0); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !matchRows.length) return;
              event.preventDefault();
              const next = (matchIndex + (event.shiftKey ? -1 : 1) + matchRows.length) % matchRows.length;
              setMatchIndex(next);
              scroll.current?.querySelector(`[data-match-seq="${matchRows[next]!.seq}"]`)?.scrollIntoView({ block: "nearest" });
            }}
            aria-label="Find in output" placeholder="Find" className="h-7 pl-7 text-[0.72rem]" />
          {query ? <span className="absolute right-2 text-[0.66rem] text-muted-foreground tabular-nums">{matchRows.length ? `${Math.min(matchIndex + 1, matchRows.length)}/${matchRows.length}` : "0"}</span> : null}
        </div>
        <CopyButton value={display.map((line) => line.text).join("\n")} label="loaded output" className="size-6 opacity-100" />
        <CopyAllButton read={copyAll} />
      </div>
      {firstSeq > 1 ? (
        <div className="flex shrink-0 items-center border-b border-border/60 px-3 py-1">
          <Button variant="ghost" size="sm" disabled={earlier.loading} onClick={() => void loadEarlier()}>
            {earlier.loading ? <Spinner data-icon="inline-start" /> : null}Load earlier lines
          </Button>
          {earlier.error ? <span className="ml-2 text-[0.7rem] text-destructive">{earlier.error}</span> : null}
        </div>
      ) : null}
      {missingBanner ? (
        <p className="shrink-0 border-b border-warning/40 bg-warning/5 px-3 py-1.5 text-[0.72rem] text-warning">
          This run doesn't keep output after it exits. It printed {run.lineCount.toLocaleString()} lines.
        </p>
      ) : null}
      {readError ? <p role="alert" className="shrink-0 border-b border-border/60 px-3 py-1.5 font-sans text-[0.7rem] text-destructive">{readError}</p> : null}
      <div ref={scroll} data-scroll onScroll={onScroll} aria-label="Process output" role="log"
        className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[0.7rem] leading-[1.5]", !wrap && "overflow-x-auto")}>
        {visible.length ? visible.map((line) => (
          <OutputRow key={line.seq} line={line} wrap={wrap} find={query} gaps={gapMarks.before.get(line.seq)}
            match={Boolean(query && matchRows[matchIndex]?.seq === line.seq)} />
        )) : !missingBanner ? <p className="py-4 text-center text-muted-foreground">{isActiveRun(run) ? "Waiting for output…" : run.lineCount === 0 ? "No output" : "No output retained"}</p> : null}
        {gapMarks.tail.map((gap, index) => <GapBanner key={`tail-${index}`} gap={gap} />)}
        {run.outputTruncated ? (
          <p className="mt-2 rounded-md bg-warning/10 px-2 py-1.5 font-sans text-[0.72rem] text-pretty text-warning">
            Output reached Proc's limit ({limits ? `${formatLimitBytes(limits.maxBytes)} or ${limits.maxLines.toLocaleString()} lines` : "2 MB or 10,000 lines"}). Later output was discarded.
          </p>
        ) : null}
      </div>
      <JumpToLatest scroll={scroll} display={display} atEnd={atEnd} />
    </div>
  );
}

function GapBanner({ gap }: { gap: OutputGap }) {
  return (
    <p className="my-1 rounded-md border border-dashed px-2 py-1 font-sans text-[0.68rem] text-muted-foreground">
      {gap.to === null ? `Lines ${gap.from} on weren't retained` : gap.from === gap.to ? `Line ${gap.from} wasn't retained` : `Lines ${gap.from}–${gap.to} weren't retained`}
    </p>
  );
}

function OutputRow({ line, wrap, find, gaps, match }: { line: ProcDisplayLine; wrap: boolean; find: string; gaps?: OutputGap[]; match: boolean }) {
  return (
    <>
      {gaps?.map((gap, index) => <GapBanner key={index} gap={gap} />)}
      <div data-match-seq={line.seq} className={cn("flex gap-2", match && "bg-warning/10")}>
        <span className="w-8 shrink-0 pt-px text-right text-muted-foreground/50 tabular-nums select-none">{line.seq}</span>
        <span className={cn("w-7 shrink-0 text-[0.6rem] leading-5 select-none", line.stream === "stderr" ? "text-destructive/80" : "text-muted-foreground/40")}>
          {line.stream === "stderr" ? "err" : ""}
        </span>
        <span className={cn("min-w-0 flex-1", wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre")}>
          <Marked text={stripAnsi(line.text)} find={find} />
          {line.partial ? <span title="Line continues in the next chunk" className="text-muted-foreground/50">…</span> : null}
        </span>
      </div>
    </>
  );
}

/** Case-insensitive find highlighting; output stays plain text. */
function Marked({ text, find }: { text: string; find: string }) {
  if (!find) return <>{text || " "}</>;
  const lower = text.toLowerCase();
  const needle = find.toLowerCase();
  const parts: React.ReactNode[] = [];
  let index = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, index)) {
    parts.push(text.slice(index, at), <mark key={parts.length} className="bg-warning/40 text-inherit">{text.slice(at, at + needle.length)}</mark>);
    index = at + needle.length;
  }
  parts.push(text.slice(index));
  return <>{parts}</>;
}

function CopyAllButton({ read }: { read(): Promise<string> }) {
  const [state, setState] = useState<"idle" | "reading" | "done" | "failed">("idle");
  useEffect(() => {
    if (state !== "done") return;
    const timer = setTimeout(() => setState("idle"), 1_500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <Button variant="ghost" size="sm" className="h-7 px-2 text-[0.72rem]" disabled={state === "reading"}
      onClick={() => {
        setState("reading");
        void read().then((text) => navigator.clipboard.writeText(text)).then(() => setState("done"), () => setState("failed"));
      }}>
      {state === "reading" ? <Spinner data-icon="inline-start" /> : null}{state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy all"}
    </Button>
  );
}

/** When the reader scrolls up, a pill offers the jump back to live output. */
function JumpToLatest({ scroll, display, atEnd }: { scroll: React.RefObject<HTMLDivElement | null>; display: ProcDisplayLine[]; atEnd: React.RefObject<boolean> }) {
  const [visible, setVisible] = useState(false);
  const [seenSeq, setSeenSeq] = useState(0);
  const newest = display.at(-1)?.seq ?? 0;
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const check = () => {
      const away = element.scrollHeight - element.scrollTop - element.clientHeight >= 24;
      setVisible(away);
      if (!away) setSeenSeq(display.at(-1)?.seq ?? 0);
    };
    check();
    element.addEventListener("scroll", check);
    return () => element.removeEventListener("scroll", check);
  }, [scroll, display]);
  if (!visible) return null;
  const fresh = Math.max(0, newest - seenSeq);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center">
      <button type="button"
        onClick={() => { const element = scroll.current; if (element) { element.scrollTop = element.scrollHeight; atEnd.current = true; setSeenSeq(newest); } }}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border bg-popover px-3 py-1 text-[0.7rem] shadow-sm hover:bg-muted">
        <ArrowDownIcon className="size-3" />{fresh ? `${fresh} new line${fresh === 1 ? "" : "s"} · ` : ""}Jump to latest
      </button>
    </div>
  );
}

/** Stop asks first, then keeps the verb through progress and error. */
function StopControl({ run }: { run: ProcRun }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = runTitle(run);
  const stop = async () => {
    setPending(true);
    setError(null);
    try {
      await store.call("proc", "proc_run_cancel", { id: run.id });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 px-1">
      <AlertDialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
        <AlertDialogTrigger render={<Button type="button" size="sm" variant="destructive" className="w-full" />}>
          <OctagonXIcon data-icon="inline-start" />Stop…
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {title}?</AlertDialogTitle>
            <AlertDialogDescription>Proc sends SIGTERM to its process group, then SIGKILL after 2 s.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={pending} onClick={() => void stop()}>
              {pending ? <Spinner data-icon="inline-start" /> : null}{pending ? "Stopping…" : "Stop"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error ? <p role="alert" className="px-1 text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
    </div>
  );
}
