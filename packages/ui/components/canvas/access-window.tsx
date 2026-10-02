"use client";

import { useId, useState } from "react";
import { ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { canSponsor, enrollScope, grantScopeOptions, scopeAvailable } from "@/lib/stack/access";
import type { AccessSnapshot } from "@/lib/stack/types";
import { useNow, useOperation, useStack } from "./provider";
import { Empty, NodeCard, NodeTitle, Row } from "./primitives";
import { Section, Window } from "./window";
import { AccessHistory } from "./access-maintenance";

const permissions = [
  { id: "brain:share", label: "Share to Brain" },
  { id: "brain:status", label: "Read share status" },
  { id: "content:read", label: "Read Content" },
  { id: "ui:view", label: "View remote UI" },
  { id: "ui:control", label: "Control remote UI" },
  { id: "access:enroll", label: "Enroll other devices (cannot delegate this permission)" },
] as const;
const date = (at: number) => new Date(at).toLocaleString();
const scopeLabel = (id: string) => permissions.find((permission) => permission.id === id)?.label ?? id;
const kindLabel = (kind: string | undefined) => kind ? `${kind} clients` : "unknown clients";
/** A stored scope the server ignores for this client kind is shown as such, never hidden. */
const grantScopeLabel = (kind: string | undefined, scope: string) =>
  scopeAvailable(kind, scope) ? scopeLabel(scope) : `${scopeLabel(scope)} (no effect for ${kindLabel(kind)})`;
type Grant = AccessSnapshot["grants"][number];
/** A grant whose credentials the server would accept as an enrollment sponsor. */
const sponsors = (grant: Grant, kind: string | undefined) => canSponsor(kind) && grant.scopes.includes(enrollScope);
const enrollmentNote = "Pending enrollments it sponsored are blocked; devices it already enrolled keep their own access and must be revoked separately.";

/** A scope unavailable to `kind` can be turned off but never on. */
function ScopeFields({ kind, value, options, onChange, disabled }: { kind: string | undefined; value: string[]; options: readonly string[]; onChange(value: string[]): void; disabled: boolean }) {
  const id = useId();
  return <FieldSet disabled={disabled}>
    <FieldLegend variant="label">Permissions</FieldLegend>
    <FieldGroup className="gap-2">
      {options.map((scope) => {
        const checked = value.includes(scope), locked = !checked && !scopeAvailable(kind, scope);
        return <Field key={scope} orientation="horizontal" data-disabled={disabled || locked}>
          <Switch id={`${id}-${scope}`} size="sm" disabled={disabled || locked} checked={checked}
            onCheckedChange={(next) => onChange(next ? [...value, scope] : value.filter((item) => item !== scope))} />
          <FieldLabel htmlFor={`${id}-${scope}`} title={scope}>{scopeAvailable(kind, scope) ? scopeLabel(scope)
            : `${scopeLabel(scope)} (${checked ? "no effect" : "unavailable"} for ${kindLabel(kind)})`}</FieldLabel>
        </Field>;
      })}
    </FieldGroup>
  </FieldSet>;
}

function OperationError({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null;
}

function RevokeButton({ kind, id, label, disabled, revoked, note }: { kind: "client" | "grant" | "credential"; id: string; label: string; disabled: boolean; revoked: number | null; note?: string }) {
  const [open, setOpen] = useState(false);
  const operation = useOperation("access", "access_revoke");
  const effect = kind === "client" ? "All of this client's grants and credentials will stop authorizing requests."
    : kind === "grant" ? "Credentials and browser sessions using this grant will stop authorizing requests."
    : "This credential and its dependent tokens and browser sessions will stop authorizing requests.";
  return <AlertDialog open={open} onOpenChange={(next) => { if (!operation.pending) setOpen(next); }}>
    <AlertDialogTrigger render={<Button size="xs" variant="outline" />} disabled={disabled || revoked !== null}
      aria-label={`Revoke ${kind} ${label}`}>{revoked !== null ? "Revoked" : "Revoke…"}</AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Revoke {kind}?</AlertDialogTitle>
        <AlertDialogDescription>{label}. {effect}{note ? ` ${note}` : ""} This cannot be undone.</AlertDialogDescription>
      </AlertDialogHeader>
      <code className="break-all text-xs">{id}</code>
      <OperationError error={operation.error} />
      <AlertDialogFooter>
        <AlertDialogCancel disabled={operation.pending}>Cancel</AlertDialogCancel>
        <Button variant="destructive" disabled={disabled || revoked !== null || operation.pending}
          onClick={() => void operation.run({ kind, id }).then(() => setOpen(false)).catch(() => {})}>
          {operation.pending ? "Revoking…" : `Revoke ${kind}`}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

function PairingCard({ pairing, disabled }: { pairing: AccessSnapshot["pairings"][number]; disabled: boolean }) {
  const [scopes, setScopes] = useState(() => pairing.scopes.filter((scope) => scopeAvailable(pairing.kind, scope)));
  const [outcome, setOutcome] = useState<string | null>(null);
  const operation = useOperation("access", "pairing_decide");
  const busy = disabled || operation.pending || outcome !== null;
  const decide = (approve: boolean) => void operation.run({ id: pairing.id, code: pairing.code, approve, scopes: approve ? scopes : [] })
    .then(() => setOutcome(approve ? "Approved; waiting for the device to redeem." : "Denied.")).catch(() => {});
  const node = { kind: "access-pairing", id: pairing.id } as const;
  return <NodeCard node={node} label={pairing.label} className="flex flex-col gap-3">
    <div><NodeTitle node={node} label={`pairing ${pairing.label}`}>{pairing.label}</NodeTitle><span className="ml-2 text-xs text-muted-foreground">{pairing.kind}</span></div>
    <p className="text-xs text-muted-foreground">Compare this full code with the code on your device before approving this manual pairing.</p>
    <code className="select-all break-all text-base font-semibold tracking-wide">{pairing.code}</code>
    <p className="text-xs text-muted-foreground">Expires {date(pairing.expires)}</p>
    <ScopeFields kind={pairing.kind} options={pairing.scopes} value={scopes} onChange={setScopes} disabled={busy} />
    <OperationError error={operation.error} />
    {outcome ? <p role="status" className="text-xs">{outcome}</p> : <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || !scopes.length} onClick={() => decide(true)}>{operation.pending ? "Submitting…" : "Approve matching code"}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(false)}>Deny</Button>
    </div>}
  </NodeCard>;
}

function GrantPermissions({ grant, kind, disabled }: { grant: Grant; kind: string | undefined; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [scopes, setScopes] = useState(grant.scopes);
  const [saved, setSaved] = useState(false);
  const [operations, setOperations] = useState(grant.operations.join("\n"));
  const operation = useOperation("access", "grant_update");
  if (!editing) return <>
    <p className="text-xs">{grant.scopes.map((scope) => grantScopeLabel(kind, scope)).join(" · ") || "No device permissions"}</p>
    {grant.operations.length ? <p className="break-words text-xs">Operations: {grant.operations.join(", ")}</p> : null}
    {saved ? <p role="status" className="text-xs">Permissions saved.</p> : null}
    <Button size="xs" variant="outline" className="self-start" disabled={disabled}
      onClick={() => { setScopes(grant.scopes); setOperations(grant.operations.join("\n")); setEditing(true); }}>Edit permissions</Button>
  </>;
  return <>
    {grant.network === "tailnet" ? <ScopeFields kind={kind} options={grantScopeOptions(kind, permissions.map((permission) => permission.id), grant.scopes)} value={scopes} onChange={setScopes} disabled={disabled || operation.pending} />
      : <FieldGroup><Field data-invalid={!!operation.error}><FieldLabel htmlFor={`cloud-${grant.id}`}>Allowed package.operation names, one per line</FieldLabel>
        <Textarea id={`cloud-${grant.id}`} value={operations} onChange={event => setOperations(event.target.value)} disabled={disabled || operation.pending} aria-invalid={!!operation.error} /></Field></FieldGroup>}
    <p className="text-xs text-muted-foreground">Changes apply to this device without pairing again. Saving no permissions removes its scoped access.</p>
    {sponsors(grant, kind) ? <p className="text-xs text-muted-foreground">Saving changes this grant&apos;s revision, even with the same permissions, and invalidates outstanding enrollment approvals from its credentials.</p> : null}
    <OperationError error={operation.error} />
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled || operation.pending} onClick={() => void operation.run({ id: grant.id, expectedRevision: grant.revision, scopes, operations: operations.split(/\s+/).filter(Boolean) })
        .then(() => { setEditing(false); setSaved(true); }).catch(() => {})}>{operation.pending ? "Saving…" : "Save permissions"}</Button>
      <Button size="sm" variant="outline" disabled={operation.pending} onClick={() => setEditing(false)}>Cancel</Button>
    </div>
  </>;
}

export function AccessWindow() {
  const { access, status, endpoints, remote } = useStack();
  const now = useNow();
  const data = access.data;
  const pending = data?.pairings.filter((pairing) => pairing.state === "pending" && pairing.expires > now) ?? [];
  const disabled = status.access !== "open" || !!access.error;
  const clients = new Map(data?.clients.map((client) => [client.id, client]));
  const grants = new Map(data?.grants.map((grant) => [grant.id, grant]));
  const clientLabel = (id: string) => clients.get(id)?.label ?? `Unknown client (${id})`;
  return <Window id="access" title="Access" subtitle="access" icon={ShieldCheckIcon} accent="server"
    status={status.access} endpoint={endpoints.access} updatedAt={access.at} error={access.error}>
     {remote ? <p role="status" className="text-xs text-muted-foreground">Access administration (manual pairing approvals, grant edits, revocations and inventory) is available only on the trusted local UI. Remote browsers cannot change their own permissions here.</p> : null}
    {access.error ? <p role="alert" className="text-xs text-destructive">Access read failed: {access.error}{data ? " · showing last good read" : ""}</p> : null}
     {!data && !remote ? <Empty icon={ShieldCheckIcon} title={access.error || status.access === "closed" ? "Access unavailable" : "Loading access…"} /> : !data ? null : <>
      {status.access !== "open" ? <p role="status" className="text-xs text-muted-foreground">Access disconnected. Showing last read; controls are unavailable.</p> : null}
       <p className="text-xs text-muted-foreground">Device access across Stack: each client (phone, Chrome extension, desktop app or remote-UI browser) holds grants that decide what its credentials may do. A manual pairing shows a full approval code; compare it with the device before approving. Remote viewers cannot approve pairings or edit grants.</p>
      <p className="text-xs text-muted-foreground">QR enrollment APIs exist, but invitation, scanning and receipt-import controls are not yet available in this UI. Enrolled devices appear here as clients and grants.</p>
      <dl><Row label="Server identity" mono><span className="select-all break-all">{data.serverId}</span></Row></dl>
      <Section title="Manual pairing approvals" aside={<span className="text-xs text-muted-foreground">{pending.length}</span>}>
        {pending.length ? pending.map((pairing) => <PairingCard key={pairing.id} pairing={pairing} disabled={disabled} />)
          : <Empty icon={ShieldCheckIcon} title="No pending manual pairings" />}
      </Section>
      <Section title="Clients">
        {data.clients.length ? data.clients.map((client) => {
          const node = { kind: "access-client", id: client.id } as const;
          return <NodeCard key={client.id} node={node} label={client.label} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2"><NodeTitle node={node} label={`client ${client.label}`}>{client.label}</NodeTitle>
              <RevokeButton kind="client" id={client.id} label={client.label} disabled={disabled} revoked={client.revoked}
                note={data.grants.some((grant) => grant.client_id === client.id && sponsors(grant, client.kind)) ? enrollmentNote : undefined} /></div>
            <p className="text-xs text-muted-foreground">{client.kind} · Created {date(client.created)}</p>
            <p className="text-xs">{client.revoked !== null ? `Revoked ${date(client.revoked)}` : "Not revoked"}</p>
          </NodeCard>;
        }) : <Empty icon={ShieldCheckIcon} title="No paired clients" />}
      </Section>
      <Section title="Grants">
        {data.grants.length ? data.grants.map((grant) => {
          const node = { kind: "access-grant", id: grant.id } as const;
          const client = clients.get(grant.client_id);
          const blocked = !client || client.revoked !== null;
          const label = `${clientLabel(grant.client_id)} · ${grant.network === "tailnet" ? "Tailnet" : "Public cloud"}`;
          return <NodeCard key={grant.id} node={node} label={label} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2"><NodeTitle node={node} label={`grant ${label}`}>{label}</NodeTitle>
              <RevokeButton kind="grant" id={grant.id} label={label} disabled={disabled} revoked={grant.revoked}
                note={sponsors(grant, client?.kind) ? enrollmentNote : undefined} /></div>
            <p className="text-xs text-muted-foreground">{grant.revoked !== null ? `Revoked ${date(grant.revoked)}` : blocked ? "Client unavailable or revoked" : "Not revoked"}</p>
            <GrantPermissions key={`${grant.id}:${grant.revision}`} grant={grant} kind={client?.kind} disabled={disabled || blocked || grant.revoked !== null} />
            {grant.network === "public-cloud" ? <p className="text-xs text-muted-foreground">Foundation only. Public-cloud credentials and remote MCP admission are not implemented.</p> : null}
          </NodeCard>;
        }) : <Empty icon={ShieldCheckIcon} title="No grants" />}
      </Section>
       <Section title="Credentials">
        {data.credentials.length ? data.credentials.map((credential) => {
          const node = { kind: "access-credential", id: credential.id } as const;
          const client = clients.get(credential.client_id), grant = grants.get(credential.grant_id);
          const state = credential.revoked !== null ? `Revoked ${date(credential.revoked)}` : credential.expires <= now ? "Expired"
            : !client || client.revoked !== null ? "Blocked by client" : !grant || grant.revoked !== null ? "Blocked by grant" : "Not revoked; unexpired";
          const label = `${clientLabel(credential.client_id)} · generation ${credential.generation}`;
          return <NodeCard key={credential.id} node={node} label={label} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2"><NodeTitle node={node} label={`credential ${label}`}>{label}</NodeTitle>
              <RevokeButton kind="credential" id={credential.id} label={label} disabled={disabled} revoked={credential.revoked}
                note={grant && sponsors(grant, client?.kind) ? enrollmentNote : undefined} /></div>
            <p className="text-xs">{state}</p><p className="text-xs text-muted-foreground">Expires {date(credential.expires)}</p>
          </NodeCard>;
        }) : <Empty icon={ShieldCheckIcon} title="No credentials" />}
       </Section>
       <Section title="Remote UI sessions" aside={<span className="text-xs text-muted-foreground">{data.uiSessions.filter(session => session.expires > now).length} active</span>}>
         {data.uiSessions.length ? data.uiSessions.map((session, index) => {
           const credential = data.credentials.find(item => item.id === session.credential_id);
           return <p key={`${session.credential_id}:${session.expires}:${index}`} className="text-xs">
             {credential ? clientLabel(credential.client_id) : "Unknown browser"} · {session.expires > now ? "Active until" : "Expired"} {date(session.expires)}
           </p>;
         }) : <Empty icon={ShieldCheckIcon} title="No remote sessions" />}
       </Section>
       <AccessHistory />
       <Section title="Ingress"><dl>
        <Row label="Tailnet">{data.ingress ? `${data.ingress.host}:${data.ingress.port}` : "Not configured"}</Row>
         <Row label="Artifact port">{data.ingress?.artifactPort ?? "Not configured"}</Row>
         <Row label="Remote UI port">{data.ingress?.uiPort ?? "Not configured"}</Row>
        <Row label="Public cloud">Not implemented</Row>
      </dl></Section>
       <Section title="Recent audit" aside={<span className="text-xs text-muted-foreground">Latest 20</span>}>
         <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Audit retention (automatic only)</summary>
           <p className="mt-1 text-pretty">No manual audit prune is supported. Mutation cleanup keeps the latest 1,000 sequence rows before appending new audit entries, so observed rows can exceed 1,000.</p>
         </details>
        {data.audit.length ? <ol className="flex flex-col gap-2">{[...data.audit].sort((a, b) => b.seq - a.seq).slice(0, 20).map((event) =>
          <li key={event.seq} className="text-xs"><time dateTime={new Date(event.time).toISOString()}>{date(event.time)}</time> · {event.action}<br /><code className="break-all text-muted-foreground">{event.subject}</code></li>)}</ol>
          : <Empty icon={ShieldCheckIcon} title="No access activity" />}
      </Section>
    </>}
  </Window>;
}
