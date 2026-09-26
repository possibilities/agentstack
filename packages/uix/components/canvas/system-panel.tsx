"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, BookOpenIcon, CheckIcon, ChevronRightIcon, CopyIcon, CpuIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { clockTime } from "@/lib/stack/derive";
import type { SystemTarget } from "@/lib/stack/navigation";
import { nodeKey } from "@/lib/stack/types";
import { NodeTitle, StatusDot, Time } from "./primitives";
import { useStack, useWorkbench } from "./provider";

function Group({ title, count, children, open = true, groupRef }: { title: string; count?: number; children: React.ReactNode; open?: boolean; groupRef?: React.Ref<HTMLDetailsElement> }) {
  return <details ref={groupRef} open={open} className="group/section border-b py-3 last:border-b-0">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <ChevronRightIcon aria-hidden className="size-3 transition-transform group-open/section:rotate-90" />{title}{count !== undefined ? <span className="font-normal tabular-nums">{count}</span> : null}
    </summary>
    <div className="mt-2.5 flex min-w-0 flex-col">{children}</div>
  </details>;
}

function Flash({ id }: { id: string }) {
  const { flash } = useWorkbench();
  return flash?.key === id ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute inset-0 rounded-md animate-uix-flash-in" /> : null;
}

/** A labeled copy chip: the URL stays out of the layout but in the title and clipboard. */
function CopyChip({ label, value, name }: { label: string; value: string; name: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" title={value} aria-label={`Copy ${name} ${label} URL`}
    onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_200); })}
    className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 font-mono text-[0.65rem] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
    {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}{label}
  </button>;
}

export function SystemPanel({ target, visible, onClose }: { target: SystemTarget | null; visible: boolean; onClose(): void }) {
  const { owner, catalog, status, endpoints, scoped, events, bots } = useStack();
  const { goTo } = useWorkbench();
  const [query, setQuery] = useState("");
  const healthGroup = useRef<HTMLDivElement>(null);
  const processGroup = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = query.trim().toLowerCase();
  const matches = (...values: unknown[]) => values.join(" ").toLowerCase().includes(search);
  const data = owner.data;
  const running = data?.children.filter((child) => child.running).length ?? 0;
  const children = (data?.children ?? []).filter((child) => matches(child.name, child.pid, child.error, child.running ? "running" : "stopped"));
  const mcpUrls = data?.mcpUrls ?? {};
  // One row per package: its WebSocket channel from this page and its owner MCP endpoint.
  const packages = [...new Set([...Object.keys(endpoints), ...Object.keys(status), ...Object.keys(mcpUrls)])].sort()
    .filter((name) => matches(name, endpoints[name], status[name], mcpUrls[name]));
  const activity = events.filter((event) => matches(event.pkg, event.topic, event.scope));
  const inspectorUrl = data?.children.some((child) => child.name === "inspector" && child.running) ? data.inspectorUrl : null;
  const subscriptions = Object.values(scoped);
  useEffect(() => {
    if (!visible || !target || target === "open") return;
    setQuery("");
    if (target.kind !== "owner" && processGroup.current) processGroup.current.open = true;
    const frame = requestAnimationFrame(() => {
      const node = body.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(nodeKey(target))}"]`);
      node?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [target, visible]);
  useEffect(() => {
    if (search) for (const details of body.current?.querySelectorAll("details") ?? []) details.open = true;
  }, [search]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <CpuIcon aria-hidden className="size-4 text-pkg-owner" />
      <h2 className="mr-auto text-sm font-semibold">System</h2>
      {inspectorUrl ? <Button variant="ghost" size="sm" nativeButton={false} render={<a href={inspectorUrl} target="_blank" rel="noreferrer" title={inspectorUrl} />}>MCP Inspector<ArrowUpRightIcon data-icon="inline-end" /><span className="sr-only">opens in a new tab</span></Button> : null}
      <Button variant="ghost" size="icon-sm" aria-label="Close System dock" onClick={onClose}><XIcon /></Button>
    </header>
    <div className="shrink-0 border-b px-4 py-3">
      <InputGroup className="h-8">
        <InputGroupAddon><SearchIcon /></InputGroupAddon>
        <InputGroupInput id="system-filter" type="search" autoComplete="off" aria-label="Filter System" placeholder="Filter" value={query} onChange={(event) => setQuery(event.target.value)} />
      </InputGroup>
    </div>
    <div ref={body} data-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
      {owner.error ? <p className="pt-3 text-xs text-destructive" role="status">{data ? "Owner read failed" : "Owner status unavailable"}: {owner.error}{data ? " · showing last good read" : ""}</p> : null}
      <div ref={healthGroup} data-node="owner" className="relative mt-3 flex flex-col gap-2.5 rounded-xl border bg-background/50 p-3">
        <Flash id="owner" />
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[0.68rem] tracking-[0.08em] text-muted-foreground uppercase">
              <StatusDot tone={status.owner === "open" ? "success" : status.owner === "closed" ? "destructive" : "muted"} />
              <NodeTitle node={{ kind: "owner" }} label="owner process">Owner</NodeTitle>
            </span>
            <span className="font-mono text-sm font-medium tabular-nums">{data ? `pid ${data.pid}` : "unavailable"}</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xl leading-none font-semibold tracking-tight tabular-nums">{running}<span className="text-muted-foreground">/{data?.children.length ?? 0}</span></span>
            <span className="text-[0.68rem] text-muted-foreground">running</span>
          </div>
        </div>
        {data?.children.length ? <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
          {data.children.map((child) => <span key={child.name} className={child.running ? "flex-1 bg-success/80" : "flex-1 bg-destructive"} />)}
        </div> : null}
        <div className="flex items-center gap-1 text-[0.68rem] text-muted-foreground">
          Read <Time at={owner.at} />
          <Button variant="ghost" size="xs" className="ml-auto -mr-1.5 h-5 px-1.5 text-[0.68rem] text-muted-foreground" onClick={() => goTo({ kind: "operation", pkg: "owner", id: "owner_status" })}><BookOpenIcon data-icon="inline-start" />owner_status</Button>
        </div>
      </div>
      <Group title="Processes" count={children.length} groupRef={processGroup}>{children.map((child) => <div key={child.name} data-node={`child:${child.name}`} className="relative flex flex-col gap-0.5 rounded-md px-1 py-1 hover:bg-muted/60">
        <Flash id={`child:${child.name}`} />
        <div className="flex items-center gap-2 text-xs"><StatusDot tone={child.running ? "success" : "destructive"} label={child.running ? "Running" : "Stopped"} /><NodeTitle node={{ kind: "child", id: child.name }} label={`${child.name} process`} className="font-medium">{child.name}</NodeTitle>
          {child.exitCode !== null || child.signal ? <span className="text-muted-foreground">{child.exitCode !== null ? `exit ${child.exitCode}` : ""} {child.signal}</span> : null}
          <span className="ml-auto font-mono text-muted-foreground tabular-nums">{child.pid ?? "—"}</span></div>
        {child.error ? <p className="pl-4 break-words text-xs text-destructive">{child.error}</p> : null}
      </div>)}</Group>
      <Group title="Packages" count={packages.length}>
        {packages.map((name) => <div key={name} className="group/row flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted/60">
          <StatusDot tone={status[name] === "open" ? "success" : status[name] === "closed" ? "destructive" : "muted"} label={status[name] ?? "not opened"} />
          <button className="rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => goTo({ kind: "package", id: name })}>{name}</button>
          <span className="text-muted-foreground">{status[name] ?? "—"}</span>
          <span className="ml-auto flex items-center gap-1">
            {endpoints[name] ? <CopyChip label="WS" name={name} value={endpoints[name]} /> : null}
            {mcpUrls[name] ? <CopyChip label="MCP" name={name} value={mcpUrls[name]} /> : null}
          </span>
        </div>)}
        {subscriptions.length ? <p className="px-1 pt-1.5 text-[0.68rem] text-muted-foreground">{subscriptions.filter((item) => item.status === "open").length}/{subscriptions.length} Bot subscriptions live</p> : null}
      </Group>
      <Group title="Activity" count={activity.length}><ol className="flex flex-col">{activity.map((event) => {
        const knownBot = event.scope && bots.data?.some((bot) => bot.id === event.scope);
        const knownPackage = catalog.data?.some((doc) => doc.name === event.pkg);
        return <li key={event.seq}><button disabled={!knownBot && !knownPackage} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs enabled:hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => knownBot ? goTo({ kind: "bot", id: event.scope! }) : goTo({ kind: "package", id: event.pkg })}>
          <time className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">{clockTime(event.at)}</time>
          <span className="font-medium">{event.pkg}</span>
          <code className="min-w-0 truncate text-muted-foreground">{event.topic}</code>
          {event.scope ? <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-muted-foreground">{event.scope}</span> : null}
        </button></li>;
      })}</ol>{!activity.length ? <p className="px-1 text-xs text-muted-foreground">{search ? "No matches." : "Listening…"}</p> : null}</Group>
    </div>
  </div>;
}
