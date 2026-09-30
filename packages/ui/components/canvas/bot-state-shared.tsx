"use client";

import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { botStateKey, botStateOperations, type BotStateAction } from "@/lib/stack/bot-state";
import type { StateReceipt } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { StateFlowView, useStateFlow, type StateFlowControls } from "./state-flow";
import { useStack, useStore } from "./provider";

/** What every Bot state view is given: the exact Bot, its incarnation and the invalidation generation to re-read on. */
export type BotScope = { botId: string; incarnation: string; generation: string; observe: number; unavailable: string | null };

export const hintClass = "text-[0.72rem] text-pretty text-muted-foreground";
export const labelClass = "text-[0.68rem] font-medium tracking-[0.06em] text-muted-foreground uppercase";

export { useKeyedRead as useBotRead, usePagedRead as useBotPages } from "./owner-reads";

/** The shared plan/receipt flow for one exact Bot action. The recovery slot is per incarnation and decision. */
export function useBotAction(scope: BotScope, action: BotStateAction, onReceipt?: (receipt: StateReceipt) => void): StateFlowControls {
  const store = useStore();
  return useStateFlow<{ botId: string }>({ operations: botStateOperations(store.call, scope.botId, action), extra: { botId: scope.botId },
    recoveryKey: botStateKey(scope.incarnation, action), observe: scope.observe, onReceipt });
}

export function BotAction({ scope, action, label, applyLabel, unavailable, children }: {
  scope: BotScope; action: BotStateAction; label: string; applyLabel?: string; unavailable?: string | null; children?: React.ReactNode;
}) {
  const controls = useBotAction(scope, action);
  return (
    <div className="flex flex-col gap-1.5">
      {children}
      <StateFlowView controls={controls} label={label} applyLabel={applyLabel} unavailable={unavailable ?? scope.unavailable} />
    </div>
  );
}

export function ViewHeader({ title, loading, onRefresh, children }: { title: string; loading?: boolean; onRefresh?(): void; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={labelClass}>{title}</span>
      {children}
      {onRefresh ? (
        <Button size="icon-xs" variant="ghost" className="ml-auto text-muted-foreground" aria-label={`Refresh ${title.toLowerCase()}`} disabled={loading} onClick={onRefresh}>
          {loading ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      ) : null}
    </div>
  );
}

/** A read failure is unavailable, never empty. */
export function ReadError({ error, what }: { error: string | null; what: string }) {
  return error ? <p role="status" className="text-xs text-destructive">{what} unavailable: {error}</p> : null;
}

export function MoreButton({ nextOffset, loading, onMore, restarted }: { nextOffset: number | null; loading: boolean; onMore(): void; restarted: boolean }) {
  return (
    <>
      {restarted ? <p role="status" className="text-xs text-warning">This listing changed while paging, so it started again from the first page.</p> : null}
      {nextOffset !== null ? <Button size="xs" variant="ghost" className="self-start text-muted-foreground" disabled={loading} onClick={onMore}>Load more (from {nextOffset})</Button> : null}
    </>
  );
}

export function Pill({ children, tone = "muted", title }: { children: React.ReactNode; tone?: "muted" | "warning" | "destructive" | "bots"; title?: string }) {
  return (
    <span title={title} className={cn("shrink-0 rounded px-1 text-[0.64rem] font-medium",
      tone === "muted" && "bg-muted text-muted-foreground", tone === "warning" && "bg-warning/15 text-warning",
      tone === "destructive" && "bg-destructive/10 text-destructive", tone === "bots" && "bg-pkg-bots/10 text-pkg-bots")}>{children}</span>
  );
}

/** Whether Bot state reads and controls can be used from this page. */
export function useBotStateAccess(): string | null {
  const { remote, status } = useStack();
  if (remote) return "Bot state is available only on the local UI.";
  if (status.bots !== "open") return "The bots connection is not open.";
  return null;
}
