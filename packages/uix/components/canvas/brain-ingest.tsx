"use client";

import { useId, useState } from "react";
import { ImportIcon, SendIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { admissionText, brainLocalReason, jobStateView } from "@/lib/stack/brain";
import type { BrainSubmission } from "@/lib/stack/store";
import { cn } from "@/lib/utils";
import { NodeLink, StatusDot, Time } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { brainUnavailable } from "./brain-shared";
import { CallErrorNote, fieldLabel } from "./scrape-shared";
import { Section, Window } from "./window";

type Draft = { key: string; kind: "url" | "text"; source: string; title: string; tags: string; collection: string; notes: string };

const fresh = (kind: Draft["kind"] = "url"): Draft => ({ key: `uix-${crypto.randomUUID()}`, kind, source: "", title: "", tags: "", collection: "", notes: "" });

/** Tags typed as words separated by commas, spaces or #. */
function parseTags(text: string): string[] {
  return [...new Set(text.split(/[\s,#]+/).map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * Submit a URL or text to Brain. Admission durably creates or finds a job; it is not indexing.
 * Each draft carries its own idempotency key, so a repeated or lost submission resolves to the
 * same job, and a failed one keeps its draft for another try.
 */
export function IngestWindow() {
  const store = useStore();
  const { setSpace } = useWorkbench();
  const { status, endpoints, brainSubmissions, remote } = useStack();
  const formId = useId();
  const [draft, setDraft] = useState<Draft>(() => fresh());
  const [submitting, setSubmitting] = useState(false);
  const blocked = brainLocalReason(remote) ?? brainUnavailable(endpoints, status);
  const invalid = draft.kind === "url" && draft.source.trim() !== "" && !/^https?:\/\/\S+$/i.test(draft.source.trim());
  const edit = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async () => {
    if (blocked || submitting || !draft.source.trim() || invalid) return;
    setSubmitting(true);
    const result = await store.brainSubmit({ key: draft.key, kind: draft.kind, source: draft.kind === "url" ? draft.source.trim() : draft.source,
      title: draft.title, tags: parseTags(draft.tags), collection: draft.collection, notes: draft.notes });
    // An admitted draft is finished. A failed or unknown one keeps its key, so trying again cannot duplicate it.
    if (result.admission) setDraft(fresh(draft.kind));
    setSubmitting(false);
  };

  return (
    <Window id="brain-ingest" title="Ingest" icon={ImportIcon} accent="brain" status={endpoints.brain ? status.brain : undefined} endpoint={endpoints.brain}
      count={brainSubmissions.length || null}>
      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <ToggleGroup value={[draft.kind]} onValueChange={(next: string[]) => { if (next.length) edit({ kind: next[0] as Draft["kind"] }); }} spacing={0} size="sm" variant="outline" aria-label="Submit" className="self-start">
          <ToggleGroupItem value="url">URL</ToggleGroupItem>
          <ToggleGroupItem value="text">Text</ToggleGroupItem>
        </ToggleGroup>
        {draft.kind === "url" ? (
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>URL</span>
            <Input type="url" value={draft.source} disabled={submitting} placeholder="https://…" spellCheck={false} autoComplete="off" aria-invalid={invalid || undefined}
              onChange={(event) => edit({ source: event.target.value })} className="h-7 font-mono text-[0.74rem]" />
            {invalid ? <span className="px-0.5 text-[0.66rem] text-destructive">Enter an http or https URL</span> : null}
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Text</span>
            <Textarea value={draft.source} disabled={submitting} placeholder="Notes, a quote, or a Markdown document" onChange={(event) => edit({ source: event.target.value })}
              className="max-h-60 min-h-24 text-[0.76rem]" />
          </label>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 flex flex-col gap-1">
            <span className={fieldLabel}>Title (optional)</span>
            <Input value={draft.title} disabled={submitting} autoComplete="off" onChange={(event) => edit({ title: event.target.value })} className="h-7 text-[0.76rem]" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Tags</span>
            <Input value={draft.tags} disabled={submitting} placeholder="research, audio" autoComplete="off" spellCheck={false} onChange={(event) => edit({ tags: event.target.value })} className="h-7 text-[0.76rem]" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Collection slug</span>
            <Input value={draft.collection} disabled={submitting} autoComplete="off" spellCheck={false} onChange={(event) => edit({ collection: event.target.value })} className="h-7 font-mono text-[0.74rem]" />
          </label>
          <label htmlFor={`${formId}-notes`} className="col-span-2 flex flex-col gap-1">
            <span className={fieldLabel}>Notes</span>
            <Textarea id={`${formId}-notes`} value={draft.notes} disabled={submitting} onChange={(event) => edit({ notes: event.target.value })} className="max-h-28 min-h-10 text-[0.74rem]" />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[0.68rem] text-pretty text-muted-foreground">
            {blocked ?? (draft.kind === "url" ? "Fetched later by the ingestion worker through Scrape" : "Indexed by the ingestion worker")}
          </span>
          <Button type="submit" size="sm" disabled={Boolean(blocked) || submitting || !draft.source.trim() || invalid} title={blocked ?? undefined}>
            {submitting ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}Submit
          </Button>
        </div>
      </form>
      {brainSubmissions.length ? (
        <Section title="Submitted from this page" aside={<span className="text-[0.65rem] text-muted-foreground">Kept until you leave</span>}>
          <ul className="flex flex-col gap-0.5">
            {brainSubmissions.map((item) => <SubmissionRow key={item.key} item={item} onDismiss={() => store.dismissBrainSubmission(item.key)} />)}
          </ul>
        </Section>
      ) : null}
      <p className="px-0.5 text-[0.66rem] text-pretty text-muted-foreground">
        Phones and browsers share into Brain once paired in{" "}
        <button type="button" onClick={() => setSpace("system")} className="underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">System → Access</button>.
      </p>
    </Window>
  );
}

function SubmissionRow({ item, onDismiss }: { item: BrainSubmission; onDismiss(): void }) {
  const store = useStore();
  const admission = item.admission;
  const share = item.share;
  const state = share?.state ?? (admission && admission.status !== "already_indexed" ? admission.state : null);
  const documentId = admission?.status === "already_indexed" ? admission.document_id : share?.document_id ?? null;
  const tone = item.error ? (item.error.uncertain ? "warning" : "destructive") : item.pending ? "muted" : state ? jobStateView[state].tone : "success";
  return (
    <li className="group/row flex flex-col gap-0.5 rounded-md px-1.5 py-1 hover:bg-muted/70">
      <div className="flex min-w-0 items-center gap-2 text-[0.74rem]">
        <StatusDot tone={tone} label={item.error ? "Not admitted" : state ? jobStateView[state].label : item.pending ? "Submitting" : "Indexed"} />
        <span className={cn("min-w-0 truncate", item.kind === "url" && "font-mono text-[0.72rem]")} title={item.label}>{item.label}</span>
        <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground"><Time at={item.at} /></span>
        <button type="button" onClick={onDismiss} aria-label={`Forget ${item.label}`} className="shrink-0 rounded-sm text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring">
          <XIcon className="size-3.5" />
        </button>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 pl-4 text-[0.66rem] text-muted-foreground">
        {item.pending ? "Submitting…" : item.error ? null : admission ? (
          <>
            {admission.status === "already_indexed" ? <span>{admissionText(admission)}</span>
              : <NodeLink node={{ kind: "ingestion-job", id: String(admission.job_id) }} label={`job ${admission.job_id}`}>{admissionText(admission)}</NodeLink>}
            {state && admission.status !== "already_indexed" ? <span>· {jobStateView[state].label.toLowerCase()}{share?.failure_class ? ` (${share.failure_class})` : ""}</span> : null}
            {documentId !== null ? <button type="button" className="text-foreground hover:underline" onClick={() => store.openBrainDocument(documentId)}>Read</button> : null}
          </>
        ) : null}
      </p>
      {item.error ? <CallErrorNote error={item.error.uncertain ? { ...item.error, text: `${item.error.text} Submitting again reuses the same key.` } : item.error} /> : null}
    </li>
  );
}
