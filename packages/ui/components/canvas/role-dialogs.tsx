"use client";

import { StarIcon, Trash2Icon } from "lucide-react";
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
import { defaultDeleteHint, defaultsLabel } from "@/lib/stack/roles";
import type { Role } from "@/lib/stack/types";
import type { Audience } from "./role-actions";

/**
 * Confirms a change of one launch default. The Bot default reaches later Bot launches; the Worker default reaches
 * later Workers started without a selected Role. The other default, and every running session, is untouched.
 */
export function DefaultDialog({ role, audience, botDefault, workerDefault, pending, onConfirm, onClose }: {
  role: Role | null; audience: Audience; botDefault: Role | null; workerDefault: Role | null; pending: boolean; onConfirm(): void; onClose(): void;
}) {
  const quoted = (value: Role | null, fallback: string) => value ? <>“{value.name}”</> : fallback;
  const worker = audience === "worker";
  return (
    <AlertDialog open={role !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia><StarIcon /></AlertDialogMedia>
          <AlertDialogTitle>Make “{role?.name}” the {worker ? "Worker" : "Bot"} default?</AlertDialogTitle>
          <AlertDialogDescription>
            {worker ? (
              <>Later Workers started without a selected Role use this Role{workerDefault ? <> instead of “{workerDefault.name}”</> : null}. Workers that select a Role are unaffected, and Bots still use {quoted(botDefault, "the Bot default")}. Running Workers keep the snapshot they started with.</>
            ) : (
              <>Later Bot launches use this Role{botDefault ? <> instead of “{botDefault.name}”</> : null}. Workers started without a Role still use {quoted(workerDefault, "the Worker default")}. Running Bots keep what they launched with until restarted; nothing restarts automatically.</>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={!role || pending} onClick={onConfirm}>
            {pending ? <Spinner data-icon="inline-start" /> : <StarIcon data-icon="inline-start" />}Make default
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Confirms deleting a Role and everything it owns; a launch default is never deletable, so it only explains. */
export function DeleteRoleDialog({ role, defaults, edits, pending, onConfirm, onClose }: {
  role: Role | null; defaults: { bot: boolean; worker: boolean }; edits: boolean; pending: boolean; onConfirm(): void; onClose(): void;
}) {
  const which = defaultsLabel(defaults.bot, defaults.worker);
  const blocked = defaultDeleteHint(defaults.bot, defaults.worker);
  return (
    <AlertDialog open={role !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>{which ? `“${role?.name}” is the ${which}` : `Delete “${role?.name}”?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? `${blocked}. A launch default cannot be deleted.`
              : <>This removes its instructions, skills, MCP servers and trusted projects{edits ? ", and discards its unsaved edits" : ""}. Bots and Workers that already launched keep their snapshots. This can’t be undone.</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{blocked ? "Close" : "Cancel"}</AlertDialogCancel>
          {blocked ? null : (
            <Button variant="destructive" disabled={!role || pending} onClick={onConfirm}>
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Delete Role
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
