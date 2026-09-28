"use client";

import { useEffect } from "react";
import { CopyPlusIcon, EllipsisIcon, FilePenLineIcon, PlusIcon, RotateCcwIcon, SaveIcon, ScanSearchIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { draftChanges, draftConflicts, editDraft, emptyDraft, type Draft } from "@/lib/stack/roles";
import { cn } from "@/lib/utils";
import { Empty } from "./primitives";
import { useStack } from "./provider";
import { useRoleActions } from "./role-actions";
import { Window } from "./window";

export const labelClass = "px-0.5 text-[0.7rem] font-medium text-muted-foreground";
export const hintClass = "px-0.5 text-[0.68rem] text-pretty text-muted-foreground";
const fieldLabels: Record<string, string> = { title: "title", description: "description", body: "instructions", name: "name", files: "supporting files", definition: "connection", path: "path" };

export function EditorFrame({ subtitle, footer, actions, empty = false, children }: {
  subtitle?: string; footer?: React.ReactNode; actions?: React.ReactNode; empty?: boolean; children: React.ReactNode;
}) {
  const { role, status, endpoints } = useStack();
  return (
    <Window id="role-editor" title="Editor" subtitle={subtitle} icon={FilePenLineIcon} accent="roles" status={status.roles} endpoint={endpoints.roles}
      updatedAt={role.at} error={role.error} footer={footer} actions={actions} empty={empty}>
      {children}
    </Window>
  );
}

/** Shared text-draft state for one record: current values, conflicts with saved changes, and what a save would send. */
export function useDraft(key: string, saved: Record<string, string>) {
  const actions = useRoleActions();
  const draft = actions.drafts[key] ?? emptyDraft;
  const value = (field: string) => field in draft.values ? draft.values[field] : saved[field] ?? "";
  return {
    draft,
    value,
    set: (field: string, next: string) => actions.setDraft(key, editDraft(draft, field, next, saved)),
    conflicts: draftConflicts(draft, saved),
    changes: draftChanges(draft, saved),
    clear: () => actions.setDraft(key, null),
    replace: (next: Draft) => actions.setDraft(key, next),
  };
}

/** ⌘S or ⌘Enter saves from anywhere in the form. */
export function saveKeys(save: () => void) {
  return (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    if (event.key.toLowerCase() !== "s" && event.key !== "Enter") return;
    event.preventDefault();
    save();
  };
}

export function ConflictNotice({ fields, onKeep, onYield }: { fields: string[]; onKeep(): void; onYield(): void }) {
  if (!fields.length) return null;
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <TriangleAlertIcon className="text-warning" />
      <AlertTitle>Changed elsewhere</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>The saved {fields.map((field) => fieldLabels[field] ?? field).join(" and ")} changed since you started editing. “Keep mine” overwrites it; “Use theirs” drops your edit.</span>
        <span className="flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={onYield}>Use theirs</Button>
          <Button size="xs" variant="outline" onClick={onKeep}>Keep mine</Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

/** `invalid` names what blocks saving; a record with nothing blocking passes null. */
export function SaveBar({ dirty, conflicts, pending, invalid, saveLabel, onSave, onRevert, note }: {
  dirty: boolean; conflicts: number; pending: boolean; invalid: string | null; saveLabel: string; onSave(): void; onRevert?: () => void; note?: React.ReactNode;
}) {
  const { status, remote } = useStack();
  const connected = status.roles === "open";
  const message = remote?.scope === "view" ? "View-only session · saving requires uix:control" : !connected ? "Roles reconnecting" : conflicts ? "Resolve the conflict to save" : invalid && dirty ? invalid : dirty ? "Unsaved changes · ⌘S to save" : note ?? "All changes saved";
  return (
    <div className="flex items-center gap-1.5 px-1.5">
      <span role="status" className={cn("min-w-0 flex-1 truncate text-[0.68rem]", dirty && !conflicts && !invalid ? "text-foreground" : "text-muted-foreground")}>{message}</span>
      {onRevert ? (
        <Button size="sm" variant="ghost" disabled={!dirty || pending} onClick={onRevert}><RotateCcwIcon data-icon="inline-start" />Revert</Button>
      ) : null}
      <Button size="sm" disabled={!connected || !dirty || Boolean(invalid) || conflicts > 0 || pending || remote?.scope === "view"} title={remote?.scope === "view" ? "Requires uix:control" : undefined} onClick={onSave}>
        {pending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}{saveLabel}
      </Button>
    </div>
  );
}

/** Once a record disappears, say so and offer to keep the unsaved text as something new. */
export function Gone({ noun, draft, onRestore }: { noun: string; draft: Draft; onRestore?: () => void }) {
  const actions = useRoleActions();
  const { role } = useStack();
  return (
    <EditorFrame empty={!role.data}>
      {role.data ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-center">
          <Trash2Icon className="size-5 text-muted-foreground/70" />
          <p className="text-sm font-medium">This {noun} no longer exists</p>
          <div className="flex gap-1.5">
            {Object.keys(draft.values).length && onRestore ? <Button size="sm" variant="outline" onClick={onRestore}><PlusIcon data-icon="inline-start" />Keep my edits as new</Button> : null}
            <Button size="sm" variant="ghost" onClick={() => actions.open(null)}><XIcon data-icon="inline-start" />Close</Button>
          </div>
        </div>
      ) : <Empty icon={FilePenLineIcon} title="Role unavailable" />}
    </EditorFrame>
  );
}

/** A new record starts with its first field focused. */
export function useFocusField(formId: string, field = "title") {
  useEffect(() => { document.getElementById(`${formId}-${field}`)?.focus({ preventScroll: true }); }, [formId, field]);
}

export function RecordMenu({ label, onInspect, onDuplicate, onDelete, deleteLabel = "Delete…" }: { label: string; onInspect(): void; onDuplicate?: () => void; onDelete(): void; deleteLabel?: string }) {
  const { status } = useStack();
  const connected = status.roles === "open";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`${label} actions`} />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          {onDuplicate ? <DropdownMenuItem disabled={!connected} onClick={onDuplicate}><CopyPlusIcon />Duplicate</DropdownMenuItem> : null}
          <DropdownMenuItem onClick={onInspect}><ScanSearchIcon />Inspect record</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={!connected} onClick={onDelete}><Trash2Icon />{deleteLabel}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
