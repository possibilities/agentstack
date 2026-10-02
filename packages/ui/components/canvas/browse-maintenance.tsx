"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { profileName, siteDataOrigins, volumeSelection, type SiteDataCategory } from "@/lib/stack/browse";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { BrowserProfile, BrowserVolume, BrowserVolumePage, StateReceipt } from "@/lib/stack/types";
import { useKeyedRead, usePagedRead } from "./owner-reads";
import { useNow, useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, StateReceiptView, useStateFlow } from "./state-flow";

const hint = "text-xs text-pretty text-muted-foreground";
export const browseMaintenanceOperations = {
  reset: { plan: "browser_profile_reset_plan", apply: "browser_profile_reset_clear", receipt: "browse_state_receipt_get" },
  site: { plan: "browser_site_data_plan", apply: "browser_site_data_clear", receipt: "browse_state_receipt_get" },
  handoff: { plan: "browser_handoff_history_plan", apply: "browser_handoff_history_clear", receipt: "browse_state_receipt_get" },
  volume: { plan: "browser_volume_plan", apply: "browser_volume_clear", receipt: "browse_state_receipt_get" },
};

export function ProfileMaintenanceDialog({ profile, kind, onClose }: { profile: BrowserProfile; kind: "reset" | "site"; onClose(): void }) {
  const state = useStack();
  const store = useStore();
  const id = useId();
  const [text, setText] = useState("");
  const [categories, setCategories] = useState<SiteDataCategory[]>([]);
  const origins = siteDataOrigins(text);
  const controls = useStateFlow({ operations: stateOperations(store.call, "browse", browseMaintenanceOperations[kind],
    kind === "reset" ? { profileId: profile.id } : { profileId: profile.id, origins: origins.origins, categories }),
    recoveryKey: `browse:${kind}:${profile.id}`, observe: state.browserProfiles.at, onReceipt: store.refreshBrowse });
  const locked = controls.flow.phase !== "idle";
  const busy = ["preparing", "applying", "checking"].includes(controls.flow.phase);
  const access = localOperations(state, "browse", Object.values(browseMaintenanceOperations[kind]));
  const unavailable = !access.available ? access.reason : state.status.browse !== "open" ? "The Browse connection is not open."
    : !profile.id ? "Choose an exact profile." : profile.maintenanceRequestId ? "Profile maintenance is fenced; inspect its receipt and native resources before release."
    : state.browserProfiles.error || state.browserControllers.error || state.browserHandoffs.error ? "Refresh Browse; a required inventory read failed."
    : kind === "site" && profile.state !== "ready" ? "The exact running profile CDP must be ready. Planning never starts or navigates a browser."
    : kind === "site" ? origins.error ?? (!categories.length ? "Select cookies, storage and/or cache explicitly." : null) : null;
  const title = kind === "reset" ? "Reset profile" : "Clear site data";
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{title} · {profileName(profile)}</DialogTitle>
        <DialogDescription>{kind === "reset" ? "Old sign-ins, tabs and all old volume data are lost. The profile ID, default and assignment stay; generation advances and a fresh exact provider volume/instance is explicitly created." : "Clear only the selected origins and categories in this exact running profile."}</DialogDescription>
      </DialogHeader>
      <p className={hint}>First stop and verify the assigned Bot, close all selected or uncertain controllers and resolve open handoffs. The owner plan checks these prerequisites and exact provider ownership again. Nothing here implicitly stops a Bot, closes a controller, starts or navigates a browser.</p>
      <p className={hint}>Profile <code className="break-all">{profile.id}</code> · generation {profile.generation}. Other profiles, independent native pages/clients, upstream copies and backups remain outside this scope.</p>
      {kind === "site" ? <>
        <FieldGroup>
          <Field data-invalid={!!text && !!origins.error}>
            <FieldLabel htmlFor={id}>Exact origins (one per line)</FieldLabel>
            <Textarea id={id} value={text} disabled={locked} spellCheck={false} autoComplete="off" placeholder="https://example.com" aria-invalid={!!text && !!origins.error}
              onChange={(event) => setText(event.target.value)} />
            {text && origins.error ? <FieldError>{origins.error}</FieldError> : null}
          </Field>
          <FieldSet disabled={locked}><FieldLegend variant="label">Site-data categories</FieldLegend>
            {(["cookies", "storage", "cache"] as const).map((category) => <label key={category} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={categories.includes(category)} onChange={(event) => setCategories((held) => event.target.checked ? [...held, category] : held.filter((value) => value !== category))} />{category}
            </label>)}
          </FieldSet>
        </FieldGroup>
        <p className={hint}>Storage: local storage, IndexedDB, WebSQL, file systems and service workers. Cache means origin CacheStorage, not the HTTP cache. History is unsupported here; whole-profile reset is the explicitly destructive alternative.</p>
        <p className={hint}>Domain cookies are shared across matching subdomains and ports; the plan binds observed domain/path/partition identities without cookie values. Unselected partitions and origins remain. Native writers may recreate data; absence/quota checks are not an atomic write lock or comprehensive local-storage byte verification.</p>
      </> : null}
      <StateFlowView controls={controls} label={`Prepare ${title.toLowerCase()}`} applyLabel={title} unavailable={unavailable} receiptOnlyRecovery />
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>Close dialog</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function BrowseMaintenanceFence({ profile }: { profile: BrowserProfile }) {
  const state = useStack();
  if (!profile.maintenanceRequestId || !localOperations(state, "browse", ["browse_state_receipt_get"]).available) return null;
  return <ProfileFence profile={profile} requestId={profile.maintenanceRequestId} />;
}

function ProfileFence({ profile, requestId }: { profile: BrowserProfile; requestId: string }) {
  const state = useStack();
  const store = useStore();
  const now = useNow(15_000);
  const receipt = useKeyedRead(() => store.call<{ receipt: StateReceipt | null }>("browse", "browse_state_receipt_get", { requestId }).then((value) => value.receipt), `${profile.id}:${requestId}`, state.browserProfiles.at ?? 0);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = localOperations(state, "browse", ["browse_state_receipt_get", "browse_state_fence_release"]);
  const inspected = receipt.data?.subject?.id === profile.id && ["partial", "unknown", "completed"].includes(receipt.data.status);
  const disabled = pending || receipt.loading || !!receipt.error || !inspected || state.status.browse !== "open";
  const release = async () => {
    setPending(true); setError(null);
    try {
      await store.call("browse", "browse_state_fence_release", { profileId: profile.id, requestId, expectedGeneration: profile.generation });
      toast.success("Profile fence released; the receipt is unchanged"); setConfirming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); store.refreshBrowse(); }
  };
  return <section aria-label={`Maintenance fence ${profileName(profile)}`} className="flex min-w-0 flex-col gap-2 rounded-lg border border-warning/50 p-2">
    <p className="text-xs font-medium">Profile maintenance remains fenced · generation {profile.generation}</p>
    <code className="break-all text-xs">Request {requestId}</code>
    {receipt.error ? <p role="alert" className="text-xs text-destructive">Receipt unavailable: {receipt.error}</p> : null}
    {receipt.data ? <><StateReceiptView receipt={receipt.data} now={now} />
      <ul aria-label="Exact remaining or uncertain resources" className="flex flex-col gap-1 text-xs">
        {receipt.data.outcomes.filter((row) => row.outcome !== "removed").map((row, index) => <li key={`${index}:${row.resource}`} className="break-all"><code>{row.resource}</code> · {row.outcome}{row.detail ? ` · ${row.detail}` : ""}</li>)}
      </ul></> : <p className={hint}>{receipt.loading ? "Reading exact receipt…" : "No receipt available; release is unavailable."}</p>}
    <p className={hint}>Inspect the receipt and exact remaining provider IDs above, and verify native resources separately. Unknown absence is not proof that nothing remains. Release only acknowledges inspection; it never completes or reruns maintenance, stops/starts a Bot, closes a controller, or starts/navigates a browser. The receipt stays unchanged; later supervision may recover the retained profile.</p>
    <Button size="xs" variant="outline" disabled={receipt.loading || state.status.browse !== "open"} onClick={receipt.refresh}>Read fence receipt</Button>
    {access.available ? <Button size="xs" variant="outline" disabled={disabled} onClick={() => { setError(null); setConfirming(true); }}>Release fence…</Button> : null}
    {state.status.browse !== "open" ? <p className={hint}>The Browse connection is not open.</p> : null}
    <Dialog open={confirming} onOpenChange={(open) => { if (!pending) setConfirming(open); }}>
      <DialogContent><DialogHeader><DialogTitle>Release profile fence?</DialogTitle><DialogDescription>Confirm you inspected request {requestId}, its receipt and exact native resources. This only acknowledges inspection for generation {profile.generation}; partial and unknown results stay that way.</DialogDescription></DialogHeader>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter><Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>Cancel</Button><Button disabled={disabled || !access.available} onClick={() => void release()}>Release fence</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}

export function BrowseVolumes() {
  const state = useStack();
  if (!localOperations(state, "browse", ["browser_volume_list", ...Object.values(browseMaintenanceOperations.volume)]).available) return null;
  return <Volumes />;
}

function Volumes() {
  const state = useStack();
  const store = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const pages = usePagedRead<BrowserVolume>(async (offset, revision) => {
    const page = await store.call<BrowserVolumePage>("browse", "browser_volume_list", { offset, limit: 100, ...(revision ? { revision } : {}) });
    return { items: page.volumes, revision: page.revision, nextOffset: page.nextOffset };
  }, "browse:volumes", state.browserToolchain.at ?? 0);
  const rows = pages.page?.items ?? [];
  const controls = useStateFlow({ operations: stateOperations(store.call, "browse", browseMaintenanceOperations.volume, { volumeIds: selected }),
    recoveryKey: "browse:volume:ids", observe: state.browserToolchain.at,
    onReceipt: (receipt) => { pages.refresh(); if (receipt.status === "completed") setSelected([]); } });
  const locked = controls.flow.phase !== "idle";
  const unavailable = state.status.browse !== "open" ? "The Browse connection is not open." : pages.error || pages.loading ? "Refresh the volume inventory before preparing."
    : !volumeSelection(rows, selected) ? "Select up to 100 exact unreferenced, unmounted owned volumes; review changed selections." : null;
  return <MaintenanceDisclosure title="Volumes" aside="Maintenance · bytes unmeasured" active={locked}>
    <p className={hint}>Only verified Stack names and role/session/lease tags are listed; foreign volumes are excluded. Every Backend receipt (including incomplete/disposable leases) and every provider mount blocks collection. No implicit session closure or VM launch. Bytes are unmeasured, not zero; backups remain independent.</p>
    <Button size="xs" variant="ghost" disabled={pages.loading || locked || state.status.browse !== "open"} onClick={pages.refresh}>Refresh volumes</Button>
    {pages.error ? <p role="alert" className="text-xs text-destructive">Volume inventory unavailable: {pages.error}</p> : null}
    {pages.page?.restarted ? <p className={hint}>The inventory changed while paging; showing the first page again.</p> : null}
    <ul aria-label="Owned browser volumes" className="flex max-h-64 flex-col gap-2 overflow-auto">
      {rows.map((row) => <li key={row.id} className="flex min-w-0 flex-col gap-1 text-xs">
        <label className="flex items-start gap-1.5"><input type="checkbox" aria-label={`Select volume ${row.id}`} checked={selected.includes(row.id)}
          disabled={locked || row.blockedBy.length > 0 || (!selected.includes(row.id) && selected.length >= 100)}
          onChange={() => setSelected((held) => held.includes(row.id) ? held.filter((id) => id !== row.id) : [...held, row.id])} /><span className="break-all"><code>{row.id}</code>{row.name ? ` · ${row.name}` : ""}</span></label>
        <span className="break-all pl-5 text-muted-foreground">{row.tags?.["dev.stack.role"]} · session {row.tags?.["dev.stack.session"]} · lease {row.tags?.["dev.stack.lease"]}</span>
        {row.blockedBy.map((reason) => <p key={reason} className={hint}>{reason}</p>)}
      </li>)}
    </ul>
    {!rows.length && !pages.error ? <p className={hint}>{pages.page ? "No verified owned volumes." : "Reading volumes…"}</p> : null}
    {pages.page?.nextOffset != null ? <Button size="xs" variant="ghost" disabled={pages.loading || locked || state.status.browse !== "open"} onClick={pages.more}>Load more volumes</Button> : null}
    <StateFlowView controls={controls} label={`Prepare collecting ${selected.length} volumes`} applyLabel="Collect these volumes" unavailable={unavailable} receiptOnlyRecovery />
  </MaintenanceDisclosure>;
}
