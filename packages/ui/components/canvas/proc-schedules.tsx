"use client";

import { useRef, useState } from "react";
import { CalendarClockIcon, ChevronRightIcon } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { blockedCopy, cadence, filterSchedules, groupSchedules, ownerOf, procScheduleGroups, scheduleTitle, type ProcTone } from "@/lib/stack/proc";
import { nodeKey, type ProcScheduleListItem } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Flash, StatusDot } from "./primitives";
import { Due, OutcomeStrip, OwnerChip, procUnavailable, ProcPlaceholder, RetryIn } from "./proc-shared";
import { useProcWindows, useStack, useWorkbench } from "./provider";
import { useNow } from "./provider";
import { Window } from "./window";

/** What the row's dot reports; the word sits beside it in text. */
function scheduleWord(schedule: ProcScheduleListItem): { word: string; tone: ProcTone } {
  if (schedule.removedAt) return { word: "Removed", tone: "muted" };
  if (schedule.authority === null && !schedule.system) return { word: "Needs reauthorization", tone: "warning" };
  if (schedule.blockedReason) return schedule.retryAt === null ? { word: blockedCopy(schedule.blockedReason), tone: "warning" } : { word: "Held", tone: "warning" };
  if (!schedule.enabled) return { word: "Disabled", tone: "muted" };
  return { word: "Enabled", tone: "success" };
}

/** A schedule's target in one line: the API operation or the executable path, never its input or environment. */
function scheduleTarget(schedule: ProcScheduleListItem): string {
  return schedule.action.type === "api" ? `${schedule.action.package}.${schedule.action.operation}` : schedule.action.process.command;
}

const collapsibleGroups = new Set(["off", "removed"]);

/**
 * Every schedule from proc_schedule_list, grouped by what it needs. Choosing a
 * row selects it for the Schedule window. Operators act in the detail window;
 * Bots and MCP callers create and manage their own schedules through the API.
 */
export function ProcSchedulesWindow() {
  const { procSchedules, status, endpoints, remote, bots } = useStack();
  const { selectedScheduleId, scheduleFilter, procWindows } = useProcWindows();
  const { goTo } = useWorkbench();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = useNow();
  const unavailable = procUnavailable(remote, endpoints);
  const all = procSchedules.data ?? [];
  const shown = filterSchedules(all, scheduleFilter);
  const groups = groupSchedules(shown);
  const owners = [...new Set(all.map((schedule) => {
    const owner = ownerOf(schedule.authority);
    return owner.kind === "bot" ? owner.botId : owner.kind;
  }))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const botsKnown = new Set((bots.data ?? []).map((bot) => bot.id));

  const choose = (id: string) => {
    procWindows.selectSchedule(id);
    goTo({ kind: "proc-schedule", id });
  };

  // Arrow keys move between rows and select each.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-schedule]") ?? [])];
    const index = rows.findIndex((row) => row === document.activeElement);
    const next = index < 0 ? undefined : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    next.focus();
    choose(next.dataset.schedule!);
    event.preventDefault();
  };

  return (
    <Window id="proc-schedules" title="Schedules" subtitle="proc" icon={CalendarClockIcon} accent="proc" count={procSchedules.data ? shown.length : null}
      status={status.proc} endpoint={endpoints.proc} updatedAt={procSchedules.at} error={procSchedules.error} empty={!all.length}>
      {unavailable ? <ProcPlaceholder title={unavailable} hint="Process output and schedule definitions stay on the AgentStack machine." />
        : !procSchedules.data ? <ProcPlaceholder title={procSchedules.error ? "Schedules unavailable" : "Reading schedules…"} />
        : !all.length ? <ProcPlaceholder title="No schedules yet" hint="Bots create them with proc_schedule_create." />
        : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect size="sm" aria-label="Owner" className="min-w-0 flex-1" value={scheduleFilter.owner ?? ""}
                onChange={(event) => procWindows.setScheduleFilter({ ...scheduleFilter, owner: event.target.value || undefined })}>
                <NativeSelectOption value="">All owners</NativeSelectOption>
                {owners.map((id) => (
                  <NativeSelectOption key={id} value={id}>
                    {id === "operator" ? "Operator" : id === "system" ? "System" : id === "unattributed" ? "Unattributed" : `${id}${botsKnown.has(id) ? "" : " · removed"}`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect size="sm" aria-label="Kind" value={scheduleFilter.kind ?? ""}
                onChange={(event) => procWindows.setScheduleFilter({ ...scheduleFilter, kind: (event.target.value || undefined) as "api" | "process" | undefined })}>
                <NativeSelectOption value="">All kinds</NativeSelectOption>
                <NativeSelectOption value="api">API</NativeSelectOption>
                <NativeSelectOption value="process">Process</NativeSelectOption>
              </NativeSelect>
            </div>
            {!shown.length ? <ProcPlaceholder title="No schedules match" /> : (
              <div ref={list} onKeyDown={onKeyDown} className="flex flex-col gap-3">
                {procScheduleGroups.map(({ id, title }) => {
                  const members = groups.get(id)!;
                  if (!members.length) return null;
                  const collapsible = collapsibleGroups.has(id);
                  const collapsed = collapsible && !open.has(id);
                  return (
                    <section key={id} aria-label={title} className="flex flex-col gap-1.5">
                      <button type="button" disabled={!collapsible} aria-expanded={collapsible ? !collapsed : undefined}
                        onClick={() => setOpen((value) => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
                        className="flex items-center gap-1 px-0.5 text-left text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase enabled:hover:text-foreground">
                        {collapsible ? <ChevronRightIcon className={cn("size-3 transition-transform", !collapsed && "rotate-90")} /> : null}
                        {title}<span className="tabular-nums">· {members.length}</span>
                      </button>
                      {collapsed ? null : (
                        <ul className="flex flex-col gap-1.5">
                          {members.map((schedule) => (
                            <ScheduleRow key={schedule.id} schedule={schedule} now={now}
                              selected={selectedScheduleId === schedule.id} onSelect={() => choose(schedule.id)} />
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

/** A link to the Schedules list filtered to one Bot's owned schedules. Renders nothing when none match. */
export function ProcSchedulesLink({ botId, className }: { botId: string; className?: string }) {
  const { procSchedules } = useStack();
  const { procWindows } = useProcWindows();
  const { setSpace } = useWorkbench();
  const count = (procSchedules.data ?? []).filter((schedule) =>
    !schedule.removedAt && schedule.authority?.kind === "bot" && schedule.authority.botId === botId).length;
  if (!count) return null;
  return (
    <a href="/proc" title={`Show ${botId}'s schedules in the Proc space`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        procWindows.setScheduleFilter({ owner: botId });
        setSpace("proc");
      }}
      className={cn("inline-flex h-6 items-center gap-1 rounded-md bg-muted/70 px-1.5 text-[0.7rem] text-muted-foreground decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring", className)}>
      <CalendarClockIcon aria-hidden className="size-3 shrink-0" />
      <span className="text-foreground/90">{count} schedule{count === 1 ? "" : "s"}</span>
    </a>
  );
}

function ScheduleRow({ schedule, now, selected, onSelect }: { schedule: ProcScheduleListItem; now: number; selected: boolean; onSelect(): void }) {
  const state = scheduleWord(schedule);
  const key = nodeKey({ kind: "proc-schedule", id: schedule.id });
  return (
    <li data-node={key} className="relative">
      <Flash id={key} />
      <button type="button" data-schedule={schedule.id} aria-current={selected ? "true" : undefined} onClick={onSelect}
        className={cn("flex w-full gap-2 rounded-xl border px-2.5 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring",
          selected && "border-foreground/25 bg-muted/60", schedule.removedAt && "opacity-70")}>
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          <StatusDot tone={state.tone} label={state.word} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[0.8rem] font-medium">{scheduleTitle(schedule)}</span>
            {schedule.system ? <Badge variant="secondary" className="shrink-0 text-[0.6rem]">Protected</Badge> : null}
            <OutcomeStrip recent={schedule.recent} now={now} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{scheduleTarget(schedule)}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.68rem] text-muted-foreground">
            <OwnerChip actor={schedule.authority ?? schedule.createdBy} static />
            <span className="shrink-0">{cadence(schedule.everyMs)}</span>
            {schedule.blockedReason && schedule.retryAt ? (
              <span className="min-w-0 truncate text-warning">{blockedCopy(schedule.blockedReason)} · retry <RetryIn at={schedule.retryAt} /></span>
            ) : schedule.nextAt && !schedule.removedAt ? (
              <span className="shrink-0">next <Due at={schedule.nextAt} /></span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
