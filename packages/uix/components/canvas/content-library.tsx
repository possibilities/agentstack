"use client";

import { useEffect, useState } from "react";
import {
  CopyIcon,
  EllipsisIcon,
  EyeIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  InboxIcon,
  LibraryIcon,
  PencilIcon,
  RotateCwIcon,
  ScanSearchIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { filterItems, formatSize, scopeKey } from "@/lib/stack/content";
import { nodeKey, type ContentCollection, type ContentItem, type ContentItemKind, type ContentItemScope, type ContentUpload } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { contentError, useContentActions } from "./content-actions";
import { IsoTime, KindIcon, UnsavedDot } from "./content-shared";
import { Empty } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { footerButton, Window } from "./window";

const itemType = "application/x-agentstack-item";

/** Collections and their items: upload by dropping files, regroup by dragging items onto a collection. */
export function ContentLibraryWindow() {
  const store = useStore();
  const { contentLibrary, contentItems, contentItemScope: scope, contentUploads, status, endpoints, remote } = useStack();
  const actions = useContentActions();
  const [kind, setKind] = useState<ContentItemKind | "all">("all");
  const [query, setQuery] = useState("");
  const [fileOver, setFileOver] = useState(false);
  const [dragging, setDragging] = useState<ContentItem | null>(null);
  const connected = status.content === "open";
  const library = contentLibrary.data;
  const page = contentItems.data && scopeKey(contentItems.data.scope) === scopeKey(scope) ? contentItems.data : null;
  const items = page ? filterItems(page.items, kind, query) : null;
  const uploadTarget = typeof scope === "string" ? scope : null;
  // A collection deleted here or elsewhere leaves nothing to show; fall back to every item.
  const missing = typeof scope === "string" && library !== null && !library.collections.some((item) => item.slug === scope);
  // A list read that started before the collection was created can omit it, so confirm before leaving it.
  useEffect(() => {
    if (!missing || typeof scope !== "string") return;
    let live = true;
    store.call("content", "collection_get", { collection: scope }).catch((error) => {
      if (live && /collection not found/.test(String(error)) && store.getState().contentItemScope === scope) store.setContentItemScope(undefined);
    });
    return () => { live = false; };
  }, [missing, scope, store]);
  const scopeTitle = scope === undefined ? "All items" : scope === null ? "Ungrouped" : library?.collections.find((item) => item.slug === scope)?.title ?? scope;

  const move = (item: ContentItem, collection: string | null) => {
    if (remote?.scope === "view") return;
    if (item.collection === collection) return;
    actions.run(`move:${item.id}`, "item_move", { id: item.id, collection, expectedRevision: item.revision })
      .then(() => toast.success(`Moved “${item.name}” to ${collection ?? "Ungrouped"}`),
        (cause) => toast.error(/revision conflict/.test(String(cause)) ? `“${item.name}” changed since this list was read. Try again.` : contentError(cause)));
  };

  return (
    <Window id="content-library" title="Library" subtitle={`content · ${scopeTitle}`} icon={LibraryIcon} accent="content"
      count={library?.counts.all ?? null} status={status.content} endpoint={endpoints.content} updatedAt={contentItems.at ?? contentLibrary.at}
      error={contentItems.error ?? contentLibrary.error}
      footer={
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className={footerButton} disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.upload(uploadTarget)}>
            <UploadIcon data-icon="inline-start" />Upload{uploadTarget ? " here" : ""}
          </Button>
          <Button size="sm" variant="ghost" className={footerButton} disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.editCollection(null)}>
            <FolderPlusIcon data-icon="inline-start" />New collection
          </Button>
        </div>
      }>
      <div
        className="relative grid min-h-64 grid-cols-[9.5rem_minmax(0,1fr)] gap-3"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files") || !connected) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setFileOver(true);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileOver(false); }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setFileOver(false);
          const files = Array.from(event.dataTransfer.files);
          if (files.length && connected) store.uploadContent(files, uploadTarget);
        }}>
        {fileOver ? (
          <div aria-hidden className="pointer-events-none absolute -inset-1 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-pkg-content/60 bg-pkg-content/10 text-[0.8rem] font-medium text-pkg-content">
            Drop to upload into {uploadTarget ? scopeTitle : "Ungrouped"}
          </div>
        ) : null}
        <nav aria-label="Collections" className="flex min-w-0 flex-col gap-0.5">
          <RailEntry scope={undefined} current={scope} icon={LibraryIcon} title="All" count={library?.counts.all} dragging={dragging} onDropItem={() => undefined} />
          <RailEntry scope={null} current={scope} icon={InboxIcon} title="Ungrouped" count={library?.counts.ungrouped} dragging={dragging} onDropItem={(item) => move(item, null)} />
          {library?.collections.length ? <div className="mt-1.5 px-1.5 text-[0.62rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Collections</div> : null}
          {library?.collections.map((collection) => (
            <RailEntry key={collection.slug} scope={collection.slug} current={scope} icon={scope === collection.slug ? FolderOpenIcon : FolderIcon} title={collection.title}
              count={library.counts.byCollection[collection.slug]} collection={collection} dragging={dragging} onDropItem={(item) => move(item, collection.slug)} />
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <InputGroup className="h-8 min-w-0 flex-1">
              <InputGroupAddon><SearchIcon /></InputGroupAddon>
              <InputGroupInput aria-label="Filter loaded items by name" placeholder="Filter by name" value={query}
                onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
              {query ? <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear filter" onClick={() => setQuery("")}><XIcon /></InputGroupButton></InputGroupAddon> : null}
            </InputGroup>
            <label className="sr-only" htmlFor="content-library-kind">Kind</label>
            <NativeSelect id="content-library-kind" size="sm" value={kind} onChange={(event) => setKind(event.target.value as ContentItemKind | "all")}>
              <NativeSelectOption value="all">All kinds</NativeSelectOption>
              <NativeSelectOption value="document">Documents</NativeSelectOption>
              <NativeSelectOption value="image">Images</NativeSelectOption>
              <NativeSelectOption value="file">Files</NativeSelectOption>
            </NativeSelect>
          </div>
          {typeof scope === "string" ? <CollectionSummary slug={scope} /> : null}
          <Uploads uploads={contentUploads} />
          {items === null ? (
            <p role="status" className="px-0.5 py-3 text-[0.72rem] text-muted-foreground">{contentItems.error ?? "Loading items…"}</p>
          ) : items.length ? (
            <table className="w-full table-fixed text-[0.76rem]">
              <caption className="sr-only">Items in {scopeTitle}</caption>
              <thead>
                <tr className="text-left text-[0.64rem] font-medium tracking-wide text-muted-foreground uppercase">
                  <th scope="col" className="px-1.5 pb-1 font-medium">Name</th>
                  <th scope="col" className="w-16 pb-1 text-right font-medium">Size</th>
                  <th scope="col" className="w-9 pb-1 text-right font-medium" title="Revision">Rev</th>
                  <th scope="col" className="w-16 pb-1 text-right font-medium">Updated</th>
                  <th scope="col" className="w-7 pb-1"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => <ItemRow key={item.id} item={item} collections={library?.collections ?? []} onDrag={setDragging} onMove={move} showCollection={scope === undefined} />)}
              </tbody>
            </table>
          ) : (
            <Empty icon={LibraryIcon} title={page?.items.length ? "No loaded items match" : `Nothing in ${scopeTitle} yet · drop files here`} />
          )}
          {page ? (
            <p className="flex items-center gap-2 px-0.5 text-[0.68rem] text-muted-foreground tabular-nums">
              {page.items.length} of {page.total} loaded{kind !== "all" || query ? " · filtering loaded items only" : ""}
              {page.nextOffset !== null ? <Button size="xs" variant="outline" className="ml-auto" onClick={store.loadMoreContentItems}>Load more</Button> : null}
            </p>
          ) : null}
        </div>
      </div>
    </Window>
  );
}

function RailEntry({ scope, current, icon: Icon, title, count, collection, dragging, onDropItem }: {
  scope: ContentItemScope; current: ContentItemScope; icon: React.ComponentType<{ className?: string }>; title: string; count?: number;
  collection?: ContentCollection; dragging: ContentItem | null; onDropItem(item: ContentItem): void;
}) {
  const store = useStore();
  const actions = useContentActions();
  const { select, flash } = useWorkbench();
  const { status, remote } = useStack();
  const [over, setOver] = useState(false);
  const selected = scopeKey(scope) === scopeKey(current);
  const droppable = dragging !== null && scope !== undefined && dragging.collection !== scope;
  const key = collection ? nodeKey({ kind: "collection", id: collection.slug }) : undefined;
  return (
    <div data-node={key} className="group/rail relative flex items-center"
      onDragOver={(event) => { if (!droppable || !event.dataTransfer.types.includes(itemType)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => { if (!droppable || !dragging) return; event.preventDefault(); setOver(false); onDropItem(dragging); }}>
      {key && flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-0.5 rounded-md animate-uix-flash" /> : null}
      <button type="button" aria-current={selected ? "true" : undefined} onClick={() => store.setContentItemScope(scope)} title={collection?.description || title}
        className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[0.76rem] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
          selected && "bg-pkg-content/12 font-medium text-foreground", over && "bg-pkg-content/20 ring-1 ring-pkg-content/60", droppable && !over && "ring-1 ring-dashed ring-border")}>
        <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", selected && "text-pkg-content")} />
        <span className="truncate">{title}</span>
        {count !== undefined ? <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground tabular-nums">{count}</span> : null}
      </button>
      {collection ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="absolute right-0 bg-card text-muted-foreground opacity-0 group-hover/rail:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${collection.title} actions`} />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuGroup>
               <DropdownMenuItem disabled={status.content !== "open" || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.upload(collection.slug)}><UploadIcon />Upload here…</DropdownMenuItem>
               <DropdownMenuItem disabled={remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.editCollection(collection)}><PencilIcon />Edit…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => select({ kind: "collection", id: collection.slug })}><ScanSearchIcon />Inspect record</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
             <DropdownMenuItem variant="destructive" disabled={status.content !== "open" || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.confirmDeleteCollection(collection)}><Trash2Icon />Delete collection…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function CollectionSummary({ slug }: { slug: string }) {
  const { contentLibrary } = useStack();
  const collection = contentLibrary.data?.collections.find((item) => item.slug === slug);
  if (!collection?.description) return null;
  return <p className="line-clamp-2 px-0.5 text-[0.7rem] text-pretty text-muted-foreground">{collection.description}</p>;
}

function ItemRow({ item, collections, onDrag, onMove, showCollection }: {
  item: ContentItem; collections: ContentCollection[]; onDrag(item: ContentItem | null): void; onMove(item: ContentItem, collection: string | null): void; showCollection: boolean;
}) {
  const actions = useContentActions();
  const { select, flash } = useWorkbench();
   const { status, remote } = useStack();
  const node = { kind: "item", id: item.id } as const;
  const key = nodeKey(node);
  const connected = status.content === "open";
  const dirty = Boolean(actions.drafts[key]);
  const previewing = actions.selection?.kind === "item" && actions.selection.id === item.id;
  const moving = actions.pending.has(`move:${item.id}`);
  return (
     <tr data-node={key} draggable={connected && remote?.scope !== "view"}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(itemType, item.id); event.dataTransfer.setData("text/plain", item.url); onDrag(item); }}
      onDragEnd={() => onDrag(null)}
      className={cn("group/row relative hover:bg-muted/70", previewing && "bg-pkg-content/10 hover:bg-pkg-content/15")}>
      <td className="relative rounded-l-md px-1.5 py-1">
        {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute inset-0 animate-uix-flash-in" /> : null}
        <button type="button" onClick={() => actions.preview({ kind: "item", id: item.id })} onDoubleClick={() => actions.open({ kind: "item", id: item.id, itemKind: item.kind })}
          aria-current={previewing ? "true" : undefined} title={`${item.name} · ${item.mediaType}`}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring">
          {moving ? <Spinner className="size-3.5" /> : <KindIcon kind={item.kind} />}
          <span className="truncate">{item.name}</span>
          {dirty ? <UnsavedDot /> : null}
          {showCollection && item.collection ? <span className="ml-auto shrink-0 truncate rounded bg-muted px-1 text-[0.62rem] text-muted-foreground">{item.collection}</span> : null}
        </button>
      </td>
      <td className="py-1 text-right text-muted-foreground tabular-nums">{formatSize(item.bytes)}</td>
      <td className="py-1 text-right font-mono text-[0.7rem] text-muted-foreground">{item.revision}</td>
      <td className="py-1 text-right text-[0.7rem] text-muted-foreground"><IsoTime at={item.updatedAt} /></td>
      <td className="rounded-r-md py-1 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${item.name} actions`} />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuGroup>
              {item.kind === "document" ? <DropdownMenuItem onClick={() => actions.open({ kind: "item", id: item.id, itemKind: item.kind })}><PencilIcon />Open in editor</DropdownMenuItem> : null}
              <DropdownMenuItem onClick={() => actions.preview({ kind: "item", id: item.id })}><EyeIcon />Preview</DropdownMenuItem>
              <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(item.url).then(() => toast.success(`Copied ${item.url}`)); }}><CopyIcon />Copy {item.url.length > 18 ? "link path" : item.url}</DropdownMenuItem>
              <DropdownMenuSub>
                 <DropdownMenuSubTrigger disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined}><FolderInputIcon />Move to</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-40">
                  <DropdownMenuItem disabled={item.collection === null} onClick={() => onMove(item, null)}><InboxIcon />Ungrouped</DropdownMenuItem>
                  {collections.map((collection) => (
                    <DropdownMenuItem key={collection.slug} disabled={item.collection === collection.slug} onClick={() => onMove(item, collection.slug)}><FolderIcon />{collection.title}</DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={() => select({ kind: "item", id: item.id })}><ScanSearchIcon />Inspect record</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
             <DropdownMenuItem variant="destructive" disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.confirmDeleteItem(item)}><Trash2Icon />Delete permanently…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

const phaseCopy: Record<ContentUpload["phase"], string> = {
  hashing: "Checking", uploading: "Uploading", storing: "Saving", done: "Uploaded", stalled: "Stalled", failed: "Failed",
};

function Uploads({ uploads }: { uploads: ContentUpload[] }) {
  const store = useStore();
  const actions = useContentActions();
  if (!uploads.length) return null;
  const finished = uploads.filter((upload) => upload.phase === "done");
  return (
    <section aria-label="Uploads" className="flex flex-col gap-1 rounded-lg border bg-background/50 p-1.5">
      <div className="flex items-center gap-2 px-0.5">
        <h3 className="text-[0.64rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Uploads</h3>
        {finished.length ? <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => finished.forEach((upload) => store.dismissUpload(upload.key))}>Clear finished</Button> : null}
      </div>
      <ul className="flex flex-col gap-1">
        {uploads.map((upload) => {
          const percent = upload.bytes ? Math.round((upload.received / upload.bytes) * 100) : upload.phase === "done" ? 100 : 0;
          const trouble = upload.phase === "stalled" || upload.phase === "failed";
          return (
            <li key={upload.key} className="flex flex-col gap-0.5 px-0.5 text-[0.72rem]">
              <div className="flex min-w-0 items-center gap-1.5">
                {upload.phase === "done" ? null : trouble ? null : <Spinner className="size-3" />}
                {upload.phase === "done" && upload.itemId ? (
                  <button type="button" className="truncate text-left hover:underline" onClick={() => actions.preview({ kind: "item", id: upload.itemId! })}>{upload.name}</button>
                ) : <span className="truncate">{upload.name}</span>}
                <span className={cn("ml-auto shrink-0 tabular-nums", trouble ? "text-destructive" : "text-muted-foreground")}>
                  {phaseCopy[upload.phase]}{upload.phase === "uploading" || upload.phase === "stalled" ? ` · ${percent}%` : ""} · {formatSize(upload.bytes)}
                </span>
                {trouble && upload.retryable ? <Button size="icon-xs" variant="ghost" aria-label={`${upload.phase === "stalled" ? "Resume" : "Retry"} ${upload.name}`} title={upload.phase === "stalled" ? "Resume" : "Retry"} onClick={() => store.resumeUpload(upload.key)}><RotateCwIcon /></Button> : null}
                {upload.phase === "done" || trouble ? <Button size="icon-xs" variant="ghost" aria-label={`Dismiss ${upload.name}`} onClick={() => store.dismissUpload(upload.key)}><XIcon /></Button> : null}
              </div>
              {upload.phase === "uploading" || upload.phase === "stalled" ? (
                <span role="progressbar" aria-label={`${upload.name} upload`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="relative block h-1 overflow-hidden rounded-full bg-muted">
                  <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300", upload.phase === "stalled" ? "bg-warning" : "bg-pkg-content")} style={{ width: `${percent}%` }} />
                </span>
              ) : null}
              {upload.error ? <p className="text-[0.68rem] text-pretty text-destructive">{upload.error}{upload.phase === "stalled" ? " Resume continues from the bytes the server already has." : ""}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
