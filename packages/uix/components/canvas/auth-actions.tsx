"use client";

import { createContext, use, useState } from "react";
import { TriangleAlertIcon, UserRoundPlusIcon } from "lucide-react";
import { toast } from "sonner";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { accountLabels, serversFor, shortId } from "@/lib/stack/derive";
import type { Account, Login, Server } from "@/lib/stack/types";
import { Orb, StatusDot } from "./primitives";
import { useOperation, useStack, useStore } from "./provider";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ActionError = { op: "activate" | "cancel" | "signin"; target: string | null; message: string };

export type AuthActions = {
  /** Start a device sign-in (or replace an account's credentials); confirms first when one is pending. */
  startSignIn(targetAccount?: string | null): void;
  pendingSignIn: boolean;
  activate(account: Account): void;
  activating: string | null;
  /** Open the shared destructive remove confirmation for an account. */
  confirmRemove(account: Account): void;
  /** Retry `account_remove` directly, for accounts already marked removing. */
  finishRemoval(account: Account): void;
  /** Account id whose remove call is in flight, if any. */
  removing: string | null;
  cancelLogin(id: string): void;
  cancelPending: boolean;
  dismissAttempt(): void;
  /** Last failed action, so the originating control can show it inline too. */
  error: ActionError | null;
};

const AuthActionsContext = createContext<AuthActions | null>(null);

export function useAuthActions(): AuthActions {
  const value = use(AuthActionsContext);
  if (!value) throw new Error("useAuthActions requires AuthActionsProvider");
  return value;
}

function usedServers(accountId: string, servers: Server[] | null, bots: Server[] | null): Server[] {
  const bound = serversFor(accountId, servers);
  const seen = new Set(bound.map((server) => server.id));
  return [...bound, ...serversFor(accountId, bots).filter((bot) => !seen.has(bot.id))];
}

export function AuthActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { accounts, servers, bots, attempt } = useStack();
  const start = useOperation<Login>("auth", "account_login_start");
  const replace = useOperation<Login>("auth", "account_login_replace");
  const activateOp = useOperation<Account>("auth", "account_activate");
  const removeOp = useOperation<{ accounts: Account[] }>("auth", "account_remove");
  const cancelOp = useOperation<Login>("auth", "account_login_cancel");
  const [removeTarget, setRemoveTarget] = useState<Account | null>(null);
  const [restart, setRestart] = useState<{ target: string | null } | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);

  const labels = accountLabels(accounts.data);
  const label = (id: string) => labels.get(id) ?? shortId(id);

  const launch = async (target: string | null) => {
    setError(null);
    try {
      if (target) await replace.run({ id: target });
      else await start.run({});
    } catch (cause) {
      const message = errorMessage(cause);
      setError({ op: "signin", target, message });
      toast.error(message);
    }
  };

  const runRemove = async (account: Account) => {
    setRemoving(account.id);
    try {
      await removeOp.run({ id: account.id });
      toast.success(`Removed ${label(account.id)}`);
      setRemoveTarget(null);
    } catch {
      // The dialog stays open and shows removeOp.error; a retry finishes removal.
    } finally {
      setRemoving(null);
    }
  };

  const value: AuthActions = {
    startSignIn: (targetAccount = null) => {
      if (attempt?.status === "pending") setRestart({ target: targetAccount });
      else void launch(targetAccount);
    },
    pendingSignIn: start.pending || replace.pending,
    activate: (account) => {
      setError(null);
      setActivating(account.id);
      void activateOp.run({ id: account.id }).then(
        () => toast.success(`${label(account.id)} is now active`),
        (cause) => {
          const message = errorMessage(cause);
          setError({ op: "activate", target: account.id, message });
          toast.error(message);
        },
      ).finally(() => setActivating(null));
    },
    activating,
    confirmRemove: setRemoveTarget,
    finishRemoval: (account) => void runRemove(account),
    removing,
    cancelLogin: (id) => {
      setError(null);
      void cancelOp.run({ id }).catch((cause) => {
        const message = errorMessage(cause);
        setError({ op: "cancel", target: id, message });
        toast.error(message);
      });
    },
    cancelPending: cancelOp.pending,
    dismissAttempt: store.dismissAttempt,
    error,
  };

  return (
    <AuthActionsContext value={value}>
      {children}
      <AlertDialog open={restart !== null} onOpenChange={(open) => { if (!open) setRestart(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><UserRoundPlusIcon /></AlertDialogMedia>
            <AlertDialogTitle>Restart sign-in?</AlertDialogTitle>
            <AlertDialogDescription>The code in progress stops working.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current code</AlertDialogCancel>
            <Button
              onClick={() => {
                const target = restart?.target ?? null;
                setRestart(null);
                void launch(target);
              }}
            >
              Start new sign-in
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {removeTarget ? (
        <RemoveAccountDialog
          key={removeTarget.id}
          account={removeTarget}
          label={label(removeTarget.id)}
          used={usedServers(removeTarget.id, servers.data, bots.data)}
          botIds={new Set(bots.data?.map((bot) => bot.id))}
          pending={removeOp.pending}
          error={removeOp.error}
          onConfirm={() => void runRemove(removeTarget)}
          onClose={() => setRemoveTarget(null)}
        />
      ) : null}
      <Toaster position="bottom-left" />
    </AuthActionsContext>
  );
}

function RemoveAccountDialog({ account, label, used, botIds, pending, error, onConfirm, onClose }: {
  account: Account;
  label: string;
  used: Server[];
  botIds: Set<string>;
  pending: boolean;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}) {
  const [typed, setTyped] = useState("");
  const needsTyping = used.length > 0;
  const confirmed = !needsTyping || typed.trim() === label;
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia><Orb id={account.id} /></AlertDialogMedia>
          <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
          <AlertDialogDescription className="font-mono text-[0.72rem] break-all">{account.id}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-[0.8rem]">
          {account.active ? (
            <p className="rounded-lg bg-warning/10 px-2.5 py-2 text-[0.75rem] text-pretty text-warning">This is the active account. The next remaining account becomes active.</p>
          ) : null}
          {used.length ? (
            <div className="flex flex-col gap-1.5 rounded-lg border bg-background/50 p-2.5">
              <span className="text-[0.72rem] font-medium text-muted-foreground">
                {used.length} {used.length === 1 ? "Server" : "Servers"} will be stopped and deleted
              </span>
              <ul className="flex flex-col gap-1">
                {used.map((server) => (
                  <li key={server.id} className="flex items-center gap-2 font-mono text-[0.78rem]">
                    <StatusDot tone={server.state === "running" ? "success" : "muted"} />
                    {server.id}
                    {botIds.has(server.id) ? <Badge variant="outline" className="h-4 px-1.5 text-[0.62rem]">bot</Badge> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="flex items-start gap-1.5 text-[0.78rem] text-muted-foreground">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
            <span>Credentials are deleted. This can&rsquo;t be undone.</span>
          </p>
          {needsTyping ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.72rem] text-muted-foreground">
                Type <span className="font-mono font-medium text-foreground">{label}</span> to confirm
              </span>
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={label} autoFocus disabled={pending} />
            </label>
          ) : null}
          {error ? <p className="text-[0.75rem] text-pretty text-destructive">{error}</p> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!confirmed || pending} onClick={onConfirm}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Removing…" : "Remove account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
