"use client";

import { ArrowRightIcon, GlobeIcon, LaptopIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { useClientObservation } from "@/lib/client/use-observation";
import { JobSummary, stageName } from "./jobs";
import { Facts, ObservationStatus, StatusChip, useNow, type Tone } from "./parts";
import { ClientShell } from "./shell";

const stateTones: Record<string, Tone> = { Ready: "success", "Running, not ready": "attention", "Observation unavailable": "attention", "Installed, stopped": "neutral", "Not installed": "muted", Loading: "muted" };

export function ConnectionsHome() {
  const { observation, error, loading } = useClientObservation();
  const now = useNow();
  const snapshot = observation?.snapshot;
  const peers = observation?.peers;
  const unresolved = snapshot?.jobs.filter(job => job.state === "running" || job.state === "unknown") ?? [];
  const pending = [...(peers?.pending.pairings ?? []).map(intent => ({ ...intent, kind: "Manual pairing" })),
    ...(peers?.pending.enrollments ?? []).map(intent => ({ ...intent, kind: "Phone enrollment" }))];
  const localState = !snapshot ? error ? "Observation unavailable" : "Loading" : snapshot.service.ready ? "Ready" : !snapshot.service.available ? "Observation unavailable"
    : snapshot.service.running ? "Running, not ready" : snapshot.installation ? "Installed, stopped" : "Not installed";
  const login = snapshot?.service.login;
  return <ClientShell>
      <div className="client-intro">
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-muted-foreground">The platform on this machine and your saved remote platforms, side by side. Closing this Client UI does not stop any of them.</p>
        <ObservationStatus loading={loading} at={observation?.at ?? null} />
      </div>
      {error ? <Alert variant="destructive"><AlertTitle>Observation interrupted</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      <section aria-labelledby="platforms-title" className="client-section">
        <h2 id="platforms-title" className="client-section-title">Platforms</h2>
        <ul className="client-peers">
          <li className="client-peer">
            <div className="client-peer-body">
              <div className="client-peer-title"><h3><LaptopIcon aria-hidden />On this machine</h3><StatusChip tone={stateTones[localState] ?? "neutral"}>{localState}</StatusChip></div>
              <p className="text-sm">{snapshot?.installation ? `Installed release ${snapshot.installation.version}` : snapshot ? "No local platform installed. Remote connections work independently." : "Waiting for the Client host."}</p>
              {login ? <Facts items={[["Start at login", login.saved === login.applied ? login.saved ? "On" : "Off" : `Saved ${login.saved ? "on" : "off"}, application pending`]]} /> : null}
            </div>
            <div className="client-peer-footer">
              <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/client/local">Run locally<ArrowRightIcon aria-hidden data-icon="inline-end" /></a>
            </div>
          </li>
          {peers?.connections.map(peer => <li key={peer.id} className="client-peer">
            <div className="client-peer-body">
              <div className="client-peer-title"><h3><GlobeIcon aria-hidden />{peer.label}</h3>
                <StatusChip tone={peer.pendingOpen ? "attention" : peer.expiresAt <= Date.now() ? "danger" : "neutral"}>{peer.pendingOpen ? "Open unresolved" : peer.expiresAt <= Date.now() ? "Credential expired" : "Saved remote"}</StatusChip></div>
              <Facts items={[["Device", peer.connection.deviceOrigin, { mono: true }],
                ["Platform UI", peer.connection.uiOrigin ?? <span className="font-sans text-muted-foreground">Not advertised by this platform</span>, { mono: !!peer.connection.uiOrigin }]]} />
            </div>
            <div className="client-peer-footer"><p className="text-sm text-muted-foreground">Saved — not a live connection.</p></div>
          </li>)}
        </ul>
        {peers && !peers.connections.length ? <p className="text-sm text-muted-foreground">No saved remote connections.</p> : null}
      </section>
      <section aria-labelledby="pending-title" className="client-section">
        <div className="flex flex-col gap-1"><h2 id="pending-title" className="client-section-title">Pending connections</h2>
          <p className="text-sm text-muted-foreground">Incomplete pairings and phone enrollments. Nothing is redeemed or retried automatically.</p></div>
        {pending.length ? <ul className="client-list">{pending.map(intent => <li key={`${intent.kind}:${intent.id}`} className="client-list-row">
          <div className="flex min-w-0 flex-col"><p className="font-medium">{intent.label}</p><p className="text-sm text-muted-foreground">{intent.kind}</p></div>
          <StatusChip tone={intent.connectionId ? "neutral" : "muted"}>{intent.connectionId ? "Connection retained" : "Incomplete"}</StatusChip>
        </li>)}</ul> : <p className="text-sm text-muted-foreground">{observation ? "No pending connections." : "Waiting for an observation."}</p>}
      </section>
      <section aria-labelledby="jobs-title" className="client-section">
        <div className="flex flex-col gap-1"><h2 id="jobs-title" className="client-section-title">Unresolved jobs</h2>
          <p className="text-sm text-muted-foreground">Unknown jobs are never replayed; inspect one before any new explicit action. A running job does not establish platform readiness.</p></div>
        {unresolved.length ? <ul className="client-list">{unresolved.map(job => <li key={job.id} className="client-list-row client-job-row" data-tone={job.state === "unknown" ? "attention" : undefined}>
          <div className="client-job-line"><JobSummary job={job} now={now} /></div>
          <p className="text-sm text-muted-foreground">Last recorded stage: {stageName(job.stage)}</p>
        </li>)}</ul> : <p className="text-sm text-muted-foreground">{observation ? "No unresolved jobs in the 50 most recent retained jobs." : "Waiting for an observation."}</p>}
      </section>
  </ClientShell>;
}
