"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, BookOpenIcon, CpuIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clockTime } from "@/lib/stack/derive";
import type { SystemTarget } from "@/lib/stack/navigation";
import { nodeKey } from "@/lib/stack/types";
import { CopyButton, NodeTitle, StatusDot, Time } from "./primitives";
import { useStack, useWorkbench } from "./provider";

function Group({ title, count, children, open = true, groupRef }: { title: string; count?: number; children: React.ReactNode; open?: boolean; groupRef?: React.Ref<HTMLDetailsElement> }) {
  return <details ref={groupRef} open={open} className="border-b py-3"><summary className="cursor-pointer rounded-sm text-xs font-semibold focus-visible:outline-2 focus-visible:outline-ring">{title}{count !== undefined ? <span className="ml-2 font-normal text-muted-foreground tabular-nums">{count}</span> : null}</summary><div className="mt-3 flex min-w-0 flex-col gap-2">{children}</div></details>;
}

export function SystemPanel({ target, visible, onClose }: { target: SystemTarget | null; visible: boolean; onClose(): void }) {
  const { owner, catalog, status, endpoints, scoped, events, bots } = useStack();
  const { goTo, flash } = useWorkbench();
  const [query, setQuery] = useState("");
  const healthGroup = useRef<HTMLDetailsElement>(null);
  const processGroup = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = query.trim().toLowerCase();
  const matches = (...values: unknown[]) => values.join(" ").toLowerCase().includes(search);
  const data = owner.data;
  const children = (data?.children ?? []).filter((child) => matches(child.name, child.pid, child.error, child.running ? "running" : "stopped"));
  const channels = [...new Set([...Object.keys(endpoints), ...Object.keys(status)])].sort().filter((name) => matches(name, endpoints[name], status[name]));
  const activity = events.filter((event) => matches(event.pkg, event.topic, event.scope));
  const referencePath = "/x/fleet?reference=overview";
  const uiUrl = data?.uixUrl ?? data?.indexUrl;
  const surfaces = [
    { title: "API reference", url: uiUrl ? new URL(referencePath, uiUrl).href : referencePath },
    { title: "UIX", url: data?.uixUrl },
    { title: "MCP Inspector", url: data?.children.some((child) => child.name === "inspector" && child.running) ? data.inspectorUrl : null },
  ].filter((s): s is { title: string; url: string } => Boolean(s.url) && matches(s.title, s.url));
  useEffect(() => {
    if (!visible || !target || target === "open") return;
    setQuery("");
    const group = target.kind === "owner" ? healthGroup : processGroup;
    if (group.current) group.current.open = true;
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
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4"><CpuIcon className="size-4" /><h2 className="mr-auto text-sm font-semibold">System</h2><Button variant="ghost" size="icon-sm" aria-label="Close System dock" onClick={onClose}><XIcon /></Button></header>
    <div className="flex shrink-0 flex-col gap-2 border-b p-4"><label htmlFor="system-filter" className="text-xs font-medium">Filter System</label><Input id="system-filter" type="search" autoComplete="off" placeholder="Processes, endpoints, notices…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div ref={body} data-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
      {owner.error ? <p className="py-3 text-xs text-destructive" role="status">{data ? "Owner status read failed" : "Owner status unavailable"}: {owner.error}{data ? " · Last successful status retained." : ""}</p> : null}
      <Group title="Health" groupRef={healthGroup}>
        <div data-node="owner" className="relative flex items-center gap-2 py-1">
          {flash?.key === "owner" ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute inset-0 animate-uix-flash-in" /> : null}
          <StatusDot tone={status.owner === "open" ? "success" : status.owner === "closed" ? "destructive" : "muted"} />
          <NodeTitle node={{ kind: "owner" }} label="owner process" className="text-sm font-medium">Owner</NodeTitle><span className="ml-auto font-mono text-xs text-muted-foreground">{data ? `pid ${data.pid}` : "unavailable"}</span>
        </div>
        <p className="text-xs text-muted-foreground">{data ? `${data.children.filter((child) => child.running).length}/${data.children.length} child processes running` : "Waiting for owner status"} · Read <Time at={owner.at} /></p>
        <Button variant="ghost" size="sm" className="self-start" onClick={() => goTo({ kind: "operation", pkg: "owner", id: "owner_status" })}><BookOpenIcon data-icon="inline-start" />owner_status reference</Button>
      </Group>
      <Group title="Processes" count={children.length} groupRef={processGroup}>{children.map((child) => <div key={child.name} data-node={`child:${child.name}`} className="relative flex flex-col gap-1 py-1">
        {flash?.key === `child:${child.name}` ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute inset-0 animate-uix-flash-in" /> : null}
        <div className="flex items-center gap-2"><StatusDot tone={child.running ? "success" : "destructive"} label={child.running ? "Running" : "Stopped"} /><NodeTitle node={{ kind: "child", id: child.name }} label={`${child.name} process`} className="text-xs font-medium">{child.name}</NodeTitle><span className="ml-auto font-mono text-xs text-muted-foreground">{child.pid ?? "—"}</span></div>
        {child.error ? <p className="break-words text-xs text-destructive">{child.error}</p> : null}
        {child.exitCode !== null || child.signal ? <p className="text-xs text-muted-foreground">{child.exitCode !== null ? `exit ${child.exitCode}` : ""} {child.signal}</p> : null}
      </div>)}</Group>
      <Group title="Connections" count={channels.length}>{channels.map((name) => <div key={name} className="group/row flex min-w-0 flex-col gap-1 py-1"><div className="flex items-center gap-2"><StatusDot tone={status[name] === "open" ? "success" : status[name] === "closed" ? "destructive" : "muted"} /><button className="rounded-sm text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => goTo({ kind: "package", id: name })}>{name}</button><span className="ml-auto text-xs text-muted-foreground">{status[name] ?? "not opened"}</span></div>{endpoints[name] ? <div className="flex min-w-0 items-start gap-1"><code className="min-w-0 break-all text-xs text-muted-foreground">{endpoints[name]}</code><CopyButton value={endpoints[name]} label={`${name} WebSocket endpoint`} className="shrink-0 opacity-100" /></div> : null}</div>)}<p className="text-xs text-muted-foreground">{Object.values(scoped).filter((s) => s.status === "open").length}/{Object.keys(scoped).length} scoped Bot subscriptions live</p></Group>
      <Group title="MCP endpoints" count={Object.entries(data?.mcpUrls ?? {}).filter(([name, url]) => matches(name, url)).length} open={false}>{Object.entries(data?.mcpUrls ?? {}).filter(([name, url]) => matches(name, url)).map(([name, url]) => <div key={name} className="group/row flex min-w-0 flex-col gap-1"><button className="self-start rounded-sm text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => goTo({ kind: "package", id: name })}>{name}</button><div className="flex min-w-0 items-start gap-1"><code className="min-w-0 break-all text-xs text-muted-foreground">{url}</code><CopyButton value={url} label={`${name} MCP endpoint`} className="shrink-0 opacity-100" /></div></div>)}</Group>
      <Group title="Surfaces" count={surfaces.length} open={false}>{surfaces.map(({ title, url }) => <div key={title} className="flex min-w-0 items-start gap-1"><a href={url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-xs hover:underline focus-visible:outline-2 focus-visible:outline-ring"><span className="flex min-w-0 flex-1 flex-col gap-1"><span>{title}</span><code className="break-all text-muted-foreground">{url}</code></span><ArrowUpRightIcon aria-hidden className="size-3 shrink-0" /><span className="sr-only">opens in a new tab</span></a><CopyButton value={url} label={`${title} URL`} className="shrink-0 opacity-100" /></div>)}</Group>
      <Group title="Activity" count={activity.length}><p className="text-xs text-muted-foreground">Notices carry a topic, not data.</p><ol className="flex flex-col gap-1">{activity.map((event) => {
        const knownBot = event.scope && bots.data?.some((bot) => bot.id === event.scope);
        const knownPackage = catalog.data?.some((doc) => doc.name === event.pkg);
        return <li key={event.seq}><button disabled={!knownBot && !knownPackage} className="flex w-full flex-col gap-0.5 rounded-md py-1.5 text-left enabled:hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => knownBot ? goTo({ kind: "bot", id: event.scope! }) : goTo({ kind: "package", id: event.pkg })}><span className="flex w-full items-center gap-2"><span className="text-xs font-medium">{event.pkg}</span><time className="ml-auto text-xs text-muted-foreground tabular-nums">{clockTime(event.at)}</time></span><code className="break-all text-xs text-muted-foreground">{event.topic}{event.scope ? ` · ${event.scope}` : ""}</code></button></li>;
      })}</ol>{!activity.length ? <p className="text-xs text-muted-foreground">{search ? "No matching notices." : "Listening for change notices."}</p> : null}</Group>
    </div>
  </div>;
}
