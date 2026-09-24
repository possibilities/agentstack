"use client";

import { BookOpenIcon, BotIcon, CpuIcon, ServerIcon, TerminalIcon } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { operationTitle } from "@/lib/stack/catalog";
import { accountLabels, shortId } from "@/lib/stack/derive";
import type { NodeRef } from "@/lib/stack/types";
import { Orb, StatusDot } from "./primitives";
import { useStack, useWorkbench } from "./provider";

export type PaletteAction = { id: string; label: string; shortcut?: string; icon: React.ComponentType; run(): void };

export function Palette({ open, onOpenChange, actions }: { open: boolean; onOpenChange(open: boolean): void; actions: PaletteAction[] }) {
  const { servers, bots, accounts, owner, catalog } = useStack();
  const { focus } = useWorkbench();
  const labels = accountLabels(accounts.data);
  const go = (ref: NodeRef) => {
    onOpenChange(false);
    focus(ref);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Find a Server, bot, account, process, or operation." className="sm:max-w-lg">
      <Command loop>
        <CommandInput placeholder="Jump to a Server, account, operation…" />
        <CommandList className="max-h-96">
          <CommandEmpty>No matches.</CommandEmpty>
          {servers.data?.length ? (
            <CommandGroup heading="Servers">
              {servers.data.map((server) => (
                <CommandItem key={server.id} value={`server ${server.id} ${server.cwd}`} onSelect={() => go({ kind: "server", id: server.id })}>
                  <ServerIcon />
                  <span className="font-mono">{server.id}</span>
                  <StatusDot tone={server.state === "running" ? "success" : "muted"} />
                  <CommandShortcut className="tracking-normal">{server.state}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {bots.data?.length ? (
            <CommandGroup heading="Bots">
              {bots.data.map((bot) => (
                <CommandItem key={bot.id} value={`bot ${bot.id}`} onSelect={() => go({ kind: "bot", id: bot.id })}>
                  <BotIcon />
                  <span className="font-mono">{bot.id}</span>
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

