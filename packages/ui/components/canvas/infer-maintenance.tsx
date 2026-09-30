"use client";

import { localOperation, stateOperations } from "@/lib/stack/state";
import { useStateFlow, type StateFlowControls } from "./state-flow";
import { useStack, useStore } from "./provider";

/** The most exact terminal request IDs one Infer payload plan accepts. */
export const inferPlanLimit = 100;

/**
 * An Infer payload-clearing flow for an explicit selection of request IDs. Every surface (Lab, Signal's correlated
 * requests) has its own recovery slot, and nothing else is cleared or re-run: request identity, usage, model and
 * outcome stay, and unknown results stay unknown.
 */
export function useInferClear(requestIds: string[], surface: "lab" | "signal"): { controls: StateFlowControls; unavailable: string | null } {
  const state = useStack();
  const store = useStore();
  const controls = useStateFlow({
    operations: stateOperations(store.call, "infer", { plan: "infer_history_plan", apply: "infer_history_clear", receipt: "infer_state_receipt_get" }, { requestIds }),
    recoveryKey: `infer:${surface}`,
  });
  const access = localOperation(state, "infer", "infer_history_plan");
  const unavailable = !access.available ? access.reason : state.status.infer !== "open" ? "The infer connection is not open."
    : !requestIds.length ? "Select terminal requests to clear first." : requestIds.length > inferPlanLimit ? `Select at most ${inferPlanLimit} requests.` : null;
  return { controls, unavailable };
}

export const inferClearNote = "Clears prompts, instructions, output, errors and trace events. Request identity, account, model, usage, timing and outcome stay, so a retry cannot run or charge again. Signal and other copies are separate.";
