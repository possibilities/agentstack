"use client";

import { RetireFocus, RetiredFocusSection } from "./hud-maintenance";
import { useEffect, useMemo, useState } from "react";
import { CrosshairIcon, HammerIcon, NetworkIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { admissionView, chatIdentity, isTerminal, rowIndex, workTitle } from "@/lib/stack/hud";
import type { WorkAdmission, WorkFocus, WorkItem, WorkResources } from "@/lib/stack/types";
import { workerLabel } from "@/lib/stack/workers";
import { cn } from "@/lib/utils";
import { ActivityDot, ActorName, HudPlaceholder, hudReadOnly, ReferenceLink, RequestNotice, useHudRequest } from "./hud-shared";
import { useProcSnapshot } from "./proc-shared";
import { NodeLink, Time } from "./primitives";
import { useHudView, useStack, useStore } from "./provider";
import { useShowWorker } from "./worker-windows";
import { Section, Window } from "./window";

type Page = NonNullable<WorkResources["workers"]>;

/**
 * What is deployed on one Work item, kept as separate facts: declared links, Chat focus
 * (contextual selection, not liveness) and captured Worker admissions with their current
 * native observations. A Worker appears once per turn admitted for this item; its other
 * turns belong to other work or none.
 */
export function ResourcesWindow() {
  const { hudTree, hudItemGenerations, hudResourceGeneration, status, endpoints, remote } = useStack();
  const store = useStore();
  const { view } = useHudView();
  const id = view.selectedId;
  const byId = useMemo(() => rowIndex(hudTree.data?.rows ?? []), [hudTree.data]);
  const item = id ? byId.get(id)?.item ?? null : null;
  const generation = (id ? hudItemGenerations[id] ?? 0 : 0) + hudResourceGeneration;
  const resources = useProcSnapshot<WorkResources>(id, generation, () => store.call<WorkResources>("hud", "work_resources", { id: id!, after: 0, limit: 30 }));
  // The last Worker page that was available, kept visible (and marked) while the Worker owner is unavailable.
  const [lastWorkers, setLastWorkers] = useState<{ id: string; page: Page; at: number } | null>(null);
  const [later, setLater] = useState<{ id: string | null; first: number | null; entries: WorkAdmission[]; cursor: number | null; loading: boolean; error: string | null }>({ id: null, first: null, entries: [], cursor: null, loading: false, error: null });
  const data = resources.data;
  useEffect(() => {
    if (data?.workers && id) setLastWorkers({ id, page: data.workers, at: data.observation.at });
  }, [data, id]);
  // A refresh restarts from the first page; later pages must be read again.
  useEffect(() => { setLater({ id: null, first: null, entries: [], cursor: null, loading: false, error: null }); }, [data, id]);
  const readOnly = hudReadOnly(remote, endpoints.hud);
  const workers = data?.workers ?? (lastWorkers?.id === id ? lastWorkers.page : null);
  const stale = data !== null && data.workers === null && workers !== null;
  const entries = [...(workers?.entries ?? []), ...(later.id === id ? later.entries : [])];
  const cursor = later.id === id && later.first === workers?.nextCursor ? later.cursor : workers?.nextCursor ?? null;
  const loadMore = async () => {
    if (!id || !cursor || later.loading) return;
    const first = workers?.nextCursor ?? null;
    setLater((value) => ({ ...(value.id === id && value.first === first ? value : { id, first, entries: [], cursor, error: null }), loading: true }));
    try {
      const next = await store.call<WorkResources>("hud", "work_resources", { id, after: cursor, limit: 30 });
      if (!next.workers) throw new Error(next.observation.issue ?? "Worker associations unavailable");
      const page = next.workers;
      setLater((value) => ({ id, first, entries: [...(value.id === id && value.first === first ? value.entries : []), ...page.entries], cursor: page.nextCursor, loading: false, error: null }));
    } catch (error) {
      setLater((value) => ({ ...value, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };
  const missing = Boolean(resources.error && /work_not_found/.test(resources.error));

  return (
    <Window id="hud-resources" title="Resources" subtitle={item ? workTitle(item) : "hud"} icon={NetworkIcon} accent="hud"
      status={status.hud} endpoint={endpoints.hud} updatedAt={resources.at} error={missing ? null : resources.error} empty={!data}>
      {!id ? <HudPlaceholder title="Choose work" hint="Its Chats, Workers and linked resources appear here." icon={NetworkIcon} />
        : missing ? <HudPlaceholder title="This item no longer exists" icon={NetworkIcon} />
        : !data ? <HudPlaceholder title={resources.error ? "Resources unavailable" : "Reading resources…"} hint={resources.error ?? undefined} icon={NetworkIcon} />
        : (
          <>
            <Declared data={data} />
            <Focus data={data} item={item} readOnly={readOnly} />
            <Section title={`Worker turns${workers ? ` · ${entries.length}${cursor ? "+" : ""}` : ""}`}>
              <Observation data={data} stale={stale} lastAt={lastWorkers?.id === id ? lastWorkers.at : null} />
              {workers ? (
                entries.length ? <WorkerTurns entries={entries} scope={data.scopeRevision} itemId={data.workItemId} /> : <p className="px-0.5 text-[0.72rem] text-muted-foreground">No Worker turn was admitted for this item{data.observation.visibility === "own_bot" ? " by this Bot" : ""}.</p>
              ) : null}
              {cursor ? (
                <Button size="xs" variant="ghost" className="self-center" disabled={later.loading} onClick={() => void loadMore()}>
                  {later.loading ? <Spinner data-icon="inline-start" /> : null}Read more turns
                </Button>
              ) : null}
              {later.error ? <p className="px-0.5 text-[0.7rem] text-destructive">{later.error}</p> : null}
            </Section>
            <p className="px-0.5 text-[0.68rem] text-pretty text-muted-foreground">
              Account <NodeLink node={{ kind: "usage" }} label="Usage">usage</NodeLink> and process <NodeLink node={{ kind: "resource", id: "total" }} label="Resources">resources</NodeLink> are shared by everything on an account or runtime. They aren’t split per item or turn.
            </p>
          </>
        )}
      <RetiredFocusSection />
    </Window>
  );
}

function Declared({ data }: { data: WorkResources }) {
  const { hudTree } = useStack();
  const titles = useMemo(() => new Map((hudTree.data?.rows ?? []).map((row) => [row.item.id, row.item.title])), [hudTree.data]);
  const runtime = data.links.filter((link) => ["operator", "bot", "chat", "worker"].includes(link.target.kind));
  return (
    <Section title="Declared">
      {runtime.length ? (
        <ul className="flex flex-col gap-0.5">
          {runtime.map((link, index) => (
            <li key={index} className="flex min-h-6 items-center gap-1.5 text-[0.78rem]">
              <span className="w-20 shrink-0 text-[0.68rem] text-muted-foreground capitalize">{link.relation}</span>
              <ReferenceLink reference={link.target} titles={titles} />
              {link.label ? <span className="truncate text-muted-foreground">“{link.label}”</span> : null}
            </li>
          ))}
        </ul>
      ) : <p className="px-0.5 text-[0.72rem] text-muted-foreground">No lead, contributor or runtime links. Links are declarations, not observations.</p>}
    </Section>
  );
}

function Observation({ data, stale, lastAt }: { data: WorkResources; stale: boolean; lastAt: number | null }) {
  const available = data.observation.state === "available";
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 px-0.5 text-[0.7rem]", available ? "text-muted-foreground" : "text-warning")}>
      <ActivityDot tone={available ? "success" : "warning"} label={available ? "Worker associations available" : "Worker associations unavailable"} />
      {available ? "Observed" : data.observation.issue ?? "Worker associations unavailable"}
      <span>· <Time at={data.observation.at} /></span>
      <span>· {data.observation.visibility === "all" ? "all Workers" : "this Bot’s Workers only"}</span>
      {stale && lastAt ? <span>· showing the last read from <Time at={lastAt} /></span> : null}
      {!available && !stale ? <span>· not an empty list</span> : null}
    </p>
  );
}

/** Turns grouped by Worker. Each turn keeps its own captured scope; the Worker's latest turn may be on other work. */
function WorkerTurns({ entries, scope, itemId }: { entries: WorkAdmission[]; scope: number; itemId: string }) {
  const { workerSessions, workerAccounts, workerRuntimes, bots, hudTree } = useStack();
  const showWorker = useShowWorker();
  const labels = workerAccountLabels(workerAccounts.data);
  const titles = new Map((hudTree.data?.rows ?? []).map((row) => [row.item.id, row.item.title]));
  const groups = new Map<string, WorkAdmission[]>();
  for (const entry of entries) groups.set(entry.workerId, [...(groups.get(entry.workerId) ?? []), entry]);
  return (
    <ul className="flex flex-col gap-2">
      {[...groups.entries()].map(([workerId, turns]) => {
        const session = workerSessions.data?.find((worker) => worker.id === workerId);
        const first = turns[0];
        const latestContext = session?.turn?.workContext;
        const elsewhere = session && latestContext !== undefined && latestContext?.workItemId !== itemId && !turns.some((turn) => turn.current);
        const hasRuntime = workerRuntimes.data?.some((runtime) => runtime.id === first.accountId);
        return (
          <li key={workerId} className="flex flex-col gap-1.5 rounded-lg border bg-background/60 p-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <HammerIcon aria-hidden className="size-3.5 shrink-0 text-pkg-worker" />
              <button type="button" onClick={() => showWorker(workerId)} title="Open this Worker's conversation and changes"
                className="min-w-0 truncate rounded-sm text-[0.8rem] font-medium decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                {session ? workerLabel(session) : `Worker ${shortId(workerId, 6)}`}
              </button>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[0.68rem] text-muted-foreground">
                <ActivityDot tone={first.workerPhase === "running" ? "info" : ["failed", "needs_recovery"].includes(first.workerPhase) ? "destructive" : first.workerPhase === "awaiting_input" ? "warning" : "muted"} label={`Worker ${first.workerPhase.replace("_", " ")}`} />
                Worker {first.workerPhase.replace("_", " ")}
              </span>
            </div>
            <p className="flex flex-wrap gap-x-2 text-[0.68rem] text-muted-foreground">
              <span>{providerTitle(first.provider)}{first.model ? ` · ${first.model}` : ""}{first.effort ? ` · ${first.effort}` : ""}</span>
              <NodeLink node={{ kind: "worker-account", id: first.accountId }} label="Worker account">{labels.get(first.accountId) ?? shortId(first.accountId)}</NodeLink>
              {hasRuntime ? <NodeLink node={{ kind: "worker-runtime", id: first.accountId }} label="Runtime">runtime</NodeLink> : null}
              {bots.data?.some((bot) => bot.id === first.botId) ? <NodeLink node={{ kind: "bot", id: first.botId }} label={`Bot ${first.botId}`}>{first.botId}</NodeLink> : <span className="font-mono">{first.botId}</span>}
            </p>
            {session ? <p className="truncate font-mono text-[0.66rem] text-muted-foreground" title={session.cwd ?? session.repo}>{session.repo}{session.branch ? ` · ${session.branch}` : ""}</p> : null}
            {elsewhere ? (
              <p className="text-[0.68rem] text-pretty text-muted-foreground">
                Its latest turn is {latestContext ? <>on <ReferenceLink reference={{ kind: "work", workItemId: latestContext.workItemId }} titles={titles} /></> : "not associated with work"}. The turns below remain history for this item.
              </p>
            ) : null}
            <ol className="flex flex-col gap-1">
              {turns.map((turn) => {
                const view = admissionView(turn, scope);
                return (
                  <li key={turn.turnId} className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2 py-1.5 text-[0.72rem]">
                    <div className="flex items-center gap-1.5">
                      <ActivityDot tone={view.tone} label={view.turn} />
                      <span>{view.turn}</span>
                      <span className="font-mono text-[0.66rem] text-muted-foreground">turn {shortId(turn.turnId)}</span>
                      {turn.current ? <span className="rounded bg-muted px-1 text-[0.62rem] text-muted-foreground" title="This Worker's latest turn. Not by itself a sign that it is running.">latest</span> : null}
                      <span className="ml-auto text-[0.66rem] text-muted-foreground"><Time at={turn.createdAt} /></span>
                    </div>
                    <p className="text-[0.66rem] text-muted-foreground">
                      {turn.context.source === "explicit" ? "Dispatched for this item" : turn.context.source === "focus" ? "Captured from Chat focus" : "Continued from its previous turn"} · scope {turn.context.scopeRevision}
                    </p>
                    {view.scope ? <p className="text-[0.66rem] text-pretty text-warning">{view.scope}: evidence about an earlier objective, not proof of the current one.</p> : null}
                  </li>
                );
              })}
            </ol>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Chat focus: which Chats selected this item as context for later Worker turns. It is a
 * saved selection, not activity; setting it starts nothing, and changing it never moves
 * turns already admitted.
 */
function Focus({ data, item, readOnly }: { data: WorkResources; item: WorkItem | null; readOnly: string | null }) {
  const { bots } = useStack();
  const store = useStore();
  const [botId, setBotId] = useState("");
  const [current, setCurrent] = useState<{ key: string; focus: WorkFocus } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const request = useHudRequest(() => { setCurrent(null); setBotId(""); });
  const clear = useHudRequest();
  const candidates = (bots.data ?? []).filter((bot) => bot.mainThreadId);
  const bot = candidates.find((value) => value.id === botId);
  const target = bot?.mainThreadId ? { botId: bot.id, mainThreadId: bot.mainThreadId, threadId: bot.mainThreadId } : null;
  const targetKey = target ? `${target.botId}/${target.mainThreadId}` : null;
  useEffect(() => {
    if (!target) { setCurrent(null); return; }
    let live = true;
    setReadError(null);
    store.call<WorkFocus>("hud", "work_focus_get", { target }).then((focus) => { if (live) setCurrent({ key: targetKey!, focus }); },
      (error: Error) => { if (live) setReadError(error.message); });
    return () => { live = false; };
  }, [targetKey, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const focus = current?.key === targetKey ? current.focus : null;
  const { hudTree } = useStack();
  const titles = new Map((hudTree.data?.rows ?? []).map((row) => [row.item.id, row.item.title]));
  const closed = item ? isTerminal(item.state) || Boolean(item.contentClearedAt) : false;
  return (
    <Section title={`Chat focus · ${data.focuses.total}`}>
      {data.focuses.entries.length ? (
        <ul className="flex flex-col gap-1">
          {data.focuses.entries.map((entry) => {
            const identity = chatIdentity(entry, bots.data);
            return (
              <li key={`${entry.botId}/${entry.threadId}`} className="group/row flex min-h-6 flex-wrap items-center gap-x-1.5 text-[0.76rem]">
                <ReferenceLink reference={{ kind: "chat", botId: entry.botId, mainThreadId: entry.mainThreadId, threadId: entry.threadId }} />
                <span className="text-[0.66rem] text-muted-foreground">by <ActorName actor={entry.updatedBy} /> · <Time at={entry.updatedAt} /></span>
                {identity !== "current" && identity !== "unknown" ? <span className="text-[0.66rem] text-muted-foreground">(retained; not a live Chat)</span> : null}
                {identity === "replaced" || identity === "missing" ? <RetireFocus target={{ botId: entry.botId, mainThreadId: entry.mainThreadId, threadId: entry.threadId }} /> : null}
                {!readOnly ? (
                  <Button size="xs" variant="ghost" className="ml-auto" disabled={clear.running || clear.held}
                    title="Save “no focus” for this Chat. It then stops inheriting focus from ancestor Chats."
                    onClick={() => void clear.submit("work_focus_set", { target: { botId: entry.botId, mainThreadId: entry.mainThreadId, threadId: entry.threadId }, expectedRevision: entry.revision, workItemId: null })}>
                    <XIcon data-icon="inline-start" />Clear
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="px-0.5 text-[0.72rem] text-muted-foreground">No Chat has selected this item.</p>}
      {data.focuses.truncated ? <p className="px-0.5 text-[0.7rem] text-muted-foreground">{data.focuses.total - data.focuses.entries.length} more Chats selected it; the list isn’t complete.</p> : null}
      <RequestNotice request={clear} conflict={<p role="alert" className="text-[0.72rem] text-warning">That Chat’s focus changed meanwhile; the current list is shown. <button type="button" className="underline underline-offset-2" onClick={clear.clear}>Dismiss</button></p>} />
      {!readOnly && item ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2">
          <div className="flex items-center gap-1.5">
            <CrosshairIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <NativeSelect size="sm" value={botId} aria-label="Bot chat" disabled={closed || request.running || request.held} onChange={(event) => setBotId(event.target.value)} className="min-w-0 flex-1">
              <NativeSelectOption value="">{closed ? (item?.contentClearedAt ? "Cleared work can't be focused" : "Closed work can't be focused") : candidates.length ? "Focus a Bot’s main chat on this…" : "No Bot has a main thread"}</NativeSelectOption>
              {candidates.map((value) => <NativeSelectOption key={value.id} value={value.id}>{value.id}{value.state === "stopped" ? " (stopped)" : ""}</NativeSelectOption>)}
            </NativeSelect>
            <Button size="sm" disabled={!target || !focus || focus.workItemId === item.id || request.running || request.held}
              onClick={() => target && focus && void request.submit("work_focus_set", { target, expectedRevision: focus.revision, workItemId: item.id })}>
              {request.running ? <Spinner data-icon="inline-start" /> : null}Focus
            </Button>
          </div>
          {target ? (
            <p className="px-0.5 text-[0.68rem] text-pretty text-muted-foreground">
              {readError ? <span className="text-destructive">{readError}</span>
                : !focus ? "Reading its focus…"
                : focus.revision === 0 ? "It has never chosen focus, so it inherits from ancestor Chats."
                : focus.workItemId === item.id ? "It already focuses this item."
                : focus.workItemId ? <>It focuses <ReferenceLink reference={{ kind: "work", workItemId: focus.workItemId }} titles={titles} /> now.</>
                : "It saved “no focus”."}
              {" "}New Worker turns it starts without naming work will capture this item. Nothing starts now.
            </p>
          ) : null}
          <RequestNotice request={request} conflict={<p role="alert" className="text-[0.72rem] text-warning">Its focus changed after it was read; the current focus is shown. Choose again. <button type="button" className="underline underline-offset-2" onClick={request.clear}>Dismiss</button></p>} />
        </div>
      ) : null}
    </Section>
  );
}
