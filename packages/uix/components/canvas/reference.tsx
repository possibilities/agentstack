"use client";

import { useDeferredValue, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftIcon, BookOpenIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { operationTitle, typeLabel } from "@/lib/stack/catalog";
import { emptyLocation, locationHref, type ReferenceTarget } from "@/lib/stack/navigation";
import { requestExample, subscriptionExample, transportInstructions } from "@/lib/stack/reference";
import { nodeKey, type JsonSchema, type NodeRef, type OperationDoc, type PackageDoc, type TransportDoc } from "@/lib/stack/types";
import { CopyButton, Time } from "./primitives";
import { useStack, useWorkbench } from "./provider";

function LinkTo({ target, children, onNavigate }: { target: Extract<NodeRef, { kind: "package" | "operation" }>; children: React.ReactNode; onNavigate?(): void }) {
  const { goTo, space } = useWorkbench();
  return <a href={locationHref({ ...emptyLocation(space), reference: target })} onClick={(event) => {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate?.(); goTo(target); }
  }} className="rounded-sm text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{children}</a>;
}

function Code({ value, label }: { value: unknown; label: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <div className="group/row relative min-w-0 rounded-lg border bg-muted/30">
    <CopyButton value={text} label={label} className="absolute top-1 right-1 opacity-100" />
    <pre tabIndex={0} aria-label={label} className="max-h-[32rem] overflow-auto overscroll-contain p-3 pr-10 font-mono text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-ring">{text}</pre>
  </div>;
}

function SchemaFields({ schema, path = "", depth = 0 }: { schema: JsonSchema; path?: string; depth?: number }) {
  if (depth > 12) return <p className="text-xs text-muted-foreground">Further nesting is available in the complete JSON Schema.</p>;
  const branches = ["anyOf", "oneOf", "allOf"] as const;
  return <div className="flex min-w-0 flex-col gap-2">
    {Object.entries(schema.properties ?? {}).map(([name, field]) => {
      const key = path ? `${path}.${name}` : name;
      return <div key={name} className="flex min-w-0 flex-col gap-1 border-l pl-3">
        <div className="flex flex-wrap items-baseline gap-x-2"><code className="break-all text-xs font-medium">{key}</code><code className="break-all text-xs text-muted-foreground">{typeLabel(field)}</code>{schema.required?.includes(name) ? <Badge variant="outline">required</Badge> : null}</div>
        {field.description ? <p className="text-xs leading-relaxed text-muted-foreground">{field.description}</p> : null}
        {Object.keys(field).some((key) => ["minimum", "maximum", "minLength", "maxLength", "pattern", "format", "default", "const", "$ref", "additionalProperties"].includes(key)) ? <p className="break-all font-mono text-xs text-muted-foreground">{Object.entries(field).filter(([key]) => ["minimum", "maximum", "minLength", "maxLength", "pattern", "format", "default", "const", "$ref", "additionalProperties"].includes(key)).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(" · ")}</p> : null}
        <SchemaFields schema={field} path={key} depth={depth + 1} />
      </div>;
    })}
    {schema.items && typeof schema.items === "object" && !Array.isArray(schema.items) ? <SchemaFields schema={schema.items} path={`${path}[]`} depth={depth + 1} /> : null}
    {branches.flatMap((kind) => Array.isArray(schema[kind]) ? (schema[kind] as JsonSchema[]).map((branch, index) => <div key={`${kind}-${index}`} className="flex flex-col gap-1 border-l pl-3"><p className="text-xs text-muted-foreground">{kind} · branch {index + 1}: {typeLabel(branch)}{branch.description ? ` — ${branch.description}` : ""}</p><SchemaFields schema={branch} path={path} depth={depth + 1} /></div>) : [])}
  </div>;
}

function Schema({ title, schema }: { title: string; schema: JsonSchema }) {
  return <section className="flex min-w-0 flex-col gap-3"><h4 className="text-sm font-semibold">{title}</h4>
    <p className="break-all font-mono text-xs text-muted-foreground">{typeLabel(schema)}{schema.description ? ` · ${schema.description}` : ""}</p>
    <SchemaFields schema={schema} />
    <details className="min-w-0"><summary className="cursor-pointer rounded-sm py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">Complete {title.toLowerCase()} JSON Schema</summary><Code value={schema} label={`${title} schema`} /></details>
  </section>;
}

function Transport({ transport }: { transport: TransportDoc }) {
  return <div className="group/row flex min-w-0 flex-col gap-1 border-l pl-3">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-mono text-sm font-medium">{transport.type}</h4><Badge variant={transport.supported ? "secondary" : "outline"}>{transport.supported ? "supported" : "unsupported"}</Badge>{transport.subscriptions ? <Badge variant="outline">subscriptions</Badge> : null}</div>
    <p className="text-xs leading-relaxed text-muted-foreground">{transport.description}</p>
    {transport.endpoint ? <div className="flex items-start gap-2"><code className="min-w-0 break-all text-xs">{transport.endpoint}</code><CopyButton value={transport.endpoint} label={`${transport.type} endpoint`} className="shrink-0 opacity-100" /></div> : <p className="text-xs text-muted-foreground">No endpoint advertised.</p>}
  </div>;
}

function Operation({ doc, operation }: { doc: PackageDoc; operation: OperationDoc }) {
  return <article className="flex min-w-0 flex-col gap-6">
    <header className="flex flex-col gap-2"><p className="text-xs text-muted-foreground"><LinkTo target={{ kind: "package", id: doc.name }}>{doc.name}</LinkTo> / Operation</p>
      <h3 className="text-xl font-semibold tracking-tight">{operationTitle(operation)}</h3><code className="break-all text-xs">{operation.name}</code><p className="text-sm leading-relaxed text-muted-foreground">{operation.description}</p>
      <dl className="flex flex-wrap gap-2">{Object.entries(operation.annotations).map(([key, value]) => <div key={key} className="flex items-center gap-1 text-xs"><dt className="text-muted-foreground">{key}</dt><dd><Badge variant="outline">{String(value)}</Badge></dd></div>)}</dl>
    </header>
    <Schema title="Input" schema={operation.inputSchema} /><Separator /><Schema title="Output" schema={operation.outputSchema} /><Separator />
    <section className="flex min-w-0 flex-col gap-4"><h4 className="text-sm font-semibold">Request templates</h4><p className="text-xs leading-relaxed text-muted-foreground">Replace every &lt;replace: …&gt; placeholder with a value of the declared type and valid for current state. Required fields are included; consult the complete schema for optional fields, constraints and unions. Templates are not validated calls.</p>
      {doc.transports.map((transport) => {
        const example = requestExample(operation, transport);
        return example ? <div key={transport.type} className="flex min-w-0 flex-col gap-2"><Transport transport={transport} /><p className="text-xs leading-relaxed text-muted-foreground">{transportInstructions(transport.type)}</p><Code value={example} label={`${transport.type} request template`} /></div> : null;
      })}
      {!doc.transports.some((t) => requestExample(operation, t)) ? <p className="text-xs text-muted-foreground">No supported request transport is advertised.</p> : null}
    </section>
  </article>;
}

function Package({ doc }: { doc: PackageDoc }) {
  const { events } = useStack();
  return <article className="flex min-w-0 flex-col gap-6">
    <header className="flex flex-col gap-2"><p className="break-all font-mono text-xs text-muted-foreground">{doc.packageName}</p><h3 className="text-2xl font-semibold tracking-tight">{doc.name}</h3><p className="text-sm leading-relaxed text-muted-foreground">{doc.description}</p><p className="text-xs text-muted-foreground">{doc.operations.length} operations · {Object.keys(doc.events).length} events</p></header>
    <section className="flex flex-col gap-3"><h4 className="text-sm font-semibold">Transports</h4>{doc.transports.map((transport) => <Transport key={transport.type} transport={transport} />)}{!doc.transports.length ? <p className="text-xs text-muted-foreground">No transports configured.</p> : null}</section>
    <Separator />
    <section className="flex min-w-0 flex-col gap-3"><h4 className="text-sm font-semibold">Events and subscriptions</h4><p className="text-xs leading-relaxed text-muted-foreground">Notices carry only a topic name. Re-read current state after subscribing or reconnecting. Counts below cover this UI session only.</p>
      {Object.entries(doc.events).map(([topic, description]) => <div key={topic} className="flex flex-col gap-1 border-l pl-3"><div className="flex items-baseline justify-between gap-2"><code className="break-all text-xs">{topic}</code><span className="text-xs text-muted-foreground tabular-nums">{events.filter((event) => event.pkg === doc.name && event.topic === topic).length} notices</span></div><p className="text-xs leading-relaxed text-muted-foreground">{description}</p></div>)}
      {!Object.keys(doc.events).length ? <p className="text-xs text-muted-foreground">No declared events.</p> : null}
      {doc.eventScope ? <div className="flex flex-col gap-1 rounded-lg bg-muted/40 p-3 text-xs"><p className="font-medium">{doc.eventScope.required ? "Required" : "Optional"} subscription scope</p><p className="leading-relaxed text-muted-foreground">{doc.eventScope.description}</p><p className="break-all">Declared example: <code>{doc.eventScope.example}</code> (illustrative; verify current state).</p></div> : null}
      {doc.transports.map((transport) => {
        const example = subscriptionExample(doc, transport);
        return example ? <details key={transport.type} className="min-w-0"><summary className="cursor-pointer rounded-sm py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">Subscribe over {transport.type}</summary><div className="flex min-w-0 flex-col gap-2 pt-2"><p className="text-xs leading-relaxed text-muted-foreground">{transportInstructions(transport.type)} Replace the scope placeholder with a current scope{doc.eventScope?.required ? "." : ", or omit scope when not needed."} The acknowledgement returns accepted topics; subsequent notices use events/changed.</p><Code value={example} label={`${transport.type} subscription template`} /></div></details> : null;
      })}
      {doc.transports.some((t) => t.type === "mcp" && t.supported) ? <p className="text-xs leading-relaxed text-muted-foreground">MCP does not accept socket events/subscribe frames. Under the owner, generated MCP event tools are available to verified Bot threads; consult the tools listed by that connection.</p> : null}
    </section><Separator />
    <section className="flex flex-col gap-3"><h4 className="text-sm font-semibold">Operations</h4><ul className="flex flex-col divide-y">{doc.operations.map((operation) => <li key={operation.name} className="flex flex-col gap-1 py-3"><LinkTo target={{ kind: "operation", pkg: doc.name, id: operation.name }}><span className="text-sm font-medium">{operationTitle(operation)}</span></LinkTo><code className="break-all text-xs text-muted-foreground">{operation.name}</code><p className="text-xs leading-relaxed text-muted-foreground">{operation.description}</p></li>)}</ul></section>
  </article>;
}

export function Reference({ target, onOverview, onClose, hasInspection, expanded, onExpand }: {
  target: ReferenceTarget; onOverview(): void; onClose(): void; hasInspection: boolean; expanded: boolean; onExpand(): void;
}) {
  const { catalog } = useStack();
  const { space } = useWorkbench();
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLowerCase());
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const positions = useRef(new Map<string, number>());
  const key = target === "overview" ? target : nodeKey(target);
  useLayoutEffect(() => {
    setQuery("");
    if (scroller.current) scroller.current.scrollTop = positions.current.get(key) ?? 0;
    heading.current?.focus({ preventScroll: true });
  }, [key]);
  const docs = catalog.data ?? [];
  const name = target === "overview" ? null : target.kind === "package" ? target.id : target.pkg;
  const doc = docs.find((d) => d.name === name);
  const operation = target !== "overview" && target.kind === "operation" ? doc?.operations.find((op) => op.name === target.id) : null;
  const matches = docs.map((d) => ({ doc: d, packageMatch: `${d.name} ${d.packageName} ${d.description}`.toLowerCase().includes(search), operations: d.operations.filter((op) => `${d.name} ${op.name} ${operationTitle(op)} ${op.description}`.toLowerCase().includes(search)) })).filter((d) => d.packageMatch || d.operations.length);
  return <div className="flex min-h-0 flex-1 flex-col" data-reference>
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-4"><BookOpenIcon className="size-4" /><h2 ref={heading} tabIndex={-1} className="mr-auto text-sm font-semibold outline-none">API reference</h2>
      {hasInspection ? <Button variant="ghost" size="sm" onClick={onClose}><ArrowLeftIcon data-icon="inline-start" />Inspector</Button> : null}
      <Button variant="ghost" size="icon-sm" className="max-[899px]:hidden" aria-label={expanded ? "Restore reference width" : "Expand reading mode"} aria-pressed={expanded} onClick={onExpand}>{expanded ? <Minimize2Icon /> : <Maximize2Icon />}</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close API reference" onClick={onClose}><XIcon /></Button>
    </header>
    <div className="flex shrink-0 flex-col gap-2 border-b p-4"><label htmlFor="reference-search" className="text-xs font-medium">Find a package or operation</label><Input id="reference-search" type="search" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names and descriptions…" />
      <div className="flex items-center justify-between gap-2"><Button variant="ghost" size="sm" onClick={() => { setQuery(""); onOverview(); }}>Overview</Button><CopyButton value={typeof window === "undefined" ? locationHref({ ...emptyLocation(space), reference: target }) : new URL(locationHref({ ...emptyLocation(space), reference: target }), window.location.origin).href} label="reference link" className="opacity-100" /></div>
    </div>
    <div ref={scroller} data-scroll className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-5" onScroll={(event) => positions.current.set(key, event.currentTarget.scrollTop)}>
      {catalog.error ? <p role="status" className="text-sm text-destructive">Discovery: {catalog.error}{catalog.data ? " · Showing the last successful snapshot." : ""}</p> : null}
      {search ? <section className="flex flex-col gap-3" aria-label="Reference search results"><h3 className="text-sm font-semibold">Search results</h3>{matches.length ? matches.map(({ doc: match, packageMatch, operations }) => <div key={match.name} className="flex flex-col gap-2 border-b pb-3">{packageMatch ? <LinkTo target={{ kind: "package", id: match.name }} onNavigate={() => setQuery("")}>{match.name} · Package API</LinkTo> : <h4 className="text-xs text-muted-foreground">{match.name}</h4>}{operations.map((op) => <LinkTo key={op.name} target={{ kind: "operation", pkg: match.name, id: op.name }} onNavigate={() => setQuery("")}><span className="break-all font-mono text-xs">{op.name}</span></LinkTo>)}</div>) : <p className="text-sm text-muted-foreground">No matching packages or operations.</p>}</section> : null}
      {target === "overview" ? <section className="flex flex-col gap-5"><header className="flex flex-col gap-2"><h3 className="text-2xl font-semibold tracking-tight">Package API reference</h3><p className="text-sm leading-relaxed text-muted-foreground">Live operations, typed inputs and outputs, and change events. Select a package to read its connection and subscription contract.</p><p className="text-xs text-muted-foreground">{docs.length} packages · {docs.reduce((n, d) => n + d.operations.length, 0)} operations · {docs.reduce((n, d) => n + Object.keys(d.events).length, 0)} events</p></header><ul className="flex flex-col divide-y">{docs.map((d) => <li key={d.name} className="flex flex-col gap-1 py-3"><LinkTo target={{ kind: "package", id: d.name }}><span className="text-sm font-semibold">{d.name}</span></LinkTo><p className="text-xs leading-relaxed text-muted-foreground">{d.description}</p><p className="text-xs text-muted-foreground">{d.operations.length} operations · {d.transports.filter((t) => t.supported).map((t) => t.type).join(" · ")}</p></li>)}</ul>{!docs.length ? <p className="text-sm text-muted-foreground">Waiting for the discovery catalog.</p> : null}</section>
        : doc && (target.kind === "package" || operation) ? operation ? <Operation doc={doc} operation={operation} /> : <Package doc={doc} /> : <p className="text-sm text-muted-foreground">This reference target is absent from the current discovery snapshot.</p>}
    </div>
    <footer className="flex shrink-0 items-center gap-1 border-t px-4 py-2 text-xs text-muted-foreground">api.docs_snapshot · Read <Time at={catalog.at} /></footer>
  </div>;
}
