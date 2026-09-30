"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { chatIdentity } from "@/lib/stack/hud";
import { localOperation, stateOperations } from "@/lib/stack/state";
import type { WorkFocus } from "@/lib/stack/types";
import { shortId } from "@/lib/stack/derive";
import { StateFlowView, useStateFlow } from "./state-flow";
import { useStack, useStore } from "./provider";
import { Section } from "./window";

type Target = { botId: string; mainThreadId: string; threadId: string };
const hint = "text-[0.68rem] text-pretty text-muted-foreground";

/**
 * Remove one exact retired-root Chat focus. The owner proves retirement from live Bot roots; shared Work, its journal
 * and Worker associations stay. A current Chat's focus is changed with Focus/Clear instead.
 */
export function RetireFocus({ target }: { target: Target }) {
  const state = useStack();
  const store = useStore();
  const [open, setOpen] = useState(false);
  const controls = useStateFlow({ operations: stateOperations(store.call, "hud", { plan: "work_focus_retire_plan", apply: "work_focus_retire", receipt: "hud_state_receipt_get" }, { target }),
    recoveryKey: `hud:focus:${target.botId}/${target.mainThreadId}/${target.threadId}` });
  const access = localOperation(state, "hud", "work_focus_retire_plan");
  if (state.remote || !access.available) return null;
  if (!open && controls.flow.phase === "idle") return <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(true)}>Remove retired focus…</Button>;
  return (
    <div className="flex w-full flex-col gap-1.5 rounded-lg border border-dashed p-2">
      <p className={hint}>Removes only this retired Chat&rsquo;s saved focus record. The work item, its history and Worker links stay. Without the record, a saved &ldquo;no focus&rdquo; no longer blocks inheritance.</p>
      <StateFlowView controls={controls} label="Prepare removal" applyLabel="Remove this focus" unavailable={state.status.hud !== "open" ? "The hud connection is not open." : null} />
      {controls.flow.phase === "idle" ? <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(false)}>Cancel</Button> : null}
    </div>
  );
}

/** Every saved focus whose Chat root has retired or whose Bot is gone, including saved “no focus” rows no item lists. */
export function RetiredFocusSection() {
  const state = useStack();
  const store = useStore();
  const { bots, hudGeneration, remote } = state;
  const [rows, setRows] = useState<{ entries: WorkFocus[]; nextCursor: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const access = localOperation(state, "hud", "work_focus_list");
  const load = (after: string | null) => {
    setLoading(true);
    setError(null);
    store.call<{ entries: WorkFocus[]; nextCursor: string | null }>("hud", "work_focus_list", { limit: 100, ...(after ? { after } : {}) })
      .then((page) => setRows((held) => ({ entries: after && held ? [...held.entries, ...page.entries] : page.entries, nextCursor: page.nextCursor })),
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (!remote && access.available) load(null); }, [hudGeneration, bots.data, remote, access.available]);
  if (remote || !access.available) return null;
  const retired = (rows?.entries ?? []).filter((entry) => { const identity = chatIdentity(entry, bots.data); return identity === "replaced" || identity === "missing"; });
  return (
    <Section title={`Retired Chat focus · ${retired.length}`} aside={loading ? <Spinner /> : null}>
      <p className={hint}>Focus saved by Chats whose root was reset or whose Bot was removed. They no longer steer new turns.</p>
      {error ? <p className="text-[0.72rem] text-destructive">Focus records unavailable: {error}</p> : null}
      {retired.length ? (
        <ul aria-label="Retired Chat focus" className="flex flex-col gap-1">
          {retired.map((entry) => (
            <li key={`${entry.botId}/${entry.mainThreadId}/${entry.threadId}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.74rem]">
              <span className="font-mono">{entry.botId}</span>
              <span className="font-mono text-[0.66rem] text-muted-foreground" title={entry.mainThreadId}>root {shortId(entry.mainThreadId)}</span>
              <span className="text-[0.68rem] text-muted-foreground">{entry.workItemId ? "focused a work item" : "saved “no focus”"}</span>
              <span className="ml-auto"><RetireFocus target={{ botId: entry.botId, mainThreadId: entry.mainThreadId, threadId: entry.threadId }} /></span>
            </li>
          ))}
        </ul>
      ) : rows ? <p className={hint}>No retired focus records.</p> : null}
      {rows?.nextCursor ? <Button size="xs" variant="ghost" className="self-start" disabled={loading} onClick={() => load(rows.nextCursor)}>Load more</Button> : null}
    </Section>
  );
}
