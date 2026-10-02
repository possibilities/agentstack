"use client";

import { useEffect } from "react";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { BrainJob, BrainRun, BrainSource } from "@/lib/stack/types";
import { useKeyedRead } from "./owner-reads";
import { Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";

const hint = "text-xs text-pretty text-muted-foreground";
const operations = (kind: "jobs" | "runs" | "source") => ({ plan: `brain_${kind}_plan`, apply: `brain_${kind}_clear`, receipt: "brain_state_receipt_get" });

export function BrainJobMaintenance({ job }: { job: BrainJob }) {
  const state = useStack();
  if (!localOperations(state, "brain", Object.values(operations("jobs"))).available) return null;
  return <JobPayload job={job} />;
}

function JobPayload({ job }: { job: BrainJob }) {
  const state = useStack();
  const store = useStore();
  const controls = useStateFlow({ operations: stateOperations(store.call, "brain", operations("jobs"), { ids: [job.id], scope: "payload" }),
    recoveryKey: `brain:jobs_payload:${job.id}`, observe: state.brainJobs.at,
    onReceipt: (receipt) => { if (receipt.status !== "running") store.refreshBrainLedger(); } });
  const unavailable = state.status.brain !== "open" ? "The Brain connection is not open." : !job.id ? "Choose an exact job."
    : job.content_cleared_at ? "Captured payload is already cleared; Retry and Reveal are unavailable." : null;
  return <MaintenanceDisclosure active={controls.flow.phase !== "idle"} aside="Captured payload">
    <p className={hint}>Clear only this terminal orphan job’s captured intent and attempt diagnostics. Active claims, indexed documents and immutable operator Runs block via the owner plan; nothing here cancels or drains work.</p>
    <p className={hint}>Admission IDs/digests, lifecycle and unknown outcomes stay. Artifact bytes, independent copies, device outboxes and backups remain; logical clearing is not media erasure. A cleared job cannot reopen.</p>
    <StateFlowView controls={controls} label="Prepare clearing captured payload" applyLabel="Clear captured payload" unavailable={unavailable} />
  </MaintenanceDisclosure>;
}

export function BrainRunMaintenance({ id, onLockChange }: { id: number; onLockChange(locked: boolean): void }) {
  const state = useStack();
  if (!localOperations(state, "brain", ["jobs_run", ...Object.values(operations("runs"))]).available) return null;
  return <RunPayload key={id} id={id} onLockChange={onLockChange} />;
}

function RunPayload({ id, onLockChange }: { id: number; onLockChange(locked: boolean): void }) {
  const state = useStack();
  const store = useStore();
  const run = useKeyedRead(() => store.call<BrainRun>("brain", "jobs_run", { "run-id": id }), `brain:run:${id}`, state.brainJobs.at ?? 0);
  const controls = useStateFlow({ operations: stateOperations(store.call, "brain", operations("runs"), { ids: [id], scope: "payload" }),
    recoveryKey: `brain:runs_payload:${id}`, observe: state.brainJobs.at,
    onReceipt: (receipt) => { if (receipt.status !== "running") { run.refresh(); store.refreshBrainLedger(); store.refreshBrainSources(); } } });
  const locked = controls.flow.phase !== "idle";
  useEffect(() => { onLockChange(locked); return () => onLockChange(false); }, [locked, onLockChange]);
  const unavailable = state.status.brain !== "open" ? "The Brain connection is not open." : !id ? "Choose an exact Run."
    : run.error || !run.data ? "Read the exact Run before preparing." : run.data.content_cleared_at ? "Run payloads are already cleared." : null;
  return <MaintenanceDisclosure active={locked} aside={`Run ${id} payloads`}>
    <p className={hint}>Clear Run {id}’s captured payloads and its captured jobs, not only the visible filtered rows. Terminal/drained state is required; claims and indexed documents block via the plan. Nothing here cancels, retries or dispatches work.</p>
    {run.error ? <p role="alert" className="text-xs text-destructive">Run unavailable: {run.error}</p> : null}
    {run.data ? <p className={hint}>{run.data.run_type} · {run.data.state} · {run.data.counts.jobs} jobs · {run.data.counts.attempts} attempts
      {run.data.operator_controlled ? ` · operator controlled (${run.data.execution_mode ?? "mode unset"})` : ""}</p> : null}
    {run.data?.content_cleared_at ? <p className={hint}>Payloads cleared <Time at={Date.parse(run.data.content_cleared_at)} /></p> : null}
    {run.data?.payload_digest ? <p className={hint}>Retained payload digest <code className="break-all">{run.data.payload_digest}</code></p> : null}
    <p className={hint}>Immutable recovery authorization, generation/snapshot authority, admission digests, lifecycle and outcomes stay. Independent Artifact/backup copies remain. Clearing does not spend or complete ingestion.</p>
    <StateFlowView controls={controls} label="Prepare clearing Run payloads" applyLabel="Clear Run payloads" unavailable={unavailable} />
  </MaintenanceDisclosure>;
}

export function BrainSourceMaintenance({ source }: { source: BrainSource }) {
  const state = useStack();
  if (!localOperations(state, "brain", Object.values(operations("source"))).available) return null;
  return <div className="flex flex-col gap-1">
    <SourceFlow source={source} action="remove" />
    <SourceFlow source={source} action="checkpoint_reset" />
  </div>;
}

function SourceFlow({ source, action }: { source: BrainSource; action: "remove" | "checkpoint_reset" }) {
  const state = useStack();
  const store = useStore();
  const title = action === "remove" ? "Remove source" : "Reset checkpoint";
  const controls = useStateFlow({ operations: stateOperations(store.call, "brain", operations("source"), { id: source.id, action }),
    recoveryKey: `brain:source_${action}:${source.id}`, observe: state.brainSources.at,
    onReceipt: (receipt) => { if (receipt.status !== "running") store.refreshBrainSources(); } });
  const unavailable = state.status.brain !== "open" ? "The Brain connection is not open." : !source.id ? "Choose an exact source."
    : source.removed_at ? "This source identity is permanently retired." : !source.paused ? "Pause the source separately before maintenance." : null;
  return <MaintenanceDisclosure active={controls.flow.phase !== "idle"} aside={title}>
    <p className={hint}>One exact paused/drained source. The owner plan checks active Runs/claims and the protected Proc schedule; maintenance never pauses or drains implicitly.</p>
    <p className={hint}>{action === "remove" ? "Retires this source identity permanently; it cannot resume, sync or accept manifest updates."
      : "Resets only the current checkpoint and advances checkpoint generation. The source stays paused and admits nothing. Explicit later resume/sync can re-read, re-admit and spend on extraction/inference; existing digest dedupe still applies."}</p>
    <p className={hint}>Prior definitions/checkpoint history, documents and admitted child jobs stay. The protected Proc schedule stays Brain-controlled; independent copies and backups remain.</p>
    <StateFlowView controls={controls} label={`Prepare ${title.toLowerCase()}`} applyLabel={title} unavailable={unavailable} />
  </MaintenanceDisclosure>;
}
