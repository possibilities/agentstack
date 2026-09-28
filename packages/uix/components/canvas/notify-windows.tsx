"use client";

import { memo, useEffect, useId, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BellIcon, BellOffIcon, CircleCheckIcon, CircleHelpIcon, ExternalLinkIcon, InboxIcon, RepeatIcon, ReplyIcon, SendIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Notification, NotificationFilter, NotificationOutcome } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useNotifyActions } from "./notify-actions";
import { CopyButton, Empty, Row, Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { footerButton, Section, Window } from "./window";

type View = "open" | "dismissed" | "all";
const views: Array<[View, string]> = [["open", "Open"], ["dismissed", "Dismissed"], ["all", "All"]];
const viewOf = (filter: NotificationFilter): View => filter.dismissed === false ? "open" : filter.dismissed === true ? "dismissed" : "all";
const emptyTitle: Record<View, string> = { open: "No open notifications", dismissed: "Nothing dismissed yet", all: "No notifications yet" };

/** Past-tense copy for each dismissal outcome; a replaced notification was superseded, not handled. */
const outcomeView: Record<NotificationOutcome, { icon: React.ComponentType<{ className?: string }>; label(record: Notification): string; className: string }> = {
  closed: { icon: XIcon, label: () => "Dismissed", className: "text-muted-foreground" },
  opened: { icon: ExternalLinkIcon, label: () => "Opened", className: "text-success" },
  action: { icon: CircleCheckIcon, label: (record) => `Chose “${record.response}”`, className: "text-success" },
  replied: { icon: ReplyIcon, label: () => "Replied", className: "text-success" },
  replaced: { icon: RepeatIcon, label: () => "Replaced", className: "text-muted-foreground" },
};

/** A one-glance preview of markdown: link text instead of link syntax, no emphasis or heading marks. */
const plain = (text: string) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "").replace(/\*\*|__|~~|[*`]/g, "").replace(/\s+/g, " ").trim();
const asks = (record: Notification) => record.actions.length > 0 || record.reply !== null;
const at = (iso: string | null) => iso ? Date.parse(iso) : null;

/** Newest-first notifications with an Open, Dismissed or All filter and an optional source. Choosing one shows it; it stays open until dismissed. */
export function InboxWindow() {
  const store = useStore();
  const { status, endpoints, notifications, notificationFilter, notifyCounts } = useStack();
  const actions = useNotifyActions();
  const list = useRef<HTMLUListElement>(null);
  const loaded = notifications.data?.filter === notificationFilter ? notifications.data : null;
  const entries = loaded?.entries ?? [];
  const view = viewOf(notificationFilter);
  const sources = (notifyCounts.data?.sources ?? []).filter((item): item is { source: string; open: number; total: number } => item.source !== null);
  const arrived = useArrivals(loaded);
  const [older, setOlder] = useState(false);

  const filter = (next: { view?: View; source?: string | null }) => {
    const chosen = next.view ?? view;
    const source = next.source === undefined ? notificationFilter.source : next.source ?? undefined;
    store.setNotificationFilter({ ...(chosen === "all" ? {} : { dismissed: chosen === "dismissed" }), ...(source ? { source } : {}) });
  };
  const loadOlder = () => { setOlder(true); void store.loadOlderNotifications().finally(() => setOlder(false)); };

  // Arrow keys move between rows and show each; D dismisses the focused open one.
  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-notification]") ?? [])];
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) { next.focus(); actions.open(next.dataset.notification!); }
      event.preventDefault();
    } else if (event.key.toLowerCase() === "d" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const record = entries.find((item) => item.id === rows[index].dataset.notification);
      if (record && !record.dismissedAt && !actions.pending.has(record.id)) void actions.dismiss(record, "closed");
      event.preventDefault();
    }
  };

  return (
    <Window id="notify-inbox" title="Inbox" subtitle="notifications" icon={InboxIcon} accent="notify" count={notifyCounts.data?.open ?? null}
      status={endpoints.notify ? status.notify : undefined} endpoint={endpoints.notify} updatedAt={notifications.at} error={notifications.error ?? notifyCounts.error}
      empty={!endpoints.notify}
      footer={endpoints.notify ? (
        <Button variant="ghost" size="sm" className={footerButton} disabled={!notifyCounts.data?.open || status.notify !== "open"} onClick={actions.confirmDismissAll}>
          <BellOffIcon data-icon="inline-start" />Dismiss all…
        </Button>
      ) : undefined}>
      {!endpoints.notify ? <Empty icon={InboxIcon} title="Notify isn’t served by this owner" /> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup value={[view]} onValueChange={(value: string[]) => { if (value.length) filter({ view: value[0] as View }); }} spacing={0} size="sm" variant="outline" aria-label="Show">
              {views.map(([value, label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}
            </ToggleGroup>
            {sources.length ? (
              <NativeSelect size="sm" aria-label="Source" className="min-w-0 flex-1" value={notificationFilter.source ?? ""} onChange={(event) => filter({ source: event.target.value || null })}>
                <NativeSelectOption value="">All sources</NativeSelectOption>
                {sources.map((item) => <NativeSelectOption key={item.source} value={item.source}>{item.source} ({view === "open" ? item.open : item.total})</NativeSelectOption>)}
              </NativeSelect>
            ) : null}
          </div>
          {!loaded ? (
            <p className="flex items-center gap-1.5 px-0.5 text-[0.72rem] text-muted-foreground">{notifications.error && !notifications.data ? notifications.error : <><Spinner className="size-3" />Loading…</>}</p>
          ) : entries.length ? (
            <ul ref={list} onKeyDown={onKeyDown} aria-label="Notifications" className="flex flex-col gap-1.5">
              {entries.map((record) => (
                <InboxRow key={record.id} record={record} selected={actions.selected === record.id} arrived={arrived.get(record.id)}
                  filtering={notificationFilter.source !== undefined} onSelect={() => actions.open(record.id)} />
              ))}
            </ul>
          ) : <Empty icon={view === "dismissed" ? BellOffIcon : InboxIcon} title={emptyTitle[view]} />}
          {loaded?.nextCursor ? (
            <Button variant="ghost" size="sm" className="self-center text-muted-foreground" disabled={older || status.notify !== "open"} onClick={loadOlder}>
              {older ? <Spinner data-icon="inline-start" /> : null}Load older
            </Button>
          ) : null}
        </>
      )}
    </Window>
  );
}

function InboxRow({ record, selected, arrived, filtering, onSelect }: { record: Notification; selected: boolean; arrived?: number; filtering: boolean; onSelect(): void }) {
  const outcome = record.outcome ? outcomeView[record.outcome] : null;
  const OutcomeIcon = outcome?.icon;
  return (
    <li className="relative">
      {arrived ? <span key={arrived} aria-hidden className="pointer-events-none absolute -inset-0.5 rounded-[inherit] animate-uix-flash" /> : null}
      <button type="button" data-notification={record.id} aria-current={selected ? "true" : undefined} onClick={onSelect}
        className={cn("flex w-full gap-2 rounded-xl border px-2.5 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring",
          selected && "border-foreground/25 bg-muted/60", record.dismissedAt && "opacity-70")}>
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          {OutcomeIcon ? <OutcomeIcon className={cn("size-3", outcome.className)} /> : <span aria-label="Open" className="size-2 rounded-full bg-pkg-notify" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[0.82rem]", !record.dismissedAt && "font-medium")}>{record.title}</span>
            <Time at={at(record.createdAt)} className="shrink-0 text-[0.65rem] text-muted-foreground" />
          </span>
          <span className="line-clamp-2 text-[0.75rem] text-pretty text-muted-foreground">{record.subtitle ?? plain(record.message)}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.65rem] text-muted-foreground">
            {record.source && !filtering ? <span className="truncate font-mono">{record.source}</span> : null}
            {outcome ? <span className={cn("shrink-0", outcome.className)}>{outcome.label(record)}</span>
              : asks(record) ? <span className="flex shrink-0 items-center gap-0.5 text-pkg-notify"><CircleHelpIcon className="size-3" />Question</span>
              : record.open ? <span className="flex shrink-0 items-center gap-0.5"><ExternalLinkIcon className="size-3" />Link</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Rows that appear after a filter's first load flash once; switching filters flashes nothing. */
function useArrivals(loaded: { filter: NotificationFilter; entries: Notification[] } | null): Map<string, number> {
  const seen = useRef<{ filter: NotificationFilter; ids: Set<string> } | null>(null);
  const [arrived, setArrived] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!loaded) return;
    const previous = seen.current;
    seen.current = { filter: loaded.filter, ids: new Set(loaded.entries.map((item) => item.id)) };
    if (!previous || previous.filter !== loaded.filter) return;
    const fresh = loaded.entries.filter((item) => !previous.ids.has(item.id));
    if (!fresh.length) return;
    const stamp = Date.now();
    setArrived((current) => new Map([...current, ...fresh.map((item) => [item.id, stamp] as const)]));
    const timer = setTimeout(() => setArrived((current) => new Map([...current].filter(([, value]) => value !== stamp))), 1_500);
    return () => clearTimeout(timer);
  }, [loaded]);
  return arrived;
}

/** One notification: its message, and while open, the ways to answer or dismiss it. Every control dismisses exactly once. */
export function NotificationWindow() {
  const store = useStore();
  const { notificationRecords, status, catalog } = useStack();
  const actions = useNotifyActions();
  const id = actions.selected;
  const record = id ? notificationRecords[id] : undefined;
  useEffect(() => id ? store.watchNotification(id) : undefined, [store, id]);
  const fields = catalog.data?.find((doc) => doc.name === "notify")?.operations.find((operation) => operation.name === "notification_get")?.outputSchema.properties ?? {};
  const hint = (name: string) => (fields[name] as { description?: string } | undefined)?.description;
  return (
    <Window id="notify-detail" title="Notification" subtitle={record ? record.dismissedAt ? "dismissed" : "open" : undefined} icon={BellIcon} accent="notify"
      node={record ? { kind: "notification", id: record.id } : undefined} empty={!record}>
      {!id ? <Empty icon={BellIcon} title="Choose a notification" />
        : !record ? <p className="flex items-center gap-1.5 px-0.5 text-[0.72rem] text-muted-foreground"><Spinner className="size-3" />Loading…</p>
        : (
          <>
            <div className="flex flex-col gap-1">
              <h3 className="text-[0.95rem] leading-snug font-semibold text-pretty">{record.title}</h3>
              {record.subtitle ? <p className="text-[0.8rem] text-pretty text-muted-foreground">{record.subtitle}</p> : null}
            </div>
            <NotificationMarkdown text={record.message} />
            {record.dismissedAt ? <Outcome record={record} /> : <Respond key={record.id} record={record} connected={status.notify === "open"} />}
            <Section title="Details">
              <div className="flex flex-col">
                {record.source ? <Row label="Source" hint={hint("source")} mono copy={record.source}>{record.source}</Row> : null}
                {record.group ? <Row label="Group" hint={hint("group")} mono copy={record.group}>{record.group}</Row> : null}
                {record.open ? <Row label="Link" hint={hint("open")} mono copy={record.open}>{record.open}</Row> : null}
                <Row label="Sent" hint={hint("createdAt")}><Time at={at(record.createdAt)} /></Row>
                {record.dismissedAt ? <Row label="Dismissed" hint={hint("dismissedAt")}><Time at={at(record.dismissedAt)} /></Row> : null}
                <Row label="ID" mono copy={record.id}>{record.id}</Row>
              </div>
            </Section>
          </>
        )}
    </Window>
  );
}

function Outcome({ record }: { record: Notification }) {
  const view = outcomeView[record.outcome ?? "closed"];
  const Icon = view.icon;
  return (
    <div role="status" className="flex flex-col gap-1.5 rounded-xl border bg-muted/40 px-3 py-2.5">
      <p className={cn("flex items-center gap-1.5 text-[0.78rem] font-medium", view.className)}>
        <Icon className="size-3.5" /><span>{view.label(record)}</span><Time at={at(record.dismissedAt)} className="ml-auto text-[0.68rem] font-normal text-muted-foreground" />
      </p>
      {record.outcome === "replied" && record.response ? (
        <div className="flex items-start gap-1">
          <p className="min-w-0 flex-1 text-[0.8rem] text-pretty whitespace-pre-wrap">{record.response}</p>
          <CopyButton value={record.response} label="reply" />
        </div>
      ) : null}
      {record.outcome === "replaced" ? <p className="text-[0.72rem] text-pretty text-muted-foreground">A newer notification in its group took its place.</p> : null}
      {record.open ? (
        <a href={record.open} target="_blank" rel="noopener noreferrer" className="flex w-fit items-center gap-1 text-[0.72rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          <ExternalLinkIcon className="size-3" />Open link
        </a>
      ) : null}
    </div>
  );
}

/** Answer controls follow the notification's own actions and reply prompt; each records how it was dismissed. */
function Respond({ record, connected }: { record: Notification; connected: boolean }) {
  const actions = useNotifyActions();
  const formId = useId();
  const [reply, setReply] = useState("");
  const busy = actions.pending.has(record.id) || !connected;
  const send = () => {
    const text = reply.trim();
    if (!text || busy) return;
    void actions.dismiss(record, "replied", text).then((done) => { if (done) setReply(""); });
  };
  return (
    <div className="flex flex-col gap-2">
      {record.actions.length ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer">
          {record.actions.map((label) => (
            <Button key={label} size="sm" variant="outline" disabled={busy} onClick={() => void actions.dismiss(record, "action", label)}>{label}</Button>
          ))}
        </div>
      ) : null}
      {record.reply !== null ? (
        <form className="flex flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <label htmlFor={`${formId}-reply`} className="sr-only">Reply</label>
          <Textarea id={`${formId}-reply`} value={reply} placeholder={record.reply} maxLength={4_000} disabled={busy}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
            className="max-h-40 min-h-16 resize-none text-[0.8rem] md:text-[0.8rem]" />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.65rem] text-muted-foreground">⌘Enter to send</span>
            <Button type="submit" size="sm" disabled={busy || !reply.trim()}><SendIcon data-icon="inline-start" />Reply</Button>
          </div>
        </form>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {record.open ? (
          // A real link, so the browser opens it; the click also records the dismissal as opened.
          <Button size="sm" variant={asks(record) ? "outline" : "default"} disabled={busy}
            render={<a href={record.open} target="_blank" rel="noopener noreferrer" onClick={() => { if (!busy) void actions.dismiss(record, "opened"); }} />}>
            <ExternalLinkIcon data-icon="inline-start" />Open link
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void actions.dismiss(record, "closed")}>
          {actions.pending.has(record.id) ? <Spinner data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}Dismiss
        </Button>
      </div>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _node, ...props }) => <div className="chat-table"><table {...props} /></div>,
};

/** Caller-supplied text: markdown without raw HTML, and links open only on an explicit click. */
const NotificationMarkdown = memo(function NotificationMarkdown({ text }: { text: string }) {
  return <div className="chat-md text-[0.82rem] break-words text-foreground/90"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown></div>;
});
