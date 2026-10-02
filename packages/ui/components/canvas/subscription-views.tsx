"use client";

import { useEffect, useRef, useState } from "react";
import { EyeIcon, EyeOffIcon, HistoryIcon, RssIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { completionDelivery, completionDiagnostic, completionLinkStatusLabels, completionReceiptLabels, completionTargets, completionUncertainty, completionWatch, occurrenceDeliveryLabel, occurrencePolicyLabel, type CompletionTarget } from "@/lib/stack/completion";
import { relativeTime, shortId } from "@/lib/stack/derive";
import { localOperation } from "@/lib/stack/state";
import type { ServeCompletionDetail, ServeCompletionReceipt, ServeOccurrenceDetail, ServeOccurrenceRow } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { CopyButton, Empty, NodeLink, StatusDot, type Tone } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { useShowWorker, useShowWorkerTurn } from "./worker-windows";

const hintClass = "text-[0.72rem] text-pretty text-muted-foreground";
const labelClass = "text-[0.66rem] font-medium tracking-[0.06em] text-muted-foreground uppercase";

/** One Bot choice shared by the Watches, Occurrences and History filters; changing it applies to all three. */
export function BotSubscriptionFilter({ botId, disabled }: { botId: string | undefined; disabled: boolean }) {
  const state = useStack();
  const store = useStore();
  const { bots } = state;
  const set = (next: string | undefined) => {
    void store.filterSubscriptions({ ...state.subscriptionFilter, botId: next });
    void store.filterCompletions({ ...state.completionFilter, botId: next });
    void store.filterOccurrences({ ...state.occurrenceFilter, botId: next });
  };
  return (
    <NativeSelect size="sm" aria-label="Bot" className="min-w-0 flex-1" value={botId ?? ""} disabled={disabled}
      onChange={(event) => set(event.target.value || undefined)}>
      <NativeSelectOption value="">All Bots</NativeSelectOption>
      {(bots.data ?? []).map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{bot.id}</NativeSelectOption>)}
    </NativeSelect>
  );
}

export function PackageSubscriptionFilter({ package: pkg, disabled, onChange }: { package: string | undefined; disabled: boolean; onChange(next: string | undefined): void }) {
  const { catalog } = useStack();
  return (
    <NativeSelect size="sm" aria-label="Package" className="min-w-0 flex-1" value={pkg ?? ""} disabled={disabled}
      onChange={(event) => onChange(event.target.value || undefined)}>
      <NativeSelectOption value="">All packages</NativeSelectOption>
      {(catalog.data ?? []).map((doc) => doc.name).sort().map((name) => <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>)}
    </NativeSelect>
  );
}

const receiptTone: Record<ServeCompletionReceipt["state"], Tone> = {
  pending: "info", error: "destructive", observed: "muted", delivered: "success", unknown: "warning", cancelled: "muted",
};

function CompletionTargetLink({ target }: { target: CompletionTarget }) {
  const showWorkerTurn = useShowWorkerTurn();
  if (target.kind === "node") return <NodeLink node={target.ref} label={target.label}>{target.label}</NodeLink>;
  if (target.kind === "worker-turn") {
    return (
      <button type="button" onClick={() => showWorkerTurn(target.workerId, target.turnId)} title="Open this exact turn in its Worker"
        className="rounded-sm decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        {target.label}
      </button>
    );
  }
  return <span>{target.label}</span>;
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-x-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function CompletionRow({ receipt, canInspect, unavailableReason }: { receipt: ServeCompletionReceipt; canInspect: boolean; unavailableReason: string | null }) {
  const store = useStore();
  const { bots } = useStack();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ data: ServeCompletionDetail | null; error: string | null } | null>(null);
  const [reading, setReading] = useState(false);
  const readDetail = () => {
    setReading(true);
    store.call<ServeCompletionDetail>("serve", "serve_completion_get", { id: receipt.id })
      .then((data) => setDetail({ data, error: null }), (error) => setDetail({ data: null, error: errorMessage(error) }))
      .finally(() => setReading(false));
  };
  const signature = `${receipt.state}:${receipt.lastDeliveredAt}:${receipt.lastDeliveryKind}:${receipt.subscriptionPresent}`;
  // An expanded detail belongs to the receipt state it was read under; a changed row re-reads it.
  useEffect(() => { if (open) readDetail(); }, [open, receipt.id, signature, store]);
  const knownBot = bots.data?.some((bot) => bot.id === receipt.botId);
  const stateLabel = completionReceiptLabels[receipt.state];
  const watch = completionWatch(receipt);
  const uncertainty = completionUncertainty(receipt);
  const diagnostic = completionDiagnostic(receipt);
  const delivery = completionDelivery(receipt);
  const link = detail?.data?.linkStatus === "resolved" ? detail.data.link : null;
  return (
    <div data-receipt={receipt.id} className="flex flex-col gap-1.5 rounded-lg px-2 py-1.5 hover:bg-muted/70">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <StatusDot tone={receiptTone[receipt.state]} label={stateLabel.label} />
        <span className="shrink-0 font-medium" title={stateLabel.description}>{stateLabel.label}</span>
        <span className="min-w-0 truncate text-muted-foreground">{receipt.pkg} · {receipt.operation}</span>
        <span className="ml-auto shrink-0 text-muted-foreground" title={watch.description}>{watch.label}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-xs text-muted-foreground">
        <span>{knownBot ? <NodeLink node={{ kind: "bot", id: receipt.botId }} label={`Bot ${receipt.botId}`}>{receipt.botId}</NodeLink> : receipt.botId}</span>
        <span className="font-mono text-[0.68rem]" title={`Thread ${receipt.threadId}`}>thread {receipt.threadId.slice(0, 12)}</span>
        <span className="inline-flex items-center gap-0.5 font-mono text-[0.68rem]" title={`Correlation ${receipt.recordId}`}>
          correlation {shortId(receipt.recordId)}<CopyButton value={receipt.recordId} label="correlation ID" className="size-5" />
        </span>
      </div>
      <p className="pl-3.5 text-xs text-muted-foreground">
        {delivery.map((part) => part.at === null ? part.text : `${part.text} ${relativeTime(part.at, now)}`).join(" · ")}
      </p>
      {uncertainty ? <p role="note" className="pl-3.5 text-[0.72rem] text-pretty text-warning">{uncertainty}</p> : null}
      {diagnostic ? <p className="pl-3.5 text-[0.72rem] text-pretty text-muted-foreground">{diagnostic}</p> : null}
      <div className="flex items-center gap-1 pl-2.5">
        <Button size="xs" variant="ghost" disabled={reading || !canInspect} title={unavailableReason ?? undefined}
          onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {reading ? <Spinner /> : open ? <EyeOffIcon /> : <EyeIcon />}{open ? "Hide details" : "Details"}
        </Button>
        <span className="ml-auto font-mono text-[0.64rem] text-muted-foreground" title={`Receipt ${receipt.id}`}>receipt {receipt.id.slice(0, 8)}</span>
      </div>
      {open ? (
        <div className="ml-3.5 flex flex-col gap-1 rounded-md border border-dashed bg-background/60 p-2">
          {detail?.error ? (
            <div className="flex items-center gap-2 text-xs">
              <p className="min-w-0 flex-1 break-words text-destructive">Detail unavailable: {detail.error}</p>
              <Button size="xs" variant="ghost" disabled={reading} onClick={readDetail}>Read detail again</Button>
            </div>
          ) : detail?.data ? (
            detail.data.receipt ? (
              <dl className="flex flex-col gap-1">
                <DetailField label="Receipt">
                  <span className="inline-flex items-center gap-0.5 font-mono text-[0.68rem] break-all">{detail.data.receipt.id}<CopyButton value={detail.data.receipt.id} label="receipt ID" className="size-5" /></span>
                </DetailField>
                <DetailField label="Correlation"><span className="font-mono text-[0.68rem] break-all">{detail.data.receipt.recordId}</span></DetailField>
                <DetailField label="Thread"><span className="font-mono text-[0.68rem] break-all">{detail.data.receipt.threadId}</span></DetailField>
                <DetailField label="State">{stateLabel.description}</DetailField>
                <DetailField label="Link">
                  <span title={completionLinkStatusLabels[detail.data.linkStatus].description}>
                    {completionLinkStatusLabels[detail.data.linkStatus].label} — {completionLinkStatusLabels[detail.data.linkStatus].description}
                  </span>
                </DetailField>
                {link ? (
                  <DetailField label="Targets">
                    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {completionTargets(link).map((target) => <CompletionTargetLink key={target.label} target={target} />)}
                    </span>
                  </DetailField>
                ) : null}
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">{completionLinkStatusLabels[detail.data.linkStatus].label}. {completionLinkStatusLabels[detail.data.linkStatus].description}</p>
            )
          ) : <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="size-3" />Reading detail…</p>}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Retained completion receipts (`serve_completion_list`): history that outlives its watches. Admission
 * acknowledged is never consumption; unknown admissions offer no retry. Detail is `serve_completion_get` on
 * explicit expand, with exact domain links including a Worker's exact turn.
 */
export function HistoryView({ run }: { run(work: Promise<void>): void }) {
  const state = useStack();
  const store = useStore();
  const { completions, completionFilter, status } = state;
  useEffect(() => store.watchCompletions(), [store]);
  const access = localOperation(state, "serve", "serve_completion_list");
  const detailAccess = localOperation(state, "serve", "serve_completion_get");
  const data = completions.data;
  const filtered = Object.values(completionFilter).some(Boolean);
  return (
    <>
      <p className={hintClass}>Retained completion receipts outlive their watches. Ordered by receipt ID, not by time. Admission acknowledged means Codex accepted the input — not that anyone read it, finished a turn, approved anything or completed Work.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <BotSubscriptionFilter botId={completionFilter.botId} disabled={!access.available} />
        <PackageSubscriptionFilter package={completionFilter.package} disabled={!access.available} onChange={(next) => run(store.filterCompletions({ ...completionFilter, package: next }))} />
        <NativeSelect size="sm" aria-label="State" className="min-w-0 flex-1" value={completionFilter.state ?? ""} disabled={!access.available}
          onChange={(event) => run(store.filterCompletions({ ...completionFilter, state: (event.target.value || undefined) as ServeCompletionReceipt["state"] | undefined }))}>
          <NativeSelectOption value="">All states</NativeSelectOption>
          {Object.entries(completionReceiptLabels).map(([value, { label }]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {!access.available ? <p className={hintClass}>{access.reason}</p> : null}
      {data?.restarted ? <p role="status" className="text-xs text-warning">History changed while paging, so paging started again from the first page.</p> : null}
      {data ? (
        <>
          <p className={hintClass}>Showing {data.completions.length} of {data.total} retained receipts{data.truncated ? " · more on later pages" : ""}</p>
          {data.completions.length ? (
            <div className="-mx-1 flex flex-col">
              {data.completions.map((receipt) => <CompletionRow key={receipt.id} receipt={receipt} canInspect={detailAccess.available} unavailableReason={detailAccess.available ? null : detailAccess.reason} />)}
            </div>
          ) : <Empty icon={HistoryIcon} title={filtered ? "No receipts match" : "No retained completion receipts"} />}
        </>
      ) : <Empty icon={HistoryIcon} title={completions.error ? "Completion history unavailable" : status.serve === "closed" ? "Server reconnecting" : "Reading completion history…"} hint={completions.error ?? undefined} />}
    </>
  );
}

function OccurrenceTarget({ row }: { row: ServeOccurrenceRow }) {
  const { bots } = useStack();
  const showWorker = useShowWorker();
  const target = row.target;
  if (target.kind === "bot") {
    const knownBot = bots.data?.some((bot) => bot.id === target.botId);
    return (
      <>
        <span>{knownBot ? <NodeLink node={{ kind: "bot", id: target.botId }} label={`Bot ${target.botId}`}>{target.botId}</NodeLink> : target.botId}</span>
        <span className="font-mono text-[0.68rem]" title={`Thread ${target.threadId}`}>thread {target.threadId.slice(0, 12)}</span>
      </>
    );
  }
  return (
    <>
      <button type="button" onClick={() => showWorker(target.workerId)} title="Show this Worker"
        className="rounded-sm font-mono text-[0.68rem] decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        Worker {shortId(target.workerId)}
      </button>
      <span className="font-mono text-[0.68rem]" title={`Session ${target.sessionId}`}>session {target.sessionId.slice(0, 12)}</span>
    </>
  );
}

function OccurrenceRow({ row, onRemove, canInspect, canRemove }: { row: ServeOccurrenceRow; onRemove(row: ServeOccurrenceRow): void; canInspect: boolean; canRemove: boolean }) {
  const store = useStore();
  const [inspection, setInspection] = useState<{ revision: string; value: ServeOccurrenceDetail | null } | null>(null);
  const [reading, setReading] = useState(false);
  // Revealed arguments and receipts belong to the intent revision they were read at; a changed row drops them.
  const shown = inspection !== null && inspection.revision === row.revision;
  const inspect = () => {
    setReading(true);
    store.call<{ subscription: ServeOccurrenceDetail | null }>("serve", "serve_occurrence_get", { id: row.id })
      .then(({ subscription }) => setInspection({ revision: subscription?.revision ?? row.revision, value: subscription }), (error) => toast.error(errorMessage(error)))
      .finally(() => setReading(false));
  };
  // While the inspection is open, receipt-count, truncation and cursor movement re-read it; the open read's
  // own landing is not a change.
  const observed = useRef<string | null>(null);
  const receiptsSignature = `${row.receiptCount}:${row.receiptsTruncated}:${row.cursor}`;
  useEffect(() => {
    if (!shown) { observed.current = null; return; }
    if (observed.current !== null && observed.current !== receiptsSignature) inspect();
    observed.current = receiptsSignature;
  }, [shown, receiptsSignature]);
  const detail = shown ? inspection!.value : null;
  return (
    <div data-occurrence={row.id} className="flex flex-col gap-1.5 rounded-lg px-2 py-1.5 hover:bg-muted/70">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 rounded bg-muted px-1 py-px text-[0.64rem] font-medium text-muted-foreground">{row.target.kind === "bot" ? "Bot Chat" : "Worker"}</span>
        <span className="min-w-0 truncate font-medium">{row.pkg}.{row.name}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{occurrencePolicyLabel(row)}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-xs text-muted-foreground">
        <OccurrenceTarget row={row} />
        <span title={row.cursor === null ? "No source cursor is held yet" : "A source cursor is held; its value needs explicit inspection"}>{row.cursor === null ? "no cursor yet" : "cursor held"}</span>
        {row.truncated ? <span className="text-warning" title="The source's poll reported truncation; some occurrences may not have been offered.">source truncated</span> : null}
        <span>{row.receiptCount} receipt{row.receiptCount === 1 ? "" : "s"}{row.receiptsTruncated ? " · only the latest 128 are inspectable" : ""}</span>
      </div>
      <div className="flex items-center gap-1 pl-2.5">
        <Button size="xs" variant="ghost" disabled={reading || !canInspect} onClick={() => shown ? setInspection(null) : inspect()} aria-expanded={shown}>
          {reading ? <Spinner /> : shown ? <EyeOffIcon /> : <EyeIcon />}{shown ? "Hide inspection" : "Inspect…"}
        </Button>
        <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" disabled={!canRemove} onClick={() => onRemove(row)}>
          <Trash2Icon />Remove…
        </Button>
        <span className="ml-auto font-mono text-[0.64rem] text-muted-foreground" title={`Intent revision ${row.revision}`}>rev {row.revision.slice(0, 8)}</span>
      </div>
      {shown ? (
        <div className="ml-3.5 flex flex-col gap-1.5 rounded-md border border-dashed bg-background/60 p-2 text-xs">
          {detail ? (
            <>
              <span className={labelClass}>Source arguments · may be sensitive</span>
              <pre className="max-h-40 overflow-auto font-mono text-[0.68rem] break-all whitespace-pre-wrap">{JSON.stringify(detail.arguments, null, 2)}</pre>
              <span className={labelClass}>Last error</span>
              <p className={detail.lastError ? "break-words text-destructive" : "text-muted-foreground"}>{detail.lastError ?? "None recorded"}</p>
              <span className={labelClass}>Cursor</span>
              <p className="font-mono text-[0.68rem] break-all">{detail.cursor ?? "None"}</p>
              <span className={labelClass}>Receipts</span>
              {detail.deliveries.length ? (
                <ul className="flex flex-col gap-1.5">
                  {detail.deliveries.map((receipt) => {
                    const wording = occurrenceDeliveryLabel(receipt);
                    return (
                      <li key={receipt.id} className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-2">
                          <span title={wording.description}>{wording.label}</span>
                          <span className="font-mono text-[0.66rem] text-muted-foreground" title={`Event ${receipt.eventId}`}>event {shortId(receipt.eventId)}</span>
                        </span>
                        <span className="text-[0.7rem] text-muted-foreground">{wording.description}</span>
                        {receipt.error ? <span className="break-words text-destructive">{receipt.error}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="text-muted-foreground">No receipts retained.</p>}
              <p className="text-muted-foreground">{detail.deliveries.length} of {detail.receiptCount} receipts shown</p>
            </>
          ) : <p className="text-muted-foreground">This occurrence subscription no longer exists.</p>}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Typed occurrence subscriptions (`serve_occurrence_list`) for Bot Chats and Worker conversations. Source
 * arguments, errors, cursor values and delivery receipts need the explicit per-row `serve_occurrence_get`
 * inspection, which an intent-revision change drops. Removal is exact and fences future intake only.
 */
export function OccurrencesView({ run }: { run(work: Promise<void>): void }) {
  const state = useStack();
  const store = useStore();
  const { occurrences, occurrenceFilter, status } = state;
  const [removing, setRemoving] = useState<ServeOccurrenceRow | null>(null);
  const [pending, setPending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  useEffect(() => store.watchOccurrences(), [store]);
  const access = localOperation(state, "serve", "serve_occurrence_list");
  const getAccess = localOperation(state, "serve", "serve_occurrence_get");
  const removeAccess = localOperation(state, "serve", "serve_subscription_remove");
  const data = occurrences.data;
  const filtered = Object.values(occurrenceFilter).some(Boolean);
  const listed = removing ? data?.subscriptions.find((row) => row.id === removing.id) ?? null : null;
  const changed = removing !== null && listed !== null && listed.revision !== removing.revision;
  const remove = () => {
    if (!removing) return;
    const target = removing;
    setPending(true);
    store.removeSubscription(target.id, target.revision).then(({ removed }) => {
      setRemoving(null);
      toast.success(removed ? `Removed occurrence subscription ${target.pkg}.${target.name}` : "That occurrence subscription was already absent");
    }, (error) => setRemoveError(errorMessage(error))).finally(() => setPending(false));
  };
  return (
    <>
      <p className={hintClass}>Typed occurrence subscriptions turn source events into input for one exact Bot Chat or Worker conversation. Payload-free invalidations are not occurrences. Events are untrusted observation data — never approval or Work completion.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <BotSubscriptionFilter botId={occurrenceFilter.botId} disabled={!access.available} />
        <PackageSubscriptionFilter package={occurrenceFilter.package} disabled={!access.available} onChange={(next) => run(store.filterOccurrences({ ...occurrenceFilter, package: next }))} />
      </div>
      {!access.available ? <p className={hintClass}>{access.reason}</p> : null}
      {data?.restarted ? <p role="status" className="text-xs text-warning">Occurrence subscriptions changed while paging, so paging started again from the first page.</p> : null}
      {data ? data.subscriptions.length ? (
        <div className="-mx-1 flex flex-col">
          {data.subscriptions.map((row) => <OccurrenceRow key={row.id} row={row} canInspect={getAccess.available} canRemove={removeAccess.available} onRemove={(target) => { setRemoveError(null); setRemoving(target); }} />)}
        </div>
      ) : <Empty icon={RssIcon} title={filtered ? "No occurrence subscriptions match" : "No occurrence subscriptions"} />
        : <Empty icon={RssIcon} title={occurrences.error ? "Occurrence subscriptions unavailable" : status.serve === "closed" ? "Server reconnecting" : "Reading occurrence subscriptions…"} hint={occurrences.error ?? undefined} />}
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
            <AlertDialogTitle>Remove this occurrence subscription?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span><span className="font-medium text-foreground">{removing?.pkg}.{removing?.name}</span>
                {removing ? (removing.target.kind === "bot" ? ` → Bot Chat ${removing.target.botId}, thread ${removing.target.threadId}` : ` → Worker ${removing.target.workerId}, session ${removing.target.sessionId}`) : null}.</span>
              <span>Removal fences future intake only. Input already admitted to Codex or stored in a Worker inbox cannot be recalled, and the source&rsquo;s own watches remain.</span>
              <span className="font-mono text-[0.68rem] break-all">{removing?.id} · revision {removing?.revision}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {changed ? <p role="alert" className="text-[0.72rem] text-warning">This occurrence subscription changed since you chose it. Close and review it first.</p> : null}
          {removing && data && !listed ? <p role="status" className="text-[0.72rem] text-muted-foreground">It is no longer in the loaded list. Removing it again reports whether it is absent.</p> : null}
          {removeError ? <p role="alert" className="text-[0.72rem] text-destructive">{removeError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={pending || changed} onClick={remove}>
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Remove occurrence subscription
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
