"use client";

import { createContext, use, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArchiveRestoreIcon, FolderPlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { slugify, validSlug } from "@/lib/stack/content";
import type { Draft } from "@/lib/stack/roles";
import { nodeKey, type ContentCollection, type ContentItem, type NodeRef } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { useStack, useStore, useWorkbench } from "./provider";

/** What the Content editor shows. A new document is a draft until created. */
export type ContentTarget = { kind: "document"; slug: string } | { kind: "item"; id: string } | { kind: "new-document" };
/** What the Content preview shows. An artifact without a version shows its latest. */
export type ContentSelection = { kind: "document"; slug: string } | { kind: "item"; id: string } | { kind: "artifact"; name: string; version?: string };

export const contentTargetKey = (target: ContentTarget): string =>
  target.kind === "document" ? `document:${target.slug}` : target.kind === "item" ? `item:${target.id}` : "new-document";

type ArtifactRemoval = { name: string; version?: string };

type ContentActions = {
  target: ContentTarget | null;
  edit(target: ContentTarget | null): void;
  selection: ContentSelection | null;
  preview(selection: ContentSelection | null): void;
  /** Show a document or document item in both the editor and the preview; other items only preview. */
  open(record: { kind: "document"; slug: string } | { kind: "item"; id: string; itemKind?: ContentItem["kind"] }): void;
  drafts: Record<string, Draft>;
  setDraft(key: string, draft: Draft | null): void;
  /** Keys of writes in flight, so each control can show its own pending state. */
  pending: ReadonlySet<string>;
  /** Run one content operation with a pending key; the store re-reads content after writes. */
  run<T>(key: string, name: string, args: Record<string, unknown>): Promise<T>;
  confirmRemoveDocument(document: { slug: string; title: string }): void;
  confirmDeleteItem(item: ContentItem): void;
  confirmDeleteCollection(collection: ContentCollection): void;
  /** Create (null) or edit a collection's title and description. */
  editCollection(collection: ContentCollection | null): void;
  confirmRemoveArtifact(removal: ArtifactRemoval): void;
  restoreByName(kind: "document" | "artifact"): void;
  /** Choose files to upload into a collection, or ungrouped with null. */
  upload(collection: string | null): void;
};

const ContentActionsContext = createContext<ContentActions | null>(null);

export function useContentActions(): ContentActions {
  const value = use(ContentActionsContext);
  if (!value) throw new Error("useContentActions requires ContentActionsProvider");
  return value;
}

/** The first line of a Content CLI-style error names its code; the second explains it. */
export function contentError(error: unknown): string {
  const lines = errorMessage(error).split("\n").filter(Boolean);
  return lines.length > 1 && /^[a-z_]+$/.test(lines[0]!) ? lines.slice(1).join(" ") : lines.join(" ");
}

const contentKinds = new Set(["document", "collection", "item", "artifact"]);

export function ContentActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { contentGeneration, status } = useStack();
  const { selected } = useWorkbench();
  const [target, setTarget] = useState<ContentTarget | null>(null);
  const [selection, setSelection] = useState<ContentSelection | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [removingDocument, setRemovingDocument] = useState<{ slug: string; title: string } | null>(null);
  const [deletingItem, setDeletingItem] = useState<ContentItem | null>(null);
  const [deletingCollection, setDeletingCollection] = useState<ContentCollection | null>(null);
  const [collectionForm, setCollectionForm] = useState<{ collection: ContentCollection | null } | null>(null);
  const [removingArtifact, setRemovingArtifact] = useState<ArtifactRemoval | null>(null);
  const [restoring, setRestoring] = useState<"document" | "artifact" | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickerCollection = useRef<string | null>(null);
  const draftsRef = useRef(drafts);
  useEffect(() => { draftsRef.current = drafts; }, [drafts]);

  const setDraft = useCallback((key: string, draft: Draft | null) => setDrafts((current) => {
    const next = { ...current };
    if (draft && Object.keys(draft.values).length) next[key] = draft;
    else delete next[key];
    return next;
  }), []);

  const run = useCallback(async <T,>(key: string, name: string, args: Record<string, unknown>): Promise<T> => {
    setPending((current) => new Set(current).add(key));
    try {
      return await store.call<T>("content", name, args);
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }, [store]);

  const open = useCallback((record: { kind: "document"; slug: string } | { kind: "item"; id: string; itemKind?: ContentItem["kind"] }) => {
    if (record.kind === "document") {
      setTarget({ kind: "document", slug: record.slug });
      setSelection({ kind: "document", slug: record.slug });
      return;
    }
    if (!record.itemKind || record.itemKind === "document") setTarget({ kind: "item", id: record.id });
    setSelection({ kind: "item", id: record.id });
  }, []);

  // Leaving the page drops unsaved drafts and interrupts uploads, so ask first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const uploading = store.getState().contentUploads.some((upload) => ["hashing", "uploading", "storing"].includes(upload.phase));
      if (Object.keys(draftsRef.current).length || uploading) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [store]);

  // The inspector shows the stored record: re-read an inspected content record after every invalidation.
  const inspected = selected && contentKinds.has(selected.kind) && "id" in selected ? selected : null;
  const inspectedKey = inspected ? nodeKey(inspected) : null;
  useEffect(() => {
    if (!inspected || !inspectedKey || status.content !== "open") return;
    let live = true;
    const read = readContentRecord(store, inspected);
    read.then((record) => { if (live) store.rememberContent(inspectedKey, record); },
      (error) => { if (live && /not[ _]found|no such|unknown/i.test(errorMessage(error))) store.rememberContent(inspectedKey, null); });
    return () => { live = false; };
  }, [inspectedKey, contentGeneration, status.content]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = useCallback((collection: string | null) => {
    pickerCollection.current = collection;
    picker.current?.click();
  }, []);

  const value = useMemo<ContentActions>(() => ({
    target, edit: setTarget, selection, preview: setSelection, open, drafts, setDraft, pending, run,
    confirmRemoveDocument: setRemovingDocument, confirmDeleteItem: setDeletingItem, confirmDeleteCollection: setDeletingCollection,
    editCollection: (collection) => setCollectionForm({ collection }), confirmRemoveArtifact: setRemovingArtifact,
    restoreByName: setRestoring, upload,
  }), [target, selection, open, drafts, setDraft, pending, run, upload]);

  return (
    <ContentActionsContext value={value}>
      {children}
      <input ref={picker} type="file" multiple hidden aria-hidden tabIndex={-1} onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length) store.uploadContent(files, pickerCollection.current);
      }} />
      <RemoveDocumentDialog document={removingDocument} onClose={() => setRemovingDocument(null)} run={run} pending={pending} />
      <DeleteItemDialog item={deletingItem} onClose={() => setDeletingItem(null)} run={run} pending={pending}
        onDeleted={(id) => {
          setDraft(`item:${id}`, null);
          store.rememberContent(`item:${id}`, null);
        }} />
      <DeleteCollectionDialog collection={deletingCollection} onClose={() => setDeletingCollection(null)} run={run} pending={pending} />
      <CollectionDialog form={collectionForm} onClose={() => setCollectionForm(null)} run={run} pending={pending} />
      <RemoveArtifactDialog removal={removingArtifact} onClose={() => setRemovingArtifact(null)} run={run} pending={pending} />
      <RestoreDialog kind={restoring} onClose={() => setRestoring(null)} run={run} pending={pending}
        onRestored={(kind, name) => kind === "document" ? setSelection({ kind: "document", slug: name }) : setSelection({ kind: "artifact", name })} />
    </ContentActionsContext>
  );
}

/** One stored content record for the inspector, without bodies or bytes. */
function readContentRecord(store: ReturnType<typeof useStore>, ref: NodeRef): Promise<Record<string, unknown>> {
  const id = "id" in ref ? ref.id : "";
  switch (ref.kind) {
    case "document": return store.call<Record<string, unknown>>("content", "get", { ref: id, "meta-only": true }).then(({ content: _content, ...meta }) => meta);
    case "item": return store.call<Record<string, unknown>>("content", "item_get", { id }).then(({ content: _content, base64: _base64, ...meta }) => meta);
    case "collection": return store.call<Record<string, unknown>>("content", "collection_get", { collection: id });
    case "artifact": return store.call<Record<string, unknown>>("content", "artifacts_show", { name: id });
    default: return Promise.reject(new Error("not a content record"));
  }
}

type Run = ContentActions["run"];

function RemoveDocumentDialog({ document, onClose, run, pending }: { document: { slug: string; title: string } | null; onClose(): void; run: Run; pending: ReadonlySet<string> }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = document ? `rm:${document.slug}` : "";
  const busy = pending.has(key);
  useEffect(() => { setReason(""); setError(null); }, [document?.slug]);
  const remove = () => {
    if (!document || !reason.trim() || busy) return;
    const { slug, title } = document;
    run(key, "rm", { ref: slug, reason: reason.trim() }).then(() => {
      onClose();
      toast.success(`Removed “${title}”`, { action: { label: "Restore", onClick: () => { run(`restore:${slug}`, "restore", { ref: slug }).then(() => toast.success(`Restored “${title}”`), (cause) => toast.error(contentError(cause))); } } });
    }, (cause) => setError(contentError(cause)));
  };
  return (
    <AlertDialog open={document !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>Remove “{document?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It leaves search, lists and its <span className="font-mono">/d/{document?.slug}</span> link, and the reason is recorded in the file. Restore brings it back with the same slug.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); remove(); }}>
          <Field data-invalid={Boolean(error) || undefined}>
            <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
            <Textarea id={`${id}-reason`} value={reason} rows={2} autoFocus placeholder="Why it is being removed" onChange={(event) => setReason(event.target.value)} className="resize-none" />
            {error ? <FieldDescription role="alert" className="text-destructive">{error}</FieldDescription> : null}
          </Field>
        </form>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!reason.trim() || busy} onClick={remove}>
            {busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteItemDialog({ item, onClose, run, pending, onDeleted }: { item: ContentItem | null; onClose(): void; run: Run; pending: ReadonlySet<string>; onDeleted(id: string): void }) {
  const [error, setError] = useState<string | null>(null);
  const key = item ? `delete:${item.id}` : "";
  const busy = pending.has(key);
  useEffect(() => setError(null), [item?.id]);
  const remove = () => {
    if (!item || busy) return;
    run(key, "item_delete", { id: item.id, expectedRevision: item.revision }).then(() => {
      onDeleted(item.id);
      onClose();
      toast.success(`Deleted “${item.name}”`);
    }, (cause) => setError(/revision conflict/.test(errorMessage(cause)) ? "It changed since this list was read. Review the new version, then delete again." : contentError(cause)));
  };
  return (
    <AlertDialog open={item !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>Delete “{item?.name}” permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            This can’t be undone. Its shared link <span className="font-mono">{item?.url}</span> stops working for everyone who has it. No collection is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-[0.8rem] text-pretty text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            {busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Delete permanently
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteCollectionDialog({ collection, onClose, run, pending }: { collection: ContentCollection | null; onClose(): void; run: Run; pending: ReadonlySet<string> }) {
  const { contentLibrary } = useStack();
  const [error, setError] = useState<string | null>(null);
  const key = collection ? `collection-delete:${collection.slug}` : "";
  const busy = pending.has(key);
  const count = collection ? contentLibrary.data?.counts.byCollection[collection.slug] ?? null : null;
  useEffect(() => setError(null), [collection?.slug]);
  const remove = () => {
    if (!collection || busy) return;
    run(key, "collection_delete", { collection: collection.slug }).then(() => { onClose(); toast.success(`Deleted collection “${collection.title}”`); }, (cause) => setError(contentError(cause)));
  };
  return (
    <AlertDialog open={collection !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>Delete collection “{collection?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {count === null ? "Its items" : count === 1 ? "Its 1 item" : `Its ${count} items`} become ungrouped. Items keep their IDs, bytes and shared links; only the grouping goes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-[0.8rem] text-pretty text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            {busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Delete collection
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CollectionDialog({ form, onClose, run, pending }: { form: { collection: ContentCollection | null } | null; onClose(): void; run: Run; pending: ReadonlySet<string> }) {
  const id = useId();
  const store = useStore();
  const editing = form?.collection ?? null;
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = editing ? `collection-save:${editing.slug}` : "collection-create";
  const busy = pending.has(key);
  useEffect(() => {
    if (!form) return;
    setTitle(form.collection?.title ?? "");
    setSlug(form.collection?.slug ?? "");
    setSlugTouched(false);
    setDescription(form.collection?.description ?? "");
    setError(null);
  }, [form]);
  const effectiveSlug = editing ? editing.slug : slugTouched ? slug : slugify(title);
  const valid = title.trim().length > 0 && title.length <= 255 && description.length <= 4096 && validSlug(effectiveSlug);
  const save = () => {
    if (!valid || busy) return;
    const request = editing
      ? run(key, "collection_update", { collection: editing.slug, title: title.trim(), description })
      : run(key, "collection_create", { slug: effectiveSlug, title: title.trim(), description });
    request.then(() => {
      onClose();
      if (!editing) store.setContentItemScope(effectiveSlug);
    }, (cause) => setError(contentError(cause)));
  };
  return (
    <Dialog open={form !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit collection" : "New collection"}</DialogTitle>
          <DialogDescription>Collections group items. An item can be ungrouped or in one collection, and moving it never changes its ID or link.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); save(); }}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
              <Input id={`${id}-title`} value={title} maxLength={255} autoFocus onChange={(event) => setTitle(event.target.value)} placeholder="Research notes" />
            </Field>
            <Field data-invalid={!editing && (slugTouched || title) && !validSlug(effectiveSlug) ? true : undefined}>
              <FieldLabel htmlFor={`${id}-slug`}>Slug</FieldLabel>
              <Input id={`${id}-slug`} value={effectiveSlug} disabled={Boolean(editing)} maxLength={80} className="font-mono text-xs"
                onChange={(event) => { setSlugTouched(true); setSlug(event.target.value); }} placeholder="research-notes" />
              <FieldDescription>{editing ? "A collection’s slug can’t change." : "Lowercase letters, digits and hyphens. It can’t change later."}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
              <Textarea id={`${id}-description`} value={description} maxLength={4096} rows={3} onChange={(event) => setDescription(event.target.value)} className="resize-none" />
            </Field>
            {error ? <p role="alert" className="text-[0.8rem] text-pretty text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!valid || busy}>
                {busy ? <Spinner data-icon="inline-start" /> : editing ? <PencilIcon data-icon="inline-start" /> : <FolderPlusIcon data-icon="inline-start" />}
                {editing ? "Save" : "Create collection"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveArtifactDialog({ removal, onClose, run, pending }: { removal: ArtifactRemoval | null; onClose(): void; run: Run; pending: ReadonlySet<string> }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = removal ? `artifact-rm:${removal.name}:${removal.version ?? ""}` : "";
  const busy = pending.has(key);
  useEffect(() => { setReason(""); setError(null); }, [key]);
  const label = removal ? removal.version ? `${removal.name} version ${removal.version.slice(0, 12)}` : removal.name : "";
  const remove = () => {
    if (!removal || !reason.trim() || busy) return;
    const { name, version } = removal;
    run(key, "artifacts_rm", { name, reason: reason.trim(), ...(version ? { version } : {}) }).then(() => {
      onClose();
      toast.success(`Tombstoned ${label}`, { action: { label: "Restore", onClick: () => {
        run(`artifact-restore:${name}`, "artifacts_restore", { name, ...(version ? { version } : {}) }).then(() => toast.success(`Restored ${label}`), (cause) => toast.error(contentError(cause)));
      } } });
    }, (cause) => setError(contentError(cause)));
  };
  return (
    <AlertDialog open={removal !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>Tombstone {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {removal?.version ? "This version’s citation stops resolving." : "Every version stops resolving, including cited links."} The bytes are kept until an agent runs garbage collection, so Restore brings it back until then.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); remove(); }}>
          <Field data-invalid={Boolean(error) || undefined}>
            <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
            <Textarea id={`${id}-reason`} value={reason} rows={2} autoFocus placeholder="Why it is being removed" onChange={(event) => setReason(event.target.value)} className="resize-none" />
            {error ? <FieldDescription role="alert" className="text-destructive">{error}</FieldDescription> : null}
          </Field>
        </form>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!reason.trim() || busy} onClick={remove}>
            {busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Tombstone
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** No operation lists removed records, so restoring one needs its exact name. */
function RestoreDialog({ kind, onClose, run, pending, onRestored }: { kind: "document" | "artifact" | null; onClose(): void; run: Run; pending: ReadonlySet<string>; onRestored(kind: "document" | "artifact", name: string): void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = pending.has("restore-by-name");
  useEffect(() => { setName(""); setVersion(""); setError(null); }, [kind]);
  const restore = () => {
    if (!kind || !name.trim() || busy) return;
    const request = kind === "document"
      ? run<{ slug: string }>("restore-by-name", "restore", { ref: name.trim() }).then((result) => result.slug)
      : run<{ name: string }>("restore-by-name", "artifacts_restore", { name: name.trim(), ...(version.trim() ? { version: version.trim() } : {}) }).then((result) => result.name);
    request.then((restored) => { onClose(); onRestored(kind, restored); toast.success(`Restored ${restored}`); }, (cause) => setError(contentError(cause)));
  };
  return (
    <Dialog open={kind !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === "artifact" ? "Restore an Artifact" : "Restore a document"}</DialogTitle>
          <DialogDescription>
            Removed {kind === "artifact" ? "Artifacts" : "documents"} are not listed anywhere, so enter the exact {kind === "artifact" ? "name" : "slug"}.
            {kind === "artifact" ? " Garbage-collected bytes can’t be restored." : ""}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); restore(); }}>
          <FieldGroup className="gap-4">
            <Field data-invalid={Boolean(error) || undefined}>
              <FieldLabel htmlFor={`${id}-name`}>{kind === "artifact" ? "Artifact name" : "Document slug"}</FieldLabel>
              <Input id={`${id}-name`} value={name} autoFocus className="font-mono text-xs" onChange={(event) => setName(event.target.value)} />
              {error ? <FieldDescription role="alert" className="text-destructive">{error}</FieldDescription> : null}
            </Field>
            {kind === "artifact" ? (
              <Field>
                <FieldLabel htmlFor={`${id}-version`}>Version (optional)</FieldLabel>
                <Input id={`${id}-version`} value={version} className="font-mono text-xs" onChange={(event) => setVersion(event.target.value)} placeholder="Every version when blank" />
              </Field>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy ? <Spinner data-icon="inline-start" /> : <ArchiveRestoreIcon data-icon="inline-start" />}Restore
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
