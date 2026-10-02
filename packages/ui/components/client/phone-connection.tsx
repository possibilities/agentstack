"use client";

import { useEffect, useState } from "react";
import type { ClientOutput } from "@stack/client/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ClientCallError, clientCall } from "@/lib/client/channel";
import { clearRemoteRequest, dispatchRemote, readRemoteRequest, remoteDestination, type RemoteRequest } from "@/lib/client/remote-request";
import { useClientObservation } from "@/lib/client/use-observation";
import { Facts, Hint, ObservationStatus, Panel, PanelBody, PanelTitle, StatusChip, useNow } from "./parts";
import { Expiry, FlowStep, ForgetControl, PermissionFields, useRemoteAction, type Scopes } from "./remote-parts";
import { ReceiptCamera } from "./receipt-camera";
import { ClientShell } from "./shell";

type EnrollmentRequest = Extract<RemoteRequest, { operation: "client_enrollment_begin" }>;
type Receipt = ClientOutput<"client_enrollment_accept">["receipt"];

function RequestQr({ qr }: { qr: ClientOutput<"client_qr_render"> }) {
  const side = qr.size + qr.quietZone * 2;
  const path = qr.rows.flatMap((row, y) => [...row].flatMap((module, x) => module === "1" ? [`M${x + qr.quietZone} ${y + qr.quietZone}h1v1h-1z`] : [])).join("");
  return <svg role="img" aria-label="Offline desktop request QR" data-quiet-zone={qr.quietZone} viewBox={`0 0 ${side} ${side}`} className="client-request-qr" shapeRendering="crispEdges">
    <rect width={side} height={side} fill="#fff" /><path d={path} fill="#000" />
  </svg>;
}

export function PhoneConnection({ scope, intent }: { scope: string; intent: string | null }) {
  const { observation, error, loading, refresh } = useClientObservation();
  const action = useRemoteAction(refresh), now = useNow(1000);
  const [label, setLabel] = useState(""), [scopes, setScopes] = useState<Scopes>(["ui:view"]);
  const [id, setId] = useState(intent), [saved, setSaved] = useState<EnrollmentRequest | null>(null), [storageReady, setStorageReady] = useState(false);
  const [request, setRequest] = useState<ClientOutput<"client_enrollment_begin"> | null>(null), [qr, setQr] = useState<ClientOutput<"client_qr_render"> | null>(null);
  const [text, setText] = useState(""), [preview, setPreview] = useState<Receipt | null>(null), [confirmed, setConfirmed] = useState(false), [accepted, setAccepted] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null), [inspected, setInspected] = useState(false), [forgotten, setForgotten] = useState(false);
  const pending = observation?.peers.pending.enrollments.find(row => row.id === id);
  useEffect(() => {
    try { if (intent) setSaved(readRemoteRequest(scope, "client_enrollment_begin", intent) as EnrollmentRequest | null); setStorageReady(true); }
    catch { action.setError("Recovery storage is unavailable or invalid. Dispatch is paused; preserve the saved request."); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, intent]);
  const frozen = pending ? { requestId: pending.id, label: pending.label, scopes: pending.scopes } : saved?.input ?? null;
  const expiresAt = request?.expiresAt ?? pending?.expiresAt;
  const expired = now !== null && expiresAt !== undefined && expiresAt <= now;
  const receiptExpired = now !== null && preview !== null && preview.expiresAt <= now;
  const disabled = !observation || !!error || action.busy || !storageReady || !!connectionId || forgotten;
  const begin = async (record: EnrollmentRequest) => {
    setSaved(record); setId(record.input.requestId); setInspected(false);
    history.replaceState(null, "", `/client/phone?intent=${record.input.requestId}`);
    await action.run(async () => {
      const output = await dispatchRemote(scope, record); setRequest(output);
      setQr(await clientCall("client_qr_render", { text: output.text }));
    });
  };
  const editReceipt = (value: string) => { setText(value); setPreview(null); setConfirmed(false); setAccepted(false); };
  const previewReceipt = async () => {
    if (!request || disabled || expired || !text) return;
    await action.run(async () => {
      const response = await fetch("/api/client/receipt", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt: text, request: request.text }) });
      const body = await response.json();
      if (!response.ok) throw new ClientCallError(body.error === "enrollment_expired_or_clock_skew" ? body.error : "enrollment_receipt_mismatch", false);
      setPreview(body.receipt); setConfirmed(false);
    });
  };
  return <ClientShell page="Connect through phone">
    <div className="client-intro"><h1 className="text-2xl font-semibold tracking-tight">Connect through phone</h1><p className="text-muted-foreground">Create an offline desktop request. An already paired phone explicitly approves it at its own pinned platform, then returns a credential-free receipt.</p>
      <ObservationStatus loading={loading} at={observation?.at ?? null} /></div>
    {error || action.error ? <Alert variant="destructive"><AlertTitle>Connection not confirmed</AlertTitle><AlertDescription>{action.error ?? error}</AlertDescription></Alert> : null}
    <Panel labelledBy="phone-title" className="client-panel-lead"><PanelBody>
      <PanelTitle id="phone-title" aside={<StatusChip tone={connectionId ? "success" : expired || receiptExpired ? "danger" : frozen ? "attention" : "neutral"}>{connectionId ? "Connection saved" : expired ? "Request expired" : receiptExpired ? "Receipt expired" : frozen ? "Saved request" : "Offline setup"}</StatusChip>}>A phone-mediated connection</PanelTitle>
      {connectionId ? <><p role="status">Connection saved with its own desktop credential. The phone&apos;s credential was never copied.</p><a className={buttonVariants()} href={`/client/connections/${connectionId}`}>View saved connection</a></>
        : forgotten ? <p role="status">Intent forgotten locally. Nothing was cancelled on the server. <a className="underline" href="/client/phone">Make a new explicit request</a>.</p>
        : <ol className="client-flow">
          <FlowStep number={1} title="Make an offline request" description="No platform, tailnet hints or remote address is needed." done={!!request}>
            {!frozen ? <><PermissionFields label={label} setLabel={setLabel} scopes={scopes} setScopes={setScopes} disabled={disabled} />
              <div><Button disabled={disabled || !label.trim()} onClick={() => {
                const input = { requestId: crypto.randomUUID(), label: label.trim(), scopes };
                void begin({ version: 1, operation: "client_enrollment_begin", destination: remoteDestination({ operation: "client_enrollment_begin", input }), input });
              }}>Make offline request</Button></div><Hint>{!label.trim() ? "Enter a connection label first." : disabled ? "Paused until the Client observation and recovery storage are available." : null}</Hint></>
              : <><Facts items={[["Label", frozen.label], ["Requested permissions", frozen.scopes.join(", ")], ["Client request ID", frozen.requestId, { mono: true, selectable: true }],
                ...(expiresAt !== undefined ? [["Request expiry", <Expiry key="expiry" at={expiresAt} now={now} />] as [string, React.ReactNode]] : [])]} />
                {!request ? <div className="client-tray" data-tone="attention"><p className="text-sm">The private intent stays on the Client host. Reload never dispatches it. Inspect, then deliberately recover the same request QR.</p>
                  <div className="flex flex-wrap gap-2"><Button variant={inspected ? "outline" : "default"} disabled={disabled} onClick={async () => { await refresh(); setInspected(true); }}>Inspect current records</Button>
                    <Button disabled={disabled || !inspected || expired} onClick={() => void begin({ version: 1, operation: "client_enrollment_begin", destination: remoteDestination({ operation: "client_enrollment_begin", input: frozen }), input: frozen })}>Show saved request QR</Button></div>
                  <Hint>{expired ? "Expired requests cannot be renewed. Forget this intent before making a new explicit request." : !inspected ? "Inspect first. The saved UUID, label and permissions stay unchanged." : null}</Hint>
                </div> : null}</>}
          </FlowStep>
          <FlowStep number={2} title="Approve on your phone" description="The phone needs access:enroll and every permission it approves. Scanning is not approval.">
            {request && qr && !expired ? <><div className="client-qr-layout"><RequestQr qr={qr} /><div className="flex min-w-0 flex-col gap-3">
              <Facts items={[["Full fingerprint", request.fingerprint, { mono: true, selectable: true }], ["Requested permissions", (frozen?.scopes ?? scopes).join(", ")], ["Expiry", <Expiry key="expiry" at={request.expiresAt} now={now} />]]} />
              <p className="text-sm text-muted-foreground">Compare the full fingerprint on the phone. This QR has no server address, redemption secret or private key. It is encoded locally, black on white with a four-module quiet zone.</p></div></div>
              <details className="client-disclosure"><summary>Selectable offline request text</summary><pre tabIndex={0} className="client-json">{request.text}</pre></details></>
              : expired ? <Alert><AlertTitle>Request expired</AlertTitle><AlertDescription>The QR is no longer usable. It is not refreshed or renewed automatically. Forget this local intent, then make a new explicit request.</AlertDescription></Alert>
              : request && !qr ? <><Hint>QR rendering was not confirmed. The saved offline request is unchanged; rendering does not renew it.</Hint>
                <div><Button variant="outline" disabled={disabled} onClick={() => void action.run(async () => setQr(await clientCall("client_qr_render", { text: request.text })))}>Render saved QR</Button></div></>
              : <Hint>Make or deliberately recover the saved request first.</Hint>}
          </FlowStep>
          <FlowStep number={3} title="Preview the returned receipt" description="Paste works everywhere. A QR string is never opened as a URL." done={!!preview}>
            <FieldGroup><Field data-disabled={disabled || !request || expired}><FieldLabel htmlFor="phone-receipt">Returned phone receipt</FieldLabel>
              <Textarea id="phone-receipt" maxLength={2048} autoComplete="off" autoCapitalize="none" spellCheck={false} value={text} disabled={disabled || !request || expired || accepted} onChange={event => editReceipt(event.target.value)} />
              <FieldDescription>Only a canonical receipt bound to this request is accepted. No phone credential is imported.</FieldDescription></Field></FieldGroup>
            <ReceiptCamera disabled={disabled || !request || expired || accepted} onText={editReceipt} />
            <div><Button variant={preview ? "outline" : "default"} disabled={disabled || !request || expired || !text || accepted} onClick={() => void previewReceipt()}>Preview receipt</Button></div>
            <Hint>{!request ? "Recover the request QR before previewing a receipt." : expired ? "This request expired; receipt import is paused." : !text ? "Paste or scan the credential-free receipt first." : accepted ? "The confirmed receipt is already saved; proceed to Connect." : null}</Hint>
            {pending?.hasReceipt && !accepted ? <Hint>A receipt is saved on the host, but pending metadata does not expose its destination. Paste it again to review; no destination is inferred and nothing redeems automatically.</Hint> : null}
          </FlowStep>
          <FlowStep number={4} title="Confirm the destination, then connect" description="Acceptance saves this exact receipt on the host. Redemption is a separate deliberate action." done={accepted}>
            {preview ? <><div className="client-plan" aria-label="Receipt destination preview"><h4 className="text-sm font-semibold">Receipt destination</h4>
              <Facts items={[["Installation ID", preview.serverId, { mono: true, selectable: true }], ["Device origin", preview.origin, { mono: true, selectable: true }], ["Approved permissions", preview.scopes.join(", ")],
                ["Request fingerprint", preview.requestHash, { mono: true, selectable: true }], ["Receipt expiry", <Expiry key="expiry" at={preview.expiresAt} now={now} />]]} /></div>
              {!accepted ? <><Field orientation="horizontal"><input id="confirm-receipt" type="checkbox" disabled={disabled || !!receiptExpired || expired} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
                <FieldLabel htmlFor="confirm-receipt">I confirm this installation ID, destination and approved permissions</FieldLabel></Field>
                <div><Button disabled={disabled || !confirmed || !!receiptExpired || expired} onClick={() => void action.run(async () => { await clientCall("client_enrollment_accept", { id: id!, receipt: text }); setAccepted(true); })}>Accept confirmed receipt</Button></div>
                <Hint>{receiptExpired ? "Receipt expired. It cannot be accepted; a new explicit request may be needed." : !confirmed ? "Confirm the returned destination first. Preview alone is not consent." : null}</Hint></>
                : <><p role="status" className="text-sm">The confirmed receipt is saved on the Client host.</p><div><Button disabled={disabled || expired || !!receiptExpired} onClick={() => void action.run(async () => { const result = await clientCall("client_enrollment_redeem", { id: id! }); setConnectionId(result.connectionId); })}>Connect to confirmed platform</Button></div>
                  <Hint>{expired || receiptExpired ? "Redemption is paused because the request or receipt expired." : "Connect redeems directly with this desktop's retained secret and signing key."}</Hint></>}</>
              : <Hint>Preview a valid returned receipt first; no platform is chosen by a scan alone.</Hint>}
          </FlowStep>
        </ol>}
      {pending && !connectionId && !forgotten ? <ForgetControl kind="intent" revision={pending.revision} disabled={disabled} onConfirm={async expectedRevision => {
        const result = await action.run(() => clientCall("client_intent_forget", { kind: "enrollment", id: pending.id, expectedRevision }));
        if (!result) return false;
        setForgotten(true); if (saved) { try { clearRemoteRequest(scope, saved); } catch { action.setError("The host forgot this intent, but browser storage could not be cleared. The old UUID stays abandoned and must not be replayed."); } } return true;
      }} /> : null}
      {intent && observation && !pending && !connectionId && !forgotten ? <div className="client-tray" data-tone="attention">
        <p className="text-sm">This intent is not listed. It may have completed or been forgotten. Inspect Connections first. The existing redeem operation can recover a retained completion with this exact intent ID; no new private intent is created.</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={disabled} onClick={async () => { await refresh(); setInspected(true); }}>Inspect completion records</Button>
          <Button disabled={disabled || !inspected} onClick={() => void action.run(async () => { const result = await clientCall("client_enrollment_redeem", { id: intent }); setConnectionId(result.connectionId); })}>Recover completed connection</Button></div>
        <Hint>{!inspected ? "Inspect first. Recovery uses only this saved intent ID and never makes another request." : null}</Hint>
      </div> : null}
    </PanelBody></Panel>
  </ClientShell>;
}
