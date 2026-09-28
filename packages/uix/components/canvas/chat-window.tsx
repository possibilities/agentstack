"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronsUpDownIcon, CopyPlusIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { primaryChat } from "@/lib/stack/chat-windows";
import { shortId } from "@/lib/stack/derive";
import { holdMainChat, type MainChatFeed, type MainChatView } from "@/lib/stack/main-chat";
import { markdownBlocks } from "@/lib/stack/markdown-blocks";
import type { ChatActivity, ChatEntry, ChatTurnEnd } from "@/lib/stack/transcript";
import { cn } from "@/lib/utils";
import { StatusDot } from "./primitives";
import { useChatWindows, useNow, useStack, useStore, useWorkbench } from "./provider";
import { Window } from "./window";

/** One shared feed per Bot while any window shows it. */
function useMainChat(botId: string | null): { view: MainChatView | null; loadOlder(): void } {
  const store = useStore();
  const [held, setHeld] = useState<{ botId: string; feed: MainChatFeed } | null>(null);
  useEffect(() => {
    if (!botId) return;
    const hold = holdMainChat(store, botId);
    setHeld({ botId, feed: hold.feed });
    return () => hold.release();
  }, [store, botId]);
  const feed = botId && held?.botId === botId ? held.feed : null;
  const subscribe = useCallback((listener: () => void) => feed ? feed.subscribe(listener) : () => {}, [feed]);
  const read = useCallback(() => feed ? feed.getView() : null, [feed]);
  const view = useSyncExternalStore(subscribe, read, () => null);
  const loadOlder = useCallback(() => feed?.loadOlder(), [feed]);
  return { view, loadOlder };
}

export function ChatWindow({ id }: { id: string }) {
  const { windows, chats } = useChatWindows();
  const { bots } = useStack();
  const { goTo } = useWorkbench();
  const botId = windows.find((chat) => chat.id === id)?.botId ?? null;
  const bot = bots.data?.find((item) => item.id === botId);
  const { view, loadOlder } = useMainChat(botId);
  const threadId = view?.threadId ?? bot?.mainThreadId ?? null;
  const primary = id === primaryChat;
  const actions = (
    <>
      <BotSwitcher windowId={id} botId={botId} />
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New chat window" className="text-muted-foreground"
          onClick={() => goTo({ kind: "chat", id: chats.open(botId) })} />}>
          <CopyPlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">New chat window</TooltipContent>
      </Tooltip>
      {primary ? null : (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Close chat window" className="text-muted-foreground" onClick={() => chats.close(id)} />}>
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="bottom">Close</TooltipContent>
        </Tooltip>
      )}
    </>
  );
  return (
    <Window id={id} title={botId ?? "Chat"} subtitle={botId ? threadId ? `main thread ${shortId(threadId)}` : "no main thread" : "main thread"}
      icon={SquareTerminalIcon} accent="bots" reveal={{ kind: "chat", id }} bleed actions={actions}>
      {botId ? <Transcript key={botId} botId={botId} view={view} loadOlder={loadOlder} /> : <Placeholder title="No bot selected" hint="Choose one with the switcher, or press Chat on a bot card." />}
      <StatusLine botId={botId} view={view} />
    </Window>
  );
}

function BotSwitcher({ windowId, botId }: { windowId: string; botId: string | null }) {
  const { bots } = useStack();
  const { chats } = useChatWindows();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Switch bot" className="text-muted-foreground" />} />}>
          <ChevronsUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Switch bot</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Main thread of</DropdownMenuLabel>
          {bots.data?.length ? (
            <DropdownMenuRadioGroup value={botId ?? ""} onValueChange={(value) => chats.setBot(windowId, value || null)}>
              {bots.data.map((bot) => (
                <DropdownMenuRadioItem key={bot.id} value={bot.id} closeOnClick className="font-mono">
                  <StatusDot tone={bot.recoveryIssue ? "warning" : bot.state === "running" ? "success" : "muted"} />
                  {bot.id}
                  <span className="ml-auto pl-3 text-[0.7rem] text-muted-foreground">{bot.mainThreadId ? shortId(bot.mainThreadId) : "no thread"}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          ) : <p className="px-2 py-1.5 text-xs text-muted-foreground">No bots</p>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Placeholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center font-mono text-xs">
      <p className="text-foreground/80">{title}</p>
      {hint ? <p className="text-pretty text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Pixels from the end that still count as reading the latest output. */
const endSlack = 4;

function Transcript({ botId, view, loadOlder }: { botId: string; view: MainChatView | null; loadOlder(): void }) {
  if (!view || (view.status === "loading" && !view.entries.length)) return <Placeholder title="Reading main thread…" />;
  if (view.entries.length) return <Scrollback view={view} loadOlder={loadOlder} />;
  switch (view.status) {
    case "missing": return <Placeholder title={`${botId} no longer exists`} />;
    case "stopped": return <Placeholder title={`${botId} is stopped`} hint="Start it to read its main thread." />;
    case "no-thread": return <Placeholder title="No main thread yet" hint={`${botId}'s main thread begins with its first turn.`} />;
    case "error": return <Placeholder title="Could not read the main thread" hint={view.error ?? undefined} />;
    default: return <Placeholder title="No messages yet" />;
  }
}

function Scrollback({ view, loadOlder }: { view: MainChatView; loadOlder(): void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // Follow the end until the reader scrolls up; scrolling back to the end resumes.
  const following = useRef(true);
  const measure = useRef({ top: 0, height: 0, fromEnd: 0 });
  const { entries, hasOlder, loadingOlder, prepends } = view;

  const pin = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    if (following.current) el.scrollTop = el.scrollHeight;
    measure.current = { top: el.scrollTop, height: el.scrollHeight, fromEnd: el.scrollHeight - el.scrollTop };
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current, inner = content.current;
    if (!el || !inner) return;
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [pin]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const previous = measure.current;
    if (el.scrollHeight - el.clientHeight - el.scrollTop <= endSlack) following.current = true;
    // Content only grows or is replaced by the feed, so an upward move with no shrink is the reader's.
    else if (el.scrollTop < previous.top - 1 && el.scrollHeight >= previous.height) following.current = false;
    measure.current = { top: el.scrollTop, height: el.scrollHeight, fromEnd: el.scrollHeight - el.scrollTop };
  };

  // Older history lands above the reader: hold their distance from the end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || following.current) return;
    el.scrollTop = el.scrollHeight - measure.current.fromEnd;
    measure.current = { top: el.scrollTop, height: el.scrollHeight, fromEnd: measure.current.fromEnd };
  }, [prepends]);

  // Reading near the top pages further back; a still-visible sentinel keeps paging as each page lands.
  useEffect(() => {
    const el = scroller.current, mark = sentinel.current;
    if (!el || !mark || !hasOlder || loadingOlder) return;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) loadOlder();
    }, { root: el, rootMargin: "600px 0px 0px 0px" });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [hasOlder, loadingOlder, loadOlder]);

  return (
    <div ref={scroller} data-scroll onScroll={onScroll} className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div ref={content} className="flex flex-col px-4 pt-4 pb-5 font-mono text-[12.5px] leading-[1.65]">
        {hasOlder ? (
          <div ref={sentinel} className="pb-4 text-center text-[11px] text-muted-foreground/70">
            <button type="button" disabled={loadingOlder} onClick={loadOlder} className="rounded px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">Load earlier turns</button>
          </div>
        ) : null}
        <span role="status" className="sr-only">{loadingOlder ? "Reading earlier turns…" : prepends > 0 ? "Earlier turns loaded." : ""}</span>
        {entries.map((entry, index) => (
          <Entry key={entry.key} entry={entry} end={view.turnEnds.get(entry.key)} first={index === 0} after={entries[index - 1]?.kind} />
        ))}
      </div>
    </div>
  );
}

const Entry = memo(function Entry({ entry, end, first, after }: { entry: ChatEntry; end: ChatTurnEnd | undefined; first: boolean; after: ChatEntry["kind"] | undefined }) {
  if (entry.kind === "human") {
    return (
      <div data-entry="human" className={cn("chat-entry rounded-r-md border-l-2 border-pkg-bots/80 bg-foreground/[0.04] py-2 pr-3 pl-3", !first && "mt-6")}>
        {entry.text ? <p className="break-words whitespace-pre-wrap text-foreground">{entry.text}</p> : null}
        {entry.omitted ? <p className="text-muted-foreground italic">message too large to show</p> : null}
        {entry.attachments.length ? (
          <p className={cn("flex flex-wrap gap-1.5", entry.text && "mt-1.5")}>
            {entry.attachments.map((label, index) => <span key={index} className="rounded-sm bg-foreground/[0.07] px-1.5 text-[11px] text-muted-foreground">{label}</span>)}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div data-entry="assistant" className={cn("chat-entry pl-[14px]", !first && (after === "human" ? "mt-4" : "mt-3"))}>
      {entry.omitted ? <p className="text-muted-foreground italic">message too large to show</p> : <Markdown text={entry.text} streaming={entry.streaming} />}
      {end ? <TurnEnd end={end} /> : null}
    </div>
  );
});

function TurnEnd({ end }: { end: ChatTurnEnd }) {
  const span = end.startedAtMs !== null && end.completedAtMs !== null && end.completedAtMs >= end.startedAtMs ? end.completedAtMs - end.startedAtMs : null;
  const at = end.completedAtMs ?? end.startedAtMs;
  if (span === null && at === null) return null;
  return (
    <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground/80 select-none">
      <span aria-hidden className="text-pkg-bots">▣</span>
      {span !== null ? <span className="tabular-nums">{duration(span)}</span> : null}
      {span !== null && at !== null ? <span aria-hidden>·</span> : null}
      {at !== null ? <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time> : null}
    </p>
  );
}

function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  table: ({ node: _node, ...props }) => <div className="chat-table"><table {...props} /></div>,
};

const Block = memo(function Block({ source }: { source: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{source}</ReactMarkdown>;
});

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  return (
    <div className={cn("chat-md break-words text-foreground/90", streaming && "chat-streaming")}>
      {blocks.map((source, index) => <Block key={index} source={source} />)}
      {streaming && !blocks.length ? <p /> : null}
    </div>
  );
});

const phaseTitle: Record<ChatActivity["phase"], string> = { thinking: "Thinking", working: "Working", responding: "Responding" };

function StatusLine({ botId, view }: { botId: string | null; view: MainChatView | null }) {
  const active = view?.active ?? null;
  const idle = !botId ? "no bot" : !view ? "connecting" : view.status === "stopped" ? "stopped" : view.status === "no-thread" ? "no main thread"
    : view.status === "missing" ? "removed" : view.status === "loading" ? "reading" : view.status === "error" && !view.entries.length ? "unavailable" : "idle";
  return (
    <div role="status" aria-live="polite" className="flex h-8 shrink-0 items-center gap-2 border-t border-border/60 px-4 font-mono text-[11.5px] text-muted-foreground">
      {active ? <Activity active={active} /> : (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span>{idle}</span>
          {view?.error && view.entries.length ? <span className="ml-auto truncate text-warning" title={view.error}>{view.error}</span> : null}
        </>
      )}
    </div>
  );
}

function Activity({ active }: { active: NonNullable<MainChatView["active"]> }) {
  const now = useNow(1_000);
  const elapsed = active.startedAt ? Math.max(0, now - active.startedAt) : null;
  return (
    <>
      <Spinner />
      <span className="shrink-0 text-foreground">{phaseTitle[active.phase]}</span>
      {active.headline ? <span className="min-w-0 truncate">{active.headline}</span> : null}
      {elapsed !== null ? <span className="ml-auto shrink-0 tabular-nums">{clock(elapsed)}</span> : null}
    </>
  );
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <span aria-hidden className="w-[1ch] shrink-0 text-pkg-bots">{frames[frame]}</span>;
}
