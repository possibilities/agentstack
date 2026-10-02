"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HistoryIcon, RssIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { completionDelivery, completionDiagnostic, completionReceiptLabels, completionUncertainty, completionWatch, noBotWatch, receiptQuery } from "@/lib/stack/completion";
import { relativeTime } from "@/lib/stack/derive";
import { localOperation, type LocalAccess } from "@/lib/stack/state";
import type { ServeCompletionPage, ServeCompletionReceipt } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { CopyButton, Empty, NodeLink, StatusDot } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";
import { receiptTone } from "./subscription-views";

const hintClass = "text-[0.72rem] text-pretty text-muted-foreground";
const labelClass = "text-[0.66rem] font-medium tracking-[0.06em] text-muted-foreground uppercase";

export type ObservedRead<T> = { data: T | null; error: string | null; loading: boolean; reload(): void };

/**
 * One-shot reads that re-read when the key, the caller's `observe` signature or the shared
 * completion generation change. Stale answers and answers for an earlier key are dropped.
 */
export function useObservedRead<T>(key: string | null, observe: unknown, read: () => Promise<T>): ObservedRead<T> {
  const state = useStack();
  const store = useStore();
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{ key: string | null; data: T | null; error: string | null; pending: boolean }>({ key, data: null, error: null, pending: key !== null });
  const seq = useRef(0);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (!key) { setResult({ key, data: null, error: null, pending: false }); return; }
    const mine = ++seq.current;
    let cancelled = false;
    setResult((current) => current.key === key ? { ...current, error: null, pending: true } : { key, data: null, error: null, pending: true });
    readRef.current().then(
      (data) => { if (!cancelled && seq.current === mine) setResult({ key, data, error: null, pending: false }); },
      (error) => { if (!cancelled && seq.current === mine) setResult((current) => ({ key, data: current.key === key ? current.data : null, error: errorMessage(error), pending: false })); });
    return () => { cancelled = true; };
  }, [key, observe, nonce, state.completionGeneration, store]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const current = result.key === key ? result : { key, data: null, error: null, pending: key !== null };
  return { data: current.data, error: current.error, loading: current.pending && current.data === null && current.error === null, reload };
}

export type WatchReceipts = {
  receipts: ServeCompletionReceipt[];
  total: number;
  truncated: boolean;
  error: string | null;
  loading: boolean;
  access: LocalAccess;
  reload(): void;
};

/**
 * `serve_completion_list` for one exact record: one read while mounted (the caller mounts only on
 * open/expand), re-read when `observe` or the shared `completionGeneration` changes. Stale answers
 * are dropped; an error is unavailable, never an empty watch list.
 */
export function useWatchReceipts(query: Record<string, unknown> | null, observe: unknown): WatchReceipts {
  const state = useStack();
  const store = useStore();
  const access = localOperation(state, "serve", "serve_completion_list");
  const key = !state.remote && access.available && state.status.serve === "open" && query ? JSON.stringify(query) : null;
  const read = useObservedRead<ServeCompletionPage>(key, observe, () => store.call<ServeCompletionPage>("serve", "serve_completion_list", JSON.parse(key!)));
  return {
    receipts: read.data?.completions ?? [], total: read.data?.total ?? 0, truncated: read.data?.truncated ?? false,
    error: read.error, loading: read.loading, access, reload: read.reload,
  };
}

/** One retained receipt compactly: its state, delivery facts, origin and a link into History. */
export function ReceiptSummary({ receipt, pkg }: { receipt: ServeCompletionReceipt; pkg: string }) {
  const state = useStack();
  const store = useStore();
  const { goTo } = useWorkbench();
  const now = useNow(30_000);
  const stateLabel = completionReceiptLabels[receipt.state];
  const watch = completionWatch(receipt);
  const uncertainty = completionUncertainty(receipt);
  const diagnostic = completionDiagnostic(receipt);
  const delivery = completionDelivery(receipt);
  const knownBot = state.bots.data?.some((bot) => bot.id === receipt.botId);
  const history = () => {
    void store.showCompletionHistory({ botId: receipt.botId, package: pkg });
    goTo({ kind: "subscription", id: receipt.id });
  };
  return (
    <div data-receipt={receipt.id} className="flex flex-col gap-1 rounded-lg border border-dashed px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <StatusDot tone={receiptTone[receipt.state]} label={stateLabel.label} />
        <span className="shrink-0 font-medium" title={stateLabel.description}>{stateLabel.label}</span>
        <span className="min-w-0 truncate text-muted-foreground">{receipt.operation}</span>
        <span className="ml-auto shrink-0 text-muted-foreground" title={watch.description}>{watch.label}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-xs text-muted-foreground">
        <span>{knownBot ? <NodeLink node={{ kind: "bot", id: receipt.botId }} label={`Bot ${receipt.botId}`}>{receipt.botId}</NodeLink> : receipt.botId}</span>
        <span className="inline-flex min-w-0 items-center gap-0.5 font-mono text-[0.68rem] break-all" title={`Thread ${receipt.threadId}`}>
          thread {receipt.threadId}<CopyButton value={receipt.threadId} label="thread ID" className="size-5 opacity-100" />
        </span>
      </div>
      <p className="pl-3.5 text-xs text-muted-foreground">
        {delivery.map((part) => part.at === null ? part.text : `${part.text} ${relativeTime(part.at, now)}`).join(" · ")}
      </p>
      {uncertainty ? <p role="note" className="pl-3.5 text-[0.72rem] text-pretty text-warning">{uncertainty}</p> : null}
      {diagnostic ? <p className="pl-3.5 text-[0.72rem] text-pretty text-muted-foreground">{diagnostic}</p> : null}
      <div className="flex items-center gap-1 pl-2.5">
        <Button size="xs" variant="ghost" onClick={history}><HistoryIcon />Open in History</Button>
        <span className="ml-auto font-mono text-[0.64rem] text-muted-foreground" title={`Receipt ${receipt.id}`}>receipt {receipt.id.slice(0, 8)}</span>
      </div>
    </div>
  );
}

/**
 * One record's Bot watch: the retained receipt(s) for its exact request, then the domain's exact
 * observation under them. No receipt is "No Bot watch requested", never an offer to subscribe;
 * an unreadable history or a closed channel is unavailable, never empty. Remote pages render nothing.
 */
export function BotWatch({ pkg, recordId, origin, observe, children }: {
  pkg: "browse" | "worker" | "proc" | "brain";
  recordId: string;
  origin?: { botId?: string; threadId?: string };
  /** Re-read signature: the record's revision or state key. */
  observe: unknown;
  children?(receipts: ServeCompletionReceipt[]): React.ReactNode;
}) {
  const state = useStack();
  const watch = useWatchReceipts(recordId ? receiptQuery(pkg, recordId, origin) : null, observe);
  if (state.remote) return null;
  const access = watch.access;
  return (
    <section data-bot-watch={pkg} aria-label="Bot watch" className="flex flex-col gap-1.5">
      <h3 className={labelClass}>Bot watch</h3>
      {!access.available ? <p className={hintClass}>{access.reason}</p>
        : state.status.serve !== "open" ? <p className={hintClass}>Server reconnecting — Bot watch unavailable</p>
        : watch.error ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[0.72rem] text-destructive">Bot watch unavailable: {watch.error}</p>
            <Button size="xs" variant="ghost" onClick={watch.reload}>Read again</Button>
          </div>
        )
        : watch.loading ? <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3" />Reading watch receipts…</p>
        : watch.receipts.length === 0 ? <Empty icon={RssIcon} title="No Bot watch requested" hint={noBotWatch[pkg]} />
        : (
          <div className="flex flex-col gap-1.5">
            {watch.receipts.map((receipt) => <ReceiptSummary key={receipt.id} receipt={receipt} pkg={pkg} />)}
            {watch.truncated ? <p className={hintClass}>Showing {watch.receipts.length} of {watch.total} receipts for this exact record.</p> : null}
            {children?.(watch.receipts)}
          </div>
        )}
    </section>
  );
}
