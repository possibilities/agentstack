"use client";

import { useEffect, useState } from "react";
import { BellIcon, BlocksIcon, BookOpenIcon, BotIcon, BoxesIcon, FileTextIcon, NotebookTextIcon, UploadIcon, CircleCheckIcon, CpuIcon, FilePlusIcon, FolderIcon, FolderLockIcon, FolderPlusIcon, MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, PlugIcon, RefreshCwIcon, ScrollTextIcon, TerminalIcon, Trash2Icon, UserRoundPlusIcon, XIcon } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { operationTitle } from "@/lib/stack/catalog";
import { accountLabels, addableWorkerProviders, pairedWorker, providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { spaces } from "@/lib/stack/spaces";
import type { Account, ContentHit, NodeRef, WorkerAccount } from "@/lib/stack/types";
import { useContentActions, type ContentSelection } from "./content-actions";
import { KindIcon } from "./content-shared";
import { useAuthActions } from "./auth-actions";
import { useBotActions } from "./bot-actions";
import { useNotifyActions } from "./notify-actions";
import { useRoleActions, type RoleTarget } from "./role-actions";
import { Orb, StatusDot } from "./primitives";
import { useStack, useStore, useWorkbench } from "./provider";
import { spaceViews } from "./spaces";
import { useVoice } from "./voice";

export type PaletteAction = { id: string; label: string; shortcut?: string; icon: React.ComponentType; run(): void };

export function Palette({ open, onOpenChange, actions }: { open: boolean; onOpenChange(open: boolean): void; actions: PaletteAction[] }) {
  const { bots, accounts, workerAccounts, owner, catalog, attempt, role, notificationRecords, contentDocuments, contentItems, contentArtifacts, status } = useStack();
  const store = useStore();
  const notify = useNotifyActions();
  // Notifications the page has loaded, newest first; the palette never pages the ledger itself.
  const notices = Object.values(notificationRecords).sort((a, b) => b.sequence - a.sequence).slice(0, 25);
  const roleActions = useRoleActions();
  const contentActions = useContentActions();
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContentHit[]>([]);
  const contentOpen = status.content === "open";
  // Documents beyond the loaded newest page come from full-text search as the query is typed.
  useEffect(() => {
    const query = search.trim();
    if (!open || query.length < 2 || !contentOpen) { setHits([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      store.call<{ hits: ContentHit[] }>("content", "search", { query, limit: 8 }).then((result) => { if (live) setHits(result.hits); }, () => { if (live) setHits([]); });
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [search, open, contentOpen, store]);
  useEffect(() => { if (!open) setSearch(""); }, [open]);
  const auth = useAuthActions();
  const botActions = useBotActions();
  const voice = useVoice();
  const { goTo, setSpace } = useWorkbench();
  const labels = accountLabels(accounts.data);
  const workerLabels = workerAccountLabels(workerAccounts.data);
  const go = (ref: NodeRef) => {
    onOpenChange(false);
    goTo(ref);
  };
  const act = (run: () => void) => {
    onOpenChange(false);
    run();
  };
  /** Open a Role record or draft in the editor and bring the Roles space into view. */
  const edit = (target: RoleTarget, ref?: NodeRef) => {
    onOpenChange(false);
    roleActions.open(target);
    if (ref) goTo(ref); else setSpace("roles");
  };
  /** Preview a content record and bring its window into view. */
  const show = (selection: ContentSelection, ref: NodeRef) => {
    onOpenChange(false);
    contentActions.preview(selection);
    goTo(ref);
  };
  const contentAct = (run: () => void) => {
    onOpenChange(false);
    setSpace("content");
    run();
  };
  const searchedSlugs = new Set(hits.map((hit) => hit.slug));
  const removable = (account: Account) => !account.removing;
  const workerRemovable = (account: WorkerAccount) => !account.removing;
  const addWorker = (provider: WorkerAccount["provider"]) => {
    void auth.worker.signIn(provider);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Find a bot, account, Role record, notification, document, process, or operation." className="sm:max-w-lg">
      <Command loop>
        <CommandInput placeholder="Jump to a bot, account, document, operation…" value={search} onValueChange={setSearch} />
        <CommandList className="max-h-96">
          <CommandEmpty>No matches.</CommandEmpty>
          <CommandGroup>
            {spaces.map((item) => {
              const Icon = spaceViews[item.id].icon;
              return (
                <CommandItem key={item.id} value={`space ${item.title} ${item.description}`} onSelect={() => { onOpenChange(false); setSpace(item.id); }}>
                  <Icon />
                  <span>{item.title}</span>
                  <span className="text-xs text-muted-foreground">{item.description}</span>
                  <CommandShortcut>{item.key}</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading="Fleet controls">
            <CommandItem value="create bot start new instance" onSelect={() => act(() => botActions("create"))}><BotIcon />Create Bot</CommandItem>
            <CommandItem value="bot defaults launch model effort sandbox approval" onSelect={() => act(() => botActions("defaults"))}><BotIcon />Bot defaults</CommandItem>
          </CommandGroup>
          <CommandGroup heading="Usage and models">
            <CommandItem value="usage quota billing observations" onSelect={() => go({ kind: "usage" })}><BookOpenIcon />Usage</CommandItem>
            {(workerAccounts.data ?? []).map((account) => <CommandItem key={`catalog:${account.id}`} value={`model catalog ${workerLabels.get(account.id)} ${account.provider} ${account.id}`} onSelect={() => go({ kind: "worker-catalog", id: account.id })}><BookOpenIcon />{workerLabels.get(account.id)} models</CommandItem>)}
          </CommandGroup>
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
          <CommandGroup heading="Roles">
            <CommandItem value="role new instruction category" disabled={!role.data} onSelect={() => edit({ kind: "new-category" })}><FolderPlusIcon />New category</CommandItem>
            {role.data?.categories.length ? (
              <CommandItem value="role new instruction fragment" onSelect={() => edit({ kind: "new-fragment", categoryId: role.data!.categories[0].id, enabled: true })}><FilePlusIcon />New fragment</CommandItem>
            ) : null}
            {role.data?.categories.flatMap((category) => [
              <CommandItem key={category.id} value={`role category ${category.title} ${category.description}`} onSelect={() => edit({ kind: "category", id: category.id }, { kind: "category", id: category.id })}>
                <FolderIcon />
                <span>{category.title}</span>
                <CommandShortcut className="tracking-normal">{category.enabled ? `${category.fragments.length} fragments` : "off"}</CommandShortcut>
              </CommandItem>,
              ...category.fragments.map((fragment) => (
                <CommandItem key={fragment.id} value={`role fragment ${fragment.title} ${category.title} ${fragment.description}`} onSelect={() => edit({ kind: "fragment", id: fragment.id }, { kind: "fragment", id: fragment.id })}>
                  <ScrollTextIcon />
                  <span>{fragment.title}</span>
                  <span className="text-xs text-muted-foreground">{category.title}</span>
                  <CommandShortcut className="tracking-normal">{fragment.enabled && category.enabled ? "" : "off"}</CommandShortcut>
                </CommandItem>
              )),
            ])}
            <CommandItem value="role new skill" disabled={!role.data} onSelect={() => edit({ kind: "new-skill", enabled: true })}><BlocksIcon />New skill</CommandItem>
            <CommandItem value="role new mcp server" disabled={!role.data} onSelect={() => edit({ kind: "new-mcp-server", enabled: true })}><PlugIcon />New MCP server</CommandItem>
            <CommandItem value="role trust project" disabled={!role.data} onSelect={() => edit({ kind: "new-trusted-project", enabled: true })}><FolderLockIcon />Trust a project</CommandItem>
            {role.data?.skills.map((skill) => (
              <CommandItem key={skill.id} value={`role skill ${skill.name} ${skill.description}`} onSelect={() => edit({ kind: "skill", id: skill.id }, { kind: "skill", id: skill.id })}>
                <BlocksIcon />
                <span className="font-mono">{skill.name}</span>
                <span className="text-xs text-muted-foreground">skill</span>
                <CommandShortcut className="tracking-normal">{skill.enabled ? "" : "off"}</CommandShortcut>
              </CommandItem>
            ))}
            {role.data?.mcpServers.map((server) => (
              <CommandItem key={server.id} value={`role mcp server ${server.name} ${server.description}`} onSelect={() => edit({ kind: "mcp-server", id: server.id }, { kind: "mcp-server", id: server.id })}>
                <PlugIcon />
                <span className="font-mono">{server.name}</span>
                <span className="text-xs text-muted-foreground">MCP server</span>
                <CommandShortcut className="tracking-normal">{server.enabled ? "" : "off"}</CommandShortcut>
              </CommandItem>
            ))}
            {role.data?.trustedProjects.map((project) => (
              <CommandItem key={project.id} value={`role trusted project ${project.path} ${project.description}`} onSelect={() => edit({ kind: "trusted-project", id: project.id }, { kind: "trusted-project", id: project.id })}>
                <FolderLockIcon />
                <span className="truncate font-mono">{project.path}</span>
                <CommandShortcut className="tracking-normal">{project.enabled ? "" : "off"}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          {notices.length ? (
            <CommandGroup heading="Inbox">
              {notices.map((record) => (
                <CommandItem key={record.id} value={`notification ${record.title} ${record.subtitle ?? ""} ${record.source ?? ""} ${record.id}`}
                  onSelect={() => { notify.open(record.id); go({ kind: "notification", id: record.id }); }}>
                  <BellIcon />
                  <span className="truncate">{record.title}</span>
                  {record.source ? <span className="truncate font-mono text-xs text-muted-foreground">{record.source}</span> : null}
                  <CommandShortcut className="tracking-normal">{record.dismissedAt ? record.outcome : "open"}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Content">
            <CommandItem value="content new document vault write" disabled={!contentOpen} onSelect={() => contentAct(() => contentActions.edit({ kind: "new-document" }))}><FilePlusIcon />New document</CommandItem>
            <CommandItem value="content new collection group items" disabled={!contentOpen} onSelect={() => contentAct(() => contentActions.editCollection(null))}><FolderPlusIcon />New collection</CommandItem>
            <CommandItem value="content upload files images items" disabled={!contentOpen} onSelect={() => contentAct(() => contentActions.upload(null))}><UploadIcon />Upload files</CommandItem>
            {hits.map((hit) => (
              <CommandItem key={`hit:${hit.slug}`} value={`document ${hit.title} ${hit.slug} ${search}`} onSelect={() => show({ kind: "document", slug: hit.slug }, { kind: "document", id: hit.slug })}>
                <FileTextIcon />
                <span className="truncate">{hit.title}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{hit.slug}</span>
                <CommandShortcut className="tracking-normal">match</CommandShortcut>
              </CommandItem>
            ))}
            {(contentDocuments.data ?? []).filter((document) => !searchedSlugs.has(document.slug)).slice(0, 60).map((document) => (
              <CommandItem key={`document:${document.slug}`} value={`document ${document.title} ${document.slug} ${document.tags.join(" ")}`} onSelect={() => show({ kind: "document", slug: document.slug }, { kind: "document", id: document.slug })}>
                <NotebookTextIcon />
                <span className="truncate">{document.title}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{document.slug}</span>
              </CommandItem>
            ))}
            {(contentItems.data?.items ?? []).slice(0, 60).map((item) => (
              <CommandItem key={`item:${item.id}`} value={`item ${item.name} ${item.kind} ${item.collection ?? "ungrouped"} ${item.id}`} onSelect={() => show({ kind: "item", id: item.id }, { kind: "item", id: item.id })}>
                <KindIcon kind={item.kind} />
                <span className="truncate">{item.name}</span>
                <span className="text-xs text-muted-foreground">{item.collection ?? "ungrouped"}</span>
              </CommandItem>
            ))}
            {(contentArtifacts.data ?? []).map((artifact) => (
              <CommandItem key={`artifact:${artifact.name}`} value={`artifact ${artifact.name} ${artifact.title ?? ""} ${artifact.kind}`} onSelect={() => show({ kind: "artifact", name: artifact.name }, { kind: "artifact", id: artifact.name })}>
                <BoxesIcon />
                <span className="truncate font-mono">{artifact.name}</span>
                <CommandShortcut className="tracking-normal">{artifact.kind}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          {accounts.data?.length || workerAccounts.data?.length ? (
            <CommandGroup heading="Accounts">
              {(accounts.data ?? []).map((account) => (
                <CommandItem key={account.id} value={`bot account ${labels.get(account.id)} ${account.id}`} onSelect={() => go({ kind: "account", id: account.id })}>
                  <Orb id={account.id} size="sm" />
                  <span>{labels.get(account.id)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{shortId(account.id)}</span>
                  <CommandShortcut className="tracking-normal">{account.enabled ? "enabled" : "disabled"}</CommandShortcut>
                </CommandItem>
              ))}
              {(workerAccounts.data ?? []).map((account) => (
                <CommandItem key={`worker-${account.id}`} value={`worker account ${workerLabels.get(account.id)} ${account.provider} ${account.id}`} onSelect={() => go({ kind: "worker-account", id: account.id })}>
                  <Orb id={account.id} size="sm" />
                  <span>{workerLabels.get(account.id)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{providerTitle(account.provider)} · {shortId(account.id)}</span>
                  <CommandShortcut className="tracking-normal">{!account.ready ? "needs sign-in" : account.enabled ? "enabled" : "disabled"}</CommandShortcut>
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
            <CommandItem value="action add codex bot account sign in" onSelect={() => act(() => auth.startSignIn())}>
              <UserRoundPlusIcon />
              Add Codex Bot account
            </CommandItem>
            {addableWorkerProviders.map((provider) => (
              <CommandItem key={`add-${provider}`} value={`action add ${provider} worker account sign in`} onSelect={() => act(() => addWorker(provider))}>
                <TerminalIcon />
                Add {providerTitle(provider)} Worker account
              </CommandItem>
            ))}
            {accounts.data?.filter(removable).flatMap((account) => {
              const label = labels.get(account.id) ?? shortId(account.id);
              return [
                ...(!account.enabled ? [
                  <CommandItem key={`${account.id}-enable`} value={`action enable ${label} ${account.id}`} onSelect={() => act(() => auth.setEnabled(account, true))}>
                    <CircleCheckIcon />
                    Enable {label}
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
            {workerAccounts.data?.filter(workerRemovable).flatMap((account) => {
              const label = workerLabels.get(account.id) ?? shortId(account.id);
              return [
                ...(!account.enabled ? [
                  <CommandItem key={`worker-${account.id}-enable`} value={`action enable ${label} ${account.id}`} onSelect={() => act(() => auth.worker.setEnabled(account, true))}>
                    <CircleCheckIcon />
                    Enable {label}
                  </CommandItem>,
                ] : []),
                <CommandItem key={`worker-${account.id}-signin`} value={`action sign in again ${label} ${account.provider} ${account.id}`} onSelect={() => act(() => { void auth.worker.signIn(account.provider, account.id); })}>
                  <RefreshCwIcon />
                  {account.ready ? "Sign in again to" : "Sign in"} {label}
                </CommandItem>,
                ...(pairedWorker(account) ? [] : [
                  <CommandItem key={`worker-${account.id}-remove`} value={`action remove ${label} delete ${account.id}`} onSelect={() => act(() => auth.worker.confirmRemove(account))}>
                    <Trash2Icon />
                    Remove {label}…
                  </CommandItem>,
                ]),
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
