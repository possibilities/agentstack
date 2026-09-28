"use client";

import { useDeferredValue, useEffect, useState } from "react";
import { ArchiveRestoreIcon, CopyIcon, EllipsisIcon, EyeIcon, FilePlusIcon, FileTextIcon, NotebookTextIcon, PencilIcon, ScanSearchIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { defaultRoutes, fillRoute } from "@/lib/stack/content";
import { nodeKey, type ContentDocument, type ContentHit } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useContentActions } from "./content-actions";
import { IsoTime, TagChip, UnsavedDot, useContentRead } from "./content-shared";
import { Empty } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { footerButton, Window } from "./window";

type Row = { slug: string; title: string; tags: string[]; snippet?: string; updated?: string | null };

/** Vault documents: FTS search with snippets, otherwise newest first; tags narrow either. */
export function ContentDocumentsWindow() {
  const { contentDocuments, contentTags, status, endpoints, remote } = useStack();
  const actions = useContentActions();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const deferred = useDeferredValue(query.trim());
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const timer = setTimeout(() => setDebounced(deferred), 200); return () => clearTimeout(timer); }, [deferred]);
  const searching = debounced.length > 0;
  const search = useContentRead<{ hits: ContentHit[] }>("search", searching ? { query: debounced, limit: 50, ...(tag ? { tag } : {}) } : null);
  const tagged = useContentRead<{ documents: ContentDocument[] }>("list", !searching && tag ? { tag, limit: 200 } : null);
  const connected = status.content === "open";
  const rows: Row[] | null = searching ? search.data?.hits ?? null : tag ? tagged.data?.documents ?? null : contentDocuments.data;
  const error = searching ? search.error : tag ? tagged.error : contentDocuments.error;
  const tags = contentTags.data ?? [];

  return (
    <Window id="content-documents" title="Documents" subtitle="content · vault" icon={NotebookTextIcon} accent="content"
      count={contentDocuments.data?.length ?? null} status={status.content} endpoint={endpoints.content} updatedAt={contentDocuments.at} error={error}
      actions={
        <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label="Restore a removed document" title={remote?.scope === "view" ? "Requires uix:control" : "Restore a removed document"}
          disabled={!connected || remote?.scope === "view"} onClick={() => actions.restoreByName("document")}><ArchiveRestoreIcon /></Button>
      }
      footer={
        <Button size="sm" variant="ghost" className={footerButton} disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.edit({ kind: "new-document" })}>
          <FilePlusIcon data-icon="inline-start" />New document
        </Button>
      }>
      <div className="flex flex-col gap-1.5">
        <InputGroup className="h-8">
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput aria-label="Search documents" placeholder="Search the vault" value={query}
            onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}><XIcon /></InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {tags.length ? (
          <div role="group" aria-label="Filter by tag" className="flex flex-wrap gap-1">
            {tags.slice(0, 24).map((item) => (
              <TagChip key={item.tag} tag={`${item.tag} ${item.documents}`} active={tag === item.tag} onClick={() => setTag(tag === item.tag ? null : item.tag)} />
            ))}
          </div>
        ) : null}
        <p role="status" className="px-0.5 text-[0.68rem] text-muted-foreground">
          {rows === null ? (searching ? "Searching…" : "Loading…")
            : searching ? `${rows.length} match${rows.length === 1 ? "" : "es"} for “${debounced}”${tag ? ` in #${tag}` : ""}`
            : tag ? `${rows.length} document${rows.length === 1 ? "" : "s"} tagged #${tag}` : `${rows.length} newest document${rows.length === 1 ? "" : "s"}`}
        </p>
      </div>
      {rows?.length ? (
        <ul className="flex flex-col">
          {rows.map((row) => <DocumentRow key={row.slug} row={row} />)}
        </ul>
      ) : rows ? (
        <Empty icon={FileTextIcon} title={searching || tag ? "No matching documents" : "No documents yet"} />
      ) : null}
    </Window>
  );
}

/** FTS snippets mark matches with [brackets]; show them as highlights. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <span className="line-clamp-2 text-[0.7rem] text-muted-foreground">
      {parts.map((part, index) => /^\[[^\]]*\]$/.test(part)
        ? <mark key={index} className="rounded-sm bg-pkg-content/15 px-px text-foreground">{part.slice(1, -1)}</mark>
        : <span key={index}>{part}</span>)}
    </span>
  );
}

function DocumentRow({ row }: { row: Row }) {
  const actions = useContentActions();
  const { contentRoutes, status, remote } = useStack();
  const { select, flash } = useWorkbench();
  const node = { kind: "document", id: row.slug } as const;
  const key = nodeKey(node);
  const dirty = Boolean(actions.drafts[key]);
  const editing = actions.target?.kind === "document" && actions.target.slug === row.slug;
  const previewing = actions.selection?.kind === "document" && actions.selection.slug === row.slug;
  const path = fillRoute(contentRoutes.data?.documentPath ?? defaultRoutes.documentPath, { slug: row.slug });
  const connected = status.content === "open";
  return (
    <li data-node={key} className={cn("group/row relative flex items-start gap-1 rounded-lg px-1.5 py-1.5 hover:bg-muted/70", (editing || previewing) && "bg-pkg-content/10 hover:bg-pkg-content/15")}>
      {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-0.5 rounded-[inherit] animate-uix-flash" /> : null}
      <button type="button" aria-current={previewing ? "true" : undefined} onClick={() => actions.preview({ kind: "document", slug: row.slug })}
        onDoubleClick={() => actions.open({ kind: "document", slug: row.slug })}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[0.8rem] font-medium">{row.title}</span>
          {dirty ? <UnsavedDot /> : null}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="truncate font-mono text-[0.66rem] text-muted-foreground">{row.slug}</span>
          {row.tags.slice(0, 4).map((tag) => <TagChip key={tag} tag={tag} />)}
          {row.updated ? <IsoTime at={row.updated} className="ml-auto text-[0.64rem] text-muted-foreground" /> : null}
        </span>
        {row.snippet ? <Snippet text={row.snippet} /> : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${row.title} actions`} />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => actions.open({ kind: "document", slug: row.slug })}><PencilIcon />Open in editor</DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.preview({ kind: "document", slug: row.slug })}><EyeIcon />Preview</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(path).then(() => toast.success(`Copied ${path}`)); }}><CopyIcon />Copy {path}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => select(node)}><ScanSearchIcon />Inspect record</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.confirmRemoveDocument({ slug: row.slug, title: row.title })}><Trash2Icon />Remove…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
