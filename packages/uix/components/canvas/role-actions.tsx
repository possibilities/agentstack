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
import { findCategory, findFragment, type Draft } from "@/lib/stack/roles";
import type { RoleSnapshot } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { useStack, useStore } from "./provider";

/** What the Role editor shows. New records are drafts until created. */
export type RoleTarget =
  | { kind: "fragment"; id: string }
  | { kind: "category"; id: string }
  | { kind: "new-fragment"; categoryId: string; index?: number; enabled: boolean }
  | { kind: "new-category" };

export const targetKey = (target: RoleTarget): string => target.kind === "fragment" || target.kind === "category" ? `${target.kind}:${target.id}` : target.kind;

/** Builds a write's arguments from the Role it will apply to, or explains why it no longer can. */
export type RoleWrite = (role: RoleSnapshot) => Record<string, unknown> | string;

type RoleActions = {
  target: RoleTarget | null;
  open(target: RoleTarget | null): void;
  drafts: Record<string, Draft>;
  setDraft(key: string, draft: Draft | null): void;
  /** Keys of writes in flight, so each control can show its own pending state. */
  pending: ReadonlySet<string>;
  /**
   * Run one Roles mutation against the latest revision. A stale-revision refusal wrote nothing, so the
   * write is rebuilt once from a fresh read; it stops if the rebuild says the change no longer applies.
   */
  write(name: string, build: RoleWrite, key?: string): Promise<RoleSnapshot>;
  /** Fire-and-report form of `write` for switches and menu items. */
  act(name: string, build: RoleWrite, key?: string, success?: string): void;
  confirmDelete(target: { kind: "fragment" | "category"; id: string }): void;
};

const RoleActionsContext = createContext<RoleActions | null>(null);

export function useRoleActions(): RoleActions {
  const value = use(RoleActionsContext);
  if (!value) throw new Error("useRoleActions requires RoleActionsProvider");
  return value;
}

const stale = /stale role revision/;

export function RoleActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { role } = useStack();
  const [target, setTarget] = useState<RoleTarget | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<{ kind: "fragment" | "category"; id: string } | null>(null);
  const draftsRef = useRef(drafts);
  useEffect(() => { draftsRef.current = drafts; }, [drafts]);

  const setDraft = useCallback((key: string, draft: Draft | null) => setDrafts((current) => {
    const next = { ...current };
    if (draft && Object.keys(draft.values).length) next[key] = draft;
    else delete next[key];
    return next;
  }), []);

  const write = useCallback(async (name: string, build: RoleWrite, key = name): Promise<RoleSnapshot> => {
    const attempt = async (snapshot: RoleSnapshot) => {
      const args = build(snapshot);
      if (typeof args === "string") throw new Error(args);
      return store.call<RoleSnapshot>("roles", name, { ...args, expectedRevision: snapshot.revision });
    };
    setPending((current) => new Set(current).add(key));
    try {
      const current = store.getState().role.data;
      if (!current) throw new Error("The Role has not loaded yet");
      try {
        return await attempt(current);
      } catch (error) {
        if (!stale.test(errorMessage(error))) throw error;
        return await attempt(await store.reloadRole());
      }
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }, [store]);

  const act = useCallback((name: string, build: RoleWrite, key?: string, success?: string) => {
    write(name, build, key).then(() => { if (success) toast.success(success); }, (error) => toast.error(errorMessage(error)));
  }, [write]);

  // Leaving the page drops unsaved drafts, so ask first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (Object.keys(draftsRef.current).length) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const doomed = deleting ? (deleting.kind === "fragment" ? findFragment(role.data, deleting.id)?.fragment : findCategory(role.data, deleting.id)?.category) : null;
  const blocked = deleting?.kind === "category" && doomed && "fragments" in doomed && doomed.fragments.length > 0;
  const deleteKey = deleting ? `delete:${deleting.id}` : "";
  const remove = () => {
    if (!deleting) return;
    const { kind, id } = deleting;
    write(`${kind}_delete`, (snapshot) => (kind === "fragment" ? findFragment(snapshot, id) : findCategory(snapshot, id)) ? { id } : `That ${kind} was already deleted.`, deleteKey)
      .then(() => {
        setDeleting(null);
        setDraft(`${kind}:${id}`, null);
        setTarget((current) => current && "id" in current && current.id === id ? null : current);
      }, (error) => toast.error(errorMessage(error)));
  };

  const value = useMemo<RoleActions>(() => ({
    target, open: setTarget, drafts, setDraft, pending, write, act, confirmDelete: setDeleting,
  }), [target, drafts, setDraft, pending, write, act]);

  return (
    <RoleActionsContext value={value}>
      {children}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open && !pending.has(deleteKey)) setDeleting(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
            <AlertDialogTitle>{blocked ? "Category isn’t empty" : `Delete ${deleting?.kind === "category" ? "category" : "fragment"}${doomed ? ` “${doomed.title}”` : ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {blocked ? "Move or delete its fragments first. Deleting a category never deletes content."
                : deleting?.kind === "category" ? "New Bots stop seeing it. Running Bots keep what they launched with."
                : "Its instructions leave the next Bot launches. Running Bots keep what they launched with. This can’t be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending.has(deleteKey)}>{blocked ? "Close" : "Cancel"}</AlertDialogCancel>
            {blocked ? null : (
              <Button variant="destructive" disabled={!doomed || pending.has(deleteKey)} onClick={remove}>
                {pending.has(deleteKey) ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
                Delete
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RoleActionsContext>
  );
}
