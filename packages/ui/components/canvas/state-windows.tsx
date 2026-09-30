"use client";

import { useEffect, useState } from "react";
import { BookOpenIcon, CableIcon, ChevronDownIcon, ChevronRightIcon, DatabaseIcon, EyeIcon, EyeOffIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { relativeTime } from "@/lib/stack/derive";
import { formatBytes } from "@/lib/stack/resources";
import { groupByOwner, linkNeedsSelection, localOperation, measured, operationNode, ownerGaps, ownerHomes, ownerStateRead, relationshipNode } from "@/lib/stack/state";
import type { ServeSubscription, ServeSubscriptionDetail, StateEntry, StateOwner } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { Empty, NodeCard, NodeLink, NodeTitle, StatusDot, type Tone } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";
import { Window } from "./window";

const hintClass = "text-[0.72rem] text-pretty text-muted-foreground";

function LocalOnly({ id, title, icon: Icon, what }: { id: string; title: string; icon: React.ComponentType<{ className?: string }>; what: string }) {
  return (
    <Window id={id} title={title} icon={Icon} accent="server" empty>
      <div className="flex flex-col items-center gap-1.5 p-6 text-center">
        <Icon className="size-5 text-muted-foreground/70" />
        <p className="text-sm font-medium">Available only on the local UI</p>
        <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">{what}</p>
      </div>
    </Window>
  );
}

const coverageTone: Record<StateEntry["coverage"], Tone> = { complete: "success", partial: "warning", unavailable: "destructive" };

/** A reference link to one operation. Empty arguments name a drill-down: the owner's own view chooses the resource. */
function OperationChip({ pkg, operation }: { pkg: string; operation: string }) {
  const { goTo } = useWorkbench();
  return (
    <button type="button" onClick={() => goTo(operationNode({ package: pkg, operation }))} title={`${pkg}.${operation} in the API reference`}
      className="inline-flex h-5 max-w-full items-center gap-1 rounded-md bg-muted px-1.5 font-mono text-[0.66rem] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <BookOpenIcon className="size-3 shrink-0" /><span className="truncate">{pkg === "serve" ? operation : `${pkg}.${operation}`}</span>
    </button>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-x-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Every inventory field besides the headline: authority, retention, regeneration, issues, relationships and links. */
export function StateEntryDetails({ entry }: { entry: StateEntry }) {
  return (
    <dl className="flex flex-col gap-1">
      <Detail label="Owner">{entry.ownerPackage}{entry.subject ? ` · ${entry.subject.kind} ${entry.subject.id}` : ""}</Detail>
      <Detail label="Authority">{entry.authority} · {entry.location} · {entry.ownership === "stack" ? "Stack-owned" : `${entry.ownership} ownership`}</Detail>
      <Detail label="Retention">{entry.retention}</Detail>
      <Detail label="Regeneration">{entry.regeneration}</Detail>
      {entry.issues.length ? <Detail label="Issues"><ul className="flex flex-col gap-0.5 text-warning">{entry.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></Detail> : null}
      {entry.relationships.length ? (
        <Detail label="Related">
          <ul className="flex flex-col gap-0.5">
            {entry.relationships.map((relation) => {
              const node = relationshipNode(relation);
              const text = `${relation.relation}: ${relation.package} ${relation.kind} ${relation.id}`;
              return <li key={`${relation.package}/${relation.kind}/${relation.id}/${relation.relation}`}>{node ? <NodeLink node={node} label={text}>{text}</NodeLink> : text}</li>;
            })}
          </ul>
        </Detail>
      ) : null}
      {entry.reads.length ? (
        <Detail label="Reads">
          <span className="flex flex-wrap gap-1">{entry.reads.map((link) => <OperationChip key={`${link.package}.${link.operation}`} pkg={link.package} operation={link.operation} />)}</span>
        </Detail>
      ) : null}
      <Detail label="Actions">
        {entry.actions.length ? (
          <ul className="flex flex-col gap-1">
            {entry.actions.map((link) => (
              <li key={`${link.package}.${link.operation}`} className="flex flex-col gap-0.5">
                <span><OperationChip pkg={link.package} operation={link.operation} /></span>
                {linkNeedsSelection(link) ? <span className="text-muted-foreground">Choose an exact resource in the owner&rsquo;s view first; this link names no resource.</span> : null}
                {link.blockedBy.map((reason, index) => <span key={index} className="text-muted-foreground">{reason}</span>)}
              </li>
            ))}
          </ul>
        ) : <span className="text-muted-foreground">None linked. That is not blanket deletion permission.</span>}
      </Detail>
      <Detail label="Revision"><span className="font-mono text-[0.68rem] break-all">{entry.revision ?? "not observed"}</span></Detail>
    </dl>
  );
}

function EntryRow({ entry }: { entry: StateEntry }) {
  const [open, setOpen] = useState(false);
  const node = { kind: "state-entry", id: entry.id } as const;
  const category = entry.id.startsWith(`${entry.ownerPackage}:`) ? entry.id.slice(entry.ownerPackage.length + 1) : entry.id;
  return (
    <NodeCard node={node} variant="row" label={`${entry.id} state`} className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${entry.id} details`} onClick={() => setOpen(!open)}
          className="-ml-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </button>
        <StatusDot tone={coverageTone[entry.coverage]} label={`${entry.coverage} coverage`} />
        <NodeTitle node={node} label={`${entry.id} state`} className="min-w-0 truncate font-medium">{category}</NodeTitle>
        <span className="shrink-0 text-muted-foreground">{entry.kind}</span>
        {entry.sensitivity !== "ordinary" ? <span className={cn("shrink-0 rounded px-1 text-[0.64rem] font-medium", entry.sensitivity === "credential" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{entry.sensitivity}</span> : null}
        {entry.issues.length ? <span className="shrink-0 text-warning" title={entry.issues.join("\n")}>{entry.issues.length} issue{entry.issues.length === 1 ? "" : "s"}</span> : null}
        <span className="ml-auto shrink-0 text-right text-muted-foreground tabular-nums" title="A null count is unmeasured, not zero">
          {measured(entry.bytes, formatBytes)}{entry.items !== null ? ` · ${entry.items} items` : ""}
        </span>
      </div>
      {open ? <div className="pl-5"><StateEntryDetails entry={entry} /></div> : null}
    </NodeCard>
  );
}

function OwnerGroup({ owner, entries }: { owner: StateOwner; entries: StateEntry[] }) {
  const { setSpace } = useWorkbench();
  return (
    <section aria-label={`${owner.package} state`} className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 px-1 pt-1.5 pb-0.5 text-xs">
        <StatusDot tone={owner.available ? "success" : "destructive"} label={owner.available ? "Available" : "Unavailable"} />
        <NodeLink node={{ kind: "package", id: owner.package }} label={`${owner.package} Package API`} className="font-semibold">{owner.package}</NodeLink>
        <span className="text-muted-foreground">{owner.available ? `${entries.length} loaded` : "unavailable"}</span>
        <span className="ml-auto flex items-center gap-1">
          {ownerHomes[owner.package] ? <button type="button" onClick={() => setSpace(ownerHomes[owner.package].space)} title={`Open ${owner.package}'s controls in ${ownerHomes[owner.package].title}`}
            className="inline-flex h-5 items-center rounded-md px-1.5 text-[0.66rem] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Open in {ownerHomes[owner.package].title}</button> : null}
          <OperationChip pkg={owner.package} operation={ownerStateRead(owner.package)} />
        </span>
      </div>
      {owner.issue ? <p className={cn("px-1 pb-1 text-xs", owner.available ? "text-muted-foreground" : "text-destructive")}>{owner.issue}</p> : null}
      {!owner.available ? <p className="px-1 pb-1 text-xs text-muted-foreground">A gap, not an empty store: this owner&rsquo;s state is unobserved.</p> : null}
      {ownerGaps[owner.package] ? <p className="px-1 pb-1 text-[0.7rem] text-pretty text-muted-foreground">{ownerGaps[owner.package]}</p> : null}
      <div className="flex flex-col">{entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)}</div>
    </section>
  );
}

/**
 * System's owner state map: every Package API's state categories from `serve_state_list`, with coverage,
 * authority, nullable measurements, retention, regeneration and links to each owner's reads. Maintenance
 * happens in the owner's view; nothing here deletes.
 */
export function StateInventoryWindow() {
  const state = useStack();
  const store = useStore();
  const { stateInventory, stateSelection, status, endpoints, catalog, remote } = state;
  const [kind, setKind] = useState<StateEntry["kind"] | "">("");
  const [loading, setLoading] = useState(false);
  if (remote) return <LocalOnly id="state" title="State" icon={DatabaseIcon} what="Owner state inventories are local operator reads. Remote sessions cannot list or change them." />;
  const access = localOperation(state, "serve", "serve_state_list");
  const data = stateInventory.data;
  // The Server names the owners it inventories; discovery adds any package it did not answer for yet.
  const owners = [...new Set([...(data?.owners ?? []).map((owner) => owner.package), ...(catalog.data ?? []).map((doc) => doc.name)])].sort();
  const groups = data ? groupByOwner(data).map((group) => ({ ...group, entries: kind ? group.entries.filter((entry) => entry.kind === kind) : group.entries })) : [];
  const unavailable = data?.owners.filter((owner) => !owner.available) ?? [];
  const run = (work: Promise<void>) => { setLoading(true); void work.finally(() => setLoading(false)); };
  return (
    <Window id="state" title="State" subtitle="owner inventories" icon={DatabaseIcon} accent="server" count={data?.entries.length ?? null}
      status={status.serve} endpoint={endpoints.serve} updatedAt={stateInventory.at} error={stateInventory.error} empty={!data}
      actions={<Button variant="ghost" size="xs" disabled={!access.available || loading} onClick={() => run(store.refreshStateInventory())} aria-label="Refresh state inventory">
        {loading ? <Spinner /> : <RefreshCwIcon />}
      </Button>}
      footer={data?.nextOffset != null ? (
        <Button size="sm" variant="ghost" className="w-full justify-center text-muted-foreground hover:text-foreground" disabled={loading} onClick={() => run(store.moreStateInventory())}>
          Load more (from {data.nextOffset})
        </Button>
      ) : undefined}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <NativeSelect size="sm" aria-label="Owner" className="min-w-0 flex-1" value={stateSelection.owners?.[0] ?? ""} disabled={!access.available}
            onChange={(event) => run(store.selectStateInventory({ ...stateSelection, owners: event.target.value ? [event.target.value] : null }))}>
            <NativeSelectOption value="">All owners</NativeSelectOption>
            {owners.map((name) => <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Category kind" className="min-w-0 flex-1" value={kind} onChange={(event) => setKind(event.target.value as StateEntry["kind"] | "")}>
            <NativeSelectOption value="">All kinds</NativeSelectOption>
            {(["workspace", "conversation", "queue", "history", "configuration", "credentials", "cache", "runtime", "storage"] as const).map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
          </NativeSelect>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Scan at most 2,000 filesystem entries per category. Shared, external and client stores stay unmeasured.">
            <Switch size="sm" checked={stateSelection.measure} disabled={!access.available} aria-label="Measure storage"
              onCheckedChange={(measure) => run(store.selectStateInventory({ ...stateSelection, measure }))} />Measure
          </label>
        </div>
        {!access.available ? <p className={hintClass}>{access.reason}</p> : null}
        {data?.restarted ? <p role="status" className="text-xs text-warning">The inventory changed while paging, so paging started again from the first page.</p> : null}
        {data ? (
          <>
            <p className={hintClass}>
              {data.owners.length} owner{data.owners.length === 1 ? "" : "s"}{unavailable.length ? `, ${unavailable.length} unavailable` : ""} · observed {relativeTime(Date.parse(data.observedAt), Date.now())}
              {data.selection.measure ? " · measured" : " · not measured"}. Bytes are per-category observations; shared or overlapping stores are never summed, and unmeasured is not zero.
              {kind ? " The kind filter applies to loaded pages only." : ""}
            </p>
            <div className="-mx-1 flex flex-col gap-1">
              {groups.filter((group) => !kind || group.entries.length || !group.owner.available).map((group) => <OwnerGroup key={group.owner.package} owner={group.owner} entries={group.entries} />)}
            </div>
          </>
        ) : <Empty icon={DatabaseIcon} title={stateInventory.error ? "State inventory unavailable" : status.serve === "closed" ? "Server reconnecting" : "Reading owner inventories…"} />}
      </div>
    </Window>
  );
}

const subscriptionTone: Record<ServeSubscription["state"], Tone> = { active: "success", delivering: "info", connecting: "muted", error: "destructive" };

function SubscriptionRow({ subscription, onRemove, available }: { subscription: ServeSubscription; onRemove(subscription: ServeSubscription): void; available: boolean }) {
  const store = useStore();
  const { bots } = useStack();
  const now = useNow(30_000);
  const [detail, setDetail] = useState<{ revision: string; value: ServeSubscriptionDetail | null } | null>(null);
  const [reading, setReading] = useState(false);
  const node = { kind: "subscription", id: subscription.id } as const;
  // Revealed arguments belong to the revision they were read at; a changed subscription hides them.
  const shown = detail && detail.revision === subscription.revision ? detail : null;
  const reveal = () => {
    setReading(true);
    store.call<{ subscription: ServeSubscriptionDetail | null }>("serve", "serve_subscription_get", { id: subscription.id })
      .then(({ subscription: value }) => setDetail({ revision: value?.revision ?? subscription.revision, value }), (error) => toast.error(errorMessage(error)))
      .finally(() => setReading(false));
  };
  const knownBot = bots.data?.some((bot) => bot.id === subscription.botId);
  return (
    <NodeCard node={node} variant="row" label={`subscription ${subscription.id}`} className="flex flex-col">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <StatusDot tone={subscriptionTone[subscription.state]} label={subscription.state} />
        <NodeTitle node={node} label={`subscription ${subscription.id}`} className="min-w-0 truncate font-medium">{subscription.pkg}.{subscription.topic}</NodeTitle>
        {subscription.scope ? <span className="min-w-0 truncate font-mono text-[0.68rem] text-muted-foreground" title={`Scope ${subscription.scope}`}>{subscription.scope}</span> : null}
        <span className="ml-auto shrink-0 text-muted-foreground">{subscription.state}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-xs text-muted-foreground">
        <span>{knownBot ? <NodeLink node={{ kind: "bot", id: subscription.botId }} label={`Bot ${subscription.botId}`}>{subscription.botId}</NodeLink> : subscription.botId}</span>
        <span className="font-mono text-[0.68rem]" title={`Thread ${subscription.threadId}`}>thread {subscription.threadId.slice(0, 12)}</span>
        <span className="font-mono text-[0.68rem]" title="Read operation run on each notice">{subscription.readOperation}</span>
        <span>{subscription.lastDeliveredAt ? `delivered ${relativeTime(subscription.lastDeliveredAt, now)}` : "never delivered"}</span>
      </div>
      <div className="flex items-center gap-1 pl-2.5">
        <Button size="xs" variant="ghost" disabled={reading || !available} onClick={() => shown ? setDetail(null) : reveal()} aria-expanded={!!shown}>
          {reading ? <Spinner /> : shown ? <EyeOffIcon /> : <EyeIcon />}{shown ? "Hide arguments" : "Reveal arguments"}
        </Button>
        <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" disabled={!available} onClick={() => onRemove(subscription)}>
          <Trash2Icon />Remove…
        </Button>
        <span className="ml-auto font-mono text-[0.64rem] text-muted-foreground" title={`Revision ${subscription.revision}`}>rev {subscription.revision.slice(0, 8)}</span>
      </div>
      {shown ? (
        <div className="ml-3.5 flex flex-col gap-1 rounded-md border border-dashed bg-background/60 p-2 text-xs">
          {shown.value ? (
            <>
              <span className="text-[0.66rem] font-medium tracking-[0.06em] text-muted-foreground uppercase">Read arguments · may be sensitive</span>
              <pre className="max-h-40 overflow-auto font-mono text-[0.68rem] break-all whitespace-pre-wrap">{JSON.stringify(shown.value.readArguments, null, 2)}</pre>
              <span className="text-[0.66rem] font-medium tracking-[0.06em] text-muted-foreground uppercase">Last error</span>
              <p className={shown.value.lastError ? "break-words text-destructive" : "text-muted-foreground"}>{shown.value.lastError ?? "None recorded"}</p>
            </>
          ) : <p className="text-muted-foreground">This subscription no longer exists.</p>}
        </div>
      ) : null}
    </NodeCard>
  );
}

/**
 * Durable Bot event subscriptions across originating threads (`serve_subscription_list`). Removal is exact:
 * one ID at the revision shown. Input already admitted to Codex cannot be recalled.
 */
export function SubscriptionsWindow() {
  const state = useStack();
  const store = useStore();
  const { subscriptions, subscriptionFilter, status, endpoints, catalog, bots, remote } = state;
  const [thread, setThread] = useState(subscriptionFilter.threadId ?? "");
  const [removing, setRemoving] = useState<ServeSubscription | null>(null);
  const [pending, setPending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => setThread(subscriptionFilter.threadId ?? ""), [subscriptionFilter.threadId]);
  if (remote) return <LocalOnly id="subscriptions" title="Subscriptions" icon={CableIcon} what="Bot event subscriptions are local operator state. Remote sessions cannot list or remove them." />;
  const listAccess = localOperation(state, "serve", "serve_subscription_list");
  const removeAccess = localOperation(state, "serve", "serve_subscription_remove");
  const data = subscriptions.data;
  const run = (work: Promise<void>) => { setLoading(true); void work.finally(() => setLoading(false)); };
  const filter = (next: typeof subscriptionFilter) => run(store.filterSubscriptions(next));
  const listed = removing ? data?.subscriptions.find((row) => row.id === removing.id) ?? null : null;
  const changed = removing !== null && listed !== null && listed.revision !== removing.revision;
  const remove = () => {
    if (!removing) return;
    const target = removing;
    setPending(true);
    store.removeSubscription(target.id, target.revision).then(({ removed }) => {
      setRemoving(null);
      toast.success(removed ? `Removed subscription ${target.pkg}.${target.topic}` : "That subscription was already absent");
    }, (error) => setRemoveError(errorMessage(error))).finally(() => setPending(false));
  };
  return (
    <Window id="subscriptions" title="Subscriptions" subtitle="Bot event inputs" icon={CableIcon} accent="server" count={data?.subscriptions.length ?? null}
      status={status.serve} endpoint={endpoints.serve} updatedAt={subscriptions.at} error={subscriptions.error} empty={!data}
      actions={<Button variant="ghost" size="xs" disabled={!listAccess.available || loading} onClick={() => run(store.refreshSubscriptions())} aria-label="Refresh subscriptions">
        {loading ? <Spinner /> : <RefreshCwIcon />}
      </Button>}
      footer={data?.nextOffset != null ? (
        <Button size="sm" variant="ghost" className="w-full justify-center text-muted-foreground hover:text-foreground" disabled={loading} onClick={() => run(store.moreSubscriptions())}>
          Load more (from {data.nextOffset})
        </Button>
      ) : undefined}>
      <div className="flex flex-col gap-2">
        <p className={hintClass}>Each subscription turns a package event into automatic input for the Bot thread that created it. Removing one aborts pending reads and fences input not yet admitted; input Codex already admitted cannot be recalled.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <NativeSelect size="sm" aria-label="Bot" className="min-w-0 flex-1" value={subscriptionFilter.botId ?? ""} disabled={!listAccess.available}
            onChange={(event) => filter({ ...subscriptionFilter, botId: event.target.value || undefined })}>
            <NativeSelectOption value="">All Bots</NativeSelectOption>
            {(bots.data ?? []).map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{bot.id}</NativeSelectOption>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Package" className="min-w-0 flex-1" value={subscriptionFilter.package ?? ""} disabled={!listAccess.available}
            onChange={(event) => filter({ ...subscriptionFilter, package: event.target.value || undefined })}>
            <NativeSelectOption value="">All packages</NativeSelectOption>
            {(catalog.data ?? []).map((doc) => doc.name).sort().map((name) => <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>)}
          </NativeSelect>
          <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); filter({ ...subscriptionFilter, threadId: thread.trim() || undefined }); }}>
            <Input aria-label="Thread ID" placeholder="Exact thread ID" className="h-7 text-xs" value={thread} disabled={!listAccess.available}
              onChange={(event) => setThread(event.target.value)} onBlur={() => { if ((thread.trim() || undefined) !== subscriptionFilter.threadId) filter({ ...subscriptionFilter, threadId: thread.trim() || undefined }); }} />
          </form>
        </div>
        {!listAccess.available ? <p className={hintClass}>{listAccess.reason}</p> : null}
        {data?.restarted ? <p role="status" className="text-xs text-warning">Subscriptions changed while paging, so paging started again from the first page.</p> : null}
        {data ? data.subscriptions.length ? (
          <div className="-mx-1 flex flex-col">
            {data.subscriptions.map((row) => <SubscriptionRow key={row.id} subscription={row} available={removeAccess.available} onRemove={(target) => { setRemoveError(null); setRemoving(target); }} />)}
          </div>
        ) : <Empty icon={CableIcon} title={Object.values(subscriptionFilter).some(Boolean) ? "No subscriptions match" : "No Bot event subscriptions"} />
          : <Empty icon={CableIcon} title={subscriptions.error ? "Subscriptions unavailable" : status.serve === "closed" ? "Server reconnecting" : "Reading subscriptions…"} />}
      </div>
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
            <AlertDialogTitle>Remove this subscription?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span><span className="font-medium text-foreground">{removing?.pkg}.{removing?.topic}</span> for {removing?.botId}, thread <code className="font-mono break-all">{removing?.threadId}</code>.</span>
              <span>Pending reads stop and input not yet admitted is fenced. Input Codex already admitted cannot be recalled, and no Bot, thread or schedule changes.</span>
              <span className="font-mono text-[0.68rem] break-all">{removing?.id} · revision {removing?.revision}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {changed ? <p role="alert" className="text-[0.72rem] text-warning">This subscription changed since you chose it. Close and review it first.</p> : null}
          {removing && data && !listed ? <p role="status" className="text-[0.72rem] text-muted-foreground">It is no longer in the loaded list. Removing it again reports whether it is absent.</p> : null}
          {removeError ? <p role="alert" className="text-[0.72rem] text-destructive">{removeError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={pending || changed} onClick={remove}>
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Remove subscription
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Window>
  );
}

