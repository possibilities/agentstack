"use client";

import { localOperations, stateOperations } from "@/lib/stack/state";
import type { WorkerAccount } from "@/lib/stack/types";
import { useAuthActions } from "./auth-actions";
import { useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";

export function WorkerAccountCache({ account }: { account: WorkerAccount }) {
  const state = useStack();
  const store = useStore();
  const actions = useAuthActions().worker;
  const signingIn = actions.signingIn === account.id || state.workerAttempts[account.id]?.status === "pending";
  const disabled = !account.enabled && !account.removing;
  const signInKnown = state.status.auth === "open" && state.workerLogins.data !== null && !state.workerLogins.error;
  const runtimeKnown = state.status.worker === "open" && state.workerRuntimes.data !== null && !state.workerRuntimes.error && state.workerSessions.data !== null && !state.workerSessions.error;
  const live = state.workerRuntimes.data?.some((runtime) => runtime.id === account.id && (runtime.state !== "stopped" || runtime.pids.length > 0 || runtime.pid !== null))
    || state.workerSessions.data?.some((worker) => worker.accountId === account.id && worker.phase !== "closed");
  const controls = useStateFlow({ operations: stateOperations(store.call, "auth", { plan: "worker_account_cache_plan", apply: "worker_account_cache_clear", receipt: "auth_state_receipt_get" }, { accountId: account.id }),
    recoveryKey: `auth:account_cache:${account.id}`, observe: state.workerAccounts.at });
  if (state.remote || !localOperations(state, "auth", ["worker_account_cache_plan", "worker_account_cache_clear", "auth_state_receipt_get"]).available) return null;
  const unavailable = state.status.auth !== "open" ? "The auth connection is not open." : !account.id ? "Choose an exact account."
    : account.provider !== "codex" ? "Devin and Claude cache clearing is unsupported."
    : !disabled ? "Disable the account first; removal must not be in progress."
    : !signInKnown ? "Sign-in observation is unavailable." : signingIn ? "Wait for sign-in to finish or cancel it separately."
    : !runtimeKnown ? "Worker runtime observation is unavailable; drain cannot be inferred."
    : live ? "Drain this account's runtime separately before preparing." : null;
  return <MaintenanceDisclosure active={controls.flow.phase !== "idle"} aside="model cache">
    <p className="text-xs text-pretty text-muted-foreground">Clears only Codex/OpenCode <code>cache/opencode/models.json</code>. Devin and Claude are unsupported. Credentials, keychains, native sessions, sibling accounts and unknown cache files remain.</p>
    <ul aria-label="Model cache preconditions" className="flex flex-col gap-1 text-xs">
      <li>{disabled ? "Met" : "Not met"}: account disabled and not removing</li>
      <li>{!signInKnown ? "Unknown" : signingIn ? "Not met" : "Met"}: sign-in idle</li>
      <li>{!runtimeKnown ? "Unknown" : live ? "Not met" : "Observed"}: no active account runtime or open Worker</li>
    </ul>
    <p className="text-xs text-pretty text-muted-foreground">The plan proves runtime, catalog and teardown are drained and the allow-listed path is present and safe. These observations do not prove arbitrary external processes stopped. Nothing here drains, signs in or restarts implicitly.</p>
    <StateFlowView controls={controls} label="Prepare model cache clearing" applyLabel="Clear model cache" unavailable={unavailable} />
  </MaintenanceDisclosure>;
}
