"use client";

import { useMemo, useState } from "react";
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { describeFilter, draftFromFilter, emptyDraft, filterIsEmpty, type FilterDraft } from "@/lib/stack/source";
import { freezeWatch, maxWatchLabel, startWords, type FrozenWatch, type WatchStart } from "@/lib/stack/source-watches";
import type { GithubFilter, GithubWatch } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "./primitives";
import { useStack, useStore } from "./provider";
import { fieldLabel } from "./scrape-shared";
import { FilterFields, FilterHint } from "./source-filter-editor";
import { sourceHint, sourceLabel } from "./source-shared";

type Step =
  | { name: "edit" }
  | { name: "review"; frozen: FrozenWatch; notes: string[] }
  | { name: "creating"; frozen: FrozenWatch }
  /** The owner's answer was not a clear refusal. `confirmed` is what reading the watch back said: created, absent, or unknown. */
  | { name: "failed"; frozen: FrozenWatch; error: string; confirmed: "created" | "absent" | "unknown" }
  | { name: "created"; watch: GithubWatch };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Create a watch: an immutable filter, frozen and shown whole before it is sent. The same UUID with the same definition is
 * idempotent at the owner, so a lost answer is resolved by reading the watch back, never by guessing. Editing an existing
 * watch's filter is not a thing: a changed filter is a new watch.
 */
export function CreateWatch({ initialFilter, count, onClose }: { initialFilter: GithubFilter | null; count: number; onClose(): void }) {
  const store = useStore();
  const { sourceEndpoints, sourceStatus, sourceLedger } = useStack();
  const [id, setId] = useState(() => crypto.randomUUID());
  const [label, setLabel] = useState("");
  const [draft, setDraft] = useState<FilterDraft>(() => initialFilter ? draftFromFilter(initialFilter) : { ...emptyDraft });
  const [start, setStart] = useState<WatchStart>({ kind: "now" });
  const [errors, setErrors] = useState<string[]>([]);
  const [step, setStep] = useState<Step>({ name: "edit" });
  const latest = sourceStatus.data?.latestSequence ?? null;
  const ledgerHasFilter = !filterIsEmpty(sourceLedger.filter);
  const ledgerWords = useMemo(() => describeFilter(sourceLedger.filter).map((item) => `${item.label}: ${item.values.join(" or ")}`).join(" · "), [sourceLedger.filter]);

  const review = () => {
    const result = freezeWatch({ id, label, filter: draft, start }, latest);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors([]);
    setStep({ name: "review", frozen: result.frozen, notes: result.notes });
  };

  /** Send exactly the reviewed request. If the answer is not a clear one, read the watch back: the UUID makes a repeat safe, and the read says whether it exists. */
  const create = async (frozen: FrozenWatch) => {
    setStep({ name: "creating", frozen });
    try {
      const watch = await store.createSourceWatch({ ...frozen.input });
      store.selectSourceWatch(watch.id);
      setStep({ name: "created", watch });
    } catch (error) {
      const text = errorText(error);
      let confirmed: "created" | "absent" | "unknown" = "unknown";
      try { await store.call("source", "github_watch_get", { id: frozen.input.id }); confirmed = "created"; } catch (readError) {
        if (/github_watch_not_found/.test(errorText(readError))) confirmed = "absent";
      }
      setStep({ name: "failed", frozen, error: text, confirmed });
    }
  };

  if (step.name === "created") {
    return (
      <section aria-label="Watch created" className="flex flex-col gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-[0.76rem]">
        <p role="status"><span className="font-semibold">Created “{step.watch.label}”.</span> It records matches from #{step.watch.startAfter + 1}; its consumption cursor is #{step.watch.acknowledgedThrough}. Nothing is attached to it: an agent subscribes separately (see its examples).</p>
        <div><Button size="sm" variant="outline" onClick={onClose}>Done</Button></div>
      </section>
    );
  }

  const frozen = step.name === "edit" ? null : step.frozen;
  return (
    <form aria-label="New watch" className="flex flex-col gap-2.5 rounded-lg border bg-background/60 p-3" onSubmit={(event) => { event.preventDefault(); if (step.name === "edit") review(); }}>
      <div className="flex items-center gap-2">
        <span className="text-[0.82rem] font-semibold">New watch</span>
        <span className="text-[0.68rem] text-muted-foreground tabular-nums">{count} of 128 used</span>
        <Button type="button" size="icon-xs" variant="ghost" className="ml-auto" aria-label="Close the new watch form" disabled={step.name === "creating"} onClick={onClose}><XIcon /></Button>
      </div>
      {step.name === "edit" ? (
        <>
          <p className={sourceHint}>A watch is a durable inbox of the deliveries that match its filter. The filter is immutable: to match something different, create another watch. Creating one attaches nothing and acknowledges nothing.</p>
          <div className="flex flex-col gap-1">
            <span className={fieldLabel}>Watch ID</span>
            <span className="flex items-center gap-1.5"><code className="min-w-0 truncate font-mono text-[0.72rem]" title={id}>{id}</code><CopyButton value={id} label="watch ID" className="opacity-100" />
              <Button type="button" size="xs" variant="ghost" onClick={() => setId(crypto.randomUUID())}><RefreshCwIcon data-icon="inline-start" />New ID</Button></span>
            <span className={sourceHint}>The ID is the idempotency key: sending the same ID with the same definition again returns the same watch.</span>
          </div>
          <label className="flex flex-col gap-1"><span className={fieldLabel}>Label</span>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={maxWatchLabel} placeholder="Pull requests in owner/project" autoComplete="off" className="h-7 text-[0.78rem]" /></label>
          <fieldset className="flex flex-col gap-2 rounded-lg border p-2.5">
            <legend className={cn(sourceLabel, "px-1")}>Filter · immutable</legend>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button type="button" size="xs" variant="outline" disabled={!ledgerHasFilter} onClick={() => setDraft(draftFromFilter(sourceLedger.filter))}
                title={ledgerHasFilter ? ledgerWords : "The Deliveries ledger has no filter applied"}>From current ledger filter</Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setDraft({ ...emptyDraft })}>Clear filter</Button>
              <span className="text-[0.68rem] text-muted-foreground">{ledgerHasFilter ? <span title={ledgerWords}>Ledger: {ledgerWords.length > 70 ? `${ledgerWords.slice(0, 70)}…` : ledgerWords}</span> : "The ledger shows every delivery."}</span>
            </div>
            <FilterHint />
            <FilterFields draft={draft} setDraft={setDraft} receivers={sourceEndpoints.data ?? []} />
          </fieldset>
          <fieldset className="flex flex-col gap-1.5 rounded-lg border p-2.5">
            <legend className={cn(sourceLabel, "px-1")}>Start</legend>
            <label className="flex items-start gap-1.5 text-[0.76rem]">
              <input type="radio" name="watch-start" checked={start.kind === "now"} onChange={() => setStart({ kind: "now" })} className="mt-0.5" />
              <span><span className="font-medium">Now (default)</span><span className="block text-[0.7rem] text-muted-foreground">Matches arrivals after the newest local sequence{latest !== null ? ` (#${latest} now)` : ""}. Nothing already stored is examined.</span></span>
            </label>
            <label className="flex items-start gap-1.5 text-[0.76rem]">
              <input type="radio" name="watch-start" checked={start.kind === "after"} onChange={() => setStart({ kind: "after", text: start.kind === "after" ? start.text : "" })} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-1"><span className="font-medium">Backfill after sequence N</span>
                <span className="block text-[0.7rem] text-muted-foreground">Also records retained deliveries after N that match. A payload predicate cannot match a delivery whose original payload was cleared.</span>
                {start.kind === "after" ? (
                  <Input inputMode="numeric" aria-label="Backfill after sequence" value={start.text} onChange={(event) => setStart({ kind: "after", text: event.target.value })} placeholder={latest !== null ? `0 to ${latest}` : "0"} autoComplete="off" className="h-7 w-32 font-mono text-[0.74rem]" />
                ) : null}
              </span>
            </label>
          </fieldset>
          {errors.length ? <ul role="alert" className="flex flex-col gap-0.5 text-[0.72rem] text-destructive">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="submit" size="sm"><PlusIcon data-icon="inline-start" />Review definition</Button>
            <span className="text-[0.68rem] text-muted-foreground">Nothing is created until you confirm the review.</span>
          </div>
        </>
      ) : frozen ? (
        <>
          <p className={sourceHint}>Review the definition as it will be sent. It cannot be edited after creation; remove the watch and create another to change it.</p>
          <dl aria-label="Frozen definition" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.76rem]">
            <dt className="text-muted-foreground">Label</dt><dd className="min-w-0 break-words font-medium">{frozen.input.label}</dd>
            <dt className="text-muted-foreground">ID</dt><dd className="min-w-0 break-all font-mono text-[0.7rem]">{frozen.input.id}</dd>
            <dt className="text-muted-foreground">Start</dt><dd className="text-[0.72rem]">{startWords(frozen.input.start, latest)}</dd>
            <dt className="text-muted-foreground">Matches</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {describeFilter(frozen.input.filter, (receiver) => (sourceEndpoints.data ?? []).find((item) => item.id === receiver)?.label ?? receiver).map((item, index) => (
                <span key={`${item.label}:${index}`} className="flex max-w-full min-w-0 items-baseline gap-1 rounded-md bg-muted px-1.5 py-px text-[0.68rem]"><span className="shrink-0 font-medium">{item.label}</span><span className="truncate font-mono" title={item.values.join(" · ")}>{item.values.join(" · ")}</span></span>
              ))}
              {filterIsEmpty(frozen.input.filter) ? <span className="text-muted-foreground">every delivery</span> : null}
            </dd>
          </dl>
          <details className="rounded-lg border border-dashed">
            <summary className="cursor-pointer px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Exact request</summary>
            <pre aria-label="Exact github_watch_create request" className="max-h-56 overflow-auto border-t border-dashed p-2.5 font-mono text-[0.68rem] break-words whitespace-pre-wrap">{frozen.json}</pre>
          </details>
          {step.name === "review" && step.notes.length ? <ul aria-label="Cautions" className="flex flex-col gap-1 text-[0.72rem] text-warning">{step.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
          {step.name === "failed" ? (
            <div role="alert" className="flex flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-2 text-[0.74rem]">
              <p><span className="font-semibold">{step.confirmed === "created" ? "The watch exists." : step.confirmed === "absent" ? "The watch was not created." : "Result not confirmed."}</span> {step.error}</p>
              <p>{step.confirmed === "created" ? "Reading it back shows it was created; the answer was lost. Nothing else was sent."
                : step.confirmed === "absent" ? "Reading it back shows it does not exist. Creating again sends the same reviewed request."
                : "The watch could not be read back, so it may or may not exist. Creating again with this ID and this exact definition is safe: it returns the existing watch, never a second one."}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {step.name === "failed" && step.confirmed === "created" ? (
              <Button type="button" size="sm" onClick={() => { store.selectSourceWatch(frozen.input.id); onClose(); }}>Open the watch</Button>
            ) : (
              <Button type="button" size="sm" disabled={step.name === "creating"} onClick={() => void create(frozen)}>
                {step.name === "creating" ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}{step.name === "failed" ? "Create again (same ID)" : "Create watch"}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" disabled={step.name === "creating"} onClick={() => setStep({ name: "edit" })}><ArrowLeftIcon data-icon="inline-start" />Back to edit</Button>
          </div>
        </>
      ) : null}
    </form>
  );
}
