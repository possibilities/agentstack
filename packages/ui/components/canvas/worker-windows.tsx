"use client";

import { useRef, useState } from "react";
import { ChevronRightIcon, CircleHelpIcon, CpuIcon, HammerIcon, TriangleAlertIcon } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { nodeKey, type WorkerListItem, type WorkerRuntime, type WorkerSession } from "@/lib/stack/types";
import { filterWorkers, groupWorkers, localOperator, workerAttention, workerGroups, workerLabel, workerNote, workerOrigin, type WorkerFilter } from "@/lib/stack/workers";
import { cn } from "@/lib/utils";
import { Empty, Flash, NodeLink, Orb, StatusDot, Time, type Tone } from "./primitives";
import { useStack, useWorkbench, useWorkerWindows } from "./provider";
import { Window } from "./window";
import { WorkerDefaultsButton } from "./worker-settings";

export const phaseTone: Record<WorkerSession["phase"], Tone> = {
  preparing: "info", running: "success", cancelling: "info", awaiting_input: "warning",
  needs_recovery: "warning", failed: "destructive", idle: "muted", closed: "muted",
};

export const phaseTitle: Record<WorkerSession["phase"], string> = {
  preparing: "Preparing", running: "Running", cancelling: "Cancelling", awaiting_input: "Awaiting permission",
  needs_recovery: "Needs recovery", failed: "Failed", idle: "Idle", closed: "Closed",
};

/** Show a Worker in the window already following it, else the primary Worker window, and bring it into view. */
export function useShowWorker(): (id: string) => void {
  const { workerWindows } = useWorkerWindows();
  const { goTo } = useWorkbench();
  return (id: string) => goTo({ kind: "worker-window", id: workerWindows.show(id) });
}

/**
 * Every Worker in worker_list, grouped by what it needs. Choosing one shows it
 * in the Worker window. Bots start and steer Workers; this space reads them and
 * edits only managed model and effort settings, including provider defaults.
 */
export function WorkersWindow() {
  const { workerSessions, workerAccounts, bots, status, endpoints } = useStack();
  const { windows, filter, workerWindows } = useWorkerWindows();
  const show = useShowWorker();
  const list = useRef<HTMLDivElement>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const labels = workerAccountLabels(workerAccounts.data);
  const all = workerSessions.data ?? [];
  const shown = filterWorkers(all, filter);
  const groups = groupWorkers(shown);
  const following = new Set(windows.map((window) => window.workerId).filter(Boolean));
  const origins = [...new Set([...(bots.data ?? []).map((bot) => bot.id), ...all.map((worker) => worker.botId)])]
    .sort((a, b) => a === localOperator ? 1 : b === localOperator ? -1 : a.localeCompare(b, undefined, { numeric: true }));
  const accounts = (workerAccounts.data ?? []).filter((account) => all.some((worker) => worker.accountId === account.id) || account.id === filter.accountId);
  const setFilter = (next: WorkerFilter) => workerWindows.setFilter(next);

  // Arrow keys move between rows and show each.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-worker]") ?? [])];
    const index = rows.findIndex((row) => row === document.activeElement);
    const next = index < 0 ? undefined : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    next.focus();
    show(next.dataset.worker!);
    event.preventDefault();
  };

  return (
    <Window id="workers" title="Workers" subtitle="worker" icon={HammerIcon} accent="worker" count={workerSessions.data ? shown.length : null}
      status={status.worker} endpoint={endpoints.worker} updatedAt={workerSessions.at} error={workerSessions.error} empty={!all.length}
      actions={endpoints.worker ? <WorkerDefaultsButton /> : undefined}>
      {!endpoints.worker ? <Empty icon={HammerIcon} title="Worker isn’t served by this server" />
        : !workerSessions.data ? <Empty icon={HammerIcon} title={workerSessions.error ? "Workers unavailable" : "Reading Workers…"} />
        : !all.length ? <Empty icon={HammerIcon} title="No Workers yet" />
        : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect size="sm" aria-label="Started by" className="min-w-0 flex-1" value={filter.botId ?? ""} onChange={(event) => setFilter({ ...filter, botId: event.target.value || undefined })}>
                <NativeSelectOption value="">All Bots</NativeSelectOption>
                {origins.map((id) => <NativeSelectOption key={id} value={id}>{workerOrigin(id)}</NativeSelectOption>)}
              </NativeSelect>
              <NativeSelect size="sm" aria-label="Account" className="min-w-0 flex-1" value={filter.accountId ?? ""} onChange={(event) => setFilter({ ...filter, accountId: event.target.value || undefined })}>
                <NativeSelectOption value="">All accounts</NativeSelectOption>
                {accounts.map((account) => <NativeSelectOption key={account.id} value={account.id}>{labels.get(account.id)}</NativeSelectOption>)}
              </NativeSelect>
            </div>
            {!shown.length ? <Empty icon={HammerIcon} title="No Workers match" /> : (
              <div ref={list} onKeyDown={onKeyDown} className="flex flex-col gap-3">
                {workerGroups.map(({ id, title }) => {
                  const members = groups.get(id)!;
                  if (!members.length) return null;
                  const collapsed = id === "closed" && !closedOpen;
                  return (
                    <section key={id} aria-label={title} className="flex flex-col gap-1.5">
                      <button type="button" disabled={id !== "closed"} aria-expanded={id === "closed" ? closedOpen : undefined} onClick={() => setClosedOpen((value) => !value)}
                        className="flex items-center gap-1 px-0.5 text-left text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase enabled:hover:text-foreground">
                        {id === "closed" ? <ChevronRightIcon className={cn("size-3 transition-transform", closedOpen && "rotate-90")} /> : null}
                        {title}<span className="tabular-nums">· {members.length}</span>
                      </button>
                      {collapsed ? null : (
                        <ul className="flex flex-col gap-1.5">
                          {members.map((worker) => (
                            <WorkerRow key={worker.id} worker={worker} accountLabel={labels.get(worker.accountId) ?? shortId(worker.accountId)}
                              selected={following.has(worker.id)} onSelect={() => show(worker.id)} />
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
    </Window>
  );
}

function WorkerRow({ worker, accountLabel, selected, onSelect }: { worker: WorkerListItem; accountLabel: string; selected: boolean; onSelect(): void }) {
  const attention = workerAttention(worker);
  const note = workerNote(worker);
  const turn = worker.turn;
  const active = turn && ["queued", "running", "awaiting_input", "cancelling"].includes(turn.phase);
  const key = nodeKey({ kind: "worker", id: worker.id });
  return (
    <li data-node={key} className="relative">
      <Flash id={key} />
      <button type="button" data-worker={worker.id} aria-current={selected ? "true" : undefined} onClick={onSelect}
        className={cn("flex w-full gap-2 rounded-xl border px-2.5 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring",
          selected && "border-foreground/25 bg-muted/60", worker.phase === "closed" && "opacity-70")}>
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          <StatusDot tone={phaseTone[worker.phase]} pulse={worker.phase === "running"} label={phaseTitle[worker.phase]} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[0.8rem] font-medium">{workerLabel(worker)}</span>
            <Time at={worker.updatedAt} className="shrink-0 text-[0.65rem] text-muted-foreground" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            <Orb id={worker.accountId} size="sm" className="size-2" />
            <span className="truncate">{accountLabel}</span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono">{[worker.model, worker.effort].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.68rem] text-muted-foreground">
            <span className="shrink-0 font-mono">{workerOrigin(worker.botId)}</span>
            {attention ? (
              <span className="flex min-w-0 items-center gap-1 text-warning"><TriangleAlertIcon aria-hidden className="size-3 shrink-0" /><span className="truncate">{attention}</span></span>
            ) : note ? (
              <span className="flex min-w-0 items-center gap-1 text-warning"><CircleHelpIcon aria-hidden className="size-3 shrink-0" /><span className="truncate">{note}</span></span>
            ) : active ? (
              <span className="min-w-0 truncate">{phaseTitle[worker.phase]} · turn started <Time at={turn.dispatchedAt ?? turn.createdAt} /></span>
            ) : turn ? (
              <span className="min-w-0 truncate">{phaseTitle[worker.phase]} · last turn {turn.phase}{turn.stopReason ? ` · ${turn.stopReason}` : ""}</span>
            ) : <span className="shrink-0">{phaseTitle[worker.phase]}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Account runtime health from worker_runtime_list, with the Workers each one carries. Draining stays with account removal. */
export function WorkerRuntimesWindow() {
  const { workerRuntimes, workerAccounts, workerSessions, resources, status, endpoints } = useStack();
  const labels = workerAccountLabels(workerAccounts.data);
  const runtimes = workerRuntimes.data ?? [];
  return (
    <Window id="worker-runtimes" title="Runtimes" subtitle="worker" icon={CpuIcon} accent="worker" count={workerRuntimes.data ? runtimes.length : null}
      status={status.worker} endpoint={endpoints.worker} updatedAt={workerRuntimes.at} error={workerRuntimes.error} empty={!runtimes.length}>
      {runtimes.length ? (
        <ul className="flex flex-col gap-1.5">
          {runtimes.map((runtime) => (
            <RuntimeRow key={runtime.id} runtime={runtime} label={labels.get(runtime.id) ?? shortId(runtime.id)}
              open={(workerSessions.data ?? []).filter((worker) => worker.accountId === runtime.id && worker.phase !== "closed").length}
              processes={resources.data?.processes ?? []} />
          ))}
        </ul>
      ) : <Empty icon={CpuIcon} title={workerRuntimes.data ? "No Worker runtimes" : "Runtimes unavailable"} />}
    </Window>
  );
}

const runtimeTone: Record<WorkerRuntime["state"], Tone> = { running: "success", stopped: "muted", error: "destructive" };

function RuntimeRow({ runtime, label, open, processes }: { runtime: WorkerRuntime; label: string; open: number; processes: Array<{ id: string; pid: number }> }) {
  const key = nodeKey({ kind: "worker-runtime", id: runtime.id });
  const pids = runtime.pid !== null ? [runtime.pid, ...runtime.pids.filter((pid) => pid !== runtime.pid)] : runtime.pids;
  return (
    <li data-node={key} className="relative flex flex-col gap-1 rounded-xl border px-2.5 py-2">
      <Flash id={key} />
      <span className="flex items-center gap-2 text-[0.8rem]">
        <StatusDot tone={runtimeTone[runtime.state]} label={runtime.state} />
        <NodeLink node={{ kind: "worker-account", id: runtime.id }} label={label} className="min-w-0 truncate font-medium">{label}</NodeLink>
        <span className="ml-auto shrink-0 text-[0.68rem] text-muted-foreground">{runtime.state}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.68rem] text-muted-foreground">
        <span>{providerTitle(runtime.provider)}</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{runtime.backend}</span>
        <span aria-hidden>·</span>
        <span title={runtime.processModel === "account" ? "One process for the account" : "One child process per session"}>{runtime.processModel === "account" ? "account process" : "session children"}</span>
        <span aria-hidden>·</span>
        <span>{open} open Worker{open === 1 ? "" : "s"}</span>
      </span>
      {pids.length ? (
        <span className="flex flex-wrap items-center gap-1.5 font-mono text-[0.68rem] text-muted-foreground">
          {pids.map((pid) => {
            const process = processes.find((item) => item.pid === pid);
            return process ? <NodeLink key={pid} node={{ kind: "process", id: process.id }} label={`pid ${pid}`}>pid {pid}</NodeLink> : <span key={pid}>pid {pid}</span>;
          })}
        </span>
      ) : null}
      {runtime.error ? <p className="text-[0.72rem] text-pretty text-destructive">{runtime.error}</p> : null}
    </li>
  );
}

/** A link to the Workers list, optionally filtered to one Bot or account. Renders nothing when no Worker matches. */
export function WorkersLink({ filter, className }: { filter: WorkerFilter; className?: string }) {
  const { workerSessions } = useStack();
  const { workerWindows } = useWorkerWindows();
  const { setSpace } = useWorkbench();
  const matching = filterWorkers(workerSessions.data ?? [], filter);
  if (!matching.length) return null;
  const open = matching.filter((worker) => worker.phase !== "closed").length;
  return (
    <a href="/workers" title="Show these Workers in the Workers space"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        workerWindows.setFilter(filter);
        setSpace("workers");
      }}
      className={cn("inline-flex h-6 items-center gap-1 rounded-md bg-muted/70 px-1.5 text-[0.7rem] text-muted-foreground decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring", className)}>
      <HammerIcon aria-hidden className="size-3 shrink-0" />
      <span className="text-foreground/90">{matching.length} Worker{matching.length === 1 ? "" : "s"}</span>
      {open !== matching.length ? <span>· {open} open</span> : null}
    </a>
  );
}
