"use client";

import { useMemo, useState } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  IdCardIcon,
  KeyRoundIcon,
  PhoneIcon,
  RadioIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserRoundPlusIcon,
  XIcon,
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { annotationBadges, fieldsOf, findOperation } from "@/lib/stack/catalog";
import { accountLabels, botsFor, histogram, providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import type { Account, Bot, Login, OperationDoc, PackageDoc, WorkerAccount, WorkerLogin } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useAuthActions } from "./auth-actions";
import { BotTile, CopyButton, Empty, NodeCard, NodeTitle, Orb, Row, Sparkline, StatusDot, Time } from "./primitives";
import { BotLifecycleControls, BotWindowActions } from "./bot-actions";
import { useActivity, useNow, useStack, useWorkbench } from "./provider";
import { useVoice } from "./voice";
import { Section, Window } from "./window";

const activitySpan = 5 * 60_000;

export function AccountChip({ id, labels }: { id: string | null; labels: Map<string, string> }) {
  if (!id) return <span className="text-muted-foreground">Unbound</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Orb id={id} size="sm" />
      <span>{labels.get(id) ?? shortId(id)}</span>
    </span>
  );
}

const workerProviders: WorkerAccount["provider"][] = ["codex", "grok", "devin"];

/** The Worker account window's menu: one terminal sign-in per provider. */
export function AddWorkerAccountMenu({ trigger, tooltip, align = "end" }: { trigger: React.ReactElement; tooltip?: string; align?: "start" | "end" }) {
  const actions = useAuthActions();
  const addWorker = (provider: WorkerAccount["provider"]) => {
    void actions.worker.signIn(provider);
  };
  const button = <DropdownMenuTrigger render={trigger} />;
  return (
    <DropdownMenu>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent side="bottom">{tooltip}</TooltipContent>
        </Tooltip>
      ) : button}
      <DropdownMenuContent align={align} className="min-w-52">
        <DropdownMenuGroup>
          {workerProviders.map((provider) => (
            <DropdownMenuItem key={provider} className="whitespace-nowrap" disabled={actions.worker.signingIn === `new:${provider}`} onClick={() => addWorker(provider)}>
              {actions.worker.signingIn === `new:${provider}` ? <Spinner /> : <TerminalIcon />}
              {providerTitle(provider)} Worker account
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The dashed full-width "Add Worker account" button. */
export function AddWorkerAccountButton() {
  const actions = useAuthActions();
  return (
    <AddWorkerAccountMenu align="start" trigger={
      <button
        type="button"
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-background/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
      >
        {actions.worker.signingIn?.startsWith("new:") ? <Spinner className="size-3.5" /> : <UserRoundPlusIcon className="size-3.5" />}
        Add Worker account
      </button>
    } />
  );
}

export function OperationBadges({ operation }: { operation: OperationDoc }) {
  return annotationBadges(operation).map(({ key, label }) => (
    <Badge key={key} variant={key === "destructiveHint" ? "destructive" : "secondary"} className="h-4 px-1.5 text-[0.62rem]">{label}</Badge>
  ));
}

/* ─── Accounts ───────────────────────────────────────────────────────── */

export function AccountsWindow() {
  const { accounts, login, bots, catalog, status, endpoints, attempt } = useStack();
  const actions = useAuthActions();
  const { goTo } = useWorkbench();
  const labels = accountLabels(accounts.data);
  const addBot = () => actions.startSignIn();

  return (
    <Window id="accounts" title="Bot accounts" subtitle="auth · codex bot sign-ins" icon={KeyRoundIcon} accent="auth"
      count={accounts.data?.length} status={status.auth} endpoint={endpoints.auth} updatedAt={accounts.at} error={accounts.error ?? login.error}
      actions={
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label="Add Codex Bot account" disabled={actions.pendingSignIn} onClick={addBot} />}
          >
            {actions.pendingSignIn ? <Spinner /> : <UserRoundPlusIcon />}
          </TooltipTrigger>
          <TooltipContent side="bottom">Add Codex Bot account</TooltipContent>
        </Tooltip>
      }>
      {attempt ? <SignInCard key={attempt.id} attempt={attempt} labels={labels} accounts={accounts.data} catalog={catalog.data} /> : null}

      {accounts.data?.length ? (
        <div className="flex flex-col gap-2">
          {accounts.data.map((account) => <AccountCard key={account.id} account={account} label={labels.get(account.id)!} bots={bots.data} />)}
          <button
            type="button"
            disabled={actions.pendingSignIn}
            onClick={addBot}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-background/80 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {actions.pendingSignIn ? <Spinner className="size-3.5" /> : <UserRoundPlusIcon className="size-3.5" />}
            Add Codex Bot account
          </button>
        </div>
      ) : accounts.data ? (
        <div className="flex flex-col gap-2.5">
          <Empty icon={KeyRoundIcon} title="No Bot accounts">Device sign-in creates an enabled Bot account. Choose its ID when starting a bot.</Empty>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" disabled={actions.pendingSignIn} onClick={addBot}>
              {actions.pendingSignIn ? <Spinner data-icon="inline-start" /> : <UserRoundPlusIcon data-icon="inline-start" />}
              Add Codex Bot account
            </Button>
          </div>
        </div>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Accounts unavailable">{accounts.error ?? "Waiting for the auth socket."}</Empty>
      )}
      {accounts.data?.length ? <p className="px-0.5 text-[0.7rem] text-pretty text-muted-foreground">Choose an enabled Bot account ID when starting a bot. Labels are numbered from this list; IDs never change.</p> : null}
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

  return (
    <NodeCard node={{ kind: "login" }} label="device sign-in"
      className={cn(attempt.status === "failed" ? "border-destructive/40 bg-destructive/5" : attempt.status === "complete" ? "border-success/40 bg-success/5" : "border-pkg-auth/40 bg-pkg-auth/5")}>
      <div className="flex items-center gap-2">
        <UserRoundPlusIcon className="size-4 text-pkg-auth" />
        <NodeTitle node={{ kind: "login" }} label="device sign-in" className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          {target ? (
            <>Signing in again · <Orb id={target} size="sm" /> {labels.get(target) ?? shortId(target)}</>
          ) : "New Codex Bot account"}
        </NodeTitle>
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
            <p className="text-[0.72rem] text-pretty text-muted-foreground">Copy the link into your browser and enter this code.</p>
            {attempt.authUrl ? <SignInLink url={attempt.authUrl} /> : null}
            <SignInCodeRow>
              <span className="min-w-0 font-mono text-2xl font-semibold tracking-[0.22em] break-all" title={loginFields.find((field) => field.name === "userCode")?.description ?? undefined}>{attempt.userCode}</span>
              <CopyButton value={attempt.userCode ?? ""} label="one-time code" className="opacity-100" />
            </SignInCodeRow>
            <SignInStatus label="Waiting for approval" since={seenAt} now={now} />
            <div className="flex items-center gap-1.5">
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
              {result && !result.enabled && !result.removing ? (
                <Button size="sm" variant="secondary" disabled={actions.changingAvailability === result.id} onClick={() => actions.setEnabled(result, true)}>
                  {actions.changingAvailability === result.id ? <Spinner data-icon="inline-start" /> : null}
                  Enable
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
  const { workerAccounts } = useStack();
  const { goTo } = useWorkbench();
  const workerLabels = workerAccountLabels(workerAccounts.data);
  const linkedWorkers = (account.linkedAccounts ?? []).filter((link) => link.scope === "worker" && workerLabels.has(link.id));
  const used = botsFor(account.id, bots);
  const removing = account.removing || actions.removing === account.id;
  const busy = actions.removing === account.id;
  const changingAvailability = actions.changingAvailability === account.id;
  const errorFor = (op: "availability" | "remove") =>
    actions.error?.op === op && actions.error.target === account.id ? actions.error.message : null;
  return (
    <NodeCard node={{ kind: "account", id: account.id }} label={`account ${label}`} className={cn(removing && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Orb id={account.id} size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <NodeTitle node={{ kind: "account", id: account.id }} label={`account ${label}`}>{label}</NodeTitle>
            <Badge className={cn("h-4 px-1.5 text-[0.62rem]", account.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>{account.enabled ? "Enabled" : "Disabled"}</Badge>
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
              <DropdownMenuItem disabled={removing || changingAvailability} onClick={() => actions.setEnabled(account, !account.enabled)}>
                <CircleCheckIcon />{account.enabled ? "Disable" : "Enable"}
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
      {linkedWorkers.length ? (
        <div className="flex flex-wrap items-center gap-1">
          {linkedWorkers.map((link) => {
            const workerLabel = workerLabels.get(link.id)!;
            return (
              <Tooltip key={link.id}>
                <TooltipTrigger render={
                  <button
                    type="button"
                    onClick={() => goTo({ kind: "worker-account", id: link.id })}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Orb id={link.id} size="sm" className="size-2.5" />
                    {workerLabel}
                  </button>
                } />
                <TooltipContent>Same ChatGPT account as Worker {workerLabel}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
      {busy ? (
        <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3.5" /> Removing…</p>
      ) : account.removing ? (
        <div className="flex flex-col gap-1">
          <Button size="xs" variant="outline" className="w-fit" onClick={() => actions.finishRemoval(account)}>Finish removal</Button>
          {errorFor("remove") ? <p className="text-[0.72rem] text-pretty text-destructive">{errorFor("remove")}</p> : null}
        </div>
      ) : !account.enabled ? (
        <div className="flex flex-col gap-1">
          <Button size="xs" variant="secondary" className="w-fit" disabled={changingAvailability} onClick={() => actions.setEnabled(account, true)}>
            {changingAvailability ? <Spinner data-icon="inline-start" /> : null}
            Enable
          </Button>
          {errorFor("availability") ? <p className="text-[0.72rem] text-pretty text-destructive">{errorFor("availability")}</p> : null}
        </div>
      ) : null}
    </NodeCard>
  );
}

/* ─── Worker accounts ────────────────────────────────────────────────── */

export function WorkerAccountsWindow() {
  const { workerAccounts, accounts, status, endpoints } = useStack();
  const labels = workerAccountLabels(workerAccounts.data);

  return (
    <Window id="worker-accounts" title="Worker accounts" subtitle="auth · terminal sign-ins" icon={IdCardIcon} accent="auth"
      count={workerAccounts.data?.length} status={status.auth} endpoint={endpoints.auth} updatedAt={workerAccounts.at} error={workerAccounts.error}
      actions={
        <AddWorkerAccountMenu tooltip="Add Worker account" trigger={
          <Button variant="ghost" size="icon-xs" aria-label="Add Worker account"><UserRoundPlusIcon /></Button>
        } />
      }>
      {workerAccounts.data?.length ? (
        <div className="flex flex-col gap-3">
          {workerProviders.map((provider) => {
            const members = workerAccounts.data!.filter((account) => account.provider === provider);
            return members.length ? (
              <Section key={provider} title={providerTitle(provider)}>
                <div className="flex flex-col gap-2">
                  {members.map((account) => <WorkerAccountCard key={account.id} account={account} label={labels.get(account.id)!} accounts={accounts.data} />)}
                </div>
              </Section>
            ) : null;
          })}
          <AddWorkerAccountButton />
        </div>
      ) : workerAccounts.data ? (
        <div className="flex flex-col gap-2.5">
          <Empty icon={IdCardIcon} title="No Worker accounts">Terminal sign-in creates an independent Codex, Grok, or Devin Worker account.</Empty>
          <div className="flex justify-center">
            <AddWorkerAccountMenu trigger={
              <Button size="sm" variant="outline">
                <UserRoundPlusIcon data-icon="inline-start" />
                Add Worker account
              </Button>
            } />
          </div>
        </div>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Worker accounts unavailable">{workerAccounts.error ?? "Waiting for the auth socket."}</Empty>
      )}
    </Window>
  );
}

function WorkerAccountCard({ account, label, accounts }: { account: WorkerAccount; label: string; accounts: Account[] | null }) {
  const actions = useAuthActions();
  const { workerAttempts } = useStack();
  const { goTo } = useWorkbench();
  const worker = actions.worker;
  const botLabels = accountLabels(accounts);
  const linkedBots = account.provider === "codex"
    ? (account.linkedAccounts ?? []).filter((link) => link.scope === "bot" && botLabels.has(link.id))
    : [];
  const removing = account.removing || worker.removing === account.id;
  const busy = worker.removing === account.id;
  const changingAvailability = worker.changingAvailability === account.id;
  const attempt = workerAttempts[account.id];
  const errorFor = (op: "signin" | "submit" | "cancel" | "availability" | "remove") =>
    worker.error?.op === op && worker.error.target === account.id ? worker.error.message : null;
  return (
    <NodeCard node={{ kind: "worker-account", id: account.id }} label={`worker account ${label}`} className={cn(removing && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Orb id={account.id} size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            <NodeTitle node={{ kind: "worker-account", id: account.id }} label={`worker account ${label}`}>{label}</NodeTitle>
            <Badge className={cn("h-4 px-1.5 text-[0.62rem]", account.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>{account.enabled ? "Enabled" : "Disabled"}</Badge>
            <Badge className={cn("h-4 px-1.5 text-[0.62rem]", account.ready ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>{account.ready ? "Ready" : "Needs sign-in"}</Badge>
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
              <DropdownMenuItem disabled={removing || changingAvailability} onClick={() => worker.setEnabled(account, !account.enabled)}>
                <CircleCheckIcon />{account.enabled ? "Disable" : "Enable"}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={removing || worker.signingIn === account.id || attempt?.status === "pending"} onClick={() => void worker.signIn(account.provider, account.id)}>
                <RefreshCwIcon />Sign in again
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" disabled={removing} onClick={() => worker.confirmRemove(account)}>
                <Trash2Icon />Remove account…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {linkedBots.length ? (
        <div className="flex flex-wrap items-center gap-1">
          {linkedBots.map((link) => {
            const botLabel = botLabels.get(link.id)!;
            return (
              <Tooltip key={link.id}>
                <TooltipTrigger render={
                  <button
                    type="button"
                    onClick={() => goTo({ kind: "account", id: link.id })}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.68rem] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Orb id={link.id} size="sm" className="size-2.5" />
                    {botLabel}
                  </button>
                } />
                <TooltipContent>Same ChatGPT account as Bot {botLabel}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
      {busy ? (
        <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3.5" /> Removing…</p>
      ) : account.removing ? (
        <div className="flex flex-col gap-1">
          <Button size="xs" variant="outline" className="w-fit" onClick={() => worker.finishRemoval(account)}>Finish removal</Button>
          {errorFor("remove") ? <p className="text-[0.72rem] text-pretty text-destructive">{errorFor("remove")}</p> : null}
        </div>
      ) : !account.ready || attempt ? (
        <WorkerSignInPanel key={attempt?.id ?? account.id} account={account} attempt={attempt} error={errorFor("signin") ?? errorFor("submit") ?? errorFor("cancel")} />
      ) : !account.enabled ? (
        <div className="flex flex-col gap-1">
          <Button size="xs" variant="secondary" className="w-fit" disabled={changingAvailability} onClick={() => worker.setEnabled(account, true)}>
            {changingAvailability ? <Spinner data-icon="inline-start" /> : null}
            Enable
          </Button>
          {errorFor("availability") ? <p className="text-[0.72rem] text-pretty text-destructive">{errorFor("availability")}</p> : null}
        </div>
      ) : null}
    </NodeCard>
  );
}

/** The link an API-run sign-in hands to the human, shown as copyable text only — never opened by the canvas. */
function SignInLink({ url }: { url: string }) {
  return (
    <div className="group/row flex items-center gap-1.5 rounded-lg bg-background/70 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-muted-foreground" title={url}>{url}</code>
      <Button size="xs" variant="secondary" className="shrink-0" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success("Link copied")).catch(() => undefined)}>
        <CopyIcon data-icon="inline-start" />
        Copy link
      </Button>
    </div>
  );
}

function SignInCodeRow({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-13 items-center justify-between gap-2 rounded-lg bg-background/70 px-3 py-2.5">{children}</div>;
}

function SignInStatus({ label, since, now }: { label: string; since: number; now: number }) {
  return (
    <p className="flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
      <Spinner aria-hidden className="size-3 shrink-0 text-pkg-auth" />
      <span role="status">{label}</span>
      <span aria-hidden>·</span>
      <span role="timer" aria-label="Elapsed sign-in time" className="tabular-nums">{elapsedClock(since, now)}</span>
    </p>
  );
}

function WorkerSignInPanel({ account, attempt, error }: { account: WorkerAccount; attempt: WorkerLogin | undefined; error: string | null }) {
  const worker = useAuthActions().worker;
  const now = useNow();
  // The parent keys this panel by attempt, so its timer and draft reset together.
  const [since] = useState(() => Date.now());
  const [code, setCode] = useState("");
  const signingIn = worker.signingIn === account.id;
  const submitting = attempt ? worker.submitting === attempt.id : false;
  const cancelling = attempt ? worker.cancelling === attempt.id : false;
  const pending = attempt?.status === "pending";
  const cancelButton = pending ? (
    <Button size="xs" variant="ghost" className="w-fit" disabled={cancelling} onClick={() => worker.cancel(attempt)}>
      {cancelling ? <Spinner data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}
      Cancel
    </Button>
  ) : null;
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-2.5",
      attempt?.status === "complete" ? "border-success/40 bg-success/5"
        : attempt?.status === "failed" ? "border-destructive/40 bg-destructive/5"
        : "border-warning/30 bg-warning/5")}>
      {!attempt ? (
        <>
          <p className="text-[0.72rem] text-muted-foreground">Needs a sign-in before it can run Worker turns.</p>
          <Button size="xs" variant="secondary" className="w-fit" disabled={signingIn} onClick={() => void worker.signIn(account.provider, account.id)}>
            {signingIn ? <Spinner data-icon="inline-start" /> : <UserRoundPlusIcon data-icon="inline-start" />}
            Sign in
          </Button>
        </>
      ) : pending ? (
        <>
          {attempt.authUrl ? (
            <>
              <p id={`worker-signin-help-${attempt.id}`} className="text-[0.72rem] text-pretty text-muted-foreground">
                {attempt.provider === "devin"
                  ? "Copy the link into your browser, then paste the code from Devin here."
                  : "Copy the link into your browser and enter this code."}
              </p>
              <SignInLink url={attempt.authUrl} />
            </>
          ) : null}
          {attempt.userCode ? (
            <SignInCodeRow>
              <span className="min-w-0 font-mono text-2xl font-semibold tracking-[0.22em] break-all">{attempt.userCode}</span>
              <CopyButton value={attempt.userCode} label="one-time code" className="opacity-100" />
            </SignInCodeRow>
          ) : null}
          {attempt.needsCode ? (
            <form
              aria-label="Submit Devin sign-in code"
              onSubmit={(event) => {
                event.preventDefault();
                if (code.trim() && !submitting && !cancelling) void worker.submitCode(attempt, code.trim()).then(() => setCode(""), () => undefined);
              }}
            >
              <SignInCodeRow>
                <FieldGroup>
                  <Field orientation="horizontal" data-disabled={submitting || cancelling} data-invalid={Boolean(attempt.error)}>
                    <FieldLabel htmlFor={`worker-signin-code-${attempt.id}`} className="sr-only">Code from Devin</FieldLabel>
                    <Input
                      id={`worker-signin-code-${attempt.id}`}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      placeholder="Paste code"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      className="min-w-0 flex-1"
                      aria-describedby={[attempt.authUrl ? `worker-signin-help-${attempt.id}` : null, attempt.error ? `worker-signin-error-${attempt.id}` : null].filter(Boolean).join(" ") || undefined}
                      aria-invalid={Boolean(attempt.error)}
                      disabled={submitting || cancelling}
                    />
                    <Button type="submit" size="xs" variant="secondary" disabled={submitting || cancelling || !code.trim()}>
                      {submitting ? <Spinner aria-hidden data-icon="inline-start" /> : null}
                      Submit code
                    </Button>
                  </Field>
                </FieldGroup>
              </SignInCodeRow>
            </form>
          ) : null}
          <SignInStatus
            label={submitting ? "Submitting code…" : attempt.needsCode ? "Waiting for code" : !attempt.authUrl ? "Starting sign-in…" : attempt.userCode ? "Waiting for approval" : "Waiting for sign-in"}
            since={since}
            now={now}
          />
          {attempt.error ? <p id={`worker-signin-error-${attempt.id}`} role="alert" className="text-[0.72rem] text-pretty text-destructive">{attempt.error}</p> : null}
          {cancelButton}
        </>
      ) : attempt.status === "complete" ? (
        <>
          <p className="flex items-center gap-2 rounded-lg bg-background/70 px-3 py-2 text-sm">
            <CircleCheckIcon className="size-4 shrink-0 text-success" />
            Signed in
          </p>
          <Button size="xs" variant="ghost" className="w-fit" onClick={() => worker.dismiss(account.id)}>Dismiss</Button>
        </>
      ) : (
        <>
          <p className="flex items-start gap-1.5 rounded-lg bg-background/70 px-3 py-2 text-[0.78rem] text-pretty text-destructive">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
            {attempt.error ?? "Sign-in failed."}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" variant="secondary" disabled={signingIn} onClick={() => void worker.signIn(account.provider, account.id)}>
              {signingIn ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              Try again
            </Button>
            <Button size="xs" variant="ghost" onClick={() => worker.dismiss(account.id)}>Dismiss</Button>
          </div>
        </>
      )}
      {error ? <p role="alert" className="text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
    </div>
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
      count={bots.data?.length} status={status.bots} endpoint={endpoints.bots} updatedAt={bots.at} error={bots.error} actions={<BotWindowActions />}>
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
                    <NodeTitle node={{ kind: "bot", id: bot.id }} label={`bot ${bot.id}`} className="font-mono text-sm font-semibold">{bot.id}</NodeTitle>
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
                  <Row label="Bot account"><AccountChip id={bot.account} labels={labels} /></Row>
                  <Row label="Main thread" mono copy={bot.mainThreadId}>{bot.mainThreadId ? shortId(bot.mainThreadId) : "Awaiting first turn"}</Row>
                  <Row label="Role revision" mono>{bot.roleRevision ?? "Never launched"}</Row>
                  <Row label="Saved model">{bot.settings?.model ?? "Codex implicit default"}</Row>
                  <Row label="Saved effort">{bot.settings?.reasoningEffort ?? "Codex implicit default"}</Row>
                  <Row label="Workspace" copy={bot.cwd} mono className="[&>dd]:break-all [&>dd]:whitespace-normal">{bot.cwd}</Row>
                  {bot.url ? <Row label="Endpoint" copy={bot.url} mono className="[&>dd]:break-all [&>dd]:whitespace-normal">{bot.url}</Row> : null}
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
                <BotLifecycleControls bot={bot} />
              </NodeCard>
            );
          })}
        </div>
      ) : bots.data ? (
        <Empty icon={BotIcon} title="No bots yet">Choose Create Bot to start with an enabled Codex Bot account. Add an account in Bot accounts if needed.</Empty>
      ) : (
        <Empty icon={ShieldAlertIcon} title="Bots unavailable">{bots.error ?? "Waiting for the bots socket."}</Empty>
      )}
    </Window>
  );
}
