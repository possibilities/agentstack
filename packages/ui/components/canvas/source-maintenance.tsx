"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { GithubDelivery } from "@/lib/stack/types";
import { useStack, useStore } from "./provider";
import { sourceHint } from "./source-shared";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";

export const maxPayloadClears = 100;
const operations = { plan: "github_history_plan", apply: "github_history_clear", receipt: "github_state_receipt_get" };

const hash = (text: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { value ^= text.charCodeAt(index); value = Math.imul(value, 0x01000193) >>> 0; }
  return value.toString(16);
};

/**
 * Clear the original payloads of exact deliveries through the shared plan/review/apply/receipt flow. Local only: the
 * remote UI never shows it. Summaries, digests, duplicate fences, watch matches and acknowledgements remain.
 */
export function ClearPayloads({ chosen, retained, onSelectRetained, onClearSelection, onOpenChange, onLockChange }: {
  /** The exact chosen sequences, ascending. */
  chosen: number[];
  /** Loaded deliveries whose original payload is still retained. */
  retained: GithubDelivery[];
  onSelectRetained(): void;
  onClearSelection(): void;
  onOpenChange(open: boolean): void;
  onLockChange(locked: boolean): void;
}) {
  const state = useStack();
  if (!localOperations(state, "source", Object.values(operations)).available) return null;
  return <Flow chosen={chosen} retained={retained} onSelectRetained={onSelectRetained} onClearSelection={onClearSelection} onOpenChange={onOpenChange} onLockChange={onLockChange} />;
}

function Flow({ chosen, retained, onSelectRetained, onClearSelection, onOpenChange, onLockChange }: Parameters<typeof ClearPayloads>[0]) {
  const state = useStack();
  const store = useStore();
  const controls = useStateFlow({
    operations: stateOperations(store.call, "source", operations, { sequences: chosen }),
    recoveryKey: `source:history:${hash(chosen.join(","))}`, observe: state.sourceGeneration,
    onReceipt: (receipt) => { if (receipt.status !== "running") store.refreshSourceDeliveries(); },
  });
  const locked = controls.flow.phase !== "idle";
  useEffect(() => { onLockChange(locked); return () => onLockChange(false); }, [locked, onLockChange]);
  const unavailable = state.status.source !== "open" ? "The Source connection is not open."
    : !chosen.length ? "Choose between 1 and 100 deliveries whose original payload is retained."
    : chosen.length > maxPayloadClears ? `A plan covers at most ${maxPayloadClears} deliveries; ${chosen.length} are chosen.` : null;
  return (
    <MaintenanceDisclosure active={locked} aside="Clear original payloads" onOpenChange={onOpenChange} title="Maintenance">
      <p className={sourceHint}>Clear the original signed request body of exact deliveries to free retained-payload space. Their summaries, digests, duplicate fences, watch matches and acknowledgements stay; nothing is deleted from the ledger and no watch entry is acknowledged.</p>
      <p className={sourceHint}>This is logical removal, not secure erasure, and a cleared body is not restored by GitHub redelivering it. It does not retrieve deliveries GitHub could not make while storage was full.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span role="status" className="text-[0.74rem] font-medium tabular-nums">{chosen.length} chosen<span className="font-normal text-muted-foreground"> of {maxPayloadClears} at most</span></span>
        <Button size="xs" variant="outline" disabled={locked || !retained.length} onClick={onSelectRetained}>Choose loaded retained ({Math.min(retained.length, maxPayloadClears)})</Button>
        <Button size="xs" variant="ghost" disabled={locked || !chosen.length} onClick={onClearSelection}>Clear choice</Button>
      </div>
      <StateFlowView controls={controls} label="Prepare clearing original payloads" applyLabel="Clear original payloads" unavailable={unavailable} />
    </MaintenanceDisclosure>
  );
}
