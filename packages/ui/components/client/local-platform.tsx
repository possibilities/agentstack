"use client";

import { useEffect, useRef, useState } from "react";
import type { ClientOutput, Release } from "@stack/client/contract";
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { clientCall } from "@/lib/client/channel";
import { useLocalRequest } from "@/lib/client/local-request";
import { useClientObservation } from "@/lib/client/use-observation";
import { JobDetails, JobProgress, JobSummary, jobState, operationName, type Job } from "./jobs";
import { Facts, Hint, ObservationStatus, Panel, PanelBody, PanelFooter, PanelTitle, StatusChip, StatusDot, useNow, type Tone } from "./parts";
import { ClientShell } from "./shell";
import { PlatformConfigurationForm } from "./platform-configuration";

const stateTones: Record<string, Tone> = { Ready: "success", Starting: "progress", Stopping: "progress", Installing: "progress", "Running, not ready": "attention",
  "Observation unavailable": "attention", "Installed, stopped": "neutral", "Not installed": "muted", Loading: "muted" };

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
    } catch { child?.close(); setOpenUncertain(true); setActionError("Open was not confirmed and no URL was kept. Check readiness, then choose Open again deliberately; this action has no request ID to recover."); }
    finally { actionLock.current = false; setOpening(false); }
  };
  // Display only: a running install anywhere in the retained ledger.
  const installing = !!snapshot?.jobs.some(item => item.operation === "client_install" && item.state === "running");
  const localState = !snapshot ? error ? "Observation unavailable" : "Loading" : service?.ready ? "Ready" : !service?.available ? "Observation unavailable"
    : startUnresolved ? "Starting" : stopUnresolved ? "Stopping" : service.running ? "Running, not ready" : installing ? "Installing" : snapshot.installation ? "Installed, stopped" : "Not installed";
  const terminal = job && job.state !== "running";
  const now = useNow();
  const installed = !!snapshot?.installation;

  // Gating expressions are unchanged; they are named so the reason can sit beside the control.
  const startDisabled = blocked || !snapshot?.installation || !service?.available || service.running;
  const stopDisabled = blocked || !service?.available || !service.owned || !(service.running || service.ready || service.registered);
  const checkDisabled = disabled || checking || !!request;
  const reviewDisabled = blocked || checking || !prerequisitesPass || service?.running || service?.ready;
  const installDisabled = blocked || checking || service?.running || service?.ready;
  const loginDisabled = (enabled: boolean) => blocked || !snapshot?.installation || !service?.available || (enabled ? service.login.saved : !service.login.saved);
  const reviewReason = !reviewDisabled || request || disabled ? null : !prerequisites ? "Check prerequisites first." : !prerequisitesPass ? "Available once prerequisites are met."
    : service?.running || service?.ready ? "Stop the platform before installing." : null;
  const installReason = !installDisabled || request || disabled ? null : service?.running || service?.ready ? "Stop the platform before installing." : null;
  const paused = !!request || !!recovery.error;
  // Presentation only: show Start/Open once something can be started or opened, Stop once there is a service to stop.
  const showPrimary = !!service?.ready || installed;
  const showStop = !!service && (service.running || service.ready || service.registered);
  // Open is never gated on a saved request; name only the controls that are actually paused.
  const pausedControls = [showPrimary && !service?.ready ? "Start" : null, showStop ? "Stop" : null].filter(Boolean).join(" and ");
  const servicePaused = !pausedControls || !paused ? null
    : `${pausedControls} ${pausedControls.includes(" and ") ? "are" : "is"} paused until ${request ? "the saved request below" : "request recovery"} is resolved.`;
  const serviceHint = !snapshot || disabled ? null : paused ? servicePaused : (showStop && !service?.owned ? "This service is not owned by this Client, so it cannot be stopped here."
    : !service?.ready && service?.running ? "The service is running; Open becomes available once a serve_status answer is observed." : null);

  const requestTone: Tone = !job ? recovery.busy ? "neutral" : "attention" : job.state === "unknown" ? "attention" : job.state === "failed" ? "danger" : "neutral";
  const requestChip = !job ? recovery.busy ? { label: "Dispatching", tone: "progress" as Tone } : { label: "Unresolved", tone: "attention" as Tone } : jobState(job.state);
  const RequestIcon = requestTone === "danger" ? CircleXIcon : requestTone === "attention" ? TriangleAlertIcon : null;

  const installFlow = <Panel labelledBy="install-title" className={installed ? undefined : "client-panel-lead"}>
    <PanelBody>
      <PanelTitle id="install-title" description={!release ? undefined : installed ? "Reinstall the pinned release while the platform is stopped." : "Three explicit steps. Nothing changes on this machine until step 3."}>Install a local release</PanelTitle>
      {!release ? <Alert><CircleAlertIcon /><AlertTitle>No trusted release configured for this Client</AlertTitle><AlertDescription>
        <p>Restart the Client launcher with <code className="client-code">stack-ui --release-manifest /absolute/reviewed-release.json</code> or set STACK_CLIENT_RELEASE_MANIFEST.</p>
        <p>Installation is unavailable; remote platforms remain independent.</p></AlertDescription></Alert>
        : <div className="flex flex-col gap-1"><p className="text-sm">Trusted launcher release: <strong className="font-semibold">{release.version}</strong> · <span className="font-mono text-[0.8125rem]">{release.platform}/{release.architecture}</span></p>
          <p className="text-sm text-muted-foreground">Pinned by the launcher. No platform or browser can supply install instructions.</p></div>}
      <ol className="client-flow">
        <li data-done={prerequisites ? prerequisitesPass ? "true" : "failed" : undefined}>
          <span aria-hidden className="client-flow-number">1</span>
          <div className="client-flow-body">
            <div className="client-flow-head">
              <div><h3 className="font-medium">Prerequisites</h3><p className="text-sm text-muted-foreground">Supported OS and architecture, python3, gh and a user service session.</p></div>
              <Button variant={release && !installed && !prerequisites && !checkDisabled ? "default" : "outline"} disabled={checkDisabled} aria-describedby={request ? "install-paused" : undefined} onClick={() => void inspectPrerequisites()}>Check prerequisites</Button>
            </div>
            {prerequisites ? <div className="flex flex-col gap-3">
              <ul className="client-checks">
                {prerequisites.dependencies.map(item => <li key={item.name} data-ok={item.available}>{item.available ? <CircleCheckIcon aria-hidden /> : <CircleXIcon aria-hidden />}<span>{item.name}: {item.available ? "executable available" : "missing executable"}</span></li>)}
                <li data-ok={prerequisites.serviceAvailable}>{prerequisites.serviceAvailable ? <CircleCheckIcon aria-hidden /> : <CircleXIcon aria-hidden />}<span>User-service observation: {prerequisites.serviceAvailable ? "available" : "unavailable"}</span></li>
              </ul>
              <p className="text-xs text-muted-foreground">Observed <span className="font-mono">{prerequisites.platform}/{prerequisites.architecture}</span> · Node {prerequisites.nodeVersion}. Executable checks do not prove GitHub authentication, Debian qualification or tailnet setup. Missing prerequisites need operator setup; nothing is installed automatically.</p>
              {!prerequisitesPass && release ? <Alert variant="destructive"><CircleXIcon /><AlertTitle>Install prerequisites not met</AlertTitle><AlertDescription>A supported OS/architecture, matching release, python3 and gh executables are required.</AlertDescription></Alert> : null}
            </div> : null}
          </div>
        </li>
        {release ? <li data-done={plan ? "true" : undefined}>
          <span aria-hidden className="client-flow-number">2</span>
          <div className="client-flow-body">
            <div className="client-flow-head">
              <div><h3 className="font-medium">Install plan</h3><p className="text-sm text-muted-foreground">The exact release, limits, directories and effects, before anything changes.</p></div>
              <Button variant={!installed && prerequisitesPass && !plan && !reviewDisabled ? "default" : "outline"} disabled={reviewDisabled} aria-describedby={reviewReason ? "review-reason" : request ? "install-paused" : undefined} onClick={() => void reviewPlan()}>Review install plan</Button>
            </div>
            <Hint id="review-reason">{reviewReason}</Hint>
            {plan ? <div className="client-plan">
              <h4 className="text-sm font-medium">Reviewed install plan</h4>
              <Facts items={[["Release", `${plan.release.version} · ${plan.release.platform}/${plan.release.architecture}`],
                ["SHA-256", <span key="sha" className="break-all">{plan.release.sha256}</span>, { mono: true }],
                ["Download / unpacked limit", <span key="bytes" className="tabular-nums">{plan.release.bytes.toLocaleString()} / {plan.release.unpackedBytes.toLocaleString()} bytes</span>],
                ["Release directory", plan.directory, { mono: true }], ["Platform state", plan.platformState, { mono: true }]]} />
              <ul className="list-disc pl-5 text-sm marker:text-muted-foreground">{plan.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
              <p className="text-sm text-muted-foreground">Requires: {plan.requires.join(", ")}. Installs may update the shared codexnk runtime. Old releases and platform data are retained.</p>
            </div> : null}
          </div>
        </li> : null}
        {release ? <li>
          <span aria-hidden className="client-flow-number">3</span>
          <div className="client-flow-body">
            <div className="client-flow-head">
              <div><h3 className="font-medium">Install</h3><p className="text-sm text-muted-foreground">Installs the reviewed release. Install does not start Stack or change login.</p></div>
              {plan ? <Button disabled={installDisabled} aria-describedby={installReason ? "install-reason" : request ? "install-paused" : undefined} onClick={() => void recovery.admit("client_install", { release: plan.release })}>Install reviewed release</Button> : null}
            </div>
            {!plan ? <Hint>Available after you review the install plan.</Hint> : <Hint id="install-reason">{installReason}</Hint>}
          </div>
        </li> : null}
      </ol>
      {request ? <Hint id="install-paused">Paused until the saved request above is resolved.</Hint> : null}
    </PanelBody>
  </Panel>;

  return <ClientShell local>
    <div className="client-intro">
      <h1 className="text-2xl font-semibold tracking-tight">Run locally</h1>
      <p className="text-muted-foreground">Install a reviewed release, then explicitly start Stack on this machine as a background service.</p>
    </div>
    {error ? <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>Observation interrupted</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}

    <Panel labelledBy="local-state-title" className="client-machine">
      <PanelBody>
        <div className="client-panel-title">
          <h2 id="local-state-title" className="client-eyebrow">On this machine</h2>
          <div className="flex items-center gap-2">
            <ObservationStatus loading={loading} at={observation?.at ?? null} />
            {!request ? <Button variant="ghost" size="xs" disabled={disabled} onClick={() => void inspect()}>Refresh</Button> : null}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <p className="client-state" aria-live="polite"><StatusDot tone={stateTones[localState] ?? "neutral"} />{localState}</p>
          <p className="text-sm">{snapshot?.installation ? `Installed release ${snapshot.installation.version}` : snapshot ? "No local platform installed." : "Waiting for the Client host's installation observation."}</p>
        </div>
        {service?.ready ? <p className="text-sm text-muted-foreground">Ready means a serve_status answer was observed from this Client&apos;s platform socket, not inferred from job completion.</p> : null}
        {service && !service.available ? <p className="text-sm text-muted-foreground">User-service observation unavailable. Start and Stop stay unavailable; no absence is inferred.</p> : null}
        {snapshot && release && !installed && !installing && !request && !service?.ready && service?.available ? <p className="text-sm text-muted-foreground">Install a reviewed release below to run Stack here.</p> : null}
        {showPrimary || showStop ? <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {service?.ready ? <Button ref={primaryAction} disabled={disabled} onClick={() => void open()}>{openUncertain ? "Open again deliberately" : "Open platform"}</Button>
              : showPrimary ? <Button ref={primaryAction} variant={startDisabled ? "outline" : "default"} disabled={startDisabled} aria-describedby={serviceHint ? "service-hint" : undefined} onClick={() => void recovery.admit("client_platform_start")}>Start platform</Button> : null}
            {showStop ? <Button ref={stopAction} variant="outline" disabled={stopDisabled} aria-describedby={serviceHint ? "service-hint" : undefined} onClick={() => void recovery.admit("client_platform_stop")}>Stop platform</Button> : null}
          </div>
          <Hint id="service-hint">{serviceHint}</Hint>
          {polling ? <p role="status" className="text-sm">{pollExhausted ? "Bounded observation ended without a resolved service state. Use Inspect job and snapshot; nothing is retried." : "Observing unresolved service state for up to 30 seconds. No service action is retried."}</p> : null}
          <p className="text-xs text-muted-foreground">Closing this Client UI never stops the background platform; only Stop does.</p>
        </div> : null}
      </PanelBody>

      {request ? <section aria-labelledby="request-title" data-tone={requestTone} className="client-tray">
        <div className="client-panel-title">
          <div className="flex min-w-0 items-start gap-2.5">
            {RequestIcon ? <RequestIcon aria-hidden className="client-tray-icon" /> : null}
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 id="request-title" className="text-sm font-semibold">Saved exact request</h2>
              <p className="text-sm text-muted-foreground">{operationName(request.operation)}{request.operation === "client_login_set" ? ` · ${request.input.enabled ? "on" : "off"}` : null}</p>
            </div>
          </div>
          <span aria-live="polite"><StatusChip tone={requestChip.tone}>{requestChip.label}</StatusChip></span>
        </div>
        {recovery.error ? <p role="alert" className="text-sm font-medium">{recovery.error}</p> : null}
        {!job ? recovery.error ? null : <p className="text-sm font-medium">{recovery.busy ? "Dispatching saved request…" : "Admission unresolved. Inspect before an identical retry."}</p>
          : job.state === "unknown" ? <p className="text-sm font-medium">This job is not replayed. Inspect current state before a new explicit action.</p>
          : job.state === "failed" ? <p className="text-sm font-medium">This job failed. Inspect current state before a new explicit action.</p>
          : request.operation === "client_platform_start" && !service?.ready ? <p className="text-sm text-muted-foreground">Admission and command completion do not make the platform ready; Ready needs a serve_status answer.</p> : null}
        {job ? <JobProgress job={job} /> : null}
        <Facts items={[["Request ID", request.input.requestId, { mono: true, key: "id" }], ...(job?.error ? [["Reported error", job.error, { mono: true, key: "error" }] as [string, string, { mono: boolean; key: string }]] : [])]} />
        <details className="client-disclosure"><summary>Immutable input</summary><pre className="client-json">{JSON.stringify(request, null, 2)}</pre></details>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant={(!job || terminal) && !recovery.inspected && !disabled ? "default" : "outline"} disabled={disabled} onClick={() => void inspect()}>Inspect job and snapshot</Button>
            {!job ? <Button variant={recovery.inspected ? "default" : "outline"} disabled={disabled || !recovery.inspected} aria-describedby="request-hint" onClick={() => void recovery.retry()}>Retry identical request</Button> : null}
            {terminal ? <Button variant={recovery.inspected ? "default" : "outline"} disabled={disabled || !recovery.inspected} aria-describedby="request-hint" onClick={() => {
              if (recovery.clear()) { setPlan(null); requestAnimationFrame(() => (primaryAction.current?.disabled ? stopAction.current : primaryAction.current)?.focus()); }
            }}>Acknowledge inspected outcome</Button> : null}
          </div>
          {(!job || terminal) && !recovery.inspected && !disabled ? <Hint id="request-hint">{!job ? "Inspect first. A retry resends the same request ID and input." : "Inspect first, then acknowledge to clear this saved request."}</Hint> : null}
        </div>
        <p className="text-xs text-muted-foreground">The request ID and exact input were stored before dispatch, scoped to this Client root. Reloading never dispatches this request.</p>
      </section> : null}
    </Panel>

    {recovery.error && !request ? <Alert variant="destructive"><CircleXIcon /><AlertTitle>Request recovery</AlertTitle><AlertDescription>{recovery.error}</AlertDescription></Alert> : null}
    {actionError ? <Alert variant="destructive"><CircleXIcon /><AlertTitle>Action not confirmed</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert> : null}

    {!installed ? installFlow : null}

    <Panel labelledBy="login-title">
      <PanelBody>
        <PanelTitle id="login-title" description="Off by default. Starts this platform when you sign in to this user account; it is not machine boot or a future native-app login.">Start local platform at login</PanelTitle>
        {service ? <p className="client-setting-state"><StatusDot tone={service.login.saved !== service.login.applied ? "attention" : service.login.saved ? "success" : "muted"} />Saved: {service.login.saved ? "on" : "off"} · Applied: {service.login.applied ? "on" : "off"} · {service.login.saved !== service.login.applied ? "Application pending" : "No pending login change"}</p>
          : <p className="text-sm text-muted-foreground">Waiting for the Client host&apos;s login observation.</p>}
      </PanelBody>
      <PanelFooter>
        <p className="text-sm text-muted-foreground">Saving never starts or restarts the platform. A running macOS service can keep the change pending until an explicit Stop, then Start.</p>
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          {service?.login.saved ? <Button variant="outline" disabled={loginDisabled(false)} aria-describedby="login-hint" onClick={() => void recovery.admit("client_login_set", { enabled: false })}>Disable platform login</Button>
            : <Button variant="outline" disabled={loginDisabled(true)} aria-describedby="login-hint" onClick={() => void recovery.admit("client_login_set", { enabled: true })}>Enable platform login</Button>}
          {snapshot && !disabled ? <Hint id="login-hint">{!installed ? "Install a release first." : !service?.available ? "User-service observation unavailable." : paused ? `Paused until ${request ? "the saved request" : "request recovery"} is resolved.` : null}</Hint> : null}
        </div>
      </PanelFooter>
    </Panel>

    {snapshot ? <PlatformConfigurationForm observed={snapshot.configuration} disabled={disabled || !!request} refresh={refresh} /> : null}

    {installed ? installFlow : null}

    {snapshot?.jobs.length ? <Panel labelledBy="jobs-title">
      <PanelBody>
        <PanelTitle id="jobs-title" description="Up to 50 retained jobs. Unknown jobs are read-only; inspecting never dispatches them.">Recent local jobs</PanelTitle>
        <ul className="client-rows">{snapshot.jobs.map(item => <li key={item.id}>
          <button type="button" className="client-row" data-selected={selectedJob?.id === item.id || undefined} aria-label={`${operationName(item.operation)} · ${item.state} · ${item.id.slice(0, 8)}`}
            onClick={async () => { try { setSelectedJob(await clientCall("client_job_get", { id: item.id })); } catch { setActionError("Exact job inspection unavailable. The last observation is retained."); } }}>
            <JobSummary job={item} now={now} />
          </button>
          {selectedJob?.id === item.id ? <JobDetails job={selectedJob} /> : null}
        </li>)}</ul>
        {selectedJob && !snapshot.jobs.some(item => item.id === selectedJob.id) ? <JobDetails job={selectedJob} /> : null}
      </PanelBody>
    </Panel> : null}
  </ClientShell>;
}
