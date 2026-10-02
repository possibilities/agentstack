"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { canonicalJson, describeFilter, filterIsEmpty } from "@/lib/stack/source";
import { maxWatchLabel, maxWatches, watchExamples } from "@/lib/stack/source-watches";
import { localOperation } from "@/lib/stack/state";
import type { GithubFilter, GithubWatch } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { CopyButton, Empty, Flash, NodeCard, NodeLink, NodeTitle } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { fieldLabel } from "./scrape-shared";
import { CreateWatch } from "./source-watch-create";
import { WatchInbox } from "./source-watch-inbox";
import { sourceChip, sourceHint, sourceLabel, sourceUnavailable, Stamp, Word } from "./source-shared";
import { Window } from "./window";

const parseWatch = (key: string | undefined): string | null => {
  const match = key?.match(/^github-watch:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1]!.toLowerCase() : null;
};

/**
 * Durable filtered inboxes. A watch's filter is immutable; its inbox is read from the consumption cursor, and that cursor moves only
 * when a person acknowledges entries they reviewed. Polling, native delivery and Worker intake never move it. Everything that
 * changes a watch is local only: the remote UI reads definitions and inboxes and shows no control.
 */
export function WatchesWindow() {
  const store = useStore();
  const state = useStack();
  const { flash } = useWorkbench();
  const { status, endpoints, remote, sourceWatches, sourceWatchCounts, sourceWatchSelected, sourceInbox, sourceStatus } = state;
  const [creating, setCreating] = useState<{ filter: GithubFilter | null } | null>(null);
  const list = sourceWatches.data;
  const unavailable = sourceUnavailable(endpoints, status);
  const createAccess = remote ? null : localOperation(state, "source", "github_watch_create");
  // A link to a watch opens its inbox. Selecting reads; it never acknowledges.
  useEffect(() => {
    const linked = parseWatch(flash?.key);
    if (linked) store.selectSourceWatch(linked);
  }, [flash?.seq, flash?.key, store]);

  return (
    <Window id="source-watches" title="Watches" icon={EyeIcon} accent="source" count={list?.length ?? null}
      status={endpoints.source ? status.source : undefined} endpoint={endpoints.source} updatedAt={sourceWatches.at ?? sourceStatus.at} error={sourceWatches.error} bleed empty={!endpoints.source}
      actions={createAccess ? (
        <Button size="xs" variant="outline" disabled={!createAccess.available || status.source !== "open" || (list?.length ?? 0) >= maxWatches || creating !== null} title={createAccess.available ? undefined : createAccess.reason}
          onClick={() => setCreating({ filter: null })}><PlusIcon data-icon="inline-start" />New watch</Button>
      ) : undefined}>
      {!endpoints.source ? <div className="p-3.5"><Empty icon={EyeIcon} title="Source isn't served by this server" /></div> : (
        <div data-scroll className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3">
          <p className={sourceHint}>
            A watch keeps the deliveries that match its immutable filter until someone acknowledges them. Disabling notifications pauses scoped notices and occurrence polling; matching continues. Polling, native admission and Worker intake never advance the consumption cursor.
            {remote ? " This connection is read-only: acknowledgement and every change to a watch are local operator actions." : ""}
          </p>
          {creating ? <CreateWatch key={creating.filter ? "from-filter" : "new"} initialFilter={creating.filter} count={list?.length ?? 0} onClose={() => setCreating(null)} /> : null}
          {sourceWatches.error && !list ? <p role="alert" className="text-[0.72rem] text-destructive">The watches could not be read: {sourceWatches.error}</p> : null}
          {!list ? <Empty icon={EyeIcon} title={unavailable ?? "Reading watches…"} />
            : !list.length ? <Empty icon={EyeIcon} title="No watches" hint={remote ? "Watches are created on the local UI or through github_watch_create." : "Create one to keep a filtered inbox of deliveries."} />
            : (
              <ul aria-label="Watches" className="flex flex-col gap-2">
                {list.map((watch) => (
                  <WatchRow key={watch.id} watch={watch} selected={sourceWatchSelected === watch.id} count={sourceWatchSelected === watch.id && sourceInbox.watchId === watch.id && sourceInbox.pending !== null
                    ? { pending: sourceInbox.pending, through: sourceInbox.through ?? 0 } : sourceWatchCounts[watch.id] ?? null}
                    onToggle={() => store.selectSourceWatch(sourceWatchSelected === watch.id ? null : watch.id)}
                    onCreateFrom={() => setCreating({ filter: watch.filter })} />
                ))}
              </ul>
            )}
        </div>
      )}
    </Window>
  );
}

function WatchRow({ watch, selected, count, onToggle, onCreateFrom }: { watch: GithubWatch; selected: boolean; count: { pending: number; through: number } | null; onToggle(): void; onCreateFrom(): void }) {
  const state = useStack();
  const { sourceEndpoints, remote, status } = state;
  const labels = useMemo(() => new Map((sourceEndpoints.data ?? []).map((endpoint) => [endpoint.id, endpoint.label])), [sourceEndpoints.data]);
  const node = { kind: "github-watch" as const, id: watch.id };
  const chips = describeFilter(watch.filter, (id) => labels.get(id) ?? `${id.slice(0, 8)}…`);
  const none = count !== null && count.pending === 0;
  const ack = remote ? null : localOperation(state, "source", "github_watch_acknowledge");
  const body = `watch-${watch.id}-body`;
  return (
    <li data-node={`github-watch:${watch.id}`} aria-current={selected || undefined} className="relative">
      <Flash id={`github-watch:${watch.id}`} />
      <NodeCard node={node} label={watch.label}>
        <div className="flex min-w-0 items-center gap-2">
          <NodeTitle node={node} label={watch.label} className="min-w-0 truncate text-[0.82rem] font-semibold">{watch.label}</NodeTitle>
          <Word tone={watch.enabled ? "success" : "muted"} className="ml-auto shrink-0 text-[0.7rem]">{watch.enabled ? "Notifications on" : "Notifications off"}</Word>
        </div>
        <div className="flex min-w-0 flex-wrap gap-1" aria-label="Immutable filter">
          {chips.length ? chips.slice(0, 4).map((item, index) => (
            <span key={`${item.label}:${index}`} className={cn(sourceChip, "flex max-w-full min-w-0 items-baseline gap-1")} title={`${item.label}: ${item.values.join(" or ")}`}>
              <span className="shrink-0 font-medium">{item.label}</span><span className="truncate font-mono">{item.values.join(" · ")}</span>
            </span>
          )) : <span className="text-[0.72rem] text-muted-foreground">Every delivery</span>}
          {chips.length > 4 ? <span className={sourceChip}>+{chips.length - 4} more</span> : null}
        </div>
        <dl aria-label="Consumption" className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-center text-[0.68rem]">
          <div className="flex flex-col"><dd className="text-[0.84rem] font-semibold tabular-nums">#{watch.acknowledgedThrough}</dd><dt className="text-muted-foreground">Acknowledged through</dt></div>
          <div className="flex flex-col"><dd className="text-[0.84rem] font-semibold tabular-nums">{count === null ? "—" : none && count.through <= watch.startAfter ? "none yet" : `#${count.through}`}</dd><dt className="text-muted-foreground">Matched through</dt></div>
          <div className="flex flex-col"><dd className={cn("text-[0.84rem] font-semibold tabular-nums", count && count.pending > 0 && "text-foreground")}>{count === null ? "—" : count.pending.toLocaleString("en-US")}</dd><dt className="text-muted-foreground">Pending</dt></div>
        </dl>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant={selected ? "secondary" : "outline"} aria-expanded={selected} aria-controls={body} disabled={status.source !== "open" && !selected} onClick={onToggle}>
            {selected ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}{selected ? "Close inbox" : "Open inbox"}
          </Button>
          <span className="ml-auto text-[0.66rem] text-muted-foreground">Created <Stamp at={watch.createdAt} /> · starts after #{watch.startAfter}</span>
        </div>
        {selected ? (
          <div id={body} className="flex flex-col gap-3 border-t pt-2.5">
            <WatchInbox id={watch.id} canAcknowledge={!remote && Boolean(ack?.available)} unavailableReason={remote ? "Read-only connection: reviewing and acknowledging are local operator actions." : ack && !ack.available ? ack.reason ?? null : null} />
            <Settings watch={watch} onCreateFrom={onCreateFrom} />
            <Examples watch={watch} />
          </div>
        ) : null}
      </NodeCard>
    </li>
  );
}

/* ---------- Definition, settings and removal ---------- */

function Settings({ watch, onCreateFrom }: { watch: GithubWatch; onCreateFrom(): void }) {
  const store = useStore();
  const state = useStack();
  const { remote, status } = state;
  const update = remote ? null : localOperation(state, "source", "github_watch_update");
  const removal = remote ? null : localOperation(state, "source", "github_watch_remove");
  const create = remote ? null : localOperation(state, "source", "github_watch_create");
  const [label, setLabel] = useState(watch.label);
  const [busy, setBusy] = useState<"label" | "enabled" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // A label changed elsewhere replaces an untouched field; an edit in progress is kept.
  useEffect(() => { setLabel((held) => (held === "" || held === watch.label ? watch.label : held)); }, [watch.label, watch.revision]);
  const open = status.source === "open";
  const apply = async (patch: { label?: string; enabled?: boolean }, kind: "label" | "enabled") => {
    setBusy(kind); setProblem(null);
    try { await store.updateSourceWatch(watch.id, watch.revision, patch); } catch (error) {
      const text = errorMessage(error);
      setProblem(/github_watch_revision_changed/.test(text) ? "The watch changed elsewhere since it was shown; it was read again. Check it and apply the change again." : text);
    } finally { setBusy(null); }
  };
  const trimmed = label.trim();
  return (
    <section aria-label="Definition and settings" className="flex flex-col gap-2.5">
      <details className="rounded-lg border border-dashed">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Definition and settings</summary>
        <div className="flex flex-col gap-3 border-t border-dashed p-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.72rem]">
            <dt className="text-muted-foreground">ID</dt><dd className="flex min-w-0 items-center gap-1"><span className="min-w-0 truncate font-mono" title={watch.id}>{watch.id}</span><CopyButton value={watch.id} label="watch ID" className="-my-1" /></dd>
            <dt className="text-muted-foreground">Scope</dt><dd className="min-w-0 truncate font-mono" title={watch.scope}>{watch.scope}</dd>
            <dt className="text-muted-foreground">Configuration</dt><dd>Revision {watch.revision} · changed <Stamp at={watch.updatedAt} /></dd>
            <dt className="text-muted-foreground">Consumption</dt><dd>Acknowledged through #{watch.acknowledgedThrough}. This cursor is separate from the configuration revision.</dd>
            <dt className="text-muted-foreground">Started</dt><dd>After #{watch.startAfter}</dd>
          </dl>
          <div className="flex flex-col gap-1">
            <span className={sourceLabel}>Filter · immutable</span>
            {filterIsEmpty(watch.filter) ? <p className={sourceHint}>Every delivery after the start matches.</p> : <pre aria-label="Watch filter" className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.68rem] break-words whitespace-pre-wrap">{canonicalJson(watch.filter, 2)}</pre>}
            <p className={sourceHint}>A filter is never edited: a different filter is a new watch. Matches already recorded are frozen, so clearing a payload later does not change this inbox.</p>
            {create?.available ? <div><Button size="xs" variant="outline" disabled={!open} onClick={onCreateFrom}><PlusIcon data-icon="inline-start" />New watch from this filter</Button></div> : null}
          </div>
          {update ? (
            <>
              <div className="flex flex-col gap-1.5">
                <span className={sourceLabel}>Notifications / occurrence polling</span>
                <p className={sourceHint}>{watch.enabled ? "On: matches publish scoped notices and occurrence polling returns them." : "Off: scoped notices and occurrence polling pause. Matching deliveries are still captured durably and appear in the inbox; nothing is acknowledged."} Attached Stack subscriptions are not changed here.</p>
                <div className="flex items-center gap-2">
                  <Word tone={watch.enabled ? "success" : "muted"} className="text-[0.74rem]">{watch.enabled ? "On" : "Off"}</Word>
                  <Button size="xs" variant="outline" disabled={!update.available || !open || busy !== null} title={update.available ? undefined : update.reason} onClick={() => void apply({ enabled: !watch.enabled }, "enabled")}>
                    {busy === "enabled" ? <Spinner data-icon="inline-start" /> : null}{watch.enabled ? "Turn off" : "Turn on"}
                  </Button>
                </div>
              </div>
              <form className="flex flex-col gap-1" onSubmit={(event) => { event.preventDefault(); if (trimmed && trimmed !== watch.label) void apply({ label: trimmed }, "label"); }}>
                <label className="flex flex-col gap-1"><span className={fieldLabel}>Label</span>
                  <span className="flex items-center gap-1.5"><Input value={label} maxLength={maxWatchLabel} onChange={(event) => setLabel(event.target.value)} autoComplete="off" className="h-7 text-[0.78rem]" />
                    <Button type="submit" size="xs" variant="outline" disabled={!update.available || !open || busy !== null || !trimmed || trimmed === watch.label}>{busy === "label" ? <Spinner data-icon="inline-start" /> : null}Save label</Button></span></label>
                <span className={sourceHint}>Saved against configuration revision {watch.revision}; a change made elsewhere is refused, not overwritten.</span>
              </form>
              {problem ? <p role="alert" className="text-[0.72rem] text-destructive">{problem}</p> : null}
            </>
          ) : null}
          {removal ? (
            <div className="flex flex-col gap-1">
              <span className={sourceLabel}>Remove</span>
              <p className={sourceHint}>Retires this watch&rsquo;s ID and stops new matching. Its recorded matches and digest are kept so the ID cannot be recreated. Attached Stack subscriptions are not removed.</p>
              <div><Button size="xs" variant="destructive" disabled={!removal.available || !open} title={removal.available ? undefined : removal.reason} onClick={() => setConfirming(true)}><Trash2Icon data-icon="inline-start" />Remove watch…</Button></div>
            </div>
          ) : null}
        </div>
      </details>
      {confirming ? <RemoveWatch watch={watch} onClose={() => setConfirming(false)} /> : null}
    </section>
  );
}

function RemoveWatch({ watch, onClose }: { watch: GithubWatch; onClose(): void }) {
  const store = useStore();
  const { setSpace } = useWorkbench();
  const { sourceWatchCounts, sourceInbox } = useStack();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = watch.id.slice(0, 8);
  const count = sourceInbox.watchId === watch.id && sourceInbox.pending !== null ? sourceInbox.pending : sourceWatchCounts[watch.id]?.pending ?? null;
  const remove = async () => {
    setPending(true); setError(null);
    try { await store.removeSourceWatch(watch.id); onClose(); } catch (failure) {
      const text = errorMessage(failure);
      setError(/github_watch_not_found/.test(text) ? "This watch is already removed." : text);
    } finally { setPending(false); }
  };
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent size="sm" aria-label="Remove watch">
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>Remove this watch?</AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-2">
            <span><span className="font-medium text-foreground">{watch.label}</span><br /><code className="font-mono text-[0.68rem] break-all">{watch.id}</code></span>
            <span>Acknowledged through #{watch.acknowledgedThrough}{count !== null ? ` · ${count.toLocaleString("en-US")} pending entries${count > 0 ? " will never be acknowledged" : ""}` : ""}.</span>
            <span>The ID is retired and cannot be reused. Removing the watch does not remove Stack subscriptions attached to it: they stop validating, and are removed in System, Subscriptions, Occurrences.</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex flex-col gap-1 text-[0.74rem]"><span>Type <code className="font-mono font-semibold">{expected}</code>, the start of this watch&rsquo;s ID, to confirm</span>
          <Input value={typed} onChange={(event) => setTyped(event.target.value.trim())} autoComplete="off" spellCheck={false} aria-label="First eight characters of the watch ID" className="h-7 font-mono text-[0.78rem]" /></label>
        {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { setSpace("system"); onClose(); }}>Open System</Button>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending || typed.toLowerCase() !== expected} onClick={() => void remove()}>
            {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Remove watch
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ---------- Examples ---------- */

function Examples({ watch }: { watch: GithubWatch }) {
  const examples = useMemo(() => watchExamples(watch.id), [watch.id]);
  const blocks: [string, string, string][] = [
    ["events_subscribe", examples.subscribe, "Attach on the source MCP connection so a sanctioned Bot thread is told, with bounded snapshots, when this watch changes. It reads; it never acknowledges."],
    ["events/poll", examples.poll, "The draft MCP Events poll on the source connection. A null cursor starts now; keep the cursor it returns. Polling never advances the consumption cursor."],
    ["events_listen", examples.listen, "A tool a verified Bot Chat or Worker calls for itself. Native admission starts or steers that conversation and never advances the consumption cursor."],
  ];
  return (
    <details className="rounded-lg border border-dashed">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><BookOpenIcon aria-hidden className="size-3.5" />Use from an agent</summary>
      <div className="flex flex-col gap-3 border-t border-dashed p-2.5">
        <p className={sourceHint}>Requests for an agent&rsquo;s own connection, with this watch&rsquo;s ID filled in. Subscribing, polling, native admission and Worker intake never acknowledge an entry: only acknowledging above does, after review. This view has no wake or target action; it cannot attach this watch to a Bot or Worker.</p>
        {blocks.map(([title, text, note]) => (
          <div key={title} className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-1.5"><code className="font-mono text-[0.72rem] font-semibold">{title}</code><CopyButton value={text} label={`${title} example`} /></span>
            <pre aria-label={`${title} example`} className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[0.66rem] break-words whitespace-pre-wrap">{text}</pre>
            <span className={sourceHint}>{note}</span>
          </div>
        ))}
        <p className={sourceHint}>
          Semantics, cursors and the managed tool are in the API reference:{" "}
          <NodeLink node={{ kind: "operation", pkg: "source", id: "github_watch_events" }} label="github_watch_events" className="font-mono font-medium">github_watch_events</NodeLink>{" "}(occurrence source, poll semantics and events_listen).
        </p>
      </div>
    </details>
  );
}
