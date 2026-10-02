"use client";

import { useId, useState } from "react";
import { CableIcon, EyeIcon, FolderSearchIcon, HardDriveIcon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { browseCallError, browseLocalReason, controllerKey, deleteBlock, groupProfiles, heldBy, profileName, type BrowseCallError } from "@/lib/stack/browse";
import { shortId } from "@/lib/stack/derive";
import type { BrowserController, BrowserProfile, HypemanInstallation } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty, Flash, NodeCard, NodeLink, NodeTitle, Row, StatusDot, Time, type Tone } from "./primitives";
import { useStack, useStore, useViewerWindows, useWorkbench } from "./provider";
import { useBrowseBlocked } from "./browse-handoffs";
import { BrowseMaintenanceFence, BrowseVolumes, ProfileMaintenanceDialog, browseMaintenanceOperations } from "./browse-maintenance";
import { localOperations } from "@/lib/stack/state";
import { Elapsed, fieldLabel } from "./scrape-shared";
import { footerButton, Section, Window } from "./window";

const badge = "rounded-md bg-muted px-1.5 py-px font-mono text-[0.64rem] text-muted-foreground";

/** One browse write with its own pending and error state. What it changes is re-read either way. */
function useBrowseWrite<T = unknown>(name: string) {
  const store = useStore();
  const [since, setSince] = useState<number | null>(null);
  const [error, setError] = useState<BrowseCallError | null>(null);
  const run = async (args: Record<string, unknown> = {}): Promise<T | null> => {
    setSince(Date.now());
    setError(null);
    try {
      return await store.browse<T>(name, args);
    } catch (cause) {
      setError(browseCallError(cause));
      return null;
    } finally {
      setSince(null);
    }
  };
  return { run, pending: since !== null, since, error, clear: () => setError(null) };
}

function WriteError({ error }: { error: BrowseCallError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className={cn("rounded-lg px-2.5 py-1.5 text-[0.72rem] text-pretty", error.uncertain ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive")}>
      {error.text}{error.uncertain ? " Check the state before trying again; nothing is resent automatically." : ""}
    </p>
  );
}

const profileTone: Record<BrowserProfile["state"], Tone> = { starting: "muted", ready: "success", recovering: "warning", failed: "destructive" };

/** Type the profile's name to delete it; its sign-ins and browser data are discarded. */
function DeleteProfileDialog({ profile, open, onOpenChange }: { profile: BrowserProfile; open: boolean; onOpenChange(open: boolean): void }) {
  const write = useBrowseWrite("browser_profile_delete");
  const blocked = useBrowseBlocked();
  const [typed, setTyped] = useState("");
  const name = profileName(profile);
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!write.pending) { onOpenChange(next); setTyped(""); write.clear(); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its browser, sign-ins, cookies and stored data are discarded with its VM and volume. This cannot be undone. Type <span className="font-mono font-medium text-foreground">{name}</span> to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input value={typed} autoFocus spellCheck={false} autoComplete="off" aria-label="Profile name" disabled={write.pending} onChange={(event) => setTyped(event.target.value)} className="font-mono" />
        <WriteError error={write.error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={write.pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={typed !== name || write.pending || Boolean(blocked)} title={blocked ?? undefined}
            onClick={() => void write.run({ profileId: profile.id, confirm: "delete" }).then((result) => { if (result) onOpenChange(false); })}>
            {write.pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Delete profile
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProfileRow({ profile, controllers }: { profile: BrowserProfile; controllers: BrowserController[] }) {
  const state = useStack();
  const { browserControllers, browserHandoffs } = state;
  const { viewers } = useViewerWindows();
  const { goTo } = useWorkbench();
  const [deleting, setDeleting] = useState(false);
  const [maintenance, setMaintenance] = useState<"reset" | "site" | null>(null);
  const node = { kind: "browser-profile" as const, id: profile.id };
  const held = heldBy(profile.id, browserHandoffs.data);
  const block = deleteBlock(profile, browserControllers.data, browserHandoffs.data);
  const name = profileName(profile);
  return (
    <li data-node={`browser-profile:${profile.id}`} className="relative">
      <Flash id={`browser-profile:${profile.id}`} />
      <NodeCard node={node} label={name} variant="row">
        <div className="flex items-center gap-2">
          <StatusDot tone={profileTone[profile.state]} label={profile.state} pulse={profile.state === "starting" || profile.state === "recovering"} />
          <NodeTitle node={node} label={`profile ${name}`} className="min-w-0 truncate text-[0.78rem] font-medium">{name}</NodeTitle>
          {profile.default ? <span className={badge}>default</span> : null}
          {controllers.length ? <span className={badge} title={controllers.map((item) => `${item.session} (${item.state})`).join(", ")}>{controllers.length} controller{controllers.length === 1 ? "" : "s"}</span> : null}
          {held ? <NodeLink node={{ kind: "browser-handoff", id: held.id }} label="handoff holding this profile" className={cn(badge, "bg-warning/15 text-warning")}>held</NodeLink> : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button type="button" size="xs" variant="ghost" disabled={profile.state !== "ready"} title={profile.state === "ready" ? "Watch in the viewer" : `Browser ${profile.state}`}
              onClick={() => goTo({ kind: "browser-viewer", id: viewers.show(profile.id) })}><EyeIcon data-icon="inline-start" />View</Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" size="icon-xs" variant="ghost" aria-label={`More for ${name}`} className="text-muted-foreground" />}><MoreHorizontalIcon /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => goTo({ kind: "browser-viewer", id: viewers.open(profile.id) })}><EyeIcon />Open in a new viewer</DropdownMenuItem>
                  {localOperations(state, "browse", Object.values(browseMaintenanceOperations.reset)).available ? <DropdownMenuItem onClick={() => setMaintenance("reset")}>Reset profile…</DropdownMenuItem> : null}
                  {localOperations(state, "browse", Object.values(browseMaintenanceOperations.site)).available ? <DropdownMenuItem onClick={() => setMaintenance("site")}>Clear site data…</DropdownMenuItem> : null}
                  <DropdownMenuItem variant="destructive" disabled={Boolean(block)} title={block ?? undefined} onClick={() => setDeleting(true)}><Trash2Icon />{block ?? "Delete profile…"}</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
        <p className="flex min-w-0 gap-2 text-[0.66rem] text-muted-foreground">
          <span className="capitalize">{profile.state}</span>
          {profile.observedAt ? <span>observed <Time at={Date.parse(profile.observedAt)} /></span> : null}
          <span className="ml-auto font-mono" title={profile.id}>{shortId(profile.id)}</span>
        </p>
        {profile.error ? <p className="text-[0.68rem] break-words text-destructive">{profile.error}</p> : null}
        <BrowseMaintenanceFence profile={profile} />
      </NodeCard>
      {deleting ? <DeleteProfileDialog profile={profile} open={deleting} onOpenChange={setDeleting} /> : null}
      {maintenance ? <ProfileMaintenanceDialog profile={profile} kind={maintenance} onClose={() => setMaintenance(null)} /> : null}
    </li>
  );
}

/**
 * Durable Browser profiles by owning Bot, then unassigned. Each has one supervised browser while
 * Stack runs; a new profile starts empty and never imports sign-ins.
 */
export function ProfilesWindow() {
  const { status, endpoints, browserProfiles, browserControllers, bots, remote } = useStack();
  const blocked = useBrowseBlocked();
  const create = useBrowseWrite<BrowserProfile>("browser_profile_create");
  const formId = useId();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState({ botId: "", label: "" });
  const profiles = browserProfiles.data ?? [];
  const unavailable = browseLocalReason(remote) ?? (!endpoints.browse ? "Browse isn't served by this server" : null);
  const byProfile = (id: string) => (browserControllers.data ?? []).filter((item) => item.profileId === id || item.actualProfileId === id);
  const submit = async () => {
    if (blocked || create.pending || !draft.label.trim()) return;
    const result = await create.run({ botId: draft.botId || null, label: draft.label.trim() });
    if (result) { setDraft({ botId: draft.botId, label: "" }); setComposing(false); }
  };
  return (
    <Window id="browse-profiles" title="Profiles" icon={HardDriveIcon} accent="browse" count={browserProfiles.data ? profiles.length : null}
      status={endpoints.browse ? status.browse : undefined} endpoint={endpoints.browse} updatedAt={browserProfiles.at} error={browserProfiles.error}
      empty={!profiles.length && !composing}
      footer={unavailable ? undefined : (
        <Button variant="ghost" size="sm" className={footerButton} aria-expanded={composing} onClick={() => setComposing(!composing)}><PlusIcon data-icon="inline-start" />New profile…</Button>
      )}>
      {composing ? (
        <form className="flex flex-col gap-2 rounded-lg border p-2.5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor={`${formId}-bot`} className="flex flex-col gap-1">
            <span className={fieldLabel}>Server</span>
            <NativeSelect id={`${formId}-bot`} size="sm" value={draft.botId} disabled={create.pending} onChange={(event) => setDraft({ ...draft, botId: event.target.value })}>
              <NativeSelectOption value="">Unassigned</NativeSelectOption>
              {(bots.data ?? []).map((bot) => <NativeSelectOption key={bot.id} value={bot.id}>{bot.id}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Label</span>
            <Input value={draft.label} maxLength={128} disabled={create.pending} placeholder="research" spellCheck={false} autoComplete="off"
              onChange={(event) => { setDraft({ ...draft, label: event.target.value }); create.clear(); }} className="h-7 text-[0.76rem]" />
          </label>
          <WriteError error={create.error} />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[0.66rem] text-pretty text-muted-foreground">{blocked ?? "Starts empty; it never copies sign-ins. The browser starts in the background."}</span>
            <Button type="submit" size="sm" disabled={Boolean(blocked) || create.pending || !draft.label.trim()}>
              {create.pending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}Create
            </Button>
          </div>
        </form>
      ) : null}
      {unavailable ? <Empty icon={HardDriveIcon} title={unavailable} />
        : !browserProfiles.data ? <Empty icon={HardDriveIcon} title="Reading profiles…" />
        : !profiles.length ? (composing ? null : <Empty icon={HardDriveIcon} title="No profiles" />)
        : groupProfiles(profiles).map((group) => (
          <Section key={group.botId ?? ""} title={group.botId ?? "Unassigned"}
            aside={group.botId ? <NodeLink node={{ kind: "bot", id: group.botId }} label={`bot ${group.botId}`} className="text-[0.65rem] text-muted-foreground">Bot</NodeLink>
              : <span className="text-[0.65rem] text-muted-foreground">Kept after their Bot was deleted, or made unassigned</span>}>
            <ul className="flex flex-col gap-0.5">{group.profiles.map((profile) => <ProfileRow key={profile.id} profile={profile} controllers={byProfile(profile.id)} />)}</ul>
          </Section>
        ))}
    </Window>
  );
}

const controllerTone: Record<BrowserController["state"], Tone> = { connecting: "muted", connected: "success", disconnected: "muted", unknown: "warning" };

/**
 * Controller selections and last confirmed bindings, read-only. These are observations, not
 * liveness: `unknown` never means attached. Selecting a profile for a live Bot stays with the Bot.
 */
export function ControllersWindow() {
  const { status, endpoints, browserControllers, browserProfiles, remote } = useStack();
  const controllers = [...(browserControllers.data ?? [])].sort((a, b) => a.botId.localeCompare(b.botId, undefined, { numeric: true }) || a.session.localeCompare(b.session));
  const profiles = new Map((browserProfiles.data ?? []).map((profile) => [profile.id, profile]));
  const unavailable = browseLocalReason(remote) ?? (!endpoints.browse ? "Browse isn't served by this server" : null);
  return (
    <Window id="browse-controllers" title="Controllers" icon={CableIcon} accent="browse" count={browserControllers.data ? controllers.length : null}
      status={endpoints.browse ? status.browse : undefined} endpoint={endpoints.browse} updatedAt={browserControllers.at} error={browserControllers.error}
      empty={!controllers.length}>
      {unavailable ? <Empty icon={CableIcon} title={unavailable} />
        : !browserControllers.data ? <Empty icon={CableIcon} title="Reading controllers…" />
        : !controllers.length ? <Empty icon={CableIcon} title="No controllers yet" />
        : (
          <>
            <p className="px-0.5 text-[0.66rem] text-muted-foreground">Last observations, not liveness. Bots choose their own profiles.</p>
            <ul className="flex flex-col gap-0.5">
              {controllers.map((controller) => {
                const key = controllerKey(controller);
                const node = { kind: "browser-controller" as const, id: key };
                const mismatch = controller.actualProfileId !== null && controller.actualProfileId !== controller.profileId;
                return (
                  <li key={key} data-node={`browser-controller:${key}`} className="relative">
                    <Flash id={`browser-controller:${key}`} />
                    <NodeCard node={node} label={`${controller.botId} ${controller.session}`} variant="row">
                      <div className="flex items-center gap-2">
                        <StatusDot tone={controllerTone[controller.state]} label={controller.state} />
                        <NodeTitle node={node} label={`controller ${controller.botId} ${controller.session}`} className="min-w-0 truncate font-mono text-[0.74rem]">{controller.botId} · {controller.session}</NodeTitle>
                        <span className={cn("ml-auto shrink-0 text-[0.66rem]", controller.state === "unknown" ? "text-warning" : "text-muted-foreground")}>{controller.state}</span>
                      </div>
                      <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.66rem] text-muted-foreground">
                        <span>selected <NodeLink node={{ kind: "browser-profile", id: controller.profileId }} label="selected profile" className="text-foreground">{profileName(profiles.get(controller.profileId), controller.profileId)}</NodeLink></span>
                        {mismatch ? <span className="text-warning">actual <NodeLink node={{ kind: "browser-profile", id: controller.actualProfileId! }} label="actual profile">{profileName(profiles.get(controller.actualProfileId!), controller.actualProfileId!)}</NodeLink></span> : null}
                        {controller.observedAt ? <span className="ml-auto">observed <Time at={Date.parse(controller.observedAt)} /></span> : null}
                      </p>
                      <p className="flex gap-2 font-mono text-[0.62rem] text-muted-foreground/80">
                        <span title={controller.instance}>launch {shortId(controller.instance)}</span>
                        {controller.targetId ? <span title={controller.targetId}>tab {shortId(controller.targetId)}</span> : null}
                      </p>
                      {controller.error ? <p className="text-[0.68rem] break-words text-destructive">{controller.error}</p> : null}
                    </NodeCard>
                  </li>
                );
              })}
            </ul>
          </>
        )}
    </Window>
  );
}

function PendingLabel({ since, children }: { since: number | null; children: React.ReactNode }) {
  return since !== null ? <><Spinner data-icon="inline-start" /><Elapsed since={since} /></> : <>{children}</>;
}

function HypemanRow({ item, locked, blocked }: { item: HypemanInstallation; locked: string | null; blocked: string | null }) {
  const enable = useBrowseWrite("hypeman_enable");
  const uninstall = useBrowseWrite("hypeman_uninstall");
  const [confirming, setConfirming] = useState(false);
  const [discard, setDiscard] = useState(false);
  const change = locked && !item.selected ? locked : null;
  return (
    <li className="flex flex-col gap-1 rounded-lg border px-2 py-1.5">
      <div className="flex items-center gap-2">
        <StatusDot tone={item.selected ? (item.running ? "success" : "warning") : item.installed ? "muted" : "muted"} label={item.selected ? "Selected" : "Not selected"} />
        <span className="min-w-0 truncate font-mono text-[0.72rem]" title={item.root}>{item.root}</span>
        <span className={cn(badge, "ml-auto")}>{item.source}</span>
      </div>
      <p className="flex flex-wrap gap-x-2 text-[0.66rem] text-muted-foreground">
        <span>{item.installed ? "installed" : "not installed"}</span>
        <span>{item.running ? "running" : "not running"}</span>
        {item.selected ? <span className="font-medium text-foreground">selected</span> : null}
      </p>
      {item.issue ? <p className="text-[0.68rem] break-words text-warning">{item.issue}</p> : null}
      <WriteError error={enable.error ?? uninstall.error} />
      <div className="flex flex-wrap items-center gap-1">
        {item.selected ? (
          <Button type="button" size="xs" variant="outline" disabled={Boolean(blocked ?? locked) || enable.pending} title={blocked ?? locked ?? "Stop using this Hypeman for browser profiles"}
            onClick={() => void enable.run({ root: null })}><PendingLabel since={enable.since}>Deselect</PendingLabel></Button>
        ) : item.installed ? (
          <Button type="button" size="xs" variant="outline" disabled={Boolean(blocked ?? change) || enable.pending} title={blocked ?? change ?? "Use this Hypeman for browser profiles"}
            onClick={() => void enable.run({ root: item.root })}><PendingLabel since={enable.since}>Select</PendingLabel></Button>
        ) : null}
        {item.source === "stack" && item.installed ? (
          <Button type="button" size="xs" variant="ghost" className="ml-auto text-muted-foreground" disabled={Boolean(blocked) || item.selected || uninstall.pending}
            title={item.selected ? "Deselect it first" : blocked ?? "Uninstall Stack's Hypeman"} onClick={() => setConfirming(true)}>Uninstall…</Button>
        ) : null}
      </div>
      <AlertDialog open={confirming} onOpenChange={(next) => { if (!uninstall.pending) { setConfirming(next); setDiscard(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall Stack&apos;s Hypeman?</AlertDialogTitle>
            <AlertDialogDescription>Only a stopped, deselected installation with no browser reservations is removed. Other Hypeman installations are never touched.</AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Switch size="sm" className="mt-0.5" checked={discard} disabled={uninstall.pending} onCheckedChange={setDiscard} />
            <span>Also discard its images and state<span className="block text-xs text-muted-foreground">Cannot be undone.</span></span>
          </label>
          <WriteError error={uninstall.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uninstall.pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={uninstall.pending} onClick={() => void uninstall.run({ discardData: discard }).then((result) => { if (result) setConfirming(false); })}>
              <PendingLabel since={uninstall.since}>Uninstall</PendingLabel>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/**
 * The managed agent-browser toolchain and the local Hypeman that runs profile browsers. Detection
 * never selects a host; the selected host can't change while profiles exist.
 */
export function ToolchainWindow() {
  const store = useStore();
  const { status, endpoints, browserToolchain, remote } = useStack();
  const blocked = useBrowseBlocked();
  const check = useBrowseWrite("agent_browser_check_updates");
  const accept = useBrowseWrite("agent_browser_update_accept");
  const install = useBrowseWrite("agent_browser_install");
  const policy = useBrowseWrite("agent_browser_update_policy_set");
  const uninstall = useBrowseWrite("agent_browser_uninstall");
  const hypemanInstall = useBrowseWrite("hypeman_install");
  const locate = useBrowseWrite("hypeman_location_set");
  const formId = useId();
  const [version, setVersion] = useState("");
  const [root, setRoot] = useState("");
  const [removing, setRemoving] = useState(false);
  const data = browserToolchain.data;
  const unavailable = browseLocalReason(remote) ?? (!endpoints.browse ? "Browse isn't served by this server" : null);
  const tool = data?.agentBrowser;
  const busy = check.pending || accept.pending || install.pending || uninstall.pending;
  const selected = data?.hypeman.find((item) => item.selected) ?? null;
  const locked = data && selected && (data.status.profiles || data.status.sessions) ? "Delete every profile before changing Hypeman" : null;
  return (
    <Window id="browse-toolchain" title="Toolchain" icon={WrenchIcon} accent="browse" status={endpoints.browse ? status.browse : undefined} endpoint={endpoints.browse}
      updatedAt={browserToolchain.at} error={browserToolchain.error} empty={!data}
      actions={endpoints.browse && !remote ? (
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Detect again" title="Detect again" disabled={status.browse !== "open"} onClick={store.refreshBrowse}><RefreshCwIcon /></Button>
      ) : null}>
      {unavailable ? <Empty icon={WrenchIcon} title={unavailable} /> : !data || !tool ? <Empty icon={WrenchIcon} title="Reading toolchain…" /> : (
        <>
          <dl className="flex flex-col">
            <Row label="Provider"><span className="font-mono text-[0.74rem]">{data.status.provider} · {data.status.mode}</span></Row>
            <Row label="Profiles">{data.status.profiles}</Row>
            {data.status.sessions ? <Row label="Legacy reservations" hint="Disposable browsers from before durable profiles. Inspect or reconcile them on the server socket.">{data.status.sessions}</Row> : null}
          </dl>
          <Section title="agent-browser" aside={<span className="text-[0.65rem] text-muted-foreground">Bots drive pages with it</span>}>
            <dl className="flex flex-col">
              <Row label="Installed" mono copy={tool.location}>{tool.installed ? tool.version ?? "unknown version" : <span className="text-warning">not installed</span>}</Row>
              <Row label="Latest" mono>{tool.latest ?? "not checked"}</Row>
              <Row label="Checked">{tool.checkedAt ? <Time at={Date.parse(tool.checkedAt)} /> : "never"}</Row>
            </dl>
            {tool.checkError ? <p className="text-[0.68rem] break-words text-warning">Last check failed: {tool.checkError}</p> : null}
            {tool.pending ? (
              <div className="flex items-center gap-2 rounded-lg border border-pkg-browse/40 bg-pkg-browse/5 px-2 py-1.5 text-[0.74rem]">
                <span className="min-w-0 flex-1">Update available: <span className="font-mono">{tool.pending}</span></span>
                <Button type="button" size="xs" disabled={Boolean(blocked) || busy} onClick={() => void accept.run({ version: tool.pending })}><PendingLabel since={accept.since}>Install {tool.pending}</PendingLabel></Button>
              </div>
            ) : null}
            <label htmlFor={`${formId}-policy`} className="flex items-center gap-2 text-[0.74rem]">
              <Switch id={`${formId}-policy`} size="sm" checked={tool.policy === "automatic"} disabled={Boolean(blocked) || policy.pending}
                onCheckedChange={(on) => void policy.run({ policy: on ? "automatic" : "manual" })} />
              Install new releases automatically
              <span className="text-[0.66rem] text-muted-foreground">(checked periodically)</span>
            </label>
            <div className="flex flex-wrap items-center gap-1">
              <Button type="button" size="xs" variant="outline" disabled={Boolean(blocked) || busy} title="Ask npm for the latest release" onClick={() => void check.run()}>
                <PendingLabel since={check.since}>Check now</PendingLabel>
              </Button>
              <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); if (version.trim()) void install.run({ version: version.trim() }).then((result) => { if (result) setVersion(""); }); }}>
                <label htmlFor={`${formId}-version`} className="sr-only">Version to install</label>
                <Input id={`${formId}-version`} value={version} placeholder="0.38.1" spellCheck={false} autoComplete="off" disabled={Boolean(blocked) || busy}
                  onChange={(event) => setVersion(event.target.value)} className="h-6 w-20 font-mono text-[0.72rem]" />
                <Button type="submit" size="xs" variant="outline" disabled={Boolean(blocked) || busy || !version.trim()}><PendingLabel since={install.since}>Install</PendingLabel></Button>
              </form>
              {tool.installed ? <Button type="button" size="xs" variant="ghost" className="ml-auto text-muted-foreground" disabled={Boolean(blocked) || busy} onClick={() => setRemoving(true)}>Uninstall…</Button> : null}
            </div>
            <WriteError error={check.error ?? accept.error ?? install.error ?? policy.error} />
            {data.detected.length ? (
              <ul className="flex flex-col gap-0.5">
                {data.detected.map((item) => (
                  <li key={item.location} className="group/row flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">
                    <span className={badge}>{item.source}</span>
                    <span className="min-w-0 truncate font-mono" title={item.location}>{item.location}</span>
                    <span className="ml-auto shrink-0 font-mono">{item.version ?? "?"}</span>
                    <CopyButton value={item.location} label="location" />
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
          <Section title="Hypeman" aside={<span className="text-[0.65rem] text-muted-foreground">Runs each profile&apos;s browser VM</span>}>
            {!selected ? <p className="text-[0.7rem] text-warning">No Hypeman selected. Profiles can&apos;t start until one is.</p> : null}
            {data.hypeman.length ? <ul className="flex flex-col gap-1.5">{data.hypeman.map((item) => <HypemanRow key={item.root} item={item} locked={locked} blocked={blocked} />)}</ul>
              : <p className="text-[0.7rem] text-muted-foreground">No local Hypeman found.</p>}
            <WriteError error={hypemanInstall.error ?? locate.error} />
            <div className="flex flex-wrap items-center gap-1">
              {data.hypeman.some((item) => item.source === "stack" && item.installed) ? null : (
                <Button type="button" size="xs" variant="outline" disabled={Boolean(blocked) || hypemanInstall.pending} title="Install the checksum-verified release in Stack state; it is not selected"
                  onClick={() => void hypemanInstall.run()}><PendingLabel since={hypemanInstall.since}>Install Hypeman</PendingLabel></Button>
              )}
              <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(event) => { event.preventDefault(); if (root.trim()) void locate.run({ root: root.trim() }).then((result) => { if (result) setRoot(""); }); }}>
                <label htmlFor={`${formId}-root`} className="sr-only">Hypeman installation directory</label>
                <Input id={`${formId}-root`} value={root} placeholder="/absolute/hypeman/root" spellCheck={false} autoComplete="off" disabled={Boolean(blocked) || locate.pending}
                  onChange={(event) => setRoot(event.target.value)} className="h-6 min-w-0 flex-1 font-mono text-[0.72rem]" />
                <Button type="submit" size="xs" variant="ghost" disabled={Boolean(blocked) || locate.pending || !root.trim()} title="Remember this directory for detection; it is not selected">
                  <FolderSearchIcon data-icon="inline-start" />Add
                </Button>
              </form>
            </div>
            <BrowseVolumes />
          </Section>
          <AlertDialog open={removing} onOpenChange={(next) => { if (!uninstall.pending) setRemoving(next); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Uninstall managed agent-browser?</AlertDialogTitle>
                <AlertDialogDescription>Bots lose page control until it is installed again. A global or AgentStart-owned agent-browser is not removed.</AlertDialogDescription>
              </AlertDialogHeader>
              <WriteError error={uninstall.error} />
              <AlertDialogFooter>
                <AlertDialogCancel disabled={uninstall.pending}>Cancel</AlertDialogCancel>
                <Button variant="destructive" disabled={uninstall.pending} onClick={() => void uninstall.run().then((result) => { if (result) setRemoving(false); })}>
                  <PendingLabel since={uninstall.since}>Uninstall</PendingLabel>
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </Window>
  );
}
