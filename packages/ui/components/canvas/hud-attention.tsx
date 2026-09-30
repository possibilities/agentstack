"use client";

import { useMemo } from "react";
import { HandIcon } from "lucide-react";
import { activityWord, attentionGroups, isTerminal, rowIndex, scopedNotes } from "@/lib/stack/hud";
import type { WorkActivity, WorkTreeRow } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { ActorName, AttentionChip, HudPlaceholder, PriorityMark, StateMark } from "./hud-shared";
import { useProcSnapshot } from "./proc-shared";
import { Time } from "./primitives";
import { useHudView, useStack, useStore } from "./provider";
import { Section, Window } from "./window";

/** Journal entries read back from the newest cursor for the recent results list. */
const recentSpan = 300;

/**
 * What needs someone next: explicit human and agent markers, review, blocked and
 * waiting work, and the latest results, decisions and handoffs. Markers ask for a look;
 * they aren't notifications, approvals or acknowledgements.
 */
export function AttentionWindow() {
  const { hudTree, hudGeneration, status, endpoints } = useStack();
  const store = useStore();
  const rows = hudTree.data?.rows ?? [];
  const groups = useMemo(() => attentionGroups(rows), [rows]);
  const byId = useMemo(() => rowIndex(rows), [rows]);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const recent = useProcSnapshot<WorkActivity[]>(endpoints.hud ? "recent" : null, hudGeneration, async () => {
    const { cursor } = await store.call<{ cursor: number }>("hud", "work_list", { limit: 1 });
    const entries: WorkActivity[] = [];
    let after = Math.max(0, cursor - recentSpan);
    for (let page = 0; page < 4; page++) {
      const result = await store.call<{ entries: WorkActivity[]; nextCursor: number; hasMore: boolean }>("hud", "work_activity_list", { after, limit: 100 });
      entries.push(...result.entries.filter((entry) => scopedNotes.has(entry.kind)));
      after = result.nextCursor;
      if (!result.hasMore) break;
    }
    return entries.reverse().slice(0, 12);
  });

  return (
    <Window id="hud-attention" title="Needs attention" subtitle={hudTree.data ? `${total} open item${total === 1 ? "" : "s"}` : "hud"} icon={HandIcon} accent="hud"
      count={total || null} status={status.hud} endpoint={endpoints.hud} updatedAt={hudTree.at} error={hudTree.error} empty={!hudTree.data}>
      {!endpoints.hud ? <HudPlaceholder title="HUD isn't served by this server" icon={HandIcon} />
        : !hudTree.data ? <HudPlaceholder title={hudTree.error ? "Work unavailable" : "Reading work…"} icon={HandIcon} />
        : (
          <>
            {groups.length ? groups.map((group) => (
              <Section key={group.id} title={`${group.title} · ${group.rows.length}`}>
                <ul className="flex flex-col gap-0.5">
                  {group.rows.slice(0, 20).map((row) => <AttentionRow key={row.item.id} row={row} titles={byId} />)}
                </ul>
                {group.rows.length > 20 ? <p className="px-0.5 text-[0.7rem] text-muted-foreground">{group.rows.length - 20} more; filter Work by “Needs a look”.</p> : null}
              </Section>
            )) : <p className="px-0.5 text-[0.75rem] text-muted-foreground">Nothing is marked, blocked, waiting or in review.</p>}
            {!hudTree.data.complete ? <p className="px-0.5 text-[0.7rem] text-muted-foreground">Only the loaded {rows.length} of {hudTree.data.total} items are considered.</p> : null}
            <Section title="Recent results and decisions">
              {recent.error && !recent.data ? <p className="px-0.5 text-[0.72rem] text-destructive">{recent.error}</p> : null}
              {recent.data?.length ? (
                <ul className="flex flex-col gap-1">
                  {recent.data.map((entry) => <RecentEntry key={entry.sequence} entry={entry} row={byId.get(entry.workItemId)} />)}
                </ul>
              ) : recent.data ? <p className="px-0.5 text-[0.72rem] text-muted-foreground">None recorded recently.</p> : null}
            </Section>
          </>
        )}
    </Window>
  );
}

function AttentionRow({ row, titles }: { row: WorkTreeRow; titles: Map<string, WorkTreeRow> }) {
  const { view, hudView } = useHudView();
  const { item } = row;
  const selected = view.selectedId === item.id;
  const unmet = row.unmetDependencies.map((id) => titles.get(id)?.item.title ?? "work outside the loaded tree");
  return (
    <li>
      <button type="button" onClick={() => hudView.select(item.id)} aria-pressed={selected}
        className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring", selected && "bg-muted")}>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <StateMark state={item.state} />
          <span className="min-w-0 truncate text-[0.8rem] font-medium">{item.title}</span>
          <PriorityMark priority={item.priority} />
          <AttentionChip attention={item.attention} className="ml-auto" />
        </span>
        {item.nextAction ? <span className="truncate pl-5 text-[0.7rem] text-muted-foreground">Next: {item.nextAction}</span> : null}
        {unmet.length ? <span className="truncate pl-5 text-[0.68rem] text-warning">Waiting on {unmet.join(", ")}</span> : null}
        <span className="pl-5 text-[0.66rem] text-muted-foreground">Updated <Time at={item.updatedAt} /></span>
      </button>
    </li>
  );
}

function RecentEntry({ entry, row }: { entry: WorkActivity; row: WorkTreeRow | undefined }) {
  const { hudView } = useHudView();
  const earlier = row && entry.scopeRevision < row.item.scopeRevision;
  return (
    <li>
      <button type="button" onClick={() => hudView.select(entry.workItemId)}
        className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring">
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <span className="font-medium text-foreground/80">{activityWord(entry.kind)}</span>
          <span className="min-w-0 truncate">on {row?.item.title ?? "work outside the loaded tree"}</span>
          {row && isTerminal(row.item.state) ? <StateMark state={row.item.state} /> : null}
          <span className="ml-auto shrink-0"><Time at={entry.at} /></span>
        </span>
        {entry.body ? <span className="line-clamp-2 text-[0.75rem] text-pretty">{entry.body}</span> : null}
        <span className="text-[0.66rem] text-muted-foreground">
          by <ActorName actor={entry.actor} />{earlier ? <span className="text-warning"> · for an earlier scope ({entry.scopeRevision}, now {row.item.scopeRevision})</span> : null}
        </span>
      </button>
    </li>
  );
}
