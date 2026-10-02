"use client";

import { useEffect, useId, useRef, useState } from "react";
import { EllipsisIcon, EyeIcon, FilePenLineIcon, RotateCcwIcon, SaveIcon, ScanSearchIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { base64ToBytes, completeWikilink, editableLimit, formatSize, inlineLimit, sha256Hex, wikilinkQuery } from "@/lib/stack/content";
import { stageBytes } from "@/lib/stack/content-upload";
import { draftChanges, draftConflicts, editDraft, emptyDraft, keepDraft, utf8Bytes, yieldDraft, type Draft } from "@/lib/stack/roles";
import type { ContentDocumentBody, ContentItem } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { contentError, contentTargetKey, useContentActions } from "./content-actions";
import { ContentVaultHistory } from "./content-history";
import { InlineError, IsoTime, KindIcon, TagChip } from "./content-shared";
import { Empty } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { Window } from "./window";

const labelClass = "px-0.5 text-[0.7rem] font-medium text-muted-foreground";
const hintClass = "px-0.5 text-[0.68rem] text-pretty text-muted-foreground";

/** The one editing surface for Vault documents and document items. Bodies are page-local drafts until saved. */
export function ContentEditorWindow() {
  const { target } = useContentActions();
  if (!target) return <EditorFrame empty><Empty icon={FilePenLineIcon} title="Choose a document to edit" /></EditorFrame>;
  switch (target.kind) {
    case "document": return <DocumentEditor key={target.slug} slug={target.slug} />;
    case "item": return <ItemEditor key={target.id} id={target.id} />;
    case "new-document": return <NewDocumentEditor />;
  }
}

function EditorFrame({ subtitle, footer, actions, empty = false, updatedAt, children }: {
  subtitle?: string; footer?: React.ReactNode; actions?: React.ReactNode; empty?: boolean; updatedAt?: number | null; children: React.ReactNode;
}) {
  const { status, endpoints } = useStack();
  return (
    <Window id="content-editor" title="Editor" subtitle={subtitle} icon={FilePenLineIcon} accent="content" status={status.content} endpoint={endpoints.content}
      updatedAt={updatedAt} footer={footer} actions={actions} empty={empty}>
      {children}
    </Window>
  );
}

function useDraft(key: string, saved: Record<string, string>) {
  const actions = useContentActions();
  const draft = actions.drafts[key] ?? emptyDraft;
  const value = (field: string) => field in draft.values ? draft.values[field] : saved[field] ?? "";
  return {
    draft,
    value,
    set: (field: string, next: string) => actions.setDraft(key, editDraft(draft, field, next, saved)),
    conflicts: draftConflicts(draft, saved),
    changes: draftChanges(draft, saved),
    clear: () => actions.setDraft(key, null),
    replace: (next: Draft) => actions.setDraft(key, next),
  };
}

function saveKeys(save: () => void) {
  return (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    if (event.key.toLowerCase() !== "s" && event.key !== "Enter") return;
    event.preventDefault();
    save();
  };
}

function ConflictNotice({ conflicted, onKeep, onYield }: { conflicted: boolean; onKeep(): void; onYield(): void }) {
  if (!conflicted) return null;
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <TriangleAlertIcon className="text-warning" />
      <AlertTitle>Changed elsewhere</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>The saved text changed since you started editing. “Keep mine” overwrites it; “Use theirs” drops your edit.</span>
        <span className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={onYield}>Use theirs</Button>
          <Button size="xs" variant="outline" onClick={onKeep}>Keep mine</Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

function SaveBar({ dirty, conflicted, pending, saveLabel, onSave, onRevert, note, invalid }: {
  dirty: boolean; conflicted: boolean; pending: boolean; saveLabel: string; onSave(): void; onRevert?: () => void; note?: string; invalid?: string | null;
}) {
  const { status, remote } = useStack();
  const connected = status.content === "open";
  const message = remote?.scope === "view" ? "View-only session · saving requires ui:control" : !connected ? "Content reconnecting" : conflicted ? "Resolve the conflict to save" : invalid ? invalid : dirty ? "Unsaved changes · ⌘S to save" : note ?? "All changes saved";
  return (
    <div className="flex items-center gap-1.5 px-1.5">
      <span role="status" className={cn("min-w-0 flex-1 truncate text-[0.68rem]", dirty && !conflicted ? "text-foreground" : "text-muted-foreground")}>{message}</span>
      {onRevert ? <Button size="sm" variant="ghost" disabled={!dirty || pending} onClick={onRevert}><RotateCcwIcon data-icon="inline-start" />Revert</Button> : null}
      <Button size="sm" disabled={!connected || !dirty || conflicted || pending || Boolean(invalid) || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={onSave}>
        {pending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}{saveLabel}
      </Button>
    </div>
  );
}

/**
 * A body textarea with slim wikilink completion: typing `[[` offers documents from `resolve`,
 * and Enter or Tab inserts the chosen slug and closes the link.
 */
function WikiTextarea({ id, value, onChange, placeholder, describedBy }: { id: string; value: string; onChange(value: string): void; placeholder?: string; describedBy?: string }) {
  const store = useStore();
  const { contentDocuments } = useStack();
  const area = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [options, setOptions] = useState<Array<{ slug: string; title: string }>>([]);
  const [active, setActive] = useState(0);
  const listId = `${id}-links`;
  useEffect(() => {
    if (query === null) { setOptions([]); return; }
    const words = query.trim();
    const local = (contentDocuments.data ?? []).filter((doc) => !words || `${doc.slug} ${doc.title}`.toLowerCase().includes(words.toLowerCase())).slice(0, 6);
    if (!words) { setOptions(local); setActive(0); return; }
    let live = true;
    const timer = setTimeout(() => {
      store.call<{ candidates: Array<{ slug: string; title: string }> }>("content", "resolve", { phrase: words, limit: 6 })
        .then((result) => { if (live) { setOptions(result.candidates.length ? result.candidates : local); setActive(0); } }, () => { if (live) { setOptions(local); setActive(0); } });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [query, store, contentDocuments.data]);
  const sync = (element: HTMLTextAreaElement) => setQuery(wikilinkQuery(element.value, element.selectionStart ?? 0)?.query ?? null);
  const choose = (slug: string) => {
    const element = area.current;
    if (!element) return;
    const done = completeWikilink(element.value, element.selectionStart ?? 0, slug);
    if (!done) return;
    onChange(done.text);
    setQuery(null);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(done.caret, done.caret); });
  };
  const open = query !== null && options.length > 0;
  return (
    <div className="relative flex min-h-0 flex-col">
      <Textarea ref={area} id={id} value={value} spellCheck={false} placeholder={placeholder} aria-describedby={describedBy}
        role={open ? "combobox" : undefined} aria-expanded={open ? true : undefined} aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined} aria-autocomplete={open ? "list" : undefined}
        onChange={(event) => { onChange(event.target.value); sync(event.target); }}
        onSelect={(event) => sync(event.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
          } else if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            choose(options[active]!.slug);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setQuery(null);
          }
        }}
        className="min-h-80 resize-y font-mono text-[0.78rem] leading-relaxed md:text-[0.78rem]" />
      {open ? (
        <ul id={listId} role="listbox" aria-label="Link to document" className="absolute inset-x-2 top-2 z-10 flex flex-col rounded-lg border bg-popover p-1 shadow-md">
          {options.map((option, index) => (
            <li key={option.slug} id={`${listId}-${index}`} role="option" aria-selected={index === active}
              onPointerDown={(event) => { event.preventDefault(); choose(option.slug); }}
              className={cn("flex cursor-default items-baseline gap-2 rounded-md px-2 py-1 text-[0.76rem]", index === active && "bg-muted")}>
              <span className="truncate">{option.title}</span>
              <span className="ml-auto shrink-0 font-mono text-[0.66rem] text-muted-foreground">{option.slug}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Gone({ what, onClose }: { what: string; onClose(): void }) {
  return (
    <EditorFrame>
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center">
        <Trash2Icon className="size-5 text-muted-foreground/70" />
        <p className="text-sm font-medium">This {what} no longer exists</p>
        <p className={hintClass}>Your unsaved text stays here until you close it.</p>
        <Button size="sm" variant="ghost" onClick={onClose}><XIcon data-icon="inline-start" />Close</Button>
      </div>
    </EditorFrame>
  );
}

type SavedDocument = { body: string; digest: string; title: string; tags: string[]; updated: string | null };

function DocumentEditor({ slug }: { slug: string }) {
  const store = useStore();
  const { contentGeneration, status } = useStack();
  const actions = useContentActions();
  const { select } = useWorkbench();
  const formId = useId();
  const key = contentTargetKey({ kind: "document", slug });
  const [saved, setSaved] = useState<SavedDocument | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const saving = actions.pending.has(`save:${key}`);
  const connected = status.content === "open";
  const read = () => store.call<ContentDocumentBody>("content", "get", { ref: slug }).then((document): SavedDocument => ({
    body: document.content ?? "", digest: document.digest, title: document.title, tags: document.tags ?? [], updated: document.updated ?? null,
  }));
  useEffect(() => {
    if (!connected || saving) return;
    let live = true;
    read().then((next) => { if (live) { setSaved(next); setGone(false); setReadError(null); setReadAt(Date.now()); } },
      (cause) => { if (!live) return; if (/document_not_found|not found|tombstone/i.test(errorMessage(cause))) setGone(true); else setReadError(contentError(cause)); });
    return () => { live = false; };
  }, [slug, contentGeneration, connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields = { body: saved?.body ?? "" };
  const draft = useDraft(key, fields);
  if (gone) return <Gone what="document" onClose={() => { draft.clear(); actions.edit(null); }} />;
  if (!saved) return <EditorFrame subtitle={`document · ${slug}`} empty><Empty icon={FilePenLineIcon} title={readError ?? "Loading document…"} /></EditorFrame>;

  const dirty = Object.keys(draft.changes).length > 0;
  const conflicted = draft.conflicts.length > 0;
  const save = async () => {
    if (!dirty || conflicted || saving || !connected) return;
    const pendingDraft = draft.draft;
    const body = pendingDraft.values.body ?? saved.body;
    setError(null);
    const attempt = (digest: string) => actions.run<{ digest: string; updated: string }>(`save:${key}`, "document_update", { ref: slug, expectedDigest: digest, content: body });
    try {
      let result: { digest: string; updated: string };
      try {
        result = await attempt(saved.digest);
      } catch (cause) {
        if (!/document changed/.test(errorMessage(cause))) throw cause;
        // The file changed; if its body is still what this draft started from, only metadata moved. Retry once.
        const fresh = await read();
        setSaved(fresh);
        if (draftConflicts(pendingDraft, { body: fresh.body }).length) throw new Error("It changed elsewhere while saving. Choose which version to keep.");
        result = await attempt(fresh.digest);
      }
      setSaved((current) => current && { ...current, body, digest: result.digest, updated: result.updated });
      draft.clear();
    } catch (cause) { setError(contentError(cause)); }
  };

  return (
    <EditorFrame subtitle={`document · ${slug}`} updatedAt={readAt}
      footer={<SaveBar dirty={dirty} conflicted={conflicted} pending={saving} saveLabel="Save" onSave={() => void save()} onRevert={() => { draft.clear(); setError(null); }} />}
      actions={<RecordMenu label={saved.title} onPreview={() => actions.preview({ kind: "document", slug })} onInspect={() => select({ kind: "document", id: slug })}
        onRemove={() => actions.confirmRemoveDocument({ slug, title: saved.title })} />}>
      <form className="flex flex-col gap-3" aria-label={`Edit ${saved.title}`} onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={saveKeys(() => void save())}>
        <div className="flex flex-col gap-1">
          <h3 className="text-[0.95rem] leading-tight font-semibold tracking-tight">{saved.title}</h3>
          <div className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-[0.66rem] text-muted-foreground">{slug}</span>
            {saved.tags.map((tag) => <TagChip key={tag} tag={tag} />)}
            {saved.updated ? <span className="ml-auto text-[0.66rem] text-muted-foreground">Edited <IsoTime at={saved.updated} /></span> : null}
          </div>
        </div>
        <ConflictNotice conflicted={conflicted} onKeep={() => draft.replace(keepDraft(draft.draft, fields))} onYield={() => draft.replace(yieldDraft(draft.draft, fields))} />
        <div className="flex min-h-0 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${formId}-body`} className={labelClass}>Markdown</label>
            <span className="text-[0.65rem] text-muted-foreground tabular-nums">{formatSize(utf8Bytes(draft.value("body")))}</span>
          </div>
          <WikiTextarea id={`${formId}-body`} value={draft.value("body")} onChange={(next) => draft.set("body", next)} describedBy={`${formId}-hint`} />
          <p id={`${formId}-hint`} className={hintClass}>Type [[ to link a document. The title and tags live in the file’s frontmatter and are kept as they are.</p>
        </div>
        <InlineError error={error} />
      </form>
      <ContentVaultHistory slug={slug} />
    </EditorFrame>
  );
}

type SavedItem = { item: ContentItem; body: string };

/** Load a document item's text through the Package API, in bounded chunks when it exceeds one inline read. */
async function readItemText(call: <T>(name: string, args: Record<string, unknown>) => Promise<T>, id: string): Promise<SavedItem | { item: ContentItem; body: null; reason: string }> {
  const item = await call<ContentItem & { content: string | null }>("item_get", { id, includeData: true });
  const { content, ...meta } = item as ContentItem & { content: string | null; base64?: string | null };
  delete (meta as { base64?: unknown }).base64;
  if (meta.kind !== "document") return { item: meta, body: null, reason: "Only document items are edited here." };
  if (content !== null) return { item: meta, body: content };
  if (meta.bytes > editableLimit) return { item: meta, body: null, reason: `At ${formatSize(meta.bytes)} it is too large to edit here.` };
  const parts: Uint8Array[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const chunk: { base64: string; nextOffset: number | null; revision: number } = await call("item_read", { id, offset, expectedRevision: meta.revision });
    parts.push(base64ToBytes(chunk.base64));
    offset = chunk.nextOffset;
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { joined.set(part, at); at += part.length; }
  return { item: meta, body: new TextDecoder().decode(joined) };
}

function ItemEditor({ id }: { id: string }) {
  const store = useStore();
  const { contentGeneration, status } = useStack();
  const actions = useContentActions();
  const { select } = useWorkbench();
  const formId = useId();
  const key = contentTargetKey({ kind: "item", id });
  const [saved, setSaved] = useState<SavedItem | null>(null);
  const [blocked, setBlocked] = useState<{ item: ContentItem; reason: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const saving = actions.pending.has(`save:${key}`);
  const connected = status.content === "open";
  const call = <T,>(name: string, args: Record<string, unknown>) => store.call<T>("content", name, args);
  const read = async (): Promise<SavedItem> => {
    const result = await readItemText(call, id);
    if (result.body === null) { setBlocked({ item: result.item, reason: (result as { reason: string }).reason }); throw new Error("blocked"); }
    setBlocked(null);
    return result as SavedItem;
  };
  useEffect(() => {
    if (!connected || saving) return;
    let live = true;
    read().then((next) => { if (live) { setSaved(next); setGone(false); setReadError(null); setReadAt(Date.now()); } },
      (cause) => { if (!live || errorMessage(cause) === "blocked") return; if (/not found/i.test(errorMessage(cause))) setGone(true); else setReadError(contentError(cause)); });
    return () => { live = false; };
  }, [id, contentGeneration, connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields = { body: saved?.body ?? "" };
  const draft = useDraft(key, fields);
  if (gone) return <Gone what="item" onClose={() => { draft.clear(); actions.edit(null); }} />;
  if (blocked) return (
    <EditorFrame subtitle={`item · ${blocked.item.name}`} empty>
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center">
        <KindIcon kind={blocked.item.kind} className="size-5" />
        <p className="text-sm font-medium">{blocked.reason}</p>
        <Button size="sm" variant="outline" onClick={() => actions.preview({ kind: "item", id })}><EyeIcon data-icon="inline-start" />Preview it</Button>
      </div>
    </EditorFrame>
  );
  if (!saved) return <EditorFrame subtitle="item" empty><Empty icon={FilePenLineIcon} title={readError ?? "Loading item…"} /></EditorFrame>;

  const { item } = saved;
  const dirty = Object.keys(draft.changes).length > 0;
  const conflicted = draft.conflicts.length > 0;
  const save = async () => {
    if (!dirty || conflicted || saving || !connected) return;
    const pendingDraft = draft.draft;
    const body = pendingDraft.values.body ?? saved.body;
    setError(null);
    const bytes = new TextEncoder().encode(body);
    const attempt = async (revision: number) => {
      // Small bodies go inline; larger ones through the same resumable stage as uploads.
      const source = bytes.length <= inlineLimit ? { content: body } : { blob: await stageBytes(call, bytes, await sha256Hex(bytes)) };
      return actions.run<ContentItem>(`save:${key}`, "item_put", { id, expectedRevision: revision, name: item.name, kind: item.kind, mediaType: item.mediaType, ...source });
    };
    try {
      let next: ContentItem;
      try {
        next = await attempt(item.revision);
      } catch (cause) {
        if (!/revision conflict/.test(errorMessage(cause))) throw cause;
        const fresh = await read();
        setSaved(fresh);
        if (draftConflicts(pendingDraft, { body: fresh.body }).length) throw new Error("It changed elsewhere while saving. Choose which version to keep.");
        next = await attempt(fresh.item.revision);
      }
      setSaved({ item: next, body });
      draft.clear();
    } catch (cause) { setError(contentError(cause)); }
  };

  return (
    <EditorFrame subtitle={`item · revision ${item.revision}`} updatedAt={readAt}
      footer={<SaveBar dirty={dirty} conflicted={conflicted} pending={saving} saveLabel="Save" onSave={() => void save()} onRevert={() => { draft.clear(); setError(null); }} />}
      actions={<RecordMenu label={item.name} onPreview={() => actions.preview({ kind: "item", id })} onInspect={() => select({ kind: "item", id })} onRemove={() => actions.confirmDeleteItem(item)} removeLabel="Delete…" />}>
      <form className="flex flex-col gap-3" aria-label={`Edit ${item.name}`} onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={saveKeys(() => void save())}>
        <div className="flex flex-wrap items-center gap-1.5">
          <KindIcon kind={item.kind} />
          <h3 className="truncate text-[0.95rem] leading-tight font-semibold tracking-tight">{item.name}</h3>
          <span className="rounded bg-muted px-1.5 py-px text-[0.64rem] text-muted-foreground">{item.collection ?? "ungrouped"}</span>
          <span className="ml-auto text-[0.66rem] text-muted-foreground">Edited <IsoTime at={item.updatedAt} /></span>
        </div>
        <ConflictNotice conflicted={conflicted} onKeep={() => draft.replace(keepDraft(draft.draft, fields))} onYield={() => draft.replace(yieldDraft(draft.draft, fields))} />
        <div className="flex min-h-0 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${formId}-body`} className={labelClass}>{item.mediaType === "text/markdown" ? "Markdown" : "Text"}</label>
            <span className="text-[0.65rem] text-muted-foreground tabular-nums">{formatSize(utf8Bytes(draft.value("body")))}</span>
          </div>
          <WikiTextarea id={`${formId}-body`} value={draft.value("body")} onChange={(next) => draft.set("body", next)} />
          <p className={hintClass}>Saving writes a new revision. Its ID and shared link stay the same.</p>
        </div>
        <InlineError error={error} />
      </form>
    </EditorFrame>
  );
}

function NewDocumentEditor() {
  const actions = useContentActions();
  const store = useStore();
  const { status } = useStack();
  const formId = useId();
  const key = "new-document";
  const blank = { title: "", tags: "", body: "" };
  const draft = useDraft(key, blank);
  const [error, setError] = useState<string | null>(null);
  const creating = actions.pending.has(`save:${key}`);
  const connected = status.content === "open";
  const title = draft.value("title").trim();
  useEffect(() => { document.getElementById(`${formId}-title`)?.focus({ preventScroll: true }); }, [formId]);

  const create = async () => {
    if (!title || creating || !connected) return;
    const tags = draft.value("tags").split(",").map((tag) => tag.trim()).filter(Boolean).join(",");
    const body = draft.value("body");
    setError(null);
    try {
      const created = await actions.run<{ slug: string }>(`save:${key}`, "new", { title, ...(tags ? { tags } : {}) });
      draft.clear();
      if (body.trim()) {
        // `new` writes a heading-only body; the draft's body replaces it, fenced by the fresh digest.
        try {
          const fresh = await store.call<ContentDocumentBody>("content", "get", { ref: created.slug });
          await actions.run(`save:${key}`, "document_update", { ref: created.slug, expectedDigest: fresh.digest, content: body });
        } catch (cause) {
          actions.setDraft(`document:${created.slug}`, { base: { body: `# ${title}\n\n` }, values: { body } });
          toast.error(`Created ${created.slug}, but its text wasn’t saved: ${contentError(cause)}. It is kept as an unsaved draft.`);
        }
      }
      actions.open({ kind: "document", slug: created.slug });
    } catch (cause) {
      setError(/document_exists/.test(errorMessage(cause)) ? "A document with this title’s slug already exists. Choose another title." : contentError(cause));
    }
  };
  const cancel = () => { draft.clear(); actions.edit(null); };

  return (
    <EditorFrame subtitle="new document"
      footer={<SaveBar dirty={connected} conflicted={false} pending={creating} saveLabel="Create document" onSave={() => void create()} note="Not created yet" invalid={title ? null : "A title is required"} />}
      actions={<Button size="icon-sm" variant="ghost" aria-label="Discard new document" onClick={cancel}><XIcon /></Button>}>
      <form className="flex flex-col gap-3" aria-label="New document" onSubmit={(event) => { event.preventDefault(); void create(); }} onKeyDown={saveKeys(() => void create())}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${formId}-title`} className={labelClass}>Title</label>
          <Input id={`${formId}-title`} value={draft.value("title")} maxLength={200} placeholder="What this document is about"
            aria-invalid={title ? undefined : true} onChange={(event) => draft.set("title", event.target.value)} className="h-8" />
          <p className={hintClass}>The slug comes from the title and can’t change later.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${formId}-tags`} className={labelClass}>Tags</label>
          <Input id={`${formId}-tags`} value={draft.value("tags")} placeholder="decision, audio" onChange={(event) => draft.set("tags", event.target.value)} className="h-8" />
        </div>
        <div className="flex min-h-0 flex-col gap-1.5">
          <label htmlFor={`${formId}-body`} className={labelClass}>Markdown</label>
          <WikiTextarea id={`${formId}-body`} value={draft.value("body")} onChange={(next) => draft.set("body", next)} placeholder={title ? `# ${title}` : "# Title"} />
        </div>
        <InlineError error={error} />
        <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={cancel}>Discard</Button>
      </form>
    </EditorFrame>
  );
}

function RecordMenu({ label, onPreview, onInspect, onRemove, removeLabel = "Remove…" }: { label: string; onPreview(): void; onInspect(): void; onRemove(): void; removeLabel?: string }) {
  const { status } = useStack();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`${label} actions`} />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onPreview}><EyeIcon />Preview</DropdownMenuItem>
          <DropdownMenuItem onClick={onInspect}><ScanSearchIcon />Inspect record</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={status.content !== "open"} onClick={onRemove}><Trash2Icon />{removeLabel}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
