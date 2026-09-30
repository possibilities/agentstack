"use client";

import { useState } from "react";
import { HardDriveIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime } from "@/lib/stack/derive";
import { formatBytes } from "@/lib/stack/resources";
import { localOperation, stateOperations } from "@/lib/stack/state";
import type { StateFile } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { usePagedRead } from "./owner-reads";
import { StateFlowView, useStateFlow } from "./state-flow";
import { Empty } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { Section, Window } from "./window";

type Stage = { id: string; bytes: number; received: number; digest: string; blob: string | null; createdAt: string; revision: string };
type BlobReference = { digest: string; items: { id: string; revision: number }[]; stages: { id: string }[] };
type BlobPage = { entries: StateFile[]; references: BlobReference[]; revision: string; nextOffset: number | null };
type Blob = StateFile & { digest: string; reference: BlobReference | null };

const hint = "text-[0.68rem] text-pretty text-muted-foreground";
const prefixes = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

/**
 * Collection storage: upload stages and the collection's content-addressed blobs. Stage abort is an exact-revision
 * write; CAS collection is a plan over exact unreferenced digests. Vault documents, Artifacts and their gc are
 * separate stores. Local operator only.
 */
export function ContentStorageWindow() {
  const state = useStack();
  const { remote, status, endpoints } = state;
  if (remote) {
    return (
      <Window id="content-storage" title="Storage" icon={HardDriveIcon} accent="content" empty>
        <div className="flex flex-col items-center gap-1.5 p-6 text-center">
          <HardDriveIcon className="size-5 text-muted-foreground/70" />
          <p className="text-sm font-medium">Available only on the local UI</p>
          <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">Upload stages and collection storage are local operator state.</p>
        </div>
      </Window>
    );
  }
  const access = localOperation(state, "content", "blob_stage_list");
  return (
    <Window id="content-storage" title="Storage" subtitle="collection uploads and blobs" icon={HardDriveIcon} accent="content" status={status.content} endpoint={endpoints.content}>
      {!access.available ? <p className={hint}>{access.reason}</p> : (
        <div className="flex flex-col gap-2">
          <p className={hint}>
            Collection files are stored once by content digest. An item and a finalized upload stage each hold their own reference, so deleting an item can still leave its stage holding the blob.
            Vault document history, named Artifacts and Git remotes or backups keep their own copies.
          </p>
          <Stages />
          <Blobs />
        </div>
      )}
    </Window>
  );
}

function Stages() {
  const store = useStore();
  const now = useNow(60_000);
  const { contentGeneration } = useStack();
  const [aborting, setAborting] = useState<Stage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = usePagedRead<Stage>((offset) => store.call<{ stages: Stage[]; nextOffset: number | null }>("content", "blob_stage_list", { offset, limit: 100 })
    .then((page) => ({ items: page.stages, revision: "stages", nextOffset: page.nextOffset })), "stages", contentGeneration);
  const listed = aborting ? pages.page?.items.find((stage) => stage.id === aborting.id) ?? null : null;
  const changed = aborting !== null && listed !== null && listed.revision !== aborting.revision;
  const abort = () => {
    if (!aborting) return;
    const target = aborting;
    setPending(true);
    store.call("content", "blob_stage_abort", { id: target.id, expectedRevision: target.revision })
      .then(() => { setAborting(null); toast.success("Upload stage retired"); }, (cause) => setError(errorMessage(cause)))
      .finally(() => { setPending(false); pages.refresh(); });
  };
  return (
    <Section title="Upload stages" aside={<Button size="xs" variant="ghost" className="-mr-1.5 h-5 text-[0.65rem]" disabled={pages.loading} onClick={pages.refresh}>{pages.loading ? <Spinner /> : "Refresh"}</Button>}>
      {pages.error ? <p className="text-xs text-destructive">Upload stages unavailable: {pages.error}</p> : null}
      {pages.page ? pages.page.items.length ? (
        <ul aria-label="Upload stages" className="flex flex-col gap-1">
          {pages.page.items.map((stage) => (
            <li key={stage.id} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-muted/50">
              <span className={cn("w-16 shrink-0", stage.blob ? "text-foreground" : "text-muted-foreground")}>{stage.blob ? "finalized" : "staging"}</span>
              <code className="min-w-0 truncate font-mono text-[0.66rem]" title={`Stage ${stage.id} · digest ${stage.digest}`}>{stage.id}</code>
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{stage.blob ? formatBytes(stage.bytes) : `${formatBytes(stage.received)} / ${formatBytes(stage.bytes)}`}</span>
              <span className="w-16 shrink-0 text-right text-muted-foreground">{relativeTime(Date.parse(stage.createdAt), now)}</span>
              <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={`Retire stage ${stage.id}`} onClick={() => { setError(null); setAborting(stage); }}><Trash2Icon /></Button>
            </li>
          ))}
        </ul>
      ) : <p className={hint}>No upload stages are held.</p> : null}
      {pages.page?.nextOffset != null ? <Button size="xs" variant="ghost" className="self-start" onClick={pages.more}>Load more</Button> : null}
      <AlertDialog open={aborting !== null} onOpenChange={(open) => { if (!open && !pending) setAborting(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
            <AlertDialogTitle>Retire this upload stage?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span className="font-mono text-[0.68rem] break-all">{aborting?.id} · revision {aborting?.revision}</span>
              <span>Staging bytes are removed and this upload can never resume under the same client key. Items that use the file keep it.
                {aborting?.blob ? " This stage stops holding its blob, which a later storage plan can collect if nothing else references it." : ""}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {changed ? <p role="alert" className="text-[0.72rem] text-warning">This stage changed since you chose it. Close and review it first.</p> : null}
          {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={pending || changed} onClick={abort}>{pending ? <Spinner data-icon="inline-start" /> : null}Retire stage</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function Blobs() {
  const store = useStore();
  const state = useStack();
  const [prefix, setPrefix] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const pages = usePagedRead<Blob>((offset, revision) => prefix ? store.call<BlobPage>("content", "content_blob_list", { prefix, offset, limit: 100, ...(revision ? { revision } : {}) })
    .then((page) => ({ revision: page.revision, nextOffset: page.nextOffset, items: page.entries.map((entry) => {
      const digest = entry.path.split("/").at(-1) ?? entry.path;
      return { ...entry, digest, reference: page.references.find((row) => row.digest === digest) ?? null };
    }) })) : Promise.resolve({ items: [], revision: "none", nextOffset: null }), `blobs:${prefix}`, state.contentGeneration);
  const flow = useStateFlow({ operations: stateOperations(store.call, "content", { plan: "content_storage_plan", apply: "content_storage_collect", receipt: "content_state_receipt_get" }, { digests: selected }),
    recoveryKey: "content:storage" });
  const locked = flow.flow.phase !== "idle";
  const referenced = (blob: Blob) => Boolean(blob.reference && (blob.reference.items.length || blob.reference.stages.length));
  return (
    <Section title="Collection blobs">
      <div className="flex items-center gap-1.5">
        <NativeSelect size="sm" aria-label="Digest prefix" className="min-w-0 flex-1" value={prefix ?? ""} disabled={locked} onChange={(event) => { setPrefix(event.target.value || null); setSelected([]); }}>
          <NativeSelectOption value="">Choose a digest prefix</NativeSelectOption>
          {prefixes.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
        </NativeSelect>
        {prefix ? <Button size="xs" variant="ghost" disabled={pages.loading} onClick={pages.refresh}>{pages.loading ? <Spinner /> : "Refresh"}</Button> : null}
      </div>
      <p className={hint}>Blobs are listed one two-character digest prefix at a time. One prefix says nothing about the others.</p>
      {pages.error ? <p className="text-xs text-destructive">{/missing|ENOENT|unavailable/i.test(pages.error) ? `Nothing is stored under ${prefix}, or it cannot be read: ${pages.error}` : pages.error}</p> : null}
      {pages.page?.restarted ? <p role="status" className="text-xs text-warning">This prefix changed while paging, so it started again from the first page.</p> : null}
      {prefix && pages.page ? pages.page.items.length ? (
        <ul aria-label="Collection blobs" className="flex max-h-64 flex-col overflow-auto">
          {pages.page.items.map((blob) => (
            <li key={blob.digest} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-muted/50">
              <input type="checkbox" className="size-3.5 accent-destructive" aria-label={`Select blob ${blob.digest}`} checked={selected.includes(blob.digest)}
                disabled={locked || referenced(blob) || (!selected.includes(blob.digest) && selected.length >= 100)}
                title={referenced(blob) ? "Still referenced" : undefined}
                onChange={() => setSelected(selected.includes(blob.digest) ? selected.filter((item) => item !== blob.digest) : [...selected, blob.digest])} />
              <code className="min-w-0 truncate font-mono text-[0.66rem]" title={blob.digest}>{blob.digest}</code>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {referenced(blob) ? `${blob.reference!.items.length} item${blob.reference!.items.length === 1 ? "" : "s"} · ${blob.reference!.stages.length} stage${blob.reference!.stages.length === 1 ? "" : "s"}` : "unreferenced"}
              </span>
              <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">{formatBytes(blob.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : <Empty icon={HardDriveIcon} title={`No blobs under ${prefix}`} /> : null}
      {pages.page?.nextOffset != null ? <Button size="xs" variant="ghost" className="self-start" onClick={pages.more}>Load more</Button> : null}
      <StateFlowView controls={flow} label={`Prepare collecting ${selected.length} blob${selected.length === 1 ? "" : "s"}`} applyLabel="Collect these blobs"
        unavailable={state.status.content !== "open" ? "The content connection is not open." : !selected.length ? "Select unreferenced blobs first." : null} />
    </Section>
  );
}
