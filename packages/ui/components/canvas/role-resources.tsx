"use client";

import { useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BlocksIcon,
  CopyPlusIcon,
  EllipsisIcon,
  FolderLockIcon,
  GripVerticalIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  ScanSearchIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import {
  addedIds,
  draftDirty,
  findResource,
  formatBytes,
  internalCounts,
  mcpTarget,
  mcpText,
  projectBots,
  projectText,
  resourceOrder,
  skillBytes,
  skillText,
  uniqueName,
  type ResourceKind,
} from "@/lib/stack/roles";
import { nodeKey, type RoleMcpServer, type RoleSkill, type RoleSnapshot, type RoleTrustedProject } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { Empty } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import type { StackState } from "@/lib/stack/store";
import { resourceOperation, useRoleActions, useRoleView } from "./role-actions";
import { footerButton, Section, Window } from "./window";

type Item = { id: string; enabled: boolean; description: string };

/** One resource list: how its rows read, and how a duplicate is made when the kind allows one. */
type ListSpec<T extends Item> = {
  kind: ResourceKind;
  windowId: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  noun: string;
  newLabel: string;
  items(role: RoleSnapshot | null): T[] | undefined;
  label(item: T): string;
  /** A second line; the description when there is one. */
  detail(item: T): string;
  text(item: T): Record<string, string>;
  search(item: T): string;
  aside(item: T, state: StackState): React.ReactNode;
  duplicate?(item: T, items: T[]): Record<string, unknown>;
  note?: React.ReactNode;
  /** Content above the Role's own records, which then sit under `heading`. */
  lead?: React.ReactNode;
  heading?: string;
};

const chip = "rounded px-1.5 py-px text-[0.64rem] font-medium";

export function RoleSkillsWindow() {
  return <ResourceList<RoleSkill> spec={{
    kind: "skill", windowId: "role-skills", title: "Skills", icon: BlocksIcon, noun: "skill", newLabel: "New skill",
    items: (role) => role?.skills,
    label: (skill) => skill.name,
    detail: (skill) => skill.description,
    text: skillText,
    search: (skill) => [skill.name, skill.description, skill.body, ...skill.files.map((file) => file.path)].join("\n"),
    aside: (skill) => (
      <span className="text-[0.65rem] text-muted-foreground tabular-nums" title={`${skill.files.length} supporting file${skill.files.length === 1 ? "" : "s"}`}>
        {skill.files.length ? `${skill.files.length} file${skill.files.length === 1 ? "" : "s"} · ` : ""}{formatBytes(skillBytes(skill))}
      </span>
    ),
    duplicate: (skill, items) => ({ name: uniqueName(skill.name, items.map((item) => item.name)), description: skill.description, body: skill.body, files: skill.files, enabled: skill.enabled }),
    note: "Bots still discover project and bundled skills; Role skills add to them.",
  }} />;
}

export function RoleMcpServersWindow() {
  return <ResourceList<RoleMcpServer> spec={{
    kind: "mcp-server", windowId: "role-mcp-servers", title: "MCP servers", icon: PlugIcon, noun: "MCP server", newLabel: "New MCP server",
    items: (role) => role?.mcpServers,
    label: (server) => server.name,
    detail: (server) => server.description || mcpTarget(server.definition),
    text: mcpText,
    search: (server) => [server.name, server.description, JSON.stringify(server.definition)].join("\n"),
    aside: (server, state) => {
      const blocking = state.roleLaunch.data?.revision === state.role.data?.revision && state.roleLaunch.data?.issues.some((issue) => issue.id === server.id);
      return (
        <>
          {blocking ? <span className={cn(chip, "bg-destructive/15 text-destructive")} title="New Bot launches fail until this changes">Blocks launches</span> : null}
          <span className={cn(chip, "bg-muted font-mono text-muted-foreground")}>{server.definition.type}</span>
        </>
      );
    },
    duplicate: (server, items) => ({ name: uniqueName(server.name, items.map((item) => item.name)), description: server.description, definition: server.definition, enabled: server.enabled }),
    note: "Later launches also receive the Stack servers switched on above.",
    lead: <StackServers />,
    heading: "Role servers",
  }} />;
}

/**
 * The internal Package API servers this Role's later launches connect to, one switch each. They come from the
 * packages' manifests, so they are neither created nor deleted here; a switch changes only this Role.
 */
function StackServers() {
  const { roleInternal, status, remote } = useStack();
  const actions = useRoleActions();
  const view = useRoleView();
  const list = roleInternal.data;
  const connected = status.roles === "open" && remote?.scope !== "view";
  const { on, total } = internalCounts(list?.servers ?? []);
  // With no Role in view there are no switches to show; the window's own placeholder says why.
  if (view.blank) return null;
  return (
    <Section title="Stack servers" aside={list ? <span className="text-[0.65rem] text-muted-foreground tabular-nums">{on} of {total} on</span> : undefined}>
      {list?.servers.length ? (
        <ul aria-label="Stack servers" className="grid grid-cols-2 gap-x-1">
          {list.servers.map((server) => (
            <li key={server.name} className="flex min-w-0 items-center gap-2 rounded-lg py-1 pr-1.5 pl-2 transition-colors hover:bg-muted/70">
              <Switch size="sm" checked={server.enabled} disabled={!connected || actions.pending.has(`internal:${server.name}`)} aria-label={`${server.name} on`}
                onCheckedChange={(enabled) => { actions.setInternalMcp(server.name, enabled).catch((error) => toast.error(errorMessage(error))); }} />
              <span className={cn("min-w-0 flex-1 truncate font-mono text-[0.78rem] font-medium", !server.enabled && "text-muted-foreground")} title={server.name}>{server.name}</span>
              {!server.enabled ? <span className={cn(chip, "bg-muted text-muted-foreground")}>Off</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1.5 text-[0.7rem] text-muted-foreground">{list ? "No Stack servers are configured." : roleInternal.error ? `Stack servers unavailable: ${roleInternal.error}` : "Reading Stack servers…"}</p>
      )}
      {list && !on && total ? <p className="px-1.5 text-[0.7rem] text-muted-foreground">Every Stack server is off; later launches receive none of them.</p> : null}
      <p className="px-1.5 text-[0.66rem] text-pretty text-muted-foreground">
        Switches apply to later Bot launches and new Workers; running sessions keep their connections. New Stack packages start on.
      </p>
    </Section>
  );
}

export function RoleProjectsWindow() {
  return <ResourceList<RoleTrustedProject> spec={{
    kind: "trusted-project", windowId: "role-projects", title: "Trusted projects", icon: FolderLockIcon, noun: "trusted project", newLabel: "Trust a project",
    items: (role) => role?.trustedProjects,
    label: (project) => project.path.split("/").filter(Boolean).pop() ?? project.path,
    detail: (project) => project.path,
    text: projectText,
    search: (project) => [project.path, project.description].join("\n"),
    aside: (project, state) => {
      if (!project.enabled || state.roleLaunch.data?.revision !== state.role.data?.revision) return null;
      const inside = projectBots(state.roleLaunch.data, project.id, state.bots.data).length;
      return inside ? <span className="text-[0.65rem] text-muted-foreground tabular-nums" title="Bots running inside this root">{inside} Bot{inside === 1 ? "" : "s"}</span> : null;
    },
    note: "Trust loads the project’s whole .codex configuration for Bots launched inside it.",
  }} />;
}

function ResourceList<T extends Item>({ spec }: { spec: ListSpec<T> }) {
  const state = useStack();
  const { role, status, endpoints } = state;
  const actions = useRoleActions();
  const view = useRoleView();
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<string | null | undefined>(undefined);
  const items = spec.items(role.data) ?? [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? items.filter((item) => { const text = spec.search(item).toLowerCase(); return words.every((word) => text.includes(word)); }) : items;
  const connected = status.roles === "open" && state.remote?.scope !== "view";
  const operation = resourceOperation[spec.kind];
  const enabled = items.filter((item) => item.enabled).length;

  const move = (id: string, beforeId: string | null) => {
    if (beforeId === id || resourceOrder(items, id, beforeId).join() === items.map((item) => item.id).join()) return;
    actions.act(`${operation}_reorder`, (snapshot) => findResource(spec.items(snapshot), id)
      ? { ids: resourceOrder(spec.items(snapshot) ?? [], id, beforeId) } : `That ${spec.noun} was deleted.`, `order:${id}`);
  };
  const finish = () => { setDrag(null); setDrop(undefined); };

  const search = items.length > 4 ? (
    <InputGroup className="h-8">
      <InputGroupAddon><SearchIcon /></InputGroupAddon>
      <InputGroupInput aria-label={`Search ${spec.title.toLowerCase()}`} placeholder="Search" value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
      {query ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}><XIcon /></InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  ) : null;
  const records = items.length ? (
    <>
      {search}
      {shown.length ? (
        <ol className="flex flex-col" onDragEnd={finish}
          onDragOver={(event) => { if (drag) { event.preventDefault(); if (event.target === event.currentTarget) setDrop(null); } }}
          onDrop={(event) => { event.preventDefault(); if (drag && drop !== undefined) move(drag, drop); finish(); }}>
          {shown.map((item) => (
            <ResourceRow key={item.id} spec={spec} item={item} items={items} state={state}
              dragging={drag === item.id} dropBefore={drag !== null && drop === item.id} draggable={connected && !words.length}
              onDragStart={() => setDrag(item.id)}
              onDragOver={(before) => setDrop(before ? item.id : items[items.findIndex((other) => other.id === item.id) + 1]?.id ?? null)}
              move={move} />
          ))}
          {drag !== null && drop === null ? <li aria-hidden className="mx-2 h-0.5 rounded-full bg-pkg-roles" /> : null}
        </ol>
      ) : <p className="px-0.5 py-4 text-center text-[0.8rem] text-muted-foreground">Nothing matches “{query.trim()}”.</p>}
      {spec.note ? <p className="px-0.5 text-[0.66rem] text-pretty text-muted-foreground">{spec.note}</p> : null}
    </>
  ) : (
    <div className="flex flex-col gap-2">
      <Empty icon={spec.icon} title={view.placeholder(role.data, role.error, `No ${spec.title.toLowerCase()}`)} />
      {role.data && spec.note ? <p className="px-2 text-center text-[0.68rem] text-pretty text-muted-foreground">{spec.note}</p> : null}
    </div>
  );

  return (
    <Window id={spec.windowId} title={spec.title} subtitle={[view.label ?? "roles", role.data && !spec.lead ? `${enabled} of ${items.length} on` : null].filter(Boolean).join(" · ")} icon={spec.icon} accent="roles"
      count={spec.lead ? null : items.length} status={status.roles} endpoint={endpoints.roles} updatedAt={role.at} error={role.error} empty={!items.length && !spec.lead}
      footer={
        <Button size="sm" variant="ghost" className={footerButton} disabled={!role.data || !connected} title={state.remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => actions.open({ kind: `new-${spec.kind}`, enabled: true })}>
          <PlusIcon data-icon="inline-start" />{spec.newLabel}
        </Button>
      }>
      {spec.lead}
      {spec.heading ? (
        <Section title={spec.heading} aside={role.data ? <span className="text-[0.65rem] text-muted-foreground tabular-nums">{enabled} of {items.length} on</span> : undefined}>{records}</Section>
      ) : records}
    </Window>
  );
}

function ResourceRow<T extends Item>({ spec, item, items, state, dragging, dropBefore, draggable, onDragStart, onDragOver, move }: {
  spec: ListSpec<T>; item: T; items: T[]; state: StackState;
  dragging: boolean; dropBefore: boolean; draggable: boolean;
  onDragStart(): void; onDragOver(before: boolean): void; move(id: string, beforeId: string | null): void;
}) {
  const actions = useRoleActions();
  const { select, flash } = useWorkbench();
  const connected = state.status.roles === "open" && state.remote?.scope !== "view";
  const node = { kind: spec.kind, id: item.id } as const;
  const key = nodeKey(node);
  const index = items.findIndex((other) => other.id === item.id);
  const editing = actions.target?.kind === spec.kind && "id" in actions.target && actions.target.id === item.id;
  const dirty = draftDirty(actions.drafts[key], spec.text(item));
  const operation = resourceOperation[spec.kind];
  const label = spec.label(item);
  const detail = spec.detail(item);
  const up = () => move(item.id, items[index - 1]?.id ?? null);
  const down = () => move(item.id, items[index + 2]?.id ?? null);
  const duplicate = spec.duplicate ? () => {
    actions.write(`${operation}_create`, (snapshot) => {
      const list = spec.items(snapshot) ?? [];
      const current = findResource(list, item.id)?.item;
      return current ? spec.duplicate!(current, list) : `That ${spec.noun} was deleted.`;
    }, `duplicate:${item.id}`).then((snapshot) => {
      const created = addedIds(items, spec.items(snapshot) ?? [])[0];
      if (created) actions.open({ kind: spec.kind, id: created });
    }, (error) => toast.error(errorMessage(error)));
  } : undefined;

  return (
    <li data-node={key} draggable={draggable}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", label); onDragStart(); }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onDragOver(event.clientY < rect.top + rect.height / 2);
      }}
      className={cn(
        "group/row relative flex items-start gap-1 rounded-lg py-1.5 pr-1 pl-0.5 transition-colors hover:bg-muted/70",
        editing && "bg-pkg-roles/10 hover:bg-pkg-roles/15",
        dragging && "opacity-40",
      )}>
      {dropBefore ? <span aria-hidden className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-pkg-roles" /> : null}
      {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-0.5 rounded-[inherit] animate-ui-flash" /> : null}
      <GripVerticalIcon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground/0", draggable && "cursor-grab group-hover/row:text-muted-foreground/60")} />
      <Switch size="sm" className="mt-0.5" checked={item.enabled} disabled={!connected || actions.pending.has(`enable:${item.id}`)}
        aria-label={`${label} enabled`}
        onCheckedChange={(enabled) => actions.act(`${operation}_update`, (snapshot) => findResource(spec.items(snapshot), item.id)
          ? { id: item.id, enabled } : `That ${spec.noun} was deleted.`, `enable:${item.id}`)} />
      <button type="button" aria-current={editing ? "true" : undefined} onClick={() => actions.open(node)}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          event.preventDefault();
          if (event.key === "ArrowUp" && index > 0) up();
          if (event.key === "ArrowDown" && index < items.length - 1) down();
        }}
        className="ml-1 flex min-w-0 flex-1 flex-col gap-px rounded-sm text-left leading-snug focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate font-mono text-[0.78rem] font-medium", !item.enabled && "text-muted-foreground")}>{label}</span>
          {dirty ? <span role="img" aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-pkg-roles" /> : null}
        </span>
        {detail ? <span className="line-clamp-1 text-[0.7rem] text-muted-foreground" title={detail}>{detail}</span> : null}
      </button>
      <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
        {!item.enabled ? <span className={cn(chip, "bg-muted text-muted-foreground")}>Off</span> : null}
        {spec.aside(item, state)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${label} actions`} />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => actions.open(node)}><PencilIcon />Edit</DropdownMenuItem>
            {duplicate ? <DropdownMenuItem disabled={!connected} onClick={duplicate}><CopyPlusIcon />Duplicate</DropdownMenuItem> : null}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!connected || index === 0} onClick={up}><ArrowUpIcon />Move up</DropdownMenuItem>
            <DropdownMenuItem disabled={!connected || index === items.length - 1} onClick={down}><ArrowDownIcon />Move down</DropdownMenuItem>
            <DropdownMenuItem onClick={() => select(node)}><ScanSearchIcon />Inspect record</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={!connected} onClick={() => actions.confirmDelete(node)}>
            <Trash2Icon />{spec.kind === "trusted-project" ? "Remove…" : "Delete…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
