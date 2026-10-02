"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { catalogClearInput, type CatalogScope } from "@/lib/stack/derive";
import { localOperation, stateOperations } from "@/lib/stack/state";
import { errorMessage } from "./auth-actions";
import { Choice, MaintenanceDisclosure, useStateFlow, type StateFlowControls } from "./state-flow";
import { useStack, useStore } from "./provider";

/** The most exact terminal request IDs one Infer payload plan accepts. */
export const inferPlanLimit = 100;

/**
 * An Infer payload-clearing flow for an explicit selection of request IDs. Every surface (Lab, Signal's correlated
 * requests) has its own recovery slot, and nothing else is cleared or re-run: request identity, usage, model and
 * outcome stay, and unknown results stay unknown.
 */
export function useInferClear(requestIds: string[], surface: "lab" | "signal", onCompleted?: () => void): { controls: StateFlowControls; unavailable: string | null } {
  const state = useStack();
  const store = useStore();
  const controls = useStateFlow({
    operations: stateOperations(store.call, "infer", { plan: "infer_history_plan", apply: "infer_history_clear", receipt: "infer_state_receipt_get" }, { requestIds }),
    recoveryKey: `infer:${surface}`,
    onReceipt: (receipt) => { if (receipt.status === "completed") onCompleted?.(); },
  });
  const access = localOperation(state, "infer", "infer_history_plan");
  const unavailable = !access.available ? access.reason : state.status.infer !== "open" ? "The infer connection is not open."
    : !requestIds.length ? "Select terminal requests to clear first." : requestIds.length > inferPlanLimit ? `Select at most ${inferPlanLimit} requests.` : null;
  return { controls, unavailable };
}

export const inferClearNote = "Clears prompts, instructions, output, errors and trace events. Request identity, account, model, usage, timing and outcome stay, so a retry cannot run or charge again. Signal and other copies are separate.";

/**
 * Evict the server's in-memory model observations. This is a direct action, not a plan: the catalog is derived state
 * with no receipt, and clearing never discovers, refreshes or dispatches anything. Two steps (choose a scope, then
 * confirm it in place) keep it deliberate. Discovery after a clear is a separate, explicit action in the Lab.
 */
export function CatalogClear({ accountId, accountLabel, cached, onCleared }: { accountId: string; accountLabel: string; cached: number; onCleared(): void }) {
  const state = useStack();
  const store = useStore();
  const [scope, setScope] = useState<CatalogScope | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ cleared: number } | { error: string } | null>(null);
  const access = localOperation(state, "infer", "infer_catalog_clear");
  if (state.remote || !access.available) return null;
  const unavailable = state.status.infer !== "open" ? "The infer connection is not open." : !scope ? "Choose which catalogs to clear." : null;
  const clear = () => {
    if (!scope) return;
    setPending(true);
    store.call<{ cleared: string[] }>("infer", "infer_catalog_clear", catalogClearInput(scope, accountId))
      .then((result) => { setOutcome({ cleared: result.cleared.length }); setConfirming(false); setScope(null); onCleared(); },
        (cause: unknown) => { setOutcome({ error: errorMessage(cause) }); setConfirming(false); })
      .finally(() => setPending(false));
  };
  return (
    <MaintenanceDisclosure aside="clear model catalog">
      <p className="text-[0.68rem] text-pretty text-muted-foreground">
        Evicts the model observations the server keeps in memory. Requests already dispatched, the request ledger, traces and credentials are untouched, and nothing is discovered again for you:
        refreshing a catalog is a separate action. No receipt is kept, because this is derived state.
      </p>
      <Choice<CatalogScope> label="Which catalogs" value={scope} disabled={confirming || pending} onChange={setScope} options={[
        ["account", accountId ? `This account (${accountLabel})` : "This account", accountId ? undefined : "Choose an account above first.", !accountId],
        ["all", "All accounts", `${cached} cached ${cached === 1 ? "catalog" : "catalogs"} seen here; the server also fences any discovery in flight.`],
      ]} />
      {confirming ? (
        <div role="group" aria-label="Confirm clearing the model catalog" className="flex flex-col gap-1.5 rounded-lg border border-destructive/40 p-2">
          <p className="text-xs text-pretty">Clear the model catalog for {scope === "all" ? "all accounts" : accountLabel}? Models stay unknown until you discover them again.</p>
          <div className="flex gap-1.5">
            <Button size="sm" variant="destructive" disabled={pending} onClick={clear}>{pending ? <Spinner data-icon="inline-start" /> : null}Clear catalog</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div><Button size="sm" variant="outline" disabled={!!unavailable} title={unavailable ?? undefined} onClick={() => { setOutcome(null); setConfirming(true); }}>Clear model catalog…</Button></div>
          {unavailable ? <p className="text-xs text-muted-foreground">{unavailable}</p> : null}
        </div>
      )}
      {outcome ? "error" in outcome
        ? <p role="alert" className="text-xs text-destructive">{outcome.error}</p>
        : <p role="status" className="text-xs text-pretty">
            Cleared model observations for {outcome.cleared} account{outcome.cleared === 1 ? "" : "s"}. Nothing was refreshed; discover models to read a catalog again.
            <button type="button" className="ml-1.5 text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setOutcome(null)}>Dismiss</button>
          </p>
        : null}
    </MaintenanceDisclosure>
  );
}
