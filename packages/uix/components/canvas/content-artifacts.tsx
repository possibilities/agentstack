"use client";

import { useState } from "react";
import { ArchiveRestoreIcon, BoxesIcon, ChevronRightIcon, CopyIcon, EllipsisIcon, EyeIcon, LinkIcon, ScanSearchIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import { nodeKey, type ContentArtifact } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { contentError, useContentActions } from "./content-actions";
import { IsoTime, TagChip, useContentRead } from "./content-shared";
import { Empty } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { Window } from "./window";

const copy = (value: string, what: string) => { void navigator.clipboard.writeText(value).then(() => toast.success(`Copied ${what}`)); };

/** Published Artifacts and their immutable versions. Publishing stays agent-only; people cite, tombstone and restore. */
export function ContentArtifactsWindow() {
  const { contentArtifacts, status, endpoints, remote } = useStack();
  const actions = useContentActions();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const artifacts = (contentArtifacts.data ?? []).filter((artifact) => words.every((word) =>
    `${artifact.name} ${artifact.title ?? ""} ${artifact.kind} ${(artifact.tags ?? []).join(" ")}`.toLowerCase().includes(word)));
  return (
    <Window id="content-artifacts" title="Artifacts" subtitle="content · published by agents" icon={BoxesIcon} accent="content"
      count={contentArtifacts.data?.length ?? null} status={status.content} endpoint={endpoints.content} updatedAt={contentArtifacts.at} error={contentArtifacts.error}
      empty={!contentArtifacts.data?.length}
      actions={
        <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label="Restore a tombstoned Artifact" title={remote?.scope === "view" ? "Requires uix:control" : "Restore a tombstoned Artifact"}
          disabled={status.content !== "open" || remote?.scope === "view"} onClick={() => actions.restoreByName("artifact")}><ArchiveRestoreIcon /></Button>
      }>
      {contentArtifacts.data?.length ? (
        <>
          <InputGroup className="h-8">
            <InputGroupAddon><SearchIcon /></InputGroupAddon>
            <InputGroupInput aria-label="Filter Artifacts" placeholder="Filter by name, kind or tag" value={query}
              onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
            {query ? <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear filter" onClick={() => setQuery("")}><XIcon /></InputGroupButton></InputGroupAddon> : null}
          </InputGroup>
          {artifacts.length ? (
            <ul className="flex flex-col gap-1">
              {artifacts.map((artifact) => (
                <ArtifactRow key={artifact.name} artifact={artifact} open={Boolean(expanded[artifact.name])}
                  onToggle={() => setExpanded((value) => ({ ...value, [artifact.name]: !value[artifact.name] }))} />
              ))}
            </ul>
          ) : <p className="px-0.5 py-4 text-center text-[0.8rem] text-muted-foreground">No Artifacts match “{query.trim()}”.</p>}
        </>
      ) : <Empty icon={BoxesIcon} title={contentArtifacts.data ? "No Artifacts · agents publish them" : "Artifacts unavailable"} />}
    </Window>
  );
}

function ArtifactRow({ artifact, open, onToggle }: { artifact: ContentArtifact; open: boolean; onToggle(): void }) {
  const actions = useContentActions();
  const { select, flash } = useWorkbench();
   const { status, remote } = useStack();
  const node = { kind: "artifact", id: artifact.name } as const;
  const key = nodeKey(node);
  const previewing = actions.selection?.kind === "artifact" && actions.selection.name === artifact.name;
  const connected = status.content === "open";
  return (
    <li data-node={key} className={cn("group/row relative rounded-lg border bg-background/60", previewing && "border-pkg-content/50 bg-pkg-content/5")}>
      {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-1 rounded-[inherit] animate-uix-flash" /> : null}
      <div className="flex items-start gap-1 px-1.5 py-1.5">
        <button type="button" aria-expanded={open} aria-label={open ? `Hide ${artifact.name} versions` : `Show ${artifact.name} versions`} onClick={onToggle}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
        </button>
        <button type="button" onClick={() => actions.preview({ kind: "artifact", name: artifact.name })} aria-current={previewing ? "true" : undefined}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm pt-0.5 text-left focus-visible:outline-2 focus-visible:outline-ring">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[0.78rem] font-medium">{artifact.name}</span>
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[0.62rem] text-muted-foreground">{artifact.kind}</span>
          </span>
          {artifact.title && artifact.title !== artifact.name ? <span className="truncate text-[0.72rem] text-muted-foreground">{artifact.title}</span> : null}
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="font-mono text-[0.64rem] text-muted-foreground" title={artifact.version}>{artifact.version.slice(0, 12)}</span>
            {(artifact.tags ?? []).slice(0, 4).map((tag) => <TagChip key={tag} tag={tag} />)}
            {artifact.created_at ? <IsoTime at={artifact.created_at} className="ml-auto text-[0.64rem] text-muted-foreground" /> : null}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${artifact.name} actions`} />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => actions.preview({ kind: "artifact", name: artifact.name })}><EyeIcon />Preview</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copy(artifact.version_url, "citation")}><LinkIcon />Copy citation</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copy(artifact.url, "latest link")}><CopyIcon />Copy latest</DropdownMenuItem>
              <DropdownMenuItem onClick={() => select(node)}><ScanSearchIcon />Inspect record</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
             <DropdownMenuItem variant="destructive" disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.confirmRemoveArtifact({ name: artifact.name })}><Trash2Icon />Tombstone every version…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open ? <Versions name={artifact.name} /> : null}
    </li>
  );
}

function Versions({ name }: { name: string }) {
  const actions = useContentActions();
   const { status, remote } = useStack();
  const read = useContentRead<{ versions: ContentArtifact[] }>("artifacts_versions", { name });
  const connected = status.content === "open";
  if (!read.data) return <p className="px-9 pb-2 text-[0.7rem] text-muted-foreground">{read.error ?? "Loading versions…"}</p>;
  const restore = (version: ContentArtifact) => {
    actions.run(`artifact-restore:${name}:${version.version}`, "artifacts_restore", { name, version: version.version })
      .then(() => toast.success(`Restored ${name} ${version.version.slice(0, 12)}`), (cause) => toast.error(contentError(cause)));
  };
  return (
    <ol aria-label={`${name} versions, newest first`} className="flex flex-col border-t px-1.5 py-1">
      {read.data.versions.map((version) => {
        const tombstoned = Boolean(version.deleted);
        const selected = actions.selection?.kind === "artifact" && actions.selection.name === name && actions.selection.version === version.version;
        const restoring = actions.pending.has(`artifact-restore:${name}:${version.version}`);
        return (
          <li key={version.version} className={cn("group/version flex items-center gap-1.5 rounded-md py-0.5 pr-0.5 pl-7 text-[0.72rem] hover:bg-muted/70", selected && "bg-pkg-content/10")}>
            <button type="button" onClick={() => actions.preview({ kind: "artifact", name, version: version.version })}
              className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring", tombstoned && "text-muted-foreground line-through")}>
              <span className="font-mono">{version.version.slice(0, 12)}</span>
              {version.latest ? <span className="rounded bg-success/15 px-1 text-[0.6rem] font-medium text-success no-underline">latest</span> : null}
              {tombstoned ? <span className="truncate text-[0.64rem] no-underline" title={version.deleted_reason ?? undefined}>tombstoned</span> : null}
              {version.created_at ? <IsoTime at={version.created_at} className="ml-auto text-[0.64rem] text-muted-foreground" /> : null}
            </button>
            {tombstoned ? (
               <Button size="xs" variant="ghost" disabled={!connected || restoring || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => restore(version)}>
                {restoring ? <Spinner data-icon="inline-start" /> : <ArchiveRestoreIcon data-icon="inline-start" />}Restore
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/version:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`Version ${version.version.slice(0, 12)} actions`} />}>
                  <EllipsisIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => actions.preview({ kind: "artifact", name, version: version.version })}><EyeIcon />Preview</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => copy(version.version_url, "citation")}><LinkIcon />Copy citation</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                   <DropdownMenuItem variant="destructive" disabled={!connected || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={() => actions.confirmRemoveArtifact({ name, version: version.version })}><Trash2Icon />Tombstone this version…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        );
      })}
    </ol>
  );
}
