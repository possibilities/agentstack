"use client";

import { useMemo, useState } from "react";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  BotIcon,
  BracesIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CpuIcon,
  EllipsisVerticalIcon,
  KeyRoundIcon,
  RadioIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldAlertIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserRoundPlusIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { annotationBadges, fieldsOf, findOperation, operationTitle, recordFields } from "@/lib/stack/catalog";
import { accountLabels, clockTime, histogram, pathParts, serversFor, shortId } from "@/lib/stack/derive";
import type { Account, Login, OperationDoc, PackageDoc, Server, StackEvent } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { errorMessage, useAuthActions } from "./auth-actions";
import { CopyButton, Empty, NodeCard, Orb, Row, Sparkline, StatusDot, Time } from "./primitives";
import { useActivity, useNow, useOperation, useStack, useWorkbench } from "./provider";
import { accentBg, accentOf, accentText, Section, Window } from "./window";

const activitySpan = 5 * 60_000;

export function Path({ path }: { path: string }) {
  const { head, tail } = pathParts(path);
  const parent = head.split("/").filter(Boolean).at(-1);
  return (
    <span className="font-mono text-[0.75rem]" title={path}>
      <span className="text-muted-foreground">{parent ? `…/${parent}/` : head}</span>
      {tail}
    </span>
  );
}

export function AccountChip({ id, labels }: { id: string | null; labels: Map<string, string> }) {
  if (!id) return <span className="text-muted-foreground">Unbound</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Orb id={id} size="sm" />
      <span>{labels.get(id) ?? shortId(id)}</span>
    </span>
  );
}

export function OperationBadges({ operation }: { operation: OperationDoc }) {
  return annotationBadges(operation).map(({ key, label }) => (
    <Badge key={key} variant={key === "destructiveHint" ? "destructive" : "secondary"} className="h-4 px-1.5 text-[0.62rem]">{label}</Badge>
  ));
}

/* ─── System ─────────────────────────────────────────────────────────── */

export function SystemWindow() {
  const { owner, catalog, status, endpoints } = useStack();
  const data = owner.data;
  const childFields = useMemo(() => {
    const children = fieldsOf(findOperation(catalog.data, "owner", "owner_status")?.outputSchema).find((field) => field.name === "children");
    return new Map(children?.children.map((field) => [field.name, field]) ?? []);
  }, [catalog.data]);
  const running = data?.children.filter((child) => child.running).length ?? 0;
  const links = data ? [
    { name: "Runtime index", url: data.indexUrl, icon: CpuIcon },
    { name: "API reference", url: data.docsUrl, icon: BookOpenIcon },
    { name: "MCP Inspector", url: data.inspectorUrl, icon: BracesIcon },
  ].filter((link): link is typeof link & { url: string } => link.url !== null) : [];

  return (
    <Window id="system" title="System" subtitle="owner · process supervisor" icon={CpuIcon} accent="owner"
      status={status.owner} endpoint={endpoints.owner} updatedAt={owner.at} error={owner.error}>
      {data ? (
        <>
          <NodeCard node={{ kind: "owner" }} label="owner process">
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-[0.68rem] tracking-[0.08em] text-muted-foreground uppercase">Owner</span>
                <span className="font-mono text-lg font-medium tabular-nums">pid {data.pid}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-2xl font-semibold tracking-tight tabular-nums">{running}<span className="text-muted-foreground">/{data.children.length}</span></span>
                <span className="text-[0.7rem] text-muted-foreground">children running</span>
              </div>
            </div>
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
              {data.children.map((child) => (
                <span key={child.name} className={cn("flex-1", child.running ? "bg-success/80" : "bg-destructive")} />
              ))}
            </div>
          </NodeCard>

          <Section title="Processes">
            <div className="-mx-1 flex flex-col">
              {data.children.map((child) => {
                const failed = !child.running && (child.error || child.exitCode !== null || child.signal);
                return (
                  <NodeCard key={child.name} node={{ kind: "child", id: child.name }} label={`${child.name} process`} variant="row">
                    <div className="flex items-center gap-2.5 text-[0.8rem]">
                      <StatusDot tone={child.running ? "success" : failed ? "destructive" : "muted"} label={child.running ? "Running" : "Stopped"} />
                      <span className="font-medium">{child.name}</span>
                      {child.error ? <span className="truncate text-xs text-destructive" title={childFields.get("error")?.description ?? undefined}>{child.error}</span> : null}
                      {child.signal ? <Badge variant="destructive" className="h-4 text-[0.62rem]">{child.signal}</Badge> : null}
                      {child.exitCode !== null ? <Badge variant="outline" className="h-4 text-[0.62rem]">exit {child.exitCode}</Badge> : null}
                      <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{child.pid ?? "—"}</span>
                    </div>
                  </NodeCard>
                );
              })}
            </div>
          </Section>

          {links.length ? (
            <Section title="Surfaces">
              <div className="grid grid-cols-1 gap-1.5">
                {links.map(({ name, url, icon: Icon }) => (
                  <a key={name} href={url} target="_blank" rel="noreferrer"
                    className="group/link flex items-center gap-2.5 rounded-lg border bg-background/50 px-2.5 py-2 text-[0.8rem] transition-colors hover:border-foreground/15 hover:bg-background focus-visible:outline-2 focus-visible:outline-ring">
                    <Icon className="size-3.5 text-muted-foreground" />
                    <span className="font-medium">{name}</span>
                    <span className="ml-auto truncate font-mono text-[0.7rem] text-muted-foreground">{new URL(url).host}</span>
                    <ArrowUpRightIcon className="size-3.5 text-muted-foreground transition-transform group-hover/link:translate-x-px group-hover/link:-translate-y-px" />
                  </a>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title="MCP endpoints">
            <dl className="flex flex-col">
              {Object.entries(data.mcpUrls).sort(([a], [b]) => a.localeCompare(b)).map(([name, url]) => (
                <Row key={name} label={name} copy={url} mono>{url.replace(/^http:\/\//, "")}</Row>
              ))}
            </dl>
          </Section>
        </>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Owner status unavailable">{owner.error ?? "Waiting for the owner socket."}</Empty>
      )}
    </Window>
  );
}

/* ─── Accounts ───────────────────────────────────────────────────────── */

export function AccountsWindow() {
  const { accounts, login, servers, catalog, status, endpoints, attempt } = useStack();
  const actions = useAuthActions();
  const labels = accountLabels(accounts.data);
  const addButton = (
    <Button size="xs" variant="outline" onClick={() => actions.startSignIn()} disabled={actions.pendingSignIn}>
      {actions.pendingSignIn ? <Spinner data-icon="inline-start" /> : <UserRoundPlusIcon data-icon="inline-start" />}
      Add account
    </Button>
  );

  return (
    <Window id="accounts" title="Accounts" subtitle="auth · codex sign-ins" icon={KeyRoundIcon} accent="auth"
      count={accounts.data?.length} status={status.auth} endpoint={endpoints.auth} updatedAt={accounts.at} error={accounts.error ?? login.error}
      actions={addButton}>
      {attempt ? <SignInCard key={attempt.id} attempt={attempt} labels={labels} accounts={accounts.data} catalog={catalog.data} /> : null}

      {accounts.data?.length ? (
        <div className="flex flex-col gap-2">
          {accounts.data.map((account) => <AccountCard key={account.id} account={account} label={labels.get(account.id)!} servers={servers.data} />)}
        </div>
      ) : accounts.data ? (
        <div className="flex flex-col gap-2.5">
          <Empty icon={KeyRoundIcon} title="No Codex accounts">Device sign-in creates the first one; it becomes active.</Empty>
          <div className="flex justify-center">{addButton}</div>
        </div>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Accounts unavailable">{accounts.error ?? "Waiting for the auth socket."}</Empty>
      )}
      {accounts.data?.length ? <p className="px-0.5 text-[0.7rem] text-pretty text-muted-foreground">The active account binds to newly created Servers. Labels are numbered from the current list; IDs never change.</p> : null}
    </Window>
  );
}

function elapsedClock(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function SignInCard({ attempt, labels, accounts, catalog }: { attempt: Login; labels: Map<string, string>; accounts: Account[] | null; catalog: PackageDoc[] | null }) {
  const actions = useAuthActions();
  const [seenAt] = useState(() => Date.now());
  const now = useNow();
  const loginFields = fieldsOf(findOperation(catalog, "auth", "account_login_status")?.outputSchema);
  const target = attempt.targetAccount;
  const result = attempt.account ? accounts?.find((account) => account.id === attempt.account) : undefined;
  const resultLabel = attempt.account ? labels.get(attempt.account) ?? shortId(attempt.account) : null;
  const phase = attempt.status === "pending" ? (attempt.userCode ? "code" : "starting") : attempt.status;

  const copyAndOpen = async () => {
    if (attempt.userCode) {
      await navigator.clipboard.writeText(attempt.userCode).then(() => toast.success("Code copied")).catch(() => undefined);
    }
    if (attempt.authUrl) window.open(attempt.authUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <NodeCard node={{ kind: "login" }} label="device sign-in"
      className={cn(attempt.status === "failed" ? "border-destructive/40 bg-destructive/5" : attempt.status === "complete" ? "border-success/40 bg-success/5" : "border-pkg-auth/40 bg-pkg-auth/5")}>
      <div className="flex items-center gap-2">
        <UserRoundPlusIcon className="size-4 text-pkg-auth" />
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          {target ? (
            <>Signing in again · <Orb id={target} size="sm" /> {labels.get(target) ?? shortId(target)}</>
          ) : "New Codex account"}
        </span>
        <Badge variant={attempt.status === "failed" ? "destructive" : "secondary"} className="ml-auto capitalize">{attempt.status}</Badge>
      </div>
      <div key={phase} className="flex flex-col gap-2.5 motion-safe:animate-in motion-safe:fade-in-0">
        {phase === "starting" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5 text-pkg-auth" />
            Starting Codex sign-in…
            <Button size="xs" variant="ghost" className="ml-auto" disabled={actions.cancelPending} onClick={() => actions.cancelLogin(attempt.id)}>Cancel</Button>
          </div>
        ) : null}
        {phase === "code" ? (
          <>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-background/70 px-3 py-2.5">
              <span className="font-mono text-2xl font-semibold tracking-[0.22em]" title={loginFields.find((field) => field.name === "userCode")?.description ?? undefined}>{attempt.userCode}</span>
              <CopyButton value={attempt.userCode ?? ""} label="one-time code" className="opacity-100" />
            </div>
            <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
              <Spinner className="size-3 text-pkg-auth" />
              Waiting for approval · {elapsedClock(seenAt, now)}
            </p>
            <div className="flex items-center gap-1.5">
              <Button size="sm" className="flex-1" disabled={!attempt.authUrl} onClick={() => void copyAndOpen()}>
                <SquareArrowOutUpRightIcon data-icon="inline-start" />
                Copy code & open page
              </Button>
              <Button size="sm" variant="ghost" disabled={actions.cancelPending} onClick={() => actions.cancelLogin(attempt.id)}>
                {actions.cancelPending ? <Spinner data-icon="inline-start" /> : null}
                Cancel
              </Button>
            </div>
          </>
        ) : null}
        {phase === "complete" && attempt.account ? (
          <>
            <p className="flex items-center gap-2 rounded-lg bg-background/70 px-3 py-2 text-sm">
              <CircleCheckIcon className="size-4 shrink-0 text-success" />
              <Orb id={attempt.account} size="sm" />
              <span className="font-medium">{target ? `${resultLabel} credentials replaced` : `${resultLabel} is signed in`}</span>
            </p>
            <div className="flex items-center gap-1.5">
              {result && !result.active && !result.removing ? (
                <Button size="sm" variant="secondary" disabled={actions.activating === result.id} onClick={() => actions.activate(result)}>
                  {actions.activating === result.id ? <Spinner data-icon="inline-start" /> : null}
                  Make active
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={actions.dismissAttempt}>Dismiss</Button>
            </div>
          </>
        ) : null}
        {phase === "failed" ? (
          <>
            <p className="flex items-start gap-1.5 rounded-lg bg-background/70 px-3 py-2 text-[0.78rem] text-pretty text-destructive">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
              {attempt.error ?? "Sign-in failed."}
            </p>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="secondary" disabled={actions.pendingSignIn} onClick={() => actions.startSignIn(attempt.targetAccount)}>
                {actions.pendingSignIn ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={actions.dismissAttempt}>Dismiss</Button>
            </div>
          </>
        ) : null}
        {actions.error?.op === "signin" || actions.error?.op === "cancel" ? (
          <p className="text-[0.72rem] text-pretty text-destructive">{actions.error.message}</p>
        ) : null}
      </div>
    </NodeCard>
  );
}

function AccountCard({ account, label, servers }: { account: Account; label: string; servers: Server[] | null }) {
  const actions = useAuthActions();
  const activate = useOperation<Account>("auth", "account_activate");
  const used = serversFor(account.id, servers);
  const removing = account.removing || actions.removing === account.id;
  const busy = actions.removing === account.id;
  const onActivate = async () => {
    try {
      await activate.run({ id: account.id });
      toast.success(`${label} is now active`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <NodeCard node={{ kind: "account", id: account.id }} label={`account ${label}`} className={cn(removing && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Orb id={account.id} size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-sm font-semibold">
            {label}
            {account.active ? <Badge className="h-4 bg-success/15 px-1.5 text-[0.62rem] text-success">Active</Badge> : null}
            {removing ? <Badge variant="destructive" className="h-4 px-1.5 text-[0.62rem]">Removing</Badge> : null}
          </span>
          <span className="group/row flex items-center gap-1 font-mono text-[0.7rem] text-muted-foreground">
            {shortId(account.id, 13)}…
            <CopyButton value={account.id} label="account ID" className="size-5" />
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${label} actions`} className="ml-auto -mr-1" />}>
            <EllipsisVerticalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={account.active || removing} onClick={() => void onActivate()}>
                <CircleCheckIcon />Make active
              </DropdownMenuItem>
              <DropdownMenuItem disabled={removing} onClick={() => actions.startSignIn(account.id)}>
                <RefreshCwIcon />Sign in again
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" disabled={removing} onClick={() => actions.confirmRemove(account)}>
                <Trash2Icon />Remove account…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {used.length ? used.map((server) => (
          <span key={server.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem]">
            <StatusDot tone={server.recoveryIssue ? "warning" : server.state === "running" ? "success" : "muted"} label={server.recoveryIssue ? "Needs inspection" : server.state} className="size-1.5 [&>span]:size-1.5" />
            {server.id}
          </span>
        )) : <span className="text-[0.7rem] text-muted-foreground">No Servers bound</span>}
      </div>
      {busy ? (
        <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3.5" /> Removing…</p>
      ) : account.removing ? (
        <Button size="xs" variant="outline" className="w-fit" onClick={() => actions.finishRemoval(account)}>Finish removal</Button>
      ) : !account.active ? (
        <div className="flex flex-col gap-1">
          <Button size="xs" variant="secondary" className="w-fit" disabled={activate.pending} onClick={() => void onActivate()}>
            {activate.pending ? <Spinner data-icon="inline-start" /> : null}
            Make active
          </Button>
          {activate.error ? <p className="text-[0.72rem] text-pretty text-destructive">{activate.error}</p> : null}
        </div>
      ) : null}
    </NodeCard>
  );
}

/* ─── Servers ────────────────────────────────────────────────────────── */

function sortServers(servers: Server[]): Server[] {
  return [...servers].sort((a, b) => Number(Boolean(b.recoveryIssue)) - Number(Boolean(a.recoveryIssue)) || Number(b.state === "running") - Number(a.state === "running") || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function RecoveryWarning({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span><strong className="font-semibold">Needs inspection.</strong> {message}</span>
    </p>
  );
}

export function ServersWindow() {
  const { servers, bots, accounts, catalog, status, endpoints } = useStack();
  const activity = useActivity();
  const labels = accountLabels(accounts.data);
  const fields = recordFields(catalog.data, "codex", "server_list");
  const botIds = new Set(bots.data?.map((bot) => bot.id));
  const running = servers.data?.filter((server) => server.state === "running" && !server.recoveryIssue).length ?? 0;
  const fenced = servers.data?.filter((server) => server.recoveryIssue).length ?? 0;

  return (
    <Window id="servers" title="Servers" subtitle={servers.data ? `codex · ${running} running · ${fenced} need inspection · ${servers.data.length - running - fenced} stopped` : "codex · app-servers"}
      icon={ServerIcon} accent="codex" count={servers.data?.length} status={status.codex} endpoint={endpoints.codex} updatedAt={servers.at} error={servers.error}>
      {servers.data?.length ? (
        <div className="flex flex-col gap-2">
          {sortServers(servers.data).map((server) => (
            <ServerCard key={server.id} server={server} bot={botIds.has(server.id)} labels={labels} fields={fields} events={activity.get(`server:${server.id}`) ?? []} />
          ))}
        </div>
      ) : servers.data ? (
        <Empty icon={ServerIcon} title="No Codex Servers">server_start launches one; its first UI turn binds the main thread.</Empty>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Servers unavailable">{servers.error ?? "Waiting for the codex socket."}</Empty>
      )}
    </Window>
  );
}

function ServerCard({ server, bot, labels, fields, events }: {
  server: Server;
  bot: boolean;
  labels: Map<string, string>;
  fields: Map<string, { description: string | null }>;
  events: StackEvent[];
}) {
  const now = useNow();
  const fenced = Boolean(server.recoveryIssue);
  const running = server.state === "running" && !fenced;
  const pendingAssignment = running && server.account !== server.runningAccount;
  const recent = events[0] && now - events[0].at < 4_000;
  const hint = (name: string) => fields.get(name)?.description;
  return (
    <NodeCard node={{ kind: "server", id: server.id }} label={`server ${server.id}`} lastEvent={events[0]} accent="var(--pkg-codex)">
      <div className="flex items-center gap-2">
        <StatusDot tone={fenced ? "warning" : running ? "success" : "muted"} pulse={!fenced && Boolean(recent)} label={fenced ? "Needs inspection" : running ? "Running" : "Stopped"} />
        <span className="font-mono text-sm font-semibold">{server.id}</span>
        {bot ? <Badge variant="outline" className="h-4 gap-1 px-1.5 text-[0.62rem]"><BotIcon />bot</Badge> : null}
        <span className="ml-auto flex items-center gap-2 text-pkg-codex" title="Codex notices, last 5 minutes">
          <Sparkline values={histogram(events.map((event) => event.at), now, 16, activitySpan)} />
        </span>
      </div>
      <dl className="flex flex-col">
        <Row label="Account" hint={hint("account")}><AccountChip id={server.account} labels={labels} /></Row>
        <Row label="PID" hint={hint("pid")} mono>{server.pid ?? "—"}</Row>
        <Row label="Thread" hint={hint("mainThreadId")} mono copy={server.mainThreadId}>{server.mainThreadId ? shortId(server.mainThreadId) : "Awaiting first turn"}</Row>
        <Row label="Workspace" hint={hint("cwd")} copy={server.cwd}><Path path={server.cwd} /></Row>
      </dl>
      {server.recoveryIssue ? <RecoveryWarning message={server.recoveryIssue} /> : null}
      {pendingAssignment ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span>Running as {server.runningAccount ? labels.get(server.runningAccount) ?? shortId(server.runningAccount) : "unbound"}. Stop and start to apply {server.account ? labels.get(server.account) ?? shortId(server.account) : "unbound"}.</span>
        </p>
      ) : null}
      <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground">
        <span>{fenced ? "Recovery fenced" : events.length ? <>Codex notice <Time at={events[0].at} /></> : running ? server.mainThreadId ? "No notices yet" : "Awaiting first turn" : "Stopped"}</span>
        {server.url ? <span className="truncate font-mono" title={server.url}>{server.url.replace(/^unix:\/\/.*\//, "unix://…/")}</span> : null}
      </div>
    </NodeCard>
  );
}

/* ─── Bots ───────────────────────────────────────────────────────────── */

export function BotsWindow() {
  const { bots, accounts, scoped, status, endpoints } = useStack();
  const activity = useActivity();
  const labels = accountLabels(accounts.data);
  const now = useNow();

  return (
    <Window id="bots" title="Bots" subtitle="bots · private workspaces" icon={BotIcon} accent="bots"
      count={bots.data?.length} status={status.bots} endpoint={endpoints.bots} updatedAt={bots.at} error={bots.error}>
      {bots.data?.length ? (
        <div className="flex flex-col gap-2">
          {sortServers(bots.data).map((bot) => {
            const events = activity.get(`server:${bot.id}`) ?? [];
            const number = /(\d+)$/.exec(bot.id)?.[1];
            const subscription = scoped[bot.id];
            const threads = events.filter((event) => event.topic === "threads_changed").length;
            const lifecycle = events.length - threads;
            return (
              <NodeCard key={bot.id} node={{ kind: "bot", id: bot.id }} label={`bot ${bot.id}`} lastEvent={events[0]} accent="var(--pkg-bots)">
                <div className="flex items-center gap-3">
                  <span className="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-pkg-bots/12 font-mono text-lg font-semibold text-pkg-bots ring-1 ring-pkg-bots/25 ring-inset">
                    {number ?? <BotIcon className="size-5" />}
                    <StatusDot tone={bot.recoveryIssue ? "warning" : bot.state === "running" ? "success" : "muted"} pulse={!bot.recoveryIssue && Boolean(events[0] && now - events[0].at < 4_000)}
                      className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-card" label={bot.recoveryIssue ? "Needs inspection" : bot.state} />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-mono text-sm font-semibold">{bot.id}</span>
                    <span className="text-[0.72rem] text-muted-foreground">{bot.recoveryIssue ? "Needs inspection" : bot.state}{bot.pid ? ` · pid ${bot.pid}` : ""}</span>
                  </div>
                  <span className="ml-auto text-pkg-bots"><Sparkline values={histogram(events.map((event) => event.at), now, 12, activitySpan)} /></span>
                </div>
                <dl className="flex flex-col">
                  <Row label="Account"><AccountChip id={bot.account} labels={labels} /></Row>
                  <Row label="Main thread" mono copy={bot.mainThreadId}>{bot.mainThreadId ? shortId(bot.mainThreadId) : "Awaiting first turn"}</Row>
                  <Row label="Workspace" copy={bot.cwd}><Path path={bot.cwd} /></Row>
                </dl>
                {bot.recoveryIssue ? <RecoveryWarning message={bot.recoveryIssue} /> : null}
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2 py-1.5 text-[0.7rem]">
                  <RadioIcon className={cn("size-3.5", subscription?.status === "open" ? "text-pkg-bots" : "text-muted-foreground")} />
                  <span className="text-muted-foreground">{subscription?.status === "open" ? "Subscribed" : subscription ? "Connecting…" : "Not subscribed"}</span>
                  <span className="ml-auto flex items-center gap-2 font-mono tabular-nums">
                    <span title="Codex thread invalidations; may include other top-level threads">{threads} notices</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span title="bots_changed notices">{lifecycle} lifecycle</span>
                  </span>
                </div>
              </NodeCard>
            );
          })}
        </div>
      ) : bots.data ? (
        <Empty icon={BotIcon} title="No bots yet">bot_start allocates the next bot-N with its own workspace.</Empty>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Bots unavailable">{bots.error ?? "Waiting for the bots socket."}</Empty>
      )}
    </Window>
  );
}

/* ─── Activity ───────────────────────────────────────────────────────── */

export function ActivityWindow() {
  const { events, status, scoped } = useStack();
  const { focus } = useWorkbench();
  const now = useNow();
  const live = Object.values(status).filter((value) => value === "open").length + Object.values(scoped).filter((value) => value.status === "open").length;
  const bins = histogram(events.map((event) => event.at), now, 40, 10 * 60_000);

  return (
    <Window id="activity" title="Activity" subtitle={`events · ${live} live connection${live === 1 ? "" : "s"}`} icon={ActivityIcon} accent="events" count={events.length || null}>
      <div className="flex flex-col gap-1.5">
        <div className="text-pkg-events"><Sparkline values={bins} className="h-10 w-full justify-between [&>span]:w-auto [&>span]:flex-1" /></div>
        <div className="flex justify-between text-[0.65rem] text-muted-foreground tabular-nums"><span>10 min ago</span><span>now</span></div>
      </div>
      {events.length ? (
        <ol data-scroll className="-mx-1 flex max-h-80 flex-col overflow-y-auto overscroll-contain">
          {events.map((event) => (
            <li key={event.seq}>
              <button
                type="button"
                disabled={!event.scope}
                onClick={() => event.scope && focus({ kind: "server", id: event.scope })}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] animate-uix-arrive enabled:hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring"
                style={{ "--ping": `var(--pkg-${accentOf(event.pkg)})` } as React.CSSProperties}
              >
                <span className="font-mono text-[0.68rem] text-muted-foreground tabular-nums">{clockTime(event.at)}</span>
                <span className={cn("size-1.5 shrink-0 rounded-full", accentBg[accentOf(event.pkg)])} aria-hidden />
                <span className={cn("font-medium", accentText[accentOf(event.pkg)])}>{event.pkg}</span>
                <span className="truncate font-mono">{event.topic}</span>
                {event.scope ? <span className="ml-auto flex items-center gap-0.5 font-mono text-muted-foreground">{event.scope}<ChevronRightIcon className="size-3" /></span> : null}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <Empty icon={RadioIcon} title="Listening for change notices">Notices carry only a topic; each one triggers a fresh read of the affected state.</Empty>
      )}
    </Window>
  );
}

/* ─── API catalog ────────────────────────────────────────────────────── */

export function ApiWindow() {
  const { catalog, events, status, endpoints } = useStack();
  const packages = catalog.data ?? [];
  const operations = packages.reduce((sum, doc) => sum + doc.operations.length, 0);
  const topics = packages.reduce((sum, doc) => sum + Object.keys(doc.events).length, 0);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of events) map.set(`${event.pkg}:${event.topic}`, (map.get(`${event.pkg}:${event.topic}`) ?? 0) + 1);
    return map;
  }, [events]);

  return (
    <Window id="api" title="API" subtitle={`discovery · ${packages.length} packages · ${operations} operations · ${topics} events`}
      icon={BookOpenIcon} accent="api" status={status.api} endpoint={endpoints.api} updatedAt={catalog.at} error={catalog.error}>
      {packages.length ? packages.map((doc) => <PackageSection key={doc.name} doc={doc} counts={counts} />) : (
        <Empty icon={ShieldAlertIcon} title="Discovery unavailable">{catalog.error ?? "Waiting for the api socket."}</Empty>
      )}
    </Window>
  );
}

function PackageSection({ doc, counts }: { doc: PackageDoc; counts: Map<string, number> }) {
  const [open, setOpen] = useState(true);
  const { select } = useWorkbench();
  const accent = accentOf(doc.name);
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-background/40 p-2.5">
      <div className="flex items-center gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className={cn("size-2 rounded-full", accentBg[accent])} aria-hidden />
          <span className="text-sm font-semibold">{doc.name}</span>
          <span className="truncate font-mono text-[0.68rem] text-muted-foreground">{doc.packageName}</span>
        </button>
        <button type="button" onClick={() => select({ kind: "package", id: doc.name })}
          className="rounded-md px-1.5 py-0.5 text-[0.68rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          Inspect
        </button>
      </div>
      {open ? (
        <>
          <p className="px-0.5 text-[0.75rem] text-pretty text-muted-foreground">{doc.description}</p>
          <div className="flex flex-wrap gap-1">
            {doc.transports.map((transport) => (
              <Badge key={transport.type} variant="outline" className="h-5 gap-1 font-mono text-[0.65rem]" title={transport.endpoint ?? transport.description}>
                {transport.type}{transport.subscriptions ? <RadioIcon /> : null}
              </Badge>
            ))}
          </div>
          {Object.keys(doc.events).length ? (
            <div className="flex flex-col gap-0.5">
              {Object.entries(doc.events).map(([topic, description]) => (
                <div key={topic} className="flex items-center gap-2 px-0.5 text-[0.72rem]" title={description}>
                  <RadioIcon className={cn("size-3", accentText[accent])} />
                  <span className="font-mono">{topic}</span>
                  <span className="ml-auto font-mono text-muted-foreground tabular-nums">{counts.get(`${doc.name}:${topic}`) ?? 0}</span>
                </div>
              ))}
              {doc.eventScope ? <p className="px-0.5 text-[0.68rem] text-muted-foreground">{doc.eventScope.required ? "Requires" : "Optional"} scope · {doc.eventScope.description}</p> : null}
            </div>
          ) : null}
          <div className="-mx-1 flex flex-col">
            {doc.operations.map((operation) => (
              <NodeCard key={operation.name} node={{ kind: "operation", id: operation.name, pkg: doc.name }} label={`operation ${operation.name}`} variant="row">
                <div className="flex items-center gap-2 text-[0.78rem]">
                  <span className="truncate font-medium">{operationTitle(operation)}</span>
                  <span className="truncate font-mono text-[0.68rem] text-muted-foreground">{operation.name}</span>
                  <span className="ml-auto flex shrink-0 gap-1"><OperationBadges operation={operation} /></span>
                </div>
              </NodeCard>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
