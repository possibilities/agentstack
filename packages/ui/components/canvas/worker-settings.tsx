"use client";

import { useCallback, useState } from "react";
import { RefreshCwIcon, Settings2Icon, ZapIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { workerApplyBlock, workerChoices, workerProviders, type WorkerProvider } from "@/lib/stack/settings";
import type { WorkerSession, WorkerStatus } from "@/lib/stack/types";
import { NodeLink, Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { SettingsEditor, useSettings } from "./settings-editor";

/** Worker settings writes are local-only under the current remote Access policy. */
function useWorkerWrites(): { canWrite: boolean; writeReason: string | null } {
  const { remote, status } = useStack();
  if (remote) return { canWrite: false, writeReason: "Worker settings are editable only on the local UI" };
  if (status.worker !== "open") return { canWrite: false, writeReason: "Worker is not connected" };
  return { canWrite: true, writeReason: null };
}

/** The account catalog native choices come from: cached reads, and a deliberate refresh. */
function AccountChoices({ accountId, label }: { accountId: string | null; label: string | null }) {
  const store = useStore();
  const { workerCatalogs, catalogPending } = useStack();
  const resource = accountId ? workerCatalogs[accountId] : undefined;
  const data = resource?.data ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-2.5 py-2 text-[0.72rem]">
      <span className="font-medium">Native choices</span>
      {!accountId ? <span className="text-muted-foreground">Choose a reference account to suggest models and efforts.</span> : (
        <>
          <NodeLink node={{ kind: "worker-catalog", id: accountId }} label={`${label ?? shortId(accountId)} models`} className="underline-offset-2 hover:underline">{label ?? shortId(accountId)} models</NodeLink>
          {data ? <span className="text-muted-foreground">{data.models.length} models · {data.source} · <Time at={Date.parse(data.observedAt)} />{data.stale ? " · stale" : ""}</span>
            : <span className="text-muted-foreground">{resource?.error ? "Unavailable" : "Not read yet"}</span>}
          {data?.error || resource?.error ? <span className="text-destructive">{data?.error ?? resource?.error}</span> : null}
          <Button size="xs" variant="ghost" className="ml-auto" disabled={catalogPending[accountId]} onClick={() => void store.refreshWorkerCatalog(accountId, true)}>
            {catalogPending[accountId] ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Refresh
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * One Worker's saved model and effort, what its current runtime was submitted, and what the native session
 * reports. Saving changes only the saved snapshot; Apply sends selector changes to the exact idle session, no prompt.
 */
export function WorkerSettingsTab({ worker, status }: { worker: WorkerSession; status: WorkerStatus | null }) {
  const store = useStore();
  const { workerAccounts, workerCatalogs } = useStack();
  const target = { kind: "worker" as const, id: worker.id };
  const { view, catalog } = useSettings(target, `worker:${worker.provider}`);
  const { canWrite, writeReason } = useWorkerWrites();
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const labels = workerAccountLabels(workerAccounts.data);
  const accountCatalog = workerCatalogs[worker.accountId]?.data ?? null;
  // Apply is gated on the scoped status read, never the list, since it must be fresh.
  const fresh = status?.worker.id === worker.id ? status.worker : null;
  const data = view?.data ?? null;
  const block = workerApplyBlock(fresh, data) ?? (canWrite ? null : writeReason);
  const pending = data?.fields.filter((field) => field.pending).length ?? 0;
  const onDirty = useCallback((value: boolean) => setDirty(value), []);

  async function apply() {
    if (!data || !fresh?.runtimeInstance || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await store.call<{ revision: number }>("worker", "worker_settings_apply", { id: worker.id, expectedRevision: data.saved.revision, expectedInstance: fresh.runtimeInstance });
      toast.success(`Revision ${result.revision} submitted to the idle session`);
    } catch (cause) {
      // Validation can refuse before selection; a partial selection needs recovery. Either way: re-read, never replay.
      setApplyError(`${cause instanceof Error ? cause.message : String(cause)}. The saved settings are kept; check the Worker's state before trying again.`);
    } finally { setApplying(false); }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3">
      <AccountChoices accountId={worker.accountId} label={labels.get(worker.accountId) ?? null} />
      <div className="flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-[0.72rem]">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-pretty text-muted-foreground">
            {pending ? `${pending} saved selection${pending === 1 ? "" : "s"} not yet submitted to this runtime.` : "Nothing saved is waiting for this runtime."} Apply submits saved revision {data?.saved.revision ?? "…"} without a prompt.{dirty ? " Unsaved edits are not included." : ""}
          </p>
          <Button size="xs" variant="secondary" disabled={Boolean(block) || applying} title={block ?? undefined} onClick={() => void apply()}>
            {applying ? <Spinner data-icon="inline-start" /> : <ZapIcon data-icon="inline-start" />}Apply saved settings
          </Button>
        </div>
        {block ? <p className="text-muted-foreground">{block}</p> : null}
        {applyError ? <Alert variant="destructive"><AlertDescription>{applyError}</AlertDescription></Alert> : null}
      </div>
      <SettingsEditor target={target} view={data} viewError={view?.error ?? null} catalog={catalog?.data ?? null}
        choices={(definition, values) => workerChoices(definition, accountCatalog, values, worker.model)}
        canWrite={canWrite} writeReason={writeReason} onDirtyChange={onDirty} />
    </div>
  );
}

/** Provider defaults copied into new Workers. A reference account only suggests choices; defaults are not account-scoped. */
function WorkerDefaults({ onDirtyChange }: { onDirtyChange(dirty: boolean): void }) {
  const { workerAccounts, workerCatalogs } = useStack();
  const [provider, setProvider] = useState<WorkerProvider>("codex");
  const [reference, setReference] = useState<Partial<Record<WorkerProvider, string>>>({});
  const [dirty, setDirty] = useState(false);
  const { canWrite, writeReason } = useWorkerWrites();
  const target = { kind: "worker-defaults" as const, provider };
  const { view, catalog } = useSettings(target, `worker:${provider}`);
  const labels = workerAccountLabels(workerAccounts.data);
  const accounts = (workerAccounts.data ?? []).filter((account) => account.provider === provider && account.enabled && account.ready && !account.removing);
  const accountId = reference[provider] ?? accounts[0]?.id ?? null;
  const onDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange(value); }, [onDirtyChange]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Provider" className="flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
          {workerProviders.map((option) => (
            <label key={option} title={dirty && option !== provider ? "Save or discard edits before switching provider" : undefined}
              className="relative cursor-pointer rounded-md px-2 py-0.5 text-[0.75rem] text-muted-foreground has-checked:bg-background has-checked:font-medium has-checked:text-foreground has-checked:shadow-xs has-disabled:cursor-not-allowed has-disabled:opacity-50 has-focus-visible:outline-2 has-focus-visible:outline-ring">
              <input type="radio" name="worker-defaults-provider" value={option} checked={provider === option} disabled={dirty && option !== provider}
                onChange={() => setProvider(option)} className="absolute inset-0 cursor-pointer appearance-none opacity-0" />
              {providerTitle(option)}
            </label>
          ))}
        </div>
        <NativeSelect size="sm" aria-label="Reference account" className="ml-auto min-w-0" value={accountId ?? ""}
          onChange={(event) => setReference({ ...reference, [provider]: event.target.value })}>
          {!accounts.length ? <NativeSelectOption value="">No ready {providerTitle(provider)} account</NativeSelectOption> : null}
          {accounts.map((account) => <NativeSelectOption key={account.id} value={account.id}>{labels.get(account.id) ?? shortId(account.id)}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <AccountChoices accountId={accountId} label={accountId ? labels.get(accountId) ?? null : null} />
      <SettingsEditor key={provider} target={target} view={view?.data ?? null} viewError={view?.error ?? null} catalog={catalog?.data ?? null}
        choices={(definition, values) => workerChoices(definition, accountId ? workerCatalogs[accountId]?.data ?? null : null, values, null)}
        canWrite={canWrite} writeReason={writeReason} onDirtyChange={onDirty} />
    </div>
  );
}

/** The Workers window's entry to provider defaults. Opening it writes nothing. */
export function WorkerDefaultsButton() {
  const { status } = useStack();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const close = () => { setOpen(false); setConfirming(false); setDirty(false); };
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Defaults for new Workers" disabled={status.worker !== "open"} onClick={() => setOpen(true)} />}>
          <Settings2Icon />
        </TooltipTrigger>
        <TooltipContent side="bottom">Defaults for new Workers</TooltipContent>
      </Tooltip>
      {open ? (
        <Dialog open onOpenChange={(next) => { if (!next) { if (dirty) setConfirming(true); else close(); } }}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Defaults for new Workers</DialogTitle>
              <DialogDescription>Copied into each new Worker of a provider. Existing Workers keep their own settings, and explicit launch choices take precedence.</DialogDescription>
            </DialogHeader>
            {confirming ? (
              <Alert>
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto">Discard unsaved settings edits?</span>
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>Keep editing</Button>
                  <Button size="xs" variant="destructive" onClick={close}>Discard and close</Button>
                </AlertDescription>
              </Alert>
            ) : null}
            <WorkerDefaults onDirtyChange={setDirty} />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
