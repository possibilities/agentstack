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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { accountLabels, botsFor, shortId, workerAccountLabels } from "@/lib/stack/derive";
import type { Account, Bot, Login, WorkerAccount, WorkerLogin } from "@/lib/stack/types";
import { Orb, StatusDot } from "./primitives";
import { useOperation, useStack, useStore } from "./provider";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ActionError = { op: "availability" | "cancel" | "remove" | "signin"; target: string | null; message: string };
export type WorkerActionError = { op: "signin" | "submit" | "cancel" | "availability" | "remove"; target: string | null; message: string };

export type AuthActions = {
  /** Start a device sign-in (or replace an account's credentials); confirms first when one is pending. */
  startSignIn(targetAccount?: string | null): void;
  pendingSignIn: boolean;
  setEnabled(account: Account, enabled: boolean): void;
  changingAvailability: string | null;
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
  /** Worker account actions; pending and error state never mix with the Bot fields above. */
  worker: {
    /** Start an API-run sign-in for a new or existing Worker. A ready Worker confirms first; resolves to the attempt or null. */
    signIn(provider: WorkerAccount["provider"], id?: string): Promise<WorkerLogin | null>;
    /** `new:<provider>` or the Worker id whose sign-in call is in flight. */
    signingIn: string | null;
    /** Paste the code a pending native sign-in is waiting for. Resolves after the call. */
    submitCode(attempt: WorkerLogin, code: string): Promise<void>;
    submitting: string | null;
    cancel(attempt: WorkerLogin): void;
    cancelling: string | null;
    /** Drop a finished attempt card for the account. */
    dismiss(accountId: string): void;
    setEnabled(account: WorkerAccount, enabled: boolean): void;
    changingAvailability: string | null;
    confirmRemove(account: WorkerAccount): void;
    finishRemoval(account: WorkerAccount): void;
    removing: string | null;
    error: WorkerActionError | null;
  };
};

const AuthActionsContext = createContext<AuthActions | null>(null);

export function useAuthActions(): AuthActions {
  const value = use(AuthActionsContext);
  if (!value) throw new Error("useAuthActions requires AuthActionsProvider");
  return value;
}

export function AuthActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { accounts, workerAccounts, bots, attempt } = useStack();
  const start = useOperation<Login>("auth", "account_login_start");
  const replace = useOperation<Login>("auth", "account_login_replace");
  const enableOp = useOperation<Account>("auth", "account_set_enabled");
  const removeOp = useOperation<{ accounts: Account[] }>("auth", "account_remove");
  const cancelOp = useOperation<Login>("auth", "account_login_cancel");
  const workerLoginStartOp = useOperation<WorkerLogin>("auth", "worker_account_login_start");
  const workerLoginSubmitOp = useOperation<WorkerLogin>("auth", "worker_account_login_submit");
  const workerLoginCancelOp = useOperation<WorkerLogin>("auth", "worker_account_login_cancel");
  const workerEnableOp = useOperation<WorkerAccount>("auth", "worker_account_set_enabled");
  const workerRemoveOp = useOperation<{ id: string }>("auth", "worker_account_remove");
  const [removeTarget, setRemoveTarget] = useState<Account | null>(null);
  const [restart, setRestart] = useState<{ target: string | null } | null>(null);
  const [changingAvailability, setChangingAvailability] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [workerRemoveTarget, setWorkerRemoveTarget] = useState<WorkerAccount | null>(null);
  const [reprepare, setReprepare] = useState<{ provider: WorkerAccount["provider"]; id: string; resolve(attempt: WorkerLogin | null): void } | null>(null);
  const [workerSigningIn, setWorkerSigningIn] = useState<string | null>(null);
  const [workerSubmitting, setWorkerSubmitting] = useState<string | null>(null);
  const [workerCancelling, setWorkerCancelling] = useState<string | null>(null);
  const [workerChangingAvailability, setWorkerChangingAvailability] = useState<string | null>(null);
  const [workerRemoving, setWorkerRemoving] = useState<string | null>(null);
  const [workerError, setWorkerError] = useState<WorkerActionError | null>(null);

  const labels = accountLabels(accounts.data);
  const label = (id: string) => labels.get(id) ?? shortId(id);
  const workerLabels = workerAccountLabels(workerAccounts.data);
  const workerLabel = (id: string) => workerLabels.get(id) ?? shortId(id);

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

  const runWorkerSignIn = async (provider: WorkerAccount["provider"], id?: string): Promise<WorkerLogin | null> => {
    setWorkerError(null);
    setWorkerSigningIn(id ?? `new:${provider}`);
    try {
      return await workerLoginStartOp.run(id ? { provider, id } : { provider });
    } catch (cause) {
      const message = errorMessage(cause);
      setWorkerError({ op: "signin", target: id ?? `new:${provider}`, message });
      toast.error(message);
      return null;
    } finally {
      setWorkerSigningIn(null);
    }
  };

  const runWorkerRemove = async (account: WorkerAccount) => {
    setWorkerRemoving(account.id);
    try {
      await workerRemoveOp.run({ id: account.id });
      toast.success(`Removed ${workerLabel(account.id)}`);
      setWorkerRemoveTarget(null);
    } catch (cause) {
      if (workerRemoveTarget?.id !== account.id) {
        const message = errorMessage(cause);
        setWorkerError({ op: "remove", target: account.id, message });
        toast.error(message);
      }
    } finally {
      setWorkerRemoving(null);
    }
  };

  const runRemove = async (account: Account) => {
    setRemoving(account.id);
    try {
      await removeOp.run({ id: account.id });
      toast.success(`Removed ${label(account.id)}`);
      setRemoveTarget(null);
    } catch (cause) {
      // An open dialog shows removeOp.error inline; a card-level retry toasts and marks the card.
      if (removeTarget?.id !== account.id) {
        const message = errorMessage(cause);
        setError({ op: "remove", target: account.id, message });
        toast.error(message);
      }
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
    setEnabled: (account, enabled) => {
      setError(null);
      setChangingAvailability(account.id);
      void enableOp.run({ id: account.id, enabled }).then(
        () => toast.success(`${label(account.id)} ${enabled ? "enabled" : "disabled"}`),
        (cause) => {
          const message = errorMessage(cause);
          setError({ op: "availability", target: account.id, message });
          toast.error(message);
        },
      ).finally(() => setChangingAvailability(null));
    },
    changingAvailability,
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
    worker: {
      signIn: (provider, id) => {
        const existing = id ? workerAccounts.data?.find((account) => account.id === id) : undefined;
        if (existing?.ready) return new Promise<WorkerLogin | null>((resolve) => setReprepare({ provider, id: existing.id, resolve }));
        return runWorkerSignIn(provider, id);
      },
      signingIn: workerSigningIn,
      submitCode: (attempt, code) => {
        setWorkerError(null);
        setWorkerSubmitting(attempt.id);
        return workerLoginSubmitOp.run({ id: attempt.id, code }).then(() => undefined, (cause) => {
          const message = errorMessage(cause);
          setWorkerError({ op: "submit", target: attempt.account, message });
          toast.error(message);
          throw cause;
        }).finally(() => setWorkerSubmitting(null));
      },
      submitting: workerSubmitting,
      cancel: (attempt) => {
        setWorkerError(null);
        setWorkerCancelling(attempt.id);
        void workerLoginCancelOp.run({ id: attempt.id }).then(undefined, (cause) => {
          const message = errorMessage(cause);
          setWorkerError({ op: "cancel", target: attempt.account, message });
          toast.error(message);
        }).finally(() => setWorkerCancelling(null));
      },
      cancelling: workerCancelling,
      dismiss: store.dismissWorkerAttempt,
      setEnabled: (account, enabled) => {
        setWorkerError(null);
        setWorkerChangingAvailability(account.id);
        void workerEnableOp.run({ id: account.id, enabled }).then(
          () => toast.success(`${workerLabel(account.id)} ${enabled ? "enabled" : "disabled"}`),
          (cause) => {
            const message = errorMessage(cause);
            setWorkerError({ op: "availability", target: account.id, message });
            toast.error(message);
          },
        ).finally(() => setWorkerChangingAvailability(null));
      },
      changingAvailability: workerChangingAvailability,
      confirmRemove: setWorkerRemoveTarget,
      finishRemoval: (account) => void runWorkerRemove(account),
      removing: workerRemoving,
      error: workerError,
    },
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
      <AlertDialog open={reprepare !== null} onOpenChange={(open) => { if (!open) { reprepare?.resolve(null); setReprepare(null); } }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia>{reprepare ? <Orb id={reprepare.id} /> : null}</AlertDialogMedia>
            <AlertDialogTitle>Sign in again to {reprepare ? workerLabel(reprepare.id) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>Its runtime stops until you finish.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={() => {
                const pending = reprepare;
                setReprepare(null);
                if (pending) void runWorkerSignIn(pending.provider, pending.id).then(pending.resolve);
              }}
            >
              Sign in again
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {removeTarget ? (
        <RemoveAccountDialog
          key={removeTarget.id}
          account={removeTarget}
          label={label(removeTarget.id)}
          used={botsFor(removeTarget.id, bots.data)}
          linkedWorkers={(removeTarget.linkedAccounts ?? []).filter((link) => link.scope === "worker" && workerLabels.has(link.id)).map((link) => workerLabels.get(link.id)!)}
          pending={removeOp.pending}
          error={removeOp.error}
          onConfirm={() => void runRemove(removeTarget)}
          onClose={() => setRemoveTarget(null)}
        />
      ) : null}
      {workerRemoveTarget ? (
        <RemoveWorkerDialog
          key={workerRemoveTarget.id}
          account={workerRemoveTarget}
          label={workerLabel(workerRemoveTarget.id)}
          pending={workerRemoveOp.pending}
          error={workerRemoveOp.error}
          onConfirm={() => void runWorkerRemove(workerRemoveTarget)}
          onClose={() => setWorkerRemoveTarget(null)}
        />
      ) : null}
      <Toaster position="bottom-left" />
    </AuthActionsContext>
  );
}

function RemoveAccountDialog({ account, label, used, linkedWorkers, pending, error, onConfirm, onClose }: {
  account: Account;
  label: string;
  used: Bot[];
  linkedWorkers: string[];
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
          {used.length ? (
            <div className="flex flex-col gap-1.5 rounded-lg border bg-background/50 p-2.5">
              <span className="text-[0.72rem] font-medium text-muted-foreground">
                {used.length} {used.length === 1 ? "bot" : "bots"} will be stopped and deleted
              </span>
              <ul className="flex flex-col gap-1">
                {used.map((bot) => (
                  <li key={bot.id} className="flex items-center gap-2 font-mono text-[0.78rem]">
                    <StatusDot tone={bot.state === "running" ? "success" : "muted"} />
                    {bot.id}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {linkedWorkers.length ? (
            <p className="text-[0.78rem] text-muted-foreground">{linkedWorkers.join(", ")} stay signed in.</p>
          ) : null}
          <p className="flex items-start gap-1.5 text-[0.78rem] text-muted-foreground">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
            <span>Deletes its credentials. Can&rsquo;t be undone.</span>
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

function RemoveWorkerDialog({ account, label, pending, error, onConfirm, onClose }: {
  account: WorkerAccount;
  label: string;
  pending: boolean;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia><Orb id={account.id} /></AlertDialogMedia>
          <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
          <AlertDialogDescription className="font-mono text-[0.72rem] break-all">{account.id}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-[0.8rem]">
          <p className="flex items-start gap-1.5 text-[0.78rem] text-muted-foreground">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
            <span>Stops its runtime and deletes its credentials.</span>
          </p>
          {error ? <p className="text-[0.75rem] text-pretty text-destructive">{error}</p> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Removing…" : "Remove account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
