"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { RoleLaunch } from "@/lib/stack/types";
import { usePagedRead } from "./owner-reads";
import { Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";
import { Section } from "./window";

const operations = ["role_launch_list", "role_launch_plan", "role_launch_clear", "roles_state_receipt_get"];
const hint = "text-[0.68rem] text-pretty text-muted-foreground";

export function RoleLaunchDirectories() {
  const state = useStack();
  if (state.remote || !localOperations(state, "roles", operations).available) return null;
  return <LaunchDirectories />;
}

function LaunchDirectories() {
  const state = useStack();
  const store = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const pages = usePagedRead<RoleLaunch>((offset, revision) => store.call<{ launches: RoleLaunch[]; revision: string; nextOffset: number | null }>("roles", "role_launch_list", { offset, limit: 100, ...(revision ? { revision } : {}) })
    .then((page) => ({ items: page.launches, revision: page.revision, nextOffset: page.nextOffset })), "roles:launches", state.roleCatalog.at ?? 0);
  const controls = useStateFlow({
    operations: stateOperations(store.call, "roles", { plan: "role_launch_plan", apply: "role_launch_clear", receipt: "roles_state_receipt_get" }, { ids: selected }),
    recoveryKey: "roles:launch_clear:ids", observe: state.roleCatalog.at,
    onReceipt: (receipt) => { pages.refresh(); if (receipt.status === "completed") setSelected([]); },
  });
  const locked = controls.flow.phase !== "idle";
  const rows = pages.page?.items ?? [];
  const unavailable = state.status.roles !== "open" ? "The roles connection is not open." : pages.error ? "Refresh the launch directories before preparing."
    : !selected.length ? "Select retained launch directories to clear."
    : selected.some((id) => !rows.some((row) => row.id === id && row.state === "retained")) ? "The selected launches changed; close the flow and review the current selection." : null;
  return <Section title="Launch directories" aside={<Button size="xs" variant="ghost" disabled={pages.loading || state.status.roles !== "open"} onClick={pages.refresh}>Refresh launches</Button>}>
    <p className={hint}>Metadata for Role injections. Refresh explicitly for file and process changes. Live launches and unknown or missing-lock directories block clearing; no native process is stopped.</p>
    {pages.error ? <p role="alert" className="text-xs text-destructive">Launch directories unavailable: {pages.error}</p> : null}
    {pages.page?.restarted ? <p className={hint}>The observation changed while paging; showing the first page again.</p> : null}
    <MaintenanceDisclosure active={locked} aside="retained launches">
      <p className={hint}>Clears exact exited launch directories only. External native history and credentials, Bot and Worker materializations, Role configuration, shims and backups remain. Unknown or partial receipts are not rerun.</p>
      <ul aria-label="Launch directories" className="flex max-h-64 flex-col gap-2 overflow-auto">
        {rows.map((row) => <li key={row.id} className="flex min-w-0 flex-col gap-0.5 text-xs">
          <label className="flex items-center gap-1.5"><input type="checkbox" aria-label={`Select launch ${row.id}`} checked={selected.includes(row.id)}
            disabled={locked || row.state !== "retained" || (!selected.includes(row.id) && selected.length >= 100)}
            onChange={() => setSelected((held) => held.includes(row.id) ? held.filter((id) => id !== row.id) : [...held, row.id])} />
            <span className="min-w-0 break-words font-mono">{row.id}</span> · {row.state}</label>
          <span className="pl-5 text-muted-foreground">Modified <Time at={Date.parse(row.modifiedAt)} />{row.issue ? ` · Blocks clearing: ${row.issue}` : ""}</span>
        </li>)}
      </ul>
      {pages.page && !rows.length ? <p className={hint}>No launch directories.</p> : null}
      {pages.page?.nextOffset != null ? <Button size="xs" variant="ghost" disabled={pages.loading || locked || state.status.roles !== "open"} onClick={pages.more}>Load more launches</Button> : null}
      <StateFlowView controls={controls} label={`Prepare clearing ${selected.length} launch directories`} applyLabel="Clear these launch directories" unavailable={unavailable} />
    </MaintenanceDisclosure>
  </Section>;
}
