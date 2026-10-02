"use client";

import { useRef, useState, type ReactNode } from "react";
import type { ClientInput, ClientOutput } from "@stack/client/contract";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { remoteError } from "@/lib/client/remote-errors";
import { Facts, Hint, StatusChip } from "./parts";

export type Descriptor = ClientOutput<"client_connection_inspect">;
export type Scopes = ClientInput<"client_pair_begin">["scopes"];

export function useRemoteAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { return await action(); }
    catch (error) { setError(remoteError(error)); }
    finally { await refresh(); lock.current = false; setBusy(false); }
  };
  return { busy, error, setError, run };
}

export function DescriptorFacts({ connection }: { connection: Descriptor }) {
  return <Facts items={[["Installation ID", connection.serverId, { mono: true, selectable: true }], ["Device origin", connection.deviceOrigin, { mono: true, selectable: true }],
    ["Documents origin", connection.documentOrigin, { mono: true, selectable: true }], ["Artifacts origin", connection.artifactOrigin, { mono: true, selectable: true }],
    ["Platform UI origin", connection.uiOrigin ?? "Not advertised", { mono: !!connection.uiOrigin, selectable: !!connection.uiOrigin }]]} />;
}

export function PermissionFields({ label, setLabel, scopes, setScopes, disabled }: {
  label: string; setLabel: (value: string) => void; scopes: Scopes; setScopes: (value: Scopes) => void; disabled: boolean;
}) {
  return <FieldGroup>
    <Field data-disabled={disabled}><FieldLabel htmlFor="connection-label">Connection label</FieldLabel>
      <Input id="connection-label" autoComplete="off" maxLength={80} value={label} onChange={event => setLabel(event.target.value)} disabled={disabled} />
    </Field>
    <FieldSet disabled={disabled}>
      <FieldLegend>Permissions to request</FieldLegend>
      <p className="text-sm">View platform · <code>ui:view</code> (required)</p>
      {([ ["ui:control", "Control platform"], ["content:read", "Read Content"] ] as const).map(([scope, title]) =>
        <Field key={scope} orientation="horizontal" data-disabled={disabled}>
          <input id={scope} type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter(item => item !== scope))} />
          <FieldLabel htmlFor={scope}>{title} · <code>{scope}</code></FieldLabel>
        </Field>)}
      <FieldDescription>These permissions never grant Access administration, sign-in, voice, Proc, Role shims or headful browser control.</FieldDescription>
    </FieldSet>
  </FieldGroup>;
}

export function Expiry({ at, now }: { at: number; now: number | null }) {
  const expired = now !== null && at <= now;
  return <span className="flex flex-wrap items-center gap-2"><time dateTime={new Date(at).toISOString()} className="tabular-nums"><textarea readOnly rows={1} aria-label="Exact expiry" className="client-selectable" value={new Date(at).toLocaleString()} /></time>
    <StatusChip tone={expired ? "danger" : "neutral"}>{expired ? "Expired" : now === null ? "Expiry recorded" : `Expires in ${Math.max(1, Math.ceil((at - now) / 60_000))} min`}</StatusChip></span>;
}

export function FlowStep({ number, title, description, done, children }: { number: number; title: string; description: string; done?: boolean; children: ReactNode }) {
  return <li data-done={done ? "true" : undefined}><span aria-hidden className="client-flow-number">{number}</span>
    <div className="client-flow-body"><div className="client-flow-head"><div><h3 className="font-medium">{title}</h3><p className="text-sm text-muted-foreground">{description}</p></div></div>{children}</div></li>;
}

/** Freeze the revision on review; a conflict rereads but never silently retries. */
export function ForgetControl({ kind, revision, disabled, onConfirm }: { kind: "connection" | "intent"; revision: number; disabled: boolean; onConfirm: (revision: number) => Promise<boolean> }) {
  const [reviewed, setReviewed] = useState<number | null>(null);
  const text = kind === "connection" ? "This removes only the saved connection and its native credential from this Client. It does not revoke Access, securely erase retained bytes, or guarantee sign-out of an already opened viewer."
    : "This abandons only this Client's pending intent and private material. It does not cancel server approval or revoke a credential already issued by Access. This request UUID cannot be reused for a new intent.";
  return <div className="flex flex-col gap-2">
    {reviewed === null ? <Button variant="outline" disabled={disabled} onClick={() => setReviewed(revision)}>Forget {kind === "connection" ? "connection" : "pending intent"}…</Button>
      : <div className="client-plan" role="group" aria-label="Confirm local removal">
        <h3 className="text-sm font-semibold">Forget locally?</h3><p className="text-sm">{text}</p>
        <Facts items={[["Reviewed revision", reviewed]]} />
        <div className="flex flex-wrap gap-2"><Button autoFocus variant="destructive" disabled={disabled} onClick={async () => { await onConfirm(reviewed); setReviewed(null); }}>Confirm local removal</Button>
          <Button variant="outline" disabled={disabled} onClick={() => setReviewed(null)}>Keep {kind}</Button></div>
      </div>}
    <Hint>{reviewed === null ? "Forget is local removal, not Access revocation or guaranteed viewer sign-out." : null}</Hint>
  </div>;
}
