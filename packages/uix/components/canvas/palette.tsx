"use client";

import { BookOpenIcon, BotIcon, CircleCheckIcon, CpuIcon, MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, RefreshCwIcon, TerminalIcon, Trash2Icon, UserRoundPlusIcon, XIcon } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { operationTitle } from "@/lib/stack/catalog";
import { accountLabels, shortId } from "@/lib/stack/derive";
import type { Account, NodeRef } from "@/lib/stack/types";
import { useAuthActions } from "./auth-actions";
import { Orb, StatusDot } from "./primitives";
import { useStack, useWorkbench } from "./provider";
import { useVoice } from "./voice";

export type PaletteAction = { id: string; label: string; shortcut?: string; icon: React.ComponentType; run(): void };

export function Palette({ open, onOpenChange, actions }: { open: boolean; onOpenChange(open: boolean): void; actions: PaletteAction[] }) {
  const { bots, accounts, owner, catalog, attempt } = useStack();
  const auth = useAuthActions();
  const voice = useVoice();
  const { focus } = useWorkbench();
  const labels = accountLabels(accounts.data);
  const go = (ref: NodeRef) => {
    onOpenChange(false);
    focus(ref);
  };
  const act = (run: () => void) => {
    onOpenChange(false);
    run();
  };
  const removable = (account: Account) => !account.removing;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Find a bot, account, process, or operation." className="sm:max-w-lg">
      <Command loop>
        <CommandInput placeholder="Jump to a bot, account, operation…" />
        <CommandList className="max-h-96">
          <CommandEmpty>No matches.</CommandEmpty>
          {bots.data?.length ? (
            <CommandGroup heading="Bots">
              {bots.data.map((bot) => (
                <CommandItem key={bot.id} value={`bot ${bot.id} ${bot.cwd}`} onSelect={() => go({ kind: "bot", id: bot.id })}>
                  <BotIcon />
                  <span className="font-mono">{bot.id}</span>
                  <StatusDot tone={bot.state === "running" ? "success" : "muted"} />
                  <CommandShortcut className="tracking-normal">{bot.state}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {accounts.data?.length ? (
            <CommandGroup heading="Accounts">
              {accounts.data.map((account) => (
                <CommandItem key={account.id} value={`account ${labels.get(account.id)} ${account.id}`} onSelect={() => go({ kind: "account", id: account.id })}>
                  <Orb id={account.id} size="sm" />
                  <span>{labels.get(account.id)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{shortId(account.id)}</span>
                  {account.active ? <CommandShortcut className="tracking-normal">active</CommandShortcut> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {owner.data ? (
            <CommandGroup heading="Processes">
              <CommandItem value="owner process" onSelect={() => go({ kind: "owner" })}><CpuIcon />Owner<CommandShortcut className="tracking-normal">pid {owner.data.pid}</CommandShortcut></CommandItem>
              {owner.data.children.map((child) => (
                <CommandItem key={child.name} value={`process ${child.name}`} onSelect={() => go({ kind: "child", id: child.name })}>
                  <StatusDot tone={child.running ? "success" : "destructive"} />
                  {child.name}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {catalog.data?.length ? (
            <CommandGroup heading="Operations">
              {catalog.data.flatMap((doc) => doc.operations.map((operation) => (
                <CommandItem key={`${doc.name}.${operation.name}`} value={`operation ${doc.name} ${operation.name} ${operationTitle(operation)}`}
                  onSelect={() => go({ kind: "operation", id: operation.name, pkg: doc.name })}>
                  <TerminalIcon />
                  <span>{operationTitle(operation)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{doc.name}.{operation.name}</span>
                </CommandItem>
              )))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Account actions">
            <CommandItem value="action add codex account sign in" onSelect={() => act(() => auth.startSignIn())}>
              <UserRoundPlusIcon />
              Add Codex account
            </CommandItem>
            {accounts.data?.filter(removable).flatMap((account) => {
              const label = labels.get(account.id) ?? shortId(account.id);
              return [
                ...(!account.active ? [
                  <CommandItem key={`${account.id}-activate`} value={`action make ${label} active ${account.id}`} onSelect={() => act(() => auth.activate(account))}>
                    <CircleCheckIcon />
                    Make {label} active
                  </CommandItem>,
                ] : []),
                <CommandItem key={`${account.id}-replace`} value={`action sign in again ${label} replace ${account.id}`} onSelect={() => act(() => auth.startSignIn(account.id))}>
                  <RefreshCwIcon />
                  Sign in again to {label}
                </CommandItem>,
                <CommandItem key={`${account.id}-remove`} value={`action remove ${label} delete ${account.id}`} onSelect={() => act(() => auth.confirmRemove(account))}>
                  <Trash2Icon />
                  Remove {label}…
                </CommandItem>,
              ];
            })}
            {attempt?.status === "pending" ? (
              <CommandItem value="action cancel sign in" onSelect={() => act(() => auth.cancelLogin(attempt.id))}>
                <XIcon />
                Cancel sign-in
              </CommandItem>
            ) : null}
          </CommandGroup>
          {voice.busy || bots.data?.some((bot) => voice.callable(bot) === null) ? (
            <CommandGroup heading="Voice">
              {!voice.busy ? bots.data?.filter((bot) => voice.callable(bot) === null).map((bot) => (
                <CommandItem key={`${bot.id}-call`} value={`action call ${bot.id} voice`} onSelect={() => act(() => voice.dial(bot.id))}>
                  <PhoneIcon />
                  Call {bot.id}
                </CommandItem>
              )) : null}
              {voice.busy ? (
                <CommandItem value="action hang up voice call end" onSelect={() => act(() => voice.hangup())}>
                  <PhoneOffIcon />
                  Hang up
                </CommandItem>
              ) : null}
              {voice.sessionId !== null && voice.phase === "connected" ? (
                <CommandItem value={`action ${voice.muted ? "unmute" : "mute"} microphone voice call`} onSelect={() => act(() => voice.toggleMute())}>
                  {voice.muted ? <MicIcon /> : <MicOffIcon />}
                  {voice.muted ? "Unmute" : "Mute"}
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}
          {catalog.data?.length ? (
            <CommandGroup heading="Package APIs">
              {catalog.data.map((doc) => (
                <CommandItem key={doc.name} value={`package ${doc.name} ${doc.packageName}`} onSelect={() => go({ kind: "package", id: doc.name })}>
                  <BookOpenIcon />
                  {doc.name}
                  <span className="font-mono text-xs text-muted-foreground">{doc.packageName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="View">
            {actions.map(({ id, label, shortcut, icon: Icon, run }) => (
              <CommandItem key={id} value={`view ${label}`} onSelect={() => { onOpenChange(false); run(); }}>
                <Icon />
                {label}
                {shortcut ? <CommandShortcut>{shortcut}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
