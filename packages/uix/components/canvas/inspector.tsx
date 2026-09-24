"use client";

import { useEffect } from "react";
import { ArrowRightIcon, LockIcon, RadioIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fieldsOf, findOperation, operationTitle, recordFields, recordOperations, type Field } from "@/lib/stack/catalog";
import { accountLabels, clockTime, shortId } from "@/lib/stack/derive";
import type { StackState } from "@/lib/stack/store";
import { nodeKey, type NodeRef, type OperationDoc, type PackageDoc, type StackEvent } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, Orb } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { accentBg, accentOf, accentText, type Accent } from "./window";
import { OperationBadges } from "./windows";

type View = {
  eyebrow: string;
  accent: Accent;
  title: string;
  orb?: string;
  record?: Record<string, unknown>;
  fields?: Map<string, Field>;
  related?: { ref: NodeRef; label: string }[];
  operations?: { pkg: string; list: OperationDoc[] };
  events?: StackEvent[];
  body?: React.ReactNode;
};

function resolve(ref: NodeRef, state: StackState): View | null {
  const catalog = state.catalog.data;
  const labels = accountLabels(state.accounts.data);
  const ownerFields = () => new Map(fieldsOf(findOperation(catalog, "owner", "owner_status")?.outputSchema).map((field) => [field.name, field]));
  switch (ref.kind) {
    case "owner": {
      const owner = state.owner.data;
      if (!owner) return null;
      return {
        eyebrow: "Owner process", accent: "owner", title: `pid ${owner.pid}`, record: { ...owner, children: owner.children.map((child) => child.name) }, fields: ownerFields(),
        related: owner.children.map((child) => ({ ref: { kind: "child", id: child.name } as NodeRef, label: child.name })),
        events: state.events.filter((event) => event.pkg === "owner"),
      };
    }
    case "child": {
      const child = state.owner.data?.children.find((item) => item.name === ref.id);
      if (!child) return null;
      const known = catalog?.some((doc) => doc.name === child.name);
      return {
        eyebrow: "Owned child", accent: "owner", title: child.name, record: child, fields: new Map(ownerFields().get("children")?.children.map((field) => [field.name, field])),
        related: known ? [{ ref: { kind: "package", id: child.name }, label: `${child.name} Package API` }] : [],
      };
    }
    case "account": {
      const account = state.accounts.data?.find((item) => item.id === ref.id);
      if (!account) return null;
      const bound = (state.servers.data ?? []).filter((server) => server.account === account.id || server.runningAccount === account.id);
      return {
        eyebrow: "Codex account", accent: "auth", title: labels.get(account.id) ?? shortId(account.id), orb: account.id, record: account,
        fields: recordFields(catalog, "auth", "account_list"),
        related: bound.map((server) => ({ ref: { kind: "server", id: server.id } as NodeRef, label: server.id })),
        operations: { pkg: "auth", list: recordOperations(catalog, "auth") },
        events: state.events.filter((event) => event.pkg === "auth"),
      };
    }
    case "login": {
      const login = state.login.data;
      if (!login) return null;
      return {
        eyebrow: "Device sign-in", accent: "auth", title: login.status === "pending" ? "Sign-in in progress" : `Sign-in ${login.status}`, record: login,
        fields: new Map(fieldsOf(findOperation(catalog, "auth", "account_login_status")?.outputSchema).map((field) => [field.name, field])),
        related: [login.account, login.targetAccount].filter((id): id is string => Boolean(id)).map((id) => ({ ref: { kind: "account", id }, label: labels.get(id) ?? shortId(id) })),
        operations: { pkg: "auth", list: (catalog?.find((doc) => doc.name === "auth")?.operations ?? []).filter((operation) => operation.name.startsWith("account_login")) },
        events: state.events.filter((event) => event.topic === "login_changed"),
      };
    }
    case "server":
    case "bot": {
      const pkg = ref.kind === "bot" ? "bots" : "codex";
      const list = ref.kind === "bot" ? state.bots.data : state.servers.data;
      const server = list?.find((item) => item.id === ref.id);
      if (!server) return null;
      const isBot = state.bots.data?.some((bot) => bot.id === server.id);
      const related: View["related"] = [];
      if (server.account) related.push({ ref: { kind: "account", id: server.account }, label: `${labels.get(server.account) ?? shortId(server.account)} · assigned` });
      if (server.runningAccount && server.runningAccount !== server.account) related.push({ ref: { kind: "account", id: server.runningAccount }, label: `${labels.get(server.runningAccount) ?? shortId(server.runningAccount)} · running` });
      if (ref.kind === "server" && isBot) related.push({ ref: { kind: "bot", id: server.id }, label: `Bot ${server.id}` });
      if (ref.kind === "bot") related.push({ ref: { kind: "server", id: server.id }, label: `Codex Server ${server.id}` });
      return {
        eyebrow: ref.kind === "bot" ? "Bot" : "Codex Server", accent: ref.kind === "bot" ? "bots" : "codex", title: server.id, record: server,
        fields: recordFields(catalog, pkg, ref.kind === "bot" ? "bot_list" : "server_list"),
        related, operations: { pkg, list: recordOperations(catalog, pkg) },
        events: state.events.filter((event) => event.scope === server.id),
      };
    }
    case "package": {
      const doc = catalog?.find((item) => item.name === ref.id);
      if (!doc) return null;
      return { eyebrow: "Package API", accent: accentOf(doc.name), title: doc.name, body: <PackageBody doc={doc} />, events: state.events.filter((event) => event.pkg === doc.name) };
    }
    case "operation": {
      const doc = catalog?.find((item) => item.name === ref.pkg);
      const operation = doc?.operations.find((item) => item.name === ref.id);
      if (!doc || !operation) return null;
      return {
        eyebrow: `${doc.name} operation`, accent: accentOf(doc.name), title: operationTitle(operation),
        body: <OperationBody doc={doc} operation={operation} endpoint={state.endpoints[doc.name]} mcp={state.owner.data?.mcpUrls[doc.name]} />,
        related: [{ ref: { kind: "package", id: doc.name }, label: `${doc.name} Package API` }],
      };
    }
  }
}

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/70 italic">null</span>;
  if (typeof value === "boolean") return <Badge variant={value ? "secondary" : "outline"} className="font-mono">{String(value)}</Badge>;
  if (typeof value === "number") return <span className="font-mono tabular-nums">{value}</span>;
  if (typeof value === "string") return <span className="font-mono break-all">{value}</span>;
  return <span className="font-mono break-all">{JSON.stringify(value)}</span>;
}

function Block({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function FieldList({ fields, depth = 0 }: { fields: Field[]; depth?: number }) {
  if (!fields.length) return <p className="text-xs text-muted-foreground">No fields.</p>;
  return (
    <ul className={cn("flex flex-col gap-2", depth > 0 && "mt-1.5 border-l pl-3")}>
      {fields.map((field) => (
        <li key={field.name} className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[0.78rem] font-medium">{field.name}</span>
            <span className="font-mono text-[0.68rem] text-muted-foreground">{field.type}</span>
            {field.required ? <span className="text-[0.62rem] tracking-wide text-muted-foreground uppercase">required</span> : null}
          </div>
          {field.description ? <p className="text-xs text-pretty text-muted-foreground">{field.description}</p> : null}
          {field.children.length ? <FieldList fields={field.children} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

function PackageBody({ doc }: { doc: PackageDoc }) {
  const { select } = useWorkbench();
  return (
    <>
      <p className="text-sm text-pretty text-muted-foreground">{doc.description}</p>
      <Block title="Transports">
        <ul className="flex flex-col gap-2">
          {doc.transports.map((transport) => (
            <li key={transport.type} className="group/row flex flex-col gap-0.5 rounded-lg border bg-background/50 p-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium">{transport.type}</span>
                {transport.subscriptions ? <Badge variant="secondary" className="h-4 gap-1 text-[0.62rem]"><RadioIcon />events</Badge> : null}
                {transport.endpoint ? <CopyButton value={transport.endpoint} label={`${transport.type} endpoint`} className="ml-auto" /> : null}
              </div>
              <p className="text-xs text-muted-foreground">{transport.description}</p>
              {transport.endpoint ? <p className="font-mono text-[0.7rem] break-all">{transport.endpoint}</p> : null}
            </li>
          ))}
        </ul>
      </Block>
      {Object.keys(doc.events).length ? (
        <Block title="Events">
          <ul className="flex flex-col gap-2">
            {Object.entries(doc.events).map(([topic, description]) => (
              <li key={topic} className="flex flex-col gap-0.5">
                <span className="font-mono text-[0.78rem] font-medium">{topic}</span>
                <p className="text-xs text-pretty text-muted-foreground">{description}</p>
              </li>
            ))}
          </ul>
          {doc.eventScope ? (
            <p className="rounded-lg bg-muted/60 p-2.5 text-xs text-pretty text-muted-foreground">
              <span className="font-medium text-foreground">{doc.eventScope.required ? "Required" : "Optional"} scope</span> — {doc.eventScope.description} Example: <span className="font-mono">{doc.eventScope.example}</span>
            </p>
          ) : null}
        </Block>
      ) : null}
      <Block title={`Operations · ${doc.operations.length}`}>
        <ul className="-mx-1.5 flex flex-col">
          {doc.operations.map((operation) => (
            <li key={operation.name}>
              <button type="button" onClick={() => select({ kind: "operation", id: operation.name, pkg: doc.name })}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                <span className="font-medium">{operationTitle(operation)}</span>
                <span className="truncate font-mono text-[0.7rem] text-muted-foreground">{operation.name}</span>
                <span className="ml-auto flex gap-1"><OperationBadges operation={operation} /></span>
              </button>
            </li>
          ))}
        </ul>
      </Block>
    </>
  );
}

function OperationBody({ doc, operation, endpoint, mcp }: { doc: PackageDoc; operation: OperationDoc; endpoint?: string; mcp?: string }) {
  const input = fieldsOf(operation.inputSchema);
  const example = Object.fromEntries(input.filter((field) => field.required).map((field) => [field.name, `<${field.type}>`]));
  const frame = JSON.stringify({ id: 1, method: "tools/call", params: { name: operation.name, arguments: example } }, null, 2);
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-mono">{operation.name}</Badge>
        <OperationBadges operation={operation} />
      </div>
      <p className="text-sm text-pretty text-muted-foreground">{operation.description}</p>
      <Block title="Input"><FieldList fields={input} /></Block>
      <Block title="Output"><FieldList fields={fieldsOf(operation.outputSchema)} /></Block>
      <Block title="Call over WebSocket" aside={<CopyButton value={frame} label="request frame" className="opacity-100" />}>
        {endpoint ? <p className="font-mono text-[0.7rem] break-all text-muted-foreground">{endpoint}</p> : null}
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-[0.72rem] leading-relaxed">{frame}</pre>
        {mcp ? <p className="text-xs text-muted-foreground">Also an MCP tool on <span className="font-mono">{mcp}</span>.</p> : doc.transports.some((transport) => transport.type === "mcp") ? null : <p className="text-xs text-muted-foreground">Not exposed over MCP.</p>}
      </Block>
    </>
  );
}

export function Inspector() {
  const { selected, select, focus } = useWorkbench();
  const state = useStack();

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("[role=dialog]")) select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, select]);

  if (!selected) return null;
  const view = resolve(selected, state);

  return (
    <aside
      key={nodeKey(selected)}
      aria-label="Inspector"
      className="fixed top-18 right-3 bottom-3 z-40 flex w-[min(420px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border bg-popover/90 text-popover-foreground shadow-[0_32px_64px_-24px_rgb(0_0_0/0.45)] backdrop-blur-2xl duration-200 animate-in fade-in-0 slide-in-from-right-4"
    >
      <header className="flex items-start gap-3 border-b px-4 py-3.5">
        {view?.orb ? <Orb id={view.orb} size="lg" /> : (
          <span className={cn("mt-0.5 size-2.5 shrink-0 rounded-full", view ? accentBg[view.accent] : "bg-muted")} />
        )}
        <div className="flex min-w-0 flex-col">
          <span className={cn("text-[0.68rem] font-medium tracking-[0.08em] uppercase", view ? accentText[view.accent] : "text-muted-foreground")}>{view?.eyebrow ?? selected.kind}</span>
          <h2 className="truncate text-lg font-semibold tracking-tight">{view?.title ?? ("id" in selected ? selected.id : selected.kind)}</h2>
        </div>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close inspector" onClick={() => select(null)}><XIcon /></Button>
      </header>
      <div data-scroll className="flex flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-4">
        {!view ? (
          <p className="text-sm text-muted-foreground">This item is no longer present in the current state.</p>
        ) : (
          <>
            {view.body}
            {view.record ? (
              <Block title="Fields" aside={<CopyButton value={JSON.stringify(view.record, null, 2)} label="JSON" className="opacity-100" />}>
                <dl className="flex flex-col divide-y rounded-xl border bg-background/50">
                  {Object.entries(view.record).map(([key, value]) => {
                    const field = view.fields?.get(key);
                    return (
                      <div key={key} className="flex flex-col gap-1 px-3 py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="font-mono text-[0.72rem] text-muted-foreground">{key}</dt>
                          {field ? <span className="font-mono text-[0.62rem] text-muted-foreground/70">{field.type}</span> : null}
                        </div>
                        <dd className="text-[0.8rem]"><Value value={value} /></dd>
                        {field?.description ? <p className="text-[0.7rem] text-pretty text-muted-foreground">{field.description}</p> : null}
                      </div>
                    );
                  })}
                </dl>
              </Block>
            ) : null}
            {view.related?.length ? (
              <Block title="Related">
                <div className="flex flex-wrap gap-1.5">
                  {view.related.map(({ ref, label }) => (
                    <Button key={nodeKey(ref)} variant="outline" size="sm" onClick={() => focus(ref)}>
                      {label}<ArrowRightIcon data-icon="inline-end" />
                    </Button>
                  ))}
                </div>
              </Block>
            ) : null}
            {view.operations?.list.length ? (
              <Block title="Actions" aside={<span className="flex items-center gap-1 text-[0.68rem] text-muted-foreground"><LockIcon className="size-3" />Read only for now</span>}>
                <ul className="flex flex-col gap-1.5">
                  {view.operations.list.map((operation) => (
                    <li key={operation.name} className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="text-[0.8rem] font-medium">{operationTitle(operation)}</span>
                        <span className="truncate font-mono text-[0.68rem] text-muted-foreground">{operation.name}</span>
                      </div>
                      <span className="ml-auto flex shrink-0 gap-1"><OperationBadges operation={operation} /></span>
                      <Tooltip>
                        <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Details for ${operation.name}`} onClick={() => select({ kind: "operation", id: operation.name, pkg: view.operations!.pkg })} />}>
                          <ArrowRightIcon />
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-64">{operation.description}</TooltipContent>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </Block>
            ) : null}
            {view.events ? (
              <Block title={`Notices · ${view.events.length}`}>
                {view.events.length ? (
                  <ol className="flex flex-col gap-1">
                    {view.events.slice(0, 12).map((event) => (
                      <li key={event.seq} className="flex items-center gap-2 font-mono text-[0.72rem]">
                        <span className="text-muted-foreground tabular-nums">{clockTime(event.at)}</span>
                        <span>{event.topic}</span>
                        <span className="ml-auto text-muted-foreground">{event.pkg}{event.scope ? ` · ${event.scope}` : ""}</span>
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-xs text-muted-foreground">No notices since this page opened.</p>}
              </Block>
            ) : null}
          </>
        )}
      </div>
      <Separator />
      <footer className="flex items-center gap-2 px-4 py-2.5 text-[0.68rem] text-muted-foreground">
        Field notes come from the live discovery schema.
        <span className="ml-auto flex items-center gap-1"><kbd className="rounded border px-1 font-sans">Esc</kbd> close</span>
      </footer>
    </aside>
  );
}
