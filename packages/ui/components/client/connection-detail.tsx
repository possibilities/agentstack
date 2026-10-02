"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { clientCall } from "@/lib/client/channel";
import { preparePlatformNavigation } from "@/lib/client/navigation";
import { clearRemoteRequest, connectionDestination, dispatchRemote, readRemoteRequest, retainRemoteRequest, type RemoteRequest } from "@/lib/client/remote-request";
import { useClientObservation } from "@/lib/client/use-observation";
import { Facts, Hint, ObservationStatus, Panel, PanelBody, PanelTitle, StatusChip, useNow } from "./parts";
import { DescriptorFacts, Expiry, ForgetControl, useRemoteAction } from "./remote-parts";
import { ClientShell } from "./shell";

type OpenRequest = Extract<RemoteRequest, { operation: "client_connection_open" }>;

export function ConnectionDetail({ scope, id }: { scope: string; id: string }) {
  const { observation, error, loading, refresh } = useClientObservation();
  const action = useRemoteAction(refresh), now = useNow(1000);
  const connection = observation?.peers.connections.find(row => row.id === id);
  const destination = connection ? connectionDestination(connection.connection) : null;
  const pointer = destination ? `stack.client.${scope}.open.v1.${encodeURIComponent(destination)}.${id}` : null;
  const [saved, setSaved] = useState<OpenRequest | null>(null), [loadedPointer, setLoadedPointer] = useState<string | null>(null);
  const [inspected, setInspected] = useState(false), [opened, setOpened] = useState(false), [forgotten, setForgotten] = useState(false);
  useEffect(() => {
    if (!pointer || !destination) return;
    try {
      const requestId = localStorage.getItem(pointer);
      const record = requestId ? readRemoteRequest(scope, "client_connection_open", requestId) as OpenRequest | null : null;
      if (requestId && (!record || record.input.id !== id || record.destination !== destination)) throw new Error();
      setSaved(record); setLoadedPointer(pointer);
    } catch { action.setError("Recovery storage is unavailable or invalid. Open is paused; preserve the saved request before continuing."); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, pointer, destination, id]);
  const pending = connection?.pendingOpen;
  const disabled = !connection || !!error || action.busy || loadedPointer !== pointer || forgotten;
  const paused = !!pending || !!saved;
  const clearSaved = (record: OpenRequest | null) => {
    if (!pointer) throw new Error();
    const current = localStorage.getItem(pointer);
    if (current !== null && current !== record?.input.requestId) throw new Error();
    if (record) clearRemoteRequest(scope, record);
    localStorage.removeItem(pointer);
    if (localStorage.getItem(pointer) !== null) throw new Error();
    setSaved(null); setInspected(false);
  };
  const open = async () => {
    if (disabled || !connection?.connection.uiOrigin || !destination || !pointer || paused && !inspected) return;
    let navigation: ReturnType<typeof preparePlatformNavigation> | undefined;
    let navigated = false;
    await action.run(async () => {
      navigation = preparePlatformNavigation();
      const record: OpenRequest = { version: 1, operation: "client_connection_open", destination, input: { id, requestId: pending ?? saved?.input.requestId ?? crypto.randomUUID() } };
      setSaved(record); setInspected(false);
      try {
        // Journal first, then its exact-current pointer, then dispatch. Either
        // storage failure blocks even a recovery call with a host-listed UUID.
        retainRemoteRequest(scope, record);
        localStorage.setItem(pointer, record.input.requestId);
        if (localStorage.getItem(pointer) !== record.input.requestId) throw new Error();
      } catch { navigation.close(); throw new Error("Could not persist the exact Open request. Nothing was dispatched. Open stays paused until recovery storage works."); }
      try {
        const output = await dispatchRemote(scope, record);
        if (output.serverId !== connection.connection.serverId) throw new Error("Returned server identity differs from the selected installation. Navigation refused.");
        if (output.expiresAt <= Date.now()) throw new Error("The returned handoff expired before navigation. Inspect, then choose a new deliberate Open if no pendingOpen remains.");
        navigation.openPlatform({ url: output.url, expectedOrigin: connection.connection.uiOrigin!, serverId: output.serverId });
        navigated = true;
        setOpened(true);
        // Only non-secret recovery input is removed; the capability is never kept.
        try { clearSaved(record); }
        catch { throw new Error("Handoff navigation was requested, but recovery storage could not be cleared. Inspect the saved UUID before a new Open; no URL was retained."); }
      } catch (error) { if (!navigated) navigation.close(); throw error; }
    });
  };
  return <ClientShell page="Saved connection">
    <div className="client-intro"><h1 className="text-2xl font-semibold tracking-tight">{connection?.label ?? "Saved connection"}</h1>
      <p className="text-muted-foreground">A retained remote destination, independent of the local installation and other saved connections.</p><ObservationStatus loading={loading} at={observation?.at ?? null} /></div>
    {error || action.error ? <Alert variant="destructive"><AlertTitle>Action not confirmed</AlertTitle><AlertDescription>{action.error ?? error}</AlertDescription></Alert> : null}
    {forgotten ? <Panel labelledBy="forgotten-title"><PanelBody><PanelTitle id="forgotten-title">Connection forgotten locally</PanelTitle>
      <p role="status">Access was not revoked and already opened viewers were not guaranteed to sign out.</p><a className={buttonVariants({ variant: "outline" })} href="/client">Back to Connections</a></PanelBody></Panel>
      : connection ? <>
        <Panel labelledBy="connection-title" className="client-machine"><PanelBody>
          <PanelTitle id="connection-title" aside={<StatusChip tone={pending ? "attention" : "neutral"}>{pending ? "Open unresolved" : "Saved — not a live connection"}</StatusChip>}>Selected platform</PanelTitle>
          <DescriptorFacts connection={connection.connection} />
          <Facts items={[["Connection ID", connection.id, { mono: true }], ["Record revision", connection.revision], ["Access client ID", connection.clientId, { mono: true }],
            ["Credential ID", connection.credentialId, { mono: true }], ["Native credential expiry", <Expiry key="expiry" at={connection.expiresAt} now={now} />]]} />
          <p className="text-sm text-muted-foreground">Live Access governs permissions. Saved metadata does not expose current grant scopes or prove that the grant is active. View-only and trusted-local restrictions remain enforced on the target platform.</p>
          {opened ? <p role="status" className="text-sm">Handoff navigation requested in a separate browser tab. This is not proof of a viewer session. If the handoff was consumed or expired, choose a new deliberate Open; no re-pairing is needed for that alone.</p> : null}
          {!paused ? <div><Button disabled={disabled || !connection.connection.uiOrigin} onClick={() => void open()}>Open platform</Button></div> : null}
          <Hint>{!connection.connection.uiOrigin ? "This platform advertises no UI origin, so Open is unavailable." : disabled ? "Open is paused until current Client observation and recovery storage are available." : null}</Hint>
          {paused ? <section aria-labelledby="open-request-title" className="client-tray" data-tone="attention">
            <div className="client-panel-title"><h2 id="open-request-title" className="text-sm font-semibold">Saved Open recovery</h2><StatusChip tone="attention">Unresolved</StatusChip></div>
            <p className="text-sm">{pending ? "The host lists an unfinished Open. Resume with its pendingOpen UUID, never a new refresh request." : "The Open answer or navigation was not confirmed. Inspect before deliberately recovering the same UUID."} Reload does not dispatch.</p>
            <Facts items={[["Open request UUID", pending ?? saved!.input.requestId, { mono: true }], ...(pending ? [["Host pendingOpen", pending, { mono: true }] as [string, string, { mono: boolean }]] : [])]} />
            <div className="flex flex-wrap gap-2"><Button variant={inspected ? "outline" : "default"} disabled={disabled} onClick={async () => { await refresh(); setInspected(true); }}>Inspect current connection</Button>
              <Button disabled={disabled || !inspected || !connection.connection.uiOrigin} onClick={() => void open()}>{pending ? "Resume pending Open" : "Recover saved Open"}</Button>
              {!pending && inspected ? <Button variant="outline" disabled={disabled} onClick={() => { try { clearSaved(saved); action.setError(null); } catch { action.setError("Could not clear saved recovery input. Open remains paused; nothing was dispatched."); } }}>Acknowledge inspected handoff</Button> : null}</div>
            <Hint>{!inspected ? "Inspect first. Recovery resends only the exact retained UUID and input." : null}</Hint>
            <p className="text-sm text-muted-foreground">Access&apos;s native refresh retry window is five minutes. Past that window, or if a token expires during an unfinished Open, there is no pending-open reset API: deliberately re-enroll, then forget the stranded local connection. Nothing silently cycles credentials.</p>
            <div className="flex flex-wrap gap-2"><a className="text-sm underline" href="/client/manual">Inspect a new manual connection</a><a className="text-sm underline" href="/client/phone">Make a new phone request</a></div>
          </section> : null}
        </PanelBody></Panel>
        <Panel labelledBy="forget-title"><PanelBody><PanelTitle id="forget-title" description="Local removal stays separate from server permission and viewer sign-out.">Forget this connection</PanelTitle>
          <ForgetControl kind="connection" revision={connection.revision} disabled={disabled} onConfirm={async expectedRevision => {
            const result = await action.run(() => clientCall("client_connection_forget", { id, expectedRevision }));
            if (!result) return false;
            setForgotten(true); try { clearSaved(saved); } catch { action.setError("The connection was forgotten locally, but browser recovery input could not be removed. Do not replay it; Access authority was not revoked."); } return true;
          }} />
        </PanelBody></Panel>
      </> : <Hint>{observation ? "This connection is not listed. It may have been forgotten; nothing re-pairs or retargets it automatically." : "Waiting for the Client host."}</Hint>}
  </ClientShell>;
}
