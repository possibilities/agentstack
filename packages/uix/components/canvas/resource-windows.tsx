"use client";

import { useEffect, useMemo, useState } from "react";
import { ChartLineIcon, ChevronRightIcon, ListTreeIcon, ScanLineIcon, SearchIcon, ServerIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { accountLabels, relativeTime, workerAccountLabels } from "@/lib/stack/derive";
import { formatBytes, formatDuration, formatPercent, processTree, scopeTarget } from "@/lib/stack/resources";
import type { OwnerResources, ResourceProcess, ResourceScope } from "@/lib/stack/types";
import { nodeKey } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Trend } from "./chart";
import { Empty, Flash, Meter, NodeLink, NodeTitle, Row, StatusDot, Time } from "./primitives";
import { useNow, useStack, useStore } from "./provider";
import { Section, Window } from "./window";

const freshnessLabel = { fresh: "Fresh", stale: "Stale", unavailable: "Unavailable" } as const;
const freshnessTone = { fresh: "secondary", stale: "outline", unavailable: "destructive" } as const;

function ResourcesEmpty({ error }: { error: string | null }) {
  return (
    <>
      <Empty icon={ChartLineIcon} title="No resource data" />
      <p className="px-1 text-xs text-muted-foreground">{error ? `Resources: ${error}` : "The owner sampler has not produced a snapshot yet."}</p>
    </>
  );
}

function Totals({ resources }: { resources: OwnerResources }) {
  const total = resources.scopes.find((scope) => scope.id === "total");
  if (!total) return null;
  const metrics = total.metrics;
  const underMeasured = metrics.cpuPercent !== null && metrics.cpuMeasuredProcessCount < metrics.processCount;
  return (
    <dl>
      <Row label="CPU" hint={underMeasured ? `CPU measured for ${metrics.cpuMeasuredProcessCount} of ${metrics.processCount} processes; the rest were new or reset.` : undefined}>
        <span className="tabular-nums">{formatPercent(metrics.cpuPercent)}{underMeasured ? <span className="text-muted-foreground"> · {metrics.cpuMeasuredProcessCount}/{metrics.processCount} measured</span> : null}</span>
      </Row>
      <Row label="RSS">{formatBytes(metrics.rssBytes)}</Row>
      <Row label="Virtual">{formatBytes(metrics.virtualBytes)}</Row>
      <Row label="Processes"><span className="tabular-nums">{metrics.processCount}</span></Row>
      {resources.capabilities.threads ? <Row label="Threads"><span className="tabular-nums">{metrics.threads ?? "—"}</span></Row> : null}
      <Row label="CPU time"><span className="tabular-nums">{formatDuration(metrics.cpuTimeMs === null ? null : metrics.cpuTimeMs / 1000)}</span></Row>
    </dl>
  );
}

const scopeKinds = [
  ["component", "Components"],
  ["bot", "Bots"],
  ["account", "Accounts"],
  ["runtime", "Runtimes"],
] as const;
type ScopeKindFilter = (typeof scopeKinds)[number][0];

export function ResourcesWindow() {
  const { resources, resourceHistory, accounts, workerAccounts } = useStack();
  const store = useStore();
  const now = useNow();
  const [kind, setKind] = useState<ScopeKindFilter>("component");
  const [chosen, setChosen] = useState("total");
  const data = resources.data;
  // A watched scope that errors falls back to the total history.
  const active = chosen !== "total" && resourceHistory[chosen]?.error ? "total" : chosen;
  useEffect(() => store.watchResourceHistory(active), [store, active]);
  const history = resourceHistory[active]?.data ?? [];
  const cpuPoints = history.map((point) => ({ at: Date.parse(point.attemptedAt), value: point.state === "measured" ? point.metrics?.cpuPercent ?? null : null }));
  const rssPoints = history.map((point) => ({ at: Date.parse(point.attemptedAt), value: point.state === "measured" ? point.metrics?.rssBytes ?? null : null }));
  const labels = useMemo(() => accountLabels(accounts.data), [accounts.data]);
  const workerLabels = useMemo(() => workerAccountLabels(workerAccounts.data), [workerAccounts.data]);
  const totalRss = data?.scopes.find((scope) => scope.id === "total")?.metrics.rssBytes ?? null;
  const shown = (data?.scopes ?? []).filter((scope) => scope.kind === kind)
    .sort((a, b) => (b.metrics.rssBytes ?? 0) - (a.metrics.rssBytes ?? 0));
  const scopeName = (scope: ResourceScope) => {
    if (scope.kind === "account" && scope.id.startsWith("account:bot:")) return scope.accountId ? labels.get(scope.accountId) ?? scope.name : scope.name;
    if ((scope.kind === "account" && scope.id.startsWith("account:worker:")) || scope.kind === "runtime") return scope.accountId ? workerLabels.get(scope.accountId) ?? scope.name : scope.name;
    return scope.name;
  };
  const activeName = active === "total" ? "AgentStack" : scopeName(data?.scopes.find((scope) => scope.id === active) ?? ({ name: active } as ResourceScope));
  return (
    <Window id="resources" title="Resources" subtitle="owner sampler" icon={ChartLineIcon} accent="owner" node={{ kind: "resource", id: "total" }}
      count={data?.scopes.length ?? null} updatedAt={resources.at} error={resources.error} empty={!data && !resources.error}>
      {resources.error && data ? <p className="text-xs text-destructive" role="status">Resources read failed: {resources.error} · showing last good read</p> : null}
      {data ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-[0.68rem] text-muted-foreground">
            <Badge variant={freshnessTone[data.observation.freshness]}>{freshnessLabel[data.observation.freshness]}</Badge>
            {data.observation.capturedAt ? <span>captured {relativeTime(Date.parse(data.observation.capturedAt), now)}</span> : null}
            {data.observation.error ? <span className="text-destructive">{data.observation.error}</span> : null}
            <span className="ml-auto">Read <Time at={resources.at} /></span>
          </div>
          <Totals resources={data} />
          <Section title={`${activeName} history`}
            aside={<span className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">{history.length}/{data.retention.maxSamples}</span>}>
            <div className="flex flex-col gap-2">
              <Trend label="CPU" points={cpuPoints} format={formatPercent} className="text-success" />
              <Trend label="RSS" points={rssPoints} format={formatBytes} className="text-pkg-codex" />
              {resourceHistory[active]?.error ? <p className="text-[0.68rem] text-destructive">History: {resourceHistory[active].error}</p> : null}
            </div>
          </Section>
          <Section title="Scopes" aside={
            <ToggleGroup value={[kind]} onValueChange={(value: string[]) => { if (value.length) setKind(value[0] as ScopeKindFilter); }} spacing={0} size="sm" variant="outline" aria-label="Scope kind">
              {scopeKinds.map(([value, label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}
            </ToggleGroup>}>
            {shown.length ? (
              <div className="-mx-1 flex flex-col">
                {shown.map((scope) => {
                  const target = scopeTarget(scope);
                  const share = totalRss && scope.metrics.rssBytes !== null ? scope.metrics.rssBytes / totalRss : null;
                  const key = nodeKey({ kind: "resource", id: scope.id });
                  return (
                    <div key={scope.id} data-node={key} role="button" tabIndex={0} aria-pressed={active === scope.id}
                      aria-label={`Chart ${scopeName(scope)}`}
                      className={cn("relative flex cursor-pointer flex-col gap-0.5 rounded-md px-1 py-1 text-xs hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring", active === scope.id && "bg-muted/70")}
                      onClick={() => setChosen(scope.id)}
                      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setChosen(scope.id); } }}>
                      <Flash id={key} />
                      <div className="flex items-center gap-2">
                        <NodeTitle node={{ kind: "resource", id: scope.id }} label={`${scope.name} resources`} className="min-w-0 truncate font-medium">{scopeName(scope)}</NodeTitle>
                        {target ? <NodeLink node={target} label={`${scope.name} home`} className="text-muted-foreground">{target.kind === "bot" ? "bot" : target.kind === "child" ? "child" : target.kind === "owner" ? "owner" : "account"}</NodeLink> : null}
                        <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-muted-foreground tabular-nums">{scope.metrics.processCount} proc</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span className="flex h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <span className="bg-pkg-codex/70" style={{ width: `${Math.min(100, (share ?? 0) * 100)}%` }} />
                        </span>
                        <span className="tabular-nums">{formatPercent(scope.metrics.cpuPercent)}</span>
                        <span className="tabular-nums">{formatBytes(scope.metrics.rssBytes)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="px-1 text-xs text-muted-foreground">No {kind} scopes in this snapshot.</p>}
          </Section>
        </div>
      ) : <ResourcesEmpty error={resources.error} />}
    </Window>
  );
}

export function HostWindow() {
  const { resources, resourceHistory } = useStack();
  const store = useStore();
  useEffect(() => store.watchResourceHistory("total"), [store]);
  const data = resources.data;
  const host = data?.host ?? null;
  const totalRss = data?.scopes.find((scope) => scope.id === "total")?.metrics.rssBytes ?? null;
  const history = resourceHistory["total"]?.data ?? [];
  const usedPercent = (point: (typeof history)[number]) =>
    point.host?.totalMemoryBytes ? ((point.host.totalMemoryBytes - (point.host.freeMemoryBytes ?? 0)) / point.host.totalMemoryBytes) * 100 : null;
  const memoryPoints = history.map((point) => ({ at: Date.parse(point.attemptedAt), value: point.state === "measured" ? usedPercent(point) : null }));
  const loadPoints = history.map((point) => ({ at: Date.parse(point.attemptedAt), value: point.state === "measured" ? point.host?.loadAverage?.[0] ?? null : null }));
  const usedBytes = host?.totalMemoryBytes !== null && host?.totalMemoryBytes !== undefined && host.freeMemoryBytes !== null ? host.totalMemoryBytes - host.freeMemoryBytes : null;
  const usedShare = host?.totalMemoryBytes && usedBytes !== null ? usedBytes / host.totalMemoryBytes : null;
  const agentShare = host?.totalMemoryBytes && totalRss !== null ? totalRss / host.totalMemoryBytes : null;
  return (
    <Window id="host" title="Host" subtitle={host?.hostname ?? "machine"} icon={ServerIcon} accent="owner"
      updatedAt={resources.at} error={resources.error} empty={!host && !resources.error}>
      {host ? (
        <div className="flex flex-col gap-4">
          <dl>
            <Row label="Host" mono>{host.hostname}</Row>
            <Row label="Platform">{host.platform} · {host.arch}</Row>
            <Row label="Release" mono>{host.release}</Row>
            <Row label="CPU" hint={host.cpuModel ?? undefined}>{host.cpuModel ?? "—"} × {host.logicalCpuCount}</Row>
            <Row label="Uptime">{formatDuration(host.uptimeSeconds)}</Row>
            <Row label="Memory" hint={host.totalMemoryBytes !== null ? `${formatBytes(usedBytes)} used of ${formatBytes(host.totalMemoryBytes)}; free is not available memory` : undefined}>
              {usedShare === null ? "—" : <Meter value={100 - usedShare * 100} label="Host memory headroom" className="w-24" />}
            </Row>
            <Row label="Load 1/5/15"><span className="tabular-nums">{host.loadAverage ? host.loadAverage.map((load) => load.toFixed(2)).join(" · ") : "—"}</span></Row>
            <Row label="Load per core"><span className="tabular-nums">{host.loadAverage ? (host.loadAverage[0] / host.logicalCpuCount).toFixed(2) : "—"}</span></Row>
            <Row label="AgentStack RSS" hint="The total scope's resident set as a share of host memory.">
              {agentShare === null ? "—" : <span className="tabular-nums">{formatBytes(totalRss)} · {formatPercent(agentShare * 100)} of host</span>}
            </Row>
          </dl>
          <div className="flex flex-col gap-2">
            <Trend label="Memory" points={memoryPoints} format={formatPercent} className="text-pkg-codex" />
            <Trend label="Load 1" points={loadPoints} format={(value) => value.toFixed(2)} className="text-warning" />
          </div>
        </div>
      ) : <ResourcesEmpty error={resources.error} />}
    </Window>
  );
}

export function ProcessesWindow() {
  const { resources } = useStack();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const data = resources.data;
  const rows = useMemo(() => processTree(data?.processes ?? []), [data]);
  const byId = useMemo(() => new Map((data?.processes ?? []).map((process) => [process.id, process])), [data]);
  const search = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!search) return rows;
    const parentOf = (process: ResourceProcess): string | null =>
      process.parentId && byId.has(process.parentId) ? process.parentId
        : process.ancestryParentId && byId.has(process.ancestryParentId) ? process.ancestryParentId : null;
    const keep = new Set<string>();
    for (const row of rows) {
      const process = row.process;
      if (![process.name, String(process.pid), process.component, process.botId ?? "", process.accountId ?? ""].join(" ").toLowerCase().includes(search)) continue;
      let current: ResourceProcess | undefined = process;
      while (current && !keep.has(current.id)) {
        keep.add(current.id);
        current = parentOf(current) ? byId.get(parentOf(current)!) : undefined;
      }
    }
    return rows.filter((row) => keep.has(row.process.id));
  }, [rows, byId, search]);
  const isOpen = (row: (typeof rows)[number]) => row.depth < 2 || expanded.has(row.process.id);
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // Hide every descendant of a collapsed node; filtering shows matches with their ancestors.
  const blockedDepths: number[] = [];
  return (
    <Window id="processes" title="Processes" subtitle="owner tree" icon={ListTreeIcon} accent="owner"
      count={data ? visible.length : null} updatedAt={resources.at} error={resources.error} empty={!data && !resources.error}
      actions={<InputGroup className="h-7 w-36">
        <InputGroupAddon><SearchIcon /></InputGroupAddon>
        <InputGroupInput id="process-filter" type="search" autoComplete="off" aria-label="Filter processes" placeholder="Filter" value={query} onChange={(event) => setQuery(event.target.value)} />
      </InputGroup>}>
      {data ? (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 px-1 text-[0.62rem] font-medium tracking-[0.08em] text-muted-foreground uppercase" aria-hidden>
            <span>Process</span><span>CPU</span><span>RSS</span><span>Subtree</span>
          </div>
          <ul className="flex flex-col">
            {visible.map((row) => {
              while (blockedDepths.length && blockedDepths[blockedDepths.length - 1] >= row.depth) blockedDepths.pop();
              if (blockedDepths.length) return null;
              if (row.hasChildren && !isOpen(row)) blockedDepths.push(row.depth);
              const process = row.process;
              const key = nodeKey({ kind: "process", id: process.id });
              return (
                <li key={process.id}>
                  <div data-node={key} className="group/row relative grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 rounded-md px-1 py-1 text-xs hover:bg-muted/60">
                    <Flash id={key} />
                    <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: row.depth * 14 }}>
                      {row.hasChildren ? (
                        <button type="button" aria-label={`${isOpen(row) ? "Collapse" : "Expand"} ${process.name}`} aria-expanded={isOpen(row)}
                          className="grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                          onClick={() => toggle(process.id)}>
                          <ChevronRightIcon className={cn("size-3 transition-transform", isOpen(row) && "rotate-90")} />
                        </button>
                      ) : <span className="size-4 shrink-0" aria-hidden />}
                      <StatusDot tone={process.ownership === "retained" ? "warning" : "success"} label={process.ownership} />
                      <NodeTitle node={{ kind: "process", id: process.id }} label={process.name} className="min-w-0 truncate font-mono text-[0.72rem]">{process.name}</NodeTitle>
                      <span className="shrink-0 font-mono text-[0.68rem] text-muted-foreground tabular-nums">{process.pid}</span>
                      {process.botId ? <Badge variant="outline" className="h-4 px-1 font-mono text-[0.6rem] font-normal">{process.botId}</Badge>
                        : process.component !== "owner" ? <Badge variant="outline" className="h-4 px-1 font-mono text-[0.6rem] font-normal">{process.component}</Badge> : null}
                      {process.ownership === "retained" ? <Badge variant="secondary" className="h-4 px-1 text-[0.6rem]">retained</Badge> : null}
                    </div>
                    <span className="font-mono text-muted-foreground tabular-nums"
                      title={process.cpuStatus === "warmup" ? "CPU needs one interval before it is measured" : process.cpuStatus === "reset" ? "CPU counter reset; measured again next interval" : undefined}>
                      {process.cpuStatus === "measured" ? formatPercent(process.self.cpuPercent) : "—"}
                    </span>
                    <span className="font-mono text-muted-foreground tabular-nums">{formatBytes(process.self.rssBytes)}</span>
                    <span className="font-mono tabular-nums">{formatBytes(process.subtree.rssBytes)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
          {!visible.length ? <p className="px-1 py-2 text-xs text-muted-foreground">{search ? "No matches." : "No observed processes."}</p> : null}
          {data.processes.length < data.processTotal ? <p className="px-1 text-[0.68rem] text-muted-foreground">Showing {data.processes.length} of {data.processTotal}</p> : null}
        </div>
      ) : <ResourcesEmpty error={resources.error} />}
    </Window>
  );
}

const capabilityLabels: [keyof OwnerResources["capabilities"], string][] = [
  ["rssBytes", "RSS"], ["virtualBytes", "Virtual"], ["cpuTimeMs", "CPU time"], ["cpuPercent", "CPU%"], ["threads", "Threads"],
  ["diskIoBytes", "Disk I/O"], ["openFileDescriptors", "File descriptors"], ["networkBytes", "Network"], ["gpu", "GPU"], ["perSessionAllocation", "Per-session"],
];

export function SamplingWindow() {
  const { resources, resourceHistory } = useStack();
  const store = useStore();
  useEffect(() => store.watchResourceHistory("total"), [store]);
  const now = useNow();
  const data = resources.data;
  const history = resourceHistory["total"]?.data ?? [];
  const observation = data?.observation;
  const coverage = observation?.coverage ?? null;
  return (
    <Window id="sampling" title="Sampling" subtitle="observation" icon={ScanLineIcon} accent="owner"
      updatedAt={resources.at} error={resources.error} empty={!data && !resources.error}>
      {data && observation ? (
        <div className="flex flex-col gap-4">
          <Section title="Observation">
            <dl>
              <Row label="Source" mono>{observation.source}</Row>
              <Row label="Interval"><span className="tabular-nums">{formatDuration(observation.intervalMs / 1000)}</span></Row>
              <Row label="Stale after"><span className="tabular-nums">{formatDuration(observation.staleAfterMs / 1000)}</span></Row>
              <Row label="Last collection"><span className="tabular-nums">{observation.collectionDurationMs === null ? "—" : `${Math.round(observation.collectionDurationMs)} ms`}</span></Row>
              <Row label="Last attempt">{observation.lastAttemptAt ? relativeTime(Date.parse(observation.lastAttemptAt), now) : "—"}</Row>
              {observation.error ? <Row label="Error"><span className="text-destructive">{observation.error}</span></Row> : null}
            </dl>
          </Section>
          <Section title="Attempts" aside={<span className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">{history.length}</span>}>
            {history.length ? (
              <ol className="flex h-5 items-stretch gap-px overflow-hidden rounded-sm" aria-label={`${history.length} retained attempts`}>
                {history.map((point) => (
                  <li key={point.attemptId} className={cn("min-w-1.5 flex-1", point.state === "measured" ? "bg-success/70" : point.state === "gap" ? "bg-destructive/80" : "bg-muted-foreground/30")}
                    title={`${point.state} · ${point.attemptedAt}${point.error ? ` · ${point.error}` : ""}`} />
                ))}
              </ol>
            ) : <p className="text-xs text-muted-foreground">No retained attempts yet.</p>}
            <p className="text-[0.68rem] text-muted-foreground">One cell per retained attempt — measured, gap (collection error), or absent.</p>
          </Section>
          {coverage ? (
            <Section title="Coverage">
              <dl>
                <Row label="Mode" mono>{coverage.mode}</Row>
                <Row label="Observed host processes"><span className="tabular-nums">{coverage.observedHostProcesses}</span></Row>
                <Row label="Owned"><span className="tabular-nums">{coverage.ownedProcesses}</span></Row>
                <Row label="Unreadable"><span className="tabular-nums">{coverage.unreadableProcesses}</span></Row>
                <Row label="Vanished"><span className="tabular-nums">{coverage.vanishedDuringCollection}</span></Row>
                <Row label="Retained"><span className="tabular-nums">{coverage.retainedProcesses}</span></Row>
                <Row label="Excluded collector"><span className="tabular-nums">{coverage.excludedCollectorProcesses}</span></Row>
              </dl>
            </Section>
          ) : null}
          {coverage?.domains.length ? (
            <Section title="Attribution domains">
              <dl>
                {coverage.domains.map((domain) => (
                  <Row key={domain.source} label={domain.source}>
                    <span className="flex items-center gap-1.5">
                      <Badge variant={domain.state === "current" ? "secondary" : domain.state === "stale" ? "outline" : "destructive"} className="h-4 px-1 text-[0.6rem]">{domain.state}</Badge>
                      {domain.capturedAt ? <span className="text-muted-foreground">{relativeTime(Date.parse(domain.capturedAt), now)}</span> : null}
                      {domain.unmatched ? <span className="text-muted-foreground">{domain.unmatched} unmatched</span> : null}
                      {domain.error ? <span className="text-destructive">{domain.error}</span> : null}
                    </span>
                  </Row>
                ))}
              </dl>
            </Section>
          ) : null}
          <Section title="Retention">
            <dl>
              <Row label="Samples"><span className="tabular-nums">{data.retention.retainedSamples}/{data.retention.maxSamples}</span></Row>
              <Row label="Dropped"><span className="tabular-nums">{data.retention.droppedSamples}</span></Row>
              <Row label="Span">
                {data.retention.oldestAttemptAt && data.retention.newestAttemptAt
                  ? `${formatDuration((Date.parse(data.retention.newestAttemptAt) - Date.parse(data.retention.oldestAttemptAt)) / 1000)}`
                  : "—"}
              </Row>
              <Row label="Oldest → newest">
                {data.retention.oldestAttemptAt && data.retention.newestAttemptAt
                  ? <span className="tabular-nums">{relativeTime(Date.parse(data.retention.oldestAttemptAt), now)} → {relativeTime(Date.parse(data.retention.newestAttemptAt), now)}</span>
                  : "—"}
              </Row>
              <Row label="Process records"><span className="tabular-nums">max {data.retention.maxProcessRecords}</span></Row>
            </dl>
          </Section>
          <Section title="Capabilities" aside={<span className="text-[0.68rem] text-muted-foreground">unavailable, never zero</span>}>
            <ul className="flex flex-wrap gap-1">
              {capabilityLabels.map(([key, label]) => (
                <li key={key}>
                  <Badge variant={data.capabilities[key] ? "secondary" : "outline"} className="gap-1">
                    {label}{data.capabilities[key] ? null : <span className="text-muted-foreground">unavailable</span>}
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : <ResourcesEmpty error={resources.error} />}
    </Window>
  );
}
