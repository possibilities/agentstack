"use client";

import { EllipsisIcon, InfoIcon, PencilIcon, PlusIcon, ScanSearchIcon, StarIcon, Trash2Icon, TriangleAlertIcon, UsersRoundIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nodeKey, type Role } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Empty } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { useRoleActions, useRoleView } from "./role-actions";
import { footerButton, Window } from "./window";

const chip = "shrink-0 rounded px-1.5 py-px text-[0.64rem] font-medium";

/**
 * Every named Role, in creation order. Clicking one selects it for editing; Make default changes Bot launches only.
 */
export function RoleCatalogWindow() {
  const { roleCatalog, status, endpoints, remote } = useStack();
  const actions = useRoleActions();
  const view = useRoleView();
  const catalog = roleCatalog.data;
  const connected = status.roles === "open" && remote?.scope !== "view";
  // Roles deleted elsewhere whose unsaved edits are still here; the Editor lists them for the selected one.
  const orphaned = [...actions.draftedRoles].filter((id) => !catalog?.roles.some((role) => role.id === id));

  return (
    <Window id="role-catalog" title="Roles" subtitle={view.defaultRole ? `default · ${view.defaultRole.name}` : catalog ? "no default" : undefined} icon={UsersRoundIcon} accent="roles"
      count={catalog?.roles.length ?? null} status={status.roles} endpoint={endpoints.roles} updatedAt={roleCatalog.at} error={roleCatalog.error} empty={!catalog?.roles.length}
      footer={catalog?.roles.length ? (
        <Button size="sm" variant="ghost" className={footerButton} disabled={!connected} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => actions.open({ kind: "new-role" })}>
          <PlusIcon data-icon="inline-start" />New role
        </Button>
      ) : undefined}>
      {catalog?.roles.length ? (
        <>
          <ol aria-label="Roles" className="flex flex-col">
            {catalog.roles.map((role) => (
               <RoleRow key={role.id} role={role} selected={role.id === view.roleId} isDefault={role.id === catalog.defaultRoleId}
                 isWorkerDefault={role.id === catalog.workerDefaultRoleId} connected={connected} />
            ))}
          </ol>
          {orphaned.map((id) => (
            <Alert key={id} className="border-warning/40 bg-warning/5">
              <TriangleAlertIcon className="text-warning" />
              <AlertDescription className="flex flex-col gap-1.5">
                <span>{actions.knownName(id) ? `“${actions.knownName(id)}”` : "A Role"} was deleted in another window. Its unsaved edits are still here.</span>
                {id === view.roleId ? <span>Review them in the Editor.</span> : <Button size="xs" variant="outline" className="self-start" onClick={() => actions.select(id)}>Review edits</Button>}
              </AlertDescription>
            </Alert>
          ))}
          <p className="px-0.5 text-[0.66rem] text-pretty text-muted-foreground">
             New Bots use the Bot default; new Workers use {catalog.roles.find(({ id }) => id === catalog.workerDefaultRoleId)?.name ?? "the Worker default"} unless another Role is selected. Editing a Role changes neither default; running sessions keep their launch snapshot.
          </p>
        </>
      ) : catalog ? (
        <div className="flex flex-col items-center gap-3">
          <Empty icon={UsersRoundIcon} title="No Roles yet" />
          <p className="px-2 text-center text-[0.72rem] text-pretty text-muted-foreground">
             Roles are provisioned when Stack starts. If none appear, inspect the Roles service.
          </p>
          <Button size="sm" disabled={!connected} title={remote?.scope === "view" ? "Requires ui:control" : undefined} onClick={() => actions.open({ kind: "new-role" })}>
            <PlusIcon data-icon="inline-start" />Create role
          </Button>
        </div>
      ) : (
        <Empty icon={UsersRoundIcon} title={roleCatalog.error ? "Roles unavailable" : "Reading Roles…"} />
      )}
    </Window>
  );
}

function RoleRow({ role, selected, isDefault, isWorkerDefault, connected }: { role: Role; selected: boolean; isDefault: boolean; isWorkerDefault: boolean; connected: boolean }) {
  const actions = useRoleActions();
  const { select, flash } = useWorkbench();
  const node = { kind: "role", id: role.id } as const;
  const key = nodeKey(node);
  // Unsaved edits are counted from the page's drafts; the Role's own content is only loaded while it is selected.
  const dirty = actions.draftedRoles.has(role.id);
  return (
    <li data-node={key}
      className={cn("group/row relative flex items-start gap-1 rounded-lg py-1.5 pr-1 pl-2.5 transition-colors hover:bg-muted/70", selected && "bg-pkg-roles/10 hover:bg-pkg-roles/15")}>
      {selected ? <span aria-hidden className="pointer-events-none absolute inset-y-1.5 left-0.5 w-0.5 rounded-full bg-pkg-roles" /> : null}
      {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-0.5 rounded-[inherit] animate-ui-flash" /> : null}
      <button type="button" aria-current={selected ? "true" : undefined} onClick={() => actions.select(role.id)}
        className="flex min-w-0 flex-1 flex-col gap-px rounded-sm text-left leading-snug focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[0.82rem] font-semibold tracking-tight">{role.name}</span>
           {isDefault ? <span className={cn(chip, "bg-success/15 text-success")} title="Later Bot launches use this Role">Default</span> : null}
           {isWorkerDefault ? <span className={cn(chip, "bg-muted text-muted-foreground")} title="New Workers use this Role unless another is selected">Worker default</span> : null}
          {selected ? <span className={cn(chip, "bg-pkg-roles/15 text-pkg-roles")} title="The Roles windows show and edit this Role">Editing</span> : null}
          {dirty ? <span role="img" aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-pkg-roles" /> : null}
        </span>
        {role.description ? <span className="line-clamp-2 text-[0.7rem] text-pretty text-muted-foreground">{role.description}</span> : null}
      </button>
      <span className="mt-0.5 shrink-0 text-[0.65rem] text-muted-foreground tabular-nums" title={`Role revision ${role.revision}`}>r{role.revision}</span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${role.name} actions`} />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!connected} onClick={() => actions.openIn(role.id, { kind: "role", id: role.id })}><PencilIcon />Edit details</DropdownMenuItem>
            <DropdownMenuItem disabled={!connected || isDefault} onClick={() => actions.confirmDefault(role.id)}><StarIcon />{isDefault ? "Default Role" : "Make default…"}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => select(node)}><ScanSearchIcon />Inspect record</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
           <DropdownMenuItem variant="destructive" disabled={!connected || isDefault || isWorkerDefault} onClick={() => actions.confirmDeleteRole(role.id)}>
            <Trash2Icon />
            <span className="flex flex-col">
              <span>Delete…</span>
               {isDefault || isWorkerDefault ? <span className="text-[0.66rem] font-normal text-muted-foreground">Reassign the {isDefault && isWorkerDefault ? "Bot and Worker" : isDefault ? "Bot" : "Worker"} default first</span> : null}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * Explains which audience receives the selected Role; Make default affects only Bots.
 * Nothing is shown for the default, for an empty catalog, or before the catalog has loaded.
 */
export function DefaultNote() {
  const { status, remote, roleCatalog } = useStack();
  const actions = useRoleActions();
  const view = useRoleView();
  if (view.state !== "ready" || view.isDefault || !view.role || !view.defaultRole) return null;
  const workerDefault = roleCatalog.data?.workerDefaultRoleId === view.role.id;
  const connected = status.roles === "open" && remote?.scope !== "view";
  return (
    <Alert className="border-pkg-roles/30 bg-pkg-roles/5">
      <InfoIcon className="text-pkg-roles" />
      <AlertDescription className="flex flex-col gap-1.5">
         <span>{workerDefault ? `New Workers use “${view.role.name}” unless another Role is selected. ` : ""}New Bots use “{view.defaultRole.name}”. Editing this Role {workerDefault ? "affects later Worker launches" : "affects only explicit selections"} until it becomes the Bot default.</span>
        <Button size="xs" variant="outline" className="self-start" disabled={!connected} onClick={() => actions.confirmDefault(view.role!.id)}>
          <StarIcon data-icon="inline-start" />Make default
        </Button>
      </AlertDescription>
    </Alert>
  );
}
