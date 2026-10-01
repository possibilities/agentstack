"use client";

import { useLayoutEffect } from "react";
import { ArrowUpRightIcon, BookOpenIcon, HammerIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime, untilTime } from "@/lib/stack/derive";
import { checkProblem, periodText, releasesSummary, releaseStatus } from "@/lib/stack/developer";
import type { HarnessRelease } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { StatusDot } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";
import { Section, Window } from "./window";

/** An ISO time as coarse relative text, past or future, with the absolute time on hover. */
function When({ at, now, future = false }: { at: string | null; now: number; future?: boolean }) {
  const time = at ? Date.parse(at) : null;
  return <time dateTime={at ?? undefined} title={time !== null ? new Date(time).toLocaleString() : undefined} className="tabular-nums">
    {future ? untilTime(time, now) : relativeTime(time, now)}
  </time>;
}

const channelLabel = (row: HarnessRelease) => row.channel === "npm-latest" ? `npm ${row.packageName ?? row.id}, latest tag` : "Devin CLI current manifest";

/** One harness: its channel, the version last observed there, what the latest check says, and when one last succeeded. */
function ReleaseRow({ row, now }: { row: HarnessRelease; now: number }) {
  const state = releaseStatus(row, now);
  return (
    <li className="col-span-full grid grid-cols-subgrid items-baseline gap-y-0.5 rounded-md px-1 py-1.5 text-xs hover:bg-muted/60">
      <a href={row.sourceUrl} target="_blank" rel="noreferrer" title={`${channelLabel(row)}\n${row.sourceUrl}`}
        className="flex min-w-0 max-w-full items-center gap-1 justify-self-start rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        <span className="truncate">{row.title}</span>
        <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <span className="sr-only">release channel, opens in a new tab</span>
      </a>
      <span className={cn("text-right font-mono text-[0.7rem] tabular-nums @min-[22rem]:text-left", state.stale && "text-muted-foreground")}
        title={row.version === null ? "No release observed yet" : state.stale ? "The last good observation; not current" : "What the public channel published at the last check"}>
        <span className="sr-only">Upstream </span>{row.version ?? "—"}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[0.72rem]">
        <StatusDot tone={state.tone} pulse={state.checking} />
        <span>{state.label}</span>
      </span>
      <span className="text-right text-[0.68rem] text-muted-foreground"><span className="sr-only">Last success </span><When at={row.lastSuccessAt} now={now} /></span>
      {state.detail ? <p className={cn("col-span-full text-[0.68rem] text-pretty", state.tone === "destructive" ? "text-destructive" : "text-muted-foreground")}>{state.detail}</p> : null}
    </li>
  );
}

/** If keyboard focus is inside this window when it goes away (developer mode turned off elsewhere), hand it back to the bench. */
function useBenchFocusOnRemoval(id: string) {
  useLayoutEffect(() => () => {
    const frame = document.querySelector(`[data-window="${id}"]`);
    if (!frame?.contains(document.activeElement)) return;
    const bench = frame.closest<HTMLElement>("[data-canvas=workbench]");
    requestAnimationFrame(() => { if (bench?.isConnected && !bench.closest("[inert],[hidden]")) bench.focus({ preventScroll: true }); });
  }, [id]);
}

/**
 * System's developer-only window (ADR 0138), registered only while developer mode is on. Harness releases shows what
 * each public upstream channel published, as the server last observed it: a channel change, never an installed or
 * outdated version. Check now admits a server-side check; nothing here installs, upgrades or runs a harness.
 */
export function DeveloperWindow() {
  const { harnessReleases, harnessCheck, status, endpoints } = useStack();
  const store = useStore();
  const { goTo } = useWorkbench();
  const now = useNow(30_000);
  useBenchFocusOnRemoval("developer");
  const data = harnessReleases.data;
  const busy = Boolean(harnessCheck?.pending || data?.checking);
  return (
    <Window id="developer" title="Developer" subtitle="developer mode" icon={HammerIcon} accent="server" empty={!data && !harnessReleases.error}
      status={status.serve} endpoint={endpoints.serve} updatedAt={harnessReleases.at} error={harnessReleases.error}
      actions={
        <Button size="xs" variant="outline" disabled={busy || status.serve !== "open"} onClick={() => void store.checkHarnessReleases()}
          title="Read the four public release channels now. Nothing is installed or run.">
          {busy ? <Spinner /> : <RefreshCwIcon />}Check now
        </Button>
      }>
      <div className="flex flex-col gap-1">
        <p role="status" className="text-xs text-pretty text-muted-foreground">{releasesSummary(harnessReleases, harnessCheck, now)}</p>
        {harnessCheck?.error ? <p role="alert" className="text-xs text-pretty text-destructive">Check not started. {checkProblem(harnessCheck.error)}</p> : null}
        {data && harnessReleases.error ? <p role="status" className="text-xs text-pretty text-destructive">Read failed: {harnessReleases.error} · showing the last good read</p> : null}
        {data?.cacheError ? <p role="status" className="text-xs text-pretty text-destructive">Release cache: {data.cacheError.message}</p> : null}
      </div>
      {data ? (
        <Section title="Harness releases" aside={
          <Button variant="ghost" size="xs" className="-mr-1.5 h-5 shrink-0 px-1.5 text-[0.68rem] text-muted-foreground" onClick={() => goTo({ kind: "operation", pkg: "serve", id: "serve_harness_releases" })}>
            <BookOpenIcon data-icon="inline-start" />serve_harness_releases
          </Button>
        }>
          <div className="@container">
            <ul aria-label="Harness releases" className="-mx-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 @min-[22rem]:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
              {/* State and Last success share a cell, so the wider label doesn't widen the time column at the name's expense. */}
              <li aria-hidden className="col-span-full hidden grid-cols-subgrid px-1 text-[0.62rem] font-medium tracking-[0.08em] text-muted-foreground uppercase @min-[22rem]:grid">
                <span>Harness</span><span>Upstream</span><span className="col-span-2 flex justify-between gap-3"><span>State</span><span>Last success</span></span>
              </li>
              {data.observations.map((row) => <ReleaseRow key={row.id} row={row} now={now} />)}
            </ul>
          </div>
          <p className="px-0.5 text-[0.68rem] text-pretty text-muted-foreground">
            <span className="whitespace-nowrap">Checks every {periodText(data.intervalMs)}</span> · <span className="whitespace-nowrap">{periodText(data.timeoutMs)} timeout per source</span>
            {data.nextCheckAt ? <> · <span className="whitespace-nowrap">next check <When at={data.nextCheckAt} now={now} future /></span></> : null}
          </p>
          <p className="px-0.5 text-[0.66rem] text-pretty text-muted-foreground">
            Versions are what each public channel published, not what this machine runs. A first observation is a baseline, and nothing here installs or upgrades.
          </p>
        </Section>
      ) : null}
    </Window>
  );
}
