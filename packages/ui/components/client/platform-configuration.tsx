"use client";

import { useState } from "react";
import type { ClientOutput, PlatformConfiguration } from "@stack/client/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ClientCallError, clientCall } from "@/lib/client/channel";

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
  return <section aria-labelledby="configuration-title" className="flex flex-col gap-4">
    <h2 id="configuration-title" className="text-lg font-medium">Local server setup</h2>
    <p className="text-sm text-muted-foreground">Saved revision {observed.revision} · {observed.pending ? "Application pending" : "No pending configuration"}. Applies on next start. This never starts or restarts the platform.</p>
    <p className="text-sm text-muted-foreground">Certificates, Tailscale joining and ACLs are operator-provisioned. No cert commands, Serve/Funnel or sudo run here. Blank ports remain unset; omitting Access disables remote ingress.</p>
    <details><summary className="cursor-pointer font-medium">Edit ports and Access/TLS</summary>
      <form onSubmit={event => void save(event)} className="mt-4 flex flex-col gap-5">
        <FieldSet disabled={frozen}><FieldLegend>Optional local ports</FieldLegend><FieldGroup className="client-fields">
          {ports.map(key => <Field key={key}><FieldLabel htmlFor={`port-${key}`}>{labels[key]} port</FieldLabel><Input id={`port-${key}`} type="number" min={1} max={65535} step={1} value={portValues[key]} onChange={event => setPortValues({ ...portValues, [key]: event.target.value })} /></Field>)}
        </FieldGroup></FieldSet>
        <Field orientation="horizontal" data-disabled={frozen}><Switch id="access-enabled" checked={accessEnabled} disabled={frozen} onCheckedChange={setAccessEnabled} /><FieldLabel htmlFor="access-enabled">Configure direct-tailnet Access</FieldLabel></Field>
        {accessEnabled ? <FieldSet disabled={frozen}><FieldLegend>Operator-provisioned Access/TLS</FieldLegend><FieldGroup>
          {accessFields.map(key => <Field key={key}><FieldLabel htmlFor={`access-${key}`}>{labels[key]}</FieldLabel><Input id={`access-${key}`} type={key === "artifactPort" ? "number" : "text"} min={key === "artifactPort" ? 1 : undefined} max={key === "artifactPort" ? 65535 : undefined} required value={accessValues[key]} onChange={event => setAccessValues({ ...accessValues, [key]: event.target.value })} autoComplete="off" spellCheck={false} />
            {key === "tlsKey" ? <FieldDescription>Paths only. Certificate and key contents never enter this page.</FieldDescription> : null}</Field>)}
        </FieldGroup></FieldSet> : null}
        <p className="text-sm text-muted-foreground">Draft based on revision {draft.revision}. Changes elsewhere do not overwrite your inputs.</p>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={frozen || draft.revision !== observed.revision}>Save configuration</Button>
          <Button type="button" variant="outline" disabled={busy || disabled} onClick={load}>Load observed configuration</Button></div>
      </form>
    </details>
    {draft.revision !== observed.revision ? <Alert><AlertTitle>Configuration revision changed</AlertTitle><AlertDescription>Your draft is retained. Inspect the current configuration, then explicitly load it before saving.</AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive"><AlertTitle>Configuration not confirmed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {status ? <p role="status" className="text-sm">{status}</p> : null}
    <Button variant="outline" disabled={busy || disabled} onClick={() => void refresh()}>Inspect configuration snapshot</Button>
  </section>;
}
