"use client";

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  catalogScope,
  draftKey,
  findCategory,
  findFragment,
  findResource,
  harnessText,
  resolveSelection,
  roleErrorText,
  roleLabel,
  roleNameIssue,
  roleScoped,
  scopedRoles,
  type Draft,
  type ResourceKind,
} from "@/lib/stack/roles";
import type { Role, RoleCapabilityHarnesses, RoleCatalog, RoleInternalMcp, RoleReceipt, RoleSnapshot } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { useStack, useStore } from "./provider";
import { DefaultDialog, DeleteRoleDialog } from "./role-dialogs";

/** What the Role editor shows. New records are drafts until created. */
export type RoleTarget =
  | { kind: "role"; id: string }
  | { kind: "new-role" }
  | { kind: "fragment"; id: string }
  | { kind: "category"; id: string }
  | { kind: "new-fragment"; categoryId: string; index?: number; enabled: boolean }
  | { kind: "new-category" }
  | { kind: ResourceKind; id: string }
  | { kind: "new-skill" | "new-mcp-server" | "new-trusted-project"; enabled: boolean };

/** A saved Role record, as the editor, inspector and delete confirmation address it. */
export type RoleRecord = { kind: "fragment" | "category" | ResourceKind; id: string };

export const targetKey = (target: RoleTarget): string => "id" in target ? `${target.kind}:${target.id}` : target.kind;

/** The operation-name stem for each resource kind, as in `skill_update` or `project_delete`. */
export const resourceOperation: Record<ResourceKind, string> = { skill: "skill", "mcp-server": "mcp_server", "trusted-project": "project" };

/** A saved resource record by kind and ID, or null once it is gone. */
export function findRoleResource(role: RoleSnapshot | null, kind: ResourceKind, id: string) {
  const list = kind === "skill" ? role?.skills : kind === "mcp-server" ? role?.mcpServers : role?.trustedProjects;
  return findResource<{ id: string }>(list, id);
}

/** Builds a write's arguments from the Role it will apply to, or explains why it no longer can. */
export type RoleWrite = (role: RoleSnapshot) => Record<string, unknown> | string;
/** Builds a catalog write's arguments from the catalog it will apply to; a string explains why it no longer can, null that nothing is left to do. */
type CatalogWrite = (catalog: RoleCatalog) => Record<string, unknown> | string | null;

type RoleActions = {
  /** The Role every action below applies to: the page's selection, fixed when the value was made. Null until the catalog names one. */
  roleId: string | null;
  /** This Role's editor target, or a Role being created. Each Role keeps its own, so switching back restores it. */
  target: RoleTarget | null;
  open(target: RoleTarget | null): void;
  /** Select a Role and open a target on it, e.g. its details. */
  openIn(roleId: string, target: RoleTarget): void;
  /** Edit another Role. Selecting never changes the default. */
  select(roleId: string): void;
  /** This Role's unsaved drafts, and those of a Role not yet created, keyed as the editors do. */
  drafts: Record<string, Draft>;
  /** Roles holding unsaved drafts, including ones deleted since. */
  draftedRoles: ReadonlySet<string>;
  setDraft(key: string, draft: Draft | null): void;
  /** Throw away a Role's drafts, e.g. once it is deleted. Nothing is written. */
  discardDrafts(roleId: string): void;
  /** A Role's name as last seen, for one that has since been deleted. */
  knownName(roleId: string): string | null;
  /** Whether a write is in flight, under a key local to this Role (or to the catalog), so each control can show its own pending state. */
  pending: { has(key: string): boolean };
  /**
   * Run one Roles mutation against this Role's latest revision. A stale-revision refusal wrote nothing, so the
   * write is rebuilt once from a fresh read; it stops if the rebuild says the change no longer applies.
   */
  write(name: string, build: RoleWrite, key?: string): Promise<RoleSnapshot>;
  /** Fire-and-report form of `write` for switches and menu items. */
  act(name: string, build: RoleWrite, key?: string, success?: string): void;
  /**
   * Edit one internal Stack MCP server's switch and/or harness filter for this Role's later launches. Only the
   * supplied fields are written; `expected` fences a harness change against a filter edited elsewhere.
   */
  setInternalMcp(name: string, patch: { enabled?: boolean; harnesses?: RoleCapabilityHarnesses; expected?: RoleCapabilityHarnesses }): Promise<void>;
  /** Create a Role with the catalog revision, then select it. */
  createRole(name: string, description: string): Promise<Role>;
  confirmDelete(target: RoleRecord): void;
  /** Ask to make a Role the Bot default or the Worker default; each changes only its own audience's later launches. */
  confirmDefault(roleId: string, audience?: Audience): void;
  confirmDeleteRole(roleId: string): void;
};

/** Which launches a default applies to: Bots, or Workers started without a selected Role. */
export type Audience = "bot" | "worker";
const defaultKey = (id: string, audience: Audience) => `${audience === "worker" ? "worker-default" : "default"}:${id}`;

const RoleActionsContext = createContext<RoleActions | null>(null);

export function useRoleActions(): RoleActions {
  const value = use(RoleActionsContext);
  if (!value) throw new Error("useRoleActions requires RoleActionsProvider");
  return value;
}

/** Where a window's Role stands: still loading, not created yet, deleted elsewhere with edits left behind, or ready. */
export type RoleView = {
  state: "loading" | "empty" | "missing" | "ready";
  catalog: RoleCatalog | null;
  roleId: string | null;
  /** The selected Role, while the catalog lists it. */
  role: Role | null;
  /** The Bot default, which Make default changes. */
  defaultRole: Role | null;
  isDefault: boolean;
  /** The default for Workers started without a Role; set only through the Roles API. */
  workerDefaultRole: Role | null;
  isWorkerDefault: boolean;
  /** “Manager · Bot default”, for window subtitles. */
  label: string | null;
  /** The placeholder title for a window with no Role to show, or null when it has one or is still loading. */
  blank: string | null;
  /** A window's placeholder: no Role, a Role still loading or unreadable, or `none` for a loaded Role with nothing to list. */
  placeholder(loaded: unknown, error: string | null, none: string): string;
};

export function useRoleView(): RoleView {
  const { roleCatalog, roleId } = useStack();
  const { draftedRoles } = useRoleActions();
  const catalog = roleCatalog.data;
  const role = (roleId && catalog?.roles.find((item) => item.id === roleId)) || null;
  const defaultRole = catalog?.roles.find((item) => item.id === catalog.defaultRoleId) ?? null;
  const isDefault = Boolean(role && role.id === defaultRole?.id);
  const workerDefaultRole = catalog?.roles.find((item) => item.id === catalog.workerDefaultRoleId) ?? null;
  const isWorkerDefault = Boolean(role && role.id === workerDefaultRole?.id);
  // A vanished Role without edits is about to fall back to the default; only one holding edits stays for review.
  const state = !catalog ? "loading" : !catalog.roles.length ? "empty" : role ? "ready" : roleId && draftedRoles.has(roleId) ? "missing" : "loading";
  const blank = state === "empty" ? "No Role yet" : state === "missing" ? "Role deleted" : null;
  return { state, catalog, roleId, role, defaultRole, isDefault, workerDefaultRole, isWorkerDefault, label: roleLabel(role, catalog), blank,
    placeholder: (loaded, error, none) => blank ?? (loaded ? none : error ? "Role unavailable" : "Reading Role…") };
}

const stale = /stale role revision/;
const staleCatalog = /stale role catalog revision/;
/** Each viewer remembers which Role it last edited; it never carries a draft or the default. */
const storageKey = "stack.uix.roles.v1";

export function RoleActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { role, roleId, roleCatalog } = useStack();
  const catalog = roleCatalog.data;
  const [targets, setTargets] = useState<Record<string, RoleTarget | null>>({});
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<{ roleId: string; record: RoleRecord } | null>(null);
  const [defaulting, setDefaulting] = useState<{ id: string; audience: Audience } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const draftsRef = useRef(drafts);
  useEffect(() => { draftsRef.current = drafts; }, [drafts]);
  // Names as last seen, so a Role deleted elsewhere can still be called by name; and Roles this page just removed itself.
  const names = useRef(new Map<string, string>());
  const quiet = useRef(new Set<string>());
  const drafted = useMemo(() => scopedRoles(drafts), [drafts]);

  // Restore which Role this viewer last edited; storage may be blocked or empty, and the catalog decides whether it still exists.
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      const selected = typeof saved === "object" && saved !== null && "selected" in saved ? saved.selected : null;
      if (typeof selected === "string" && store.getState().roleId === null) store.selectRole(selected);
    } catch { /* optional persistence */ }
  }, [store]);
  useEffect(() => {
    if (!roleId) return;
    try { window.localStorage.setItem(storageKey, JSON.stringify({ selected: roleId })); } catch { /* optional persistence */ }
  }, [roleId]);

  useEffect(() => { for (const item of catalog?.roles ?? []) names.current.set(item.id, item.name); }, [catalog]);
  // With no valid selection, edit the default. A selected Role deleted elsewhere is left in place while it holds
  // unsaved edits, so they can be reviewed; without any, fall back to the default and say so once.
  useEffect(() => {
    const selected = store.getState().roleId;
    const next = resolveSelection(selected, catalog, drafted);
    if (next.roleId !== selected) store.selectRole(next.roleId);
    const name = next.fellBack && !quiet.current.has(next.fellBack) ? names.current.get(next.fellBack) : null;
    if (name) toast.info(`“${name}” was deleted in another window`, { description: next.roleId ? "Now editing the Bot default Role." : undefined });
  }, [store, roleId, catalog, drafted]);

  // A record's delete confirmation belongs to the Role it was opened for.
  useEffect(() => { setDeleting((current) => current && current.roleId === roleId ? current : null); }, [roleId]);

  const track = useCallback(async <T,>(scope: string, key: string, action: () => Promise<T>): Promise<T> => {
    const id = `${scope}:${key}`;
    setPending((current) => new Set(current).add(id));
    try {
      return await action();
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  }, []);

  const setDraft = useCallback((key: string, draft: Draft | null) => {
    if (!roleId && key !== "new-role") return;
    const scoped = draftKey(roleId ?? catalogScope, key);
    setDrafts((current) => {
      const next = { ...current };
      if (draft && Object.keys(draft.values).length) next[scoped] = draft;
      else delete next[scoped];
      return next;
    });
  }, [roleId]);

  const discardDrafts = useCallback((id: string) => {
    quiet.current.add(id);
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${id}:`))));
    setTargets((current) => { const next = { ...current }; delete next[id]; return next; });
  }, []);

  const writeFor = useCallback(async (id: string, name: string, build: RoleWrite, key = name): Promise<RoleSnapshot> => {
    const attempt = async (snapshot: RoleSnapshot) => {
      const args = build(snapshot);
      if (typeof args === "string") throw new Error(args);
      await store.call<RoleReceipt>("roles", name, { ...args, roleId: id, expectedRevision: snapshot.revision });
      return store.reloadRole(id);
    };
    return track(id, key, async () => {
      // The held snapshot is the selected Role's; a write built for another Role reads its own.
      const held = store.getState().role.data;
      const current = held?.id === id ? held : await store.reloadRole(id);
      try {
        return await attempt(current);
      } catch (error) {
        if (!stale.test(errorMessage(error))) throw error;
        return await attempt(await store.reloadRole(id));
      }
    });
  }, [store, track]);

  const write = useCallback((name: string, build: RoleWrite, key?: string): Promise<RoleSnapshot> => {
    if (!roleId) return Promise.reject(new Error("No Role is selected"));
    return writeFor(roleId, name, build, key);
  }, [roleId, writeFor]);

  const act = useCallback((name: string, build: RoleWrite, key?: string, success?: string) => {
    write(name, build, key).then(() => { if (success) toast.success(success); }, (error) => toast.error(errorMessage(error)));
  }, [write]);

  /** A catalog write carries the catalog revision, which is not any Role's; its reply is the new catalog. */
  const catalogWrite = useCallback((name: "role_create" | "role_set_default" | "role_set_worker_default" | "role_delete", build: CatalogWrite, key: string): Promise<RoleCatalog> => {
    const attempt = async (held: RoleCatalog) => {
      const args = build(held);
      if (typeof args === "string") throw new Error(args);
      return args === null ? held : await store.call<RoleCatalog>("roles", name, { ...args, expectedRevision: held.revision });
    };
    return track(catalogScope, key, async () => {
      const held = store.getState().roleCatalog.data ?? await store.reloadRoleCatalog();
      try {
        return await attempt(held);
      } catch (error) {
        if (!staleCatalog.test(errorMessage(error))) throw error;
        return await attempt(await store.reloadRoleCatalog());
      }
    }).catch((error) => { throw new Error(roleErrorText(errorMessage(error))); });
  }, [store, track]);

  const select = useCallback((id: string) => { setCreating(false); store.selectRole(id); }, [store]);

  const open = useCallback((target: RoleTarget | null) => {
    if (target?.kind === "new-role") { setCreating(true); return; }
    setCreating(false);
    if (roleId) setTargets((current) => ({ ...current, [roleId]: target }));
  }, [roleId]);

  const openIn = useCallback((id: string, target: RoleTarget) => {
    setCreating(false);
    setTargets((current) => ({ ...current, [id]: target }));
    store.selectRole(id);
  }, [store]);

  const setInternalMcp = useCallback((name: string, patch: { enabled?: boolean; harnesses?: RoleCapabilityHarnesses; expected?: RoleCapabilityHarnesses }): Promise<void> => {
    if (!roleId) return Promise.reject(new Error("No Role is selected"));
    const id = roleId;
    return track(id, `internal:${name}`, async () => {
      const attempt = async (list: RoleInternalMcp) => {
        const server = list.servers.find((item) => item.name === name);
        if (!server) throw new Error(`${name} is no longer a configured Stack server`);
        // Only the supplied fields are written; a reread already showing them means someone else made the change.
        const args: Record<string, unknown> = {};
        if (patch.enabled !== undefined && server.enabled !== patch.enabled) args.enabled = patch.enabled;
        if (patch.harnesses !== undefined) {
          const current = harnessText(server.harnesses);
          // The popover's fence: a filter that moved since it was opened is reviewed, never overwritten blind.
          if (patch.expected !== undefined && current !== harnessText(patch.expected) && current !== harnessText(patch.harnesses))
            throw new Error("This server’s harness filter changed elsewhere. Review it and apply again.");
          if (current !== harnessText(patch.harnesses)) args.harnesses = patch.harnesses;
        }
        if (!Object.keys(args).length) return;
        await store.call<RoleReceipt>("roles", "role_internal_mcp_update", { roleId: id, expectedRevision: list.revision, name, ...args });
      };
      const held = store.getState().roleInternal.data;
      try {
        await attempt(held?.roleId === id ? held : await store.reloadRoleInternal(id));
      } catch (error) {
        if (!stale.test(errorMessage(error))) throw error;
        await attempt(await store.reloadRoleInternal(id));
      }
      // A receipt carries no state: reread the list and the editor snapshot, which refreshes the previews.
      await Promise.all([store.reloadRoleInternal(id), store.reloadRole(id)]);
    });
  }, [roleId, store, track]);

  const createRole = useCallback(async (name: string, description: string): Promise<Role> => {
    const trimmed = name.trim();
    const result = await catalogWrite("role_create", (held) => roleNameIssue(trimmed, held) ?? { name: trimmed, description }, "save:new-role");
    // Names are unique, so this is the Role just made.
    const created = result.roles.find((item) => item.name === trimmed);
    if (!created) throw new Error("The Role was created, but the catalog does not list it");
    setDrafts((current) => { const next = { ...current }; delete next[draftKey(catalogScope, "new-role")]; return next; });
    select(created.id);
    return created;
  }, [catalogWrite, select]);

  const makeDefault = () => {
    if (!defaulting) return;
    const { id, audience } = defaulting;
    const label = names.current.get(id) ?? "The Role";
    const [name, field] = audience === "worker" ? ["role_set_worker_default", "workerDefaultRoleId"] as const : ["role_set_default", "defaultRoleId"] as const;
    catalogWrite(name, (held) => !held.roles.some((item) => item.id === id) ? "That Role was deleted." : held[field] === id ? null : { roleId: id }, defaultKey(id, audience))
      .then(() => { setDefaulting(null); toast.success(`“${label}” is now the ${audience === "worker" ? "Worker" : "Bot"} default`); }, (error) => toast.error(errorMessage(error)));
  };

  const removeRole = () => {
    if (!removing) return;
    const id = removing;
    const label = names.current.get(id) ?? "The Role";
    quiet.current.add(id);
    catalogWrite("role_delete", (held) => !held.roles.some((item) => item.id === id) ? null
      : held.defaultRoleId === id || held.workerDefaultRoleId === id ? "This Role is a launch default. Reassign that default before deleting it." : { roleId: id }, `delete-role:${id}`)
      .then(() => { setRemoving(null); discardDrafts(id); toast.success(`Deleted “${label}”`); }, (error) => { quiet.current.delete(id); toast.error(errorMessage(error)); });
  };

  // Leaving the page drops unsaved drafts of every Role, so ask first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (Object.keys(draftsRef.current).length) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const find = (snapshot: RoleSnapshot | null, { kind, id }: RoleRecord) => kind === "fragment" ? findFragment(snapshot, id)?.fragment
    : kind === "category" ? findCategory(snapshot, id)?.category : findRoleResource(snapshot, kind, id)?.item;
  const record = deleting && deleting.roleId === roleId ? deleting.record : null;
  const doomed = record ? find(role.data, record) : null;
  const blocked = record?.kind === "category" && Boolean(findCategory(role.data, record.id)?.category.fragments.length);
  const deleteKey = record ? `delete:${record.id}` : "";
  const copy = record ? deleteCopy(record.kind, doomed) : null;
  const remove = () => {
    if (!record || !roleId) return;
    const { kind, id } = record;
    const operation = kind === "fragment" || kind === "category" ? kind : resourceOperation[kind];
    write(`${operation}_delete`, (snapshot) => find(snapshot, record) ? { id } : `That ${copy?.noun ?? kind} was already deleted.`, deleteKey)
      .then(() => {
        setDeleting(null);
        setDraft(`${kind}:${id}`, null);
        setTargets((current) => current[roleId] && "id" in current[roleId] && current[roleId].id === id ? { ...current, [roleId]: null } : current);
      }, (error) => toast.error(errorMessage(error)));
  };

  const pendingView = useMemo(() => ({ has: (key: string) => Boolean(roleId && pending.has(`${roleId}:${key}`)) || pending.has(`${catalogScope}:${key}`) }), [pending, roleId]);
  const scopedDrafts = useMemo(() => roleScoped(drafts, roleId), [drafts, roleId]);
  const target = creating ? { kind: "new-role" as const } : roleId ? targets[roleId] ?? null : null;

  const value = useMemo<RoleActions>(() => ({
    roleId, target, open, openIn, select, drafts: scopedDrafts, draftedRoles: drafted, setDraft, discardDrafts, knownName: (id) => names.current.get(id) ?? null,
    pending: pendingView, write, act, setInternalMcp, createRole, confirmDelete: (record) => { if (roleId) setDeleting({ roleId, record }); },
    confirmDefault: (id, audience = "bot") => setDefaulting({ id, audience }), confirmDeleteRole: setRemoving,
  }), [roleId, target, open, openIn, select, scopedDrafts, drafted, setDraft, discardDrafts, pendingView, write, act, setInternalMcp, createRole]);

  const defaultTarget = catalog?.roles.find((item) => item.id === defaulting?.id);
  const removeTarget = catalog?.roles.find((item) => item.id === removing);

  return (
    <RoleActionsContext value={value}>
      {children}
      <AlertDialog open={record !== null} onOpenChange={(open) => { if (!open && !pendingView.has(deleteKey)) setDeleting(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
            <AlertDialogTitle>{blocked ? "Category isn’t empty" : copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {blocked ? "Move or delete its fragments first. Deleting a category never deletes content." : copy?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingView.has(deleteKey)}>{blocked ? "Close" : "Cancel"}</AlertDialogCancel>
            {blocked ? null : (
              <Button variant="destructive" disabled={!doomed || pendingView.has(deleteKey)} onClick={remove}>
                {pendingView.has(deleteKey) ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
                {copy?.action ?? "Delete"}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DefaultDialog role={defaultTarget ?? null} audience={defaulting?.audience ?? "bot"}
        botDefault={catalog?.roles.find((item) => item.id === catalog.defaultRoleId) ?? null} workerDefault={catalog?.roles.find((item) => item.id === catalog.workerDefaultRoleId) ?? null}
        pending={defaulting !== null && pending.has(`${catalogScope}:${defaultKey(defaulting.id, defaulting.audience)}`)} onConfirm={makeDefault} onClose={() => setDefaulting(null)} />
      <DeleteRoleDialog role={removeTarget ?? null} defaults={{ bot: Boolean(removeTarget && removeTarget.id === catalog?.defaultRoleId), worker: Boolean(removeTarget && removeTarget.id === catalog?.workerDefaultRoleId) }}
        edits={removing !== null && drafted.has(removing)}
        pending={removing !== null && pending.has(`${catalogScope}:delete-role:${removing}`)} onConfirm={removeRole} onClose={() => setRemoving(null)} />
    </RoleActionsContext>
  );
}

/** What deleting each kind of record means for later launches. */
function deleteCopy(kind: RoleRecord["kind"], record: unknown): { noun: string; title: string; description: string; action: string } {
  const field = (name: string) => record && typeof record === "object" && name in record ? String((record as Record<string, unknown>)[name]) : null;
  const named = (name: string | null) => name ? ` “${name}”` : "";
  const running = "Running Bots keep what they launched with.";
  switch (kind) {
    case "category": return { noun: "category", title: `Delete category${named(field("title"))}?`, description: `New Bots stop seeing it. ${running}`, action: "Delete" };
    case "fragment": return { noun: "fragment", title: `Delete fragment${named(field("title"))}?`, description: `Its instructions leave later launches. ${running} This can’t be undone.`, action: "Delete" };
    case "skill": {
      const files = record && typeof record === "object" && "files" in record && Array.isArray(record.files) ? record.files.length : 0;
      return { noun: "skill", title: `Delete skill${named(field("name"))}?`,
        description: `It${files ? ` and its ${files} supporting file${files === 1 ? "" : "s"}` : ""} leave later launches. ${running} This can’t be undone.`, action: "Delete" };
    }
    case "mcp-server": return { noun: "MCP server", title: `Delete MCP server${named(field("name"))}?`,
      description: `New Bots stop connecting to it. Running Bots keep their connections until restarted. This can’t be undone.`, action: "Delete" };
    case "trusted-project": return { noun: "trusted project", title: `Stop trusting${named(field("path"))}?`,
      description: `New Bots launched inside it stop loading its project configuration. ${running}`, action: "Remove" };
  }
}
