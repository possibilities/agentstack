"use client";

import { use, useId, useState } from "react";
import { ChevronsUpDownIcon, CopyPlusIcon, EyeIcon, HandIcon, LifeBuoyIcon, MonitorIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { browseCallError, browseLocalReason, groupHandoffs, handoffContentSelection, handoffOutcomes, handoffStates, heldBy, intentFor, loadIntent, profileName, saveIntent } from "@/lib/stack/browse";
import { localOperations, stateOperations } from "@/lib/stack/state";
import { primaryViewer, type HandoffActionState } from "@/lib/stack/browse-viewers";
import type { BrowserHandoff, BrowserHandoffAction, BrowserProfile } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { ContentCleared, Empty, Flash, NodeCard, NodeLink, NodeTitle, StatusDot, Time } from "./primitives";
import { browseMaintenanceOperations } from "./browse-maintenance";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";
import { useStack, useStore, useViewerWindows, useWorkbench } from "./provider";
import { PlacementContext, Section, Window } from "./window";

function session(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function mint(): string {
  return crypto.randomUUID();
}

/** Why browse can't be used from this page right now, or null. */
export function useBrowseBlocked(): string | null {
  const { endpoints, status, remote } = useStack();
  return browseLocalReason(remote) ?? (!endpoints.browse ? "Browse isn't served by this server" : status.browse !== "open" ? "Browse reconnecting" : null);
}

/**
 * Take and finish, following the API's retry contract. Each intended action keeps one request ID
 * with its exact arguments in sessionStorage before it is sent. An unknown outcome keeps the
 * intent for an identical retry; nothing is resent automatically. A take this page made stays
 * stored while the handoff is under human control, so Reopen can recover its grant after a reload.
 */
export function useHandoffActions() {
  const store = useStore();
  const { viewers, actions, grants } = useViewerWindows();
  const { goTo } = useWorkbench();
  const act = async (kind: "take" | "finish", handoff: BrowserHandoff, choice: HandoffActionState["choice"] = {}) => {
    if (actions[handoff.id]?.pending) return;
    const storage = session();
    const stored = loadIntent(storage, handoff.id);
    const intent = intentFor(kind, handoff, stored, choice, mint);
    saveIntent(storage, intent, handoff.id);
    viewers.setAction(handoff.id, { kind, choice, pending: true, error: null });
    try {
      const result = await store.browse<BrowserHandoffAction>(kind === "take" ? "browser_handoff_take" : "browser_handoff_finish", { ...intent.args });
      viewers.grant(handoff.id, kind === "take" ? result.controlUrl : null);
      if (kind === "finish") saveIntent(storage, null, handoff.id);
      viewers.setAction(handoff.id, null);
      if (kind === "take") goTo({ kind: "browser-viewer", id: viewers.show(handoff.profileId) });
    } catch (error) {
      const failure = browseCallError(error);
      // A definite refusal ends the intent, except the take a controlled handoff still depends on.
      const keep = failure.uncertain || (intent === stored && kind === "take" && handoff.state === "human_controlling");
      if (!keep) saveIntent(storage, null, handoff.id);
      viewers.setAction(handoff.id, { kind, choice, pending: false, error: failure });
    }
  };
  /** A stored intent this page can repeat for a handoff that has moved on without it. */
  const resumable = (handoff: BrowserHandoff): "take" | "finish" | null => {
    const stored = loadIntent(session(), handoff.id);
    if (stored?.kind === "take" && handoff.state === "human_controlling" && !grants[handoff.id]) return "take";
    if (stored?.kind === "finish" && handoff.state === "returning") return "finish";
    return null;
  };
  const retry = (handoff: BrowserHandoff) => {
    const state = actions[handoff.id];
    if (state) return act(state.kind, handoff, state.choice);
    const kind = resumable(handoff);
    const stored = loadIntent(session(), handoff.id);
    if (kind && stored) return act(kind, handoff, { outcome: stored.args.outcome, note: stored.args.note });
  };
  return { act, retry, resumable, actions, grants };
}

const targetCopy: Record<BrowserHandoff["targetStatus"], string | null> = {
  unspecified: null,
  present: "Requested tab found",
  missing: "Requested tab is gone",
  unknown: "Requested tab unchecked",
};

function firstLine(message: string): string {
  return message.split("\n")[0].slice(0, 120) || "Handoff";
}

/** Completed or Skipped with an optional note. Completed is the operator's report; the Bot verifies it. */
export function FinishForm({ handoff, compact, onDone }: { handoff: BrowserHandoff; compact?: boolean; onDone?: () => void }) {
  const { act, actions } = useHandoffActions();
  const blocked = useBrowseBlocked();
  const id = useId();
  const state = actions[handoff.id];
  const [note, setNote] = useState(state?.kind === "finish" ? state.choice.note ?? "" : "");
  const pending = Boolean(state?.pending && state.kind === "finish");
  const finish = (outcome: "completed" | "skipped") => void act("finish", handoff, { outcome, note }).then(onDone);
  return (
    <div className={cn("flex flex-col gap-1.5", compact ? "" : "rounded-lg border p-2")}>
      <label htmlFor={`${id}-note`} className="sr-only">Note for the Bot</label>
      <Textarea id={`${id}-note`} value={note} maxLength={4000} disabled={pending} placeholder="Note for the Bot (optional)"
        onChange={(event) => setNote(event.target.value)} className={cn("min-h-8 text-[0.74rem]", compact ? "max-h-16" : "max-h-28")} />
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-[0.66rem] text-pretty text-muted-foreground">{blocked ?? "Hands the whole profile back. The Bot checks your report with a fresh snapshot."}</span>
        <Button type="button" size="sm" variant="outline" disabled={Boolean(blocked) || pending} onClick={() => finish("skipped")}>Skipped</Button>
        <Button type="button" size="sm" disabled={Boolean(blocked) || pending} onClick={() => finish("completed")}>
          {pending ? <Spinner data-icon="inline-start" /> : null}Completed
        </Button>
      </div>
    </div>
  );
}

function ActionNote({ handoff }: { handoff: BrowserHandoff }) {
  const { actions, retry } = useHandoffActions();
  const blocked = useBrowseBlocked();
  const error = actions[handoff.id]?.error;
  if (!error) return null;
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[0.72rem] text-pretty", error.uncertain ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive")}>
      <span className="min-w-0 flex-1">{error.text}{error.uncertain ? " It may have happened; nothing is resent automatically." : ""}</span>
      {error.uncertain ? <Button type="button" size="xs" variant="outline" disabled={Boolean(blocked)} onClick={() => void retry(handoff)}><RotateCcwIcon data-icon="inline-start" />Retry</Button> : null}
    </div>
  );
}

/** One handoff's controls for its current state. */
function HandoffControls({ handoff, inViewer }: { handoff: BrowserHandoff; inViewer?: boolean }) {
  const { act, retry, resumable, actions, grants } = useHandoffActions();
  const { viewers } = useViewerWindows();
  const { goTo } = useWorkbench();
  const blocked = useBrowseBlocked();
  const [finishing, setFinishing] = useState(false);
  const state = actions[handoff.id];
  const taking = Boolean(state?.pending && state.kind === "take");
  const resume = resumable(handoff);
  const view = () => goTo({ kind: "browser-viewer", id: viewers.show(handoff.profileId) });
  if (handoff.state === "resolved" || handoff.state === "preparing") return <ActionNote handoff={handoff} />;
  if (handoff.state === "returning") {
    return (
      <>
        <ActionNote handoff={handoff} />
        {resume && !state ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[0.68rem] text-muted-foreground">This page finished it; the return hasn&apos;t completed.</span>
            <Button type="button" size="xs" variant="outline" disabled={Boolean(blocked)} onClick={() => void retry(handoff)}><RotateCcwIcon data-icon="inline-start" />Retry return</Button>
          </div>
        ) : handoff.issue && !resume ? <p className="text-[0.68rem] text-muted-foreground">The browser or Bot that started this return retries it.</p> : null}
      </>
    );
  }
  const controlling = handoff.state === "human_controlling";
  return (
    <>
      <ActionNote handoff={handoff} />
      <div className="flex flex-wrap items-center gap-1.5">
        {handoff.state === "awaiting_human" ? (
          <Button type="button" size="xs" disabled={Boolean(blocked) || taking} title={blocked ?? "Stops managed automation for the whole profile and gives you input"} onClick={() => void act("take", handoff)}>
            {taking ? <Spinner data-icon="inline-start" /> : <HandIcon data-icon="inline-start" />}Take control
          </Button>
        ) : controlling && grants[handoff.id] ? (
          inViewer ? <span className="text-[0.7rem] font-medium text-pkg-browse">You have control in this viewer</span>
            : <Button type="button" size="xs" onClick={view}><MonitorIcon data-icon="inline-start" />Open viewer</Button>
        ) : controlling && resume === "take" ? (
          <Button type="button" size="xs" disabled={Boolean(blocked) || taking} title="Repeats this page's take; the API issues the grant again" onClick={() => void act("take", handoff)}>
            {taking ? <Spinner data-icon="inline-start" /> : <HandIcon data-icon="inline-start" />}Reopen control
          </Button>
        ) : controlling ? <span className="text-[0.68rem] text-muted-foreground">Taken in another browser. You can still finish here.</span> : null}
        {!inViewer && !controlling ? <Button type="button" size="xs" variant="ghost" onClick={view}><EyeIcon data-icon="inline-start" />Watch</Button> : null}
        {inViewer ? null : (
          <Button type="button" size="xs" variant="ghost" className="ml-auto" aria-expanded={finishing} onClick={() => setFinishing(!finishing)}>Finish…</Button>
        )}
      </div>
      {finishing && !inViewer ? <FinishForm handoff={handoff} onDone={() => setFinishing(false)} /> : null}
    </>
  );
}

function HandoffRow({ handoff, profile }: { handoff: BrowserHandoff; profile: BrowserProfile | undefined }) {
  const view = handoffStates[handoff.state];
  const node = { kind: "browser-handoff" as const, id: handoff.id };
  const target = targetCopy[handoff.targetStatus];
  return (
    <li data-node={`browser-handoff:${handoff.id}`} className="relative">
      <Flash id={`browser-handoff:${handoff.id}`} />
      <NodeCard node={node} label={firstLine(handoff.message)} className={cn(handoff.state === "awaiting_human" && "border-warning/50 bg-warning/5")}>
        <div className="flex items-center gap-2">
          <StatusDot tone={view.tone} pulse={handoff.state === "awaiting_human"} label={view.label} />
          <NodeTitle node={node} label={firstLine(handoff.message)} className="min-w-0 truncate text-[0.8rem] font-medium">{view.label}</NodeTitle>
          <span className="ml-auto shrink-0 text-[0.66rem] text-muted-foreground"><Time at={Date.parse(handoff.createdAt)} /></span>
        </div>
        {handoff.contentClearedAt ? <ContentCleared at={handoff.contentClearedAt} /> : <p className="line-clamp-4 text-[0.78rem] whitespace-pre-wrap text-pretty">{handoff.message}</p>}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.68rem] text-muted-foreground">
          <NodeLink node={{ kind: "bot", id: handoff.botId }} label={`bot ${handoff.botId}`} className="font-mono text-foreground">{handoff.botId}</NodeLink>
          <span aria-hidden>·</span>
          <NodeLink node={{ kind: "browser-profile", id: handoff.profileId }} label={`profile ${profileName(profile, handoff.profileId)}`}>{profileName(profile, handoff.profileId)}</NodeLink>
          {target ? <><span aria-hidden>·</span><span className={cn(handoff.targetStatus === "missing" && "text-warning")}>{target}</span></> : null}
          <span aria-hidden>·</span>
          <span>{handoff.quiesced ? "Automation drained" : "Automation not drained"}</span>
        </p>
        {!handoff.contentClearedAt && handoff.issue ? (
          <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">
            <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{handoff.issue}{handoff.state === "preparing" ? ". The profile stays held; there is no force release." : ""}</span>
          </p>
        ) : null}
        <HandoffControls handoff={handoff} />
      </NodeCard>
    </li>
  );
}

function HistoryRows({ rows, profiles, selection }: { rows: BrowserHandoff[]; profiles: Map<string, BrowserProfile>; selection?: { ids: string[]; locked: boolean; select(id: string): void } }) {
  return <ul className="flex flex-col gap-0.5">
    {rows.map((handoff) => {
      const title = handoff.contentClearedAt ? "Handoff content cleared" : firstLine(handoff.message);
      return <li key={handoff.id} data-node={`browser-handoff:${handoff.id}`} className="relative">
        <Flash id={`browser-handoff:${handoff.id}`} />
        <NodeCard node={{ kind: "browser-handoff", id: handoff.id }} label={title} variant="row">
          <div className="flex items-center gap-2 text-[0.72rem]">
            {selection ? <input type="checkbox" aria-label={`Select handoff ${handoff.id}`} checked={selection.ids.includes(handoff.id)}
              disabled={selection.locked || !!handoff.contentClearedAt || (!selection.ids.includes(handoff.id) && selection.ids.length >= 100)} onChange={() => selection.select(handoff.id)} /> : null}
            <NodeTitle node={{ kind: "browser-handoff", id: handoff.id }} label={title} className="min-w-0 truncate">{title}</NodeTitle>
            <span className="ml-auto shrink-0 text-[0.64rem] text-muted-foreground">{handoff.outcome ? handoffOutcomes[handoff.outcome] : "Resolved"} · <Time at={Date.parse(handoff.resolvedAt ?? handoff.createdAt)} /></span>
          </div>
          {handoff.contentClearedAt ? <ContentCleared at={handoff.contentClearedAt} /> : null}
          <p className="flex gap-2 text-[0.66rem] text-muted-foreground">
            <span className="font-mono">{handoff.botId}</span><span className="truncate">{profileName(profiles.get(handoff.profileId), handoff.profileId)}</span>
            {!handoff.contentClearedAt && handoff.note ? <span className="min-w-0 truncate italic" title={handoff.note}>“{handoff.note}”</span> : null}
          </p>
        </NodeCard>
      </li>;
    })}
  </ul>;
}

function HandoffHistory({ rows, profiles }: { rows: BrowserHandoff[]; profiles: Map<string, BrowserProfile> }) {
  const state = useStack();
  return localOperations(state, "browse", Object.values(browseMaintenanceOperations.handoff)).available
    ? <MaintainedHistory rows={rows} profiles={profiles} /> : <HistoryRows rows={rows} profiles={profiles} />;
}

function MaintainedHistory({ rows, profiles }: { rows: BrowserHandoff[]; profiles: Map<string, BrowserProfile> }) {
  const state = useStack();
  const store = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const controls = useStateFlow({ operations: stateOperations(store.call, "browse", browseMaintenanceOperations.handoff, { ids: selected }),
    recoveryKey: "browse:handoff:ids", observe: state.browserHandoffs.at,
    onReceipt: (receipt) => { if (receipt.status !== "running") store.refreshBrowse(); if (receipt.status === "completed") setSelected([]); } });
  const locked = controls.flow.phase !== "idle";
  const unavailable = state.status.browse !== "open" ? "The Browse connection is not open." : state.browserHandoffs.error ? "Refresh handoffs before preparing."
    : !handoffContentSelection(rows, selected) ? "Select up to 100 resolved handoffs with retained content; review any changed selection." : null;
  return <>
    {!maintenanceOpen && !locked ? <HistoryRows rows={rows} profiles={profiles} /> : null}
    <MaintenanceDisclosure active={locked} aside="resolved handoff content" onOpenChange={setMaintenanceOpen}>
      <p className="text-xs text-pretty text-muted-foreground">Redacts exact resolved messages, notes and issues in the Browse ledger. IDs, target/profile/controller identity, outcome, timing and permanent admission/action digests stay. Open handoffs cannot be selected. Screenshots and live control URLs were never persisted here; caller/upstream copies and backups remain independent.</p>
      {maintenanceOpen || locked ? <HistoryRows rows={rows} profiles={profiles} selection={{ ids: selected, locked, select: (id) => setSelected((held) => held.includes(id) ? held.filter((value) => value !== id) : [...held, id]) }} /> : null}
      <StateFlowView controls={controls} label={`Prepare clearing ${selected.length} handoff bodies`} applyLabel="Clear handoff content" unavailable={unavailable} />
    </MaintenanceDisclosure>
  </>;
}

/**
 * Durable requests from Bot Chats for human help with a whole Browser profile. Unresolved ones
 * come first, oldest first; disconnect, timeout and closing a viewer never resolve one.
 */
export function HandoffsWindow() {
  const store = useStore();
  const { status, endpoints, browserHandoffs, browserProfiles, remote } = useStack();
  const [history, setHistory] = useState(false);
  const handoffs = browserHandoffs.data ?? [];
  const { open, resolved } = groupHandoffs(handoffs);
  const profiles = new Map((browserProfiles.data ?? []).map((profile) => [profile.id, profile]));
  const unavailable = browseLocalReason(remote) ?? (!endpoints.browse ? "Browse isn't served by this server" : null);
  const waiting = handoffs.filter((item) => item.state === "awaiting_human").length;
  return (
    <Window id="browse-handoffs" title="Handoffs" icon={LifeBuoyIcon} accent="browse" count={browserHandoffs.data ? open.reduce((sum, group) => sum + group.handoffs.length, 0) : null}
      status={endpoints.browse ? status.browse : undefined} endpoint={endpoints.browse} updatedAt={browserHandoffs.at} error={browserHandoffs.error}
      empty={!handoffs.length}
      actions={endpoints.browse ? (
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Read browse again" title="Read browse again" disabled={status.browse !== "open"} onClick={store.refreshBrowse}>
          <RotateCcwIcon />
        </Button>
      ) : null}>
      {unavailable ? <Empty icon={LifeBuoyIcon} title={unavailable} />
        : !browserHandoffs.data ? <Empty icon={LifeBuoyIcon} title="Reading handoffs…" />
        : !handoffs.length ? <Empty icon={LifeBuoyIcon} title="No Bot has asked for browser help" />
        : (
          <>
            {waiting ? <p className="px-0.5 text-[0.72rem] text-warning">{waiting === 1 ? "A Bot is waiting for you" : `${waiting} Bots are waiting for you`}</p> : null}
            {open.map((group) => (
              <Section key={group.state} title={handoffStates[group.state].label}>
                <ul className="flex flex-col gap-2">{group.handoffs.map((handoff) => <HandoffRow key={handoff.id} handoff={handoff} profile={profiles.get(handoff.profileId)} />)}</ul>
              </Section>
            ))}
            {!open.length ? <p className="px-0.5 text-[0.72rem] text-muted-foreground">Nothing waiting. Bots ask here when a page needs a person.</p> : null}
            {resolved.length ? (
              <Section title="History" aside={<Button type="button" size="xs" variant="ghost" aria-expanded={history} onClick={() => setHistory(!history)}>{history ? "Hide" : `Show ${resolved.length}`}</Button>}>
                {history ? (
                  <HandoffHistory rows={resolved} profiles={profiles} />
                ) : null}
              </Section>
            ) : null}
          </>
        )}
    </Window>
  );
}

function Placeholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <MonitorIcon className="size-5 text-muted-foreground/70" />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ProfileSwitcher({ windowId, profileId }: { windowId: string; profileId: string | null }) {
  const { browserProfiles } = useStack();
  const { viewers } = useViewerWindows();
  const profiles = browserProfiles.data ?? [];
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Switch profile" className="text-muted-foreground" />} />}>
          <ChevronsUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Switch profile</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-h-80 min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show profile</DropdownMenuLabel>
          {profiles.length ? (
            <DropdownMenuRadioGroup value={profileId ?? ""} onValueChange={(value) => viewers.setProfile(windowId, value || null)}>
              {profiles.map((profile) => (
                <DropdownMenuRadioItem key={profile.id} value={profile.id} closeOnClick>
                  <StatusDot tone={profile.state === "ready" ? "success" : profile.state === "failed" ? "destructive" : "muted"} />
                  <span className="truncate">{profileName(profile)}</span>
                  <span className="ml-auto font-mono text-[0.66rem] text-muted-foreground">{profile.botId ?? "unassigned"}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          ) : <p className="px-2 py-1.5 text-xs text-muted-foreground">No profiles</p>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A profile's Neko viewer. Without a grant it observes: it follows the visible tab and delivery is
 * not verified. With this page's grant it has input until the handoff is finished; closing or
 * switching the window never hands back. It loads only while Browse is the visible space.
 */
export function ViewerWindow({ id }: { id: string }) {
  const { windows, grants, viewers } = useViewerWindows();
  const { browserProfiles, browserHandoffs, remote } = useStack();
  const { goTo, space } = useWorkbench();
  const placement = use(PlacementContext)?.(id);
  const profileId = windows.find((window) => window.id === id)?.profileId ?? null;
  const profile = browserProfiles.data?.find((item) => item.id === profileId) ?? null;
  const handoff = profile ? heldBy(profile.id, browserHandoffs.data) : null;
  const grant = handoff?.state === "human_controlling" ? grants[handoff.id] ?? null : null;
  const src = grant ?? profile?.observation?.url ?? null;
  const primary = id === primaryViewer;
  const actions = (
    <>
      <ProfileSwitcher windowId={id} profileId={profileId} />
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New viewer" className="text-muted-foreground" onClick={() => goTo({ kind: "browser-viewer", id: viewers.open(profileId) })} />}>
          <CopyPlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">New viewer</TooltipContent>
      </Tooltip>
      {primary ? null : (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Close viewer" className="text-muted-foreground" onClick={() => viewers.close(id)} />}>
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Close{grant ? " · doesn't hand back" : ""}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
  return (
    <Window id={id} title={profile ? profileName(profile) : "Viewer"} subtitle={profile ? `${profile.botId ?? "unassigned"} · ${grant ? "you have control" : "observing"}` : "browser"}
      icon={MonitorIcon} accent="browse" node={profile ? { kind: "browser-profile", id: profile.id } : undefined} reveal={{ kind: "browser-viewer", id }} bleed actions={actions}>
      {remote ? <Placeholder title="Available only on the local UI" hint="Browser handoff stays on the Stack machine." />
        : !profileId ? <Placeholder title="No profile selected" hint="Choose one with the switcher, or Watch a handoff." />
        : !profile ? <Placeholder title={browserProfiles.data ? "This profile is gone" : "Reading profiles…"} />
        : (
          <>
            {grant ? (
              <p className="flex shrink-0 items-center gap-2 border-b border-pkg-browse/40 bg-pkg-browse/10 px-3 py-1.5 text-[0.72rem] font-medium text-pkg-browse">
                <HandIcon className="size-3.5" />You have control. Closing this window doesn&apos;t hand back; finish below.
              </p>
            ) : handoff ? (
              <div className="flex shrink-0 flex-col gap-1.5 border-b border-warning/40 bg-warning/5 px-3 py-2">
                <p className="line-clamp-3 text-[0.74rem] whitespace-pre-wrap text-pretty"><span className="font-medium">{handoff.botId} asks:</span> {handoff.message}</p>
                <HandoffControls handoff={handoff} inViewer />
              </div>
            ) : (
              <p className="shrink-0 border-b border-border/60 px-3 py-1 text-[0.66rem] text-muted-foreground">Live view · follows the visible tab · delivery not verified</p>
            )}
            {profile.state !== "ready" || !src ? (
              <Placeholder title={profile.state === "ready" ? "No viewer connection" : `Browser ${profile.state}`} hint={profile.error ?? (profile.observedAt ? `Observed ${new Date(Date.parse(profile.observedAt)).toLocaleTimeString()}` : undefined)} />
            ) : space !== "browse" ? <Placeholder title="Paused while Browse is hidden" />
            : (
              <iframe key={src} src={src} title={`${profileName(profile)} browser${grant ? " (control)" : ""}`}
                allow="autoplay; clipboard-read; clipboard-write; fullscreen" referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"
                className={cn("min-h-0 w-full flex-1 border-0 bg-black", placement?.dragging && "pointer-events-none", grant && "outline-2 -outline-offset-2 outline-pkg-browse")} />
            )}
            {grant && handoff ? <div className="shrink-0 border-t border-border/60 p-2"><ActionNote handoff={handoff} /><FinishForm handoff={handoff} compact /></div> : null}
          </>
        )}
    </Window>
  );
}
