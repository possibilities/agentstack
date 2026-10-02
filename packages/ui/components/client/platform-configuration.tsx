"use client";

import { useState } from "react";
import type { ClientOutput, PlatformConfiguration } from "@stack/client/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ClientCallError, clientCall } from "@/lib/client/channel";
import { CircleAlertIcon, CircleXIcon } from "lucide-react";
import { Panel, PanelBody, PanelTitle, StatusDot } from "./parts";

const ports = ["ui", "websocket", "mcp", "inspector", "documents", "artifacts", "brain"] as const;
const accessFields = ["host", "deviceOrigin", "artifactPort", "uiOrigin", "tlsCert", "tlsKey"] as const;
const labels = { ui: "Local UI", websocket: "WebSocket", mcp: "MCP", inspector: "Inspector", documents: "Documents", artifacts: "Artifacts", brain: "Brain",
  host: "Direct Tailscale IP", deviceOrigin: "Device HTTPS origin", artifactPort: "Access artifact port", uiOrigin: "UI HTTPS origin", tlsCert: "TLS certificate path", tlsKey: "TLS key path" };
type Saved = ClientOutput<"client_snapshot">["configuration"];
export function PlatformConfigurationForm({ observed, disabled, refresh }: { observed: Saved; disabled: boolean; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => observed);
  const [portValues, setPortValues] = useState(() => Object.fromEntries(ports.map(key => [key, String(observed.saved.ports?.[key] ?? "")])));
  const [accessValues, setAccessValues] = useState(() => Object.fromEntries(accessFields.map(key => [key, String(observed.saved.access?.[key] ?? "")])));
  const [accessEnabled, setAccessEnabled] = useState(!!observed.saved.access);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const load = () => {
    setDraft(observed); setPortValues(Object.fromEntries(ports.map(key => [key, String(observed.saved.ports?.[key] ?? "")])));
    setAccessValues(Object.fromEntries(accessFields.map(key => [key, String(observed.saved.access?.[key] ?? "")])));
    setAccessEnabled(!!observed.saved.access); setError(null); setStatus(null); setUncertain(false);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || disabled || uncertain) return;
    const selected = Object.fromEntries(ports.filter(key => portValues[key] !== "").map(key => [key, Number(portValues[key])]));
    const configuration: PlatformConfiguration = { ...(Object.keys(selected).length ? { ports: selected } : {}),
      ...(accessEnabled ? { access: { host: accessValues.host!, deviceOrigin: accessValues.deviceOrigin!, artifactPort: Number(accessValues.artifactPort),
        uiOrigin: accessValues.uiOrigin!, tlsCert: accessValues.tlsCert!, tlsKey: accessValues.tlsKey! } } : {}) };
    setBusy(true); setError(null); setStatus(null);
    try {
      const output = await clientCall("client_platform_configure", { expectedRevision: draft.revision, configuration });
      setDraft({ revision: output.revision, saved: configuration, pending: true });
      setStatus(`Saved configuration revision ${output.revision}. Applies on next start; nothing was restarted.`);
    } catch (error) {
      if (error instanceof ClientCallError && error.code === "revision_conflict") setError(error.message);
      else if (error instanceof ClientCallError && !error.uncertain) setError("Configuration was refused. Check ports, exact HTTPS origins, distinct Access ports and absolute TLS paths. Your draft is retained.");
      else { setUncertain(true); setError("Configuration save is uncertain. Your exact draft and revision are frozen. Inspect the current snapshot, then deliberately load the observed configuration before another save."); }
    } finally { setBusy(false); await refresh(); }
  };
  const frozen = disabled || busy || uncertain;
  const changed = draft.revision !== observed.revision;
  return <Panel labelledBy="configuration-title">
    <PanelBody>
      <PanelTitle id="configuration-title" description="Optional ports and direct-tailnet Access. Saved changes apply on the next start; saving never starts or restarts the platform."
        aside={<Button variant="outline" size="sm" disabled={busy || disabled} onClick={() => void refresh()}>Inspect configuration snapshot</Button>}>Local server setup</PanelTitle>
      <p className="client-setting-state"><StatusDot tone={observed.pending ? "attention" : "muted"} />Saved revision {observed.revision} · {observed.pending ? "Application pending" : "No pending configuration"}</p>
      <details className="client-disclosure client-disclosure-form"><summary>Edit ports and Access/TLS</summary>
        <form onSubmit={event => void save(event)} className="flex flex-col gap-6 pt-4">
          <FieldSet disabled={frozen} className="gap-3">
            <FieldLegend variant="label" className="mb-0">Ports <span className="font-normal text-muted-foreground">(optional)</span></FieldLegend>
            <FieldDescription>Leave a port blank to keep it unset and use the default.</FieldDescription>
            <div className="client-ports">
              {ports.map(key => <Field key={key} className="gap-1.5"><FieldLabel htmlFor={`port-${key}`} className="text-xs font-normal text-muted-foreground">{labels[key]} port</FieldLabel><Input id={`port-${key}`} type="number" inputMode="numeric" min={1} max={65535} step={1} placeholder="Default" className="font-mono tabular-nums" value={portValues[key]} onChange={event => setPortValues({ ...portValues, [key]: event.target.value })} /></Field>)}
            </div>
          </FieldSet>
          <div className="client-optional-group" data-enabled={accessEnabled || undefined}>
            <Field orientation="horizontal" data-disabled={frozen} className="items-start"><Switch id="access-enabled" checked={accessEnabled} disabled={frozen} onCheckedChange={setAccessEnabled} className="mt-0.5" />
              <div className="flex flex-col gap-1"><FieldLabel htmlFor="access-enabled">Configure direct-tailnet Access</FieldLabel>
                <FieldDescription>Optional. Off disables remote ingress. Certificates, Tailscale joining and ACLs are operator-provisioned; nothing here runs cert commands, Serve/Funnel or sudo.</FieldDescription></div></Field>
            {accessEnabled ? <FieldSet disabled={frozen} className="gap-3"><FieldLegend variant="label" className="mb-0">Operator-provisioned Access/TLS</FieldLegend><div className="client-access-fields">
              {accessFields.map(key => <Field key={key} className="gap-1.5"><FieldLabel htmlFor={`access-${key}`} className="text-xs font-normal text-muted-foreground">{labels[key]}</FieldLabel><Input id={`access-${key}`} type={key === "artifactPort" ? "number" : "text"} min={key === "artifactPort" ? 1 : undefined} max={key === "artifactPort" ? 65535 : undefined} required value={accessValues[key]} onChange={event => setAccessValues({ ...accessValues, [key]: event.target.value })} autoComplete="off" spellCheck={false} className="font-mono" /></Field>)}
            </div><FieldDescription>Paths only. Certificate and key contents never enter this page.</FieldDescription></FieldSet> : null}
          </div>
          <div className="flex flex-col gap-2 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={frozen || changed}>Save configuration</Button>
              <Button type="button" variant="outline" disabled={busy || disabled} onClick={load}>Load observed configuration</Button></div>
            <p className="text-xs text-muted-foreground">Draft based on revision {draft.revision}. Changes elsewhere do not overwrite your inputs.</p>
          </div>
        </form>
      </details>
      {changed ? <Alert><CircleAlertIcon /><AlertTitle>Configuration revision changed</AlertTitle><AlertDescription>Your draft is retained. Inspect the current configuration, then explicitly load it before saving.</AlertDescription></Alert> : null}
      {error ? <Alert variant="destructive"><CircleXIcon /><AlertTitle>Configuration not confirmed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {status ? <p role="status" className="text-sm">{status}</p> : null}
    </PanelBody>
  </Panel>;
}
