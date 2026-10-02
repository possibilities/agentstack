"use client";

import { useState } from "react";
import { expiredAccessHistory, type AccessHistoryKind } from "@/lib/stack/access";
import { localOperations, stateOperations } from "@/lib/stack/state";
import { useNow, useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";
import { Section } from "./window";

const kinds: [AccessHistoryKind, string, string][] = [["ui_sessions", "Expired UI sessions", "expired UI sessions"], ["expired_pairings", "Expired pairings", "expired pairings"], ["expired_invitations", "Expired invitations", "expired invitations"]];

export function AccessHistory() {
  const state = useStack();
  if (state.remote || !state.access.data || !localOperations(state, "access", ["access_history_plan", "access_history_clear", "access_state_receipt_get"]).available) return null;
  return <Section title="Expired history">
    <p className="text-xs text-pretty text-muted-foreground">Clears exact expired metadata, not authority. Revocation stays separate. Server, client, grant and credential identity, revocations, enrollment/Share receipts and minimal retired replay digests remain. Browser/device cookies, outboxes and backups are independent copies.</p>
    {kinds.map(([kind, title, noun]) => <HistoryKind key={kind} kind={kind} title={title} noun={noun} />)}
  </Section>;
}

function HistoryKind({ kind, title, noun }: { kind: AccessHistoryKind; title: string; noun: string }) {
  const state = useStack();
  const store = useStore();
  const now = useNow();
  const [selected, setSelected] = useState<string[]>([]);
  const rows = state.access.data ? expiredAccessHistory(state.access.data, kind, now) : [];
  const controls = useStateFlow({ operations: stateOperations(store.call, "access", { plan: "access_history_plan", apply: "access_history_clear", receipt: "access_state_receipt_get" }, { kind, ids: selected }),
    recoveryKey: `access:history:${kind}`, observe: state.access.at,
    onReceipt: (receipt) => { if (receipt.status === "completed") setSelected([]); },
  });
  const locked = controls.flow.phase !== "idle";
  const unavailable = state.status.access !== "open" ? "The access connection is not open." : state.access.error ? "Refresh Access before preparing; the last snapshot read failed."
    : !selected.length ? "Select expired entries to clear." : selected.some((id) => !rows.some((row) => row.id === id)) ? "The selected history changed; close the flow and review the selection." : null;
  return <MaintenanceDisclosure title={title} active={locked} aside={`${rows.length} expired`}>
    <p className="text-xs text-muted-foreground">Select up to 100 expired entries of this kind. Active and unexpired entries cannot be cleared.</p>
    <ul aria-label={title} className="flex max-h-56 flex-col gap-2 overflow-auto">
      {rows.map((row) => <li key={row.id} className="flex min-w-0 flex-col gap-0.5 text-xs">
        <label className="flex items-start gap-1.5"><input type="checkbox" aria-label={`Select ${kind} ${row.id}`} checked={selected.includes(row.id)}
          disabled={locked || (!selected.includes(row.id) && selected.length >= 100)}
          onChange={() => setSelected((held) => held.includes(row.id) ? held.filter((id) => id !== row.id) : [...held, row.id])} />
          <span className="min-w-0 break-words">{row.label} · <code>{row.id}</code></span></label>
        <span className="pl-5 text-muted-foreground">Expired <time dateTime={new Date(row.expires).toISOString()}>{new Date(row.expires).toLocaleString()}</time></span>
      </li>)}
    </ul>
    {!rows.length ? <p className="text-xs text-muted-foreground">No expired entries in the observed snapshot.</p> : null}
    <StateFlowView controls={controls} label={`Prepare clearing ${selected.length} ${noun}`} applyLabel={`Clear these ${noun}`} unavailable={unavailable} />
  </MaintenanceDisclosure>;
}
