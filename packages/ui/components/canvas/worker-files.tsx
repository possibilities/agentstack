"use client";

import { useState } from "react";
import { ChevronLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { decodeChunk, parentPath } from "@/lib/stack/bot-state";
import type { StateFile, StateFilePage, StateFileRead, WorkerSession } from "@/lib/stack/types";
import { chunk, FileRow, PreviewBody, useFilePreview } from "./bot-state-files";
import { MoreButton } from "./bot-state-shared";
import { usePagedRead } from "./owner-reads";
import { useStore } from "./provider";

/**
 * The Worker's retained Git worktree as files, including after the Worker closed. Read-only: close, remove and
 * discard stay the lifecycle controls, and Changes shows what differs from the base commit.
 */
export function WorkerFilesTab({ worker, generation }: { worker: WorkerSession; generation: number }) {
  const store = useStore();
  const [path, setPath] = useState(".");
  const pages = usePagedRead<StateFile>((offset, revision) => store.call<StateFilePage>("worker", "worker_workspace_list", { id: worker.id, path, offset, limit: 100, ...(revision ? { revision } : {}) })
    .then((page) => ({ items: page.entries, revision: page.revision, nextOffset: page.nextOffset })), `${worker.id}:${path}`, generation);
  const preview = useFilePreview((file, revision) => store.call<StateFileRead>("worker", "worker_workspace_read", { id: worker.id, path: file, offset: 0, length: chunk, ...(revision ? { revision } : {}) }));
  return (
    <div className="flex flex-col gap-2 p-3">
      <p className="text-[0.7rem] text-pretty text-muted-foreground">The retained worktree on disk. Its files, the native conversation and the source branch have separate lifecycles. Nothing here changes them; refresh after the Worker writes.</p>
      <div className="flex min-w-0 items-center gap-1 text-xs">
        <Button size="icon-xs" variant="ghost" aria-label="Parent directory" disabled={path === "."} onClick={() => { setPath(parentPath(path)); preview.close(); }}><ChevronLeftIcon /></Button>
        <code className="min-w-0 truncate font-mono text-[0.7rem]">{path === "." ? "./" : `./${path}/`}</code>
        <Button size="xs" variant="ghost" className="ml-auto" disabled={pages.loading} onClick={pages.refresh}>{pages.loading ? <Spinner /> : "Refresh"}</Button>
      </div>
      {pages.error ? <p className="text-xs text-destructive">Worktree unavailable: {pages.error}</p> : null}
      {pages.page ? pages.page.items.length ? (
        <ul aria-label="Worktree files" className="-mx-1 flex flex-col">
          {pages.page.items.map((file) => (
            <FileRow key={file.path} file={file} active={preview.state?.key === file.path} selectable={false} selected={false} covered={null}
              onOpen={() => { setPath(file.path); preview.close(); }}
              onPreview={() => preview.state?.key === file.path ? preview.close() : preview.open(file.path, file.revision)} />
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">This directory is empty.</p> : null}
      {pages.page ? <MoreButton nextOffset={pages.page.nextOffset} loading={pages.loading} onMore={pages.more} restarted={pages.page.restarted} /> : null}
      {preview.state ? (
        <div className="flex flex-col gap-1 rounded-md border border-dashed p-2">
          <span className="flex items-center gap-2 text-xs"><span className="min-w-0 truncate font-mono">{preview.state.key}</span>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={preview.close}>Close</Button></span>
          {preview.state.loading ? <Spinner /> : null}
          {preview.state.error ? <p className="text-xs text-destructive">{/revision changed/.test(preview.state.error) ? "This file changed since it was listed. Refresh to read it again." : preview.state.error}</p> : null}
          {preview.state.read ? <PreviewBody read={preview.state.read} preview={decodeChunk(preview.state.read)} /> : null}
        </div>
      ) : null}
    </div>
  );
}
