"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClockIcon, ChevronRightIcon, EyeIcon, PauseIcon, PlayIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { shortId } from "@/lib/stack/derive";
import { blockedCopy, cadence, errorCopy, executionView, ownerOf, scheduleTitle } from "@/lib/stack/proc";
import { nodeKey, type ProcAction, type ProcExecution, type ProcSchedule } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty, Flash, NodeLink, NodeTitle, Row, StatusDot, Time } from "./primitives";
import { Due, OwnerChip, ProcPlaceholder, procUnavailable, RetryIn, Since, useProcSnapshot } from "./proc-shared";
import { useShowProcRun } from "./proc-runs";
import { fieldLabel, Raw } from "./scrape-shared";
import { useNow, useProcWindows, useStack, useStore } from "./provider";
import { Window } from "./window";

type ScheduleDetail = { schedule: ProcSchedule; executions: ProcExecution[]; nextCursor: string | null };

/** One schedule: its definition, its execution history, and the operator's controls. Follows the list's selection. */
export function ProcScheduleWindow() {
  const { procSchedules, procScheduleGeneration, remote, endpoints, status } = useStack();
  const { selectedScheduleId } = useProcWindows();
  const store = useStore();
  const [epoch, setEpoch] = useState(0);
  const detail = useProcSnapshot<ScheduleDetail>(selectedScheduleId, procScheduleGeneration + epoch, async () => {
    const [schedule, page] = await Promise.all([
      store.call<ProcSchedule>("proc", "proc_schedule_get", { id: selectedScheduleId!, includeRemoved: true }),
      store.call<{ executions: ProcExecution[]; nextCursor: string | null }>("proc", "proc_execution_list", { id: selectedScheduleId!, limit: 50 }),
    ]);
    return { schedule, executions: page.executions, nextCursor: page.nextCursor };
  });
  const unavailable = procUnavailable(remote, endpoints);
  // Older execution pages merge into this list; the first page refreshes with the snapshot.
  const [older, setOlder] = useState<{ key: string | null; executions: ProcExecution[]; cursor: string | null; loading: boolean; error: string | null }>(
    { key: null, executions: [], cursor: null, loading: false, error: null });
  const schedule = detail.data?.schedule ?? null;
  const executions = useMemo(() => {
    const seen = new Map<string, ProcExecution>();
    for (const execution of detail.data?.executions ?? []) seen.set(execution.id, execution);
    for (const execution of older.key === schedule?.id ? older.executions : []) if (!seen.has(execution.id)) seen.set(execution.id, execution);
    return [...seen.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }, [detail.data, older, schedule?.id]);

  const loadOlder = async () => {
    if (!schedule || older.loading) return;
    const cursor = older.key === schedule.id ? older.cursor : detail.data?.nextCursor;
    if (!cursor) return;
    setOlder((value) => ({ ...value, key: schedule.id, cursor: cursor ?? null, loading: true, error: null }));
    try {
      const page = await store.call<{ executions: ProcExecution[]; nextCursor: string | null }>("proc", "proc_execution_list", { id: schedule.id, cursor, limit: 50 });
      setOlder((value) => value.key === schedule.id
        ? { key: schedule.id, executions: [...value.executions, ...page.executions], cursor: page.nextCursor, loading: false, error: null } : value);
    } catch (error) {
      setOlder((value) => value.key === schedule.id ? { ...value, loading: false, error: error instanceof Error ? error.message : String(error) } : value);
    }
  };
  const olderCursor = schedule ? (older.key === schedule.id ? older.cursor : detail.data?.nextCursor) : null;
  const listed = selectedScheduleId ? procSchedules.data?.find((item) => item.id === selectedScheduleId) : null;

  return (
    <Window id="proc-schedule" title={schedule ? scheduleTitle(schedule) : "Schedule"} subtitle="proc" icon={CalendarClockIcon} accent="proc"
      node={schedule ? { kind: "proc-schedule", id: schedule.id } : undefined}
      status={status.proc} endpoint={endpoints.proc} updatedAt={detail.at} error={detail.error}
      empty={!schedule}
      footer={schedule && !remote ? <ScheduleControls schedule={schedule} onChanged={() => setEpoch((value) => value + 1)} /> : undefined}>
      {unavailable ? <ProcPlaceholder title={unavailable} hint="Process output and schedule definitions stay on the AgentStack machine." />
        : !selectedScheduleId ? <ProcPlaceholder title="Choose a schedule" hint="Pick one in the Schedules list." />
        : detail.error && !schedule ? <ProcPlaceholder title="Schedule unavailable" hint={detail.error} />
        : !schedule ? <ProcPlaceholder title={procSchedules.data && !listed && !detail.data ? "Reading schedule…" : "Reading schedule…"} />
        : (
          <>
            <ScheduleSummary schedule={schedule} />
            <ScheduleAction schedule={schedule} />
            <section className="flex flex-col gap-1.5" aria-label="Executions">
              <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Executions · {executions.length}</h3>
              {executions.length ? (
                <ul className="flex flex-col gap-1">
                  {executions.map((execution) => <ExecutionRow key={execution.id} execution={execution} />)}
                </ul>
              ) : <p className="px-0.5 text-[0.72rem] text-muted-foreground">No executions yet.</p>}
              {olderCursor ? (
                <Button variant="ghost" size="sm" className="self-center" disabled={older.loading} onClick={() => void loadOlder()}>
                  {older.loading ? <Spinner data-icon="inline-start" /> : null}Load older
                </Button>
              ) : null}
              {older.error ? <p className="px-0.5 text-[0.7rem] text-destructive">{older.error}</p> : null}
            </section>
          </>
        )}
    </Window>
  );
}

function actorName(actor: ProcSchedule["createdBy"]): string {
  const owner = ownerOf(actor);
  return owner.kind === "bot" ? owner.botId : owner.kind === "unattributed" ? "an unknown creator" : owner.kind;
}

function ScheduleSummary({ schedule }: { schedule: ProcSchedule }) {
  const owner = ownerOf(schedule.authority);
  const editedBy = schedule.lastEditedBy;
  const creator = actorName(schedule.createdBy);
  const editor = actorName(editedBy);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <OwnerChip actor={schedule.authority} />
        {schedule.system ? <Badge variant="secondary" className="text-[0.6rem]">Protected</Badge> : null}
        {schedule.removedAt ? <Badge variant="outline" className="text-[0.6rem]">Removed</Badge> : schedule.enabled ? <Badge variant="secondary" className="text-[0.6rem]">Enabled</Badge> : <Badge variant="outline" className="text-[0.6rem]">Disabled</Badge>}
      </div>
      {owner.kind === "bot" ? (
        <p className="text-[0.7rem] text-muted-foreground">Bot root thread <span className="font-mono">{schedule.authority && "botId" in schedule.authority ? shortId(schedule.authority.mainThreadId) : ""}</span></p>
      ) : null}
      {creator !== editor ? <p className="text-[0.7rem] text-muted-foreground">Created by {creator} · last edited by {editor}</p>
        : <p className="text-[0.7rem] text-muted-foreground">Created by {creator}</p>}
      {schedule.authority === null && !schedule.system ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">{blockedCopy(schedule.blockedReason ?? "legacy_reauthorization_required")}.</p>
      ) : schedule.blockedReason ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">
          {blockedCopy(schedule.blockedReason)}{schedule.retryAt ? <> · retry <RetryIn at={schedule.retryAt} /></> : null}.
        </p>
      ) : null}
      {schedule.everyMs !== null ? (
        <p className="text-[0.7rem] text-pretty text-muted-foreground">Next due counts from when the last run started. After downtime, missed runs happen once.</p>
      ) : null}
      <dl className="flex flex-col">
        <Row label="Revision" mono>{schedule.revision}</Row>
        <Row label="Cadence">{cadence(schedule.everyMs)}</Row>
        <Row label="First at"><Since at={schedule.firstAt} /></Row>
        <Row label="Next due">{schedule.nextAt ? <Due at={schedule.nextAt} /> : "—"}</Row>
        {schedule.retryAt ? <Row label="Retry at"><Due at={schedule.retryAt} /></Row> : null}
        <Row label="Created"><Since at={schedule.createdAt} /></Row>
        <Row label="Updated"><Since at={schedule.updatedAt} /></Row>
        {schedule.removedAt ? <Row label="Removed"><Since at={schedule.removedAt} /></Row> : null}
      </dl>
      {schedule.id === "00000000-0000-4000-8000-000000000001" ? (
        <p className="text-[0.72rem] text-pretty text-muted-foreground">
          The wake-up for Brain's due Sources. It admits nothing unless Sources are enabled.{" "}
          <a href="/brain" className="underline decoration-muted-foreground/50 underline-offset-4 hover:text-foreground">Open Brain</a>
        </p>
      ) : null}
    </div>
  );
}

/** What the schedule invokes. Environment values are masked until a per-key Reveal; they never render before that click. */
function ScheduleAction({ schedule }: { schedule: ProcSchedule }) {
  const action = schedule.action;
  if (action.type === "api") {
    return <ApiAction action={action} />;
  }
  return <ProcessAction key={schedule.id} process={action.process} />;
}

function ApiAction({ action }: { action: Extract<ProcAction, { type: "api" }> }) {
  const [expanded, setExpanded] = useState(false);
  const json = useMemo(() => JSON.stringify(action.input, null, 2), [action.input]);
  const long = json.length > 400;
  return (
    <section className="flex flex-col gap-1.5" aria-label="Action">
      <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Action · API call</h3>
      <p className="px-0.5 text-[0.8rem]">
        <NodeLink node={{ kind: "operation", pkg: action.package, id: action.operation }} label={`${action.package}.${action.operation}`} className="font-mono">
          {action.package}.{action.operation}
        </NodeLink>
      </p>
      <span className={fieldLabel}>Input</span>
      <div className="relative">
        <Raw value={json} className={cn(!expanded && long && "max-h-40")} />
        {long ? (
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse" : "Show all"}</Button>
        ) : null}
      </div>
    </section>
  );
}

function ProcessAction({ process }: { process: Extract<ProcAction, { type: "process" }>["process"] }) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const env = process.env ?? {};
  const keys = Object.keys(env);
  const toggle = (name: string) => setRevealed((value) => {
    const next = new Set(value);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return (
    <section className="flex flex-col gap-1.5" aria-label="Action">
      <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Action · process</h3>
      <dl className="flex flex-col">
        <Row label="Command" mono copy={process.command}>{process.command}</Row>
        <Row label="Working directory" mono copy={process.cwd ?? null}>{process.cwd ?? "—"}</Row>
        <Row label="Timeout">{process.timeoutMs === null ? "none" : `${Math.round(process.timeoutMs / 1_000)}s`}</Row>
        <Row label="Keep output">{process.retainOutput ? "yes" : "no"}</Row>
      </dl>
      {process.args.length ? (
        <div className="flex flex-col gap-0.5">
          <span className={fieldLabel}>Arguments</span>
          <ul className="flex flex-col gap-0.5 rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-[0.7rem] break-all">
            {process.args.map((arg, index) => <li key={index}>{arg}</li>)}
          </ul>
        </div>
      ) : null}
      {keys.length ? (
        <div className="flex flex-col gap-0.5">
          <span className={fieldLabel}>Environment</span>
          <ul className="flex flex-col gap-1 rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-[0.7rem]">
            {keys.map((name) => (
              <li key={name} className="flex items-center gap-2 break-all">
                <span>{name}=</span>
                <span className="min-w-0 flex-1 truncate">{revealed.has(name) ? env[name] : "••••••"}</span>
                <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={() => toggle(name)}>
                  <EyeIcon data-icon="inline-start" />{revealed.has(name) ? "Hide" : "Reveal"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ExecutionRow({ execution }: { execution: ProcExecution }) {
  const showRun = useShowProcRun();
  const [expanded, setExpanded] = useState(false);
  const key = nodeKey({ kind: "proc-execution", id: execution.id });
  const view = executionView[execution.state];
  const duration = execution.finishedAt ? Date.parse(execution.finishedAt) - Date.parse(execution.startedAt) : null;
  const truncated = execution.result !== null && typeof execution.result === "object" && (execution.result as { truncated?: unknown }).truncated === true;
  const hasJson = execution.result !== null && !truncated;
  const json = hasJson ? JSON.stringify(execution.result, null, 2) : null;
  return (
    <li data-node={key} className="relative rounded-lg border px-2.5 py-2">
      <Flash id={key} />
      <div className="flex items-center gap-2 text-[0.78rem]">
        <StatusDot tone={view.tone} label={view.word} />
        <NodeTitle node={{ kind: "proc-execution", id: execution.id }} label={`execution ${execution.id.slice(0, 8)}`} className="font-medium">{view.word}</NodeTitle>
        <span className="text-[0.68rem] text-muted-foreground">due <Time at={Date.parse(execution.dueAt)} /></span>
        {duration !== null ? <span className="text-[0.68rem] text-muted-foreground tabular-nums">{Math.max(0, Math.round(duration / 1_000))}s</span> : null}
        <Time at={Date.parse(execution.startedAt)} className="ml-auto text-[0.65rem] text-muted-foreground" />
      </div>
      {execution.error ? <p className="mt-1 text-[0.72rem] text-pretty text-warning">{errorCopy(execution.error)}</p> : null}
      {execution.state === "unknown" && !execution.error ? <p className="mt-1 text-[0.72rem] text-pretty text-warning">The outcome is unknown; Proc was interrupted before it could be proven.</p> : null}
      {truncated ? <p className="mt-1 text-[0.72rem] text-muted-foreground">Result exceeded 32 KB and wasn't kept</p> : null}
      {hasJson ? (
        <div className="mt-1">
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1 text-[0.68rem] text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className={cn("size-3 transition-transform", expanded && "rotate-90")} />Result
          </button>
          {expanded ? <Raw value={json!} className="mt-1" /> : null}
        </div>
      ) : null}
      {execution.processId ? (
        <button type="button" onClick={() => showRun(execution.processId!)}
          className="mt-1 inline-flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-[0.68rem] text-foreground/80 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          run {shortId(execution.processId)} →
        </button>
      ) : null}
    </li>
  );
}

const blockedCodes = new Set([
  "bot_service_unavailable", "bot_removed", "bot_root_changed", "bot_not_running", "bot_instance_changed", "bot_thread_unavailable",
  "target_mcp_unavailable", "target_not_mcp_exposed", "target_unavailable", "target_operation_unavailable",
  "recursive_schedule_refused", "authorization_unavailable",
]);

function controlError(message: string): string {
  if (message === "schedule_revision_conflict_or_protected") return "It changed since you opened it. Review it again.";
  if (blockedCodes.has(message)) return blockedCopy(message);
  return message;
}

/**
 * Disable, enable, remove and reauthorize. Each control asks first, keeps the
 * exact verb through confirmation, progress and error, and fences the write
 * with the revision it saw.
 */
function ScheduleControls({ schedule, onChanged }: { schedule: ProcSchedule; onChanged(): void }) {
  const store = useStore();
  const [error, setError] = useState<string | null>(null);
  const title = scheduleTitle(schedule);
  const spec = {
    label: schedule.label,
    action: schedule.action,
    firstAt: schedule.firstAt,
    everyMs: schedule.everyMs,
  };
  const update = async (enabled: boolean, firstAt?: string) => {
    await store.call("proc", "proc_schedule_update", {
      id: schedule.id, expectedRevision: schedule.revision, ...spec, enabled,
      ...(firstAt ? { firstAt } : {}),
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {schedule.enabled && !schedule.system && schedule.authority !== null && !schedule.removedAt ? (
          <ControlButton icon={PauseIcon} verb="Disable" title={`Disable ${title}?`}
            body={`It stops future runs; a run in progress continues. Its owner can enable it again.`}
            onRun={() => update(false)} onDone={onChanged} onError={setError} />
        ) : null}
        {!schedule.enabled && !schedule.system && schedule.authority !== null && !schedule.removedAt ? (
          <ControlButton icon={PlayIcon} verb="Enable" title={`Enable ${title}?`}
            body={schedule.everyMs !== null ? `It runs now, then ${cadence(schedule.everyMs)}.` : "It runs once, now."}
            onRun={() => update(true, new Date().toISOString())} onDone={onChanged} onError={setError} />
        ) : null}
        {schedule.authority === null && !schedule.system && !schedule.removedAt ? (
          <ReauthorizeControl schedule={schedule} title={title} spec={spec} onDone={onChanged} onError={setError} />
        ) : null}
        {!schedule.system && !schedule.removedAt ? (
          <ControlButton icon={Trash2Icon} verb="Remove" destructive title={`Remove ${title}?`}
            body={"It stops future runs. History is kept, and a run in progress continues."}
            onRun={() => store.call("proc", "proc_schedule_remove", { id: schedule.id, expectedRevision: schedule.revision })}
            onDone={onChanged} onError={setError} />
        ) : null}
      </div>
      {error ? <p role="alert" className="text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
    </div>
  );
}

function ControlButton({ icon: Icon, verb, title, body, destructive, onRun, onDone, onError }: {
  icon: React.ComponentType<{ className?: string }>; verb: string; title: string; body: string; destructive?: boolean;
  onRun(): Promise<unknown>; onDone(): void; onError(message: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    onError(null);
    try {
      await onRun();
      setOpen(false);
      onDone();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      onError(controlError(message));
      if (message === "schedule_revision_conflict_or_protected") { setOpen(false); onDone(); }
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
      <AlertDialogTrigger render={<Button type="button" size="sm" variant={destructive ? "destructive" : "outline"} />}>
        <Icon data-icon="inline-start" />{verb}…
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={() => void run()}>
            {pending ? <Spinner data-icon="inline-start" /> : null}{pending ? `${verb}…` : verb}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Reauthorizing adopts a legacy definition as the operator after showing the whole reviewed definition. */
function ReauthorizeControl({ schedule, title, spec, onDone, onError }: {
  schedule: ProcSchedule; title: string;
  spec: { label: string | null; action: ProcAction; firstAt: string; everyMs: number | null };
  onDone(): void; onError(message: string | null): void;
}) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [enableNow, setEnableNow] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const action = spec.action;
  const env = action.type === "process" ? action.process.env ?? {} : {};
  const envKeys = Object.keys(env);
  const run = async () => {
    setPending(true);
    onError(null);
    try {
      await store.call("proc", "proc_schedule_reauthorize", {
        id: schedule.id, expectedRevision: schedule.revision, ...spec,
        firstAt: enableNow ? new Date().toISOString() : spec.firstAt,
        enabled: enableNow,
      });
      setOpen(false);
      onDone();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      onError(controlError(message));
      if (message === "schedule_revision_conflict_or_protected") { setOpen(false); onDone(); }
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); if (!next) { setEnableNow(false); setRevealed(new Set()); } } }}>
      <AlertDialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
        <ShieldCheckIcon data-icon="inline-start" />Reauthorize…
      </AlertDialogTrigger>
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Authorize {title} as operator?</AlertDialogTitle>
          <AlertDialogDescription>It will run with your authority. Its creator stays unknown.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 text-[0.78rem]">
          <dl className="flex flex-col">
            <Row label="Label">{spec.label ?? <span className="text-muted-foreground">none</span>}</Row>
            <Row label="Cadence">{cadence(spec.everyMs)}</Row>
            {action.type === "api" ? (
              <Row label="Target" mono>{action.package}.{action.operation}</Row>
            ) : (
              <>
                <Row label="Command" mono>{action.process.command}</Row>
                <Row label="Arguments" mono>{action.process.args.join(" ") || "—"}</Row>
                <Row label="Working directory" mono>{action.process.cwd ?? "—"}</Row>
                {envKeys.length ? (
                  <div className="flex flex-col gap-0.5 py-1">
                    <span className={fieldLabel}>Environment</span>
                    <ul className="flex flex-col gap-1 font-mono text-[0.7rem]">
                      {envKeys.map((name) => (
                        <li key={name} className="flex items-center gap-2 break-all">
                          <span>{name}=</span>
                          <span className="min-w-0 flex-1 truncate">{revealed.has(name) ? env[name] : "••••••"}</span>
                          <Button type="button" variant="ghost" size="xs" className="shrink-0"
                            onClick={() => setRevealed((value) => { const next = new Set(value); if (next.has(name)) next.delete(name); else next.add(name); return next; })}>
                            {revealed.has(name) ? "Hide" : "Reveal"}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </dl>
          <div className="flex gap-1.5" role="radiogroup" aria-label="After authorization">
            {([false, true] as const).map((value) => (
              <button key={String(value)} type="button" role="radio" aria-checked={enableNow === value} onClick={() => setEnableNow(value)}
                className={cn("rounded-lg border px-2.5 py-1.5 text-[0.72rem]", enableNow === value ? "border-foreground/25 bg-muted/60" : "text-muted-foreground hover:bg-muted/40")}>
                {value ? "Enable now" : "Keep disabled"}
              </button>
            ))}
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={pending} onClick={() => void run()}>
            {pending ? <Spinner data-icon="inline-start" /> : null}{pending ? "Reauthorizing…" : "Reauthorize"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
