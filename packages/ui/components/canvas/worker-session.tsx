"use client";

import { WorkerFilesTab } from "./worker-files";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronsUpDownIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CopyPlusIcon, FolderGitIcon, GitBranchIcon, HammerIcon, LockIcon, ScrollTextIcon, ShieldQuestionIcon, SparklesIcon, TriangleAlertIcon, WrenchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { classifyWorkerRole, workerRoleHint, workerRoleLabel, type WorkerRole } from "@/lib/stack/roles";
import { workerEventFence, workerEventReceiptLabels, workerObservationPhaseLabels } from "@/lib/stack/completion";
import { primaryWorker } from "@/lib/stack/worker-windows";
import type { StackStore } from "@/lib/stack/store";
import { localOperation, localOperations } from "@/lib/stack/state";
import type { RoleCatalog, ServeCompletionReceipt, WorkerDiff, WorkerDiffFile, WorkerDetail, WorkerEventPage, WorkerEventReceipt, WorkerPermission, WorkerRecord, WorkerRecordChunk, WorkerRecordPage, WorkerSession, WorkerStatus, WorkerTool, WorkerToolPage, WorkerTranscriptEntry, WorkerTranscriptPage, WorkerTurn, WorkerTurnObservation, WorkerTurnPage } from "@/lib/stack/types";
import { appendBySeq, conversation, eventReceiptFor, eventTurns, localOperator, settingsMismatch, span, workerAttention, workerLabel, workerOrigin, type ConversationItem, type PlanEntry } from "@/lib/stack/workers";
import { cn } from "@/lib/utils";
import { Markdown } from "./chat-window";
import { ContentCleared, CopyButton, NodeLink, Row, StatusDot, Time } from "./primitives";
import { RecordTree } from "./record-tree";
import { useNow, useStack, useStore, useWorkbench, useWorkerWindows } from "./provider";
import { phaseTitle, phaseTone } from "./worker-windows";
import { Window } from "./window";
import { WorkerSettingsTab } from "./worker-settings";
import { WorkContextLink } from "./hud-shared";
import { WorkerMaintenance, WorkerSessionMaintenance, workerStateOperations } from "./worker-maintenance";
import { BotWatch, useObservedRead } from "./watch-receipts";

type Tab = "conversation" | "changes" | "files" | "turns" | "tools" | "records" | "session" | "settings";
const tabs: Array<[Tab, string]> = [["conversation", "Conversation"], ["changes", "Changes"], ["files", "Files"], ["turns", "Turns"], ["tools", "Tools"], ["records", "Records"], ["session", "Session"], ["settings", "Settings"]];

/** Keep a Worker's scoped subscription and status while a window shows it; its generation drives re-reads. */
function useWatchedWorker(id: string | null): { status: WorkerStatus | null; statusError: string | null; generation: number } {
  const store = useStore();
  const { workerStatuses, workerGenerations } = useStack();
  useEffect(() => id ? store.watchWorker(id) : undefined, [store, id]);
  const resource = id ? workerStatuses[id] : undefined;
  return { status: resource?.data ?? null, statusError: resource?.error ?? null, generation: id ? workerGenerations[id] ?? 0 : 0 };
}

type Feed<T> = { entries: T[]; hasMore: boolean; loading: boolean; error: string | null };

/**
 * Append-only pages by sequence. `eager` feeds read to the end; others read one
 * page at a time. A new generation continues from the last sequence when the
 * feed has reached its end, so progress appears without re-reading history.
 */
function useSeqFeed<T extends { seq: number }>(key: string | null, generation: number, eager: boolean,
  read: (afterSeq: number) => Promise<{ entries: T[]; nextSeq: number; hasMore: boolean }>): Feed<T> & { more(): void } {
  const [feed, setFeed] = useState<Feed<T> & { key: string | null }>({ key, entries: [], hasMore: true, loading: false, error: null });
  const cursor = useRef({ key, nextSeq: 0, hasMore: true, running: false, again: false });
  const readRef = useRef(read);
  readRef.current = read;
  const pump = useCallback(async () => {
    const state = cursor.current;
    if (state.running) { state.again = true; return; }
    state.running = true;
    const runKey = state.key;
    setFeed((current) => current.key === runKey ? { ...current, loading: true } : current);
    try {
      let pages = 0;
      do {
        const page = await readRef.current(state.nextSeq);
        if (cursor.current.key !== runKey) return;
        state.nextSeq = Math.max(state.nextSeq, page.nextSeq);
        state.hasMore = page.hasMore;
        setFeed((current) => current.key === runKey ? { ...current, entries: appendBySeq(current.entries, page.entries), hasMore: page.hasMore, error: null } : current);
        pages++;
      } while (state.hasMore && eager && pages < 200);
    } catch (error) {
      if (cursor.current.key === runKey) setFeed((current) => current.key === runKey ? { ...current, error: error instanceof Error ? error.message : String(error) } : current);
    } finally {
      if (cursor.current.key === runKey) {
        state.running = false;
        setFeed((current) => current.key === runKey ? { ...current, loading: false } : current);
        if (state.again) { state.again = false; if (!state.hasMore || eager) void pump(); }
      }
    }
  }, [eager]);
  useEffect(() => {
    if (cursor.current.key !== key) {
      cursor.current = { key, nextSeq: 0, hasMore: true, running: false, again: false };
      setFeed({ key, entries: [], hasMore: true, loading: false, error: null });
    }
    if (!key) return;
    // The first read, and later notices once the end has been reached.
    if (cursor.current.nextSeq === 0 || !cursor.current.hasMore || eager) void pump();
  }, [key, generation, eager, pump]);
  const current = feed.key === key ? feed : { entries: [], hasMore: true, loading: false, error: null };
  return { ...current, more: () => void pump() };
}

/** A snapshot read that repeats on each generation; overlapping reads coalesce into one follow-up. */
function useSnapshot<T>(key: string | null, generation: number, read: () => Promise<T>): { data: T | null; error: string | null; at: number | null } {
  const [value, setValue] = useState<{ key: string | null; data: T | null; error: string | null; at: number | null }>({ key, data: null, error: null, at: null });
  const flight = useRef({ key, running: false, again: false });
  const readRef = useRef(read);
  readRef.current = read;
  const run = useCallback(async () => {
    const state = flight.current;
    if (state.running) { state.again = true; return; }
    state.running = true;
    const runKey = state.key;
    try {
      const data = await readRef.current();
      if (flight.current.key === runKey) setValue({ key: runKey, data, error: null, at: Date.now() });
    } catch (error) {
      if (flight.current.key === runKey) setValue((current) => ({ key: runKey, data: current.key === runKey ? current.data : null, error: error instanceof Error ? error.message : String(error), at: Date.now() }));
    } finally {
      state.running = false;
      if (state.again && flight.current === state) { state.again = false; void run(); }
    }
  }, []);
  useEffect(() => {
    if (flight.current.key !== key) flight.current = { key, running: false, again: false };
    if (key) void run();
  }, [key, generation, run]);
  return value.key === key ? value : { data: null, error: null, at: null };
}

async function readTurns(store: StackStore, id: string): Promise<WorkerTurn[]> {
  const turns: WorkerTurn[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < 40; page++) {
    const result = await store.call<WorkerTurnPage>("worker", "worker_turn_list", { id, limit: 50, ...(afterId ? { afterId } : {}) });
    turns.push(...result.turns);
    if (!result.hasMore || !result.nextId) break;
    afterId = result.nextId;
  }
  return turns;
}

/** Tools are merged records, so they are re-read from the first page after progress, as many pages as were shown. */
async function readTools(store: StackStore, id: string, pages: number): Promise<{ tools: WorkerTool[]; tasks: WorkerToolPage["tasks"]; hasMore: boolean }> {
  const tools: WorkerTool[] = [];
  const tasks: WorkerToolPage["tasks"] = [];
  let afterSeq = 0;
  let hasMore = false;
  for (let page = 0; page < pages; page++) {
    const result = await store.call<WorkerToolPage>("worker", "worker_tool_list", { id, afterSeq, limit: 50 });
    tools.push(...result.tools);
    tasks.push(...result.tasks);
    hasMore = result.hasMore;
    if (!hasMore) break;
    afterSeq = result.nextSeq;
  }
  return { tools, tasks, hasMore };
}

/**
 * One Worker: what it was asked, what it did, and what it is waiting for. Its Bot answers and steers it; the
  * window reads, except for managed settings and explicit local state maintenance.
 */
export function WorkerWindow({ id }: { id: string }) {
  const { windows, workerWindows, turnFocus } = useWorkerWindows();
  const { workerSessions, workerAccounts, remote } = useStack();
  const { goTo } = useWorkbench();
  const workerId = windows.find((window) => window.id === id)?.workerId ?? null;
  const listed = workerSessions.data?.find((worker) => worker.id === workerId) ?? null;
  const { status, statusError, generation } = useWatchedWorker(workerId);
  // The status read is fresher than the list after a scoped notice.
  const worker = status?.worker.id === workerId ? status.worker : listed;
  const labels = workerAccountLabels(workerAccounts.data);
  const [tab, setTab] = useState<Tab>("conversation");
  // The focus remembers which Worker it named, so a window that switched Workers drops it instead of warning.
  const [focus, setFocus] = useState<{ workerId: string; turnId: string } | null>(null);
  const focusSeq = turnFocus?.seq ?? 0;
  useEffect(() => {
    const match = turnFocus && turnFocus.windowId === id && turnFocus.workerId === workerId ? { workerId: turnFocus.workerId, turnId: turnFocus.turnId } : null;
    setFocus(match);
    if (match) setTab("turns");
  }, [focusSeq]);
  const primary = id === primaryWorker;
  const actions = (
    <>
      <WorkerSwitcher windowId={id} workerId={workerId} />
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New Worker window" className="text-muted-foreground"
          onClick={() => goTo({ kind: "worker-window", id: workerWindows.open(workerId) })} />}>
          <CopyPlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">New Worker window</TooltipContent>
      </Tooltip>
      {primary ? null : (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Close Worker window" className="text-muted-foreground" onClick={() => workerWindows.close(id)} />}>
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      )}
    </>
  );
  return (
    <Window id={id} title={worker ? workerLabel(worker) : "Worker"} subtitle={worker ? `${providerTitle(worker.provider)} · ${labels.get(worker.accountId) ?? shortId(worker.accountId)}` : "worker"}
      icon={HammerIcon} accent="worker" node={worker ? { kind: "worker", id: worker.id } : undefined} reveal={{ kind: "worker-window", id }} bleed actions={actions}>
      {!workerId ? <Placeholder title="No Worker selected" hint="Choose one in the Workers list or with the switcher." />
        : !worker ? <Placeholder title={workerSessions.data ? "This Worker is gone" : "Reading Worker…"} />
        : (
          <>
            <Summary worker={worker} status={status} statusError={statusError} />
            <div role="tablist" aria-label="Worker views" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-3 py-1.5">
              {/* Worktree files are local operator reads; a remote session has no Files view. */}
              {tabs.filter(([value]) => value !== "files" || !remote).map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
                  className={cn("inline-flex h-7 shrink-0 items-center rounded-lg border px-2 text-[0.75rem] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    tab === value ? "border-foreground/15 bg-background text-foreground shadow-xs" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground")}>
                  {label}
                </button>
              ))}
            </div>
            {tab === "conversation" ? <ConversationTab key={`${worker.id}:${worker.contentClearedAt ?? "original"}`} worker={worker} generation={generation} />
              : tab === "changes" ? <ChangesTab key={worker.id} worker={worker} generation={generation} />
              : tab === "files" ? <WorkerFilesTab key={worker.id} worker={worker} generation={generation} />
              : tab === "turns" ? <TurnsTab key={worker.id} worker={worker} generation={generation} focusTurnId={focus && focus.workerId === workerId ? focus.turnId : null} />
              : tab === "tools" ? <ToolsTab key={worker.id} worker={worker} generation={generation} />
              : tab === "records" ? <RecordsTab key={`${worker.id}:${worker.contentClearedAt ?? "original"}`} worker={worker} generation={generation} />
              : tab === "settings" ? <WorkerSettingsTab key={worker.id} worker={worker} status={status} />
              : <SessionTab key={worker.id} worker={worker} generation={generation} />}
            <StatusLine worker={worker} status={status} />
          </>
        )}
    </Window>
  );
}

function WorkerSwitcher({ windowId, workerId }: { windowId: string; workerId: string | null }) {
  const { workerSessions } = useStack();
  const { workerWindows } = useWorkerWindows();
  const workers = [...(workerSessions.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Switch Worker" className="text-muted-foreground" />} />}>
          <ChevronsUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Switch Worker</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-80 min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show Worker</DropdownMenuLabel>
          {workers.length ? (
            <DropdownMenuRadioGroup value={workerId ?? ""} onValueChange={(value) => workerWindows.setWorker(windowId, value || null)}>
              {workers.map((worker) => (
                <DropdownMenuRadioItem key={worker.id} value={worker.id} closeOnClick className="font-mono">
                  <StatusDot tone={phaseTone[worker.phase]} />
                  {workerLabel(worker)}
                  <span className="ml-auto pl-3 text-[0.7rem] text-muted-foreground">{workerOrigin(worker.botId)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          ) : <p className="px-2 py-1.5 text-xs text-muted-foreground">No Workers</p>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Placeholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-8 py-10 text-center text-xs">
      <p className="font-medium text-foreground/80">{title}</p>
      {hint ? <p className="text-pretty text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Chip({ icon: Icon, children, title, copy, label, tone }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; title?: string; copy?: string | null; label?: string; tone?: "warning" }) {
  return (
    <span title={title} className={cn("group/row inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted/70 px-1.5 text-[0.7rem] text-muted-foreground", tone === "warning" && "bg-warning/10 text-warning")}>
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className={cn("min-w-0 truncate", tone ? undefined : "text-foreground/90")}>{children}</span>
      {copy ? <CopyButton value={copy} label={label ?? "value"} className="-my-1 size-5 w-0 transition-[width,opacity] group-hover/row:w-5 focus-visible:w-5" /> : null}
    </span>
  );
}

/** Identity, requested versus observed settings, worktree and what the Worker is waiting on. */
function Summary({ worker, status, statusError }: { worker: WorkerSession; status: WorkerStatus | null; statusError: string | null }) {
  const state = useStack();
  const { workerAccounts, bots, roleCatalog, remote } = state;
  const maintenance = localOperations(state, "worker", Object.values(workerStateOperations)).available;
  const now = useNow();
  const labels = workerAccountLabels(workerAccounts.data);
  const turn = status?.turn ?? null;
  const observed = turn?.observedSettings ?? null;
  const mismatch = settingsMismatch({ model: worker.model, effort: worker.effort }, observed);
  const attention = workerAttention(worker);
  const pending = (status?.pending ?? []).filter((request) => request.state === "pending");
  const bot = bots.data?.some((item) => item.id === worker.botId);
  const role = classifyWorkerRole(worker, roleCatalog.data);
  const active = turn && ["queued", "running", "awaiting_input", "cancelling"].includes(turn.phase);
  const started = turn ? turn.dispatchedAt ?? turn.createdAt : null;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[0.8rem]">
        <StatusDot tone={phaseTone[worker.phase]} pulse={worker.phase === "running"} />
        <span className="font-medium">{phaseTitle[worker.phase]}</span>
        {active && started ? <span className="text-[0.72rem] text-muted-foreground tabular-nums">turn {span(now - started)}</span> : null}
        {turn && !active ? <span className="truncate text-[0.72rem] text-muted-foreground">last turn {turn.phase}{turn.stopReason ? ` · ${turn.stopReason}` : ""}</span> : null}
        <span className="ml-auto flex items-center gap-1 text-[0.68rem] text-muted-foreground" title="Bots start and steer Workers; this window offers managed settings and explicit local state maintenance, never lifecycle or permission controls">
          <LockIcon className="size-3 shrink-0" />{remote ? "Read only" : maintenance ? "Observe · settings · maintenance" : "Observe · settings"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {worker.botId === localOperator ? <Chip icon={SparklesIcon} title="Started by the local operator">Operator</Chip>
          : bot ? <NodeLink node={{ kind: "bot", id: worker.botId }} label={worker.botId} className="inline-flex h-6 items-center rounded-md bg-muted/70 px-1.5 font-mono text-[0.7rem]">{worker.botId}</NodeLink>
          : <Chip icon={SparklesIcon} title="Its Bot no longer exists">{worker.botId}</Chip>}
        <NodeLink node={{ kind: "worker-account", id: worker.accountId }} label={labels.get(worker.accountId) ?? shortId(worker.accountId)}
          className="inline-flex h-6 items-center rounded-md bg-muted/70 px-1.5 text-[0.7rem]">{labels.get(worker.accountId) ?? shortId(worker.accountId)}</NodeLink>
        <Chip icon={SparklesIcon} title="Requested model · effort">{[worker.model, worker.effort].filter(Boolean).join(" · ")}</Chip>
        {mismatch ? <Chip icon={TriangleAlertIcon} tone="warning" title="The native session reported different settings">observed {[observed?.model, observed?.effort].filter(Boolean).join(" · ")}</Chip> : null}
        <Chip icon={FolderGitIcon} title={worker.cwd ?? worker.repo} copy={worker.cwd ?? worker.repo} label="worktree path">{worker.repo.split("/").filter(Boolean).at(-1) ?? worker.repo}</Chip>
        {worker.branch ? <Chip icon={GitBranchIcon} title={worker.branch} copy={worker.branch} label="branch">{worker.baseCommit ? `from ${worker.baseCommit.slice(0, 7)}` : worker.branch}</Chip> : null}
        {turn?.workContext ? (
          <span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted/70 px-1.5 text-[0.7rem]" aria-label="Latest turn's Work">
            <WorkContextLink context={turn.workContext} />
          </span>
        ) : null}
        {worker.sourceDirty ? <Chip icon={TriangleAlertIcon} tone="warning" title="The source checkout had uncommitted changes when this Worker started; its worktree does not include them">source was dirty</Chip> : null}
        {role ? (
          <Chip icon={ScrollTextIcon} tone={role.state === "older" ? "warning" : undefined} title={workerRoleHint(role, workerDefaultOf(roleCatalog.data))}>
            {workerRoleLabel(role)}{role.state === "older" ? ` · now r${role.currentRevision}` : ""}
          </Chip>
        ) : null}
      </div>
      {attention && !pending.length ? <Notice>{attention}</Notice> : null}
      {worker.issue && worker.issue !== attention ? <Notice>{worker.issue}</Notice> : null}
      {turn?.phase === "unknown" ? <Notice>{turn.issue ?? "The last turn’s outcome is unknown."} Its Bot inspects the worktree before resuming.</Notice> : null}
      {statusError ? <p className="text-[0.7rem] text-destructive">Status: {statusError}</p> : null}
      {pending.map((request) => <PendingRequest key={request.id} request={request} />)}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" /><span>{children}</span>
    </p>
  );
}

/** A permission the native runtime asked for. The originating Bot answers it; the options are shown, not offered. */
function PendingRequest({ request }: { request: WorkerPermission }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-2.5 py-2">
      <p className="flex items-start gap-1.5 text-[0.78rem] font-medium">
        <ShieldQuestionIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" /><span className="min-w-0 break-words">{request.title}</span>
      </p>
      <div className="flex flex-wrap gap-1">
        {request.options.map((option) => (
          <span key={option.optionId} title={option.kind} className="rounded-md border border-dashed px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">{option.name}</span>
        ))}
      </div>
      <p className="text-[0.68rem] text-muted-foreground">Waiting for its Bot to answer{request.toolCallId ? ` · tool ${shortId(request.toolCallId, 12)}` : ""}</p>
    </div>
  );
}

function StatusLine({ worker, status }: { worker: WorkerSession; status: WorkerStatus | null }) {
  const { status: channels } = useStack();
  const live = channels.worker === "open";
  return (
    <div role="status" aria-live="polite" className="flex h-8 shrink-0 items-center gap-2 border-t border-border/60 px-3.5 text-[0.68rem] text-muted-foreground">
      <StatusDot tone={live ? "success" : "muted"} />
      <span>{live ? "Live" : "Reconnecting…"}</span>
      <span className="ml-auto truncate font-mono">{shortId(worker.id, 13)}</span>
      <CopyButton value={worker.id} label="Worker ID" className="size-5" />
      {status ? <span className="shrink-0">updated <Time at={worker.updatedAt} /></span> : null}
    </div>
  );
}

/** A scroll body that stays at the end while new entries arrive, unless the reader scrolled up. */
function Scroller({ children, follow, className }: { children: React.ReactNode; follow?: unknown; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && atEnd.current && follow !== undefined) element.scrollTop = element.scrollHeight;
  }, [follow]);
  return (
    <div ref={ref} data-scroll onScroll={(event) => { const element = event.currentTarget; atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8; }}
      className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3.5 py-3", className)}>
      {children}
    </div>
  );
}

function FeedFooter({ loading, error, hasMore, more, count, noun }: { loading: boolean; error: string | null; hasMore: boolean; more?(): void; count: number; noun: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-1 text-[0.7rem] text-muted-foreground">
      {error ? <p className="text-destructive">{error}</p> : null}
      {loading ? <p className="flex items-center gap-1.5"><Spinner className="size-3" />Reading {noun}…</p>
        : hasMore && more ? <Button variant="ghost" size="sm" onClick={more}>Load more</Button>
        : !count ? <p>No {noun} yet</p> : null}
    </div>
  );
}

function ConversationTab({ worker, generation }: { worker: WorkerSession; generation: number }) {
  const store = useStore();
  const transcript = useSeqFeed<WorkerTranscriptEntry>(worker.id, generation, true,
    (afterSeq) => store.call<WorkerTranscriptPage>("worker", "worker_read", { id: worker.id, afterSeq, limit: 50 }));
  // Tool lines without a title carry only a tool call ID; the merged tool list names them.
  const tools = useSnapshot(`${worker.id}:names`, generation, () => readTools(store, worker.id, 2));
  const names = useMemo(() => new Map((tools.data?.tools ?? []).map((tool) => [tool.toolCallId, tool])), [tools.data]);
  const turns = useMemo(() => conversation(transcript.entries, names), [transcript.entries, names]);
  return (
     <Scroller follow={transcript.entries.length}>
       {worker.contentClearedAt != null ? <ContentCleared at={worker.contentClearedAt} /> : null}
      {turns.map((turn, index) => (
        <section key={turn.turnId} aria-label={`Turn ${index + 1}`} className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[0.64rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            <span>Turn {index + 1}</span><span className="h-px flex-1 bg-border" /><span className="font-mono normal-case tracking-normal">{shortId(turn.turnId)}</span>
          </div>
          {turn.items.map((item) => <ConversationRow key={item.key} item={item} streaming={worker.currentTurnId === turn.turnId && item === turn.items.at(-1) && item.kind === "agent"} />)}
        </section>
      ))}
      <FeedFooter loading={transcript.loading && !transcript.entries.length} error={transcript.error} hasMore={false} count={transcript.entries.length} noun="transcript" />
    </Scroller>
  );
}

const planIcon = (status: string | null) => status === "completed" ? CircleCheckIcon : status === "in_progress" ? CircleDotIcon : CircleDashedIcon;

function ConversationRow({ item, streaming }: { item: ConversationItem; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-6 rounded-xl bg-muted/70 px-3 py-2 text-[0.8rem]">
          <p className="mb-0.5 text-[0.62rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Task</p>
          <p className="break-words whitespace-pre-wrap">{item.text}</p>
        </div>
      );
    case "event":
      return (
        <div className="ml-6 rounded-xl border border-dashed bg-muted/40 px-3 py-2 text-[0.8rem]">
          <p className="mb-0.5 text-[0.62rem] font-medium tracking-[0.08em] text-muted-foreground uppercase" title="An event a subscription delivered to this Worker — an untrusted observation, not a human task">Event</p>
          <p className="break-words whitespace-pre-wrap">{item.text}</p>
        </div>
      );
    case "agent":
      return <div className="text-[0.8rem]"><Markdown text={item.text} streaming={streaming} /></div>;
    case "tool":
      return (
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-[0.72rem] text-muted-foreground">
          <WrenchIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate" title={item.title}>{item.title}</span>
          {item.status ? <span className={cn("shrink-0", item.status === "failed" ? "text-destructive" : item.status === "completed" ? "text-success" : "text-foreground/70")}>{item.status.replace("_", " ")}</span> : null}
        </p>
      );
    case "plan":
      return item.entries ? (
        <ul aria-label="Plan" className="flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-[0.75rem]">
          {item.entries.map((entry: PlanEntry, index) => {
            const Icon = planIcon(entry.status);
            return (
              <li key={index} className={cn("flex items-start gap-1.5", entry.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                <Icon aria-label={entry.status ?? "pending"} className={cn("mt-0.5 size-3 shrink-0", entry.status === "in_progress" && "text-pkg-worker")} />
                <span className="min-w-0 break-words">{entry.content}</span>
              </li>
            );
          })}
        </ul>
      ) : <pre className="max-h-40 overflow-auto rounded-lg border px-2.5 py-2 text-[0.68rem] whitespace-pre-wrap">{item.text}</pre>;
    case "turn":
      return <p className="text-center text-[0.68rem] text-muted-foreground">{item.text}</p>;
    default:
      return <p className="text-[0.7rem] text-pretty text-warning">{item.text}</p>;
  }
}

const fileStatus: Record<WorkerDiffFile["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-success" }, untracked: { letter: "N", className: "text-success" }, modified: { letter: "M", className: "text-pkg-worker" },
  deleted: { letter: "D", className: "text-destructive" }, renamed: { letter: "R", className: "text-pkg-worker" }, copied: { letter: "C", className: "text-pkg-worker" },
  typechange: { letter: "T", className: "text-warning" }, unmerged: { letter: "U", className: "text-warning" }, unknown: { letter: "?", className: "text-muted-foreground" },
};

/** Changes against the base, with an explicit closed-Worker reset through the owner plan/receipt flow. */
function ChangesTab({ worker, generation }: { worker: WorkerSession; generation: number }) {
  const store = useStore();
  const [shown, setShown] = useState<{ path: string | null } | null>(null);
  const summary = useSnapshot(`${worker.id}:diff`, generation, () => store.call<WorkerDiff>("worker", "worker_diff", { id: worker.id }));
  const patch = useSnapshot(shown ? `${worker.id}:patch:${shown.path ?? ""}` : null, generation, () =>
    store.call<WorkerDiff>("worker", "worker_diff", shown?.path ? { id: worker.id, path: shown.path } : { id: worker.id, patch: true }));
  const data = summary.data;
  // A file the Worker no longer changes drops its open patch.
  const stale = shown?.path && data && !data.files.some((file) => file.path === shown.path);
  useEffect(() => { if (stale) setShown(null); }, [stale]);
  const additions = data?.files.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0;
  const deletions = data?.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0;
  return (
    <Scroller>
      {!data ? <FeedFooter loading={!summary.error} error={summary.error} hasMore={false} count={0} noun="changes" /> : (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem]">
            <span className="font-medium">{data.files.length}{data.filesTruncated ? "+" : ""} file{data.files.length === 1 ? "" : "s"}</span>
            <span className="text-success tabular-nums">+{additions}</span>
            <span className="text-destructive tabular-nums">−{deletions}</span>
            <span className="text-muted-foreground">· {data.commits.length}{data.commitsTruncated ? "+" : ""} commit{data.commits.length === 1 ? "" : "s"}</span>
            {data.uncommitted ? <span className="rounded bg-warning/10 px-1.5 py-px text-[0.68rem] text-warning" title="The worktree has uncommitted or untracked changes">uncommitted</span> : null}
            <span className="ml-auto flex items-center gap-1 font-mono text-[0.68rem] text-muted-foreground" title={`${data.baseCommit} → ${data.head}`}>
              {data.baseCommit.slice(0, 7)} → {data.head.slice(0, 7)}<CopyButton value={data.head} label="head commit" className="size-5" />
            </span>
          </div>
          {summary.error ? <p className="text-[0.7rem] text-destructive">{summary.error}</p> : null}
          {data.commits.length ? (
            <ul aria-label="Commits" className="flex flex-col gap-0.5">
              {data.commits.map((commit) => (
                <li key={commit.sha} className="flex min-w-0 items-baseline gap-2 text-[0.75rem]">
                  <span className="shrink-0 font-mono text-[0.68rem] text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                  <Time at={commit.at} className="shrink-0 text-[0.65rem] text-muted-foreground" />
                </li>
              ))}
            </ul>
          ) : null}
          {data.files.length ? (
            <ul aria-label="Changed files" className="flex flex-col gap-px rounded-lg border p-1">
              {data.files.map((file) => {
                const status = fileStatus[file.status];
                const open = shown?.path === file.path;
                return (
                  <li key={file.path}>
                    <button type="button" aria-pressed={open} onClick={() => setShown(open ? null : { path: file.path })}
                      className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left font-mono text-[0.72rem] hover:bg-muted/60", open && "bg-muted")}>
                      <span title={file.status} className={cn("w-3 shrink-0 text-center font-semibold", status.className)}>{status.letter}</span>
                      <span className="min-w-0 flex-1 truncate" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                        {file.oldPath ? <span className="text-muted-foreground">{file.oldPath} → </span> : null}{file.path}
                      </span>
                      {file.binary ? <span className="shrink-0 text-muted-foreground">binary</span> : file.additions !== null ? (
                        <span className="shrink-0 tabular-nums"><span className="text-success">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span></span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="py-2 text-center text-[0.72rem] text-muted-foreground">No changes against the base commit</p>}
          {data.files.length ? (
            <Button size="sm" variant={shown && !shown.path ? "secondary" : "ghost"} className="self-start" onClick={() => setShown(shown && !shown.path ? null : { path: null })}>
              {shown && !shown.path ? "Hide all changes" : "Show all changes"}
            </Button>
          ) : null}
          {shown ? (
            patch.data ? <Patch diff={patch.data} /> : <FeedFooter loading={!patch.error} error={patch.error} hasMore={false} count={0} noun="patch" />
          ) : null}
        </>
       )}
       <WorkerMaintenance worker={worker} kind="git_reset" />
     </Scroller>
  );
}

function Patch({ diff }: { diff: WorkerDiff }) {
  const lines = useMemo(() => (diff.patch ?? "").split("\n"), [diff.patch]);
  return (
    <div className="flex flex-col gap-1">
      {diff.truncated ? <Notice>This patch was cut at its size limit. Read the rest in Git from the worktree.</Notice> : null}
      <pre aria-label={diff.path ? `Patch for ${diff.path}` : "All changes"} className="overflow-x-auto rounded-lg border bg-background/60 py-1.5 font-mono text-[0.68rem] leading-[1.45]">
        {lines.map((line, index) => (
          <span key={index} className={cn("block px-2.5 whitespace-pre",
            line.startsWith("+") && !line.startsWith("+++") ? "bg-success/10 text-success"
              : line.startsWith("-") && !line.startsWith("---") ? "bg-destructive/10 text-destructive"
              : line.startsWith("@@") ? "text-pkg-worker"
              : /^(diff --git|index |--- |\+\+\+ |new file|deleted file|rename |similarity )/.test(line) ? "text-muted-foreground" : "text-foreground/85")}>
            {line || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * Durable event delivery receipts for this Worker (`worker_event_list`, local operator only). Receipts
 * carry no payload — the delivered input shows in the transcript. A truncated page may hide an older
 * receipt, so an unlinked turn can still be an event turn; unknown is not a proven failure.
 */
function EventReceipts({ page, error, onFocus }: { page: WorkerEventPage | null; error: string | null; onFocus(turnId: string): void }) {
  const receipts = page?.receipts ?? [];
  return (
    <section aria-label="Event receipts" className="flex flex-col gap-1.5">
      <h3 className="text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Event receipts</h3>
      {error ? <p className="text-[0.72rem] text-pretty text-destructive">Event receipts unavailable: {error}</p>
        : !page ? <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3" />Reading event receipts…</p>
        : !receipts.length ? <p className="text-[0.72rem] text-muted-foreground">No event deliveries recorded.</p>
        : (
          <>
            <p className="text-[0.68rem] text-pretty text-muted-foreground">
              {page.total} receipt{page.total === 1 ? "" : "s"}. Receipts carry no payload — the delivered input shows in the Conversation and Records tabs.
              {page.truncated ? ` Only the latest ${page.limit} of ${page.total} are inspectable — an unlinked older turn may still be an event turn.` : ""}
            </p>
            <ul className="flex flex-col gap-1.5">
              {receipts.map((receipt) => {
                const view = workerEventReceiptLabels[receipt.state];
                return (
                  <li key={receipt.deliveryId} data-event-receipt={receipt.deliveryId} className="flex flex-col gap-0.5 rounded-lg border border-dashed px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 font-medium" title={view.description}>{view.label}</span>
                      <span className="group/row inline-flex min-w-0 items-center gap-0.5 font-mono text-[0.68rem] text-muted-foreground" title={`Delivery ${receipt.deliveryId}`}>
                        {shortId(receipt.deliveryId, 12)}<CopyButton value={receipt.deliveryId} label="delivery ID" className="size-5" />
                      </span>
                      <Time at={receipt.updatedAt} className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground" />
                    </div>
                    <p className="pl-3.5 text-[0.68rem] text-muted-foreground">{view.description}</p>
                    <p className="flex items-center gap-2 pl-3.5 text-[0.68rem] text-muted-foreground">
                      <span className="flex items-center gap-1">created <Time at={receipt.createdAt} /></span>
                      {receipt.turnId ? (
                        <button type="button" title="Show this exact turn below" onClick={() => onFocus(receipt.turnId!)}
                          className="rounded-sm font-mono hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                          turn {shortId(receipt.turnId)}
                        </button>
                      ) : null}
                    </p>
                    {receipt.issue ? <p className="pl-3.5 text-[0.68rem] text-pretty text-warning">{receipt.issue}</p> : null}
                  </li>
                );
              })}
            </ul>
            {receipts.some((receipt) => receipt.state === "unknown") ? <p role="note" className="text-[0.7rem] text-pretty text-warning">{workerEventFence}</p> : null}
          </>
        )}
    </section>
  );
}

/**
 * The exact-request observation for this turn's first watch receipt, read on the latest signature.
 * The result is this exact request's outcome — never a latest-turn claim. Active turns show bounded
 * pending permission metadata only; nothing here answers a permission.
 */
function TurnObservation({ receipts, signature }: { receipts: ServeCompletionReceipt[]; signature: string }) {
  const state = useStack();
  const store = useStore();
  const receipt = receipts[0];
  const access = localOperation(state, "worker", "worker_turn_observation");
  const usable = access.available && Boolean(receipt?.botId && receipt?.threadId && receipt?.recordId);
  const read = useObservedRead<WorkerTurnObservation>(usable ? `turn-observation:${receipt!.recordId}` : null, signature,
    () => store.call<WorkerTurnObservation>("worker", "worker_turn_observation", { botId: receipt!.botId, threadId: receipt!.threadId, requestId: receipt!.recordId }));
  const observation = read.data;
  if (!access.available) return <p className="text-[0.72rem] text-pretty text-muted-foreground">{access.reason}</p>;
  if (read.error) return <p className="text-[0.72rem] text-pretty text-destructive">Observation unavailable: {read.error}</p>;
  if (read.loading || !observation) return <p className="text-[0.72rem] text-muted-foreground">Reading observation…</p>;
  if (observation.result) {
    const result = observation.result;
    return (
      <div className="flex flex-col gap-1 rounded-lg bg-muted/40 px-2 py-1.5">
        <span className="text-[0.66rem] font-medium tracking-[0.06em] text-muted-foreground uppercase">Completion</span>
        <dl className="flex flex-col">
          <Row label="Outcome">{workerObservationPhaseLabels[result.phase].label}{result.stopReason ? ` · ${result.stopReason}` : ""}</Row>
          {result.issue ? <Row label="Issue" className="text-warning"><span className="whitespace-normal break-words">{result.issue}</span></Row> : null}
          {result.workContext ? <Row label="Work"><WorkContextLink context={result.workContext} className="max-w-full justify-end" /></Row> : null}
        </dl>
        {result.contentClearedAt ? <ContentCleared at={result.contentClearedAt} label="Turn content cleared" className="text-[0.68rem]" /> : null}
        <p className="text-[0.68rem] text-pretty text-muted-foreground">Full evidence for this turn: Conversation and Records tabs. Observation covers the request's outcome only, not broader Work.</p>
      </div>
    );
  }
  if (observation.update) {
    const update = observation.update;
    const shown = update.pending.slice(0, 8);
    return (
      <div className="flex flex-col gap-1 rounded-lg bg-muted/40 px-2 py-1.5">
        <span className="text-[0.66rem] font-medium tracking-[0.06em] text-muted-foreground uppercase">Attention</span>
        <dl className="flex flex-col">
          <Row label="Phase">{workerObservationPhaseLabels[update.phase].label}</Row>
          <Row label="Pending permissions">{update.pendingCount ? `${update.pendingCount} pending permission${update.pendingCount === 1 ? "" : "s"}` : "none"}</Row>
        </dl>
        {shown.length ? (
          <ul className="flex flex-col gap-0.5 pl-1 text-[0.68rem] text-muted-foreground">
            {shown.map((permission) => (
              <li key={permission.permissionId} className="font-mono">permission {shortId(permission.permissionId, 12)} · {permission.optionCount} option{permission.optionCount === 1 ? "" : "s"}</li>
            ))}
          </ul>
        ) : null}
        {update.pendingTruncated ? <p className="text-[0.68rem] text-pretty text-muted-foreground">More pending permissions than the inspectable bound.</p> : null}
      </div>
    );
  }
  return <p className="text-[0.72rem] text-muted-foreground">Not admitted yet.</p>;
}

function TurnsTab({ worker, generation, focusTurnId }: { worker: WorkerSession; generation: number; focusTurnId?: string | null }) {
  const store = useStore();
  const state = useStack();
  const turns = useSnapshot(worker.id, generation, () => readTurns(store, worker.id));
  const list = turns.data ?? [];
  const eventsAccess = state.remote ? { available: false, reason: null } : localOperation(state, "worker", "worker_event_list");
  const events = useSnapshot(eventsAccess.available ? `${worker.id}:events` : null, generation,
    () => store.call<WorkerEventPage>("worker", "worker_event_list", { id: worker.id }));
  const receipts = events.data?.receipts ?? [];
  const eventsById = useMemo(() => eventTurns(receipts), [receipts]);
  const [eventFocus, setEventFocus] = useState<string | null>(null);
  const [watchOpen, setWatchOpen] = useState<string | null>(null);
  const pending = state.workerStatuses[worker.id]?.data?.pending ?? [];
  const linked = focusTurnId && list.some((turn) => turn.id === focusTurnId) ? focusTurnId : null;
  const local = eventFocus && list.some((turn) => turn.id === eventFocus) ? eventFocus : null;
  const focused = linked ?? local;
  const scrolled = useRef<string | null>(null);
  // Set scrollTop on the tab's own scroll container only; scrollIntoView could move bench ancestors.
  const focusRef = useCallback((element: HTMLElement | null) => {
    if (!element || !focused || scrolled.current === `${worker.id}:${focused}`) return;
    scrolled.current = `${worker.id}:${focused}`;
    const container = element.closest<HTMLElement>("[data-scroll]");
    if (container) container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  }, [worker.id, focused]);
  return (
    <Scroller>
      {focusTurnId && turns.data && !linked ? <p role="status" className="text-xs text-warning">The linked turn {shortId(focusTurnId)} is not in this Worker&rsquo;s turn list.</p> : null}
      {eventsAccess.available ? <EventReceipts page={events.data} error={events.error} onFocus={setEventFocus} /> : null}
      {list.map((turn, index) => {
        const mismatch = settingsMismatch({ model: turn.requestedModel, effort: turn.requestedEffort }, turn.observedSettings);
        const event = eventsById.turnIds.has(turn.id) || eventsById.deliveryIds.has(turn.requestId);
        const delivery = event ? eventReceiptFor(turn, receipts) : null;
        // The observation re-reads when the turn's outcome or its pending permission set moves.
        const signature = `${turn.phase}:${turn.updatedAt}:${pending.filter((request) => request.turnId === turn.id).map((request) => request.id).sort().join(",")}`;
        return (
          <article key={turn.id} ref={focused === turn.id ? focusRef : undefined} data-turn-id={turn.id} aria-current={focused === turn.id ? "true" : undefined}
            className={cn("flex flex-col gap-1.5 rounded-xl border px-2.5 py-2", focused === turn.id && "ring-2 ring-foreground/30")}>
            <div className="flex items-center gap-2 text-[0.78rem]">
              <span className="font-medium">Turn {index + 1}</span>
              {event ? <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[0.64rem] font-medium text-muted-foreground">Event turn</span> : null}
              {focused === turn.id ? <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[0.64rem] font-medium text-muted-foreground">Linked turn · {shortId(turn.id)}</span> : null}
              <span className={cn("text-[0.7rem]", turn.phase === "failed" ? "text-destructive" : turn.phase === "unknown" ? "text-warning" : turn.phase === "completed" ? "text-success" : "text-muted-foreground")}>
                {turn.phase}{turn.stopReason ? ` · ${turn.stopReason}` : ""}
              </span>
              <Time at={turn.createdAt} className="ml-auto text-[0.65rem] text-muted-foreground" />
            </div>
            {event ? <p className="text-[0.68rem] text-muted-foreground italic">Event input · untrusted observation, not a human task</p> : null}
            {turn.prompt !== null ? <p className="line-clamp-4 text-[0.75rem] break-words whitespace-pre-wrap text-foreground/90">{turn.prompt}</p>
              : <p className="text-[0.72rem] text-muted-foreground italic">{turn.contentClearedAt != null ? "Prompt cleared" : "Prompt not recorded"}</p>}
            <dl className="flex flex-col">
              <Row label="Requested" mono>{[turn.requestedModel, turn.requestedEffort].filter(Boolean).join(" · ") || "—"}</Row>
              <Row label="Observed" mono className={mismatch ? "text-warning" : undefined}>{turn.observedSettings ? [turn.observedSettings.model, turn.observedSettings.effort, turn.observedSettings.mode].filter(Boolean).join(" · ") || "—" : "not reported"}</Row>
              <Row label="Dispatched">{turn.dispatchedAt ? <><Time at={turn.dispatchedAt} />{turn.dispatchedPromptSeq !== null ? ` · record ${turn.dispatchedPromptSeq}` : ""}</> : "not dispatched"}</Row>
              <Row label="Duration">{span(turn.updatedAt - (turn.dispatchedAt ?? turn.createdAt))}</Row>
              <Row label="Request" mono copy={turn.requestId}>{shortId(turn.requestId, 13)}</Row>
              <Row label="Work" hint="The HUD Work item this turn was admitted for, captured with its scope revision.">{turn.workContext ? <WorkContextLink context={turn.workContext} className="max-w-full justify-end" /> : "not associated"}</Row>
            </dl>
            {turn.issue ? <p className="text-[0.72rem] text-pretty text-warning">{turn.issue}</p> : null}
            {event ? (
              <p className="text-[0.68rem] text-muted-foreground" title={delivery ? workerEventReceiptLabels[delivery.state].description : "No retained delivery receipt links to this turn"}>
                {delivery ? `Delivery ${workerEventReceiptLabels[delivery.state].label} — ${workerEventReceiptLabels[delivery.state].description}` : "Delivered event input; its delivery receipt isn't in the inspectable page"}
              </p>
            ) : state.remote ? null : (
              <div>
                <Button type="button" variant="ghost" size="xs" aria-expanded={watchOpen === turn.id} onClick={() => setWatchOpen(watchOpen === turn.id ? null : turn.id)}>
                  Bot watch
                </Button>
                {watchOpen === turn.id ? (
                  <div className="mt-1.5">
                    <BotWatch pkg="worker" recordId={turn.requestId} origin={{ botId: worker.botId }} observe={signature}>
                      {(list) => <TurnObservation receipts={list} signature={signature} />}
                    </BotWatch>
                  </div>
                ) : null}
              </div>
            )}
          </article>
        );
      })}
      <FeedFooter loading={!turns.data && !turns.error} error={turns.error} hasMore={false} count={list.length} noun="turns" />
    </Scroller>
  );
}

function ToolsTab({ worker, generation }: { worker: WorkerSession; generation: number }) {
  const store = useStore();
  const [pages, setPages] = useState(1);
  const result = useSnapshot(`${worker.id}:${pages}`, generation, () => readTools(store, worker.id, pages));
  const [open, setOpen] = useState<string | null>(null);
  const tools = result.data?.tools ?? [];
  const tasks = result.data?.tasks ?? [];
  return (
    <Scroller>
      {tasks.length ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Task references</h3>
          <p className="px-0.5 text-[0.68rem] text-pretty text-muted-foreground">Projected from tool input and output. The parent link is unverified and the child’s status is unknown.</p>
          {tasks.map((task) => (
            <div key={`${task.toolCallId}:${task.sessionId}`} className="flex flex-col gap-0.5 rounded-lg border border-dashed px-2.5 py-1.5 font-mono text-[0.68rem] text-muted-foreground">
              <span className="text-foreground/90">session {shortId(task.sessionId, 12)}{task.background ? " · background" : ""}</span>
              <span>from {shortId(task.callingSessionId, 12)} · tool {shortId(task.toolCallId, 12)}{task.toolStatus ? ` · ${task.toolStatus}` : ""}</span>
              {task.model ? <span>{[task.model.providerID, task.model.modelID].filter(Boolean).join("/")}</span> : null}
            </div>
          ))}
        </section>
      ) : null}
      <ul className="flex flex-col gap-1">
        {tools.map((tool) => (
          <li key={tool.toolCallId} className="rounded-lg border">
            <button type="button" aria-expanded={open === tool.toolCallId} onClick={() => setOpen(open === tool.toolCallId ? null : tool.toolCallId)}
              className="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-muted/60">
              <WrenchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{tool.title ?? tool.toolCallId}</span>
              {tool.kind ? <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">{tool.kind}</span> : null}
              <span className={cn("shrink-0 text-[0.68rem]", tool.status === "failed" ? "text-destructive" : tool.status === "completed" ? "text-success" : "text-muted-foreground")}>{tool.status?.replace("_", " ") ?? "—"}</span>
            </button>
            {open === tool.toolCallId ? (
              <div className="flex flex-col gap-2 border-t px-2.5 py-2">
                <p className="font-mono text-[0.65rem] text-muted-foreground">{tool.toolCallId} · records {tool.firstSeq}–{tool.lastSeq}</p>
                <RecordData worker={worker} record={tool.record} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <FeedFooter loading={!result.data && !result.error} error={result.error} hasMore={Boolean(result.data?.hasMore)} more={() => setPages((value) => value + 1)} count={tools.length} noun="tools" />
    </Scroller>
  );
}

function RecordsTab({ worker, generation }: { worker: WorkerSession; generation: number }) {
  const store = useStore();
  const [turnId, setTurnId] = useState("");
  const [kind, setKind] = useState("");
  const turns = useSnapshot(`${worker.id}:turns`, generation, () => readTurns(store, worker.id));
  const [capture, setCapture] = useState<WorkerRecordPage["capture"] | null>(null);
  const feed = useSeqFeed<WorkerRecord>(`${worker.id}:${turnId}`, generation, false, async (afterSeq) => {
    const page = await store.call<WorkerRecordPage>("worker", "worker_record_list", { id: worker.id, afterSeq, limit: 50, ...(turnId ? { turnId } : {}) });
    setCapture(page.capture);
    return page;
  });
  const kinds = [...new Set(feed.entries.map((entry) => entry.kind))].sort();
  const shown = kind ? feed.entries.filter((entry) => entry.kind === kind) : feed.entries;
  return (
     <Scroller>
       {worker.contentClearedAt != null ? <ContentCleared at={worker.contentClearedAt} /> : null}
       <div className="flex flex-wrap items-center gap-2">
        <NativeSelect size="sm" aria-label="Turn" className="min-w-0 flex-1" value={turnId} onChange={(event) => setTurnId(event.target.value)}>
          <NativeSelectOption value="">All turns</NativeSelectOption>
          {(turns.data ?? []).map((turn, index) => <NativeSelectOption key={turn.id} value={turn.id}>Turn {index + 1} · {turn.phase}</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Kind" className="min-w-0 flex-1" value={kind} onChange={(event) => setKind(event.target.value)}>
          <NativeSelectOption value="">All kinds</NativeSelectOption>
          {kinds.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {capture && (capture.truncated || capture.droppedRecords) ? (
        <Notice>Capture limit reached: {capture.droppedRecords} record{capture.droppedRecords === 1 ? "" : "s"} dropped. Retained {capture.records} of {capture.maxRecords} records.</Notice>
      ) : null}
      <ul className="flex flex-col gap-1">
        {shown.map((record) => <RecordRow key={record.seq} worker={worker} record={record} />)}
      </ul>
      <FeedFooter loading={feed.loading} error={feed.error} hasMore={feed.hasMore} more={feed.more} count={shown.length} noun="records" />
    </Scroller>
  );
}

function RecordRow({ worker, record }: { worker: WorkerSession; record: WorkerRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[0.7rem] hover:bg-muted/60">
        <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">{record.seq}</span>
        <span className="min-w-0 flex-1 truncate">{record.kind}</span>
        {record.source !== "live" ? <span className="shrink-0 text-muted-foreground">{record.source}</span> : null}
        {record.oversized ? <span className="shrink-0 text-warning">oversized</span> : null}
        <Time at={record.at} className="shrink-0 text-[0.62rem] text-muted-foreground" />
      </button>
      {open ? <div className="border-t px-2.5 py-2"><RecordData worker={worker} record={record} /></div> : null}
    </li>
  );
}

/** A record's safe data; an oversized one is recovered in chunks through worker_record_read. */
function RecordData({ worker, record }: { worker: WorkerSession; record: WorkerRecord }) {
  const store = useStore();
  const [full, setFull] = useState<{ value: unknown; loading: boolean; error: string | null } | null>(null);
  const load = async () => {
    setFull({ value: null, loading: true, error: null });
    try {
      let text = "";
      let offset = 0;
      for (;;) {
        const chunk = await store.call<WorkerRecordChunk>("worker", "worker_record_read", { id: worker.id, seq: record.seq, offset });
        text += chunk.data;
        if (!chunk.hasMore) break;
        offset = chunk.nextOffset;
      }
      setFull({ value: JSON.parse(text), loading: false, error: null });
    } catch (error) {
      setFull({ value: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <div className="flex flex-col gap-2 text-[0.75rem]">
      {record.oversized && !full?.value ? (
        <div className="flex items-center gap-2">
          <span className="text-[0.7rem] text-muted-foreground">{record.dataChars.toLocaleString()} characters</span>
          <Button size="xs" variant="outline" disabled={full?.loading} onClick={() => void load()}>{full?.loading ? <Spinner data-icon="inline-start" /> : null}Load full record</Button>
          {full?.error ? <span className="text-[0.7rem] text-destructive">{full.error}</span> : null}
        </div>
      ) : null}
      <RecordTree value={full?.value ?? record.data} />
    </div>
  );
}

const workerDefaultOf = (catalog: RoleCatalog | null) => catalog?.roles.find((item) => item.id === catalog.workerDefaultRoleId) ?? null;

const roleState: Record<WorkerRole["state"], string> = {
  current: "current revision", older: "older revision", deleted: "Role deleted since", unknown: "legacy record without a Role ID", unavailable: "Roles catalog unavailable",
};

/** The Role snapshot this Worker captured at creation, compared only with that same Role. Nothing here changes it. */
function RoleSection({ worker }: { worker: WorkerSession }) {
  const { roleCatalog } = useStack();
  const role = classifyWorkerRole(worker, roleCatalog.data);
  const workerDefault = workerDefaultOf(roleCatalog.data);
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Role</h3>
      {role ? (
        <>
          <dl className="flex flex-col">
            <Row label="Captured">{workerRoleLabel(role)}</Row>
            <Row label="Now" className={role.state === "older" ? "text-warning" : undefined}>
              {role.state === "current" || role.state === "older" ? `r${role.currentRevision} · ${roleState[role.state]}` : roleState[role.state]}
            </Row>
            {role.roleId ? <Row label="Role ID" mono copy={role.roleId}>{shortId(role.roleId, 13)}</Row> : null}
            {workerDefault ? <Row label="Worker default">{workerDefault.name}{role.workerDefault ? " · this Role" : ""}</Row> : null}
          </dl>
          <p className="px-0.5 text-[0.72rem] text-pretty text-muted-foreground">
            {workerRoleHint(role, null)} Recovery reuses this snapshot, and follow-up turns cannot change it. The Worker default only decides what a new Worker gets when it selects no Role.
          </p>
        </>
      ) : <p className="px-0.5 text-[0.72rem] text-pretty text-muted-foreground">No Role captured yet.</p>}
    </section>
  );
}

function SessionTab({ worker, generation }: { worker: WorkerSession; generation: number }) {
  const store = useStore();
  const detail = useSnapshot(worker.id, generation, () => store.call<WorkerDetail>("worker", "worker_detail", { id: worker.id }));
  const data = detail.data;
  return (
    <Scroller>
      {!data ? <FeedFooter loading={!detail.error} error={detail.error} hasMore={false} count={0} noun="session" /> : (
        <>
          <dl className="flex flex-col">
            <Row label="Session" mono copy={worker.sessionId}>{worker.sessionId ? shortId(worker.sessionId, 13) : "—"}</Row>
            <Row label="Runtime instance" mono copy={worker.runtimeInstance}>{worker.runtimeInstance ? shortId(worker.runtimeInstance, 13) : "—"}</Row>
            <Row label="Connected">{data.freshness.connected ? "yes" : "no"}{data.freshness.stale ? " · stale" : ""}</Row>
            {data.freshness.reason ? <Row label="Freshness">{data.freshness.reason}</Row> : null}
            <Row label="Observed" mono>{data.observedSettings ? [data.observedSettings.model, data.observedSettings.effort, data.observedSettings.mode].filter(Boolean).join(" · ") || "—" : "not reported"}</Row>
            <Row label="Worktree" mono copy={worker.cwd}>{worker.cwd ?? "—"}</Row>
            <Row label="Branch" mono copy={worker.branch}>{worker.branch ?? "—"}</Row>
            <Row label="Base commit" mono copy={worker.baseCommit}>{worker.baseCommit?.slice(0, 12) ?? "—"}</Row>
            <Row label="Source repo" mono copy={worker.repo}>{worker.repo}</Row>
            <Row label="Started"><Time at={worker.createdAt} /></Row>
          </dl>
          <RoleSection worker={worker} />
          <section className="flex flex-col gap-1">
            <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Capture</h3>
            <dl className="flex flex-col">
              <Row label="Records">{data.capture.records.toLocaleString()} of {data.capture.maxRecords.toLocaleString()}</Row>
              <Row label="Characters">{data.capture.retainedChars.toLocaleString()} of {data.capture.maxChars.toLocaleString()}</Row>
              <Row label="Dropped" className={data.capture.droppedRecords ? "text-warning" : undefined}>{data.capture.droppedRecords.toLocaleString()}{data.capture.truncated ? " · truncated" : ""}</Row>
              <Row label="Last observed"><Time at={data.capture.lastObservedAt} /></Row>
            </dl>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Subagents</h3>
            <p className="px-0.5 text-[0.72rem] text-pretty text-muted-foreground">Coverage {data.subagents.coverage}. {data.subagents.reason}</p>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="px-0.5 text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Session metadata · {data.metadata.length}</h3>
            <ul className="flex flex-col gap-1">
              {data.metadata.map((record) => <RecordRow key={record.seq} worker={worker} record={record} />)}
            </ul>
          </section>
          <WorkerSessionMaintenance worker={worker} />
        </>
      )}
    </Scroller>
  );
}
