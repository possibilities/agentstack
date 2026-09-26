"use client";

import { GaugeIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountLabels, shortId, untilTime, usageRows, workerAccountLabels } from "@/lib/stack/derive";
import { nodeKey, type NodeRef, type UsageAccount, type UsageObservation, type UsageSnapshot } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Empty, headroomTone, Meter, NodeCard, NodeTitle, Orb, StatusDot, Time } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { Window } from "./window";

/**
 * A gauge's group is the set of windows that gate the same quota: an exhausted
 * window blocks its siblings unless it is local, gating only its own model.
 */
type Gauge = { label: string; remaining: number | null; resetsAt: string | null; group: string; local?: boolean;
  inspect?: { node: NodeRef; label: string } };
type Summary = { plan: string | null; limited: boolean; gauges: Gauge[]; notes: string[] };

const money = (value: number) => value.toLocaleString(undefined, { style: "currency", currency: "USD" });
/** Every gauge is remaining headroom, whichever direction the provider reports. */
const pct = (value: number) => `${Math.round(value)}%`;
const freshWindow = 5 * 60_000;
const grokBotNode: NodeRef = { kind: "grok-bot-usage" };
/** An exhausted window is a limit, like Codex's own limit flag. */
const exhausted = (gauges: Gauge[]) => gauges.some((gauge) => gauge.remaining === 0);
/** The exhausted sibling that makes a gauge's remaining headroom unusable, if any. */
const blockedBy = (gauge: Gauge, gauges: Gauge[]) => gauge.remaining === 0 ? undefined
  : gauges.find((other) => other !== gauge && other.group === gauge.group && !other.local && other.remaining === 0);

function freshness(observation: UsageObservation, now: number): "fresh" | "stale" | "never" {
  if (observation.observedAtMs === null) return "never";
  return observation.fresh && now - observation.observedAtMs <= freshWindow ? "fresh" : "stale";
}

function summarize(account: UsageAccount): Summary | null {
  if (!account.usage) return null;
  if (account.provider === "codex") {
    const usage = account.usage;
    const lanes = usage.lanes;
    return {
      plan: usage.planType,
      limited: usage.limitReached === true,
      gauges: lanes.flatMap((lane) => lane.windows.map((window) => ({
        label: lanes.length > 1 ? `${lane.title} · ${window.label}` : window.label,
        remaining: window.remainingPercent,
        resetsAt: window.resetsAt,
        group: lane.id,
      }))),
      notes: usage.resetCreditsAvailable ? [`${usage.resetCreditsAvailable} reset credit${usage.resetCreditsAvailable === 1 ? "" : "s"}`] : [],
    };
  }
  if (account.provider === "grok") {
    const usage = account.usage;
    const notes: string[] = [];
    if (usage.included.allocatedUsd !== null) notes.push(`${money(usage.included.allocatedUsd)} included`);
    if (usage.prepaidBalanceUsd) notes.push(`${money(usage.prepaidBalanceUsd)} prepaid`);
    if (usage.paygEnabled || usage.paygUsedUsd) notes.push(`PAYG ${money(usage.paygUsedUsd ?? 0)}${usage.paygCapUsd ? ` / ${money(usage.paygCapUsd)}` : ""}`);
    const gauges = [{ label: usage.included.periodType ?? "included", remaining: usage.included.remainingPercent, resetsAt: usage.included.resetsAt, group: "included" }];
    // Pay-as-you-go continues past the included allocation.
    return { plan: usage.subscriptionTier, limited: !usage.paygEnabled && exhausted(gauges), gauges, notes };
  }
  if (account.provider === "claude") {
    const usage = account.usage;
    const extra = usage.extraUsage;
    const notes: string[] = [];
    // Extra-usage credits and limits are provider units, not dollars.
    if (extra?.enabled) notes.push(`extra usage ${extra.usedCredits?.toLocaleString() ?? "?"}${extra.monthlyLimit !== null ? ` / ${extra.monthlyLimit.toLocaleString()}` : ""} credits`);
    else if (extra?.enabled === false) notes.push("extra usage off");
    // The 5h and weekly windows gate every model; a per-model weekly window gates only its model.
    const gauges = usage.windows.map((window) => ({ label: window.label, remaining: window.remainingPercent, resetsAt: window.resetsAt,
      group: "claude", local: window.id !== "five_hour" && window.id !== "seven_day" }));
    return { plan: null, limited: exhausted(gauges), gauges, notes };
  }
  const usage = account.usage;
  const gauges: Gauge[] = [];
  if (usage.dailyRemainingPercent !== null) gauges.push({ label: "daily", remaining: usage.dailyRemainingPercent, resetsAt: usage.dailyResetsAt, group: "devin" });
  if (usage.weeklyRemainingPercent !== null) gauges.push({ label: "weekly", remaining: usage.weeklyRemainingPercent, resetsAt: usage.weeklyResetsAt, group: "devin" });
  const notes: string[] = [];
  if (usage.weeklyQuotaHidden) notes.push("weekly quota hidden");
  // Devin reports -1 when an account has no prompt-credit budget.
  const credits = (value: number | null) => value !== null && value >= 0 ? value : null;
  const available = credits(usage.promptCreditsAvailable);
  const monthly = credits(usage.promptCreditsMonthly);
  if (available !== null) notes.push(`${available}${monthly !== null ? ` / ${monthly}` : ""} credits`);
  return { plan: usage.planLabel, limited: exhausted(gauges), gauges, notes };
}

type GrokBot = UsageSnapshot["grokBot"];

function grokBotSummary(usage: NonNullable<GrokBot["usage"]>, label: string): Summary {
  return {
    plan: usage.planLabel,
    limited: !usage.hasAvailableUsage,
    gauges: [{ label, remaining: Math.max(0, 100 - usage.usedPercent), resetsAt: usage.resetsAt, group: "grok-bot", inspect: { node: grokBotNode, label: "Grok Bot usage" } }],
    notes: usage.onDemandEnabled ? [`${label} on-demand on`] : [],
  };
}

/** The Grok Worker login's card also carries the machine's Grok Bot usage. */
function withGrokBot(summary: Summary, usage: NonNullable<GrokBot["usage"]>): Summary {
  const bot = grokBotSummary(usage, "bot");
  return { plan: summary.plan ?? bot.plan, limited: summary.limited || bot.limited,
    gauges: [...summary.gauges, ...bot.gauges], notes: [...summary.notes, ...bot.notes] };
}

/** One freshness signal for a merged card: a failed read, then a stale one, wins. */
function worstObservation(a: UsageObservation, b: UsageObservation): UsageObservation {
  const rank = (observation: UsageObservation) => observation.error ? 2 : observation.fresh && observation.observedAtMs !== null ? 0 : 1;
  return rank(b) > rank(a) ? b : a;
}

/** Observation age and last error, shown in the inspector. */
export function ObservationStatus({ observation }: { observation: UsageObservation }) {
  const now = useNow(30_000);
  const state = freshness(observation, now);
  return (
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={state === "fresh" ? "secondary" : "outline"} className="capitalize">{state === "never" ? "Not observed" : state}</Badge>
        {observation.observedAtMs !== null ? <Time at={observation.observedAtMs} /> : null}
        {observation.lastAttemptAtMs !== observation.observedAtMs ? <span>· tried <Time at={observation.lastAttemptAtMs} /></span> : null}
      </div>
      {observation.error ? (
        <Alert variant="destructive"><AlertDescription>{observation.error}{observation.observedAtMs !== null ? " · showing last good read" : ""}</AlertDescription></Alert>
      ) : null}
    </div>
  );
}

function FreshnessDot({ observation }: { observation: UsageObservation }) {
  const now = useNow(30_000);
  const state = freshness(observation, now);
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} data-interactive="" className="relative z-10 inline-flex size-4 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring" />}>
        {observation.error ? <TriangleAlertIcon aria-label="Read failed" className="size-3.5 text-warning" /> : <StatusDot tone={state === "fresh" ? "success" : "muted"} label={state === "fresh" ? "Fresh" : "Stale"} className="size-1.5 [&>span]:size-1.5" />}
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col items-start gap-0.5">
        <span>{state === "fresh" ? "Fresh" : "Stale"} · <Time at={observation.observedAtMs} /></span>
        {observation.error ? <span className="opacity-70">{observation.error}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function UsageCard({ node, names, observation, summary, orbs }: {
  node: NodeRef;
  names: Array<{ node: NodeRef; label: string }>;
  observation: UsageObservation;
  summary: Summary;
  orbs: string[];
}) {
  const now = useNow(60_000);
  const headline = summary.gauges.reduce<number | null>((low, gauge) => gauge.remaining === null ? low : low === null ? gauge.remaining : Math.min(low, gauge.remaining), null);
  const tone = summary.limited ? "destructive" : headroomTone(headline);
  return (
    <NodeCard node={node} label={`${names[0].label} usage`} className="p-2.5">
      <div className="flex items-center gap-2">
        {orbs.length ? (
          <span className="flex shrink-0 -space-x-1.5">
            {orbs.map((id) => <Orb key={id} id={id} size="sm" className="ring-2 ring-card" />)}
          </span>
        ) : <GaugeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[0.8rem] leading-snug font-medium">
          {names.map((name, index) => (
            <span key={name.label} data-node={index ? nodeKey(name.node) : undefined} className={cn("min-w-0 break-all", index && "text-muted-foreground")}>
              <NodeTitle node={name.node} label={`${name.label} usage`}>{name.label}</NodeTitle>
            </span>
          ))}
        </span>
        <FreshnessDot observation={observation} />
        {summary.plan ? <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-[0.65rem] font-medium text-muted-foreground capitalize">{summary.plan}</span> : null}
        <span className={cn("ml-auto shrink-0 text-base leading-none font-semibold tracking-tight tabular-nums",
          tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-foreground")}>
          {summary.limited ? "Limit" : headline === null ? "—" : <>{pct(headline)}<span className="ml-0.5 text-[0.65rem] font-medium text-muted-foreground">left</span></>}
        </span>
      </div>
      {summary.gauges.length ? (
        <div className="flex flex-col gap-1.5">
          {summary.gauges.map((gauge) => {
            const blocker = blockedBy(gauge, summary.gauges);
            return (
            <div key={gauge.label} title={blocker ? `Unavailable until ${blocker.label} resets` : undefined}
              className="grid grid-cols-[3.75rem_1fr_auto_auto] items-center gap-2 text-[0.68rem] text-muted-foreground">
              {gauge.inspect ? (
                <span data-node={nodeKey(gauge.inspect.node)} className="truncate"><NodeTitle node={gauge.inspect.node} label={gauge.inspect.label}>{gauge.label}</NodeTitle></span>
              ) : <span className="truncate">{gauge.label}</span>}
              <Meter value={gauge.remaining} className={cn(blocker && "opacity-35")}
                label={`${names[0].label} ${gauge.label} remaining${blocker ? `, unavailable until ${blocker.label} resets` : ""}`} />
              <span className={cn("min-w-14 text-right whitespace-nowrap tabular-nums", blocker && "opacity-35")}>
                {gauge.remaining === null ? "—" : <><span className="text-foreground/80">{pct(gauge.remaining)}</span> left</>}
              </span>
              <span className="w-12 text-right tabular-nums" title={gauge.resetsAt ?? undefined}>
                {gauge.resetsAt ? untilTime(Date.parse(gauge.resetsAt), now) : "—"}
              </span>
            </div>
            );
          })}
        </div>
      ) : null}
      {summary.notes.length ? <p className="text-[0.68rem] text-muted-foreground">{summary.notes.join(" · ")}</p> : null}
    </NodeCard>
  );
}

export function UsageWindow() {
  const { usage, accounts, workerAccounts, status, endpoints } = useStack();
  const store = useStore();
  const botLabels = accountLabels(accounts.data);
  const workerLabels = workerAccountLabels(workerAccounts.data);
  const label = (account: UsageAccount) => (account.scope === "bot" ? botLabels : workerLabels).get(account.id) ?? shortId(account.id);
  const nodeOf = (account: UsageAccount): NodeRef => ({ kind: "usage-account", id: `${account.scope}:${account.id}` });
  const observed = usage.data?.accounts.filter((account) => account.usage) ?? [];
  const waiting = usage.data?.accounts.filter((account) => !account.usage) ?? [];
  const grokBot = usage.data?.grokBot;
  const rows = usageRows(observed);
  // Grok Bot folds into the card of the only Grok Worker login; otherwise it stands alone.
  const grokAccounts = usage.data?.accounts.filter((account) => account.provider === "grok") ?? [];
  const grokHost = grokBot?.usage && grokAccounts.length === 1 ? rows.find((row) => row[0] === grokAccounts[0]) ?? null : null;
  return (
    <Window id="usage" title="Usage" subtitle="usage" icon={GaugeIcon} accent="owner" node={{ kind: "usage" }}
      count={usage.data ? usage.data.accounts.length + 1 : undefined} status={status.usage} endpoint={endpoints.usage} updatedAt={usage.at} error={usage.error}
      actions={
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Re-read usage" disabled={status.usage !== "open"} onClick={store.reloadUsage} />}>
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">Re-read</TooltipContent>
        </Tooltip>
      }>
      {usage.error ? <Alert variant="destructive"><AlertDescription>{usage.error}</AlertDescription></Alert> : null}
      {usage.data?.inventoryError ? <Alert variant="destructive"><AlertDescription>Inventory {usage.data.inventoryError.replace("_", " ")} · <Time at={usage.data.inventoryAtMs} /></AlertDescription></Alert> : null}
      {usage.data ? (
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const bot = row === grokHost ? grokBot : null;
            return (
              <UsageCard key={`${row[0].scope}:${row[0].id}`} node={nodeOf(row[0])} observation={bot ? worstObservation(row[0], bot) : row[0]}
                summary={bot?.usage ? withGrokBot(summarize(row[0])!, bot.usage) : summarize(row[0])!}
                orbs={row.map((account) => account.id)} names={row.map((account) => ({ node: nodeOf(account), label: label(account) }))} />
            );
          })}
          {grokBot?.usage && !grokHost ? (
            <UsageCard node={grokBotNode} observation={grokBot} summary={grokBotSummary(grokBot.usage, "period")} orbs={[]}
              names={[{ node: grokBotNode, label: "Grok Bot" }]} />
          ) : null}
          {waiting.length || (grokBot && !grokBot.usage) ? (
            <div className="flex flex-wrap items-center gap-1 px-0.5 pt-1">
              <span className="mr-1 text-[0.68rem] text-muted-foreground">Not observed</span>
              {waiting.map((account) => (
                <span key={`${account.scope}:${account.id}`} data-node={nodeKey(nodeOf(account))} title={account.error ?? (!account.ready ? "Needs sign-in" : !account.enabled ? "Disabled" : "Waiting")}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem]">
                  <Orb id={account.id} size="sm" className="size-2.5" />
                  <NodeTitle node={nodeOf(account)} label={`${label(account)} usage`}>{label(account)}</NodeTitle>
                </span>
              ))}
              {grokBot && !grokBot.usage ? (
                <span data-node={nodeKey(grokBotNode)} title={grokBot.error ?? "Waiting"} className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem]">
                  <NodeTitle node={grokBotNode} label="Grok Bot usage">Grok Bot</NodeTitle>
                </span>
              ) : null}
            </div>
          ) : null}
          {!observed.length && !waiting.length && !grokBot?.usage ? <Empty icon={GaugeIcon} title="No accounts" /> : null}
        </div>
      ) : (
        <Empty icon={GaugeIcon} title="Usage unavailable">{usage.error ?? "Waiting for a snapshot."}</Empty>
      )}
    </Window>
  );
}
