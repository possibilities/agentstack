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
  PhoneIcon,
  RadioIcon,
  RefreshCwIcon,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { annotationBadges, fieldsOf, findOperation, operationTitle } from "@/lib/stack/catalog";
import { accountLabels, botsFor, clockTime, histogram, pathParts, shortId } from "@/lib/stack/derive";
import type { Account, Bot, Login, OperationDoc, PackageDoc } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useAuthActions } from "./auth-actions";
import { BotTile, channelLabel, CopyButton, Empty, NodeCard, Orb, Row, Sparkline, StatusDot, Time } from "./primitives";
import { useActivity, useNow, useStack, useWorkbench } from "./provider";
import { useVoice } from "./voice";
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
  const { accounts, login, bots, catalog, status, endpoints, attempt } = useStack();
  const actions = useAuthActions();
  const labels = accountLabels(accounts.data);

  return (
    <Window id="accounts" title="Accounts" subtitle="auth · codex sign-ins" icon={KeyRoundIcon} accent="auth"
      count={accounts.data?.length} status={status.auth} endpoint={endpoints.auth} updatedAt={accounts.at} error={accounts.error ?? login.error}
      actions={
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label="Add Codex account" disabled={actions.pendingSignIn} onClick={() => actions.startSignIn()} />}
          >
            {actions.pendingSignIn ? <Spinner /> : <UserRoundPlusIcon />}
          </TooltipTrigger>
          <TooltipContent side="bottom">Add Codex account</TooltipContent>
        </Tooltip>
      }>
      {attempt ? <SignInCard key={attempt.id} attempt={attempt} labels={labels} accounts={accounts.data} catalog={catalog.data} /> : null}

      {accounts.data?.length ? (
        <div className="flex flex-col gap-2">
          {accounts.data.map((account) => <AccountCard key={account.id} account={account} label={labels.get(account.id)!} bots={bots.data} />)}
          <button
            type="button"
            disabled={actions.pendingSignIn}
            onClick={() => actions.startSignIn()}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-background/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {actions.pendingSignIn ? <Spinner className="size-3.5" /> : <UserRoundPlusIcon className="size-3.5" />}
            Add Codex account
          </button>
        </div>
      ) : accounts.data ? (
        <div className="flex flex-col gap-2.5">
          <Empty icon={KeyRoundIcon} title="No Codex accounts">Device sign-in creates the first one; it becomes active.</Empty>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={() => actions.startSignIn()} disabled={actions.pendingSignIn}>
              {actions.pendingSignIn ? <Spinner data-icon="inline-start" /> : <UserRoundPlusIcon data-icon="inline-start" />}
              Add account
            </Button>
          </div>
        </div>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Accounts unavailable">{accounts.error ?? "Waiting for the auth socket."}</Empty>
      )}
      {accounts.data?.length ? <p className="px-0.5 text-[0.7rem] text-pretty text-muted-foreground">The active account binds to newly created bots. Labels are numbered from the current list; IDs never change.</p> : null}
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

function AccountCard({ account, label, bots }: { account: Account; label: string; bots: Bot[] | null }) {
  const actions = useAuthActions();
  const used = botsFor(account.id, bots);
  const removing = account.removing || actions.removing === account.id;
  const busy = actions.removing === account.id;
  const activating = actions.activating === account.id;
  const errorFor = (op: "activate" | "remove") =>
    actions.error?.op === op && actions.error.target === account.id ? actions.error.message : null;
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
              <DropdownMenuItem disabled={account.active || removing || activating} onClick={() => actions.activate(account)}>
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
        {used.length ? used.map((bot) => (
          <span key={bot.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem]">
            <StatusDot tone={bot.recoveryIssue ? "warning" : bot.state === "running" ? "success" : "muted"} label={bot.recoveryIssue ? "Needs inspection" : bot.state} className="size-1.5 [&>span]:size-1.5" />
            {bot.id}
          </span>
        )) : <span className="text-[0.7rem] text-muted-foreground">No bots bound</span>}
      </div>
      {busy ? (
        <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3.5" /> Removing…</p>
      ) : account.removing ? (
        <div className="flex flex-col gap-1">
          <Button size="xs" variant="outline" className="w-fit" onClick={() => actions.finishRemoval(account)}>Finish removal</Button>
          {errorFor("remove") ? <p className="text-[0.72rem] text-pretty text-destructive">{errorFor("remove")}</p> : null}
        </div>
      ) : !account.active ? (
        <div className="flex flex-col gap-1">
          <Button size="xs" variant="secondary" className="w-fit" disabled={activating} onClick={() => actions.activate(account)}>
            {activating ? <Spinner data-icon="inline-start" /> : null}
            Make active
          </Button>
          {errorFor("activate") ? <p className="text-[0.72rem] text-pretty text-destructive">{errorFor("activate")}</p> : null}
        </div>
      ) : null}
    </NodeCard>
  );
}

/* ─── Bots ───────────────────────────────────────────────────────────── */

function sortBots(bots: Bot[]): Bot[] {
  return [...bots].sort((a, b) => Number(Boolean(b.recoveryIssue)) - Number(Boolean(a.recoveryIssue)) || Number(b.state === "running") - Number(a.state === "running") || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function RecoveryWarning({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span><strong className="font-semibold">Needs inspection.</strong> {message}</span>
    </p>
  );
}

export function BotsWindow() {
  const { bots, accounts, scoped, status, endpoints } = useStack();
  const voice = useVoice();
  const activity = useActivity();
  const labels = accountLabels(accounts.data);
  const now = useNow();

  return (
    <Window id="bots" title="Bots" subtitle="bots · private workspaces" icon={BotIcon} accent="bots"
      count={bots.data?.length} status={status.bots} endpoint={endpoints.bots} updatedAt={bots.at} error={bots.error}>
      {bots.data?.length ? (
        <div className="flex flex-col gap-2">
          {sortBots(bots.data).map((bot) => {
            const events = activity.get(`bot:${bot.id}`) ?? [];
            const subscription = scoped[bot.id];
            const threads = events.filter((event) => event.topic === "threads_changed").length;
            const lifecycle = events.length - threads;
            const onCall = voice.botId === bot.id;
            const callReason = voice.callable(bot);
            return (
              <NodeCard key={bot.id} node={{ kind: "bot", id: bot.id }} label={`bot ${bot.id}`} lastEvent={events[0]} accent="var(--pkg-bots)"
                className={cn(onCall && "border-pkg-bots/40 ring-2 ring-pkg-bots/35 shadow-[0_0_18px_-4px_color-mix(in_oklch,var(--pkg-bots)_45%,transparent)]")}>
                <div className="flex items-center gap-3">
                  <BotTile bot={bot} pulse={!bot.recoveryIssue && Boolean(events[0] && now - events[0].at < 4_000)} />
                  <div className="flex min-w-0 flex-col">
                    <span className="font-mono text-sm font-semibold">{bot.id}</span>
                    <span className="text-[0.72rem] text-muted-foreground">{bot.recoveryIssue ? "Needs inspection" : bot.state}{bot.pid ? ` · pid ${bot.pid}` : ""}</span>
                  </div>
                  {onCall ? (
                    <Badge variant="secondary" className="ml-auto gap-1 bg-pkg-bots/10 text-pkg-bots">
                      <PhoneIcon className="size-3" />
                      On call{voice.startedAt ? ` · ${elapsedClock(voice.startedAt, now)}` : voice.phase !== "idle" ? ` · ${voice.phase}` : ""}
                    </Badge>
                  ) : (
                    <span className="ml-auto text-pkg-bots"><Sparkline values={histogram(events.map((event) => event.at), now, 12, activitySpan)} /></span>
                  )}
                </div>
                <dl className="flex flex-col">
                  <Row label="Account"><AccountChip id={bot.account} labels={labels} /></Row>
                  <Row label="Main thread" mono copy={bot.mainThreadId}>{bot.mainThreadId ? shortId(bot.mainThreadId) : "Awaiting first turn"}</Row>
                  <Row label="Role revision" mono>{bot.roleRevision ?? "Never launched"}</Row>
                  <Row label="Workspace" copy={bot.cwd}><Path path={bot.cwd} /></Row>
                </dl>
                {bot.recoveryIssue ? <RecoveryWarning message={bot.recoveryIssue} /> : null}
                {bot.state === "running" && !bot.recoveryIssue && bot.account !== bot.runningAccount ? (
                  <p className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1.5 text-[0.72rem] text-pretty text-warning">
                    <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                    <span>Running as {bot.runningAccount ? labels.get(bot.runningAccount) ?? shortId(bot.runningAccount) : "unbound"}. Stop and start to apply {bot.account ? labels.get(bot.account) ?? shortId(bot.account) : "unbound"}.</span>
                  </p>
                ) : null}
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2 py-1.5 text-[0.7rem]">
                  <RadioIcon className={cn("size-3.5", subscription?.status === "open" ? "text-pkg-bots" : "text-muted-foreground")} />
                  <span className="text-muted-foreground">{subscription?.status === "open" ? "Subscribed" : subscription ? "Connecting…" : "Not subscribed"}</span>
                  <span className="ml-auto flex items-center gap-2 font-mono tabular-nums">
                    <span title="Codex thread invalidations; may include other top-level threads">{threads} notices</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span title="bots_changed notices">{lifecycle} lifecycle</span>
                  </span>
                </div>
                {!onCall && callReason === null && !voice.busy ? (
                  <Button size="xs" variant="outline" className="w-fit" onClick={() => voice.dial(bot.id)}>
                    <PhoneIcon data-icon="inline-start" />
                    Call
                  </Button>
                ) : null}
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
  const { goTo } = useWorkbench();
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
        <ol data-scroll className="-mx-1 flex max-h-[32rem] flex-col overflow-y-auto overscroll-contain">
          {events.map((event) => (
            <li key={event.seq}>
              <button
                type="button"
                disabled={!event.scope}
                onClick={() => event.scope && goTo({ kind: "bot", id: event.scope })}
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

export function PackagesWindow() {
  const { catalog, status, endpoints } = useStack();
  const { goTo } = useWorkbench();
  const packages = catalog.data ?? [];
  const operations = packages.reduce((sum, doc) => sum + doc.operations.length, 0);
  const topics = packages.reduce((sum, doc) => sum + Object.keys(doc.events).length, 0);

  return (
    <Window id="packages" title="Packages" subtitle={`discovery · ${packages.length} packages · ${operations} operations · ${topics} events`}
      icon={BookOpenIcon} accent="api" status={status.api} endpoint={endpoints.api} updatedAt={catalog.at} error={catalog.error}>
      {packages.length ? (
        <div className="-mx-1 flex flex-col">
          {packages.map((doc) => {
            const accent = accentOf(doc.name);
            const endpoint = endpoints[doc.name];
            const channel = channelLabel(endpoint, status[doc.name]);
            return (
              <NodeCard key={doc.name} node={{ kind: "package", id: doc.name }} label={`package ${doc.name}`} variant="row"
                activate={() => goTo({ kind: "package", id: doc.name })}>
                <div className="flex items-center gap-2 text-[0.8rem]">
                  <span className={cn("size-2 shrink-0 rounded-full", accentBg[accent])} aria-hidden />
                  <span className="font-medium">{doc.name}</span>
                  <span className="truncate font-mono text-[0.68rem] text-muted-foreground">{doc.packageName}</span>
                  <span className="ml-auto shrink-0 text-[0.68rem] text-muted-foreground tabular-nums">
                    {doc.operations.length} ops · {Object.keys(doc.events).length} events
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {doc.transports.map((transport) => (
                    <Badge key={transport.type} variant="outline" className="h-5 gap-1 font-mono text-[0.65rem]" title={transport.endpoint ?? transport.description}>
                      {transport.type}{transport.subscriptions ? <RadioIcon /> : null}
                    </Badge>
                  ))}
                  <span className="ml-auto flex items-center gap-1.5 text-[0.68rem] text-muted-foreground">
                    <StatusDot tone={channel.tone} label={endpoint ? `WebSocket ${channel.label}` : channel.label} />
                    {channel.label}
                  </span>
                </div>
              </NodeCard>
            );
          })}
        </div>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Discovery unavailable">{catalog.error ?? "Waiting for the api socket."}</Empty>
      )}
    </Window>
  );
}

export function PackageWindow({ name }: { name: string }) {
  const { catalog, events, status, endpoints } = useStack();
  const doc = catalog.data?.find((item) => item.name === name);
  const accent = accentOf(name);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of events) if (event.pkg === name) map.set(event.topic, (map.get(event.topic) ?? 0) + 1);
    return map;
  }, [events, name]);
  const reads = doc?.operations.filter((operation) => operation.annotations.readOnlyHint === true) ?? [];
  const actions = doc?.operations.filter((operation) => operation.annotations.readOnlyHint !== true) ?? [];

  return (
    <Window id={`package:${name}`} title={name} subtitle={doc?.packageName ?? "package"} icon={BookOpenIcon} accent={accent}
      status={status[name]} endpoint={endpoints[name]} updatedAt={catalog.at} error={doc ? null : catalog.error}
      node={{ kind: "package", id: name }}>
      {doc ? (
        <>
          <p className="text-sm text-pretty text-muted-foreground">{doc.description}</p>
          {doc.transports.length ? (
            <Section title="Transports">
              <ul className="flex flex-col gap-2">
                {doc.transports.map((transport) => (
                  <li key={transport.type} className="group/row flex flex-col gap-0.5 rounded-lg border bg-background/50 p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium">{transport.type}</span>
                      {transport.subscriptions ? <Badge variant="secondary" className="h-4 gap-1 text-[0.62rem]"><RadioIcon />events</Badge> : null}
                      {transport.endpoint ? <CopyButton value={transport.endpoint} label={`${transport.type} endpoint`} className="ml-auto" /> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{transport.description}</p>
                    {transport.endpoint ? <p className="font-mono text-[0.7rem] break-all">{transport.endpoint}</p> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {Object.keys(doc.events).length ? (
            <Section title="Events">
              <ul className="flex flex-col gap-2">
                {Object.entries(doc.events).map(([topic, description]) => (
                  <li key={topic} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <RadioIcon className={cn("size-3", accentText[accent])} />
                      <span className="font-mono text-[0.78rem] font-medium">{topic}</span>
                      <span className="ml-auto font-mono text-[0.7rem] text-muted-foreground tabular-nums" title="notices seen this session">{counts.get(topic) ?? 0}</span>
                    </div>
                    <p className="text-xs text-pretty text-muted-foreground">{description}</p>
                  </li>
                ))}
              </ul>
              {doc.eventScope ? (
                <p className="rounded-lg bg-muted/60 p-2.5 text-xs text-pretty text-muted-foreground">
                  <span className="font-medium text-foreground">{doc.eventScope.required ? "Required" : "Optional"} scope</span> — {doc.eventScope.description} Example: <span className="font-mono">{doc.eventScope.example}</span>
                </p>
              ) : null}
            </Section>
          ) : null}
          {reads.length ? (
            <Section title={`Reads · ${reads.length}`}>
              <div className="flex flex-col gap-2">
                {reads.map((operation) => <OperationCard key={operation.name} doc={doc} operation={operation} />)}
              </div>
            </Section>
          ) : null}
          {actions.length ? (
            <Section title={`Actions · ${actions.length}`}>
              <div className="flex flex-col gap-2">
                {actions.map((operation) => <OperationCard key={operation.name} doc={doc} operation={operation} />)}
              </div>
            </Section>
          ) : null}
        </>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Package unavailable">{catalog.error ?? "Waiting for the api socket."}</Empty>
      )}
    </Window>
  );
}

function OperationCard({ doc, operation }: { doc: PackageDoc; operation: OperationDoc }) {
  const input = fieldsOf(operation.inputSchema);
  return (
    <NodeCard node={{ kind: "operation", id: operation.name, pkg: doc.name }} label={`operation ${operation.name}`}>
      <div className="flex items-center gap-2 text-[0.8rem]">
        <span className="truncate font-medium">{operationTitle(operation)}</span>
        <span className="truncate font-mono text-[0.68rem] text-muted-foreground">{operation.name}</span>
        <span className="ml-auto flex shrink-0 gap-1"><OperationBadges operation={operation} /></span>
      </div>
      <p className="line-clamp-3 text-xs text-pretty text-muted-foreground">{operation.description}</p>
      <div className="flex flex-wrap items-center gap-1">
        {input.length ? input.map((field) => (
          <span key={field.name} title={field.required ? "required" : field.description ?? undefined}
            className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
            {field.name}{field.required ? "*" : ""}
          </span>
        )) : <span className="text-[0.7rem] text-muted-foreground">No input</span>}
      </div>
    </NodeCard>
  );
}
