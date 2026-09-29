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

/** Confirms a change of Bot default, which later Bot launches follow and running sessions ignore. The Worker default is untouched. */
export function DefaultDialog({ role, current, workerDefault, pending, onConfirm, onClose }: {
  role: Role | null; current: Role | null; workerDefault: Role | null; pending: boolean; onConfirm(): void; onClose(): void;
}) {
  return (
    <AlertDialog open={role !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia><StarIcon /></AlertDialogMedia>
          <AlertDialogTitle>Make “{role?.name}” the Bot default?</AlertDialogTitle>
          <AlertDialogDescription>
            Later Bot launches use this Role{current ? <> instead of “{current.name}”</> : null}. Workers started without a Role still use {workerDefault ? <>“{workerDefault.name}”</> : "the Worker default"}. Running Bots keep what they launched with until restarted; nothing restarts automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={!role || pending} onClick={onConfirm}>
            {pending ? <Spinner data-icon="inline-start" /> : <StarIcon data-icon="inline-start" />}Make Bot default
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
