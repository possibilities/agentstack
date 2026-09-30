"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { localOperation, stateOperations } from "@/lib/stack/state";
import type { StateReceipt } from "@/lib/stack/types";
import { StateFlowView, useStateFlow } from "./state-flow";
import { useStack, useStore } from "./provider";

const notes = {
  run_output: "Clears this run's stdout and stderr. The command summary, authority, timing and exit state stay, and output cursors show the gap. Stopping a run or removing its schedule are separate.",
  execution_content: "Clears the captured action, result and error of this execution. Its authority, timing and outcome, including unknown, stay. The schedule definition is unchanged.",
} as const;

/** One exact terminal Proc record's payload clear, opened on request. Brain source schedules stay Brain-controlled. */
export function ProcClear({ kind, id, onReceipt }: { kind: "run_output" | "execution_content"; id: string; onReceipt?(receipt: StateReceipt): void }) {
  const state = useStack();
  const store = useStore();
  const [open, setOpen] = useState(false);
  const controls = useStateFlow({ operations: stateOperations(store.call, "proc", { plan: "proc_history_plan", apply: "proc_history_clear", receipt: "proc_state_receipt_get" }, { kind, ids: [id] }),
    recoveryKey: `proc:${kind}:${id}`, onReceipt });
  const access = localOperation(state, "proc", "proc_history_plan");
  if (state.remote || !access.available) return null;
  if (!open && controls.flow.phase === "idle") {
    return <Button size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => setOpen(true)}>{kind === "run_output" ? "Clear output…" : "Clear captured content…"}</Button>;
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2">
      <p className="text-[0.68rem] text-pretty text-muted-foreground">{notes[kind]}</p>
      <StateFlowView controls={controls} label="Prepare clear" applyLabel={kind === "run_output" ? "Clear this output" : "Clear this content"}
        unavailable={state.status.proc !== "open" ? "The proc connection is not open." : null} />
      {controls.flow.phase === "idle" ? <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(false)}>Cancel</Button> : null}
    </div>
  );
}
