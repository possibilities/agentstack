"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { activityWord, noteKinds, rowIndex, scopedNotes, valueText, type NoteKind } from "@/lib/stack/hud";
import type { WorkActivity, WorkItem } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { ActorName, HudPlaceholder, hudReadOnly, ReferenceLink, RequestNotice, useHudRequest } from "./hud-shared";
import { Time } from "./primitives";
import { useHudView, useStack, useStore } from "./provider";
import { Window } from "./window";

type Page = { entries: WorkActivity[]; nextCursor: number; hasMore: boolean };
type History = { id: string | null; entries: WorkActivity[]; cursor: number; hasMore: boolean; loading: boolean; error: string | null };
/** Pages read per catch-up before asking; each is at most 100 entries. */
const catchUpPages = 10;

/**
 * One item's collaboration journal in order: edits with their before and after, scope
 * changes, Chat focus, and immutable notes, results, decisions and handoffs. It follows
 * the durable cursor, so a reconnect continues rather than guesses.
 */
export function TimelineWindow() {
  const { hudTree, hudItemGenerations, status, endpoints, remote } = useStack();
  const store = useStore();
  const { view } = useHudView();
  const id = view.selectedId;
  const item = id ? rowIndex(hudTree.data?.rows ?? []).get(id)?.item ?? null : null;
  const [history, setHistory] = useState<History>({ id: null, entries: [], cursor: 0, hasMore: false, loading: false, error: null });
  const flight = useRef<{ id: string | null; running: boolean; again: boolean }>({ id: null, running: false, again: false });
  const current = useRef(history);
  current.current = history;

  const readForward = useCallback(async (limitPages: number) => {
    const state = flight.current;
    if (!state.id) return;
    if (state.running) { state.again = true; return; }
    state.running = true;
    const key = state.id;
    setHistory((value) => value.id === key ? { ...value, loading: true } : value);
    try {
      let cursor = current.current.id === key ? current.current.cursor : 0;
      const added: WorkActivity[] = [];
      let more = true;
      for (let page = 0; page < limitPages && more; page++) {
        const result = await store.call<Page>("hud", "work_activity_list", { id: key, after: cursor, limit: 100 });
        added.push(...result.entries);
        cursor = result.nextCursor;
        more = result.hasMore;
      }
      if (flight.current.id === key) setHistory((value) => value.id === key
        ? { ...value, entries: [...value.entries, ...added.filter((entry) => !value.entries.some((known) => known.sequence === entry.sequence))], cursor, hasMore: more, loading: false, error: null }
        : value);
    } catch (error) {
      if (flight.current.id === key) setHistory((value) => value.id === key ? { ...value, loading: false, error: error instanceof Error ? error.message : String(error) } : value);
    } finally {
      state.running = false;
      if (state.again && flight.current === state) { state.again = false; void readForward(catchUpPages); }
    }
  }, [store]);

  useEffect(() => {
    if (flight.current.id !== id) {
      flight.current = { id, running: false, again: false };
      setHistory({ id, entries: [], cursor: 0, hasMore: false, loading: false, error: null });
      current.current = { id, entries: [], cursor: 0, hasMore: false, loading: false, error: null };
    }
    if (id) void readForward(catchUpPages);
  }, [id, id ? hudItemGenerations[id] : 0, readForward]);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [history.entries.length]);
  const readOnly = hudReadOnly(remote, endpoints.hud);
  const shown = history.id === id ? history : null;

  return (
    <Window id="hud-timeline" title="Timeline" subtitle={item ? item.title : "hud"} icon={HistoryIcon} accent="hud" bleed
      count={shown?.entries.length ?? null} status={status.hud} endpoint={endpoints.hud} error={shown?.error ?? null}
      footer={item && !readOnly ? <NoteComposer item={item} /> : undefined}>
      <div ref={scroller} data-scroll onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3">
        {!id ? <HudPlaceholder title="Choose work" hint="Its edits, notes, results and decisions appear here." icon={HistoryIcon} />
          : !shown || (!shown.entries.length && shown.loading) ? <HudPlaceholder title="Reading history…" icon={HistoryIcon} />
          : !shown.entries.length ? <HudPlaceholder title={shown.error ? "History unavailable" : "No history"} hint={shown.error ?? undefined} icon={HistoryIcon} />
          : (
            <>
              <p className="text-center text-[0.68rem] text-muted-foreground">Oldest first · notes are immutable; corrections are new notes</p>
              <ol className="flex flex-col gap-2">
                {shown.entries.map((entry) => <Entry key={entry.sequence} entry={entry} currentScope={item?.scopeRevision ?? null} />)}
              </ol>
              {shown.hasMore ? (
                <div className="flex flex-col items-center gap-1 text-[0.7rem] text-muted-foreground">
                  <p>History continues; newer entries aren’t read yet.</p>
                  <Button size="xs" variant="outline" disabled={shown.loading} onClick={() => void readForward(catchUpPages)}>
                    {shown.loading ? <Spinner data-icon="inline-start" /> : null}Read newer
                  </Button>
                </div>
              ) : null}
            </>
          )}
      </div>
    </Window>
  );
}

const kindTone: Partial<Record<WorkActivity["kind"], string>> = {
  result: "bg-success/12 text-success", decision: "bg-pkg-hud/12 text-pkg-hud", handoff: "bg-warning/12 text-warning",
  progress: "bg-muted text-foreground/80", note: "bg-muted text-foreground/80",
};

function Entry({ entry, currentScope }: { entry: WorkActivity; currentScope: number | null }) {
  const { hudTree } = useStack();
  const titles = new Map((hudTree.data?.rows ?? []).map((row) => [row.item.id, row.item.title]));
  const earlierScope = scopedNotes.has(entry.kind) && currentScope !== null && entry.scopeRevision < currentScope;
  const note = entry.body !== null && entry.kind !== "focus";
  return (
    <li className={cn("flex flex-col gap-1 rounded-lg px-2.5 py-2 text-[0.78rem]", note ? "border bg-background/60" : "")}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.7rem] text-muted-foreground">
        <span className={cn("rounded px-1.5 py-px text-[0.64rem] font-medium", kindTone[entry.kind] ?? "text-foreground/80")}>{activityWord(entry.kind)}</span>
        <ActorName actor={entry.actor} />
        {entry.actor.kind === "bot" && entry.actor.threadId !== entry.actor.mainThreadId ? <span className="font-mono">· subthread</span> : null}
        <span>·</span><Time at={entry.at} />
        <span className="ml-auto font-mono text-[0.64rem]" title={`Item revision ${entry.revision}, scope revision ${entry.scopeRevision}`}>r{entry.revision} · s{entry.scopeRevision}</span>
      </div>
      {earlierScope ? (
        <p className="text-[0.68rem] text-pretty text-warning">Recorded for scope {entry.scopeRevision}; the objective, parent or dependencies have changed since (now {currentScope}). It is evidence about the earlier scope.</p>
      ) : null}
      {entry.body !== null ? <p className={cn("text-pretty whitespace-pre-wrap", entry.kind === "focus" && "text-muted-foreground")}>{entry.body}</p> : null}
      {entry.changes.length ? (
        <dl className="flex flex-col gap-0.5">
          {entry.changes.map((change, index) => (
            <div key={index} className="flex min-w-0 gap-1.5 text-[0.72rem]">
              <dt className="shrink-0 font-mono text-muted-foreground">{change.field}</dt>
              <dd className="min-w-0 break-words">
                {entry.kind === "created" ? valueText(change.after) : <><span className="text-muted-foreground line-through decoration-muted-foreground/40">{valueText(change.before, 80)}</span> → {valueText(change.after)}</>}
              </dd>
            </div>
          ))}
        </dl>
      ) : entry.fields.length ? <p className="font-mono text-[0.68rem] text-muted-foreground">{entry.kind === "metadata" ? "namespace " : ""}{entry.fields.join(", ")}</p> : null}
      {entry.references.length ? (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[0.72rem]">
          {entry.references.map((reference, index) => <ReferenceLink key={index} reference={reference} titles={titles} />)}
        </div>
      ) : null}
    </li>
  );
}

const noteHints: Record<NoteKind, string> = {
  note: "A remark for collaborators.",
  progress: "What changed since the last report.",
  result: "What was produced. Recording it neither accepts it nor completes the work.",
  decision: "A decision and its reasoning. It doesn't change state or grant approval by itself.",
  handoff: "What the next person or agent needs to continue.",
};

/** Append an immutable note against the item's current revision. A conflict keeps the text. */
function NoteComposer({ item }: { item: WorkItem }) {
  const [kind, setKind] = useState<NoteKind>("note");
  const [body, setBody] = useState("");
  const request = useHudRequest(() => setBody(""));
  const locked = request.running || request.held;
  const add = (revision: number) => void request.submit("work_note_add", { id: item.id, expectedRevision: revision, kind, body: body.trim() });
  return (
    <form className="flex flex-col gap-1.5 p-1" onSubmit={(event) => { event.preventDefault(); if (body.trim() && !locked) add(item.revision); }}>
      <RequestNotice request={request} conflict={
        <div role="alert" className="flex flex-wrap items-center gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-[0.72rem] text-warning">
          The item changed meanwhile (now revision {item.revision}). Your note is kept.
          <Button type="button" size="xs" variant="outline" disabled={request.running} onClick={() => { request.clear(); add(item.revision); }}>Add it on revision {item.revision}</Button>
        </div>
      } />
      <Textarea value={body} disabled={locked} rows={2} maxLength={16_000} placeholder={noteHints[kind]} aria-label="Note"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (body.trim() && !locked) add(item.revision); } }}
        className="min-h-14 text-[0.8rem]" />
      <div className="flex items-center gap-1.5">
        <NativeSelect size="sm" value={kind} disabled={locked} aria-label="Kind" onChange={(event) => setKind(event.target.value as NoteKind)}>
          {noteKinds.map((value) => <NativeSelectOption key={value} value={value}>{activityWord(value)}</NativeSelectOption>)}
        </NativeSelect>
        <span className="truncate text-[0.66rem] text-muted-foreground">Recorded at scope {item.scopeRevision}</span>
        <Button type="submit" size="sm" className="ml-auto" disabled={!body.trim() || locked}>
          {request.running ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}Add
        </Button>
      </div>
    </form>
  );
}
