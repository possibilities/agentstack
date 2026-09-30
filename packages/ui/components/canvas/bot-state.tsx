"use client";

import { useState } from "react";
import { BookOpenIcon, CableIcon, CalendarClockIcon, EyeIcon, EyeOffIcon, GlobeIcon, HammerIcon, HardDriveIcon, ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { botBlockers, purgeable, queueWords, workspaceOwned, type BotHistoryGeneration, type BotLaunch, type BotQueueEntry, type BotStateRead } from "@/lib/stack/bot-state";
import { relativeTime, shortId } from "@/lib/stack/derive";
import { formatBytes } from "@/lib/stack/resources";
import { localOperation } from "@/lib/stack/state";
import type { Bot, StateReceipt } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { BotLifecycleControls } from "./bot-actions";
import { BotAction, hintClass, labelClass, MoreButton, Pill, ReadError, useBotAction, useBotPages, useBotRead, ViewHeader, type BotScope } from "./bot-state-shared";
import { LogView, RecoveryView, UploadsView, WorkspaceView } from "./bot-state-files";
import { StateFlowView, StateReceiptView } from "./state-flow";
import { StateEntryDetails } from "./state-windows";
import { Empty, NodeLink } from "./primitives";
import { useNow, useProcWindows, useStack, useStore, useWorkbench, useWorkerWindows } from "./provider";
import { Window } from "./window";

type View = "overview" | "workspace" | "conversation" | "queue" | "uploads" | "launch" | "log" | "recovery";
const views: { id: View; title: string }[] = [
  { id: "overview", title: "Overview" }, { id: "workspace", title: "Workspace" }, { id: "conversation", title: "Conversation" }, { id: "queue", title: "Queue" },
  { id: "uploads", title: "Uploads" }, { id: "launch", title: "Launch" }, { id: "log", title: "Log" }, { id: "recovery", title: "Recovery" },
];

/** A Bot card's link to its state view. Local only. */
export function BotStateLink({ botId }: { botId: string }) {
  const { remote } = useStack();
  const store = useStore();
  const { goTo } = useWorkbench();
  if (remote) return null;
  return (
    <button type="button" title={`Inspect ${botId}'s workspace, conversation history and stored state`} onClick={() => { store.selectBotState(botId); goTo({ kind: "bot-state", id: botId }); }}
      className="inline-flex h-6 items-center gap-1 rounded-md bg-muted/70 px-1.5 text-[0.7rem] text-muted-foreground decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
      <HardDriveIcon aria-hidden className="size-3 shrink-0" />State
    </button>
  );
}

/**
 * Fleet's state view of one Bot: workspace, conversation generations, queue receipts, uploads, launch arguments,
 * log and credential recovery, each with its own exact maintenance plan. Nothing here starts or stops the Bot.
 * Everything below the picker belongs to one Bot incarnation and is discarded when it changes.
 */
export function BotStateWindow() {
  const state = useStack();
  const store = useStore();
  const { bots, botStateId, botStateGenerations, remote, status, endpoints } = state;
  const [view, setView] = useState<View>("overview");
  const botId = botStateId && bots.data?.some((bot) => bot.id === botStateId) ? botStateId : null;
  const bot = bots.data?.find((item) => item.id === botId) ?? null;
  const observe = botId ? botStateGenerations[botId] ?? 0 : 0;
  const access = localOperation(state, "bots", "bot_state_read");
  const unavailable = remote ? "Bot state is available only on the local UI." : !access.available ? access.reason : status.bots !== "open" ? "The bots connection is not open." : null;
  const read = useBotRead(() => botId && !unavailable ? store.call<BotStateRead>("bots", "bot_state_read", { botId }) : Promise.resolve(null), `${botId}:${unavailable ?? ""}`, observe);
  if (remote) {
    return (
      <Window id="bot-state" title="Bot state" icon={HardDriveIcon} accent="bots" empty>
        <div className="flex flex-col items-center gap-1.5 p-6 text-center">
          <HardDriveIcon className="size-5 text-muted-foreground/70" />
          <p className="text-sm font-medium">Available only on the local UI</p>
          <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">Bot workspaces, histories and stored state are local operator state. Remote sessions cannot read or change them.</p>
        </div>
      </Window>
    );
  }
  const data = read.data;
  const scope: BotScope | null = botId && data ? { botId, incarnation: data.incarnation, generation: data.generation, observe, unavailable } : null;
  return (
    <Window id="bot-state" title="Bot state" subtitle={botId ?? undefined} icon={HardDriveIcon} accent="bots" node={botId ? { kind: "bot-state", id: botId } : undefined}
      status={status.bots} endpoint={endpoints.bots} error={read.error} empty={!scope}>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <NativeSelect size="sm" aria-label="Bot" className="min-w-0 flex-1" value={botId ?? ""} onChange={(event) => store.selectBotState(event.target.value || null)}>
            <NativeSelectOption value="">Choose a Bot</NativeSelectOption>
            {(bots.data ?? []).map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.id}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        {unavailable ? <p className={hintClass}>{unavailable}</p> : null}
        {!botId ? <Empty icon={HardDriveIcon} title="Choose a Bot to inspect its state" /> : null}
        <ReadError error={read.error} what="Bot state" />
        {botId && !data && read.loading ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner />Reading {botId}&rsquo;s state and cleanup dependencies…</p> : null}
        {scope && bot && data ? (
          <>
            <ToggleGroup value={[view]} onValueChange={(next: string[]) => { if (next.length) setView(next[0] as View); }} spacing={0} size="sm" variant="outline" aria-label="Bot state view" className="flex-wrap">
              {views.map((item) => <ToggleGroupItem key={item.id} value={item.id}>{item.title}</ToggleGroupItem>)}
            </ToggleGroup>
            {/* A new incarnation (a removed and re-created Bot ID) remounts every view, dropping selections and in-flight reads. */}
            <div key={data.incarnation} className="flex flex-col gap-2">
              {view === "overview" ? <Overview scope={scope} bot={bot} data={data} refresh={read.refresh} /> : null}
              {view === "workspace" ? <WorkspaceView scope={scope} owned={workspaceOwned(data)} cwd={bot.cwd} /> : null}
              {view === "conversation" ? <ConversationView scope={scope} bot={bot} /> : null}
              {view === "queue" ? <QueueView scope={scope} /> : null}
              {view === "uploads" ? <UploadsView scope={scope} /> : null}
              {view === "launch" ? <LaunchView scope={scope} /> : null}
              {view === "log" ? <LogView scope={scope} /> : null}
              {view === "recovery" ? <RecoveryView scope={scope} /> : null}
            </div>
          </>
        ) : null}
      </div>
    </Window>
  );
}

/** Existing lifecycle controls for each dependency owner that can block cleanup; nothing here resolves them. */
function DependencyLinks({ bot }: { bot: Bot }) {
  const store = useStore();
  const { setSpace } = useWorkbench();
  const { workerWindows } = useWorkerWindows();
  const { procWindows } = useProcWindows();
  const chip = "inline-flex h-6 items-center gap-1 rounded-md bg-muted/70 px-1.5 text-[0.7rem] text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring";
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button type="button" className={chip} onClick={() => { workerWindows.setFilter({ botId: bot.id }); setSpace("workers"); }}><HammerIcon aria-hidden className="size-3" />Workers</button>
      <button type="button" className={chip} onClick={() => { procWindows.setScheduleFilter({ owner: bot.id }); setSpace("proc"); }}><CalendarClockIcon aria-hidden className="size-3" />Proc schedules</button>
      <button type="button" className={chip} onClick={() => setSpace("browse")}><GlobeIcon aria-hidden className="size-3" />Browser controllers</button>
      <button type="button" className={chip} onClick={() => { void store.filterSubscriptions({ botId: bot.id }); setSpace("system"); }}><CableIcon aria-hidden className="size-3" />Event subscriptions</button>
    </div>
  );
}

function Overview({ scope, bot, data, refresh }: { scope: BotScope; bot: Bot; data: BotStateRead; refresh(): void }) {
  const blockers = botBlockers(data);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2.5">
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Lifecycle</dt><dd>{bot.recoveryIssue ? "Needs inspection" : bot.state}</dd>
        <dt className="text-muted-foreground">Incarnation</dt><dd className="truncate font-mono text-[0.68rem]" title={data.incarnation}>{data.incarnation}</dd>
        <dt className="text-muted-foreground">Generation</dt><dd className="truncate font-mono text-[0.68rem]" title={data.generation}>{data.generation}</dd>
        <dt className="text-muted-foreground">Main thread</dt><dd className="truncate font-mono text-[0.68rem]" title={bot.mainThreadId ?? undefined}>{bot.mainThreadId ?? "None bound yet"}</dd>
      </dl>
      {data.maintenanceRequestId ? <MaintenanceFence scope={scope} requestId={data.maintenanceRequestId} onReleased={refresh} /> : null}
      <section aria-label="Cleanup blockers" className="flex flex-col gap-1.5">
        <ViewHeader title="Before cleanup" onRefresh={refresh} />
        {blockers.length ? (
          <>
            <ul className="flex flex-col gap-0.5 text-xs text-destructive">{blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
            <p className={hintClass}>Resolve these with their own controls, then prepare a new plan. Unavailable owners block too; they are never treated as having nothing to report.</p>
            <BotLifecycleControls bot={bot} />
            <DependencyLinks bot={bot} />
          </>
        ) : <p className="text-xs text-muted-foreground">Nothing currently blocks maintenance. Each plan checks again.</p>}
      </section>
      <section aria-label="Stored state" className="flex flex-col gap-1">
        <span className={labelClass}>Stored state</span>
        <ul className="flex flex-col">
          {data.entries.map((entry) => (
            <li key={entry.id} className="flex flex-col rounded-md px-1 py-1 hover:bg-muted/40">
              <button type="button" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)} className="flex min-w-0 items-center gap-2 text-left text-xs">
                <span className="font-medium">{entry.id.split(":").at(-1)}</span>
                <span className="text-muted-foreground">{entry.kind}</span>
                {entry.location === "external" ? <Pill>external</Pill> : null}
                {entry.sensitivity === "credential" ? <Pill tone="destructive">credential</Pill> : null}
                <span className="ml-auto text-muted-foreground tabular-nums">{entry.items === null ? "" : `${entry.items} item${entry.items === 1 ? "" : "s"}`}</span>
              </button>
              {open === entry.id ? <div className="pt-1 pl-2"><StateEntryDetails entry={entry} /></div> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * An earlier cleanup did not complete, so the Bot cannot start. Inspect its receipt and the files first; releasing
 * the fence only acknowledges that inspection. It never completes cleanup or changes the receipt.
 */
function MaintenanceFence({ scope, requestId, onReleased }: { scope: BotScope; requestId: string; onReleased(): void }) {
  const store = useStore();
  const now = useNow(15_000);
  const receipt = useBotRead(() => store.call<{ receipt: StateReceipt | null }>("bots", "bot_state_receipt_get", { requestId }).then((value) => value.receipt), `${scope.incarnation}:${requestId}`, scope.observe);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = receipt.data?.status === "running";
  const release = () => {
    setPending(true);
    store.call("bots", "bot_state_fence_release", { botId: scope.botId, requestId, expectedGeneration: scope.generation })
      .then(() => { setConfirming(false); toast.success("Start fence released; the receipt is unchanged"); onReleased(); }, (cause) => setError(errorMessage(cause)))
      .finally(() => setPending(false));
  };
  return (
    <section aria-label="Maintenance fence" className="flex flex-col gap-1.5 rounded-lg border border-warning/50 bg-warning/5 p-2">
      <span className="flex items-center gap-1.5 text-xs font-medium"><ShieldAlertIcon aria-hidden className="size-3.5 text-warning" />An earlier cleanup is unresolved, so this Bot cannot start</span>
      <ReadError error={receipt.error} what="Receipt" />
      {receipt.data ? <StateReceiptView receipt={receipt.data} now={now} /> : receipt.data === null && !receipt.loading && !receipt.error ? <p className="text-xs text-muted-foreground">The owner has no receipt for request {requestId}.</p> : null}
      <p className={hintClass}>Inspect the outcomes and the remaining files. Releasing the fence acknowledges that inspection so the Bot can start again. It does not finish the cleanup, and the receipt stays {receipt.data?.status ?? "as it is"}.</p>
      <Button size="sm" variant="outline" className="self-start" disabled={running || !!scope.unavailable} title={running ? "Cleanup is still running" : undefined} onClick={() => { setError(null); setConfirming(true); }}>Release start fence…</Button>
      <AlertDialog open={confirming} onOpenChange={(value) => { if (!value && !pending) setConfirming(false); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><ShieldAlertIcon /></AlertDialogMedia>
            <AlertDialogTitle>Release the start fence?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span>Confirm you have inspected request <code className="font-mono break-all">{requestId}</code> and its files.</span>
              <span>This only lets {scope.botId} start again. Nothing is cleaned up or retried, and a partial or unknown result stays that way.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button disabled={pending} onClick={release}>{pending ? <Spinner data-icon="inline-start" /> : null}Release fence</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ConversationView({ scope, bot }: { scope: BotScope; bot: Bot }) {
  const store = useStore();
  const now = useNow(60_000);
  const [history, setHistory] = useState<"retain" | "purge" | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const pages = useBotPages<BotHistoryGeneration>((offset, revision) => store.call<{ generations: BotHistoryGeneration[]; revision: string; nextOffset: number | null }>("bots", "bot_history_list",
    { botId: scope.botId, offset, limit: 100, ...(revision ? { revision } : {}) }).then((page) => ({ items: page.generations, revision: page.revision, nextOffset: page.nextOffset })), scope.incarnation, scope.observe);
  const reset = useBotAction(scope, { kind: "session_reset", history: history ?? "retain" });
  const idle = reset.flow.phase === "idle";
  return (
    <div className="flex flex-col gap-2.5">
      <ViewHeader title="Conversation generations" loading={pages.loading} onRefresh={pages.refresh} />
      <ReadError error={pages.error} what="History generations" />
      {pages.page ? (
        <ul aria-label="History generations" className="flex flex-col gap-1">
          {pages.page.items.map((generation) => (
            <li key={generation.generation} className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <code className="font-mono text-[0.7rem]" title={generation.generation}>{shortId(generation.generation)}</code>
                {generation.active ? <Pill tone="bots">active</Pill> : generation.purgedAt ? <Pill>purged</Pill> : <Pill>retired</Pill>}
                {generation.ownership === "shared" ? <Pill tone="warning" title="Recorded before per-generation namespaces; not fully attributable">legacy shared</Pill> : null}
                <span className="ml-auto text-muted-foreground">{generation.purgedAt ? `purged ${relativeTime(Date.parse(generation.purgedAt), now)}` : generation.retiredAt ? `retired ${relativeTime(Date.parse(generation.retiredAt), now)}` : `since ${relativeTime(Date.parse(generation.createdAt), now)}`}</span>
              </span>
              <span className="truncate font-mono text-[0.66rem] text-muted-foreground" title={generation.mainThreadId ?? undefined}>root {generation.mainThreadId ?? "not bound"}</span>
              {generation.ownership === "shared" && !generation.active ? <p className={hintClass}>Legacy shared history cannot be purged wholesale.</p> : null}
              {generation.purgedAt ? <p className={hintClass}>History bytes are gone; this lifecycle record remains.</p> : null}
              {purgeable(generation) ? (
                purging === generation.generation ? (
                  <BotAction scope={scope} action={{ kind: "history_clear", generation: generation.generation }} label="Prepare purge of this generation" applyLabel="Purge this history" />
                ) : <Button size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => setPurging(generation.generation)}>Purge this retired history…</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {pages.page ? <MoreButton nextOffset={pages.page.nextOffset} loading={pages.loading} onMore={pages.more} restarted={pages.page.restarted} /> : null}
      <section aria-label="Reset conversation" className="flex flex-col gap-1.5 border-t pt-2">
        <span className={labelClass}>Reset conversation</span>
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[0.72rem] text-muted-foreground">
          <li>The current root {bot.mainThreadId ? <code className="font-mono">{shortId(bot.mainThreadId)}</code> : null} is retired and the history namespace advances. The next durable turn binds a new root.</li>
          <li>Bot identity, account, workspace and settings stay. Pending queue entries are cancelled; sent and unknown admissions and queued bodies stay as evidence.</li>
          <li>Signal, Infer, Worker, Browser and HUD copies are separate and stay. A server restart can autostart this Bot.</li>
        </ul>
        <div role="radiogroup" aria-label="Current history" className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Choose what happens to the current history:</span>
          <label className="flex items-center gap-1.5"><input type="radio" name={`${scope.incarnation}-history`} checked={history === "retain"} disabled={!idle} onChange={() => setHistory("retain")} />Retain it as a retired generation</label>
          <label className="flex items-center gap-1.5"><input type="radio" name={`${scope.incarnation}-history`} checked={history === "purge"} disabled={!idle} onChange={() => setHistory("purge")} />Purge its Stack-owned history bytes</label>
        </div>
        <StateFlowView controls={reset} label="Prepare conversation reset" applyLabel="Reset conversation"
          unavailable={scope.unavailable ?? (history ? null : "Choose whether to retain or purge the current history.")} />
      </section>
    </div>
  );
}

/** Content-free queue receipts across roots. The active root's messages stay in its chat. */
function QueueView({ scope }: { scope: BotScope }) {
  const store = useStore();
  const pages = useBotPages<BotQueueEntry>((offset, revision) => store.call<{ entries: BotQueueEntry[]; revision: string; nextOffset: number | null }>("bots", "bot_queue_history",
    { botId: scope.botId, offset, limit: 100, ...(revision ? { revision } : {}) }).then((page) => ({ items: page.entries, revision: page.revision, nextOffset: page.nextOffset })), scope.incarnation, scope.observe);
  const counts = new Map<string, number>();
  for (const entry of pages.page?.items ?? []) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  return (
    <div className="flex flex-col gap-2">
      <ViewHeader title="Queue receipts" loading={pages.loading} onRefresh={pages.refresh}>
        <span className="text-[0.68rem] text-muted-foreground">{[...counts].map(([key, value]) => `${value} ${key}`).join(" · ")}</span>
      </ViewHeader>
      <p className={hintClass}>Identities and sizes only, across current and retired roots. The current root&rsquo;s queued messages are in its chat.</p>
      <ReadError error={pages.error} what="Queue history" />
      {pages.page ? pages.page.items.length ? (
        <ul aria-label="Queue receipts" className="flex flex-col">
          {pages.page.items.map((entry) => (
            <li key={entry.id} className="flex min-w-0 items-center gap-2 px-1 py-0.5 text-xs" title={queueWords[entry.state]}>
              <span className={cn("w-20 shrink-0", entry.state === "unknown" && "text-warning", entry.state === "cancelled" && "text-muted-foreground")}>{entry.state}</span>
              <code className="min-w-0 truncate font-mono text-[0.66rem]">{entry.id}</code>
              <span className="ml-auto shrink-0 font-mono text-[0.66rem] text-muted-foreground" title={`Thread ${entry.threadId}`}>{shortId(entry.threadId)}</span>
              <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">{formatBytes(entry.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-muted-foreground">No queue entries recorded.</p> : null}
      {counts.get("unknown") ? <p className="text-xs text-warning">{queueWords.unknown}</p> : null}
      {pages.page ? <MoreButton nextOffset={pages.page.nextOffset} loading={pages.loading} onMore={pages.more} restarted={pages.page.restarted} /> : null}
    </div>
  );
}

/** Saved launch arguments: count and digest by default; values only on an explicit local reveal, since they can hold secrets. */
function LaunchView({ scope }: { scope: BotScope }) {
  const store = useStore();
  const { goTo } = useWorkbench();
  const [revealed, setRevealed] = useState<BotLaunch | null>(null);
  const [revealing, setRevealing] = useState(false);
  const launch = useBotRead(() => store.call<BotLaunch>("bots", "bot_launch_read", { botId: scope.botId, revealArguments: false }), scope.incarnation, scope.observe);
  const data = launch.data;
  // Revealed values belong to the revision they were read at.
  const shown = revealed && data && revealed.revision === data.revision ? revealed : null;
  const reveal = () => {
    setRevealing(true);
    store.call<BotLaunch>("bots", "bot_launch_read", { botId: scope.botId, revealArguments: true }).then(setRevealed, (error) => toast.error(errorMessage(error))).finally(() => setRevealing(false));
  };
  return (
    <div className="flex flex-col gap-2">
      <ViewHeader title="Launch arguments" loading={launch.loading} onRefresh={launch.refresh} />
      <ReadError error={launch.error} what="Launch arguments" />
      {data ? (
        <>
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">Saved</dt><dd className="tabular-nums">{data.count} argument{data.count === 1 ? "" : "s"}</dd>
            <dt className="text-muted-foreground">Digest</dt><dd className="truncate font-mono text-[0.66rem]" title={data.revision}>{data.revision}</dd>
            <dt className="text-muted-foreground">Role</dt><dd>{data.roleId ? <NodeLink node={{ kind: "role", id: data.roleId }} label={`Role ${data.roleId}`}>{data.roleId}</NodeLink> : "None captured"}{data.roleRevision !== null ? ` · revision ${data.roleRevision}` : ""}</dd>
            <dt className="text-muted-foreground">Running</dt><dd>{data.running ? "Yes: running processes keep what they launched with" : "No"}</dd>
          </dl>
          {data.count ? (
            <Button size="xs" variant="ghost" className="self-start" disabled={revealing || !!scope.unavailable} onClick={() => shown ? setRevealed(null) : reveal()}>
              {revealing ? <Spinner /> : shown ? <EyeOffIcon /> : <EyeIcon />}{shown ? "Hide values" : "Reveal values"}
            </Button>
          ) : null}
          {shown?.arguments ? (
            <div className="flex flex-col gap-1 rounded-md border border-dashed p-2">
              <span className={labelClass}>Values · may contain secrets</span>
              <ol className="flex flex-col font-mono text-[0.68rem]">{shown.arguments.map((value, index) => <li key={index} className="break-all">{value}</li>)}</ol>
            </div>
          ) : null}
        </>
      ) : null}
      <p className={hintClass}>Managed model and runtime settings are separate. <button type="button" className="underline-offset-4 hover:underline" onClick={() => goTo({ kind: "bot", id: scope.botId })}><BookOpenIcon aria-hidden className="inline size-3" /> Bot settings</button></p>
      <BotAction scope={scope} action={{ kind: "launch_args_clear" }} label="Prepare argument clear" applyLabel="Clear saved arguments">
        <p className={hintClass}>The next start launches without saved arguments.</p>
      </BotAction>
    </div>
  );
}

