"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { listRecoveries, localOperations, readRecovery, stateOperations } from "@/lib/stack/state";
import type { GithubDelivery } from "@/lib/stack/types";
import { useDestination, useStack, useStore } from "./provider";
import { sourceHint, Stamp } from "./source-shared";
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

const historyPrefix = "source:history:";

/**
 * Saved clear requests left without a confirmed result, from any selection. Recovery is keyed by the exact choice, so
 * it must not depend on choosing the same deliveries again: every unconfirmed request is listed here until the person
 * reads its receipt and closes it.
 */
function usePendingClears(currentKey: string): { keys: string[]; close(key: string): void } {
  // Only this destination's saved requests are listed; with none yet, there is nothing to list.
  const { local } = useDestination();
  const [seen, setSeen] = useState<string[]>([]);
  const scan = useCallback(() => {
    const found = listRecoveries(local, historyPrefix).map((item) => item.key);
    setSeen((held) => { const next = [...new Set([...held, ...found])]; return next.length === held.length ? held : next; });
  }, [local]);
  // A selection that is no longer chosen leaves its saved request behind: look again whenever the chosen set changes.
  useEffect(() => { scan(); }, [scan, currentKey]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key.includes(historyPrefix)) scan(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [scan]);
  return { keys: seen.filter((key) => key !== currentKey), close: (key) => setSeen((held) => held.filter((item) => item !== key)) };
}

function Flow({ chosen, retained, onSelectRetained, onClearSelection, onOpenChange, onLockChange }: Parameters<typeof ClearPayloads>[0]) {
  const state = useStack();
  const store = useStore();
  const currentKey = `${historyPrefix}${hash(chosen.join(","))}`;
  const pending = usePendingClears(currentKey);
  const controls = useStateFlow({
    operations: stateOperations(store.call, "source", operations, { sequences: chosen }),
    recoveryKey: currentKey, observe: state.sourceGeneration,
    onReceipt: (receipt) => { if (receipt.status !== "running") store.refreshSourceDeliveries(); },
  });
  const locked = controls.flow.phase !== "idle";
  useEffect(() => { onLockChange(locked); return () => onLockChange(false); }, [locked, onLockChange]);
  const unavailable = state.status.source !== "open" ? "The Source connection is not open."
    : !chosen.length ? "Choose between 1 and 100 deliveries whose original payload is retained."
    : chosen.length > maxPayloadClears ? `A plan covers at most ${maxPayloadClears} deliveries; ${chosen.length} are chosen.` : null;
  return (
    <MaintenanceDisclosure active={locked || pending.keys.length > 0} aside={pending.keys.length ? `${pending.keys.length} unconfirmed` : "Clear original payloads"} onOpenChange={onOpenChange} title="Maintenance">
      {pending.keys.length ? (
        <section aria-label="Unconfirmed clear requests" className="flex flex-col gap-2">
          {state.status.source === "open"
            ? pending.keys.map((key) => <PendingClear key={key} recoveryKey={key} onClosed={() => pending.close(key)} />)
            : <p role="status" className={sourceHint}>{pending.keys.length} clear {pending.keys.length === 1 ? "request has" : "requests have"} no confirmed result. Their receipts are read when the Source connection is open.</p>}
        </section>
      ) : null}
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

/**
 * One saved request from a selection that is no longer chosen. Only its receipt is read: nothing here sends the request
 * again or prepares a plan, and forgetting it does not undo or cancel what the owner may have done.
 */
function PendingClear({ recoveryKey, onClosed }: { recoveryKey: string; onClosed(): void }) {
  const state = useStack();
  const store = useStore();
  const { local } = useDestination();
  const saved = readRecovery(local, recoveryKey);
  const controls = useStateFlow({
    operations: stateOperations(store.call, "source", operations, { sequences: [] }),
    recoveryKey, observe: state.sourceGeneration,
    onReceipt: (receipt) => { if (receipt.status !== "running") store.refreshSourceDeliveries(); },
  });
  const left = useRef(false);
  useEffect(() => {
    if (controls.flow.phase !== "idle") left.current = true;
    else if (left.current) onClosed();
  }, [controls.flow.phase, onClosed]);
  const forget = () => { controls.reset(); onClosed(); };
  return (
    <div role="group" aria-label={`Unconfirmed clear request ${saved?.input.requestId.slice(0, 8) ?? ""}`} className="flex flex-col gap-2 rounded-lg border border-warning/50 p-2.5">
      <p className="text-[0.74rem] font-medium">Unconfirmed clear request{saved ? <> from <Stamp at={saved.at} className="font-normal text-muted-foreground" /></> : null}</p>
      <p className={sourceHint}>An earlier choice has no confirmed result: the owner&rsquo;s receipt for this request ID is the only evidence of what it did. Reading it changes nothing; it is not sent again.</p>
      {controls.flow.phase !== "idle" ? <StateFlowView controls={controls} label="Read receipt" unavailable={null} receiptOnlyRecovery /> : <p className={sourceHint}>Reading the receipt…</p>}
      <div><Button size="xs" variant="ghost" onClick={forget}>Forget this request</Button></div>
    </div>
  );
}
