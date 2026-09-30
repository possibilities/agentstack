"use client";

import { useState } from "react";
import { ChevronLeftIcon, FileIcon, FolderIcon, LinkIcon, OctagonAlertIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { absentStore, coveredBy, decodeChunk, fileName, parentPath, quarantined, toggleSelection, type BotStateAction, type BotUpload, type Preview } from "@/lib/stack/bot-state";
import { relativeTime } from "@/lib/stack/derive";
import { formatBytes } from "@/lib/stack/resources";
import type { StateFile, StateFileRead, StateFilePage } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { StateFlowView } from "./state-flow";
import { BotAction, hintClass, labelClass, MoreButton, Pill, ReadError, useBotAction, useBotPages, useBotRead, ViewHeader, type BotScope } from "./bot-state-shared";
import { useNow, useStore } from "./provider";

export const chunk = 65_536;

/** Plain text or binary metadata for one bounded read; content is never rendered as markup. */
export function PreviewBody({ read, preview }: { read: StateFileRead; preview: Preview }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.68rem] text-muted-foreground tabular-nums">
        {preview.kind === "binary" ? `Binary content · ${formatBytes(read.totalBytes)}` : `Showing ${formatBytes(read.bytes)} of ${formatBytes(read.totalBytes)}`}
        {read.nextOffset !== null && preview.kind === "text" ? " (first chunk)" : ""}
      </span>
      {preview.kind === "text" ? <pre className="max-h-64 overflow-auto rounded-md border bg-background/60 p-2 font-mono text-[0.68rem] break-all whitespace-pre-wrap">{preview.text || "(empty)"}</pre> : null}
    </div>
  );
}

/** Explicit, revision-fenced reading of one file; a changed file is reported, never silently re-read. */
export function useFilePreview(read: (key: string, revision?: string) => Promise<StateFileRead>) {
  const [state, setState] = useState<{ key: string; read: StateFileRead | null; error: string | null; loading: boolean } | null>(null);
  return {
    state,
    open(key: string, revision?: string) {
      setState({ key, read: null, error: null, loading: true });
      read(key, revision).then((value) => setState((held) => held?.key === key ? { key, read: value, error: null, loading: false } : held),
        (error: unknown) => setState((held) => held?.key === key ? { key, read: null, error: error instanceof Error ? error.message : String(error), loading: false } : held));
    },
    close() { setState(null); },
  };
}

export function FileRow({ file, selectable, selected, covered, onToggle, onOpen, onPreview, active }: {
  file: StateFile; selectable: boolean; selected: boolean; covered: string | null; onToggle?(): void; onOpen?(): void; onPreview?(): void; active: boolean;
}) {
  const now = useNow(60_000);
  const Icon = file.type === "directory" ? FolderIcon : file.type === "symlink" ? LinkIcon : file.type === "special" ? OctagonAlertIcon : FileIcon;
  const name = fileName(file.path);
  return (
    <li className={cn("flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-muted/60", active && "bg-muted")}>
      {selectable ? (
        <input type="checkbox" className="size-3.5 accent-destructive" aria-label={`Select ${file.path}`} checked={selected || covered !== null} disabled={covered !== null || !onToggle}
          title={covered ? `Included in ${covered}` : undefined} onChange={onToggle} />
      ) : null}
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {file.type === "directory" && onOpen ? (
        <button type="button" className="min-w-0 truncate text-left font-medium hover:underline" onClick={onOpen}>{name}/</button>
      ) : file.type === "file" && onPreview ? (
        <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={onPreview}>{name}</button>
      ) : <span className="min-w-0 truncate">{name}</span>}
      {file.type === "symlink" ? <Pill title="Listed, never traversed or read">symlink · not followed</Pill> : null}
      {file.type === "special" ? <Pill tone="warning" title="Special files cannot be read or cleared">special file</Pill> : null}
      {quarantined(file) ? <Pill tone="warning" title="Retained by an interrupted cleanup; inspect it with its receipt">cleanup quarantine</Pill> : null}
      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{file.type === "file" ? formatBytes(file.bytes) : ""}</span>
      <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums" title={file.modifiedAt}>{relativeTime(Date.parse(file.modifiedAt), now)}</span>
    </li>
  );
}

/**
 * The Bot's cwd. Any workspace can be browsed; only a ledger-owned one can be cleared, and whole-workspace clearing
 * includes Git metadata. Clearing files does not touch the conversation.
 */
export function WorkspaceView({ scope, owned, cwd }: { scope: BotScope; owned: boolean; cwd: string | null }) {
  const store = useStore();
  const [path, setPath] = useState(".");
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"paths" | "all">("paths");
  const pages = useBotPages<StateFile>((offset, revision) => store.call<StateFilePage>("bots", "bot_workspace_list", { botId: scope.botId, path, offset, limit: 100, ...(revision ? { revision } : {}) })
    .then((page) => ({ items: page.entries, revision: page.revision, nextOffset: page.nextOffset })), `${scope.incarnation}:${path}`, scope.observe);
  const preview = useFilePreview((file, revision) => store.call<StateFileRead>("bots", "bot_workspace_read",
    { botId: scope.botId, path: file, offset: 0, length: chunk, ...(revision ? { revision } : {}) }));
  const action: BotStateAction = { kind: "workspace_clear", selection: mode === "all" ? { all: true } : { paths: selected.length ? selected : ["."] } };
  const controls = useBotAction(scope, action);
  const idle = controls.flow.phase === "idle";
  // The preview reads under the listed revision, so a file changed since listing is refused rather than shown.
  const openFile = (file: StateFile) => { if (preview.state?.key === file.path) preview.close(); else preview.open(file.path, file.revision); };
  return (
    <div className="flex flex-col gap-2">
      <ViewHeader title="Workspace" loading={pages.loading} onRefresh={pages.refresh}>
        <Pill tone={owned ? "bots" : "muted"}>{owned ? "Stack-owned" : "external"}</Pill>
      </ViewHeader>
      {cwd ? <code className="font-mono text-[0.68rem] break-all text-muted-foreground">{cwd}</code> : null}
      {!owned ? <p className={hintClass}>This Bot runs in a supplied directory. You can read it here, but Stack has no authority to delete its contents.</p> : null}
      <p className={hintClass}>Tools and the Bot write here without Stack events. Refresh to see their changes.</p>
      <div className="flex min-w-0 items-center gap-1 text-xs">
        <Button size="icon-xs" variant="ghost" aria-label="Parent directory" disabled={path === "."} onClick={() => { setPath(parentPath(path)); preview.close(); }}><ChevronLeftIcon /></Button>
        <code className="min-w-0 truncate font-mono text-[0.7rem]">{path === "." ? "./" : `./${path}/`}</code>
      </div>
      <ReadError error={pages.error} what="Workspace listing" />
      {pages.page ? pages.page.items.length ? (
        <ul aria-label="Workspace files" className="-mx-1 flex max-h-72 flex-col overflow-auto">
          {pages.page.items.map((file) => (
            <FileRow key={file.path} file={file} active={preview.state?.key === file.path}
              selectable={owned && mode === "paths"} selected={selected.includes(file.path)} covered={coveredBy(selected, file.path)}
              onToggle={idle ? () => setSelected(toggleSelection(selected, file.path)) : undefined}
              onOpen={() => { setPath(file.path); preview.close(); }} onPreview={() => openFile(file)} />
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">This directory is empty.</p> : pages.loading ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner />Listing…</p> : null}
      {pages.page ? <MoreButton nextOffset={pages.page.nextOffset} loading={pages.loading} onMore={pages.more} restarted={pages.page.restarted} /> : null}
      {preview.state ? (
        <div className="flex flex-col gap-1 rounded-md border border-dashed p-2">
          <span className="flex items-center gap-2 text-xs"><span className="min-w-0 truncate font-mono">{preview.state.key}</span>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={preview.close}>Close</Button></span>
          {preview.state.loading ? <Spinner /> : null}
          {preview.state.error ? <p className="text-xs text-destructive">{/revision changed/.test(preview.state.error) ? "This file changed since it was listed. Refresh the listing to read it again." : preview.state.error}</p> : null}
          {preview.state.read ? <PreviewBody read={preview.state.read} preview={decodeChunk(preview.state.read)} /> : null}
        </div>
      ) : null}
      {owned ? (
        <div className="flex flex-col gap-1.5 border-t pt-2">
          <span className={labelClass}>Clear files</span>
          <div role="radiogroup" aria-label="Clear scope" className="flex flex-col gap-1 text-xs">
            <label className="flex items-center gap-1.5"><input type="radio" name={`${scope.incarnation}-workspace-scope`} checked={mode === "paths"} disabled={!idle} onChange={() => setMode("paths")} />
              Selected entries <span className="text-muted-foreground tabular-nums">({selected.length})</span></label>
            <label className="flex items-center gap-1.5"><input type="radio" name={`${scope.incarnation}-workspace-scope`} checked={mode === "all"} disabled={!idle} onChange={() => setMode("all")} />
              The whole workspace, including <code className="font-mono">.git</code></label>
          </div>
          {mode === "paths" && selected.length ? <ul className="flex flex-col font-mono text-[0.68rem] text-muted-foreground">{selected.map((item) => <li key={item} className="truncate">{item}</li>)}</ul> : null}
          <p className={hintClass}>The conversation, settings and other owners&rsquo; copies are unaffected. The plan binds these exact files; a file changed afterwards needs a new plan.</p>
          <StateFlowView controls={controls} label={mode === "all" ? "Prepare whole-workspace clear" : "Prepare clear of selected entries"} applyLabel="Clear these files"
            unavailable={scope.unavailable ?? (mode === "paths" && !selected.length ? "Select entries to clear first." : null)} />
        </div>
      ) : null}
    </div>
  );
}

/** Bot-private uploads. Removal retires the UUID; attachment associations and copied bytes remain. */
export function UploadsView({ scope }: { scope: BotScope }) {
  const store = useStore();
  const pages = useBotPages<StateFile>((offset, revision) => store.call<StateFilePage>("bots", "chat_upload_list", { botId: scope.botId, offset, limit: 100, ...(revision ? { revision } : {}) })
    .then((page) => ({ items: absentStore(page) ? [] : page.entries, revision: page.revision, nextOffset: page.nextOffset })), scope.incarnation, scope.observe);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <ViewHeader title="Uploads" loading={pages.loading} onRefresh={pages.refresh} />
      <ReadError error={pages.error} what="Upload storage" />
      {pages.page ? pages.page.items.length ? (
        <ul aria-label="Uploads" className="-mx-1 flex flex-col gap-1">
          {pages.page.items.map((file) => {
            const id = fileName(file.path);
            return (
              <li key={id} className="flex flex-col gap-1 rounded-md px-1 py-1 hover:bg-muted/40">
                <button type="button" className="flex min-w-0 items-center gap-2 text-left text-xs" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
                  <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-[0.7rem]">{id}</span>
                  {quarantined(file) ? <Pill tone="warning">cleanup quarantine</Pill> : null}
                </button>
                {open === id && !quarantined(file) ? <UploadDetail scope={scope} id={id} /> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="text-xs text-muted-foreground">No uploads are stored for this Bot.</p> : null}
      {pages.page ? <MoreButton nextOffset={pages.page.nextOffset} loading={pages.loading} onMore={pages.more} restarted={pages.page.restarted} /> : null}
    </div>
  );
}

function UploadDetail({ scope, id }: { scope: BotScope; id: string }) {
  const store = useStore();
  const status = useBotRead(() => store.call<BotUpload>("bots", "chat_upload_status", { botId: scope.botId, id }), `${scope.incarnation}:${id}`, scope.observe);
  const preview = useFilePreview(() => store.call<StateFileRead>("bots", "chat_upload_read", { botId: scope.botId, id, offset: 0, length: chunk }));
  const upload = status.data;
  return (
    <div className="flex flex-col gap-1.5 pl-5 text-xs">
      <ReadError error={status.error} what="Upload status" />
      {upload ? (
        <dl className="grid grid-cols-[5rem_1fr] gap-x-2">
          <dt className="text-muted-foreground">Name</dt><dd className="truncate">{upload.name}</dd>
          <dt className="text-muted-foreground">Size</dt><dd className="tabular-nums">{formatBytes(upload.bytes)}{upload.path ? "" : ` · ${formatBytes(upload.offset)} staged`}</dd>
          <dt className="text-muted-foreground">State</dt><dd>{upload.path ? "Finalized" : "Staging, not finalized"}</dd>
          <dt className="text-muted-foreground">SHA-256</dt><dd className="truncate font-mono text-[0.66rem]" title={upload.sha256}>{upload.sha256}</dd>
        </dl>
      ) : null}
      {upload?.path ? (
        preview.state ? (
          <>
            {preview.state.error ? <p className="text-destructive">{preview.state.error}</p> : null}
            {preview.state.read ? <PreviewBody read={preview.state.read} preview={decodeChunk(preview.state.read)} /> : <Spinner />}
          </>
        ) : <Button size="xs" variant="outline" className="self-start" onClick={() => preview.open(id)}>Read content</Button>
      ) : null}
      <BotAction scope={scope} action={{ kind: "upload_remove", uploadId: id }} label="Prepare upload removal" applyLabel="Remove this upload">
        <p className={hintClass}>Removing retires this upload ID for this Bot. Attachment metadata, transcript paths and any copies of the bytes stay where they are, so those references will stop opening.</p>
      </BotAction>
    </div>
  );
}

/** The Bot's log, read in bounded chunks under one revision. A missing log is unavailable, not an empty transcript. */
export function LogView({ scope }: { scope: BotScope }) {
  const store = useStore();
  const [chunks, setChunks] = useState<{ key: string; reads: StateFileRead[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const first = useBotRead(() => store.call<StateFileRead>("bots", "bot_log_read", { botId: scope.botId, offset: 0, length: chunk }), scope.incarnation, scope.observe);
  const held = first.data && chunks?.key === first.data.revision ? chunks.reads : first.data ? [first.data] : [];
  const last = held.at(-1);
  const more = () => {
    if (!last || last.nextOffset === null || !first.data) return;
    setPending(true);
    setNotice(null);
    store.call<StateFileRead>("bots", "bot_log_read", { botId: scope.botId, offset: last.nextOffset, length: chunk, revision: last.revision })
      .then((next) => setChunks({ key: first.data!.revision, reads: [...held, next] }),
        () => { setNotice("The log changed while reading, so it was read again from the start."); first.refresh(); })
      .finally(() => setPending(false));
  };
  const text = held.map((read) => decodeChunk(read)).map((preview) => preview.kind === "text" ? preview.text : "[binary content]").join("");
  return (
    <div className="flex flex-col gap-2">
      <ViewHeader title="Log" loading={first.loading} onRefresh={first.refresh} />
      <ReadError error={first.error} what="Log" />
      {notice ? <p role="status" className="text-xs text-warning">{notice}</p> : null}
      {first.data ? (
        <>
          <span className="text-[0.68rem] text-muted-foreground tabular-nums">Showing {formatBytes(held.reduce((sum, read) => sum + read.bytes, 0))} of {formatBytes(first.data.totalBytes)}</span>
          <pre aria-label="Log text" className="max-h-72 overflow-auto rounded-md border bg-background/60 p-2 font-mono text-[0.66rem] break-all whitespace-pre-wrap">{text || "(empty)"}</pre>
          {last?.nextOffset !== null ? <Button size="xs" variant="ghost" className="self-start" disabled={pending} onClick={more}>Read next {formatBytes(chunk)}</Button> : null}
        </>
      ) : null}
      <BotAction scope={scope} action={{ kind: "log_clear" }} label="Prepare log clear" applyLabel="Clear this log">
        <p className={hintClass}>The next launch writes a new log.</p>
      </BotAction>
    </div>
  );
}

/** Retired runtime credential copies, as metadata. Discarding one can lose the only unreconciled credential refresh. */
export function RecoveryView({ scope }: { scope: BotScope }) {
  const store = useStore();
  const pages = useBotPages<StateFile>((offset, revision) => store.call<StateFilePage>("bots", "bot_recovery_list", { botId: scope.botId, offset, limit: 100, ...(revision ? { revision } : {}) })
    .then((page) => ({ items: absentStore(page) ? [] : page.entries, revision: page.revision, nextOffset: page.nextOffset })), scope.incarnation, scope.observe);
  return (
    <div className="flex flex-col gap-2">
      <ViewHeader title="Credential recovery" loading={pages.loading} onRefresh={pages.refresh} />
      <p className={hintClass}>Metadata only. The credential files themselves are never read here.</p>
      <ReadError error={pages.error} what="Recovery storage" />
      {pages.page ? pages.page.items.length ? (
        <ul aria-label="Recovery directories" className="flex flex-col gap-2">
          {pages.page.items.map((file) => (
            <li key={file.path} className="flex flex-col gap-1.5 rounded-md border p-2 text-xs">
              <span className="flex items-center gap-2"><FolderIcon aria-hidden className="size-3.5 text-muted-foreground" /><code className="min-w-0 truncate font-mono">{file.path}</code>
                <span className="ml-auto text-muted-foreground" title={file.modifiedAt}>{file.type}</span></span>
              {file.type === "directory" && !quarantined(file) ? (
                <BotAction scope={scope} action={{ kind: "recovery_discard", directory: file.path }} label="Prepare discard" applyLabel="Discard this credential copy">
                  <p className="flex items-start gap-1.5 text-warning"><Trash2Icon aria-hidden className="mt-px size-3.5 shrink-0" />
                    This may be the only copy of a credential refresh that never reached the account. Discarding it cannot be undone. Only this directory is selected.</p>
                </BotAction>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">No credential recovery copies are stored for this Bot.</p> : null}
      {pages.page ? <MoreButton nextOffset={pages.page.nextOffset} loading={pages.loading} onMore={pages.more} restarted={pages.page.restarted} /> : null}
    </div>
  );
}
