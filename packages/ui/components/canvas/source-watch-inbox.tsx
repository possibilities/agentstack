"use client";

import { useEffect, useState } from "react";
import { CheckCheckIcon, ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/stack/resources";
import { contentTypeLabel, deliveryName, deliverySubject, primaryEntity } from "@/lib/stack/source";
import { acknowledgement, unloaded, type InboxNotice, type InboxState } from "@/lib/stack/source-watches";
import type { GithubDelivery } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, NodeLink } from "./primitives";
import { useStack, useStore } from "./provider";
import { sourceChip, sourceHint, sourceLabel, Stamp, UntrustedNote } from "./source-shared";

const rangeText = (first: number | null, through: number | null) => first === null || through === null ? "" : first === through ? `#${first}` : `#${first} to #${through}`;
const listText = (sequences: number[], limit = 24) => sequences.slice(0, limit).map((sequence) => `#${sequence}`).join(", ") + (sequences.length > limit ? ` and ${sequences.length - limit} more` : "");

/**
 * One watch's consumption inbox: the oldest pending entries, and what the person has deliberately reviewed. It is not a pinned
 * snapshot. Nothing here acknowledges on view, navigation, reload, a notice or a native admission: the cursor moves only when
 * "Acknowledge through #N" is confirmed, for exactly the run of entries marked as reviewed.
 */
export function WatchInbox({ id, canAcknowledge, unavailableReason }: { id: string; canAcknowledge: boolean; unavailableReason: string | null }) {
  const store = useStore();
  const { sourceInbox: inbox, sourceEndpoints, status } = useStack();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<{ through: number; base: number } | null>(null);
  const [sending, setSending] = useState(false);
  const labels = new Map((sourceEndpoints.data ?? []).map((endpoint) => [endpoint.id, endpoint.label]));
  const current = inbox.watchId === id;
  const offer = acknowledgement(inbox);
  const more = unloaded(inbox);
  const open = status.source === "open";

  // Another watch, a fresh load or a moved cursor means the rows are not those that were reviewed.
  useEffect(() => { setExpanded(new Set()); setConfirm(null); }, [inbox.session]);
  // A confirmation is for exactly the run it named: if the review changes underneath it, close it rather than let it stand for something else.
  useEffect(() => {
    if (confirm && (offer.plan.through !== confirm.through || inbox.base !== confirm.base)) setConfirm(null);
  }, [confirm, offer.plan.through, inbox.base]);

  if (!current) return <p className={sourceHint}>Reading the inbox…</p>;
  if (inbox.gone) {
    return (
      <Alert variant="destructive"><AlertTitle>This watch was removed</AlertTitle>
        <AlertDescription>Its ID is retired and it matches nothing new. Its inbox can no longer be read and nothing was acknowledged by removing it.</AlertDescription></Alert>
    );
  }
  const watch = inbox.watch;
  const toggleDetails = (sequence: number) => {
    setExpanded((held) => { const next = new Set(held); if (next.has(sequence)) next.delete(sequence); else { next.add(sequence); store.sourceInboxOpened(sequence); } return next; });
  };
  const send = async () => {
    if (!confirm) return;
    setSending(true);
    try { await store.acknowledgeSourceWatch(confirm.through); } finally { setSending(false); setConfirm(null); }
  };
  const arrived = inbox.through !== null && inbox.firstThrough !== null && inbox.through > inbox.firstThrough;

  return (
    <div className="flex flex-col gap-2.5" aria-label="Watch inbox">
      <p className={sourceHint}>
        <span className="font-medium text-foreground">Not a pinned snapshot.</span> The owner offers no pin for this read: matches can arrive while you read. Rows already loaded never move, and later matches load only when you ask.
        Reading, refreshing, notices, polling and native delivery never acknowledge an entry.
      </p>
      <dl aria-label="Consumption" className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-center text-[0.68rem]">
        <div className="flex flex-col"><dd className="text-[0.84rem] font-semibold tabular-nums">{watch ? `#${watch.acknowledgedThrough}` : "…"}</dd><dt className="text-muted-foreground">Acknowledged through</dt></div>
        <div className="flex flex-col"><dd className="text-[0.84rem] font-semibold tabular-nums">{inbox.through === null ? "…" : `#${inbox.through}`}</dd><dt className="text-muted-foreground">Matched through</dt></div>
        <div className="flex flex-col"><dd className="text-[0.84rem] font-semibold tabular-nums">{inbox.pending === null ? "…" : inbox.pending.toLocaleString("en-US")}</dd><dt className="text-muted-foreground">Pending</dt></div>
      </dl>
      {watch && !watch.enabled ? <p role="status" className="text-[0.72rem] text-muted-foreground">Notifications and occurrence polling are off for this watch. Matching deliveries are still captured and appear here.</p> : null}
      <Notice notice={inbox.notice} onDismiss={store.sourceInboxDismissNotice} />
      {inbox.error ? (
        <Alert variant="destructive"><AlertTitle>The inbox could not be read</AlertTitle>
          <AlertDescription className="flex flex-col gap-1.5"><span>{inbox.error}</span>
            <span><Button size="xs" variant="outline" disabled={!open || inbox.busy !== null} onClick={store.sourceInboxReload}><RefreshCwIcon data-icon="inline-start" />Read again</Button></span></AlertDescription></Alert>
      ) : null}
      {arrived ? <p role="status" className="rounded-lg border border-pkg-source/40 bg-pkg-source/10 px-2.5 py-1.5 text-[0.72rem]"><span className="font-semibold">New matches arrived</span> after you opened this inbox (matched through #{inbox.through}). {more > 0 ? `${more} pending ${more === 1 ? "entry is" : "entries are"} not loaded; your place has not moved.` : "They are loaded below the entries you were reading."}</p> : null}

      {inbox.busy === "first" ? <p className="flex items-center gap-1.5 text-[0.74rem] text-muted-foreground"><Spinner />Reading the oldest pending entries…</p>
        : !inbox.entries.length ? <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[0.76rem] text-muted-foreground">{inbox.error ? "Nothing loaded." : more > 0 ? `${more.toLocaleString("en-US")} pending ${more === 1 ? "entry arrived" : "entries arrived"} after this inbox was read. Load them below.` : "Nothing is pending. Matches appear here as deliveries arrive."}</p>
        : (
          <ul aria-label="Pending entries, oldest first" className="flex flex-col gap-1">
            {inbox.entries.map((entry) => (
              <Entry key={entry.sequence} entry={entry} receiver={labels.get(entry.endpointId) ?? null} reviewing={canAcknowledge} reviewed={inbox.marked.includes(entry.sequence)}
                stranded={offer.plan.stranded.includes(entry.sequence)} open={expanded.has(entry.sequence)} busy={inbox.busy === "ack"}
                onMark={(on) => store.sourceInboxMark(entry.sequence, on)} onMarkThrough={() => store.sourceInboxMarkThrough(entry.sequence)} onToggle={() => toggleDetails(entry.sequence)} />
            ))}
          </ul>
        )}
      {inbox.entries.length || more > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[0.7rem] text-muted-foreground" aria-live="polite">
          <span className="tabular-nums">{inbox.entries.length.toLocaleString("en-US")} loaded{more > 0 ? `, ${more.toLocaleString("en-US")} more pending` : ""}</span>
          <Button size="xs" variant="outline" disabled={!open || inbox.busy !== null || (more === 0 && inbox.nextCursor === null)} onClick={store.sourceInboxMore}>
            {inbox.busy === "more" ? <Spinner data-icon="inline-start" /> : null}Load next page
          </Button>
          <Button size="xs" variant="ghost" disabled={!open || inbox.busy !== null} onClick={store.sourceInboxReload} title="Read from the owner's cursor again. Review marks are cleared.">
            <RefreshCwIcon data-icon="inline-start" />Read again
          </Button>
        </div>
      ) : null}

      {canAcknowledge ? (
        <section aria-label="Review and acknowledge" className="flex flex-col gap-1.5 rounded-lg border bg-background/60 p-2.5">
          <span className={sourceLabel}>Review</span>
          <p role="status" className="text-[0.74rem]">
            {offer.plan.through === null
              ? <>Mark entries as reviewed, oldest first. Nothing is acknowledged until you confirm.</>
              : <>Reviewed <span className="font-medium tabular-nums">{rangeText(offer.plan.first, offer.plan.through)}</span> · {offer.plan.count} of {inbox.entries.length} loaded {offer.plan.count === 1 ? "entry" : "entries"}.</>}
          </p>
          {offer.plan.stranded.length ? <p className="text-[0.7rem] text-warning">{offer.plan.stranded.length} marked {offer.plan.stranded.length === 1 ? "entry is" : "entries are"} after an unmarked one ({listText(offer.plan.stranded, 8)}). Consumption is oldest-first: they are not covered until every entry before them is marked.</p> : null}
          {offer.plan.skipped.length ? <p className="text-[0.7rem] text-muted-foreground">{offer.plan.skipped.length} of these {offer.plan.skipped.length === 1 ? "was" : "were"} marked without opening {offer.plan.skipped.length === 1 ? "its" : "their"} details.</p> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={!offer.allowed || !open || sending} title={offer.reason ?? undefined}
              onClick={() => offer.plan.through !== null && inbox.base !== null && setConfirm({ through: offer.plan.through, base: inbox.base })}>
              <CheckCheckIcon data-icon="inline-start" />{offer.plan.through === null ? "Acknowledge through…" : `Acknowledge through #${offer.plan.through}…`}
            </Button>
            <Button size="sm" variant="ghost" disabled={!inbox.marked.length || inbox.busy === "ack"} onClick={store.sourceInboxClearMarks}>Clear marks</Button>
          </div>
          {offer.reason && offer.plan.through === null && inbox.entries.length ? <p className={sourceHint}>{offer.reason}</p> : null}
          <p className={sourceHint}>Acknowledging moves the consumption cursor forward only, and only through entries you marked. It is the only thing here that does.</p>
        </section>
      ) : <p className={sourceHint}>{unavailableReason ?? "Acknowledgement is not offered here."}</p>}

      <UntrustedNote />
      <AlertDialog open={confirm !== null} onOpenChange={(next) => { if (!next && !sending) setConfirm(null); }}>
        <AlertDialogContent size="sm" aria-label="Confirm acknowledgement">
          <AlertDialogHeader>
            <AlertDialogMedia><CheckCheckIcon /></AlertDialogMedia>
            <AlertDialogTitle>Acknowledge through #{confirm?.through}?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span><span className="font-medium text-foreground">{watch?.label}</span> <code className="font-mono text-[0.68rem] break-all">{id}</code></span>
              <span>The consumption cursor moves from <span className="font-medium text-foreground tabular-nums">#{confirm?.base}</span> to <span className="font-medium text-foreground tabular-nums">#{confirm?.through}</span>, covering {offer.plan.count} {offer.plan.count === 1 ? "entry" : "entries"}: {listText(inbox.entries.slice(0, offer.plan.count).map((entry) => entry.sequence))}.</span>
              {offer.plan.skipped.length ? <span role="alert" className="text-warning">{offer.plan.skipped.length} {offer.plan.skipped.length === 1 ? "entry was" : "entries were"} marked reviewed without opening {offer.plan.skipped.length === 1 ? "its" : "their"} details and will be acknowledged anyway: {listText(offer.plan.skipped)}.</span> : <span>Every entry in the range had its details opened.</span>}
              <span>{inbox.pending !== null ? `${Math.max(0, inbox.pending - offer.plan.count).toLocaleString("en-US")} pending ${Math.max(0, inbox.pending - offer.plan.count) === 1 ? "entry stays" : "entries stay"} pending` : "Later entries stay pending"}{offer.plan.stranded.length ? `, including ${offer.plan.stranded.length} you marked after an unmarked one` : ""}.</span>
              <span>The cursor only moves forward, so this cannot be undone here. It is sent only while the cursor is still #{confirm?.base} (compare-and-set); otherwise nothing is acknowledged, the inbox is read again and you review again.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={sending || !confirm} onClick={() => void send()}>
              {sending ? <Spinner data-icon="inline-start" /> : <CheckCheckIcon data-icon="inline-start" />}Acknowledge through #{confirm?.through}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Notice({ notice, onDismiss }: { notice: InboxNotice | null; onDismiss(): void }) {
  if (!notice) return null;
  const dismiss = <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>;
  if (notice.kind === "acknowledged") {
    return (
      <div role="status" className="flex flex-col gap-1 rounded-lg border border-success/40 bg-success/10 px-2.5 py-2 text-[0.74rem]">
        <p><span className="font-semibold">Acknowledged through #{notice.through}</span> · {notice.count} {notice.count === 1 ? "entry" : "entries"}{notice.confirmedByReading ? ". The answer was lost; reading the cursor back shows it moved" : ""}.
          {notice.skipped.length ? ` ${notice.skipped.length} ${notice.skipped.length === 1 ? "was" : "were"} marked without opening details: ${listText(notice.skipped, 12)}.` : ""}</p>
        <div>{dismiss}</div>
      </div>
    );
  }
  if (notice.kind === "conflict") {
    return (
      <div role="alert" className="flex flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-2 text-[0.74rem]">
        <p><span className="font-semibold">Nothing was acknowledged.</span> The cursor was no longer #{notice.expected}{notice.now !== null ? `: it is now #${notice.now}` : ""}, so the request through #{notice.attempted} was not applied (or was refused as stale). Another consumer or window may share this watch. The inbox was read again from the cursor as it is now and every review mark was cleared: review the entries again before acknowledging.</p>
        <div>{dismiss}</div>
      </div>
    );
  }
  if (notice.kind === "moved") {
    return (
      <div role="alert" className="flex flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-2 text-[0.74rem]">
        <p><span className="font-semibold">The acknowledged cursor moved from #{notice.from} to #{notice.to}</span> while you were reading; this view did not move it. The rows were replaced with those pending now and every review mark was cleared.</p>
        <div>{dismiss}</div>
      </div>
    );
  }
  if (notice.kind === "refused") {
    return (
      <div role="alert" className="flex flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-2 text-[0.74rem]">
        <p><span className="font-semibold">Not acknowledged.</span> The request through #{notice.attempted} failed ({notice.error}) and the cursor is unchanged. Your review marks are kept; nothing was retried.</p>
        <div>{dismiss}</div>
      </div>
    );
  }
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-2 text-[0.74rem]">
      <p><span className="font-semibold">Result not confirmed.</span> The request through #{notice.attempted} (cursor was #{notice.expected}) failed ({notice.error}) and the cursor could not be read back. It may or may not have been applied; nothing was retried. Read the inbox again to see the cursor.</p>
      <div>{dismiss}</div>
    </div>
  );
}

function Entry({ entry, receiver, reviewing, reviewed, stranded, open, busy, onMark, onMarkThrough, onToggle }: {
  entry: GithubDelivery; receiver: string | null; reviewing: boolean; reviewed: boolean; stranded: boolean; open: boolean; busy: boolean;
  onMark(on: boolean): void; onMarkThrough(): void; onToggle(): void;
}) {
  const subject = deliverySubject(entry);
  const entity = primaryEntity(entry);
  const detail = `watch-entry-${entry.sequence}`;
  return (
    <li data-entry={entry.sequence} data-reviewed={reviewed || undefined} className={cn("rounded-lg border px-2 py-1.5", reviewed && "border-pkg-source/50 bg-pkg-source/5", stranded && "border-warning/50")}>
      <div className="flex items-start gap-2 text-[0.76rem]">
        {reviewing ? (
          <input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => onMark(event.target.checked)} aria-label={`Entry ${entry.sequence} reviewed`} className="mt-0.5 size-3.5 shrink-0" />
        ) : null}
        <span className="w-11 shrink-0 text-right font-mono text-[0.72rem] text-muted-foreground tabular-nums">#{entry.sequence}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate font-mono font-semibold">{deliveryName(entry)}</span>
            <Stamp at={entry.receivedAt} className="ml-auto shrink-0 text-[0.68rem] text-muted-foreground" />
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-2 text-[0.7rem] text-muted-foreground">
            {subject.map((part) => <span key={part} className="max-w-full truncate font-mono">{part}</span>)}
            {entry.sender ? <span className="truncate">by {entry.sender}</span> : null}
            {receiver ? <span className="truncate">via {receiver}</span> : null}
          </span>
          {entity ? <span className="truncate text-[0.7rem]" title={entity}>{entity}</span> : null}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.66rem] text-muted-foreground tabular-nums">
            <span>{entry.payloadClearedAt ? "Original cleared" : "Original retained"}</span>
            <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={detail}
              className="inline-flex items-center gap-0.5 rounded-sm font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}Details
            </button>
            {reviewing ? <button type="button" onClick={onMarkThrough} disabled={busy} title="Mark this entry and every older loaded entry as reviewed"
              className="rounded-sm font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Mark through here</button> : null}
            {stranded ? <span className={cn(sourceChip, "text-warning")}>after an unmarked entry</span> : null}
          </span>
        </div>
      </div>
      {open ? (
        <dl id={detail} className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t pt-1.5 pl-8 text-[0.7rem]">
          <dt className="text-muted-foreground">Delivery</dt><dd className="min-w-0 truncate font-mono" title={entry.deliveryId}>{entry.deliveryId}</dd>
          <dt className="text-muted-foreground">Content</dt><dd>{contentTypeLabel(entry.contentType)} · {formatBytes(entry.payloadBytes)}</dd>
          {entry.ref ? <><dt className="text-muted-foreground">Ref</dt><dd className="min-w-0 truncate font-mono" title={entry.ref}>{entry.ref}</dd></> : null}
          {entry.sha ? <><dt className="text-muted-foreground">Commit</dt><dd className="font-mono">{entry.sha.slice(0, 12)}</dd></> : null}
          <dt className="text-muted-foreground">Digest</dt><dd className="flex min-w-0 items-center gap-1"><span className="min-w-0 truncate font-mono" title={entry.payloadSha256}>{entry.payloadSha256}</span><CopyButton value={entry.payloadSha256} label="digest" className="-my-1" /></dd>
          {entry.entities.length ? <><dt className="text-muted-foreground">Names</dt>
            <dd className="flex min-w-0 flex-col gap-0.5">{entry.entities.slice(0, 6).map((item, index) => (
              <span key={`${item.kind}:${index}`} className="min-w-0 truncate" title={item.title ?? undefined}>{item.kind}{item.number !== null ? ` #${item.number}` : ""}{item.title ? ` · ${item.title}` : ""}{item.state ? ` · ${item.state}` : ""}</span>
            ))}</dd></> : null}
          <dt className="text-muted-foreground">Reader</dt><dd><NodeLink node={{ kind: "github-delivery", id: String(entry.sequence) }} label={`delivery ${entry.sequence}`} className="font-medium">Open delivery #{entry.sequence} in the reader</NodeLink></dd>
        </dl>
      ) : null}
    </li>
  );
}

export type { InboxState };
