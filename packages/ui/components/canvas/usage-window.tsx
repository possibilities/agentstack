"use client";

import { UsageClearSection } from "./usage-maintenance";
import { GaugeIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountLabels, providerTitle, relativeTime, shortId, untilTime, usageRows, workerAccountLabels, workerProviders } from "@/lib/stack/derive";
import { nodeKey, type NodeRef, type UsageAccount, type UsageObservation, type UsageSubscription } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Empty, headroomTone, Meter, NodeCard, NodeTitle, Orb, StatusDot, Time } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { Section, Window } from "./window";

/**
 * A gauge's group is the set of windows that gate the same quota: an exhausted
 * window blocks its siblings unless it is local, gating only its own model.
 */
type Gauge = { label: string; remaining: number | null; resetsAt: string | null; group: string; local?: boolean };
type Summary = { plan: string | null; limited: boolean; gauges: Gauge[]; notes: string[] };
/** When one observation behind a card was last measured; a merged gauge names its own. */
type Sample = { label: string | null; at: number | null };

/** Every gauge is remaining headroom, whichever direction the provider reports. */
const pct = (value: number) => `${Math.round(value)}%`;
const freshWindow = 5 * 60_000;
/** An exhausted window is a limit, like Codex's own limit flag. */
const exhausted = (gauges: Gauge[]) => gauges.some((gauge) => gauge.remaining === 0);
/** The exhausted sibling that makes a gauge's remaining headroom unusable, if any. */
const blockedBy = (gauge: Gauge, gauges: Gauge[]) => gauge.remaining === 0 ? undefined
  : gauges.find((other) => other !== gauge && other.group === gauge.group && !other.local && other.remaining === 0);

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric",
  year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

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

/** Freshness at a glance; the tooltip carries when each observation behind the card was sampled. */
function FreshnessDot({ observation, samples }: { observation: UsageObservation; samples: Sample[] }) {
  const now = useNow(30_000);
  const state = freshness(observation, now);
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} data-interactive="" className="relative z-10 inline-flex size-4 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring" />}>
        {observation.error ? <TriangleAlertIcon aria-label="Read failed" className="size-3.5 text-warning" /> : <StatusDot tone={state === "fresh" ? "success" : "muted"} label={state === "fresh" ? "Fresh" : "Stale"} className="size-1.5 [&>span]:size-1.5" />}
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col items-start gap-0.5">
        <span>{state === "fresh" ? "Fresh" : "Stale"} · updated {samples.map((sample, index) => (
          <span key={sample.label ?? ""}>{index ? " · " : ""}{sample.label ? `${sample.label} ` : ""}<Time at={sample.at} /></span>
        ))}</span>
        {observation.error ? <span className="opacity-70">{observation.error}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function SubscriptionEnd({ subscription, now }: { subscription: UsageSubscription; now: number }) {
  const at = Date.parse(subscription.endsAt);
  const source = subscription.source === "plan_period" ? "Plan period end" : "Sign-in subscription claim";
  return (
    <span className="shrink-0 tabular-nums" title={`${new Date(at).toLocaleString()} · ${source}${subscription.checkedAtMs !== null ? `, checked ${relativeTime(subscription.checkedAtMs, now)}` : ""}`}>
      sub {at < now ? "ended" : "ends"} <span className="text-foreground/80">{day(at)}</span>
    </span>
  );
}

function UsageCard({ node, names, observation, summary, orbs, samples, subscription }: {
  node: NodeRef;
  names: Array<{ node: NodeRef; label: string }>;
  observation: UsageObservation;
  summary: Summary;
  orbs: string[];
  samples: Sample[];
  subscription: UsageSubscription | null;
}) {
  const now = useNow(60_000);
  const headline = summary.gauges.reduce<number | null>((low, gauge) => gauge.remaining === null ? low : low === null ? gauge.remaining : Math.min(low, gauge.remaining), null);
  const tone = summary.limited ? "destructive" : headroomTone(headline);
  // A fresh sample's age lives in the freshness tooltip; a stale one stays visible on the info line.
  const stale = samples.filter((sample) => sample.at === null || now - sample.at > freshWindow);
  const notes = summary.notes.join(" · ");
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
        <FreshnessDot observation={observation} samples={samples} />
        {summary.plan ? <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-[0.65rem] font-medium text-muted-foreground capitalize">{summary.plan}</span> : null}
        <span className={cn("ml-auto shrink-0 text-base leading-none font-semibold tracking-tight tabular-nums",
          tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-foreground")}>
          {summary.limited ? "Limit" : headline === null ? "—" : pct(headline)}
        </span>
      </div>
      {summary.gauges.length ? (
        <div className="flex flex-col gap-1.5">
          {summary.gauges.map((gauge) => {
            const blocker = blockedBy(gauge, summary.gauges);
            return (
            <div key={gauge.label} title={blocker ? `Unavailable until ${blocker.label} resets` : undefined}
              className="grid grid-cols-[3.75rem_1fr_auto_auto] items-center gap-2 text-[0.68rem] text-muted-foreground">
              <span className="truncate">{gauge.label}</span>
              <Meter value={gauge.remaining} className={cn("h-3", blocker && "opacity-35")}
                label={`${names[0].label} ${gauge.label} remaining${blocker ? `, unavailable until ${blocker.label} resets` : ""}`} />
              <span className={cn("min-w-10 text-right whitespace-nowrap tabular-nums", blocker && "opacity-35")}>
                {gauge.remaining === null ? "—" : <span className="text-foreground/80">{pct(gauge.remaining)}</span>}
              </span>
              <span className="min-w-12 whitespace-nowrap text-right tabular-nums" title={gauge.resetsAt ?? undefined}>
                {gauge.resetsAt ? untilTime(Date.parse(gauge.resetsAt), now) : "—"}
              </span>
            </div>
            );
          })}
        </div>
      ) : null}
      {/* At most one info line: notes truncate (full text on hover) before a stale age or the subscription end gives way. */}
      {notes || stale.length || subscription ? (
        <p className="flex min-w-0 items-baseline gap-2 text-[0.68rem] text-muted-foreground">
          {notes ? <span className="min-w-0 truncate" title={notes}>{notes}</span> : null}
          {stale.length ? (
            <span className="shrink-0 text-foreground/80">updated {stale.map((sample, index) => (
              <span key={sample.label ?? ""}>{index ? " · " : ""}{sample.label ? `${sample.label} ` : ""}<Time at={sample.at} /></span>
            ))}</span>
          ) : null}
          {subscription ? <span className="ml-auto shrink-0"><SubscriptionEnd subscription={subscription} now={now} /></span> : null}
        </p>
      ) : null}
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
  // A card shows its leading account's measurement; a linked Codex Worker folds into its Bot's card.
  const grouped = usageRows(usage.data?.accounts ?? []);
  const rows = grouped.filter((row) => row[0].usage);
  const waiting = grouped.filter((row) => !row[0].usage).map((row) => row[0]);
  // Mirror Accounts' provider sections, including accounts without a measurement.
  const groups = workerProviders.map((provider) => ({
    provider,
    rows: rows.filter((row) => row[0].provider === provider),
    waiting: waiting.filter((account) => account.provider === provider),
  })).filter((group) => group.rows.length || group.waiting.length);
  return (
    <Window id="usage" title="Usage" subtitle="usage" icon={GaugeIcon} accent="server" node={{ kind: "usage" }} empty={!usage.data || !rows.length && !waiting.length}
      count={usage.data?.accounts.length} status={status.usage} endpoint={endpoints.usage} updatedAt={usage.at} error={usage.error}
      actions={
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Re-read usage" disabled={status.usage !== "open"} onClick={store.reloadUsage} />}>
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">Re-read snapshot; does not retry collection or renew sign-ins</TooltipContent>
        </Tooltip>
      }>
      {usage.data?.inventoryError ? <Alert variant="destructive"><AlertDescription>Inventory {usage.data.inventoryError.replace("_", " ")} · <Time at={usage.data.inventoryAtMs} /></AlertDescription></Alert> : null}
      {usage.data ? (
        <div className="flex flex-col gap-3">
          {groups.map(({ provider, rows: providerRows, waiting: providerWaiting }) => (
            <Section key={provider} title={providerTitle(provider)}>
              <div className="flex flex-col gap-2">
                {providerRows.map((row) => (
                  <UsageCard key={`${row[0].scope}:${row[0].id}`} node={nodeOf(row[0])} observation={row[0]}
                    summary={summarize(row[0])!} samples={[{ label: null, at: row[0].observedAtMs }]}
                    subscription={row[0].subscription}
                    orbs={row.map((account) => account.id)} names={row.map((account) => ({ node: nodeOf(account), label: label(account) }))} />
                ))}
                {providerWaiting.length ? (
                  <div className="flex flex-wrap items-center gap-1 px-0.5 pt-1">
                    <span className="mr-1 text-[0.68rem] text-muted-foreground">Not observed</span>
                    {providerWaiting.map((account) => (
                      <span key={`${account.scope}:${account.id}`} data-node={nodeKey(nodeOf(account))} title={account.error ?? (!account.ready ? "Needs sign-in" : !account.enabled ? "Disabled" : "Waiting")}
                        className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem]">
                        <Orb id={account.id} size="sm" className="size-2.5" />
                        <NodeTitle node={nodeOf(account)} label={`${label(account)} usage`}>{label(account)}</NodeTitle>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </Section>
          ))}
          {!rows.length && !waiting.length ? <Empty icon={GaugeIcon} title="No accounts" /> : null}
        </div>
      ) : (
        <Empty icon={GaugeIcon} title="Usage unavailable" />
      )}
      <UsageClearSection />
    </Window>
  );
}
