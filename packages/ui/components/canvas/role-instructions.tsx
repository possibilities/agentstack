"use client";

import { useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CopyPlusIcon,
  EllipsisIcon,
  FolderInputIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  ListTreeIcon,
  PencilIcon,
  PlusIcon,
  ScanSearchIcon,
  ScrollTextIcon,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import {
  addedIds,
  approxTokens,
  categoryOrder,
  categoryText,
  copyTitle,
  draftDirty,
  filterRole,
  findCategory,
  findFragment,
  formatCount,
  fragmentState,
  fragmentText,
  fragmentStateLabel,
  moveIndex,
  roleCounts,
  utf8Bytes,
} from "@/lib/stack/roles";
import { nodeKey, type RoleCategory, type RoleFragment, type RoleSnapshot } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { Empty } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { useRoleActions, useRoleView } from "./role-actions";
import { footerButton, Window } from "./window";

type Drag = { kind: "fragment"; id: string } | { kind: "category"; id: string };
type Drop = { kind: "fragment"; categoryId: string; beforeId: string | null } | { kind: "category"; beforeId: string | null };

/** Place a fragment before `beforeId` (or last) in a category; skipped when it would not move. */
function useFragmentMove() {
  const { role } = useStack();
  const actions = useRoleActions();
  return (id: string, categoryId: string, beforeId: string | null) => {
    const current = findFragment(role.data, id);
    const destination = findCategory(role.data, categoryId)?.category;
    if (!current || !destination || beforeId === id) return;
    if (current.category.id === categoryId && moveIndex(destination, id, beforeId) === current.index) return;
    actions.act("fragment_move", (snapshot) => {
      const category = findCategory(snapshot, categoryId)?.category;
      if (!category) return "That category was deleted.";
      if (!findFragment(snapshot, id)) return "That fragment was deleted.";
      return { id, categoryId, index: moveIndex(category, id, beforeId) };
    }, `move:${id}`);
  };
}

function useCategoryMove() {
  const { role } = useStack();
  const actions = useRoleActions();
  return (id: string, beforeId: string | null) => {
    const categories = role.data?.categories ?? [];
    if (beforeId === id || categoryOrder(categories, id, beforeId).join() === categories.map((category) => category.id).join()) return;
    actions.act("category_reorder", (snapshot) => findCategory(snapshot, id)
      ? { ids: categoryOrder(snapshot.categories, id, beforeId) } : "That category was deleted.", `order:${id}`);
  };
}

export function RoleInstructionsWindow() {
  const { role, rolePreview, status, endpoints, remote } = useStack();
  const actions = useRoleActions();
  const view = useRoleView();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const moveFragment = useFragmentMove();
  const moveCategory = useCategoryMove();
  const data = role.data;
  const counts = data ? roleCounts(data) : null;
  const filtered = data ? filterRole(data.categories, query) : [];
  const connected = status.roles === "open" && remote?.scope !== "view";
  const searching = query.trim().length > 0;
  const bytes = rolePreview.data?.bytes ?? null;

  const finish = () => { setDrag(null); setDrop(null); };
  const land = () => {
    if (drag?.kind === "fragment" && drop?.kind === "fragment") moveFragment(drag.id, drop.categoryId, drop.beforeId);
    if (drag?.kind === "category" && drop?.kind === "category") moveCategory(drag.id, drop.beforeId);
    finish();
  };

  return (
    <Window id="role-instructions" title="Instructions" subtitle={[view.label ?? "roles", data ? `revision ${data.revision}` : null].filter(Boolean).join(" · ")} icon={ScrollTextIcon} accent="roles"
      count={counts?.fragments ?? null} status={status.roles} endpoint={endpoints.roles} updatedAt={role.at} error={role.error}
      empty={!data?.categories.length}
      footer={
        <Button size="sm" variant="ghost" className={footerButton} disabled={!data || !connected} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => actions.open({ kind: "new-category" })}>
          <FolderPlusIcon data-icon="inline-start" />New category
        </Button>
      }>
      {data?.categories.length ? (
        <>
          <div className="flex flex-col gap-1.5">
            <InputGroup className="h-8">
              <InputGroupAddon><SearchIcon /></InputGroupAddon>
              <InputGroupInput aria-label="Search instructions" placeholder="Search titles, notes and text" value={query}
                onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
              {searching ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}><XIcon /></InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            <p role="status" className="px-0.5 text-[0.68rem] text-muted-foreground">
              {searching
                ? `${filtered.reduce((sum, item) => sum + item.fragments.length, 0)} matching fragment${filtered.reduce((sum, item) => sum + item.fragments.length, 0) === 1 ? "" : "s"}`
                : <>{counts!.rendering} of {counts!.fragments} fragment{counts!.fragments === 1 ? "" : "s"} render{bytes !== null ? <> · ≈{formatCount(approxTokens(bytes))} tokens</> : null}</>}
            </p>
          </div>
          {filtered.length ? (
            <ol className="flex flex-col gap-2" onDragEnd={finish}>
              {filtered.map(({ category, fragments }, position) => (
                <CategoryCard key={category.id} category={category} fragments={fragments} role={data}
                  collapsed={!searching && Boolean(collapsed[category.id])} onToggle={() => setCollapsed((value) => ({ ...value, [category.id]: !value[category.id] }))}
                  drag={drag} drop={drop} setDrag={setDrag} setDrop={setDrop} land={land}
                  nextCategoryId={data.categories[data.categories.findIndex((item) => item.id === category.id) + 1]?.id ?? null}
                  last={position === filtered.length - 1} />
              ))}
            </ol>
          ) : (
            <p className="px-0.5 py-4 text-center text-[0.8rem] text-muted-foreground">No instructions match “{query.trim()}”.</p>
          )}
        </>
      ) : (
        <Empty icon={ScrollTextIcon} title={view.placeholder(data, role.error, "No instructions")} />
      )}
    </Window>
  );
}

function CategoryCard({ category, fragments, role, collapsed, onToggle, drag, drop, setDrag, setDrop, land, nextCategoryId, last }: {
  category: RoleCategory;
  /** The fragments to show; fewer than the category's own while searching. */
  fragments: RoleFragment[];
  role: RoleSnapshot;
  collapsed: boolean;
  onToggle(): void;
  drag: Drag | null;
  drop: Drop | null;
  setDrag(drag: Drag | null): void;
  setDrop(drop: Drop | null): void;
  land(): void;
  nextCategoryId: string | null;
  last: boolean;
}) {
  const actions = useRoleActions();
  const { status, remote } = useStack();
  const { select, flash } = useWorkbench();
  const moveCategory = useCategoryMove();
  const connected = status.roles === "open" && remote?.scope !== "view";
  const index = role.categories.findIndex((item) => item.id === category.id);
  const node = { kind: "category", id: category.id } as const;
  const key = nodeKey(node);
  const editing = actions.target?.kind === "category" && actions.target.id === category.id;
  const dirty = draftDirty(actions.drafts[key], categoryText(category));
  const rendering = category.fragments.filter((fragment) => fragmentState(fragment, category) === "renders").length;
  const dropBefore = drag?.kind === "category" && drop?.kind === "category" && drop.beforeId === category.id;
  const dropAfter = drag?.kind === "category" && drop?.kind === "category" && drop.beforeId === null && last;
  const dropEnd = drag?.kind === "fragment" && drop?.kind === "fragment" && drop.categoryId === category.id && drop.beforeId === null;

  return (
    <li data-node={key} aria-label={`Category ${category.title}`}
      draggable={connected}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", category.title);
        setDrag({ kind: "category", id: category.id });
      }}
      onDragOver={(event) => {
        if (!drag) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (drag.kind === "category") {
          const rect = event.currentTarget.getBoundingClientRect();
          setDrop({ kind: "category", beforeId: event.clientY > rect.top + rect.height / 2 ? nextCategoryId : category.id });
        } else setDrop({ kind: "fragment", categoryId: category.id, beforeId: null });
      }}
      onDrop={(event) => { event.preventDefault(); land(); }}
      className={cn(
        "group/category relative rounded-xl border bg-background/60 transition-[border-color,background-color,opacity] duration-200",
        editing && "border-pkg-roles/50 bg-pkg-roles/5",
        !category.enabled && "bg-muted/30",
        drag?.kind === "category" && drag.id === category.id && "opacity-50",
        dropEnd && "border-pkg-roles/60",
      )}>
      {dropBefore ? <span aria-hidden className="pointer-events-none absolute inset-x-2 -top-[5px] h-0.5 rounded-full bg-pkg-roles" /> : null}
      {dropAfter ? <span aria-hidden className="pointer-events-none absolute inset-x-2 -bottom-[5px] h-0.5 rounded-full bg-pkg-roles" /> : null}
      {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-1 rounded-[inherit] animate-ui-flash" /> : null}
      <div className="flex items-center gap-1 px-1.5 pt-1.5 pb-1">
        <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 cursor-grab text-muted-foreground/40 group-hover/category:text-muted-foreground" />
        <button type="button" aria-label={collapsed ? `Expand ${category.title}` : `Collapse ${category.title}`} aria-expanded={!collapsed} onClick={onToggle}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronDownIcon className={cn("size-3.5 transition-transform duration-200", collapsed && "-rotate-90")} />
        </button>
        <button type="button" aria-current={editing ? "true" : undefined} onClick={() => actions.open(node)}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            const before = event.key === "ArrowUp" ? role.categories[index - 1]?.id : role.categories[index + 2]?.id ?? null;
            if (before !== undefined) moveCategory(category.id, before);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-0.5 text-left focus-visible:outline-2 focus-visible:outline-ring">
          <span className={cn("truncate text-[0.82rem] font-semibold tracking-tight", !category.enabled && "text-muted-foreground")}>{category.title}</span>
          {dirty ? <span role="img" aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-pkg-roles" /> : null}
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[0.64rem] font-medium text-muted-foreground tabular-nums"
            title={`${rendering} of ${category.fragments.length} render`}>
            {category.fragments.length}
          </span>
        </button>
        <Switch size="sm" checked={category.enabled} disabled={!connected || actions.pending.has(`enable:${category.id}`)}
          aria-label={`${category.title} enabled`}
          onCheckedChange={(enabled) => actions.act("category_update", (snapshot) => findCategory(snapshot, category.id)
            ? { id: category.id, enabled } : "That category was deleted.", `enable:${category.id}`)} />
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`${category.title} actions`} />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => actions.open(node)}><PencilIcon />Edit category</DropdownMenuItem>
              <DropdownMenuItem disabled={!connected} onClick={() => actions.open({ kind: "new-fragment", categoryId: category.id, enabled: true })}><PlusIcon />Add fragment</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!connected || index === 0} onClick={() => moveCategory(category.id, role.categories[index - 1]?.id ?? null)}><ArrowUpIcon />Move up</DropdownMenuItem>
              <DropdownMenuItem disabled={!connected || index === role.categories.length - 1} onClick={() => moveCategory(category.id, role.categories[index + 2]?.id ?? null)}><ArrowDownIcon />Move down</DropdownMenuItem>
              <DropdownMenuItem onClick={() => select(node)}><ScanSearchIcon />Inspect record</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={!connected} onClick={() => actions.confirmDelete(node)}><Trash2Icon />Delete…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {category.description && !collapsed ? (
        <p className="line-clamp-2 px-9 pb-1 text-[0.7rem] text-pretty text-muted-foreground">{category.description}</p>
      ) : null}
      {!category.enabled && !collapsed ? (
        <p className="px-9 pb-1 text-[0.68rem] text-muted-foreground">Off · none of these reach new Bots</p>
      ) : null}
      {collapsed ? null : (
        <div className="flex flex-col px-1 pb-1">
          {fragments.length ? (
            <ol className="flex flex-col">
              {fragments.map((fragment) => (
                <FragmentRow key={fragment.id} fragment={fragment} category={category} role={role} drag={drag} drop={drop} setDrag={setDrag} setDrop={setDrop} land={land} />
              ))}
            </ol>
          ) : null}
          <div className="relative">
            {dropEnd && fragments.length ? <span aria-hidden className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-pkg-roles" /> : null}
            <Button size="xs" variant="ghost" className="w-full justify-start text-muted-foreground hover:text-foreground" disabled={!connected}
              onClick={() => actions.open({ kind: "new-fragment", categoryId: category.id, enabled: true })}>
              <PlusIcon data-icon="inline-start" />Add fragment
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function FragmentRow({ fragment, category, role, drag, drop, setDrag, setDrop, land }: {
  fragment: RoleFragment;
  category: RoleCategory;
  role: RoleSnapshot;
  drag: Drag | null;
  drop: Drop | null;
  setDrag(drag: Drag | null): void;
  setDrop(drop: Drop | null): void;
  land(): void;
}) {
  const actions = useRoleActions();
  const { status, remote } = useStack();
  const { select, flash } = useWorkbench();
  const move = useFragmentMove();
  const connected = status.roles === "open" && remote?.scope !== "view";
  const node = { kind: "fragment", id: fragment.id } as const;
  const key = nodeKey(node);
  const index = category.fragments.findIndex((item) => item.id === fragment.id);
  const nextId = category.fragments[index + 1]?.id ?? null;
  const editing = actions.target?.kind === "fragment" && actions.target.id === fragment.id;
  const dirty = draftDirty(actions.drafts[key], fragmentText(fragment));
  const state = fragmentState(fragment, category);
  const tokens = approxTokens(utf8Bytes(fragment.body));
  const others = role.categories.filter((item) => item.id !== category.id);
  const dropHere = drag?.kind === "fragment" && drop?.kind === "fragment" && drop.categoryId === category.id && drop.beforeId === fragment.id;

  const duplicate = () => {
    actions.write("fragment_create", (snapshot) => {
      const found = findFragment(snapshot, fragment.id);
      if (!found) return "That fragment was deleted.";
      const { title, description, body, enabled } = found.fragment;
      return { categoryId: found.category.id, title: copyTitle(title), description, body, enabled, index: found.index + 1 };
    }, `duplicate:${fragment.id}`).then((snapshot) => {
      const created = addedIds(role.categories.flatMap((item) => item.fragments), snapshot.categories.flatMap((item) => item.fragments))[0];
      if (created) actions.open({ kind: "fragment", id: created });
    }, (error) => toast.error(errorMessage(error)));
  };

  return (
    <li data-node={key}
      draggable={connected}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", fragment.title);
        setDrag({ kind: "fragment", id: fragment.id });
      }}
      onDragOver={(event) => {
        if (drag?.kind !== "fragment") return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        setDrop({ kind: "fragment", categoryId: category.id, beforeId: event.clientY > rect.top + rect.height / 2 ? nextId : fragment.id });
      }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); land(); }}
      className={cn(
        "group/row relative flex items-start gap-1 rounded-lg py-1.5 pr-1 pl-0.5 transition-colors hover:bg-muted/70",
        editing && "bg-pkg-roles/10 hover:bg-pkg-roles/15",
        drag?.kind === "fragment" && drag.id === fragment.id && "opacity-40",
      )}>
      {dropHere ? <span aria-hidden className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-pkg-roles" /> : null}
      {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-0.5 rounded-[inherit] animate-ui-flash" /> : null}
      <GripVerticalIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 cursor-grab text-muted-foreground/0 group-hover/row:text-muted-foreground/60" />
      <Switch size="sm" className="mt-0.5" checked={fragment.enabled} disabled={!connected || actions.pending.has(`enable:${fragment.id}`)}
        aria-label={`${fragment.title} enabled`}
        onCheckedChange={(enabled) => actions.act("fragment_update", (snapshot) => findFragment(snapshot, fragment.id)
          ? { id: fragment.id, enabled } : "That fragment was deleted.", `enable:${fragment.id}`)} />
      <button type="button" aria-current={editing ? "true" : undefined} onClick={() => actions.open(node)}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          event.preventDefault();
          const before = event.key === "ArrowUp" ? category.fragments[index - 1]?.id : category.fragments[index + 2]?.id ?? null;
          if (before !== undefined) move(fragment.id, category.id, before);
        }}
        className="ml-1 flex min-w-0 flex-1 flex-col gap-px rounded-sm text-left leading-snug focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-[0.8rem] font-medium", state !== "renders" && "text-muted-foreground")}>{fragment.title}</span>
          {dirty ? <span role="img" aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-pkg-roles" /> : null}
        </span>
        {fragment.description ? <span className="line-clamp-1 text-[0.7rem] text-muted-foreground">{fragment.description}</span> : null}
      </button>
      <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-[0.65rem] text-muted-foreground tabular-nums">
        {state === "off" || state === "empty" ? (
          <span className={cn("rounded px-1 py-px font-medium", state === "empty" ? "bg-warning/15 text-warning" : "bg-muted")}>{fragmentStateLabel[state]}</span>
        ) : null}
        {fragment.body.trim() ? <span title={`About ${tokens} tokens`}>≈{formatCount(tokens)}</span> : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${fragment.title} actions`} />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => actions.open(node)}><PencilIcon />Edit</DropdownMenuItem>
            <DropdownMenuItem disabled={!connected} onClick={duplicate}><CopyPlusIcon />Duplicate</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!connected || index === 0} onClick={() => move(fragment.id, category.id, category.fragments[index - 1]?.id ?? null)}><ArrowUpIcon />Move up</DropdownMenuItem>
            <DropdownMenuItem disabled={!connected || index === category.fragments.length - 1} onClick={() => move(fragment.id, category.id, category.fragments[index + 2]?.id ?? null)}><ArrowDownIcon />Move down</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!connected || !others.length}><FolderInputIcon />Move to</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-40">
                {others.map((item) => (
                  <DropdownMenuItem key={item.id} onClick={() => move(fragment.id, item.id, null)}><ListTreeIcon />{item.title}</DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={() => select(node)}><ScanSearchIcon />Inspect record</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={!connected} onClick={() => actions.confirmDelete(node)}><Trash2Icon />Delete…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
