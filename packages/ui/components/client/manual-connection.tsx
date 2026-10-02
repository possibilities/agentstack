"use client";

import { useEffect, useState } from "react";
import type { ClientInput, ClientOutput } from "@stack/client/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { clientCall } from "@/lib/client/channel";
import { clearRemoteRequest, dispatchRemote, readRemoteRequest, remoteDestination, type RemoteRequest } from "@/lib/client/remote-request";
import { useClientObservation } from "@/lib/client/use-observation";
import { Facts, Hint, ObservationStatus, Panel, PanelBody, PanelTitle, StatusChip, useNow } from "./parts";
import { DescriptorFacts, Expiry, FlowStep, ForgetControl, PermissionFields, useRemoteAction, type Descriptor, type Scopes } from "./remote-parts";
import { ClientShell } from "./shell";

type PairRequest = Extract<RemoteRequest, { operation: "client_pair_begin" }>;
function exactOrigin(value: string) {
  try {
    const url = new URL(value), host = url.hostname;
    return value.length <= 300 && url.protocol === "https:" && url.origin === value && !url.username && !url.password
      && host !== "localhost" && !host.endsWith(".localhost") && !host.startsWith("127.") && !["0.0.0.0", "[::]", "[::1]"].includes(host);
  } catch { return false; }
}

export function ManualConnection({ scope, intent }: { scope: string; intent: string | null }) {
  const { observation, error, loading, refresh } = useClientObservation();
  const action = useRemoteAction(refresh), now = useNow(1000);
  const [origin, setOrigin] = useState(""), [label, setLabel] = useState(""), [scopes, setScopes] = useState<Scopes>(["ui:view"]);
  const [connection, setConnection] = useState<Descriptor | null>(null), [confirmed, setConfirmed] = useState(false);
  const [id, setId] = useState(intent), [saved, setSaved] = useState<PairRequest | null>(null), [storageReady, setStorageReady] = useState(false);
  const [receipt, setReceipt] = useState<ClientOutput<"client_pair_begin">["receipt"] | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null), [inspected, setInspected] = useState(false), [forgotten, setForgotten] = useState(false);
  const [peers, setPeers] = useState<ClientOutput<"client_tailnet_peers"> | null>(null);
  const pending = observation?.peers.pending.pairings.find(row => row.id === id);
  useEffect(() => {
    try { if (intent) setSaved(readRemoteRequest(scope, "client_pair_begin", intent) as PairRequest | null); setStorageReady(true); }
    catch { action.setError("Recovery storage is unavailable or invalid. Dispatch is paused; preserve this browser's saved request."); }
  // Read only once for this route; host metadata is authoritative on later observations.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, intent]);
  const frozen: ClientInput<"client_pair_begin"> | null = pending ? { requestId: pending.id, label: pending.label, scopes: pending.scopes, connection: pending.connection } : saved?.input ?? null;
  const descriptor = frozen?.connection ?? connection;
  const approval = pending?.receipt ?? receipt;
  const expired = approval && now !== null && approval.expiresAt <= now;
  const disabled = !observation || !!error || action.busy || !storageReady || forgotten || !!connectionId;
  const admission = async (record: PairRequest) => {
    setSaved(record); setId(record.input.requestId); setInspected(false);
    history.replaceState(null, "", `/client/manual?intent=${record.input.requestId}`);
    const result = await action.run(() => dispatchRemote(scope, record));
    if (result) { setReceipt(result.receipt); if (result.connectionId) setConnectionId(result.connectionId); }
  };
  const inspect = async () => { await refresh(); setInspected(true); };
  const begin = async () => {
    if (disabled || frozen || !connection || !confirmed || !label.trim()) return;
    const input = { requestId: crypto.randomUUID(), label: label.trim(), connection, scopes };
    await admission({ version: 1, operation: "client_pair_begin", destination: remoteDestination({ operation: "client_pair_begin", input }), input });
  };
  const redeem = async () => {
    if (disabled || !id || !approval || expired) return;
    const result = await action.run(() => clientCall("client_pair_redeem", { id }));
    if (result) setConnectionId(result.connectionId);
  };
  return <ClientShell page="Connect manually">
    <div className="client-intro"><h1 className="text-2xl font-semibold tracking-tight">Connect manually</h1>
      <p className="text-muted-foreground">Inspect the exact device origin, confirm its destinations, then ask trusted-local Access on that platform to approve this desktop.</p>
      <ObservationStatus loading={loading} at={observation?.at ?? null} /></div>
    {error || action.error ? <Alert variant="destructive"><AlertTitle>{action.error ? action.errorTitle : "Observation interrupted"}</AlertTitle><AlertDescription>{action.error ?? error}</AlertDescription></Alert> : null}
    <Panel labelledBy="manual-title" className="client-panel-lead"><PanelBody>
      <PanelTitle id="manual-title" aside={<StatusChip tone={connectionId ? "success" : expired ? "danger" : frozen ? "attention" : "neutral"}>{connectionId ? "Connection saved" : expired ? "Approval expired" : frozen ? "Saved pairing" : "Not connected"}</StatusChip>}>A deliberate connection</PanelTitle>
      {connectionId ? <><p role="status">Connection saved. It is not a live viewer session; choose Open on its detail page.</p>
        <a className={buttonVariants()} href={`/client/connections/${connectionId}`}>View saved connection</a></>
        : forgotten ? <p role="status">Pending intent forgotten locally. Access approval was not cancelled. <a className="underline" href="/client/manual">Begin a new deliberate pairing</a>.</p>
        : <ol className="client-flow">
          <FlowStep number={1} title="Inspect the device origin" description="No scheme guessing, path, redirects or peer probing." done={!!descriptor}>
            {!frozen ? <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (disabled || !exactOrigin(origin)) return;
              setConfirmed(false); void action.run(async () => { const result = await clientCall("client_connection_inspect", { origin }); setConnection(result); }); }}>
              <FieldGroup><Field data-invalid={!!origin && !exactOrigin(origin)} data-disabled={disabled}><FieldLabel htmlFor="device-origin">Exact HTTPS device origin</FieldLabel>
                <Input id="device-origin" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://machine.example:8943" value={origin}
                  disabled={disabled} aria-invalid={!!origin && !exactOrigin(origin)} onChange={event => { setOrigin(event.target.value); setConnection(null); setConfirmed(false); }} />
                <FieldDescription>Use the complete HTTPS origin exactly as configured, without a trailing slash or path.</FieldDescription></Field></FieldGroup>
              <div><Button type="submit" variant={descriptor ? "outline" : "default"} disabled={disabled || !exactOrigin(origin)}>Inspect origin</Button></div>
              <Hint>{disabled ? "Paused while the Client observation, recovery storage or current action is unavailable." : !exactOrigin(origin) ? "Enter an exact non-loopback HTTPS origin before inspection." : null}</Hint>
            </form> : <Facts items={[["Saved origin", frozen.connection.deviceOrigin, { mono: true, selectable: true }]]} />}
          </FlowStep>
          <FlowStep number={2} title="Confirm this installation and every origin" description="This identity stays pinned. A changed server is a new connection decision." done={confirmed || !!frozen}>
            {descriptor ? <><DescriptorFacts connection={descriptor} />
              {!frozen ? <Field orientation="horizontal"><input id="confirm-destination" type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />
                <FieldLabel htmlFor="confirm-destination">I confirm this installation ID and every destination origin above</FieldLabel></Field> : <Hint>Confirmed when this exact pairing request was saved. Retrying cannot change its destination or permissions.</Hint>}</>
              : <Hint>Inspect the origin first; confirmation is not inferred from reachability.</Hint>}
          </FlowStep>
          <FlowStep number={3} title="Request approval" description="Select only the UI permissions this desktop needs." done={!!approval}>
            {frozen ? <Facts items={[["Label", frozen.label], ["Requested permissions", frozen.scopes.join(", ")], ["Request ID", frozen.requestId, { mono: true, selectable: true }]]} />
              : <><PermissionFields label={label} setLabel={setLabel} scopes={scopes} setScopes={setScopes} disabled={disabled} />
                <div><Button disabled={disabled || !confirmed || !label.trim() || !connection?.pairing.includes("manual")} onClick={() => void begin()}>Request approval</Button></div>
                <Hint>{!confirmed ? "Confirm the installation and all origins first." : !label.trim() ? "Enter a connection label first." : !connection?.pairing.includes("manual") ? "This descriptor does not advertise manual pairing." : null}</Hint></>}
            {frozen && !approval ? <div className="client-tray" data-tone="attention"><p className="text-sm">Admission unresolved. Inspect current records before an identical retry. Reload never sends this request.</p>
              <div className="flex flex-wrap gap-2"><Button variant={inspected ? "outline" : "default"} disabled={disabled} onClick={() => void inspect()}>Inspect current records</Button>
                <Button disabled={disabled || !inspected} onClick={() => void admission({ version: 1, operation: "client_pair_begin", destination: remoteDestination({ operation: "client_pair_begin", input: frozen }), input: frozen })}>Retry saved pairing request</Button></div>
              <Hint>{!inspected ? "Inspect first; retry uses the saved UUID and exact input." : null}</Hint></div> : null}
          </FlowStep>
          <FlowStep number={4} title="Approve there, connect here" description="Approval happens in trusted-local Access on the target server. This Client never polls approval." done={!!connectionId}>
            {approval ? <><p className="text-sm">Compare the complete approval code there:</p><input readOnly className="client-approval-code" aria-label="Complete approval code" value={approval.code} />
              <Facts items={[["Approval expiry", <Expiry key="expiry" at={approval.expiresAt} now={now} />]]} />
              <div><Button disabled={disabled || !!expired} onClick={() => void redeem()}>Approved? Connect</Button></div>
              <Hint>{expired ? "Approval expired. Forget this intent, then make a new explicit request; nothing renews automatically." : disabled ? "Paused while the current Client action or observation is unavailable." : "Click only after approval on the target platform. A saved code is not consent."}</Hint></>
              : <Hint>Available once Access returns the approval code.</Hint>}
          </FlowStep>
        </ol>}
      {pending && !connectionId && !forgotten ? <ForgetControl kind="intent" revision={pending.revision} disabled={disabled} onConfirm={async expectedRevision => {
        const result = await action.run(() => clientCall("client_intent_forget", { kind: "pairing", id: pending.id, expectedRevision }));
        if (!result) return false;
        setForgotten(true); if (saved) { try { clearRemoteRequest(scope, saved); } catch { action.setError("The host forgot this intent, but browser recovery storage could not be cleared. The old UUID remains abandoned; it must not be replayed."); } }
        return true;
      }} /> : null}
      {intent && observation && !pending && !saved && !connectionId ? <Hint>This intent is not listed. It may have completed or been forgotten. Inspect Connections; no request is recreated from a missing record.</Hint> : null}
    </PanelBody></Panel>
    {!frozen && !connectionId ? <Panel labelledBy="peers-title"><PanelBody><PanelTitle id="peers-title" description="Optional local Tailscale status hints. Peers are not verified Stack servers or grants.">Tailnet peers</PanelTitle>
      <div><Button variant="outline" disabled={disabled} onClick={() => void action.run(async () => setPeers(await clientCall("client_tailnet_peers", {})))}>Show peer hints</Button></div>
      {peers ? <>{!peers.available ? <Hint>Peer hints unavailable. Manual origin and phone receipt still work independently.</Hint> : null}
        {peers.truncated ? <Hint>Showing only the first 200 peers; this list is truncated.</Hint> : null}
        <ul className="client-rows">{peers.peers.map((peer, index) => <li key={`${peer.id}:${index}`}><div className="client-list-row"><div className="flex min-w-0 flex-col gap-1"><p className="font-medium break-all">{peer.name || peer.id || "Unnamed peer"}</p>
          <p className="text-xs text-muted-foreground break-all">{peer.addresses.join(", ")}</p><StatusChip tone="neutral">{peer.online ? "Peer online" : "Peer offline"}</StatusChip></div>
          <div className="flex flex-col gap-1"><Button variant="outline" size="sm" disabled={disabled || !peer.name} onClick={() => { const name = peer.name.replace(/\.$/, ""); setOrigin(`https://${name}`); setConnection(null); setConfirmed(false); }}>Use peer hostname</Button>
            <Hint>{!peer.name ? "No hostname advertised; enter an origin manually." : null}</Hint></div></div></li>)}</ul>
        <Hint>Choosing a peer only fills the origin. Add the configured port if needed, then inspect and confirm; nothing scans or pairs automatically.</Hint></> : <Hint>No peer status is read until you choose Show peer hints.</Hint>}
    </PanelBody></Panel> : null}
  </ClientShell>;
}
