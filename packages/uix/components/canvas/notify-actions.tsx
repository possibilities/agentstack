"use client";

import { createContext, use, useCallback, useMemo, useState } from "react";
import { BellOffIcon } from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import type { Notification, NotificationOutcome } from "@/lib/stack/types";
import { errorMessage } from "./auth-actions";
import { useStack, useStore } from "./provider";

type Dismissal = Exclude<NotificationOutcome, "replaced">;

type NotifyActions = {
  /** The notification the Notification window shows. Choosing one never dismisses it. */
  selected: string | null;
  open(id: string | null): void;
  /** IDs with a dismissal in flight. */
  pending: ReadonlySet<string>;
  /** Dismiss once with an outcome; resolves false when the API refused or the connection failed. */
  dismiss(record: Notification, outcome: Dismissal, response?: string): Promise<boolean>;
  confirmDismissAll(): void;
};

const NotifyActionsContext = createContext<NotifyActions | null>(null);

export function useNotifyActions(): NotifyActions {
  const value = use(NotifyActionsContext);
  if (!value) throw new Error("useNotifyActions requires NotifyActionsProvider");
  return value;
}

export function NotifyActionsProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { notifyCounts } = useStack();
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [dismissingAll, setDismissingAll] = useState(false);

  const dismiss = useCallback(async (record: Notification, outcome: Dismissal, response?: string) => {
    setPending((current) => new Set(current).add(record.id));
    try {
      await store.notify("notification_dismiss", { id: record.id, outcome, ...(response === undefined ? {} : { response }) });
      return true;
    } catch (error) {
      const message = errorMessage(error);
      toast.error(/notification_already_dismissed/.test(message) ? "Already dismissed another way" : message);
      return false;
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(record.id); return next; });
    }
  }, [store]);

  const dismissAll = useCallback(async () => {
    setDismissingAll(true);
    try {
      const { dismissed } = await store.notify<{ dismissed: number }>("notification_dismiss_all", {});
      toast.success(dismissed === 1 ? "Dismissed 1 notification" : `Dismissed ${dismissed} notifications`);
      setConfirming(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDismissingAll(false);
    }
  }, [store]);

  const value = useMemo<NotifyActions>(() => ({ selected, open: setSelected, pending, dismiss, confirmDismissAll: () => setConfirming(true) }), [selected, pending, dismiss]);
  const open = notifyCounts.data?.open ?? 0;
  return (
    <NotifyActionsContext value={value}>
      {children}
      <AlertDialog open={confirming} onOpenChange={(next) => { if (!dismissingAll) setConfirming(next); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia><BellOffIcon /></AlertDialogMedia>
            <AlertDialogTitle>{open === 1 ? "Dismiss 1 open notification?" : `Dismiss all ${open} open notifications?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Every open notification is dismissed as closed, not only the ones this view shows. Unanswered questions stay unanswered, and history is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dismissingAll}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={dismissingAll} onClick={() => void dismissAll()}>
              {dismissingAll ? <Spinner data-icon="inline-start" /> : null}
              Dismiss all
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </NotifyActionsContext>
  );
}
