"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, EyeIcon, ListChecksIcon, PauseIcon, PlayIcon, RefreshCwIcon, SatelliteDishIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { relativeTime, untilTime } from "@/lib/stack/derive";
import { brainCallError, brainLocalReason, cadence, jobActions, jobStateView, jobViews, sourceHealthView, statusIssues, viewCount, type BrainJobView, type CallError } from "@/lib/stack/brain";
import type { BrainJob, BrainJobRecord, BrainRevealedJob, BrainShareState, BrainSource, BrainSyncAdmission } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Empty, Flash, NodeCard, NodeTitle, StatusDot, Time } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";
import { badge, brainUnavailable, SensitivityBadge } from "./brain-shared";
import { CallErrorNote, fieldLabel, Raw } from "./scrape-shared";
import { footerButton, Section, Window } from "./window";

const views: BrainJobView[] = ["attention", "active", "done", "all"];
const actionLabels = { retry: "Retry", cancel: "Cancel", exclude: "Exclude" } as const;

/**
 * The ingestion ledger, stalled work first. Rows are content-safe: job reads never carry the
 * submitted URL or text. Diagnostics, dispositions and an audited reveal live in each row.
 */
export function JobsWindow() {
  const store = useStore();
  const { status, endpoints, brainStatus, brainJobStats, brainJobView, brainJobs, brainSources, remote } = useStack();
  const now = useNow(30_000);
  const [expanded, setExpanded] = useState<number | null>(null);
  const stats = brainJobStats.data;
  const list = brainJobs.data && brainJobs.data.view === brainJobView.view && brainJobs.data.run === brainJobView.run ? brainJobs.data.jobs : null;
  const issues = statusIssues(brainStatus.data);
  const sourceNames = useMemo(() => new Map((brainSources.data ?? []).map((source) => [source.database_id, source])), [brainSources.data]);
  const blocked = brainLocalReason(remote) ?? brainUnavailable(endpoints, status);
  const { flash } = useWorkbench();
  // A link to a job opens its row, reading every state so the job is in the list.
  useEffect(() => {
    const id = flash?.key.startsWith("ingestion-job:") ? Number(flash.key.slice("ingestion-job:".length)) : null;
    if (!id) return;
    setExpanded(id);
    if (!list?.some((job) => job.id === id)) store.setBrainJobView("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash?.seq]);

  return (
    <Window id="brain-jobs" title="Jobs" icon={ListChecksIcon} accent="brain" count={stats?.total ?? null}
      status={endpoints.brain ? status.brain : undefined} endpoint={endpoints.brain} updatedAt={brainJobStats.at} error={brainJobStats.error ?? brainJobs.error ?? brainStatus.error}
      empty={!endpoints.brain}>
      {!endpoints.brain ? <Empty icon={ListChecksIcon} title="Brain isn't served by this owner" /> : (
        <>
          <div className="flex flex-col gap-1 px-0.5">
            <p className="flex items-center gap-1.5 text-[0.74rem]">
              <StatusDot tone={!brainStatus.data ? "muted" : issues.length ? "destructive" : "success"} />
              <span className="font-medium">{!brainStatus.data ? "Reading worker status…" : issues.length ? issues.join(" · ") : "Ingestion worker running"}</span>
            </p>
            {stats ? (
              <p className="flex flex-wrap gap-x-3 text-[0.68rem] text-muted-foreground tabular-nums">
                <span>{stats.runnable_due} due now</span>
                <span>{stats.active_leases} leased</span>
                {stats.stale_leases ? <span className="text-warning">{stats.stale_leases} stale {stats.stale_leases === 1 ? "lease" : "leases"}</span> : null}
                {stats.oldest_runnable_at ? <span>oldest waiting {relativeTime(Date.parse(stats.oldest_runnable_at), now)}</span> : null}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup value={[brainJobView.view]} onValueChange={(next: string[]) => { if (next.length) store.setBrainJobView(next[0] as BrainJobView, brainJobView.run); }}
              spacing={0} size="sm" variant="outline" aria-label="Jobs to show">
              {views.map((view) => {
                const count = brainJobView.run === null ? viewCount(stats, view) : null;
                return (
                  <ToggleGroupItem key={view} value={view} className="text-[0.72rem]">
                    {jobViews[view].title}{count !== null ? <span className={cn("ml-1 tabular-nums", view === "attention" && count ? "text-destructive" : "text-muted-foreground")}>{count}</span> : null}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
            {brainJobView.run !== null ? (
              <span className={cn(badge, "flex items-center gap-1 font-mono")}>
                Run {brainJobView.run}
                <button type="button" aria-label="Show jobs from every Run" onClick={() => store.setBrainJobView(brainJobView.view, null)} className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><XIcon className="size-3" /></button>
              </span>
            ) : null}
          </div>
          {!list ? <Empty icon={ListChecksIcon} title="Reading jobs…" />
            : !list.length ? <Empty icon={ListChecksIcon} title={brainJobView.view === "attention" ? "Nothing needs a decision" : "No jobs here"} /> : (
              <ul className="flex flex-col gap-0.5">
                {list.map((job) => (
                  <JobRow key={job.id} job={job} source={job.source_id !== null ? sourceNames.get(job.source_id) ?? null : null} expanded={expanded === job.id} blocked={blocked}
                    onToggle={() => setExpanded(expanded === job.id ? null : job.id)} onRun={(run) => store.setBrainJobView("all", run)} />
                ))}
              </ul>
            )}
          {list && list.length >= 200 ? <p className="px-0.5 text-[0.66rem] text-muted-foreground">Showing the newest 200 per state.</p> : null}
        </>
      )}
    </Window>
  );
}

function JobRow({ job, source, expanded, blocked, onToggle, onRun }: { job: BrainJob; source: BrainSource | null; expanded: boolean; blocked: string | null; onToggle(): void; onRun(run: number): void }) {
  const node = { kind: "ingestion-job" as const, id: String(job.id) };
  const view = jobStateView[job.state];
  return (
    <li data-node={`ingestion-job:${job.id}`} className="relative">
      <Flash id={`ingestion-job:${job.id}`} />
      <NodeCard node={node} label={`Job ${job.id}`} variant="row">
        <div className="flex min-w-0 items-center gap-2 text-[0.74rem]">
          <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} job ${job.id} details`}
            className="-ml-0.5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </button>
          <StatusDot tone={view.tone} label={view.label} />
          <NodeTitle node={node} label={`job ${job.id}`} className="shrink-0 font-mono tabular-nums">#{job.id}</NodeTitle>
          <span className={badge}>{job.kind}</span>
          <span className={cn("truncate", view.tone === "destructive" ? "text-destructive" : view.tone === "warning" ? "text-warning" : "text-muted-foreground")}>
            {view.label}{job.failure_class ? ` · ${job.failure_class}` : ""}
          </span>
          <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground"><Time at={Date.parse(job.updated_at)} /></span>
        </div>
        <p className="flex min-w-0 flex-wrap gap-x-2 pl-5 text-[0.66rem] text-muted-foreground">
          <span className="tabular-nums">{job.attempt_count} {job.attempt_count === 1 ? "attempt" : "attempts"}</span>
          {source ? <span className="truncate">from {source.display_name}</span> : null}
          {job.run_id !== null ? <button type="button" className="font-mono hover:text-foreground hover:underline" onClick={() => onRun(job.run_id!)}>run {job.run_id}</button> : null}
          {job.state === "retry_wait" ? <span>retries <RunAt at={job.run_at} /></span> : null}
          <SensitivityBadge value={job.sensitivity} />
        </p>
        {expanded ? <JobDetail job={job} blocked={blocked} /> : null}
      </NodeCard>
    </li>
  );
}

function RunAt({ at }: { at: string }) {
  const now = useNow(30_000);
  return <>{untilTime(Date.parse(at), now)}</>;
}

/** Sanitized diagnostics, the job's document once indexed, and operator dispositions. */
function JobDetail({ job, blocked }: { job: BrainJob; blocked: string | null }) {
  const store = useStore();
  const { brainJobRecords } = useStack();
  const record = brainJobRecords[job.id];
  const [share, setShare] = useState<BrainShareState | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  useEffect(() => { void store.loadBrainJob(job.id); }, [job.id, store]);
  useEffect(() => {
    if (job.state !== "completed") { setShare(null); return; }
    let live = true;
    store.call<{ shares: BrainShareState[] }>("brain", "share_read_states", { ids: [job.id] }).then((result) => { if (live) setShare(result.shares[0] ?? null); }, () => {});
    return () => { live = false; };
  }, [job.id, job.state, store]);
  const act = async (action: "retry" | "cancel" | "exclude") => {
    if (action === "exclude" && !reason.trim()) { setError({ text: "Exclusion needs a reason", uncertain: false }); return; }
    setPending(action);
    setError(null);
    try {
      await store.brainJobAction(action, job.id, reason);
      setReason("");
    } catch (failure) {
      setError(brainCallError(failure));
    } finally {
      setPending(null);
    }
  };
  const data: BrainJobRecord | null = record?.data ?? null;
  const actions = jobActions(job.state);
  return (
    <div className="flex flex-col gap-2 border-t pt-2 pl-5">
      {share?.document_id ? (
        <button type="button" className="self-start text-[0.72rem] font-medium hover:underline" onClick={() => store.openBrainDocument(share.document_id!)}>Read document {share.document_id}</button>
      ) : null}
      {!data ? (record?.error ? <CallErrorNote error={{ text: record.error, uncertain: false }} /> : <p className="text-[0.7rem] text-muted-foreground">Reading diagnostics…</p>) : (
        <>
          {data.failure_summary ? <Raw value={data.failure_summary} className="max-h-40 text-destructive" /> : null}
          {data.attempts.length ? (
            <Section title="Attempts">
              <ol className="flex flex-col gap-1">
                {data.attempts.map((attempt) => (
                  <li key={attempt.id} className="flex flex-col text-[0.7rem]">
                    <span className="flex items-center gap-2">
                      <span className="font-mono tabular-nums">{attempt.attempt_number}</span>
                      <span className={cn(attempt.state === "failed" || attempt.state === "stale" ? "text-destructive" : attempt.state === "succeeded" ? "text-success" : "text-muted-foreground")}>{attempt.state}</span>
                      {attempt.failure_class ? <span className="text-muted-foreground">{attempt.failure_class}</span> : null}
                      <span className="ml-auto text-[0.64rem] text-muted-foreground"><Time at={Date.parse(attempt.started_at)} /></span>
                    </span>
                    {attempt.failure_summary ? <span className="font-mono text-[0.64rem] break-all text-muted-foreground">{attempt.failure_summary}</span> : null}
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}
          <Section title="History">
            <ol className="flex flex-col text-[0.68rem] text-muted-foreground">
              {data.transitions.map((transition) => (
                <li key={transition.id} className="flex items-center gap-2">
                  <span>{transition.from_state ? `${transition.from_state} → ` : ""}<span className="text-foreground">{transition.to_state}</span></span>
                  <span className="ml-auto"><Time at={Date.parse(transition.created_at)} /></span>
                </li>
              ))}
            </ol>
          </Section>
        </>
      )}
      {actions.length ? (
        <form className="flex flex-col gap-1.5" onSubmit={(event) => event.preventDefault()}>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Reason (recorded on the transition{actions.includes("exclude") ? "; required to exclude" : ""})</span>
            <Input value={reason} disabled={Boolean(blocked) || pending !== null} autoComplete="off" onChange={(event) => { setReason(event.target.value); setError(null); }} className="h-7 text-[0.74rem]" />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {actions.map((action) => (
              <Button key={action} type="button" size="xs" variant={action === "retry" ? "default" : "outline"} disabled={Boolean(blocked) || pending !== null} title={blocked ?? undefined} onClick={() => void act(action)}>
                {pending === action ? <Spinner data-icon="inline-start" /> : action === "retry" ? <RotateCcwIcon data-icon="inline-start" /> : null}{actionLabels[action]}
              </Button>
            ))}
            <RevealContent job={job} blocked={blocked} />
          </div>
          <CallErrorNote error={error} />
        </form>
      ) : <div className="flex"><RevealContent job={job} blocked={blocked} /></div>}
    </div>
  );
}

/** Reveal is deliberate: it reads submitted content and appends a sensitive-inspection audit record. Nothing is kept after closing. */
function RevealContent({ job, blocked }: { job: BrainJob; blocked: string | null }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState<BrainRevealedJob | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const reveal = async () => {
    setPending(true);
    setError(null);
    try {
      setRevealed(await store.call<BrainRevealedJob>("brain", "jobs_reveal", { "job-id": job.id, actor: "uix", "max-bytes": 200_000 }));
    } catch (failure) {
      setError(brainCallError(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); if (!next) { setRevealed(null); setError(null); } } }}>
      <AlertDialogTrigger render={<Button type="button" size="xs" variant="ghost" className="ml-auto" />} disabled={Boolean(blocked)} title={blocked ?? "Show what was submitted (audited)"}>
        <EyeIcon data-icon="inline-start" />Reveal content…
      </AlertDialogTrigger>
      <AlertDialogContent className={revealed ? "sm:max-w-2xl" : undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{revealed ? `Job ${job.id} content` : `Reveal job ${job.id}'s content?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {revealed ? "Recorded in Brain's audit log. Closing this discards it from the page."
              : "This shows the submitted intent and captured text, and appends a sensitive-inspection audit record naming this UI. Ordinary diagnostics never need it."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {revealed ? (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
            <span className={fieldLabel}>Intent</span>
            <Raw value={JSON.stringify(revealed.intent, null, 2)} />
            {revealed.artifacts.map((artifact) => (
              <div key={artifact.content_digest} className="flex flex-col gap-1">
                <span className={fieldLabel}>{artifact.media_type} · {artifact.byte_size.toLocaleString()} bytes</span>
                <Raw value={artifact.body} />
              </div>
            ))}
          </div>
        ) : null}
        <CallErrorNote error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{revealed ? "Close" : "Cancel"}</AlertDialogCancel>
          {revealed ? null : <Button disabled={pending} onClick={() => void reveal()}>{pending ? "Revealing…" : "Reveal and record"}</Button>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const syncText: Record<BrainSyncAdmission["status"], string> = {
  queued: "Discovery Run admitted", duplicate: "A Run for this schedule already exists", would_queue: "Would admit a Run", not_due: "Not due",
  disabled: "Disabled", paused: "Paused", unsupported: "This kind can't sync",
};

/**
 * Recurring Research sources. A Run's success proves discovery and child admission, not that
 * every discovered item has been indexed. Definitions are applied through the API.
 */
export function SourcesWindow() {
  const store = useStore();
  const { status, endpoints, brainSources, remote } = useStack();
  const [outcomes, setOutcomes] = useState<Record<string, { text: string; tone: "muted" | "destructive" | "warning" }>>({});
  const [bulk, setBulk] = useState<"preview" | "sync" | null>(null);
  const [bulkResult, setBulkResult] = useState<{ text: string; error: boolean } | null>(null);
  const sources = brainSources.data ?? [];
  const blocked = brainLocalReason(remote) ?? brainUnavailable(endpoints, status);
  const report = (results: BrainSyncAdmission[]) => {
    setOutcomes((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.source_id,
      { text: `${syncText[result.status]}${result.run_id ? ` · run ${result.run_id}` : ""}`, tone: result.status === "queued" || result.status === "would_queue" ? "muted" as const : "warning" as const }])) }));
  };
  const syncDue = async (dryRun: boolean) => {
    setBulk(dryRun ? "preview" : "sync");
    setBulkResult(null);
    try {
      const { results } = await store.brainSync<{ results: BrainSyncAdmission[] }>({ due: true, dryRun });
      report(results);
      const admitted = results.filter((result) => result.status === (dryRun ? "would_queue" : "queued")).length;
      setBulkResult({ text: dryRun ? `${admitted} due ${admitted === 1 ? "source" : "sources"} would sync` : `${admitted} discovery ${admitted === 1 ? "Run" : "Runs"} admitted`, error: false });
    } catch (failure) {
      setBulkResult({ text: brainCallError(failure).text, error: true });
    } finally {
      setBulk(null);
    }
  };
  return (
    <Window id="brain-sources" title="Sources" icon={SatelliteDishIcon} accent="brain" count={brainSources.data ? sources.length : null}
      status={endpoints.brain ? status.brain : undefined} endpoint={endpoints.brain} updatedAt={brainSources.at} error={brainSources.error}
      empty={!sources.length && !bulkResult}
      footer={endpoints.brain && sources.length ? (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" className={footerButton} disabled={Boolean(blocked) || bulk !== null} title={blocked ?? "Report which due sources would sync, without admitting anything"} onClick={() => void syncDue(true)}>
            {bulk === "preview" ? <Spinner data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}Preview due
          </Button>
          <Button variant="ghost" size="sm" className={footerButton} disabled={Boolean(blocked) || bulk !== null} title={blocked ?? "Admit a discovery Run for every overdue source"} onClick={() => void syncDue(false)}>
            {bulk === "sync" ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Sync due
          </Button>
        </div>
      ) : undefined}>
      {bulkResult ? <p role="status" className={cn("px-0.5 text-[0.7rem]", bulkResult.error ? "text-destructive" : "text-muted-foreground")}>{bulkResult.text}</p> : null}
      {!endpoints.brain ? <Empty icon={SatelliteDishIcon} title="Brain isn't served by this owner" />
        : !brainSources.data ? <Empty icon={SatelliteDishIcon} title="Reading sources…" />
        : !sources.length ? (
          <div className="flex flex-col gap-1">
            <Empty icon={SatelliteDishIcon} title="No sources" />
            <p className="px-0.5 text-center text-[0.7rem] text-pretty text-muted-foreground">Feeds and timelines are defined with sources_apply. A fresh Brain has none.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sources.map((source) => <SourceRow key={source.id} source={source} blocked={blocked} outcome={outcomes[source.id] ?? null} onOutcome={report} />)}
          </ul>
        )}
    </Window>
  );
}

function SourceRow({ source, blocked, outcome, onOutcome }: { source: BrainSource; blocked: string | null; outcome: { text: string; tone: "muted" | "destructive" | "warning" } | null; onOutcome(results: BrainSyncAdmission[]): void }) {
  const store = useStore();
  const now = useNow(30_000);
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const node = { kind: "research-source" as const, id: source.id };
  const health = !source.enabled ? { label: "Disabled", tone: "muted" as const } : source.paused ? { label: "Paused", tone: "muted" as const } : sourceHealthView[source.health.state];
  const run = source.latest_run;
  const act = async (name: string, work: () => Promise<unknown>) => {
    setPending(name);
    setError(null);
    try { await work(); } catch (failure) { setError(brainCallError(failure)); } finally { setPending(null); }
  };
  const sync = (dryRun: boolean) => act(dryRun ? "preview" : "sync", async () => {
    const { results } = await store.brainSync<{ results: BrainSyncAdmission[] }>({ sourceId: source.id, dryRun });
    onOutcome(results);
  });
  const pauseOrResume = () => act("pause", async () => {
    await store.brainSourceAction(source.paused ? "resume" : "pause", source.id, reason);
    setPausing(false);
    setReason("");
  });
  return (
    <li data-node={`research-source:${source.id}`} className="relative">
      <Flash id={`research-source:${source.id}`} />
      <NodeCard node={node} label={source.display_name} variant="row">
        <div className="flex min-w-0 items-center gap-2 text-[0.76rem]">
          <StatusDot tone={health.tone} label={health.label} />
          <NodeTitle node={node} label={source.display_name} className="min-w-0 truncate font-medium">{source.display_name}</NodeTitle>
          <span className={badge}>{source.kind}</span>
          <SensitivityBadge value={source.sensitivity} />
          <span className="ml-auto shrink-0 text-[0.66rem] text-muted-foreground">{health.label}</span>
        </div>
        <p className="flex min-w-0 flex-wrap gap-x-2 text-[0.66rem] text-muted-foreground">
          {source.schedule ? <span>every {cadence(source.schedule.cadence_seconds)}</span> : <span>no schedule</span>}
          {source.enabled && !source.paused ? <span className={source.due ? "text-foreground" : undefined}>{source.due ? "due now" : source.health.next_due_at ? `next ${untilTime(Date.parse(source.health.next_due_at), now)}` : null}</span> : null}
          {source.health.last_success_at ? <span>last success {relativeTime(Date.parse(source.health.last_success_at), now)}</span> : null}
          {!source.executable ? <span className="text-warning">not runnable by this Brain</span> : null}
        </p>
        {source.paused && source.pause_reason ? <p className="text-[0.66rem] text-muted-foreground">Paused: {source.pause_reason}</p> : null}
        {source.health.detail && source.health.state !== "healthy" ? <p className={cn("text-[0.66rem] break-words", source.health.state === "unhealthy" ? "text-destructive" : "text-warning")}>{source.health.detail}</p> : null}
        {run ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.66rem] text-muted-foreground">
            <button type="button" className="font-mono hover:text-foreground hover:underline" title="Show this Run's jobs"
              onClick={() => store.setBrainJobView("all", run.id)}>run {run.id}</button>
            <span className={run.outcome === "failed" ? "text-destructive" : run.outcome === "partial" ? "text-warning" : undefined}>{run.outcome ?? run.state.replace(/_/g, " ")}</span>
            <span className="tabular-nums">{run.counts.discovered} found · {run.counts.admitted} admitted · {run.counts.suppressed} suppressed</span>
            {run.warnings ? <span className="text-warning tabular-nums">{run.warnings} {run.warnings === 1 ? "warning" : "warnings"}</span> : null}
            <span className="ml-auto"><Time at={Date.parse(run.finished_at ?? run.created_at)} /></span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="xs" variant="outline" disabled={Boolean(blocked) || pending !== null} title={blocked ?? "Admit a discovery Run now"} onClick={() => void sync(false)}>
            {pending === "sync" ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Sync
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={Boolean(blocked) || pending !== null} title={blocked ?? "Report what a sync would admit"} onClick={() => void sync(true)}>
            {pending === "preview" ? <Spinner data-icon="inline-start" /> : null}Preview
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={Boolean(blocked) || pending !== null} aria-expanded={pausing} title={blocked ?? undefined} onClick={() => setPausing(!pausing)}>
            {source.paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}{source.paused ? "Resume…" : "Pause…"}
          </Button>
          {outcome ? <span className={cn("ml-auto text-[0.66rem]", outcome.tone === "warning" ? "text-warning" : "text-muted-foreground")}>{outcome.text}</span> : null}
        </div>
        {pausing ? (
          <form className="flex items-end gap-1.5" onSubmit={(event) => { event.preventDefault(); void pauseOrResume(); }}>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className={fieldLabel}>Reason (recorded on the audit evidence)</span>
              <Input value={reason} autoFocus disabled={pending !== null} autoComplete="off" onChange={(event) => setReason(event.target.value)} className="h-7 text-[0.74rem]" />
            </label>
            <Button type="submit" size="xs" disabled={Boolean(blocked) || pending !== null}>{pending === "pause" ? <Spinner data-icon="inline-start" /> : null}{source.paused ? "Resume" : "Pause"}</Button>
          </form>
        ) : null}
        <CallErrorNote error={error} />
      </NodeCard>
    </li>
  );
}
