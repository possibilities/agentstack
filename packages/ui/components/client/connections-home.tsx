"use client";

import { useEffect, useState } from "react";
import type { ClientOutput } from "@stack/client/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { clientCall } from "@/lib/client/channel";

type Observation = { snapshot: ClientOutput<"client_snapshot">; peers: ClientOutput<"client_connection_list">; at: number };
export function ConnectionsHome() {
  const [observation, setObservation] = useState<Observation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const events = new EventSource("/api/client/events");
    let busy = false, dirty = false;
    const refresh = async () => {
      if (busy) { dirty = true; return; }
      busy = true;
      do {
        dirty = false;
        try {
          const [snapshot, peers] = await Promise.all([
            clientCall("client_snapshot", {}, controller.signal), clientCall("client_connection_list", {}, controller.signal),
          ]);
          if (!controller.signal.aborted) { setObservation({ snapshot, peers, at: Date.now() }); setError(null); }
        } catch (error) {
          if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Client observation unavailable.");
        } finally { if (!controller.signal.aborted) setLoading(false); }
      } while (dirty && !controller.signal.aborted);
      busy = false;
    };
    // Do not snapshot before the private subscription has acknowledged.
    events.addEventListener("ready", () => void refresh());
    events.addEventListener("client_changed", () => void refresh());
    events.addEventListener("session_expired", () => {
      events.close(); controller.abort(); setLoading(false);
      setError("Client session expired. Run stack-ui to reconnect. The last observation is retained.");
    });
    const unavailable = () => { setLoading(false); setError("Client updates unavailable: the host may have disconnected or your session may have expired. The last observation is retained. Run stack-ui to reconnect if needed."); };
    events.addEventListener("unavailable", unavailable);
    events.onerror = unavailable;
    return () => { controller.abort(); events.close(); };
  }, []);
  const snapshot = observation?.snapshot;
  const peers = observation?.peers;
  const unresolved = snapshot?.jobs.filter(job => job.state === "running" || job.state === "unknown") ?? [];
  const pending = [...(peers?.pending.pairings ?? []).map(intent => ({ ...intent, kind: "Manual pairing" })),
    ...(peers?.pending.enrollments ?? []).map(intent => ({ ...intent, kind: "Phone enrollment" }))];
  const localState = !snapshot ? "Loading" : snapshot.service.ready ? "Ready" : !snapshot.service.available ? "Observation unavailable"
    : snapshot.service.running ? "Running, not ready" : snapshot.installation ? "Installed, stopped" : "Not installed";
  return <div className="client-home">
    <a className="client-skip" href="#connections-main">Skip to connections</a>
    <header className="client-header">
      <span className="font-medium">Stack Client</span>
      <nav aria-label="Client"><a href="/client" aria-current="page">Connections</a></nav>
    </header>
    <main id="connections-main" className="client-main">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-muted-foreground">Your local platform and saved remote platforms, together.</p>
        <p className="text-sm text-muted-foreground">Closing this Client UI does not stop a platform. Installation and connection setup are not available in this foundation release.</p>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {loading ? "Loading client observation…" : observation ? `Last observation: ${new Date(observation.at).toLocaleTimeString()}` : "No client observation available."}
      </p>
      {error ? <Alert variant="destructive"><AlertTitle>Observation interrupted</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      <section aria-labelledby="platforms-title" className="flex flex-col gap-3">
        <h2 id="platforms-title" className="text-lg font-medium">Platforms</h2>
        <ul className="client-peers">
          <li className="client-peer">
            <div className="client-peer-title"><h3 className="font-medium">On this machine</h3><Badge variant="outline">{localState}</Badge></div>
            <p className="text-sm text-muted-foreground">{snapshot?.installation ? `Installed release ${snapshot.installation.version}` : snapshot ? "No local platform installed. Remote connections work independently." : "Waiting for the Client host."}</p>
            {snapshot ? <p className="text-sm text-muted-foreground">Start at login: {snapshot.service.login.saved ? "saved on" : "saved off"}; {snapshot.service.login.applied === snapshot.service.login.saved ? "applied" : "application pending"}.</p> : null}
          </li>
          {peers?.connections.map(peer => <li key={peer.id} className="client-peer">
            <div className="client-peer-title"><h3 className="font-medium">{peer.label}</h3><Badge variant="outline">{peer.pendingOpen ? "Open unresolved" : peer.expiresAt <= Date.now() ? "Credential expired" : "Saved remote"}</Badge></div>
            <p className="break-words font-mono text-sm">{peer.connection.deviceOrigin}</p>
            <p className="text-sm text-muted-foreground">{peer.connection.uiOrigin ? <>Platform UI:<span className="block break-words font-mono">{peer.connection.uiOrigin}</span></> : "This platform does not advertise a UI."}</p>
            <p className="text-sm text-muted-foreground">Saved — not a live connection.</p>
          </li>)}
        </ul>
        {peers && !peers.connections.length ? <p className="text-sm text-muted-foreground">No saved remote connections.</p> : null}
      </section>
      <section aria-labelledby="pending-title" className="flex flex-col gap-3">
        <h2 id="pending-title" className="text-lg font-medium">Pending connections</h2>
        {pending.length ? <ul className="flex flex-col gap-3">{pending.map(intent => <li key={`${intent.kind}:${intent.id}`}>
          <p className="font-medium">{intent.label}</p><p className="text-sm text-muted-foreground">{intent.kind} · {intent.connectionId ? "Connection retained" : "Incomplete"}. No automatic redemption or retry.</p>
        </li>)}</ul> : <p className="text-sm text-muted-foreground">{observation ? "No pending connection intents." : "Waiting for an observation."}</p>}
      </section>
      <section aria-labelledby="jobs-title" className="flex flex-col gap-3">
        <h2 id="jobs-title" className="text-lg font-medium">Unresolved jobs</h2>
        {unresolved.length ? <ul className="flex flex-col gap-3">{unresolved.map(job => <li key={job.id}>
          <div className="client-peer-title"><p className="font-mono text-sm">{job.operation}</p><Badge variant={job.state === "unknown" ? "destructive" : "outline"}>{job.state === "unknown" ? "Outcome unknown" : "Running"}</Badge></div>
          <p className="text-sm text-muted-foreground">Stage: {job.stage}. {job.state === "unknown" ? "Inspect before any new explicit action; this job is not replayed." : "Admission does not establish platform readiness."}</p>
        </li>)}</ul> : <p className="text-sm text-muted-foreground">{observation ? "No unresolved jobs in the 50 most recent retained jobs." : "Waiting for an observation."}</p>}
      </section>
    </main>
  </div>;
}
