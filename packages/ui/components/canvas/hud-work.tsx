"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CrosshairIcon, GitForkIcon, ListTreeIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ancestorsOf, appendOrder, attentionKinds, isTerminal, priorities, rowIndex, stateView, treeWindow, workStates, type TreeView } from "@/lib/stack/hud";
import { nodeKey, type WorkItem, type WorkState } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { AttentionChip, HudPlaceholder, hudReadOnly, PriorityMark, RequestNotice, StateMark, useHudRequest } from "./hud-shared";
import { Flash } from "./primitives";
import { useHudView, useStack, useStore, useWorkbench } from "./provider";
import { footerButton, Window } from "./window";

const views: Array<{ id: TreeView; label: string; hint: string }> = [
  { id: "open", label: "Open", hint: "Open work, with closed ancestors kept as context" },
  { id: "attention", label: "Needs a look", hint: "Marked for a human or agent, blocked, waiting or in review" },
  { id: "all", label: "All", hint: "Everything, including completed and cancelled work" },
];

/**
 * The shared Work hierarchy in its real order. Filters keep every shown item under its
 * real parent and say what they hid. Counts are open descendants, never progress.
 */
export function WorkWindow() {
  const { hudTree, status, endpoints, remote } = useStack();
  const store = useStore();
  const { view, hudView } = useHudView();
  const { flash } = useWorkbench();
  const [composing, setComposing] = useState(false);
  const rows = hudTree.data?.rows ?? [];
  const byId = useMemo(() => rowIndex(rows), [rows]);
  const shown = useMemo(() => treeWindow(rows, view.filter, view.collapsed, view.rootId), [rows, view.filter, view.collapsed, view.rootId]);
  const root = view.rootId ? byId.get(view.rootId) : undefined;
  const rootDepth = root?.depth ?? 0;
  const readOnly = hudReadOnly(remote, endpoints.hud);
  const openCount = rows.filter((row) => !isTerminal(row.item.state)).length;

  // Arriving at a Work item from anywhere selects it and makes its row visible.
  const arrived = useRef<number | null>(null);
  useEffect(() => {
    if (!flash || arrived.current === flash.seq || !flash.key.startsWith("work-item:")) return;
    const id = flash.key.slice("work-item:".length);
    if (!byId.has(id)) return;
    arrived.current = flash.seq;
    hudView.reveal(id, ancestorsOf(id, byId).map((item) => item.id));
  }, [flash, byId, hudView]);

  return (
    <Window id="hud-work" title="Work" subtitle={hudTree.data ? `${openCount} open · ${rows.length} total` : "hud"} icon={ListTreeIcon} accent="hud" bleed
      status={status.hud} endpoint={endpoints.hud} updatedAt={hudTree.at} error={hudTree.error}
      footer={readOnly ? undefined : (
        <Button variant="ghost" size="sm" className={footerButton} onClick={() => setComposing((value) => !value)} aria-expanded={composing}>
          <PlusIcon data-icon="inline-start" />New work{root ? ` in ${root.item.title}` : ""}
        </Button>
      )}>
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 p-2.5">
        <div className="relative">
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={view.filter.query} onChange={(event) => hudView.setFilter({ query: event.target.value })}
            placeholder="Find work" aria-label="Find work by title, objective, next action or label" className="h-8 pl-8 text-[0.8rem]" />
        </div>
        <div role="radiogroup" aria-label="Show" className="flex gap-1">
          {views.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={view.filter.view === item.id} title={item.hint}
              onClick={() => hudView.setFilter({ view: item.id })}
              className={cn("h-6 rounded-md px-2 text-[0.72rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                view.filter.view === item.id && "bg-muted font-medium text-foreground")}>
              {item.label}
            </button>
          ))}
        </div>
        {view.rootId ? (
          <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
            <CrosshairIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">Only <span className="text-foreground">{root?.item.title ?? "a subtree that isn't loaded"}</span> and its descendants</span>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => hudView.focusSubtree(null)}><XIcon data-icon="inline-start" />Show all</Button>
          </p>
        ) : null}
      </div>
      {composing && !readOnly ? (
        <div className="shrink-0 border-b border-border/60 p-2.5">
          <NewWorkForm parentId={view.rootId} onDone={(id) => { setComposing(false); if (id) hudView.select(id); }} />
        </div>
      ) : null}
      <div data-scroll className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-1.5">
        {!endpoints.hud ? <HudPlaceholder title="HUD isn't served by this server" />
          : !hudTree.data ? <HudPlaceholder title={hudTree.error ? "Work unavailable" : "Reading work…"} hint={hudTree.error ?? undefined} />
          : !rows.length ? <HudPlaceholder title="No work yet" hint="Create the first objective. Bots add and update work here too." />
          : shown.rootMissing ? <HudPlaceholder title="That subtree isn't loaded" hint="It may have been moved or the tree is only partly read." />
          : (
            <ul role="tree" aria-label="Work" className="flex flex-col">
              {shown.rows.map(({ row, context, collapsed }) => (
                <TreeRow key={row.item.id} item={row.item} depth={row.depth - rootDepth} childCount={row.childCount} open={row.openDescendants}
                  unmet={row.unmetDependencies.map((id) => byId.get(id)?.item.title ?? "work outside the loaded tree")}
                  context={context} collapsed={collapsed} selected={view.selectedId === row.item.id}
                  onSelect={() => hudView.select(row.item.id)} onToggle={() => hudView.toggle(row.item.id)} onFocus={() => hudView.focusSubtree(row.item.id)} />
              ))}
            </ul>
          )}
        {hudTree.data ? (
          <div className="mt-auto flex flex-col gap-1 px-1.5 pt-2 pb-1 text-[0.7rem] text-muted-foreground">
            {shown.hiddenClosed ? (
              <p>{shown.hiddenClosed} closed item{shown.hiddenClosed === 1 ? "" : "s"} hidden · <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => hudView.setFilter({ view: "all" })}>show all</button></p>
            ) : null}
            {shown.hiddenFiltered ? <p>{shown.hiddenFiltered} item{shown.hiddenFiltered === 1 ? "" : "s"} don’t match{view.filter.query ? ` “${view.filter.query}”` : " this view"}.</p> : null}
            {shown.rows.some((row) => row.context) ? <p>Dimmed rows don’t match; they show where matches really sit.</p> : null}
            {!hudTree.data.complete ? (
              <p>Showing {rows.length} of {hudTree.data.total} items. <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={store.loadMoreHudTree}>Read more</button></p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Window>
  );
}

function TreeRow({ item, depth, childCount, open, unmet, context, collapsed, selected, onSelect, onToggle, onFocus }: {
  item: WorkItem; depth: number; childCount: number; open: number; unmet: string[]; context: boolean; collapsed: boolean; selected: boolean;
  onSelect(): void; onToggle(): void; onFocus(): void;
}) {
  const key = nodeKey({ kind: "work-item", id: item.id });
  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={childCount ? !collapsed : undefined} aria-level={depth + 1} data-node={key}
      className={cn("group/work relative flex items-start gap-1 rounded-lg py-1 pr-1.5 hover:bg-muted/60", selected && "bg-muted", context && "opacity-55")}
      style={{ paddingLeft: 4 + depth * 14 }}>
      <Flash id={key} />
      {childCount ? (
        <button type="button" onClick={onToggle} aria-label={`${collapsed ? "Expand" : "Collapse"} ${item.title}`}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRightIcon className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
        </button>
      ) : <span aria-hidden className="size-5 shrink-0" />}
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <StateMark state={item.state} className="mt-px" />
          <span className={cn("min-w-0 truncate text-[0.8rem] font-medium", isTerminal(item.state) && "text-muted-foreground line-through decoration-muted-foreground/40")}>{item.title}</span>
          <PriorityMark priority={item.priority} />
          <AttentionChip attention={item.attention} className="ml-auto" />
        </span>
        {item.nextAction && !isTerminal(item.state) ? <span className="w-full truncate pl-5 text-[0.7rem] text-muted-foreground">Next: {item.nextAction}</span> : null}
        {childCount || unmet.length ? (
          <span className="flex flex-wrap items-center gap-x-2 pl-5 text-[0.66rem] text-muted-foreground tabular-nums">
            {childCount ? <span title="Open descendants; a count, not progress">{open ? `${open} open below` : `${childCount} closed below`}</span> : null}
            {unmet.length ? <span className="text-warning" title={`Waiting on: ${unmet.join(", ")}`}>{unmet.length} unmet dependenc{unmet.length === 1 ? "y" : "ies"}</span> : null}
          </span>
        ) : null}
      </button>
      {childCount ? (
        <button type="button" onClick={onFocus} aria-label={`Show only ${item.title} and its descendants`} title="Show only this subtree"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/work:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(hover:none)]:opacity-100">
          <CrosshairIcon className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}

/**
 * Create one Work item. Its ID is chosen once per draft, so retrying after a lost
 * response can never create a second item.
 */
export function NewWorkForm({ parentId, onDone }: { parentId: string | null; onDone(id: string | null): void }) {
  const { hudTree } = useStack();
  const rows = hudTree.data?.rows ?? [];
  const [id, setId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState({ title: "", objective: "", parentId, state: "planned" as WorkState, priority: "normal" as WorkItem["priority"], nextAction: "", attention: "none" as WorkItem["attention"] });
  const request = useHudRequest(() => { setId(crypto.randomUUID()); onDone(id); });
  const valid = draft.title.trim() && draft.objective.trim();
  const create = () => void request.submit("work_create", {
    id, title: draft.title.trim(), objective: draft.objective.trim(), parentId: draft.parentId, order: appendOrder(draft.parentId, rows),
    state: draft.state, priority: draft.priority, nextAction: draft.nextAction.trim(), attention: draft.attention,
  });
  const locked = request.running || request.held;
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (valid && !locked) create(); }}>
      <Input autoFocus value={draft.title} disabled={locked} maxLength={200} placeholder="Title" aria-label="Title"
        onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="h-8 text-[0.8rem]" />
      <Textarea value={draft.objective} disabled={locked} maxLength={8000} rows={3} placeholder="Objective: what outcome makes this done?" aria-label="Objective"
        onChange={(event) => setDraft({ ...draft, objective: event.target.value })} className="text-[0.8rem]" />
      <Input value={draft.nextAction} disabled={locked} maxLength={2000} placeholder="Next action (optional)" aria-label="Next action"
        onChange={(event) => setDraft({ ...draft, nextAction: event.target.value })} className="h-8 text-[0.8rem]" />
      <div className="grid grid-cols-2 gap-2">
        <ParentSelect value={draft.parentId} exclude={null} disabled={locked} onChange={(value) => setDraft({ ...draft, parentId: value })} />
        <NativeSelect size="sm" value={draft.state} disabled={locked} aria-label="State" onChange={(event) => setDraft({ ...draft, state: event.target.value as WorkState })} className="w-full">
          {workStates.filter((state) => !isTerminal(state)).map((state) => <NativeSelectOption key={state} value={state}>{stateView[state].word}</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect size="sm" value={draft.priority} disabled={locked} aria-label="Priority" onChange={(event) => setDraft({ ...draft, priority: event.target.value as WorkItem["priority"] })} className="w-full">
          {priorities.map((priority) => <NativeSelectOption key={priority} value={priority}>{priority[0].toUpperCase() + priority.slice(1)} priority</NativeSelectOption>)}
        </NativeSelect>
        <NativeSelect size="sm" value={draft.attention} disabled={locked} aria-label="Attention" onChange={(event) => setDraft({ ...draft, attention: event.target.value as WorkItem["attention"] })} className="w-full">
          {attentionKinds.map((kind) => <NativeSelectOption key={kind} value={kind}>{kind === "none" ? "No attention marker" : kind === "human" ? "Needs a human" : "Needs an agent"}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <RequestNotice request={request} />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" disabled={request.running} onClick={() => { request.clear(); onDone(null); }}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || locked}>
          {request.running ? <Spinner data-icon="inline-start" /> : <GitForkIcon data-icon="inline-start" />}Create
        </Button>
      </div>
    </form>
  );
}

/** Choose a parent from the loaded tree, indented by depth; an item can't move under itself or its descendants. */
export function ParentSelect({ value, exclude, disabled, onChange }: { value: string | null; exclude: string | null; disabled?: boolean; onChange(value: string | null): void }) {
  const { hudTree } = useStack();
  const rows = hudTree.data?.rows ?? [];
  const excluded = useMemo(() => {
    if (!exclude) return new Set<string>();
    const start = rows.findIndex((row) => row.item.id === exclude);
    const ids = new Set<string>([exclude]);
    for (let index = start + 1; start >= 0 && index < rows.length && rows[index].depth > rows[start].depth; index++) ids.add(rows[index].item.id);
    return ids;
  }, [rows, exclude]);
  return (
    <NativeSelect size="sm" value={value ?? ""} disabled={disabled} aria-label="Parent" onChange={(event) => onChange(event.target.value || null)} className="w-full">
      <NativeSelectOption value="">Top level</NativeSelectOption>
      {rows.filter((row) => !excluded.has(row.item.id)).map((row) => (
        <NativeSelectOption key={row.item.id} value={row.item.id}>{`${" ".repeat(Math.min(row.depth, 8))}${row.item.title}${isTerminal(row.item.state) ? ` (${row.item.state})` : ""}`}</NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
