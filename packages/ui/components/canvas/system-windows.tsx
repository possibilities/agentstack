"use client";

import { useId, useState } from "react";
import { ArrowUpRightIcon, BookOpenIcon, CheckIcon, CopyIcon, CpuIcon, PackageIcon, RadioIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { clockTime, relativeTime } from "@/lib/stack/derive";
import { settingsSaveProblem, type SaveProblem } from "@/lib/stack/developer";
import { formatBytes, formatDuration, formatPercent } from "@/lib/stack/resources";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { Empty, NodeCard, NodeTitle, Row, StatusDot, Time } from "./primitives";
import { useNow, useStack, useStore, useWorkbench } from "./provider";
import { Section, Window } from "./window";

/** A labeled copy chip: the URL stays out of the layout but in the title and clipboard. */
export function CopyChip({ label, value, name, hint }: { label: string; value: string; name: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" title={hint ? `${hint}\n${value}` : value} aria-label={`Copy ${name} ${label} URL`}
    onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_200); })}
    className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 font-mono text-[0.65rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
    {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}{label}
  </button>;
}

const componentScopeId = (name: string) => `component:${encodeURIComponent(name)}`;

export function ServerWindow() {
  const { server, resources, status, endpoints } = useStack();
  const { goTo } = useWorkbench();
  const now = useNow();
  const data = server.data;
  const running = data?.children.filter((child) => child.running).length ?? 0;
  const inspectorUrl = data?.children.some((child) => child.name === "inspector" && child.running) ? data.inspectorUrl : null;
  const runtime = resources.data?.runtime ?? null;
  const serverScope = resources.data?.scopes.find((scope) => scope.id === "component:server");
  const scopeOf = (name: string) => resources.data?.scopes.find((scope) => scope.id === componentScopeId(name));
  return (
    <Window id="server" title="Server" subtitle="server" icon={CpuIcon} accent="server" node={{ kind: "server" }} empty={!data && !server.error}
      status={status.serve} endpoint={endpoints.serve} updatedAt={server.at} error={server.error}
      actions={inspectorUrl ? (
        <Button variant="ghost" size="xs" nativeButton={false} render={<a href={inspectorUrl} target="_blank" rel="noreferrer" title={inspectorUrl} />}>
          MCP Inspector<ArrowUpRightIcon data-icon="inline-end" /><span className="sr-only">opens in a new tab</span>
        </Button>
      ) : null}>
      {server.error ? <p className="text-xs text-destructive" role="status">{data ? "Server read failed" : "Server status unavailable"}: {server.error}{data ? " · showing last good read" : ""}</p> : null}
      {!data && !server.error ? <Empty icon={CpuIcon} title="No server status" /> : null}
      {data ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[0.68rem] tracking-[0.08em] text-muted-foreground uppercase">
                <StatusDot tone={status.serve === "open" ? "success" : status.serve === "closed" ? "destructive" : "muted"} />
                server process
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
            {serverScope ? <>
              <Row label="Server CPU" hint="The server component's interval CPU; 100% is one logical core."><span className="tabular-nums">{formatPercent(serverScope.metrics.cpuPercent)}</span></Row>
              <Row label="Server RSS" hint="The server component's resident set.">{formatBytes(serverScope.metrics.rssBytes)}</Row>
            </> : null}
          </dl>
          <div className="flex items-center gap-1 text-[0.68rem] text-muted-foreground">
            Read <Time at={server.at} />
            <Button variant="ghost" size="xs" className="ml-auto -mr-1.5 h-5 px-1.5 text-[0.68rem] text-muted-foreground" onClick={() => goTo({ kind: "operation", pkg: "serve", id: "serve_status" })}><BookOpenIcon data-icon="inline-start" />serve_status</Button>
          </div>
          {data.indexUrl || data.uiUrl ? (
            <div className="flex flex-wrap items-center gap-1">
              {data.indexUrl ? <CopyChip label="UI" name="UI entry" value={data.indexUrl} /> : null}
              {data.uiUrl ? <CopyChip label="Canvas" name="canvas" value={data.uiUrl} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {runtime ? (
        <Section title="Server runtime">
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
      <StackSettings />
    </Window>
  );
}

/**
 * Global Stack settings (ADR 0138): durable, revisioned and separate from Bot and Worker settings. A change saves only
 * on an explicit toggle, at the revision last read; the switch shows no value until this connection has read one.
 * Local operator only: a remote page renders nothing here.
 */
function StackSettings() {
  const { serveSettings, status, remote } = useStack();
  const store = useStore();
  const now = useNow(30_000);
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  if (remote) return null;
  const data = serveSettings.data;
  const known = status.serve === "open" && data !== null && serveSettings.error === null;
  const save = (developerMode: boolean) => {
    setSaving(true);
    setProblem(null);
    store.saveServeSettings(developerMode).catch((error) => setProblem(settingsSaveProblem(errorMessage(error)))).finally(() => setSaving(false));
  };
  const note = status.serve !== "open" ? "Unknown until the server connection opens."
    : serveSettings.error ? `Unknown: ${serveSettings.error}`
      : !data ? "Reading the current setting…"
        : saving ? "Saving…"
          : data.updatedAt ? `${data.developerMode ? "On" : "Off"} · saved ${relativeTime(Date.parse(data.updatedAt), now)}` : "Off by default";
  return (
    <Section title="Stack settings">
      <div className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={`${id}-label`} className="text-sm font-medium">Developer mode</span>
          <span id={`${id}-hint`} className="text-[0.68rem] text-pretty text-muted-foreground">Show developer tools and check upstream harness releases.</span>
        </div>
        {saving ? <Spinner /> : null}
        {/* Unknown is neither on nor off: no thumb position until a read says which. */}
        <Switch aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint ${id}-state`} checked={known && data.developerMode} disabled={!known || saving}
          data-unknown={known ? undefined : ""} className={cn(!known && "border-dashed border-muted-foreground/50 data-unchecked:bg-transparent dark:data-unchecked:bg-transparent [&>[data-slot=switch-thumb]]:invisible")}
          onCheckedChange={save} />
      </div>
      <p id={`${id}-state`} role="status" className="px-0.5 text-[0.68rem] text-pretty text-muted-foreground">{note}</p>
      {problem ? <p role="alert" className={cn("px-0.5 text-[0.72rem] text-pretty", problem.kind === "failed" ? "text-destructive" : "text-warning")}>{problem.text}</p> : null}
    </Section>
  );
}

export function PackagesWindow() {
  const { server, catalog, status, endpoints, scoped } = useStack();
  const { goTo } = useWorkbench();
  const mcpUrls = server.data?.mcpUrls ?? {};
  // One row per package: its WebSocket channel from this page and its external HTTP MCP endpoint.
  const packages = [...new Set([...Object.keys(endpoints), ...Object.keys(status), ...Object.keys(mcpUrls), ...(catalog.data ?? []).map((doc) => doc.name)])].sort();
  const subscriptions = Object.values(scoped);
  return (
    <Window id="packages" title="Packages" subtitle="discovery" icon={PackageIcon} accent="server" empty={!packages.length}
      count={packages.length || null} updatedAt={catalog.at ?? server.at} error={catalog.error}>
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
                  {mcpUrls[name] ? <CopyChip label="MCP HTTP" name={name} value={mcpUrls[name]} hint="HTTP MCP endpoint for external consumers. Stack launches use stdio." /> : null}
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
