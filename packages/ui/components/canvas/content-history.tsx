"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { localOperation, type Page } from "@/lib/stack/state";
import type { ContentVaultHistoryEntry, ContentVaultHistoryPage } from "@/lib/stack/types";
import { usePagedRead } from "./owner-reads";
import { useStack, useStore } from "./provider";

const hint = "text-xs text-pretty text-muted-foreground";

/** Disclosure only: no StatePlan admission, apply, Git writes or device reset. */
export function ContentVaultHistory({ slug }: { slug?: string }) {
  const state = useStack();
  const [open, setOpen] = useState(false);
  if (!localOperation(state, "content", "content_vault_history_plan").available) return null;
  return <details className="rounded-lg border border-dashed" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-2.5 py-1.5 text-[0.72rem] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Retained history</summary>
    {open ? <div className="flex min-w-0 flex-col gap-2 border-t border-dashed p-2.5">
      <p className={hint}>Read-only exact-slug paths, commits and blobs reachable from local refs/reflogs. This does not read bodies, rewrite Git or erase remote, backup or device copies.</p>
      {slug ? <HistoryReader key={slug} slug={slug} /> : <ExactSlugHistory />}
    </div> : null}
  </details>;
}

function ExactSlugHistory() {
  const id = useId();
  const [value, setValue] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const exact = value.trim();
  // History accepts exact slugs up to 255 characters, unlike new-document title slugification.
  const valid = exact.length <= 255 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exact);
  const state = useStack();
  return <>
    <form aria-label="Inspect removed document history" onSubmit={(event) => { event.preventDefault(); if (valid && state.status.content === "open") setSlug(exact); }}>
      <FieldGroup className="gap-2">
        <Field data-invalid={Boolean(exact && !valid) || undefined}>
          <FieldLabel htmlFor={id}>Exact document slug</FieldLabel>
          <Input id={id} className="font-mono text-xs" value={value} aria-invalid={Boolean(exact && !valid)} aria-describedby={`${id}-hint`} autoComplete="off"
            onChange={(event) => { setValue(event.target.value); setSlug(null); }} />
          <FieldDescription id={`${id}-hint`}>Removed documents are not listed. Enter the exact lowercase, hyphen-separated slug; no fuzzy lookup or restore occurs.</FieldDescription>
        </Field>
        <Button type="submit" size="xs" className="self-start" disabled={!valid || state.status.content !== "open"}>Inspect history</Button>
      </FieldGroup>
    </form>
    {state.status.content !== "open" ? <p role="status" className={hint}>The Content connection is not open.</p> : null}
    {slug ? <HistoryReader key={slug} slug={slug} /> : null}
  </>;
}

function HistoryReader({ slug }: { slug: string }) {
  const store = useStore();
  const state = useStack();
  const pages = usePagedRead<ContentVaultHistoryEntry>(async (offset, revision) => {
    if (state.status.content !== "open") throw new Error("The Content connection is not open.");
    const page = await store.call<ContentVaultHistoryPage>("content", "content_vault_history_plan", { slugs: [slug], offset, limit: 50, ...(revision ? { revision } : {}) });
    return { ...page, items: page.entries };
  }, `content:vault-history:${slug}:${state.status.content}`, state.contentGeneration);
  const page = pages.page as (Page<ContentVaultHistoryEntry> & Pick<ContentVaultHistoryPage, "commitsScanned" | "paths" | "remotes" | "retained">) | null;
  return <section aria-label={`Retained history for ${slug}`} className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 break-all text-xs">{slug}</code>
      <Button size="xs" variant="ghost" disabled={pages.loading || state.status.content !== "open"} onClick={pages.refresh}>{pages.loading ? <Spinner data-icon="inline-start" /> : null}Refresh history</Button>
    </div>
    {pages.error ? <p role="alert" className="text-xs text-destructive">Retained history inspection failed: {pages.error}. Coverage is unavailable, not proof that no bodies remain.</p> : null}
    {page?.restarted ? <p role="status" className="text-xs text-warning">Vault history changed while paging; restarted from the first page.</p> : null}
    {page && !pages.error ? <>
      <p className={hint}>{page.commitsScanned} commits scanned · {page.items.length} entries loaded{page.nextOffset !== null ? " · more available" : ""}</p>
      <ul aria-label="Observed Vault paths" className="flex flex-col gap-1 text-xs">
        {page.paths.map((path) => <li key={`${path.slug}:${path.path}`}><code className="break-all">{path.path}</code> · {path.current ? "current path" : "historical path"}</li>)}
      </ul>
      <ul aria-label="Retained commit and blob entries" className="flex max-h-64 flex-col gap-2 overflow-auto text-xs">
        {page.items.map((entry) => <li key={`${entry.slug}:${entry.path}:${entry.commit}`} className="flex min-w-0 flex-col gap-0.5">
          <code className="break-all">{entry.slug} · {entry.path}</code>
          <span>Commit <code className="break-all">{entry.commit}</code></span>
          <span>Blob <code className="break-all">{entry.blob}</code> · mode <code>{entry.mode}</code></span>
        </li>)}
      </ul>
      {!page.items.length ? <p className={hint}>No matching retained entries in the observed local refs/reflogs. External and unobservable copies may remain.</p> : null}
      <p className={hint}>Remote presence (names only; contents not inspected):</p>
      {page.remotes.length ? <ul aria-label="Vault remote presence" className="text-xs">
        {page.remotes.map((remote) => <li key={remote.name}><code className="break-all">{remote.name}</code> · fetch {remote.fetch ? "present" : "absent"} · push {remote.push ? "present" : "absent"}</li>)}
      </ul> : <p className={hint}>No remotes configured in this observation; clones and backups remain unobservable.</p>}
      {page.retained.map((text, index) => <p key={index} className={hint}>{text}</p>)}
      {page.nextOffset !== null ? <Button size="xs" variant="ghost" className="self-start" disabled={pages.loading} onClick={pages.more}>Load more history</Button> : null}
    </> : null}
  </section>;
}
