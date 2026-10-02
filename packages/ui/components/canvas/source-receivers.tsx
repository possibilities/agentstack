"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, ListIcon, RadioTowerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { receiverFacts, targetKinds, targetLabel, type ReceiverFact } from "@/lib/stack/source";
import type { GithubEndpoint, GithubSetup } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Empty, Flash, NodeCard, NodeTitle, StatusDot } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { Capacity, sourceChip, sourceHint, sourceLabel, sourceUnavailable, Stamp, Word } from "./source-shared";
import { Section, Window } from "./window";

/**
 * Where deliveries come from. Intake and capacity first, then each receiver as separate facts: a receiver saved
 * locally is not published, published is not configured at GitHub, a request is not an arrival, and one signed
 * arrival is not coverage. Read-only in this view: nothing here creates, edits, reveals or applies.
 */
export function ReceiversWindow() {
  const { flash } = useWorkbench();
  const { status, endpoints, sourceStatus, sourceEndpoints } = useStack();
  const [open, setOpen] = useState<string | null>(null);
  const list = sourceEndpoints.data;
  const intake = sourceStatus.data;
  // A link to a receiver opens its setup facts.
  useEffect(() => {
    if (flash?.key.startsWith("github-receiver:")) setOpen(flash.key.slice("github-receiver:".length));
  }, [flash?.seq, flash?.key]);
  const unavailable = sourceUnavailable(endpoints, status);
  return (
    <Window id="source-receivers" title="Receivers" icon={RadioTowerIcon} accent="source" count={list?.length ?? null}
      status={endpoints.source ? status.source : undefined} endpoint={endpoints.source} updatedAt={sourceEndpoints.at ?? sourceStatus.at}
      error={sourceEndpoints.error ?? sourceStatus.error} empty={!endpoints.source}>
      {!endpoints.source ? <Empty icon={RadioTowerIcon} title="Source isn't served by this server" /> : (
        <>
          <Section title="Intake">
            {intake ? (
              <dl className="flex flex-col gap-1 px-0.5 text-[0.76rem]">
                <Fact label="Loopback listener"><span className="font-mono text-[0.72rem]">{intake.ingress.host}:{intake.ingress.port}</span></Fact>
                <Fact label="Route"><span className="font-mono text-[0.72rem]">{intake.ingress.route}</span></Fact>
                <Fact label="Body limit"><span className="tabular-nums">{(intake.ingress.maxBodyBytes / 1024 / 1024).toLocaleString("en-US")} MiB</span></Fact>
                <Fact label="Newest arrival"><span className="tabular-nums">{intake.latestSequence ? `#${intake.latestSequence}` : "none yet"}</span></Fact>
                <Fact label="Receivers · watches"><span className="tabular-nums">{intake.endpoints} · {intake.watches}</span></Fact>
              </dl>
            ) : <p className={sourceHint}>{sourceStatus.error ? `Status unavailable: ${sourceStatus.error}` : "Reading intake…"}</p>}
            <Capacity status={intake} endpoints={list} />
            <p className={sourceHint}>Only signed webhook requests reach the loopback listener, and only the webhook path should be published. A tailnet-only address cannot receive GitHub Cloud webhooks.</p>
          </Section>
          <Section title="Receivers" aside={list ? <span className="text-[0.68rem] text-muted-foreground tabular-nums">{list.length}</span> : null}>
            {!list ? <Empty icon={RadioTowerIcon} title={unavailable ?? "Reading receivers…"} />
              : !list.length ? <Empty icon={RadioTowerIcon} title="No receivers" hint="A receiver is created through the Package API (github_endpoint_create). This view reads them; it does not create or change one." />
              : (
                <ul className="flex flex-col gap-2">
                  {list.map((endpoint) => <ReceiverRow key={endpoint.id} endpoint={endpoint} open={open === endpoint.id} onToggle={() => setOpen(open === endpoint.id ? null : endpoint.id)} />)}
                </ul>
              )}
          </Section>
        </>
      )}
    </Window>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex min-h-5 items-baseline gap-3"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="ml-auto min-w-0 truncate text-right">{children}</dd></div>;
}

function ReceiverRow({ endpoint, open, onToggle }: { endpoint: GithubEndpoint; open: boolean; onToggle(): void }) {
  const node = { kind: "github-receiver" as const, id: endpoint.id };
  const detail = `receiver-${endpoint.id}-setup`;
  const refused = endpoint.lastFailure !== null;
  return (
    <li data-node={`github-receiver:${endpoint.id}`} className="relative">
      <Flash id={`github-receiver:${endpoint.id}`} />
      <NodeCard node={node} label={endpoint.label}>
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={endpoint.enabled ? "success" : "muted"} label={endpoint.enabled ? "Enabled" : "Disabled"} />
          <NodeTitle node={node} label={endpoint.label} className="min-w-0 truncate text-[0.82rem] font-semibold">{endpoint.label}</NodeTitle>
          <span className={cn(sourceChip, "ml-auto shrink-0")}>{endpoint.enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[0.72rem] text-muted-foreground">
          <span>{targetKinds[endpoint.target.kind]}</span>
          {targetLabel(endpoint.target) !== targetKinds[endpoint.target.kind] ? <span className="min-w-0 truncate font-mono text-foreground" title={targetLabel(endpoint.target)}>{targetLabel(endpoint.target)}</span> : <span>any {endpoint.target.kind === "app" ? "installation" : "account"}</span>}
          {endpoint.githubHost !== "github.com" ? <span className="font-mono">{endpoint.githubHost}</span> : null}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.72rem]">
          <dt className="text-muted-foreground">Last delivery</dt>
          <dd className="text-right">{endpoint.lastDeliveryAt ? <Stamp at={endpoint.lastDeliveryAt} /> : <span className="text-muted-foreground">none observed</span>}</dd>
          <dt className="text-muted-foreground">Last ping</dt>
          <dd className="text-right">{endpoint.lastPingAt ? <Stamp at={endpoint.lastPingAt} /> : <span className="text-muted-foreground">none observed</span>}</dd>
        </dl>
        <dl aria-label="Request counts" className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-center text-[0.68rem]">
          {([["Accepted", endpoint.accepted, false], ["Duplicate", endpoint.duplicates, false], ["Rejected", endpoint.rejected, endpoint.rejected > 0]] as const).map(([label, value, attention]) => (
            <div key={label} className="flex flex-col"><dd className={cn("text-[0.84rem] font-semibold tabular-nums", attention && "text-warning")}>{value.toLocaleString("en-US")}</dd><dt className="text-muted-foreground">{label}</dt></div>
          ))}
        </dl>
        {refused ? <p role="status" className="flex flex-wrap gap-x-1.5 text-[0.7rem] text-warning"><span className="font-medium">Last refusal</span><code className="font-mono break-all">{endpoint.lastFailure}</code></p> : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <ShowDeliveries id={endpoint.id} />
          <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={detail}
            className="ml-auto inline-flex items-center gap-1 rounded-sm text-[0.72rem] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}Setup facts
          </button>
        </div>
        {open ? <div id={detail}><Setup endpoint={endpoint} /></div> : null}
      </NodeCard>
    </li>
  );
}

/** A fresh Deliveries session for this receiver, in the ledger beside it. */
function ShowDeliveries({ id }: { id: string }) {
  const store = useStore();
  const { setSpace } = useWorkbench();
  const { status } = useStack();
  return (
    <Button size="xs" variant="outline" disabled={status.source !== "open"} onClick={() => { store.applySourceFilter({ endpointIds: [id] }); setSpace("source"); }}>
      <ListIcon data-icon="inline-start" />Show deliveries
    </Button>
  );
}

function Setup({ endpoint }: { endpoint: GithubEndpoint }) {
  const store = useStore();
  const { sourceSetups } = useStack();
  const held = sourceSetups[endpoint.id];
  useEffect(() => { void store.loadSourceSetup(endpoint.id); }, [store, endpoint.id, endpoint.revision]);
  const setup: GithubSetup | null = held?.data ?? null;
  const facts = receiverFacts(endpoint, setup);
  return (
    <div className="flex flex-col gap-3 border-t pt-2.5">
      <ol aria-label="Five separate facts" className="flex flex-col gap-2">
        {facts.map((fact, index) => <FactRow key={fact.id} fact={fact} index={index + 1} />)}
      </ol>
      {held?.error ? <p role="alert" className="text-[0.72rem] text-destructive">Setup read failed: {held.error}</p> : null}
      {!setup && !held?.error ? <p className={sourceHint}>Reading setup…</p> : null}
      {setup ? (
        <>
          {setup.blockers.length ? (
            <div className="flex flex-col gap-1">
              <span className={sourceLabel}>Blocked until</span>
              <ul className="flex flex-col gap-0.5 text-[0.72rem]">{setup.blockers.map((blocker) => <li key={blocker} className="flex gap-1.5"><StatusDot tone="warning" /><span>{blockerWords[blocker] ?? blocker}</span></li>)}</ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <span className={sourceLabel}>Where it points</span>
            <Destination label="Loopback destination" value={setup.ingress.localUrl} />
            {endpoint.webhookUrl ? <Destination label="Webhook URL" value={endpoint.webhookUrl} /> : null}
            <Destination label="GitHub settings page" value={setup.settingsUrl} />
            <p className={sourceHint}>Shown as text; nothing here opens a link or contacts GitHub.</p>
          </div>
          <details className="group rounded-lg border border-dashed">
            <summary className="flex cursor-pointer items-center justify-between px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <span>Setup steps</span><span className="tabular-nums">{setup.steps.length}</span>
            </summary>
            <ol className="flex flex-col gap-2 border-t border-dashed p-2.5">
              {setup.steps.map((step, index) => (
                <li key={step.id} className="flex flex-col gap-0.5 text-[0.72rem]">
                  <span className="flex items-baseline gap-2"><span className="tabular-nums text-muted-foreground">{index + 1}</span><span className="font-medium">{step.title}</span>
                    <span className={cn(sourceChip, "ml-auto shrink-0")}>{step.state}</span></span>
                  <span className="pl-4 text-pretty text-muted-foreground">{step.detail}</span>
                </li>
              ))}
            </ol>
          </details>
          <details className="group rounded-lg border border-dashed">
            <summary className="flex cursor-pointer items-center justify-between px-2.5 py-1.5 text-[0.72rem] text-muted-foreground select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <span>What this does not promise</span><span className="tabular-nums">{setup.limitations.length}</span>
            </summary>
            <ul className="flex flex-col gap-1.5 border-t border-dashed p-2.5 text-[0.72rem] text-pretty text-muted-foreground">
              {setup.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
            </ul>
          </details>
        </>
      ) : null}
    </div>
  );
}

const blockerWords: Record<string, string> = { receiver_disabled: "The receiver is disabled, so new requests are rejected.", public_https_origin_unset: "No public HTTPS origin is set, so GitHub's cloud has nowhere to send requests." };

function FactRow({ fact, index }: { fact: ReceiverFact; index: number }) {
  return (
    <li className="flex flex-col gap-0.5 text-[0.72rem]">
      <div className="flex items-baseline gap-2">
        <span className="w-3 shrink-0 text-right tabular-nums text-muted-foreground">{index}</span>
        <span className="font-medium">{fact.title}</span>
        <Word tone={fact.tone} className="ml-auto text-[0.72rem]">{fact.word}</Word>
      </div>
      <ul className="flex flex-col gap-0.5 pl-5 text-pretty break-words text-muted-foreground">{fact.lines.map((line) => <li key={line}>{line}</li>)}</ul>
    </li>
  );
}

function Destination({ label, value }: { label: string; value: string }) {
  return (
    <div className="group/row flex min-w-0 items-center gap-2 text-[0.72rem]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ml-auto min-w-0 truncate font-mono text-[0.68rem]" title={value}>{value}</span>
      <CopyButton value={value} label={label.toLowerCase()} className="-mr-1.5" />
    </div>
  );
}
