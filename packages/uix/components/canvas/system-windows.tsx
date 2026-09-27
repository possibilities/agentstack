"use client";

import { useState } from "react";
import { ArrowUpRightIcon, BookOpenIcon, CheckIcon, CopyIcon, CpuIcon, PackageIcon, RadioIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { clockTime, relativeTime } from "@/lib/stack/derive";
import { formatBytes, formatDuration, formatPercent } from "@/lib/stack/resources";
import { Empty, NodeCard, NodeTitle, Row, StatusDot, Time } from "./primitives";
import { useNow, useStack, useWorkbench } from "./provider";
import { Section, Window } from "./window";

/** A labeled copy chip: the URL stays out of the layout but in the title and clipboard. */
export function CopyChip({ label, value, name }: { label: string; value: string; name: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" title={value} aria-label={`Copy ${name} ${label} URL`}
    onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_200); })}
    className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 font-mono text-[0.65rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
    {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}{label}
  </button>;
}

const componentScopeId = (name: string) => `component:${encodeURIComponent(name)}`;

export function OwnerWindow() {
  const { owner, resources, status, endpoints } = useStack();
  const { goTo } = useWorkbench();
  const now = useNow();
  const data = owner.data;
  const running = data?.children.filter((child) => child.running).length ?? 0;
  const inspectorUrl = data?.children.some((child) => child.name === "inspector" && child.running) ? data.inspectorUrl : null;
  const runtime = resources.data?.runtime ?? null;
  const ownerScope = resources.data?.scopes.find((scope) => scope.id === "component:owner");
  const scopeOf = (name: string) => resources.data?.scopes.find((scope) => scope.id === componentScopeId(name));
  return (
    <Window id="owner" title="Owner" subtitle="owner" icon={CpuIcon} accent="owner" node={{ kind: "owner" }} empty={!data && !owner.error}
      status={status.owner} endpoint={endpoints.owner} updatedAt={owner.at} error={owner.error}
      actions={inspectorUrl ? (
        <Button variant="ghost" size="xs" nativeButton={false} render={<a href={inspectorUrl} target="_blank" rel="noreferrer" title={inspectorUrl} />}>
          MCP Inspector<ArrowUpRightIcon data-icon="inline-end" /><span className="sr-only">opens in a new tab</span>
        </Button>
      ) : null}>
      {owner.error ? <p className="text-xs text-destructive" role="status">{data ? "Owner read failed" : "Owner status unavailable"}: {owner.error}{data ? " · showing last good read" : ""}</p> : null}
      {!data && !owner.error ? <Empty icon={CpuIcon} title="No owner status" /> : null}
      {data ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[0.68rem] tracking-[0.08em] text-muted-foreground uppercase">
                <StatusDot tone={status.owner === "open" ? "success" : status.owner === "closed" ? "destructive" : "muted"} />
                owner process
              </span>
              <span className="font-mono text-sm font-medium tabular-nums">pid {data.pid}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-xl leading-none font-semibold tracking-tight tabular-nums">{running}<span className="text-muted-foreground">/{data.children.length}</span></span>
              <span className="text-[0.68rem] text-muted-foreground">running</span>
            </div>
          </div>
          {data.children.length ? <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {data.children.map((child) => <span key={child.name} className={child.running ? "flex-1 bg-success/80" : "flex-1 bg-destructive"} />)}
          </div> : null}
          <dl>
            <Row label="Uptime"><span title={`Since ${new Date(Date.parse(data.startedAt)).toLocaleString()}`}>{formatDuration((now - Date.parse(data.startedAt)) / 1000)}</span></Row>
            <Row label="Runtime" mono>{data.nodeVersion}</Row>
            {ownerScope ? <>
              <Row label="Owner CPU" hint="The owner component's interval CPU; 100% is one logical core."><span className="tabular-nums">{formatPercent(ownerScope.metrics.cpuPercent)}</span></Row>
              <Row label="Owner RSS" hint="The owner component's resident set.">{formatBytes(ownerScope.metrics.rssBytes)}</Row>
            </> : null}
          </dl>
          <div className="flex items-center gap-1 text-[0.68rem] text-muted-foreground">
            Read <Time at={owner.at} />
            <Button variant="ghost" size="xs" className="ml-auto -mr-1.5 h-5 px-1.5 text-[0.68rem] text-muted-foreground" onClick={() => goTo({ kind: "operation", pkg: "owner", id: "owner_status" })}><BookOpenIcon data-icon="inline-start" />owner_status</Button>
          </div>
          {data.indexUrl || data.uixUrl ? (
            <div className="flex flex-wrap items-center gap-1">
              {data.indexUrl ? <CopyChip label="UI" name="UI entry" value={data.indexUrl} /> : null}
              {data.uixUrl ? <CopyChip label="Canvas" name="canvas" value={data.uixUrl} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {runtime ? (
        <Section title="Owner runtime">
          <dl>
            <Row label="Heap"><span className="tabular-nums">{formatBytes(runtime.heapUsedBytes)} / {formatBytes(runtime.heapTotalBytes)}</span></Row>
            <Row label="External">{formatBytes(runtime.externalBytes)}</Row>
            <Row label="Array buffers">{formatBytes(runtime.arrayBuffersBytes)}</Row>
            <Row label="Event loop" hint="Utilization since the previous sampling interval; null until a second sample exists.">
              <span className="tabular-nums">{runtime.eventLoopUtilization === null ? "—" : formatPercent(runtime.eventLoopUtilization * 100)}</span>
            </Row>
          </dl>
        </Section>
      ) : null}
      {data?.children.length ? (
        <Section title="Children" aside={<span className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">{running}/{data.children.length} running</span>}>
          <div className="-mx-1 flex flex-col">
            {data.children.map((child) => {
              const scope = scopeOf(child.name);
              return (
                <NodeCard key={child.name} variant="row" node={{ kind: "child", id: child.name }} label={`${child.name} process`} className="flex flex-col">
                  <div className="flex items-center gap-2 text-xs">
                    <StatusDot tone={child.running ? "success" : "destructive"} label={child.running ? "Running" : "Stopped"} />
                    <NodeTitle node={{ kind: "child", id: child.name }} label={`${child.name} process`} className="font-medium">{child.name}</NodeTitle>
                    {child.exitCode !== null || child.signal ? <span className="text-muted-foreground">{child.exitCode !== null ? `exit ${child.exitCode}` : ""} {child.signal}</span> : null}
                    {scope ? <span className="text-muted-foreground tabular-nums" title="Component CPU% · RSS">{formatPercent(scope.metrics.cpuPercent)} · {formatBytes(scope.metrics.rssBytes)}</span> : null}
                    <span className="ml-auto text-muted-foreground">
                      {child.running && child.startedAt ? `up ${formatDuration((now - Date.parse(child.startedAt)) / 1000)}`
                        : !child.running && child.exitedAt ? `exited ${relativeTime(Date.parse(child.exitedAt), now)}` : ""}
                    </span>
                    <span className="font-mono text-muted-foreground tabular-nums">{child.pid ?? "—"}</span>
                  </div>
                  {child.error ? <p className="pl-4 break-words text-xs text-destructive">{child.error}</p> : null}
                </NodeCard>
              );
            })}
          </div>
        </Section>
      ) : null}
    </Window>
  );
}

export function PackagesWindow() {
  const { owner, catalog, status, endpoints, scoped } = useStack();
  const { goTo } = useWorkbench();
  const mcpUrls = owner.data?.mcpUrls ?? {};
  // One row per package: its WebSocket channel from this page and its owner MCP endpoint.
  const packages = [...new Set([...Object.keys(endpoints), ...Object.keys(status), ...Object.keys(mcpUrls), ...(catalog.data ?? []).map((doc) => doc.name)])].sort();
  const subscriptions = Object.values(scoped);
  return (
    <Window id="packages" title="Packages" subtitle="discovery" icon={PackageIcon} accent="owner" empty={!packages.length}
      count={packages.length || null} updatedAt={catalog.at ?? owner.at} error={catalog.error}>
      {packages.length ? (
        <div className="-mx-1 flex flex-col">
          {packages.map((name) => {
            const doc = catalog.data?.find((item) => item.name === name);
            return (
              <div key={name} className="group/row flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/60">
                <StatusDot tone={status[name] === "open" ? "success" : status[name] === "closed" ? "destructive" : "muted"} label={status[name] ?? "not opened"} />
                <button className="rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => goTo({ kind: "package", id: name })}>{name}</button>
                <span className="text-muted-foreground">{status[name] ?? "—"}</span>
                {doc ? <span className="text-muted-foreground/80 tabular-nums" title={`${doc.operations.length} operations · ${Object.keys(doc.events).length} event topics`}>{doc.operations.length} ops · {Object.keys(doc.events).length} events</span> : null}
                <span className="ml-auto flex items-center gap-1">
                  {endpoints[name] ? <CopyChip label="WS" name={name} value={endpoints[name]} /> : null}
                  {mcpUrls[name] ? <CopyChip label="MCP" name={name} value={mcpUrls[name]} /> : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty icon={PackageIcon} title="No packages" />
      )}
      {subscriptions.length ? <p className="px-1 text-[0.68rem] text-muted-foreground">{subscriptions.filter((item) => item.status === "open").length}/{subscriptions.length} Bot subscriptions live</p> : null}
    </Window>
  );
}

export function ActivityWindow() {
  const { events, bots, catalog } = useStack();
  const { goTo } = useWorkbench();
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();
  const activity = events.filter((event) => !search || [event.pkg, event.topic, event.scope].join(" ").toLowerCase().includes(search));
  return (
    <Window id="activity" title="Activity" subtitle="notices" icon={RadioIcon} accent="events" count={activity.length}
      empty={!events.length}>
      <InputGroup className="h-8">
        <InputGroupAddon><SearchIcon /></InputGroupAddon>
        <InputGroupInput id="activity-filter" type="search" autoComplete="off" aria-label="Filter activity" placeholder="Filter" value={query} onChange={(event) => setQuery(event.target.value)} />
      </InputGroup>
      {activity.length ? (
        <ol className="-mx-1 flex flex-col">
          {activity.map((event) => {
            const knownBot = event.scope && bots.data?.some((bot) => bot.id === event.scope);
            const knownPackage = catalog.data?.some((doc) => doc.name === event.pkg);
            return <li key={event.seq}><button disabled={!knownBot && !knownPackage} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs enabled:hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => knownBot ? goTo({ kind: "bot", id: event.scope! }) : goTo({ kind: "package", id: event.pkg })}>
              <time className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">{clockTime(event.at)}</time>
              <span className="font-medium">{event.pkg}</span>
              <code className="min-w-0 truncate text-muted-foreground">{event.topic}</code>
              {event.scope ? <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-muted-foreground">{event.scope}</span> : null}
            </button></li>;
          })}
        </ol>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">{search ? "No matches." : "Listening…"}</p>
      )}
    </Window>
  );
}
