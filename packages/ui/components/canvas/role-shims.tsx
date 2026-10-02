"use client";

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, EllipsisIcon, InfoIcon, PencilIcon, PlusIcon, SaveIcon, ScanSearchIcon, SquareTerminalIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import {
  joinShimArgs,
  newShimDraft,
  readStackArgs,
  shimCommand,
  shimDraftFrom,
  shimEditState,
  shimErrorText,
  shimHarnesses,
  shimNameIssue,
  shimRoleNote,
  splitShimArgs,
  type ShimDraft,
} from "@/lib/stack/shims";
import { nodeKey, type RoleShim } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "./auth-actions";
import { CopyButton, Empty } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { hintClass, labelClass, saveKeys } from "./role-editor-parts";
import { footerButton, Section, Window } from "./window";
import { RoleLaunchDirectories } from "./role-launch-maintenance";

type ShimActions = {
  draft: ShimDraft | null;
  pending: boolean;
  create(): void;
  edit(shim: RoleShim): void;
  /** Edit an installed shim by name, as the inspector does; nothing happens once it is gone. */
  editNamed(name: string): void;
  change(next: Partial<Pick<ShimDraft, "name" | "vector">>): void;
  /** Rebase the edit onto the listed shim, keeping or replacing the edited vector. */
  rebase(shim: RoleShim, keep: boolean): void;
  close(): void;
  save(): void;
  confirmRemove(shim: RoleShim): void;
};

const ShimActionsContext = createContext<ShimActions | null>(null);

export function useShimActions(): ShimActions {
  const value = use(ShimActionsContext);
  if (!value) throw new Error("useShimActions requires ShimActionsProvider");
  return value;
}

/**
 * Holds the Shims window's editor so it survives switching spaces, and the removal confirmation. Every write carries
 * the listed revision: a refusal wrote nothing, is shown as it is, and never retries over someone else's change.
 */
export function ShimActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { roleShims } = useStack();
  const [draft, setDraft] = useState<ShimDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<RoleShim | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const shims = roleShims.data?.shims;

  const edit = useCallback((shim: RoleShim) => setDraft(shimDraftFrom(shim, Date.now())), []);
  const editNamed = useCallback((name: string) => {
    const shim = store.getState().roleShims.data?.shims.find((item) => item.name === name);
    if (shim) edit(shim);
  }, [edit, store]);

  const save = useCallback(() => {
    const current = draftRef.current;
    if (!current || pending) return;
    const args = joinShimArgs(current.vector);
    const request = current.mode === "new"
      ? store.call<RoleShim>("roles", "role_shim_create", { name: current.name, args })
      : store.call<RoleShim>("roles", "role_shim_update", { name: current.name, expectedRevision: current.base!.revision, args });
    setPending(true);
    // The reply belongs to the edit that sent it; one the operator has since left for another shim keeps its own state.
    const same = (held: ShimDraft | null): held is ShimDraft => held !== null && held.mode === current.mode && held.name === current.name;
    request.then((shim) => {
      setDraft((held) => same(held) ? shimDraftFrom(shim, Date.now(), current.base?.revision ?? null) : held);
      toast.success(current.mode === "new" ? `Installed ${shim.path}` : `Updated ${shim.name}`);
    }, (error) => {
      const text = shimErrorText(errorMessage(error)).text;
      setDraft((held) => same(held) ? { ...held, error: text } : held);
      if (!same(draftRef.current)) toast.error(text);
    }).finally(() => setPending(false));
  }, [pending, store]);

  const remove = () => {
    if (!removing) return;
    const doomed = removing;
    setPending(true);
    store.call("roles", "role_shim_delete", { name: doomed.name, expectedRevision: doomed.revision }).then(() => {
      setRemoving(null);
      setDraft((held) => held?.mode === "edit" && held.name === doomed.name ? null : held);
      toast.success(`Removed ${doomed.path}`);
    }, (error) => setRemoveError(shimErrorText(errorMessage(error)).text)).finally(() => setPending(false));
  };

  const value = useMemo<ShimActions>(() => ({
    draft, pending, edit, editNamed, save,
    create: () => setDraft(newShimDraft(Date.now())),
    change: (next) => setDraft((held) => held && { ...held, ...next, error: null }),
    rebase: (shim, keep) => setDraft((held) => held && { ...held, base: shim, since: Date.now(), replaced: null, vector: keep ? held.vector : splitShimArgs(shim.args), error: null }),
    close: () => setDraft(null),
    confirmRemove: (shim) => { setRemoveError(null); setRemoving(shim); },
  }), [draft, pending, edit, editNamed, save]);

  // Confirm against the listing: a shim that changed or vanished since the menu opened is no longer what was chosen.
  const listed = removing ? shims?.find((shim) => shim.name === removing.name) ?? null : null;
  const changed = removing !== null && listed?.revision !== removing.revision;

  return (
    <ShimActionsContext value={value}>
      {children}
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2Icon /></AlertDialogMedia>
            <AlertDialogTitle>Remove “{removing?.name}”?</AlertDialogTitle>
            <AlertDialogDescription className="flex flex-col gap-2">
              <span>This deletes <code className="font-mono break-all">{removing?.path}</code>. The command stops working for new launches.</span>
              <span>Sessions already started with it keep running. No Role, setting or other command is touched, and a file changed outside Stack is never removed.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {changed ? <p role="alert" className="text-[0.72rem] text-warning">{listed ? "This command changed since you chose it. Close and review it first." : "This command is no longer listed as a Stack-owned shim."}</p> : null}
          {removeError ? <p role="alert" className="text-[0.72rem] text-destructive">{removeError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={pending || changed} onClick={remove}>
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}Remove command
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ShimActionsContext>
  );
}

/**
 * Role shims: commands on the operator's PATH that start a native harness under a Role through `stack roles inject`.
 * Local operator control only; a remote session neither reads nor writes them.
 */
export function RoleShimsWindow() {
  const { roleShims, status, endpoints, remote } = useStack();
  const actions = useShimActions();
  const data = roleShims.data;
  const connected = status.roles === "open";

  if (remote) {
    return (
      <Window id="role-shims" title="Shims" icon={SquareTerminalIcon} accent="roles" empty>
        <div className="flex flex-col items-center gap-1.5 p-6 text-center">
          <SquareTerminalIcon className="size-5 text-muted-foreground/70" />
          <p className="text-sm font-medium">Available only on the local UI</p>
          <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">Role shims are commands installed on the Stack machine. Remote sessions cannot list or change them.</p>
        </div>
      </Window>
    );
  }

  return (
    <Window id="role-shims" title="Shims" subtitle={data ? data.binDir : undefined} icon={SquareTerminalIcon} accent="roles"
      count={data?.shims.length ?? null} status={status.roles} endpoint={endpoints.roles} updatedAt={roleShims.at} error={roleShims.error} empty={!data}
      footer={data && actions.draft?.mode !== "new" ? (
        <Button size="sm" variant="ghost" className={footerButton} disabled={!connected} onClick={actions.create}>
          <PlusIcon data-icon="inline-start" />New shim
        </Button>
      ) : undefined}>
      {data ? (
        <>
          <p className={hintClass}>
            Each shim is a command in <code className="font-mono break-all text-foreground">{data.binDir}</code> that runs <code className="font-mono">stack roles inject</code> with exact arguments, then appends whatever you type after it unchanged. That directory must be on your PATH to run a shim by name; Stack does not edit shell profiles.
          </p>
          {data.shims.length ? (
            <ol aria-label="Role shims" className="flex flex-col">
              {data.shims.map((shim) => <ShimRow key={shim.name} shim={shim} connected={connected} />)}
            </ol>
          ) : actions.draft?.mode === "new" ? null : (
            <div className="flex flex-col items-center gap-3">
              <Empty icon={SquareTerminalIcon} title="No Role shims" />
              <Button size="sm" disabled={!connected} onClick={actions.create}><PlusIcon data-icon="inline-start" />Create shim</Button>
            </div>
          )}
          {actions.draft ? <ShimEditor draft={actions.draft} /> : null}
          <RoleLaunchDirectories />
        </>
      ) : (
        <Empty icon={SquareTerminalIcon} title={roleShims.error ? "Shims unavailable" : status.roles === "closed" ? "Roles reconnecting" : "Reading shims…"} />
      )}
    </Window>
  );
}

function ShimRow({ shim, connected }: { shim: RoleShim; connected: boolean }) {
  const actions = useShimActions();
  const { select, flash } = useWorkbench();
  const node = { kind: "role-shim", id: shim.name } as const;
  const key = nodeKey(node);
  const editing = actions.draft?.mode === "edit" && actions.draft.name === shim.name;
  const vector = splitShimArgs(shim.args);
  return (
    <li data-node={key} className={cn("group/row relative flex items-start gap-1 rounded-lg py-1.5 pr-1 pl-2.5 transition-colors hover:bg-muted/70", editing && "bg-pkg-roles/10 hover:bg-pkg-roles/15")}>
      {editing ? <span aria-hidden className="pointer-events-none absolute inset-y-1.5 left-0.5 w-0.5 rounded-full bg-pkg-roles" /> : null}
      {flash?.key === key ? <span key={flash.seq} aria-hidden className="pointer-events-none absolute -inset-0.5 rounded-[inherit] animate-ui-flash" /> : null}
      <button type="button" aria-current={editing ? "true" : undefined} onClick={() => actions.edit(shim)}
        className="flex min-w-0 flex-1 flex-col gap-px rounded-sm text-left leading-snug focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[0.8rem] font-semibold">{shim.name}</span>
          <span className="shrink-0 rounded bg-pkg-roles/15 px-1.5 py-px text-[0.64rem] font-medium text-pkg-roles">{vector.harness}</span>
        </span>
        <span className="line-clamp-2 font-mono text-[0.68rem] break-all text-muted-foreground" title={shimCommand(shim.args)}>{shimCommand(shim.args)}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={`${shim.name} actions`} />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => actions.edit(shim)}><PencilIcon />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => select(node)}><ScanSearchIcon />Inspect record</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={!connected} onClick={() => actions.confirmRemove(shim)}><Trash2Icon />Remove…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function ShimEditor({ draft }: { draft: ShimDraft }) {
  const { roleShims, roleCatalog, status } = useStack();
  const actions = useShimActions();
  const data = roleShims.data!;
  const { listed, gone, changed, dirty, invalid } = shimEditState(draft, data, roleShims.at);
  const conflict = changed !== null;
  const args = joinShimArgs(draft.vector);
  const connected = status.roles === "open";
  const reading = readStackArgs(draft.vector.stack);
  const role = shimRoleNote(reading.role, roleCatalog.data);
  const path = `${data.binDir.replace(/\/$/, "")}/${draft.name || "…"}`;
  const command = shimCommand(args);
  const spaced = args.some((arg) => arg !== arg.trim());
  const empty = draft.vector.harness !== "" && args.some((arg) => arg === "");
  const message = !connected ? "Roles reconnecting" : gone ? "This command is no longer installed" : conflict ? "Resolve the change to save"
    : invalid && (dirty || draft.mode === "new") ? invalid : dirty ? "Unsaved changes · ⌘S to save" : "Installed as shown";

  return (
    <Section title={draft.mode === "new" ? "New shim" : `Edit ${draft.name}`} className="rounded-xl border bg-card/60 p-2.5"
      aside={<Button size="icon-xs" variant="ghost" aria-label="Close shim editor" onClick={actions.close}><XIcon /></Button>}>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); actions.save(); }} onKeyDown={saveKeys(actions.save)}>
        {gone ? (
          <Alert className="border-warning/40 bg-warning/5">
            <TriangleAlertIcon className="text-warning" />
            <AlertTitle>No longer installed</AlertTitle>
            <AlertDescription>
              <code className="font-mono break-all">{draft.base!.path}</code> was removed or edited outside Stack, so it is not a Stack-owned shim anymore. Nothing will overwrite it. Your arguments stay here to copy.
            </AlertDescription>
          </Alert>
        ) : changed ? (
          <Alert className="border-warning/40 bg-warning/5">
            <TriangleAlertIcon className="text-warning" />
            <AlertTitle>Changed elsewhere</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>The installed command now runs <code className="font-mono break-all">{shimCommand(changed.args)}</code>. “Keep mine” saves your arguments over it; “Use installed” drops your edit.</span>
              <span className="flex flex-wrap gap-1.5">
                <Button type="button" size="xs" variant="outline" onClick={() => actions.rebase(changed, false)}>Use installed</Button>
                <Button type="button" size="xs" variant="outline" onClick={() => actions.rebase(changed, true)}>Keep mine</Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="role-shim-name" className={labelClass}>Command name</label>
          {draft.mode === "new" ? (
            <Input id="role-shim-name" className="font-mono" value={draft.name} autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="opencode-astra"
              aria-invalid={Boolean(draft.name) && shimNameIssue(draft.name, data.shims) !== null} onChange={(event) => actions.change({ name: event.target.value })} />
          ) : (
            <p id="role-shim-name" className="px-0.5 font-mono text-[0.8rem] font-semibold">{draft.name}</p>
          )}
          <p className={hintClass}>
            {draft.mode === "new" ? <>Installs <code className="font-mono break-all">{path}</code>. An existing file there is never replaced.</> : "A shim keeps its name. To rename it, create a new shim and remove this one."}
          </p>
        </div>

        <TokenList id="role-shim-stack" label="Stack arguments" hint="The Role, then optional --with-model and --with-harness rendering context." tokens={draft.vector.stack}
          onChange={(stack) => actions.change({ vector: { ...draft.vector, stack } })} addLabel="Add Stack argument" />
        <div className="flex flex-col gap-1 px-0.5 text-[0.68rem]">
          <p className={cn("flex items-start gap-1.5 text-pretty", role.tone === "warning" ? "text-warning" : "text-muted-foreground")}>
            <InfoIcon aria-hidden className="mt-0.5 size-3 shrink-0" /><span>Role: {role.text} Roles are resolved each time the command runs, not when it is saved.</span>
          </p>
          {reading.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-1.5 text-pretty text-warning"><TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" /><span>{warning}. roles inject refuses this when the command runs.</span></p>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="role-shim-harness" className={labelClass}>Native harness</label>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.75rem]" title="The single boundary between Stack and native arguments">--</code>
            <NativeSelect id="role-shim-harness" value={draft.vector.harness} onChange={(event) => actions.change({ vector: { ...draft.vector, harness: event.target.value } })}>
              {draft.vector.harness === "" ? <NativeSelectOption value="" disabled>Choose a harness</NativeSelectOption> : null}
              {shimHarnesses.map((harness) => <NativeSelectOption key={harness} value={harness}>{harness}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        </div>

        <TokenList id="role-shim-native" label="Native arguments" hint="Passed to the harness in this order. Its installed version decides which options it accepts; roles inject refuses only options that would escape the Role." tokens={draft.vector.native}
          onChange={(native) => actions.change({ vector: { ...draft.vector, native } })} addLabel="Add native argument" allowBoundary />

        <div className="flex flex-col gap-1">
          <span className="flex items-center justify-between gap-2">
            <span className={labelClass}>Runs</span>
            {draft.vector.harness ? <CopyButton value={command} label="command" className="opacity-100" /> : null}
          </span>
          {draft.vector.harness ? (
            <pre aria-label="Shim command preview" className="overflow-x-auto rounded-lg border bg-muted/40 px-2.5 py-2 font-mono text-[0.72rem] leading-relaxed break-all whitespace-pre-wrap">{command}</pre>
          ) : <p className="rounded-lg border border-dashed px-2.5 py-2 text-[0.72rem] text-muted-foreground">Choose a harness to preview the command.</p>}
          <p className={hintClass}>
            Each argument is one word, quoted where the shell needs it. “$@” is what you type after <code className="font-mono">{draft.name || "the command"}</code>, passed through unchanged.
            {spaced ? " Some arguments start or end with spaces; they are kept exactly." : ""}
            {empty ? " An empty argument is passed as ''." : ""}
          </p>
        </div>

        {draft.error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertDescription>{draft.error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center gap-1.5">
          <span role="status" className={cn("min-w-0 flex-1 truncate text-[0.68rem]", dirty && !conflict && !invalid ? "text-foreground" : "text-muted-foreground")}>{message}</span>
          {draft.mode === "edit" && dirty && !gone ? <Button type="button" size="sm" variant="ghost" disabled={actions.pending} onClick={() => actions.rebase(listed ?? draft.base!, false)}>Revert</Button> : null}
          <Button type="submit" size="sm" disabled={!connected || !dirty && draft.mode === "edit" || Boolean(invalid) || conflict || gone || actions.pending}>
            {actions.pending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}{draft.mode === "new" ? "Install" : "Save"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

/**
 * An ordered list of exact arguments. Each input holds one argument verbatim: nothing is split, trimmed or unquoted.
 * Enter adds an argument after the current one.
 */
function TokenList({ id, label, hint, tokens, onChange, addLabel, allowBoundary = false }: {
  id: string; label: string; hint: string; tokens: string[]; onChange(next: string[]): void; addLabel: string; allowBoundary?: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const focus = (index: number) => requestAnimationFrame(() => list.current?.querySelectorAll("input")[index]?.focus());
  const set = (index: number, value: string) => onChange(tokens.map((token, at) => at === index ? value : token));
  const insert = (index: number) => { onChange([...tokens.slice(0, index), "", ...tokens.slice(index)]); focus(index); };
  const remove = (index: number) => onChange(tokens.filter((_, at) => at !== index));
  const move = (index: number, to: number) => {
    const next = [...tokens];
    const [token] = next.splice(index, 1);
    next.splice(to, 0, token!);
    onChange(next);
    focus(to);
  };
  return (
    <div className="flex flex-col gap-1">
      <span id={`${id}-label`} className={labelClass}>{label}</span>
      {tokens.length ? (
        <ol ref={list} aria-labelledby={`${id}-label`} className="flex flex-col gap-1">
          {tokens.map((token, index) => (
            <li key={index} className="flex items-center gap-1">
              <span aria-hidden className="w-5 shrink-0 text-right text-[0.64rem] text-muted-foreground tabular-nums">{index + 1}</span>
              <Input className={cn("h-7 font-mono text-[0.75rem]", !allowBoundary && token === "--" && "border-destructive")} value={token}
                aria-label={`${label} ${index + 1}`} autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
                aria-invalid={!allowBoundary && token === "--"}
                onChange={(event) => set(index, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) { event.preventDefault(); insert(index + 1); }
                }} />
              <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Move ${label.toLowerCase()} ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}><ArrowUpIcon /></Button>
              <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Move ${label.toLowerCase()} ${index + 1} down`} disabled={index === tokens.length - 1} onClick={() => move(index, index + 1)}><ArrowDownIcon /></Button>
              <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => remove(index)}><XIcon /></Button>
            </li>
          ))}
        </ol>
      ) : <p className="px-0.5 text-[0.7rem] text-muted-foreground italic">None</p>}
      <Button type="button" size="xs" variant="outline" className="self-start" onClick={() => insert(tokens.length)}><PlusIcon data-icon="inline-start" />{addLabel}</Button>
      <p className={hintClass}>{hint}</p>
    </div>
  );
}

/** The inspector hands an installed shim to the Shims window's editor. */
export function ShimRecordControls({ name }: { name: string }) {
  const actions = useShimActions();
  const { goTo } = useWorkbench();
  return (
    <Button size="sm" variant="outline" className="w-fit" onClick={() => { actions.editNamed(name); goTo({ kind: "role-shim", id: name }); }}>
      <PencilIcon data-icon="inline-start" />Edit in Shims
    </Button>
  );
}
