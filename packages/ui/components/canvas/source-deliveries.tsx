"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownIcon, FilterIcon, InboxIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/stack/resources";
import {
  buildFilter, capacityView, contentTypeLabel, deliveryName, deliverySubject, describeFilter, draftFromFilter, emptyDraft, emptyPredicate, filterIsEmpty, filterKey,
  newerArrivals, oneOfTypes, predicateOps, primaryEntity, scalarTypes, targetLabel, type FilterDraft, type PredicateDraft, type PredicateOp, type ValueType,
} from "@/lib/stack/source";
import type { GithubDelivery, GithubEndpoint } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Empty, Flash, NodeCard, NodeTitle } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { ClearPayloads, maxPayloadClears } from "./source-maintenance";
import { Capacity, sourceChip, sourceHint, sourceLabel, sourceUnavailable, Stamp, Word } from "./source-shared";
import { fieldLabel } from "./scrape-shared";
import { Window } from "./window";

/**
 * Every accepted delivery in Stack's arrival order, oldest first. A session pins the watermark of its first answer
 * and follows the owner's exclusive cursor, so the page you are reading never shifts: newer arrivals are announced,
 * and a changed filter is a fresh session. Payload text appears only in the reader, as escaped text.
 */
export function DeliveriesWindow() {
  const store = useStore();
  const { goTo } = useWorkbench();
  const { status, endpoints, sourceLedger: ledger, sourceStatus, sourceEndpoints, sourceSelected } = useStack();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const [locked, setLocked] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const list = useRef<HTMLUListElement>(null);
  const receivers = sourceEndpoints.data;
  const labels = useMemo(() => new Map((receivers ?? []).map((endpoint) => [endpoint.id, endpoint.label])), [receivers]);
  const arrivals = newerArrivals(ledger, sourceStatus.data?.latestSequence ?? null);
  const retained = ledger.entries.filter((entry) => entry.payloadClearedAt === null);
  const unavailable = sourceUnavailable(endpoints, status);
  const applied = describeFilter(ledger.filter, (id) => labels.get(id) ?? `${id.slice(0, 8)}…`);
  const reading = ledger.busy === "first";

  // A chosen row whose payload was cleared (by this plan or another) is no longer a valid choice.
  useEffect(() => {
    setChosen((held) => {
      const live = new Set(ledger.entries.filter((entry) => entry.payloadClearedAt === null).map((entry) => entry.sequence));
      const next = new Set([...held].filter((sequence) => live.has(sequence)));
      return next.size === held.size ? held : next;
    });
  }, [ledger.entries]);
  // A fresh session starts with no choice: the sequences belong to the rows that were read.
  useEffect(() => { setChosen(new Set()); }, [ledger.session]);

  const open = (sequence: number) => { store.selectSourceDelivery(sequence); goTo({ kind: "github-delivery", id: String(sequence) }); };
  const toggle = useCallback((sequence: number) => setChosen((held) => {
    const next = new Set(held);
    if (next.has(sequence)) next.delete(sequence); else next.add(sequence);
    return next;
  }), []);
  const chosenList = [...chosen].sort((a, b) => a - b);
  const move = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-row-open]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <Window id="source-deliveries" title="Deliveries" icon={InboxIcon} accent="source" count={ledger.through !== null ? ledger.entries.length : null}
      status={endpoints.source ? status.source : undefined} endpoint={endpoints.source} updatedAt={sourceStatus.at} error={ledger.error ?? sourceStatus.error} bleed empty={!endpoints.source}>
      {!endpoints.source ? <div className="p-3.5"><Empty icon={InboxIcon} title="Source isn't served by this server" /></div> : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3.5 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[0.76rem]" aria-live="polite">
              {ledger.through !== null ? (
                <>
                  <span className="font-semibold tabular-nums">Snapshot through #{ledger.through}</span>
                  <span className="text-muted-foreground tabular-nums">{ledger.entries.length.toLocaleString("en-US")} loaded</span>
                  <span className="text-muted-foreground">{ledger.complete ? "End of snapshot" : "More to read"}</span>
                </>
              ) : <span className="text-muted-foreground">{reading ? "Reading the first page…" : ledger.error ? "No snapshot: the first page failed" : unavailable ?? "No snapshot yet"}</span>}
              <span className="ml-auto flex items-center gap-1.5">
                {ledger.busy ? <Spinner /> : null}
                <Button size="xs" variant="ghost" disabled={status.source !== "open" || reading} onClick={() => store.applySourceFilter(ledger.filter)} title="Start a fresh snapshot with the same filter">
                  <RefreshCwIcon data-icon="inline-start" />Fresh snapshot
                </Button>
              </span>
            </div>
            {arrivals.available ? (
              <div role="status" className="flex flex-col gap-1.5 rounded-lg border border-pkg-source/40 bg-pkg-source/10 px-2.5 py-2 text-[0.74rem]">
                <p><span className="font-semibold">New arrivals available</span> · newest is #{arrivals.latest}; this snapshot ends at #{ledger.through}. Your place has not moved.</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="xs" variant="outline" disabled={!arrivals.canExtend || ledger.busy !== null} onClick={store.sourceExtend}><ChevronsDownIcon data-icon="inline-start" />Continue to the newest</Button>
                  <Button size="xs" variant="ghost" disabled={ledger.busy === "first"} onClick={() => store.applySourceFilter(ledger.filter)}>Start fresh at the newest</Button>
                  {!arrivals.canExtend ? <span className="text-[0.68rem] text-muted-foreground">Read to the end of this snapshot first to continue from here.</span> : null}
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="xs" variant={filtersOpen ? "secondary" : "outline"} aria-expanded={filtersOpen} aria-controls="source-filters" onClick={() => setFiltersOpen(!filtersOpen)}>
                <FilterIcon data-icon="inline-start" />Filters{applied.length ? <span className="ml-0.5 tabular-nums">{applied.length}</span> : null}
              </Button>
              {applied.length ? applied.map((item, index) => (
                <span key={`${item.label}:${index}`} className={cn(sourceChip, "flex max-w-full min-w-0 items-baseline gap-1")} title={`${item.label}: ${item.values.join(" or ")}`}>
                  <span className="shrink-0 font-medium">{item.label}</span><span className="truncate font-mono">{item.values.join(" · ")}</span>
                </span>
              )) : <span className="text-[0.72rem] text-muted-foreground">All accepted deliveries</span>}
            </div>
            <CapacityLine />
            {ledger.refreshError ? <p role="alert" className="text-[0.7rem] text-warning">Could not re-read the loaded rows after a change ({ledger.refreshError}). Their payload state may be out of date; start a fresh snapshot to read it again.</p> : null}
          </div>
          <div data-scroll className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3">
            {filtersOpen ? <Filters receivers={receivers ?? []} disabled={status.source !== "open"} /> : null}
            <ClearPayloads chosen={chosenList} retained={retained} onOpenChange={setMaintenance} onLockChange={setLocked}
              onSelectRetained={() => setChosen(new Set(retained.slice(0, maxPayloadClears).map((entry) => entry.sequence)))} onClearSelection={() => setChosen(new Set())} />
            {ledger.error && ledger.through === null ? (
              <Alert variant="destructive"><AlertTitle>The ledger could not be read</AlertTitle><AlertDescription>{ledger.error}</AlertDescription></Alert>
            ) : ledger.through === null ? <Empty icon={InboxIcon} title={reading ? "Reading deliveries…" : unavailable ?? "Waiting for Source"} />
              : !ledger.entries.length ? (
                <Empty icon={InboxIcon} title={ledger.complete ? (filterIsEmpty(ledger.filter) ? "No deliveries yet" : "No delivery matches this filter") : "Nothing on this page matches yet"}
                  hint={ledger.complete ? (filterIsEmpty(ledger.filter) ? "Signed webhook requests appear here in arrival order once a receiver is published and GitHub sends one." : "Filters combine with AND; a payload predicate cannot match a delivery whose original payload was cleared.") : "The owner returned a short page. Keep reading: a short page is not the end."} />
              ) : (
                <ul ref={list} onKeyDown={move} aria-label="Deliveries, oldest first" className="flex flex-col gap-0.5">
                  {ledger.entries.map((entry) => (
                    <Row key={entry.sequence} entry={entry} receiver={labels.get(entry.endpointId) ?? null} selected={sourceSelected === entry.sequence}
                      detached={ledger.detached.includes(entry.sequence)} choosing={maintenance} chosen={chosen.has(entry.sequence)} locked={locked} onToggle={toggle} onOpen={open} />
                  ))}
                </ul>
              )}
            {ledger.error && ledger.through !== null ? <p role="alert" className="text-[0.72rem] text-destructive">The last page failed: {ledger.error}. What was read is unchanged.</p> : null}
            {ledger.through !== null ? (
              <div className="flex flex-col items-start gap-1 pb-1" aria-live="polite">
                {ledger.nextCursor !== null ? (
                  <Button size="sm" variant="outline" disabled={ledger.busy !== null} onClick={store.sourceMore}>
                    {ledger.busy === "more" ? <Spinner data-icon="inline-start" /> : null}Read next page
                  </Button>
                ) : null}
                <p className={sourceHint}>
                  {ledger.nextCursor !== null ? `Next page starts after #${ledger.nextCursor}. The owner may shorten a page; only the end of the snapshot ends this list.`
                    : `Reached the end of the snapshot through #${ledger.through}.`}
                  {" "}Arrival order is local, not GitHub&rsquo;s causal order.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Window>
  );
}

/** The ledger's own capacity line: numbers always, the refusal wording when it matters. */
function CapacityLine() {
  const { sourceStatus, sourceEndpoints } = useStack();
  const status = sourceStatus.data;
  if (!status) return null;
  const view = capacityView(status.payloads, sourceEndpoints.data);
  if (view.state !== "available") return <Capacity status={status} endpoints={sourceEndpoints.data} compact />;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-[0.7rem] text-muted-foreground tabular-nums">
      <span className={sourceLabel}>Payloads</span>
      <span>{status.payloads.count.toLocaleString("en-US")} of {status.payloads.maxCount.toLocaleString("en-US")}</span>
      <span>{formatBytes(status.payloads.bytes)} of {formatBytes(status.payloads.maxBytes)}</span>
      <Word tone={view.tone} className="ml-auto text-[0.7rem]">{view.word}</Word>
    </p>
  );
}

function Row({ entry, receiver, selected, detached, choosing, chosen, locked, onToggle, onOpen }: {
  entry: GithubDelivery; receiver: string | null; selected: boolean; detached: boolean; choosing: boolean; chosen: boolean; locked: boolean;
  onToggle(sequence: number): void; onOpen(sequence: number): void;
}) {
  const node = { kind: "github-delivery" as const, id: String(entry.sequence) };
  const cleared = entry.payloadClearedAt !== null;
  const subject = deliverySubject(entry);
  const entity = primaryEntity(entry);
  return (
    <li data-node={`github-delivery:${entry.sequence}`} aria-current={selected || undefined} className="relative">
      <Flash id={`github-delivery:${entry.sequence}`} />
      <NodeCard node={node} label={`Delivery ${entry.sequence}`} variant="row" className={cn(selected && "ring-1 ring-pkg-source/60")}>
        <div className="flex items-start gap-2 text-[0.76rem]">
          {choosing ? (
            <input type="checkbox" checked={chosen} disabled={cleared || locked} onChange={() => onToggle(entry.sequence)} aria-label={cleared ? `Delivery ${entry.sequence} payload already cleared` : `Choose delivery ${entry.sequence} for payload clearing`} className="mt-0.5 size-3.5 shrink-0" />
          ) : null}
          <NodeTitle node={node} label={`delivery ${entry.sequence}`} className="w-12 shrink-0 text-right font-mono text-[0.72rem] text-muted-foreground tabular-nums">#{entry.sequence}</NodeTitle>
          <button type="button" data-row-open onClick={() => onOpen(entry.sequence)} aria-label={`Open delivery ${entry.sequence}, ${deliveryName(entry)}`}
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-mono font-semibold">{deliveryName(entry)}</span>
              {!entry.knownEvent ? <span className={sourceChip} title="Not in the pinned official catalog; still accepted">not in catalog</span> : null}
              <Stamp at={entry.receivedAt} className="ml-auto shrink-0 text-[0.68rem] text-muted-foreground" />
            </span>
            <span className="flex min-w-0 flex-wrap gap-x-2 text-[0.7rem] text-muted-foreground">
              {subject.map((part) => <span key={part} className="max-w-full truncate font-mono">{part}</span>)}
              {entry.sender ? <span className="truncate">by {entry.sender}</span> : null}
              {receiver ? <span className="truncate">via {receiver}</span> : null}
            </span>
            {entity ? <span className="truncate text-[0.7rem]" title={entity}>{entity}</span> : null}
            <span className="flex flex-wrap items-baseline gap-x-2 text-[0.66rem] text-muted-foreground tabular-nums">
              {cleared ? <span className="font-medium text-foreground">Original cleared</span> : <span>Original retained</span>}
              <span>{formatBytes(entry.payloadBytes)}</span>
              <span>{contentTypeLabel(entry.contentType)}</span>
              {detached ? <span className="text-warning">no longer matches the payload filter</span> : null}
            </span>
          </button>
        </div>
      </NodeCard>
    </li>
  );
}

/* ---------- Filters ---------- */

function Filters({ receivers, disabled }: { receivers: GithubEndpoint[]; disabled: boolean }) {
  const store = useStore();
  const { sourceLedger: ledger } = useStack();
  const [draft, setDraft] = useState<FilterDraft>(() => draftFromFilter(ledger.filter));
  const [errors, setErrors] = useState<string[]>([]);
  // A filter set elsewhere (a receiver's "Show deliveries") is the one this form shows.
  useEffect(() => { setDraft(draftFromFilter(ledger.filter)); setErrors([]); }, [ledger.key, ledger.filter]);
  const built = useMemo(() => buildFilter(draft), [draft]);
  const dirty = filterKey(built.filter) !== ledger.key;
  const set = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K]) => setDraft((held) => ({ ...held, [key]: value }));
  const apply = () => {
    const { filter, errors: found } = buildFilter(draft);
    setErrors(found);
    if (!found.length) store.applySourceFilter(filter);
  };
  const text = (key: "events" | "actions" | "repositories" | "organizations" | "senders" | "refs" | "enterprises" | "installationIds" | "repositoryIds", label: string, placeholder: string) => (
    <label className="flex min-w-0 flex-col gap-1"><span className={fieldLabel}>{label}</span>
      <Input value={draft[key]} onChange={(event) => set(key, event.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" /></label>
  );
  const setPredicate = (index: number, patch: Partial<PredicateDraft>) => set("predicates", draft.predicates.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  return (
    <form id="source-filters" aria-label="Delivery filters" className="flex flex-col gap-2.5 rounded-lg border bg-background/60 p-2.5" onSubmit={(event) => { event.preventDefault(); apply(); }}>
      <p className={sourceHint}>A delivery must match every field you fill in. Several values in one field match any of them. Values are exact; repository, organization, enterprise and sender ignore case. Any event name works, including ones the catalog does not list yet.</p>
      {receivers.length ? (
        <fieldset className="flex flex-col gap-1"><legend className={fieldLabel}>Receiver</legend>
          <div className="flex flex-wrap gap-1">
            {receivers.map((endpoint) => {
              const on = draft.endpointIds.includes(endpoint.id);
              return <button key={endpoint.id} type="button" aria-pressed={on} onClick={() => set("endpointIds", on ? draft.endpointIds.filter((id) => id !== endpoint.id) : [...draft.endpointIds, endpoint.id])}
                className={cn("rounded-md border px-2 py-0.5 text-[0.72rem] focus-visible:outline-2 focus-visible:outline-ring", on ? "border-pkg-source bg-pkg-source/15 font-medium" : "text-muted-foreground hover:text-foreground")}>
                {endpoint.label} <span className="font-mono text-[0.64rem] text-muted-foreground">{targetLabel(endpoint.target)}</span>
              </button>;
            })}
          </div>
        </fieldset>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {text("events", "Events", "issues, pull_request")}
        {text("actions", "Actions", "opened, closed")}
        {text("repositories", "Repositories", "owner/name")}
        {text("organizations", "Organizations", "login")}
        {text("senders", "Senders", "login")}
        {text("refs", "Refs", "refs/heads/main")}
      </div>
      <details className="rounded-lg border border-dashed" open={Boolean(draft.enterprises || draft.installationIds || draft.repositoryIds || draft.predicates.length)}>
        <summary className="cursor-pointer px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Advanced: enterprise, IDs and payload predicates</summary>
        <div className="flex flex-col gap-2.5 border-t border-dashed p-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {text("enterprises", "Enterprises", "slug")}
            {text("installationIds", "Installation IDs", "12345")}
            {text("repositoryIds", "Repository IDs", "98765")}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={fieldLabel}>Payload predicates · JSON Pointer paths, all must hold</span>
            <p className={sourceHint}>Predicates read original payloads, so a delivery whose payload was cleared cannot match one. Types are kept: <code>false</code>, <code>0</code>, <code>null</code> and the text &ldquo;false&rdquo; are different values.</p>
            {draft.predicates.map((predicate, index) => (
              <PredicateRow key={index} index={index} predicate={predicate} onChange={(patch) => setPredicate(index, patch)} onRemove={() => set("predicates", draft.predicates.filter((_, at) => at !== index))} />
            ))}
            <div><Button type="button" size="xs" variant="outline" disabled={draft.predicates.length >= 32} onClick={() => set("predicates", [...draft.predicates, { ...emptyPredicate }])}><PlusIcon data-icon="inline-start" />Add predicate</Button></div>
          </div>
        </div>
      </details>
      {errors.length ? <ul role="alert" className="flex flex-col gap-0.5 text-[0.72rem] text-destructive">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="submit" size="sm" disabled={disabled}>{dirty ? "Apply filter" : "Filter applied"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled || (filterIsEmpty(built.filter) && filterIsEmpty(ledger.filter))} onClick={() => { setDraft({ ...emptyDraft }); setErrors([]); store.applySourceFilter({}); }}>Clear filter</Button>
        <span className="ml-auto text-[0.66rem] text-muted-foreground">Applying starts a fresh snapshot. Filter values stay in this page only.</span>
      </div>
    </form>
  );
}

const noValue = (op: PredicateOp, type: ValueType) => op !== "exists" && op !== "starts_with" && type === "null";

function PredicateRow({ index, predicate, onChange, onRemove }: { index: number; predicate: PredicateDraft; onChange(patch: Partial<PredicateDraft>): void; onRemove(): void }) {
  const n = index + 1;
  const types = predicate.op === "one_of" ? oneOfTypes : scalarTypes;
  return (
    <div role="group" aria-label={`Predicate ${n}`} className="flex flex-col gap-1.5 rounded-md border p-2">
      <div className="flex items-center gap-1.5">
        <Input value={predicate.path} onChange={(event) => onChange({ path: event.target.value })} placeholder="/pull_request/head/ref" aria-label={`Predicate ${n} JSON Pointer path`} autoComplete="off" spellCheck={false} className="h-7 min-w-0 flex-1 font-mono text-[0.74rem]" />
        <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove predicate ${n}`} onClick={onRemove}><XIcon /></Button>
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        <NativeSelect size="sm" aria-label={`Predicate ${n} operator`} value={predicate.op} onChange={(event) => {
          const op = event.target.value as PredicateOp;
          onChange({ op, type: op === "exists" ? "boolean" : op === "starts_with" ? "string" : op === "one_of" || predicate.type !== "json" ? predicate.type : "string", value: op === "exists" ? "true" : predicate.value });
        }}>
          {predicateOps.map((item) => <NativeSelectOption key={item.op} value={item.op}>{item.label}</NativeSelectOption>)}
        </NativeSelect>
        {predicate.op === "exists" ? (
          <NativeSelect size="sm" aria-label={`Predicate ${n} existence`} value={predicate.value === "false" ? "false" : "true"} onChange={(event) => onChange({ value: event.target.value })}>
            <NativeSelectOption value="true">is present</NativeSelectOption><NativeSelectOption value="false">is absent</NativeSelectOption>
          </NativeSelect>
        ) : predicate.op === "starts_with" ? null : (
          <NativeSelect size="sm" aria-label={`Predicate ${n} value type`} value={predicate.type} onChange={(event) => onChange({ type: event.target.value as ValueType })}>
            {types.map((type) => <NativeSelectOption key={type} value={type}>{type === "json" ? "mixed (JSON per line)" : type}</NativeSelectOption>)}
          </NativeSelect>
        )}
      </div>
      {predicate.op === "exists" || noValue(predicate.op, predicate.type) ? null : predicate.op === "one_of" ? (
        <Textarea rows={2} value={predicate.value} onChange={(event) => onChange({ value: event.target.value })} aria-label={`Predicate ${n} values, one per line`} placeholder="one value per line" spellCheck={false} className="min-h-0 font-mono text-[0.74rem]" />
      ) : (
        <Input value={predicate.value} onChange={(event) => onChange({ value: event.target.value })} aria-label={`Predicate ${n} value`} placeholder={predicate.type === "boolean" ? "true or false" : predicate.type === "number" ? "number" : "text"} autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" />
      )}
    </div>
  );
}
