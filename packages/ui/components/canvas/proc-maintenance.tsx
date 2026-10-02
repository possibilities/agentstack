"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { StateReceipt } from "@/lib/stack/types";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";
import { useStack, useStore } from "./provider";

type Kind = "run_output" | "execution_content" | "schedule_definition";

const notes: Record<Kind, string> = {
  run_output: "Clears this run's stdout and stderr. The command summary, authority, timing and exit state stay, and output cursors show the gap. Stopping a run or removing its schedule are separate.",
  execution_content: "Clears the captured action, result and error of this execution. Its authority, timing and outcome, including unknown, stay. The schedule definition is unchanged.",
  schedule_definition: "Redacts this removed schedule's stored definition: the action input, or the process arguments, environment and working directory. Its ID, label, authority, target, timing and a digest of the original definition stay. "
    + "Executions it already admitted keep their own captured content; clear each from its execution. Active and Brain-protected schedules refuse.",
};

const operations = ["proc_history_plan", "proc_history_clear", "proc_state_receipt_get"] as const;

/**
 * One exact Proc record's content flow. The slot is per kind and record: a clear selects only that record, so there is
 * nothing to freeze, and a retained running, partial or unknown receipt returns after a reload.
 */
function useProcClear(kind: Kind, id: string, onReceipt?: (receipt: StateReceipt) => void) {
  const state = useStack();
  const store = useStore();
  const controls = useStateFlow({ operations: stateOperations(store.call, "proc", { plan: "proc_history_plan", apply: "proc_history_clear", receipt: "proc_state_receipt_get" }, { kind, ids: [id] }),
    recoveryKey: `proc:${kind}:${id}`, observe: state.procScheduleGeneration, onReceipt });
  // A plan, its apply and its receipt are three WebSocket selections; the control needs all of them.
  const access = localOperations(state, "proc", operations);
  const unavailable = state.remote ? null : !access.available ? access.reason : state.status.proc !== "open" ? "The proc connection is not open." : null;
  return { controls, hidden: Boolean(state.remote) || !access.available, unavailable };
}

/** One exact terminal Proc record's payload clear, opened on request. Brain source schedules stay Brain-controlled. */
export function ProcClear({ kind, id, onReceipt }: { kind: "run_output" | "execution_content"; id: string; onReceipt?(receipt: StateReceipt): void }) {
  const [open, setOpen] = useState(false);
  const { controls, hidden, unavailable } = useProcClear(kind, id, onReceipt);
  if (hidden) return null;
  if (!open && controls.flow.phase === "idle") {
    return <Button size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => setOpen(true)}>{kind === "run_output" ? "Clear output…" : "Clear captured content…"}</Button>;
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2">
      <p className="text-[0.68rem] text-pretty text-muted-foreground">{notes[kind]}</p>
      <StateFlowView controls={controls} label="Prepare clear" applyLabel={kind === "run_output" ? "Clear this output" : "Clear this content"} unavailable={unavailable} />
      {controls.flow.phase === "idle" ? <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(false)}>Cancel</Button> : null}
    </div>
  );
}

/**
 * Redact one removed schedule's stored definition, at the end of that schedule's detail. Only a removed schedule is
 * offered: removal stops future runs first, and redaction is a separate decision. The owner refuses an active or
 * Brain-protected schedule, and the shared plan review shows why.
 */
export function ProcScheduleRedaction({ id, onReceipt }: { id: string; onReceipt?(receipt: StateReceipt): void }) {
  const { controls, hidden, unavailable } = useProcClear("schedule_definition", id, onReceipt);
  if (hidden) return null;
  return (
    <MaintenanceDisclosure active={controls.flow.phase !== "idle"} aside="redact definition">
      <p className="text-[0.68rem] text-pretty text-muted-foreground">{notes.schedule_definition}</p>
      <StateFlowView controls={controls} label="Prepare redaction" applyLabel="Redact this definition" unavailable={unavailable} />
    </MaintenanceDisclosure>
  );
}
