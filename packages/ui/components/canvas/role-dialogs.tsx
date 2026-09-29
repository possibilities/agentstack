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
import type { Role } from "@/lib/stack/types";

/** Confirms a change of default, which later launches follow and running sessions ignore. */
export function DefaultDialog({ role, current, pending, onConfirm, onClose }: {
  role: Role | null; current: Role | null; pending: boolean; onConfirm(): void; onClose(): void;
}) {
  return (
    <AlertDialog open={role !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia><StarIcon /></AlertDialogMedia>
          <AlertDialogTitle>Make “{role?.name}” the default?</AlertDialogTitle>
          <AlertDialogDescription>
            Later Bot launches and new Workers use this Role{current ? <> instead of “{current.name}”</> : null}. Running Bots and Workers keep what they launched with until restarted; nothing restarts automatically.
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

/** Confirms deleting a Role and everything it owns; the default is never deletable, so it only explains. */
export function DeleteRoleDialog({ role, isDefault, edits, pending, onConfirm, onClose }: {
  role: Role | null; isDefault: boolean; edits: boolean; pending: boolean; onConfirm(): void; onClose(): void;
}) {
  return (
    <AlertDialog open={role !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
          <AlertDialogTitle>{isDefault ? `“${role?.name}” is the default` : `Delete “${role?.name}”?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {isDefault
              ? "Make another Role default first. The default cannot be deleted."
              : <>This removes its instructions, skills, MCP servers and trusted projects{edits ? ", and discards its unsaved edits" : ""}. Bots and Workers that already launched keep their snapshots. This can’t be undone.</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{isDefault ? "Close" : "Cancel"}</AlertDialogCancel>
          {isDefault ? null : (
            <Button variant="destructive" disabled={!role || pending} onClick={onConfirm}>
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Delete Role
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
