"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { corpusSelection, queueMaintenanceActions, type ScrapeQueueAction } from "@/lib/stack/scrape";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { ScrapeCorpus, ScrapeQueueJob } from "@/lib/stack/types";
import { useKeyedRead } from "./owner-reads";
import { useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";

const hint = "text-xs text-pretty text-muted-foreground";
const queueOperations = { plan: "scrape_queue_plan", apply: "scrape_queue_apply", receipt: "scrape_state_receipt_get" };
const corpusOperations = { plan: "scrape_corpus_plan", apply: "scrape_corpus_clear", receipt: "scrape_state_receipt_get" };

export function ScrapeQueueMaintenance({ job }: { job: ScrapeQueueJob }) {
  const state = useStack();
  if (!localOperations(state, "scrape", Object.values(queueOperations)).available) return null;
  return <QueueFlows job={job} />;
}

function useQueueFlow(job: ScrapeQueueJob, action: ScrapeQueueAction) {
  const state = useStack();
  const store = useStore();
  return useStateFlow({ operations: stateOperations(store.call, "scrape", queueOperations, { ids: [job.id], action }),
    recoveryKey: `scrape:queue_${action}:${job.id}`, observe: state.scrapeQueue.at,
    onReceipt: (receipt) => { if (receipt.status !== "running") store.refreshScrapeQueue(); } });
}

function QueueFlows({ job }: { job: ScrapeQueueJob }) {
  const state = useStack();
  // Keep every action's recovery slot mounted even when a new fence changes eligibility.
  const cancel = useQueueFlow(job, "cancel");
  const retry = useQueueFlow(job, "retry");
  const discard = useQueueFlow(job, "discard");
  const flows = { cancel, retry, discard };
  const active = Object.values(flows).some((flow) => flow.flow.phase !== "idle");
  const eligible = queueMaintenanceActions(job);
  const unavailable = state.status.scrape !== "open" ? "The Scrape connection is not open." : !/^[a-f0-9]{64}$/.test(job.id) ? "Choose an exact queue generation." : null;
  return <MaintenanceDisclosure active={active} aside="Queue generation">
    <p className={hint}>Only this exact queue generation’s owned files. Claims (PID/token), unresolved publication and changed files block via the plan; no live, dead or uncertain claim is broken. External destination files, Brain, other generations and backups remain.</p>
    <p className={hint}>Cancel is pending-only; retry creates a new pending generation for a failed job. Later processing may extract, spend and publish to the retained destination — a retry receipt is not extraction completion. Discard clears failed or receipt-retired remaining files; neither action recalls earlier extraction.</p>
    <code className="break-all text-xs">Generation {job.id}</code>
    {!eligible.length && !active ? <p className={hint}>Retrying generations are not eligible for maintenance; wait for their authoritative state.</p> : null}
    {(["cancel", "retry", "discard"] as const).map((action) => {
      const controls = flows[action];
      if (!eligible.includes(action) && controls.flow.phase === "idle") return null;
      const title = action === "cancel" ? "Cancel pending generation" : action === "retry" ? "Retry failed generation" : "Discard remaining queue files";
      const reason = unavailable ?? (!eligible.includes(action) ? "This generation is no longer eligible; inspect the retained receipt."
        : Object.entries(flows).some(([name, value]) => name !== action && value.flow.phase !== "idle"
          && !(action === "discard" && value.flow.phase === "receipt" && ["unknown", "partial", "completed", "blocked"].includes(value.flow.receipt.status)))
          ? "Finish inspecting the other maintenance flow first." : null);
      return <StateFlowView key={action} controls={controls} label={`Prepare ${title.toLowerCase()}`} applyLabel={title} unavailable={reason} receiptOnlyRecovery />;
    })}
  </MaintenanceDisclosure>;
}

export function ScrapeCorpusMaintenance({ preset, onLockChange }: { preset: string; onLockChange(locked: boolean): void }) {
  const state = useStack();
  if (!preset || !localOperations(state, "scrape", ["scrape_corpus_list", ...Object.values(corpusOperations)]).available) return null;
  return <CorpusFlow key={preset} preset={preset} onLockChange={onLockChange} />;
}

function CorpusFlow({ preset, onLockChange }: { preset: string; onLockChange(locked: boolean): void }) {
  const state = useStack();
  const store = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const read = useKeyedRead(() => store.call<ScrapeCorpus>("scrape", "scrape_corpus_list", { preset }), `scrape:corpus:${preset}`, state.scrapeQueue.at ?? 0);
  const rows = read.data?.captures ?? [];
  const selection = corpusSelection(rows, preset, selected);
  const controls = useStateFlow({ operations: stateOperations(store.call, "scrape", corpusOperations, { captures: selection ?? [] }),
    recoveryKey: `scrape:corpus_clear:${preset}`, observe: read.data?.revision,
    onReceipt: (receipt) => { if (receipt.status !== "running") read.refresh(); if (receipt.status === "completed") setSelected([]); } });
  const locked = controls.flow.phase !== "idle";
  useEffect(() => { onLockChange(locked); return () => onLockChange(false); }, [locked, onLockChange]);
  const unavailable = state.status.scrape !== "open" ? "The Scrape connection is not open." : read.error || read.loading || !read.data ? "Refresh local captures before preparing."
    : !selection ? "Select up to 100 exact local captures; review changed selections." : null;
  return <MaintenanceDisclosure active={locked} aside={`Local captures · ${preset}`}>
    <p className={hint}>Clear only selected final local sample-NNN captures for {preset}. Shipped fixtures, presets, canary definitions, temporary publications, authenticated Browse sessions, external copies and backups are never targets. Clearing admits no extraction or capture.</p>
    <Button size="xs" variant="ghost" disabled={read.loading || locked || state.status.scrape !== "open"} onClick={read.refresh}>Refresh local captures</Button>
    {read.error ? <p role="alert" className="text-xs text-destructive">Local captures unavailable: {read.error}</p> : null}
    <ul aria-label={`Local captures for ${preset}`} className="flex max-h-56 flex-col gap-1 overflow-auto">
      {rows.map((row) => <li key={`${row.preset}:${row.id}`} className="text-xs">
        <label className="flex items-start gap-1.5"><input type="checkbox" aria-label={`Select capture ${row.id}`} checked={selected.includes(row.id)}
          disabled={locked || row.preset !== preset || !/^sample-[0-9]{3,10}$/.test(row.id) || (!selected.includes(row.id) && selected.length >= 100)}
          onChange={() => setSelected((held) => held.includes(row.id) ? held.filter((id) => id !== row.id) : [...held, row.id])} /><code className="break-all">{row.id}</code></label>
      </li>)}
    </ul>
    {!rows.length && !read.error ? <p className={hint}>{read.data ? "No final local captures for this preset." : "Reading local captures…"}</p> : null}
    <StateFlowView controls={controls} label={`Prepare clearing ${selected.length} local captures`} applyLabel="Clear these local captures" unavailable={unavailable} receiptOnlyRecovery />
  </MaintenanceDisclosure>;
}
