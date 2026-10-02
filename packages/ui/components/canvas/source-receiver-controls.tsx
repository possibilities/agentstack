"use client";

import { useEffect, useRef, useState } from "react";
import { EyeIcon, EyeOffIcon, KeyRoundIcon, PowerIcon, PowerOffIcon, RotateCwIcon } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { editPatch, graceWords, maxReceiverLabel, rotateRequest, type GraceUnit, type RotateChoice } from "@/lib/stack/source-setup";
import { targetLabel } from "@/lib/stack/source";
import { localOperation } from "@/lib/stack/state";
import type { GithubEndpoint } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { CopyButton } from "./primitives";
import { useStack, useStore } from "./provider";
import { fieldLabel } from "./scrape-shared";
import { sourceHint, sourceLabel, Stamp, Word } from "./source-shared";

const revisionChanged = /github_endpoint_revision_changed/;
const busyMessage = "A hook request is running for this receiver. Try again when it has finished.";
const conflictMessage = "This receiver changed elsewhere since it was shown. It was read again; check it and make the change again.";
export const writeProblem = (error: unknown): string => {
  const text = errorMessage(error);
  return revisionChanged.test(text) ? conflictMessage : /github_endpoint_busy/.test(text) ? busyMessage : text;
};

/**
 * Local configuration only: label, public origin and enablement, each against the revision that was shown. Target and GitHub host are
 * fixed at creation. Nothing here changes GitHub: a hook there changes only through a reviewed plan.
 */
export function EditReceiver({ endpoint }: { endpoint: GithubEndpoint }) {
  const store = useStore();
  const state = useStack();
  const access = localOperation(state, "source", "github_endpoint_update");
  const [label, setLabel] = useState(endpoint.label);
  const [origin, setOrigin] = useState(endpoint.publicOrigin ?? "");
  const [busy, setBusy] = useState<"label" | "origin" | "enabled" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  // A value changed elsewhere replaces an untouched field; an edit in progress is kept.
  useEffect(() => { setLabel((held) => (held === "" || held === endpoint.label ? endpoint.label : held)); }, [endpoint.label, endpoint.revision]);
  useEffect(() => { setOrigin((held) => (held === "" || held === (endpoint.publicOrigin ?? "") ? endpoint.publicOrigin ?? "" : held)); }, [endpoint.publicOrigin, endpoint.revision]);
  const open = state.status.source === "open";
  const apply = async (kind: "label" | "origin" | "enabled", change: { label?: string; publicOrigin?: string; enabled?: boolean }) => {
    const built = editPatch(endpoint, change);
    if (!built.ok) { setProblem(built.error); return; }
    if (!built.patch) return;
    setBusy(kind); setProblem(null);
    try { await store.updateSourceReceiver(endpoint.id, endpoint.revision, built.patch); } catch (error) { setProblem(writeProblem(error)); } finally { setBusy(null); }
  };
  const disabled = !access.available || !open || busy !== null;
  const originChanged = origin.trim() !== (endpoint.publicOrigin ?? "");
  return (
    <section aria-label="Edit receiver" className="flex flex-col gap-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.72rem]">
        <dt className="text-muted-foreground">Target</dt><dd className="min-w-0 break-words font-mono text-[0.7rem]">{targetLabel(endpoint.target)}</dd>
        <dt className="text-muted-foreground">GitHub host</dt><dd className="font-mono text-[0.7rem]">{endpoint.githubHost}</dd>
      </dl>
      <p className={sourceHint}>The target and GitHub host are fixed when a receiver is created. To watch something else, create another receiver. Edits here save Stack&rsquo;s configuration only; they change nothing at GitHub.</p>
      <form className="flex flex-col gap-1" onSubmit={(event) => { event.preventDefault(); void apply("label", { label }); }}>
        <label className="flex flex-col gap-1"><span className={fieldLabel}>Label</span>
          <span className="flex items-center gap-1.5"><Input value={label} maxLength={maxReceiverLabel} onChange={(event) => setLabel(event.target.value)} autoComplete="off" className="h-7 text-[0.78rem]" />
            <Button type="submit" size="xs" variant="outline" disabled={disabled || !label.trim() || label.trim() === endpoint.label}>{busy === "label" ? <Spinner data-icon="inline-start" /> : null}Save label</Button></span></label>
      </form>
      <form className="flex flex-col gap-1" onSubmit={(event) => { event.preventDefault(); void apply("origin", { publicOrigin: origin }); }}>
        <label className="flex flex-col gap-1"><span className={fieldLabel}>Public origin</span>
          <span className="flex items-center gap-1.5"><Input value={origin} onChange={(event) => setOrigin(event.target.value)} autoComplete="off" spellCheck={false} placeholder="https://hooks.example.com" className="h-7 font-mono text-[0.74rem]" />
            <Button type="submit" size="xs" variant="outline" disabled={disabled || !originChanged}>{busy === "origin" ? <Spinner data-icon="inline-start" /> : null}Save origin</Button></span></label>
        <span className={sourceHint}>Only the HTTPS origin of the externally reachable listener; Stack adds the webhook path. Leave it empty for none. Entering an origin is not a reachability test{endpoint.managedHookId ? `, and hook #${endpoint.managedHookId} at GitHub keeps its current URL until you apply a new plan` : ""}.</span>
      </form>
      <div className="flex flex-col gap-1">
        <span className={sourceLabel}>Intake</span>
        <div className="flex flex-wrap items-center gap-2">
          <Word tone={endpoint.enabled ? "success" : "muted"} className="text-[0.74rem]">{endpoint.enabled ? "Enabled" : "Disabled"}</Word>
          {endpoint.enabled ? (
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => setDisabling(true)}><PowerOffIcon data-icon="inline-start" />Disable…</Button>
          ) : (
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => void apply("enabled", { enabled: true })}>{busy === "enabled" ? <Spinner data-icon="inline-start" /> : <PowerIcon data-icon="inline-start" />}Enable</Button>
          )}
        </div>
        <span className={sourceHint}>{endpoint.enabled ? "Signed requests are admitted." : "New requests are rejected. Delivery history and watches are kept."}</span>
      </div>
      {!access.available ? <p className={sourceHint}>{access.reason}</p> : null}
      {problem ? <p role="alert" className="text-[0.72rem] text-destructive">{problem}</p> : null}
      <AlertDialog open={disabling} onOpenChange={(next) => { if (!next && busy === null) setDisabling(false); }}>
        <AlertDialogContent size="sm" aria-label="Disable receiver">
          <AlertDialogHeader>
            <AlertDialogMedia><PowerOffIcon /></AlertDialogMedia>
            <AlertDialogTitle>Disable this receiver?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span><span className="font-medium text-foreground">{endpoint.label}</span> <code className="font-mono text-[0.68rem]">{targetLabel(endpoint.target)}</code></span>
              <span>New requests are rejected while it is disabled. GitHub does not redeliver on its own, so what is rejected is not kept.</span>
              <span>Delivery history, original payloads and watches are kept, and the hook at GitHub is not changed. Enabling it again accepts new requests only.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="group-data-[size=sm]/alert-dialog-content:grid-cols-1">
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void apply("enabled", { enabled: false }).then(() => setDisabling(false))}>
              {busy === "enabled" ? <Spinner data-icon="inline-start" /> : <PowerOffIcon data-icon="inline-start" />}Disable receiver
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

const autoHideMs = 120_000;

/**
 * The receiver's signing secret, shown only when asked for, only here, and only as long as it is needed. It lives in this component's state
 * alone: never in the store, the inspector, a URL, a list or a log. It is cleared when hidden, when this panel closes, when another receiver
 * is shown, when the connection drops, when the right to reveal is lost, when the secret is rotated, and after two minutes.
 */
export function SecretControls({ endpoint }: { endpoint: GithubEndpoint }) {
  const store = useStore();
  const state = useStack();
  const reveal = localOperation(state, "source", "github_endpoint_secret_reveal");
  const rotate = localOperation(state, "source", "github_endpoint_secret_rotate");
  const connected = state.status.source === "open";
  const [shown, setShown] = useState<{ secret: string; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const authority = reveal.available && connected;
  const live = useRef({ authority, id: endpoint.id, alive: true });
  live.current.authority = authority; live.current.id = endpoint.id;
  useEffect(() => { live.current.alive = true; return () => { live.current.alive = false; }; }, []);
  // Authority lost, or the secret was replaced (here or elsewhere): what is shown is no longer the current secret.
  useEffect(() => { if (shown && (!authority || shown.version !== endpoint.secretVersion)) setShown(null); }, [shown, authority, endpoint.secretVersion]);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), autoHideMs);
    return () => clearTimeout(timer);
  }, [shown]);
  const show = async () => {
    setBusy(true); setProblem(null); setNotice(null);
    const requested = endpoint.id;
    try {
      const value = await store.call<{ id: string; secretVersion: number; secret: string }>("source", "github_endpoint_secret_reveal", { id: requested, reveal: true });
      // An answer that lands after the receiver, the connection or the authority changed is dropped, not shown.
      if (live.current.alive && live.current.id === requested && live.current.authority) setShown({ secret: value.secret, version: value.secretVersion });
    } catch (error) { if (live.current.alive) setProblem(errorMessage(error)); } finally { if (live.current.alive) setBusy(false); }
  };
  return (
    <section aria-label="Receiver secret" className="flex flex-col gap-2">
      <p className={sourceHint}>Each receiver has its own random signing secret, version {endpoint.secretVersion}. Stack never lists it. Revealing it is a deliberate act, for installing it at GitHub by hand.</p>
      {endpoint.previousSecretExpiresAt ? <p className="text-[0.72rem] text-warning">The previous secret is also accepted until <Stamp at={endpoint.previousSecretExpiresAt} />. Update GitHub before then.</p> : null}
      {shown ? (
        <div role="group" aria-label="Revealed secret" className="flex flex-col gap-1.5 rounded-lg border border-warning/50 bg-warning/10 p-2.5">
          <span className="flex items-center gap-1.5"><code data-secret className="min-w-0 flex-1 break-all font-mono text-[0.72rem]" aria-label="Receiver secret value">{shown.secret}</code>
            <CopyButton value={shown.secret} label="secret" className="opacity-100" /></span>
          <span className={sourceHint}>Secret version {shown.version}. It is held only in this panel: not stored, not in the address or any list, and hidden when you close this, change receiver, lose the connection or the right to reveal it, rotate it, or after two minutes. Your clipboard keeps whatever you copy.</span>
          <div><Button size="xs" variant="outline" onClick={() => setShown(null)}><EyeOffIcon data-icon="inline-start" />Hide secret</Button></div>
        </div>
      ) : reveal.available ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={!connected || busy} onClick={() => void show()}>{busy ? <Spinner data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}Reveal secret</Button>
        </div>
      ) : <p className={sourceHint}>{reveal.reason}</p>}
      {rotate.available ? (
        <div className="flex flex-col gap-1">
          <div><Button size="xs" variant="outline" disabled={!connected || busy} onClick={() => setRotating(true)}><RotateCwIcon data-icon="inline-start" />Rotate secret…</Button></div>
          <span className={sourceHint}>Rotation replaces Stack&rsquo;s secret. It does not change GitHub.</span>
        </div>
      ) : null}
      {notice ? <p role="status" className="text-[0.72rem] text-warning">{notice}</p> : null}
      {problem ? <p role="alert" className="text-[0.72rem] text-destructive">{problem}</p> : null}
      {rotating ? <RotateSecret endpoint={endpoint} onClose={() => setRotating(false)} onRotated={(text) => { setShown(null); setNotice(text); setProblem(null); }} onProblem={(text) => { setShown(null); setProblem(text); }} /> : null}
    </section>
  );
}

function RotateSecret({ endpoint, onClose, onRotated, onProblem }: { endpoint: GithubEndpoint; onClose(): void; onRotated(text: string): void; onProblem(text: string): void }) {
  const store = useStore();
  const [choice, setChoice] = useState<RotateChoice>({ mode: "immediate" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = rotateRequest(choice);
  const automated = endpoint.githubHost.toLowerCase() === "github.com" && (endpoint.target.kind === "repository" || endpoint.target.kind === "organization");
  const send = async () => {
    if (!request.ok) return;
    setPending(true); setError(null);
    const before = endpoint.secretVersion;
    try {
      const next = await store.rotateSourceSecret(endpoint.id, endpoint.revision, request.graceSeconds);
      onRotated(`Rotated to secret version ${next.secretVersion}. ${request.graceSeconds ? `The old secret is also accepted for ${graceWords(request.graceSeconds)}. ` : "The old secret is no longer accepted. "}GitHub still has the old secret until you update it there.`);
      onClose();
    } catch (failure) {
      const text = errorMessage(failure);
      if (revisionChanged.test(text) || /github_endpoint_busy/.test(text)) { onProblem(writeProblem(failure)); onClose(); }
      else {
        // Rotation is not idempotent: an unclear answer is read back, never repeated.
        let readBack = "The receiver could not be read back, so it is not known whether the secret changed. Check its secret version before rotating again.";
        try {
          const now = await store.readSourceReceiver(endpoint.id);
          readBack = now.secretVersion > before ? `The receiver was read back: the secret is now version ${now.secretVersion}, so the rotation was applied. It was not repeated.`
            : `The receiver was read back: the secret is still version ${now.secretVersion}, so nothing was rotated.`;
        } catch { /* reported above */ }
        onProblem(`${text}. ${readBack}`); onClose();
      }
    } finally { setPending(false); }
  };
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent size="sm" aria-label="Rotate secret">
        <AlertDialogHeader>
          <AlertDialogMedia><KeyRoundIcon /></AlertDialogMedia>
          <AlertDialogTitle>Rotate this receiver&rsquo;s secret?</AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-2">
            <span><span className="font-medium text-foreground">{endpoint.label}</span> · secret version {endpoint.secretVersion} becomes {endpoint.secretVersion + 1}.</span>
            <span>GitHub keeps signing with the old secret until you update it there, so requests can be rejected in between. Rotating does not change GitHub; {automated ? "apply a new hook plan to transfer the new secret privately, or reveal it and install it by hand." : "reveal the new secret and install it at GitHub by hand."}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="flex flex-col gap-2 rounded-lg border p-2.5">
          <legend className={`${sourceLabel} px-1`}>The old secret</legend>
          <label className="flex items-start gap-1.5 text-[0.76rem]">
            <input type="radio" name="rotate-mode" checked={choice.mode === "immediate"} onChange={() => setChoice({ mode: "immediate" })} className="mt-0.5" />
            <span><span className="font-medium">Revoke immediately (default)</span><span className="block text-[0.7rem] text-muted-foreground">Requests signed with the old secret are rejected from now on.</span></span>
          </label>
          <label className="flex items-start gap-1.5 text-[0.76rem]">
            <input type="radio" name="rotate-mode" checked={choice.mode === "grace"} onChange={() => setChoice({ mode: "grace", amount: choice.mode === "grace" ? choice.amount : "30", unit: choice.mode === "grace" ? choice.unit : "minutes" })} className="mt-0.5" />
            <span className="flex min-w-0 flex-col gap-1"><span className="font-medium">Also accept it for a grace period</span>
              <span className="block text-[0.7rem] text-muted-foreground">Gives you time to update GitHub. At most 24 hours.</span>
              {choice.mode === "grace" ? (
                <span className="flex items-center gap-1.5">
                  <Input inputMode="numeric" aria-label="Grace period" value={choice.amount} onChange={(event) => setChoice({ ...choice, amount: event.target.value })} autoComplete="off" className="h-7 w-20 font-mono text-[0.74rem]" />
                  <NativeSelect size="sm" aria-label="Grace period unit" value={choice.unit} onChange={(event) => setChoice({ ...choice, unit: event.target.value as GraceUnit })}>
                    {(["seconds", "minutes", "hours"] as const).map((unit) => <NativeSelectOption key={unit} value={unit}>{unit}</NativeSelectOption>)}
                  </NativeSelect>
                </span>
              ) : null}
            </span>
          </label>
        </fieldset>
        <p role={request.ok ? undefined : "alert"} className={request.ok ? "text-[0.72rem] text-muted-foreground" : "text-[0.72rem] text-destructive"}>{request.ok ? request.words : request.error}</p>
        {error ? <p role="alert" className="text-[0.72rem] text-destructive">{error}</p> : null}
        <AlertDialogFooter className="group-data-[size=sm]/alert-dialog-content:grid-cols-1">
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending || !request.ok} onClick={() => void send()}>
            {pending ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}Rotate secret
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
