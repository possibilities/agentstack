"use client";

import { useId, useState } from "react";
import { GaugeIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { accountLabels, providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import type { UsageAccount, UsageObservation } from "@/lib/stack/types";
import { Empty, NodeCard, NodeTitle, Row, Time } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { Window } from "./window";

const percent = (value: number | null) => value === null ? "Not reported" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const dollars = (value: number | null) => value === null ? "Not reported" : value.toLocaleString(undefined, { style: "currency", currency: "USD" });
const observationStatus = (observation: UsageObservation, now: number) => observation.observedAtMs === null ? "Not observed"
  : observation.fresh && now - observation.observedAtMs <= 5 * 60_000 ? "Fresh" : "Stale";

export function ObservationStatus({ observation }: { observation: UsageObservation }) {
  const now = useNow(30_000);
  const status = observationStatus(observation, now);
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={status === "Fresh" ? "secondary" : "outline"}>{status}</Badge>
        <span>Observed <Time at={observation.observedAtMs} /></span>
      </div>
      {observation.error ? <Alert variant="destructive"><AlertDescription>{observation.error}. {observation.observedAtMs !== null ? "Showing the last good measurement." : "No measurement available."}</AlertDescription></Alert> : null}
      {observation.lastAttemptAtMs !== observation.observedAtMs ? <span>Last attempt <Time at={observation.lastAttemptAtMs} /></span> : null}
    </div>
  );
}

function Remaining({ label, value, reset }: { label: string; value: number | null; reset?: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between gap-2 text-xs"><span>{label}</span><span className="tabular-nums">{percent(value)} remaining</span></div>
      {value !== null ? <meter className="h-2 w-full" min={0} max={100} value={Math.max(0, Math.min(100, value))} aria-label={`${label} remaining`} /> : null}
      {reset ? <p className="text-xs text-muted-foreground">Resets <time dateTime={reset}>{reset}</time></p> : null}
    </div>
  );
}

function UsageSummary({ account }: { account: UsageAccount }) {
  if (!account.usage) return <p className="text-xs text-muted-foreground">No measurement yet.</p>;
  if (account.provider === "codex") return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{account.usage.planType ?? "Plan not reported"}{account.usage.limitReached ? " · limit reached" : ""}</p>
      {account.usage.lanes.map((lane) => <div key={lane.id} className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{lane.title}</h4>
        {lane.windows.map((window, index) => <Remaining key={`${window.role}:${index}`} label={window.label} value={window.remainingPercent} reset={window.resetsAt} />)}
      </div>)}
      <dl><Row label="Reset credits">{account.usage.resetCreditsAvailable ?? "Not reported"}</Row></dl>
    </div>
  );
  if (account.provider === "grok") return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{account.usage.subscriptionTier ?? "Plan not reported"}</p>
      <Remaining label="Included usage" value={account.usage.included.remainingPercent} reset={account.usage.included.resetsAt} />
      <dl>
        <Row label="Monthly allocation">{dollars(account.usage.included.allocatedUsd)}</Row>
        <Row label="Prepaid balance">{dollars(account.usage.prepaidBalanceUsd)}</Row>
        <Row label="PAYG used / cap">{dollars(account.usage.paygUsedUsd)} / {dollars(account.usage.paygCapUsd)}</Row>
        <Row label="PAYG remaining">{dollars(account.usage.paygRemainingUsd)}</Row>
      </dl>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{account.usage.planLabel ?? "Plan not reported"}</p>
      <Remaining label="Daily" value={account.usage.dailyRemainingPercent} reset={account.usage.dailyResetsAt} />
      <Remaining label="Weekly" value={account.usage.weeklyRemainingPercent} reset={account.usage.weeklyResetsAt} />
      {account.usage.weeklyQuotaHidden ? <p className="text-xs text-muted-foreground">Provider hides the weekly quota.</p> : null}
      <dl><Row label="Prompt credits available">{account.usage.promptCreditsAvailable ?? "Not reported"}</Row><Row label="Monthly prompt credits">{account.usage.promptCreditsMonthly ?? "Not reported"}</Row></dl>
    </div>
  );
}

export function UsageWindow() {
  const { usage, accounts, workerAccounts, status, endpoints } = useStack();
  const store = useStore();
  const [query, setQuery] = useState("");
  const id = useId();
  const now = useNow(30_000);
  const botLabels = accountLabels(accounts.data);
  const workerLabels = workerAccountLabels(workerAccounts.data);
  const label = (account: UsageAccount) => (account.scope === "bot" ? botLabels : workerLabels).get(account.id) ?? shortId(account.id);
  const match = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const shown = usage.data?.accounts.filter((account) => match(`${label(account)} ${account.id} ${account.provider} ${account.scope} ${observationStatus(account, now)} ${account.enabled ? "enabled" : "disabled"} ${account.ready ? "ready" : "needs sign-in"} ${account.error ?? ""}`)) ?? [];
  const grokBot = usage.data?.grokBot;
  const showGrokBot = grokBot && match(`grok bot machine CLI ${observationStatus(grokBot, now)} ${grokBot.error ?? ""}`);
  return (
    <Window id="usage" title="Usage" subtitle="usage · provider observations" icon={GaugeIcon} accent="owner" node={{ kind: "usage" }}
      count={usage.data ? usage.data.accounts.length + 1 : undefined} status={status.usage} endpoint={endpoints.usage} updatedAt={usage.at} error={usage.error}
      actions={<Button variant="ghost" size="icon-xs" aria-label="Re-read usage snapshot" disabled={status.usage !== "open"} onClick={store.reloadUsage}><RefreshCwIcon /></Button>}>
      <p className="text-xs text-muted-foreground">Provider observations, not dispatch eligibility. Re-read fetches the owner’s latest snapshot; collection runs on its own schedule.</p>
      {usage.error ? <Alert variant="destructive"><AlertDescription>{usage.error}</AlertDescription></Alert> : null}
      {usage.data?.inventoryError ? <Alert variant="destructive"><AlertDescription>Account inventory: {usage.data.inventoryError}. Last inventory <Time at={usage.data.inventoryAtMs} />.</AlertDescription></Alert> : null}
      <Field><FieldLabel htmlFor={id}>Filter usage</FieldLabel><Input id={id} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Account, provider, scope, or status…" /></Field>
      <div data-scroll className="flex max-h-[42rem] flex-col gap-3 overflow-y-auto overscroll-contain">
        {shown.map((account) => {
          const node = { kind: "usage-account" as const, id: `${account.scope}:${account.id}` };
          return <NodeCard key={node.id} node={node} label={`${label(account)} usage`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><NodeTitle node={node} label={`${label(account)} usage`} className="text-sm font-medium">{label(account)}</NodeTitle><span className="text-xs text-muted-foreground">{providerTitle(account.provider)} · {account.scope}</span></div>
            <div className="flex gap-2"><Badge variant="outline">{account.enabled ? "Enabled" : "Disabled"}</Badge>{!account.ready ? <Badge variant="outline">Needs sign-in</Badge> : null}</div>
            <ObservationStatus observation={account} />
            <UsageSummary account={account} />
          </NodeCard>;
        })}
        {grokBot && showGrokBot ? <NodeCard node={{ kind: "grok-bot-usage" }} label="Grok Bot usage">
          <NodeTitle node={{ kind: "grok-bot-usage" }} label="Grok Bot usage" className="text-sm font-medium">Grok Bot · machine login</NodeTitle>
          <p className="text-xs text-muted-foreground">Separate Grok CLI login; not a Worker account.</p>
          <ObservationStatus observation={grokBot} />
          {grokBot.usage ? <dl><Row label="Used">{percent(grokBot.usage.usedPercent)}</Row><Row label="Plan">{grokBot.usage.planLabel ?? "Not reported"}</Row><Row label="Resets">{grokBot.usage.resetsAt}</Row></dl> : null}
        </NodeCard> : null}
        {!shown.length && !showGrokBot ? <Empty icon={GaugeIcon} title={usage.data ? "No matching observations" : "Usage unavailable"}>{usage.data ? "Try another filter." : "Waiting for a usage snapshot."}</Empty> : null}
      </div>
    </Window>
  );
}
