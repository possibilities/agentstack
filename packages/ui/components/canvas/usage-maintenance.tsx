"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { accountLabels, providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { localOperation, stateOperations } from "@/lib/stack/state";
import { StateFlowView, useStateFlow } from "./state-flow";
import { useStack, useStore } from "./provider";
import { Section } from "./window";

type Choice = { id: string; scope: "bot" | "worker" };
const same = (a: Choice, b: Choice) => a.id === b.id && a.scope === b.scope;

/**
 * Clearing this machine's usage measurements for exact account/scope pairs (a Bot and a Worker login can share an
 * account ID) and, separately, the Grok Bot observation. Provider quota, billing and credentials are untouched, and
 * the next collection can measure again. Local operator only.
 */
export function UsageClearSection() {
  const state = useStack();
  const store = useStore();
  const { usage, accounts, workerAccounts, remote, status } = state;
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Choice[]>([]);
  const [grok, setGrok] = useState(false);
  const controls = useStateFlow({
    operations: stateOperations(store.call, "usage", { plan: "usage_observations_plan", apply: "usage_observations_clear", receipt: "usage_state_receipt_get" }, { accounts: chosen, grokBot: grok }),
    recoveryKey: "usage:observations",
  });
  const access = localOperation(state, "usage", "usage_observations_plan");
  if (remote || !access.available || !usage.data) return null;
  const locked = controls.flow.phase !== "idle";
  const botLabels = accountLabels(accounts.data), workerLabels = workerAccountLabels(workerAccounts.data);
  if (!open && !locked) return <Button size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => setOpen(true)}>Clear local measurements…</Button>;
  return (
    <Section title="Clear local measurements">
      <p className="text-[0.68rem] text-pretty text-muted-foreground">
        Removes what this machine has measured for the selected accounts. Provider quota, billing and sign-ins are not touched, and the next collection may measure again. Until then these accounts read as not yet measured, never as zero usage.
      </p>
      <ul aria-label="Usage observations" className="flex flex-col">
        {usage.data.accounts.map((account) => {
          const choice = { id: account.id, scope: account.scope };
          const label = (account.scope === "bot" ? botLabels : workerLabels).get(account.id) ?? shortId(account.id);
          return (
            <li key={`${account.scope}:${account.id}`}>
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" className="size-3.5 accent-destructive" disabled={locked} checked={chosen.some((item) => same(item, choice))}
                  onChange={() => setChosen(chosen.some((item) => same(item, choice)) ? chosen.filter((item) => !same(item, choice)) : [...chosen, choice])} />
                <span className="min-w-0 truncate">{label}</span>
                <span className="text-muted-foreground">{providerTitle(account.provider)} · {account.scope === "bot" ? "Bot account" : "Worker login"}</span>
              </label>
            </li>
          );
        })}
        {usage.data.grokBot ? (
          <li><label className="flex items-center gap-1.5 text-xs"><input type="checkbox" className="size-3.5 accent-destructive" disabled={locked} checked={grok} onChange={() => setGrok(!grok)} />
            Grok Bot observation <span className="text-muted-foreground">(separate from Grok Worker logins)</span></label></li>
        ) : null}
      </ul>
      <StateFlowView controls={controls} label="Prepare measurement clear" applyLabel="Clear these measurements"
        unavailable={status.usage !== "open" ? "The usage connection is not open." : !chosen.length && !grok ? "Select at least one observation." : null} />
      {!locked ? <Button size="xs" variant="ghost" className="self-start" onClick={() => { setOpen(false); setChosen([]); setGrok(false); }}>Cancel</Button> : null}
    </Section>
  );
}
