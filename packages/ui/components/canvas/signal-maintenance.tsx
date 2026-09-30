"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { localOperation, stateOperations } from "@/lib/stack/state";
import { inferClearNote, inferPlanLimit, useInferClear } from "./infer-maintenance";
import { StateFlowView, useStateFlow } from "./state-flow";
import { useStack, useStore } from "./provider";
import { Section } from "./window";

const hint = "text-[0.68rem] text-pretty text-muted-foreground";

/**
 * Clearing everything Signal captured, as one owner scope: source reads and inference contexts span conversations,
 * so there is no per-conversation selection. Correlated Infer payloads are a separate, explicit Infer selection.
 * Local operator only.
 */
export function SignalContentSection() {
  const state = useStack();
  const store = useStore();
  const { signalStatus, signalGeneration, status, remote } = state;
  const data = signalStatus.data;
  const controls = useStateFlow({
    operations: stateOperations(store.call, "signal", { plan: "attention_history_plan", apply: "attention_history_clear", receipt: "signal_state_receipt_get" }, { scope: "all-captured-content" }),
    recoveryKey: "signal:history", observe: signalGeneration,
  });
  if (remote || !data) return null;
  const access = localOperation(state, "signal", "attention_history_plan");
  const unavailable = !access.available ? access.reason : status.signal !== "open" ? "The signal connection is not open."
    : data.enabled ? "Pause interpretation first. The plan also waits for source reads and inference already running to finish." : null;
  return (
    <Section title="Captured content">
      <div className="flex flex-col gap-2">
        <p className={hint}>
          Clears every captured message, the context copies taken from other conversations, annotations, feedback, source-read blobs and partial buffers, all at once.
          Message revisions stay suppressed, source cursors and admission receipts stay, and the Infer requests that interpreted them keep their own payloads until cleared below.
          Resuming can capture new source evidence.
        </p>
        <p className={hint}>Content generation {data.contentGeneration}. Open views re-read when it advances.</p>
        <StateFlowView controls={controls} label="Prepare captured-content clear" applyLabel="Clear captured content" unavailable={unavailable} />
        <CorrelatedInfer />
      </div>
    </Section>
  );
}

/** Retained Infer request IDs Signal correlated with its runs; selecting some prepares an Infer plan, nothing more. */
function CorrelatedInfer() {
  const state = useStack();
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<{ ids: string[]; nextOffset: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const clear = useInferClear(selected, "signal");
  const locked = clear.controls.flow.phase !== "idle";
  const access = localOperation(state, "signal", "attention_infer_requests");
  const load = (offset: number) => {
    setLoading(true);
    setError(null);
    store.call<{ requestIds: string[]; nextOffset: number | null }>("signal", "attention_infer_requests", { offset, limit: 100 })
      .then((next) => setPage((held) => ({ ids: offset && held ? [...held.ids, ...next.requestIds] : next.requestIds, nextOffset: next.nextOffset })),
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (open) load(0); }, [open, state.signalGeneration]);
  if (!open) return <Button size="xs" variant="ghost" className="self-start text-muted-foreground" disabled={!access.available} onClick={() => setOpen(true)}>Correlated Infer requests…</Button>;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2">
      <span className="flex items-center gap-2 text-[0.72rem] font-medium">Correlated Infer requests {loading ? <Spinner /> : null}
        <Button size="xs" variant="ghost" className="ml-auto" disabled={locked} onClick={() => { setOpen(false); setSelected([]); }}>Close</Button></span>
      <p className={hint}>{inferClearNote}</p>
      {error ? <p className="text-[0.72rem] text-destructive">{error}</p> : null}
      {page ? page.ids.length ? (
        <ul aria-label="Correlated Infer requests" className="flex max-h-48 flex-col overflow-auto">
          {page.ids.map((id) => (
            <li key={id}>
              <label className="flex items-center gap-1.5 font-mono text-[0.66rem]">
                <input type="checkbox" className="size-3.5 accent-destructive" checked={selected.includes(id)}
                  disabled={locked || (!selected.includes(id) && selected.length >= inferPlanLimit)}
                  onChange={() => setSelected(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id])} />{id}
              </label>
            </li>
          ))}
        </ul>
      ) : <p className={hint}>No correlated Infer requests are retained.</p> : null}
      {page?.nextOffset != null ? <Button size="xs" variant="ghost" className="self-start" disabled={loading} onClick={() => load(page.nextOffset!)}>Load more</Button> : null}
      <StateFlowView controls={clear.controls} label={`Prepare clearing ${selected.length} Infer request${selected.length === 1 ? "" : "s"}`} applyLabel="Clear these payloads" unavailable={clear.unavailable} />
    </div>
  );
}
