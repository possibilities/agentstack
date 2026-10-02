"use client";

import { useEffect, useRef, useState } from "react";
import type { ClientOutput, Release } from "@stack/client/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clientCall } from "@/lib/client/channel";
import { useLocalRequest } from "@/lib/client/local-request";
import { useClientObservation } from "@/lib/client/use-observation";
import { ClientShell } from "./shell";
import { PlatformConfigurationForm } from "./platform-configuration";

type Job = ClientOutput<"client_job_get">;
const names = { client_install: "Install", client_platform_start: "Start", client_platform_stop: "Stop", client_login_set: "Login preference" };
const stageNames: Record<string, string> = { admitted: "Admitted", downloading: "Downloading", extracting: "Extracting", runtime_install: "Installing shared codexnk runtime", selecting: "Selecting installed release", finished: "Terminal", starting_service: "Starting user service", stopping_service: "Stopping user service", configuring_login: "Applying login preference" };
function JobDetails({ job }: { job: Job }) {
  return <div className="flex flex-col gap-2" data-job-state={job.state}>
    <div className="client-peer-title"><p className="font-medium">{names[job.operation as keyof typeof names] ?? job.operation}</p><Badge variant={job.state === "unknown" || job.state === "failed" ? "destructive" : "outline"}>{job.state === "unknown" ? "Outcome unknown" : job.state}</Badge></div>
    <p className="text-sm">Stage: {stageNames[job.stage] ?? job.stage}</p><p className="break-all font-mono text-sm">{job.id}</p>
    {job.error ? <p className="break-words text-sm">Reported error: {job.error}</p> : null}
    <p className="text-sm text-muted-foreground">{job.state === "unknown" ? "This job is not replayed. Inspect current state before a new explicit action." : "Admission and native command completion do not establish platform readiness."}</p>
  </div>;
}

export function LocalPlatform({ release, scope }: { release: Release | null; scope: string }) {
  const { observation, error, loading, refresh } = useClientObservation();
  const recovery = useLocalRequest(scope);
  const [prerequisites, setPrerequisites] = useState<ClientOutput<"client_prerequisites"> | null>(null);
  const [plan, setPlan] = useState<ClientOutput<"client_install_plan"> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openUncertain, setOpenUncertain] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [pollExhausted, setPollExhausted] = useState(false);
  const actionLock = useRef(false);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const stopAction = useRef<HTMLButtonElement>(null);
  const snapshot = observation?.snapshot;
  const service = snapshot?.service;
  const request = recovery.request, job = recovery.job;
  useEffect(() => { if (snapshot) recovery.observeJob(snapshot.jobs); }, [snapshot, recovery.observeJob]);
  const startUnresolved = request?.operation === "client_platform_start" && (!job || job.state === "running" || job.state === "completed") && !service?.ready;
  const stopUnresolved = request?.operation === "client_platform_stop" && (!job || job.state === "running" || job.state === "completed") && (!service?.available || service.running || service.ready);
  const polling = !!(startUnresolved || stopUnresolved);
  const pollIdentity = polling ? request?.input.requestId : null;
  useEffect(() => {
    if (!pollIdentity) return;
    setPollExhausted(false);
    let count = 0, busy = false;
    const deadline = setTimeout(() => { clearInterval(timer); setPollExhausted(true); }, 30_000);
    const timer = setInterval(async () => {
      if (busy) return;
      if (++count > 30) { clearInterval(timer); setPollExhausted(true); return; }
      busy = true; try { await refresh(); } finally { busy = false; }
    }, 1000);
    return () => { clearInterval(timer); clearTimeout(deadline); };
  }, [pollIdentity, refresh]);
  const disabled = !snapshot || !!error || !recovery.loaded || recovery.busy || opening;
  const blocked = disabled || !!request || !!recovery.error;
  const prerequisitesPass = !!prerequisites && prerequisites.supported && prerequisites.dependencies.every(item => item.available)
    && !!release && prerequisites.platform === release.platform && prerequisites.architecture === release.architecture;
  const inspect = async () => { await refresh(); await recovery.inspect(); };
  const inspectPrerequisites = async () => {
    if (actionLock.current) return; actionLock.current = true; setChecking(true); setActionError(null); setPlan(null);
    try { setPrerequisites(await clientCall("client_prerequisites", {})); }
    catch { setActionError("Prerequisites could not be observed. No install was dispatched."); }
    finally { actionLock.current = false; setChecking(false); }
  };
  const reviewPlan = async () => {
    if (!release || !prerequisitesPass || actionLock.current) return;
    actionLock.current = true; setChecking(true); setActionError(null);
    try { setPlan(await clientCall("client_install_plan", { release })); }
    catch { setActionError("Install plan unavailable. Check the trusted release target and prerequisites. Nothing was installed."); }
    finally { actionLock.current = false; setChecking(false); }
  };
  const open = async () => {
    if (disabled || !service?.ready || actionLock.current) return;
    actionLock.current = true; setOpening(true); setActionError(null);
    // Open a blank child synchronously to preserve the browser's explicit gesture.
    const child = window.open("about:blank", "_blank");
    if (child) child.opener = null;
    try {
      if (!child) throw new Error();
      const output = await clientCall("client_local_open", {});
      const target = new URL(output.url);
      if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password || target.pathname !== "/connect/local" || target.search || !target.hash) throw new Error();
      child.location.replace(output.url); setOpenUncertain(false);
    } catch { child?.close(); setOpenUncertain(true); setActionError("Open was not confirmed. No URL is retained. Inspect readiness, then use a new deliberate Open; this operation has no requestId."); }
    finally { actionLock.current = false; setOpening(false); }
  };
  const localState = !snapshot ? error ? "Observation unavailable" : "Loading" : service?.ready ? "Ready" : !service?.available ? "Observation unavailable"
    : startUnresolved ? "Starting" : stopUnresolved ? "Stopping" : service.running ? "Running, not ready" : snapshot.installation ? "Installed, stopped" : "Not installed";
  const terminal = job && job.state !== "running";
  return <ClientShell local>
    <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">Run locally</h1>
      <p className="text-muted-foreground">Install a reviewed release, then explicitly start your local platform.</p>
      <p className="text-sm text-muted-foreground">Closing this Client UI never stops the background platform. Stop is a separate explicit action.</p></div>
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{loading ? "Loading client observation…" : observation ? `Last observation: ${new Date(observation.at).toLocaleTimeString()}` : "No observation available."}</p>
    {error ? <Alert variant="destructive"><AlertTitle>Observation interrupted</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    <section aria-labelledby="local-state-title" className="flex flex-col gap-4">
      <div className="client-peer-title"><h2 id="local-state-title" className="text-lg font-medium">On this machine</h2><Badge variant="outline">{localState}</Badge></div>
      <p className="text-sm">{snapshot?.installation ? `Installed release ${snapshot.installation.version}` : snapshot ? "No local platform installed." : "Waiting for the Client host's installation observation."}</p>
      {service?.ready ? <p className="text-sm">Ready means a serve_status answer was observed from this Client's platform socket. It is not inferred from job completion.</p> : null}
      {service && !service.available ? <p className="text-sm">User-service observation unavailable. Start and Stop remain unavailable; no absence is inferred.</p> : null}
      <div className="flex flex-wrap gap-2">
        {service?.ready ? <Button ref={primaryAction} disabled={disabled} onClick={() => void open()}>{openUncertain ? "Open again deliberately" : "Open platform"}</Button> : <Button ref={primaryAction} disabled={blocked || !snapshot?.installation || !service?.available || service.running} onClick={() => void recovery.admit("client_platform_start")}>Start platform</Button>}
        <Button ref={stopAction} variant="outline" disabled={blocked || !service?.available || !service.owned || !(service.running || service.ready || service.registered)} onClick={() => void recovery.admit("client_platform_stop")}>Stop platform</Button>
        <Button variant="outline" disabled={disabled} onClick={() => void inspect()}>Inspect job and snapshot</Button>
      </div>
      {polling ? <p role="status" className="text-sm">{pollExhausted ? "Bounded observation ended without a resolved service state. Use Inspect job and snapshot; nothing is retried." : "Observing unresolved service state for up to 30 seconds. No service action is retried."}</p> : null}
    </section>
    {request ? <section aria-labelledby="request-title" className="flex flex-col gap-3">
      <h2 id="request-title" className="text-lg font-medium">Saved exact request</h2>
      {job ? <JobDetails job={job} /> : <p className="text-sm">{recovery.busy ? "Dispatching saved request…" : "Admission unresolved. Inspect before an identical retry."}</p>}
      <details><summary className="cursor-pointer text-sm">Immutable input</summary><pre className="client-json text-sm">{JSON.stringify(request, null, 2)}</pre></details>
      {!job ? <Button variant="outline" disabled={disabled || !recovery.inspected} onClick={() => void recovery.retry()}>Retry identical request</Button> : null}
      {terminal ? <Button variant="outline" disabled={disabled || !recovery.inspected} onClick={() => {
        if (recovery.clear()) { setPlan(null); requestAnimationFrame(() => (primaryAction.current?.disabled ? stopAction.current : primaryAction.current)?.focus()); }
      }}>Acknowledge inspected outcome</Button> : null}
      <p className="text-sm text-muted-foreground">The UUID and exact input were stored before dispatch, scoped to this Client root. Reloading never dispatches this request.</p>
    </section> : null}
    {recovery.error ? <Alert variant="destructive"><AlertTitle>Request recovery</AlertTitle><AlertDescription>{recovery.error}</AlertDescription></Alert> : null}
    {actionError ? <Alert variant="destructive"><AlertTitle>Action not confirmed</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert> : null}
    <section aria-labelledby="install-title" className="flex flex-col gap-4">
      <h2 id="install-title" className="text-lg font-medium">Install a local release</h2>
      {!release ? <Alert><AlertTitle>No trusted release configured for this Client</AlertTitle><AlertDescription>Restart the Client launcher with <code className="break-words">stack-ui --release-manifest /absolute/reviewed-release.json</code> (or STACK_CLIENT_RELEASE_MANIFEST). Installation is unavailable; remote platforms remain independent.</AlertDescription></Alert>
        : <p className="text-sm">Trusted launcher release: <strong>{release.version}</strong> · {release.platform}/{release.architecture}. No platform or browser can supply install instructions.</p>}
      <Button variant="outline" disabled={disabled || checking || !!request} onClick={() => void inspectPrerequisites()}>Check prerequisites</Button>
      {prerequisites ? <div className="flex flex-col gap-2"><p className="text-sm">Observed OS/architecture: {prerequisites.platform}/{prerequisites.architecture} · Node {prerequisites.nodeVersion}</p>
        <ul className="flex flex-col gap-1 text-sm">{prerequisites.dependencies.map(item => <li key={item.name}>{item.name}: {item.available ? "executable available" : "missing executable"}</li>)}<li>User-service observation: {prerequisites.serviceAvailable ? "available" : "unavailable"}</li></ul>
        <p className="text-sm text-muted-foreground">Executable checks do not prove GitHub authentication, Debian qualification or tailnet setup. Missing prerequisites require operator setup; nothing is installed automatically.</p>
        {!prerequisitesPass && release ? <Alert variant="destructive"><AlertTitle>Install prerequisites not met</AlertTitle><AlertDescription>A supported OS/architecture, matching release, python3 and gh executables are required.</AlertDescription></Alert> : null}
      </div> : null}
      {release ? <Button variant="outline" disabled={blocked || checking || !prerequisitesPass || service?.running || service?.ready} onClick={() => void reviewPlan()}>Review install plan</Button> : null}
      {plan ? <div className="flex flex-col gap-3"><h3 className="font-medium">Reviewed install plan</h3>
        <dl className="flex flex-col gap-2 text-sm"><div><dt>Release</dt><dd>{plan.release.version} · {plan.release.platform}/{plan.release.architecture}</dd></div>
          <div><dt>SHA-256</dt><dd className="break-all font-mono">{plan.release.sha256}</dd></div><div><dt>Download / unpacked limit</dt><dd>{plan.release.bytes.toLocaleString()} / {plan.release.unpackedBytes.toLocaleString()} bytes</dd></div>
          <div><dt>Release directory</dt><dd className="break-words font-mono">{plan.directory}</dd></div><div><dt>Platform state</dt><dd className="break-words font-mono">{plan.platformState}</dd></div></dl>
        <ul className="list-inside list-disc text-sm">{plan.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
        <p className="text-sm text-muted-foreground">Requires: {plan.requires.join(", ")}. Installs may update the shared codexnk runtime. Old releases and platform data are retained. Install does not start Stack or change login.</p>
        <Button disabled={blocked || checking || service?.running || service?.ready} onClick={() => void recovery.admit("client_install", { release: plan.release })}>Install reviewed release</Button>
      </div> : null}
    </section>
    <section aria-labelledby="login-title" className="flex flex-col gap-3"><h2 id="login-title" className="text-lg font-medium">Start local platform at login</h2>
      {service ? <p className="text-sm">Saved: {service.login.saved ? "on" : "off"} · Applied: {service.login.applied ? "on" : "off"} · {service.login.saved !== service.login.applied ? "Application pending" : "No pending login change"}</p>
        : <p className="text-sm">Waiting for the Client host's login observation.</p>}
      <p className="text-sm text-muted-foreground">Off by default. This is the platform's user-session login preference, not future native-app login or machine boot. Saving never starts or restarts the platform. A running macOS service may leave it pending until explicit Stop then Start.</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={blocked || !snapshot?.installation || !service?.available || service.login.saved} onClick={() => void recovery.admit("client_login_set", { enabled: true })}>Enable platform login</Button>
        <Button variant="outline" disabled={blocked || !snapshot?.installation || !service?.available || !service.login.saved} onClick={() => void recovery.admit("client_login_set", { enabled: false })}>Disable platform login</Button></div>
    </section>
    {snapshot ? <PlatformConfigurationForm observed={snapshot.configuration} disabled={disabled || !!request} refresh={refresh} /> : null}
    {snapshot?.jobs.length ? <section aria-labelledby="jobs-title" className="flex flex-col gap-3"><h2 id="jobs-title" className="text-lg font-medium">Recent local jobs</h2><p className="text-sm text-muted-foreground">Up to 50 retained jobs. Unknown jobs are read-only; inspecting never dispatches them.</p>
      <ul className="flex flex-col gap-2">{snapshot.jobs.map(item => <li key={item.id}><Button variant="link" onClick={async () => { try { setSelectedJob(await clientCall("client_job_get", { id: item.id })); } catch { setActionError("Exact job inspection unavailable. The last observation is retained."); } }}>{names[item.operation as keyof typeof names] ?? item.operation} · {item.state} · {item.id.slice(0, 8)}</Button></li>)}</ul>
      {selectedJob ? <JobDetails job={selectedJob} /> : null}</section> : null}
  </ClientShell>;
}
