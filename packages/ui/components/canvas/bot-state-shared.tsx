"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { botStateKey, botStateOperations, firstPage, nextPage, type BotStateAction, type Page, type PageRead } from "@/lib/stack/bot-state";
import type { StateReceipt } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { StateFlowView, useStateFlow, type StateFlowControls } from "./state-flow";
import { useStack, useStore } from "./provider";

/** What every Bot state view is given: the exact Bot, its incarnation and the invalidation generation to re-read on. */
export type BotScope = { botId: string; incarnation: string; generation: string; observe: number; unavailable: string | null };

export const hintClass = "text-[0.72rem] text-pretty text-muted-foreground";
export const labelClass = "text-[0.68rem] font-medium tracking-[0.06em] text-muted-foreground uppercase";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One read, re-run when its key or invalidation changes. An older answer never replaces a newer one. */
export function useBotRead<T>(read: () => Promise<T>, key: string, observe: number): { data: T | null; error: string | null; loading: boolean; refresh(): void } {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key, data: null, error: null });
  const [loading, setLoading] = useState(false);
  const token = useRef(0);
  const latest = useRef(read);
  latest.current = read;
  const run = useCallback(() => {
    const mine = ++token.current;
    setLoading(true);
    latest.current().then((data) => { if (mine === token.current) setState({ key, data, error: null }); },
      (error: unknown) => { if (mine === token.current) setState((held) => ({ key, data: held.key === key ? held.data : null, error: message(error) })); })
      .finally(() => { if (mine === token.current) setLoading(false); });
  }, [key]);
  useEffect(() => { run(); return () => { token.current++; }; }, [run, observe]);
  // Data read for another key is never shown, even for the render before the new read starts.
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, loading, refresh: run };
}

/** Bounded pages of one observation; continuing after the owner changed it starts again from the first page. */
export function useBotPages<T>(read: PageRead<T>, key: string, observe: number) {
  const [state, setState] = useState<{ key: string; page: Page<T> | null; error: string | null }>({ key, page: null, error: null });
  const [loading, setLoading] = useState(false);
  const token = useRef(0);
  const latest = useRef(read);
  latest.current = read;
  const load = useCallback((more: Page<T> | null) => {
    const mine = ++token.current;
    setLoading(true);
    (more ? nextPage(latest.current, more) : firstPage(latest.current)).then((page) => { if (mine === token.current) setState({ key, page, error: null }); },
      (error: unknown) => { if (mine === token.current) setState((held) => ({ key, page: held.key === key ? held.page : null, error: message(error) })); })
      .finally(() => { if (mine === token.current) setLoading(false); });
  }, [key]);
  useEffect(() => { load(null); return () => { token.current++; }; }, [load, observe]);
  const page = state.key === key ? state.page : null;
  return { page, error: state.key === key ? state.error : null, loading, refresh: () => load(null), more: () => { if (page) load(page); } };
}

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
