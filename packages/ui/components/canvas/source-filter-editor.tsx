"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { emptyPredicate, oneOfTypes, predicateOps, scalarTypes, targetLabel, type FilterDraft, type PredicateDraft, type PredicateOp, type ValueType } from "@/lib/stack/source";
import type { GithubEndpoint } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { fieldLabel } from "./scrape-shared";
import { sourceHint } from "./source-shared";

/**
 * The delivery filter's fields, shared by the Deliveries ledger and the watch creation form: one editor, one draft shape, one
 * serialization (`buildFilter`). It owns no state and applies nothing; the caller decides what a filter is for.
 */
export function FilterHint({ className }: { className?: string }) {
  return <p className={cn(sourceHint, className)}>A delivery must match every field you fill in. Several values in one field match any of them. Values are exact; repository, organization, enterprise and sender ignore case. Any event name works, including ones the catalog does not list yet.</p>;
}

export function FilterFields({ draft, setDraft, receivers, disabled = false }: {
  draft: FilterDraft; setDraft(update: (held: FilterDraft) => FilterDraft): void; receivers: GithubEndpoint[]; disabled?: boolean;
}) {
  const set = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K]) => setDraft((held) => ({ ...held, [key]: value }));
  const text = (key: "events" | "actions" | "repositories" | "organizations" | "senders" | "refs" | "enterprises" | "installationIds" | "repositoryIds", label: string, placeholder: string) => (
    <label className="flex min-w-0 flex-col gap-1"><span className={fieldLabel}>{label}</span>
      <Input value={draft[key]} disabled={disabled} onChange={(event) => set(key, event.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="h-7 font-mono text-[0.74rem]" /></label>
  );
  const setPredicate = (index: number, patch: Partial<PredicateDraft>) => set("predicates", draft.predicates.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  return (
    <>
      {receivers.length ? (
        <fieldset className="flex flex-col gap-1" disabled={disabled}><legend className={fieldLabel}>Receiver</legend>
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
            <div><Button type="button" size="xs" variant="outline" disabled={disabled || draft.predicates.length >= 32} onClick={() => set("predicates", [...draft.predicates, { ...emptyPredicate }])}><PlusIcon data-icon="inline-start" />Add predicate</Button></div>
          </div>
        </div>
      </details>
    </>
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
