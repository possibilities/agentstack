"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangleIcon, BanIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CirclePauseIcon, CircleSlashIcon, ClockIcon, EyeIcon, ExternalLinkIcon, HandIcon, ListTreeIcon, RefreshCwIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { actorLabel, chatIdentity, hudFailure, referenceView, stateView, type HudFailure } from "@/lib/stack/hud";
import { shortId } from "@/lib/stack/derive";
import type { WorkActor, WorkContext, WorkItem, WorkReceipt, WorkReference, WorkState } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { CopyButton, NodeLink } from "./primitives";
import { useChatWindows, useStack, useStore, useWorkbench } from "./provider";

const stateIcon: Record<WorkState, React.ComponentType<{ className?: string }>> = {
  planned: CircleDashedIcon, active: CircleDotIcon, blocked: CircleSlashIcon, waiting: ClockIcon,
  paused: CirclePauseIcon, review: EyeIcon, completed: CircleCheckIcon, cancelled: BanIcon,
};
const stateTone: Record<WorkState, string> = {
  planned: "text-muted-foreground", active: "text-foreground", blocked: "text-destructive", waiting: "text-warning",
  paused: "text-muted-foreground", review: "text-warning", completed: "text-success", cancelled: "text-muted-foreground/70",
};

/**
 * Semantic state as a shape and a word, never color alone. Resource activity uses
 * separate dot marks, so a running Worker is never mistaken for active work.
 */
export function StateMark({ state, word = false, className }: { state: WorkState; word?: boolean; className?: string }) {
  const Icon = stateIcon[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-[0.7rem]", stateTone[state], className)} title={stateView[state].word}>
      <Icon aria-hidden className="size-3.5" />
      {word ? <span>{stateView[state].word}</span> : <span className="sr-only">{stateView[state].word}</span>}
    </span>
  );
}

export function AttentionChip({ attention, className }: { attention: WorkItem["attention"]; className?: string }) {
  if (attention === "none") return null;
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.64rem] font-medium",
      attention === "human" ? "bg-warning/15 text-warning" : "bg-pkg-hud/12 text-pkg-hud", className)}
      title={attention === "human" ? "Marked for a human to look at. Not a notification or an approval request." : "Marked for an agent to pick up."}>
      <HandIcon aria-hidden className="size-3" />{attention === "human" ? "Human" : "Agent"}
    </span>
  );
}

export function PriorityMark({ priority, className }: { priority: WorkItem["priority"]; className?: string }) {
  if (priority === "normal") return null;
  return (
    <span className={cn("shrink-0 font-mono text-[0.62rem] tracking-wide uppercase",
      priority === "urgent" ? "text-destructive" : priority === "high" ? "text-warning" : "text-muted-foreground/70", className)}>
      {priority === "urgent" ? "!!" : priority === "high" ? "!" : "low"}
      <span className="sr-only"> priority {priority}</span>
    </span>
  );
}

export function ActorName({ actor }: { actor: WorkActor | null | undefined }) {
  if (actor?.kind === "bot") return <NodeLink node={{ kind: "bot", id: actor.botId }} label={`Bot ${actor.botId}`} className="font-mono">{actor.botId}</NodeLink>;
  return <span>{actorLabel(actor)}</span>;
}

/**
 * A typed reference, resolved to its owner's card where the UI has one. A Chat opens the
 * Bot's Fleet chat only while the Bot still has the same root; a retained link to a
 * replaced or removed identity stays visible and inspectable as text.
 */
export function ReferenceLink({ reference, titles, className }: { reference: WorkReference; titles?: Map<string, string>; className?: string }) {
  const { bots } = useStack();
  const { chats } = useChatWindows();
  const { goTo } = useWorkbench();
  const view = referenceView(reference, titles);
  const chip = cn("inline-flex min-w-0 items-center gap-1 truncate", className);
  if (reference.kind === "chat" || reference.kind === "bot") {
    const identity = chatIdentity(reference, bots.data);
    if (identity !== "current") {
      return (
        <span className={chip} title={identity === "missing" ? "This Bot no longer exists" : identity === "replaced" ? "This Bot has a different root thread now" : undefined}>
          <span className="truncate font-mono">{view.label}</span>
          {identity === "missing" ? <span className="text-muted-foreground">· removed</span> : identity === "replaced" ? <span className="text-warning">· earlier root</span> : null}
        </span>
      );
    }
    if (reference.kind === "chat") {
      return (
        <button type="button" className={cn(chip, "rounded-sm decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring")}
          title={reference.threadId === reference.mainThreadId ? "Open this Bot's chat in Fleet" : "Open this Bot's chat in Fleet; the named thread is a descendant of its main thread"}
          onClick={(event) => goTo({ kind: "chat", id: event.metaKey || event.ctrlKey || event.shiftKey ? chats.open(reference.botId) : chats.show(reference.botId) })}>
          <SquareTerminalIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate font-mono">{view.label}</span>
          {view.detail ? <span className="text-muted-foreground">· {view.detail}</span> : null}
        </button>
      );
    }
  }
  if (view.external) {
    return (
      <a href={view.external} target="_blank" rel="noreferrer noopener" className={cn(chip, "rounded-sm decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring")}>
        <span className="truncate">{view.label}</span><ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
      </a>
    );
  }
  if (view.node) {
    return (
      <span className={chip}>
        <NodeLink node={view.node} label={view.label} className="truncate">{view.label}</NodeLink>
        {view.detail ? <span className="shrink-0 text-muted-foreground">· {view.detail}</span> : null}
      </span>
    );
  }
  // A locator the UI can't resolve is a declaration, not a claim it exists: keep it copyable.
  const exact = reference.kind === "resource" ? JSON.stringify(reference) : view.label;
  return (
    <span className={cn(chip, "group/row")}>
      <span className="truncate font-mono text-[0.72rem]" title={exact}>{view.label}</span>
      {view.detail ? <span className="shrink-0 text-muted-foreground">· {view.detail}</span> : null}
      <CopyButton value={exact} label="reference" />
    </span>
  );
}

const contextSource: Record<WorkContext["source"], string> = { explicit: "dispatched for it", focus: "from Chat focus", continuation: "continued" };

/**
 * A Worker turn's captured Work context, linked to its HUD item. It is association
 * evidence for that turn at its captured scope, not a claim the work is current or done.
 */
export function WorkContextLink({ context, className }: { context: WorkContext; className?: string }) {
  const { hudTree } = useStack();
  const item = hudTree.data?.rows.find((row) => row.item.id === context.workItemId)?.item;
  const label = item?.title ?? `Work ${shortId(context.workItemId)}`;
  const later = item && item.scopeRevision > context.scopeRevision;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}
      title={`Captured at scope ${context.scopeRevision}, ${contextSource[context.source]}${later ? `; the item is now at scope ${item.scopeRevision}` : ""}`}>
      {item ? <StateMark state={item.state} /> : null}
      <NodeLink node={{ kind: "work-item", id: context.workItemId }} label={label} className="min-w-0 truncate">{label}</NodeLink>
      <span className="shrink-0 text-muted-foreground">· {contextSource[context.source]}</span>
      {later ? <span className="shrink-0 text-warning">· earlier scope</span> : null}
    </span>
  );
}

export function HudPlaceholder({ title, hint, icon: Icon = ListTreeIcon }: { title: string; hint?: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
      <Icon className="size-5 text-muted-foreground/70" />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-72 text-[0.72rem] text-pretty text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Why HUD writes can't run here, or null when they can. */
export function hudReadOnly(remote: { scope: "view" | "control" } | undefined, endpoint: string | undefined): string | null {
  if (!endpoint) return "HUD isn't served by this server";
  if (remote?.scope === "view") return "This remote session can view work but not change it";
  return null;
}

type Held = { requestId: string; name: string; args: Record<string, unknown> };
export type HudRequest = {
  running: boolean;
  failure: HudFailure | null;
  /** An uncertain or unsent request is held for an exact retry; new submissions wait until it is resolved. */
  held: boolean;
  submit(name: string, args: Record<string, unknown>): Promise<WorkReceipt | null>;
  retry(): Promise<WorkReceipt | null>;
  clear(): void;
};

/**
 * One form's HUD write. Each new intent gets a new requestId. When the outcome is
 * unknown, the exact requestId and input are held, and only an explicit retry resends
 * them; a new submission never replaces an uncertain one with a new ID.
 */
export function useHudRequest(onApplied?: (receipt: WorkReceipt) => void): HudRequest {
  const store = useStore();
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<HudFailure | null>(null);
  const held = useRef<Held | null>(null);
  const applied = useRef(onApplied);
  applied.current = onApplied;
  const send = useCallback(async (request: Held): Promise<WorkReceipt | null> => {
    setRunning(true);
    setFailure(null);
    try {
      const receipt = await store.hud<WorkReceipt>(request.name, { ...request.args, requestId: request.requestId });
      held.current = null;
      applied.current?.(receipt);
      return receipt;
    } catch (error) {
      const next = hudFailure(error);
      held.current = next.kind === "uncertain" || next.kind === "unsent" ? request : null;
      setFailure(next);
      return null;
    } finally {
      setRunning(false);
    }
  }, [store]);
  return {
    running, failure, held: held.current !== null,
    submit: (name, args) => held.current ? Promise.resolve(null) : send({ requestId: crypto.randomUUID(), name, args }),
    retry: () => held.current ? send(held.current) : Promise.resolve(null),
    clear: () => { held.current = null; setFailure(null); },
  };
}

/** A request's failure, with the one safe next step for an unknown outcome: the same request again. */
export function RequestNotice({ request, conflict }: { request: HudRequest; conflict?: React.ReactNode }) {
  const { failure } = request;
  if (!failure) return null;
  if (failure.kind === "conflict" && conflict) return <>{conflict}</>;
  const uncertain = failure.kind === "uncertain" || failure.kind === "unsent";
  return (
    <div role="alert" className={cn("flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-[0.72rem] text-pretty", uncertain ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive")}>
      <p className="flex items-start gap-1.5"><AlertTriangleIcon aria-hidden className="mt-px size-3.5 shrink-0" />{failure.text}</p>
      <div className="flex flex-wrap gap-1.5">
        {uncertain ? (
          <Button size="xs" variant="outline" disabled={request.running} onClick={() => void request.retry()}>
            {request.running ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}Retry the same request
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" disabled={request.running} onClick={request.clear}
          title={uncertain ? "Stop tracking this request. Check the current state first: it may have applied." : undefined}>
          <XIcon data-icon="inline-start" />{uncertain ? "Forget it" : "Dismiss"}
        </Button>
      </div>
    </div>
  );
}

/** A small inline dot for resource activity, deliberately distinct from semantic state marks. */
export function ActivityDot({ tone, label }: { tone: "success" | "warning" | "destructive" | "muted" | "info"; label: string }) {
  const color = { success: "bg-success", warning: "bg-warning", destructive: "bg-destructive", muted: "bg-muted-foreground/40", info: "bg-pkg-codex" }[tone];
  return <span role="img" aria-label={label} title={label} className={cn("inline-block size-1.5 shrink-0 rounded-full", color)} />;
}

