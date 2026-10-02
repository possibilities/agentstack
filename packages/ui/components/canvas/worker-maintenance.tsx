"use client";

import { useState } from "react";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { WorkerSession } from "@/lib/stack/types";
import { workerNativeDisclosure, workerNativePreconditions, type WorkerStateKind } from "@/lib/stack/worker-maintenance";
import { useAuthActions } from "./auth-actions";
import { useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";

export const workerStateOperations = { plan: "worker_state_plan", apply: "worker_state_clear", receipt: "worker_state_receipt_get" };
const hint = "text-xs text-pretty text-muted-foreground";
const titles: Record<WorkerStateKind, string> = { git_reset: "Reset worktree", transcript: "Clear transcript", native_session: "Purge native session", branch: "Collect branch", catalog: "Clear model catalog" };

export function WorkerSessionMaintenance({ worker }: { worker: WorkerSession }) {
  const state = useStack();
  if (state.remote || !localOperations(state, "worker", Object.values(workerStateOperations)).available) return null;
  return <div className="flex flex-col gap-2">
    {(["transcript", "native_session", "branch", "catalog"] as const).filter((kind) => kind === "catalog" || worker.phase === "closed")
      .map((kind) => <WorkerMaintenance key={kind} worker={worker} kind={kind} />)}
  </div>;
}

export function WorkerMaintenance({ worker, kind }: { worker: WorkerSession; kind: WorkerStateKind }) {
  const state = useStack();
  if (state.remote || !localOperations(state, "worker", Object.values(workerStateOperations)).available || (kind !== "catalog" && worker.phase !== "closed")) return null;
  return <WorkerMaintenanceFlow worker={worker} kind={kind} />;
}

function WorkerMaintenanceFlow({ worker, kind }: { worker: WorkerSession; kind: WorkerStateKind }) {
  const state = useStack();
  const store = useStore();
  const actions = useAuthActions().worker;
  const [allowUnmerged, setAllowUnmerged] = useState(false);
  const conditions = workerNativePreconditions(worker, {
    account: state.workerAccounts.data?.find((account) => account.id === worker.accountId),
    accountKnown: state.status.auth === "open" && state.workerAccounts.data !== null && !state.workerAccounts.error,
    signInKnown: state.status.auth === "open" && state.workerLogins.data !== null && !state.workerLogins.error,
    signingIn: actions.signingIn === worker.accountId || state.workerAttempts[worker.accountId]?.status === "pending",
    runtimeKnown: state.status.worker === "open" && state.workerRuntimes.data !== null && !state.workerRuntimes.error,
    runtimes: state.workerRuntimes.data,
  });
  const controls = useStateFlow({ operations: stateOperations(store.call, "worker", workerStateOperations,
    { ids: [worker.id], kind, allowUnmerged: kind === "branch" && allowUnmerged ? [worker.id] : [] }),
    recoveryKey: `worker:${kind}:${worker.id}`, observe: state.workerGenerations[worker.id] ?? 0 });
  const locked = controls.flow.phase !== "idle";
  const plan = "plan" in controls.flow ? controls.flow.plan : null;
  const nativeDisclosure = kind === "native_session" && plan ? workerNativeDisclosure(plan) : null;
  const unmet = conditions.find((condition) => condition.state !== "Met");
  const unavailable = state.status.worker !== "open" ? "The worker connection is not open." : !worker.id ? "Choose an exact Worker."
    : kind !== "catalog" && worker.phase !== "closed" ? "Worker must be closed; nothing here closes it."
    : kind === "transcript" && worker.contentClearedAt !== null ? "Transcript content is already cleared."
    : kind === "native_session" && unmet ? `${unmet.state}: ${unmet.label}. Resolve this separately before preparing.`
    : kind === "native_session" && plan && !nativeDisclosure ? "The plan discloses no exact native IDs. Purge is unavailable."
    : kind === "git_reset" && (!worker.cwd || !worker.branch || !worker.baseCommit) ? "An exact owned worktree, branch and recorded base are required." : null;
  return <MaintenanceDisclosure title={kind === "git_reset" ? "Maintenance" : titles[kind]} active={locked} aside={kind === "git_reset" ? titles[kind] : "Worker maintenance"}>
    {kind === "git_reset" ? <>
      <p className={hint}>Resets only this closed Worker&rsquo;s owned linked worktree to its recorded base. All uncommitted tracked changes and index state are lost; exact non-Role untracked files are cleared. Review the changed files above and the owner&rsquo;s diff summary in this plan.</p>
      <p className={hint}>Commits stay at <code className="break-all">refs/stack/retained/{worker.id}</code>. Source checkout, remotes, backups and frozen Role files stay untouched.</p>
      <ul aria-label="Worktree reset preconditions" className="flex flex-col gap-1 text-xs">
        <li>Worker closed; exact owned linked worktree, branch and base required</li>
        <li>No different earlier retained tip, symlinks, submodules, special files or checkout filters</li>
        <li>HEAD, index and files must still match the plan; changed or uncertain ownership blocks apply</li>
      </ul>
      <p className={hint}>Worktree <code className="break-all">{worker.cwd}</code><br />Recorded base <code className="break-all">{worker.baseCommit}</code></p>
    </> : kind === "transcript" ? <>
      <p className={hint}>Redacts stored prompts, messages, tools and record bodies in Worker SQLite only. Turn IDs, admission digests, outcomes including unknown, usage, settings and captured HUD Work context stay.</p>
      <p className={hint}>Native sessions and HUD, Signal and Infer copies remain independent. This is logical clearing, not erasure of SQLite free pages, WAL, physical media or backups.</p>
    </> : kind === "native_session" ? <>
      <p className={hint}>Purge, not reset or reopen. One native root per account/plan; only exact IDs and verified descendants disclosed by the owner are selected.</p>
      <ul aria-label="Native purge preconditions" className="flex flex-col gap-1 text-xs">
        {conditions.map((condition) => <li key={condition.label}>{condition.state}: {condition.label}</li>)}
        <li>Owner plan must verify runtime, catalog and teardown drained</li>
        <li>macOS offline guard; OpenCode 2.0.16, Devin 3000.11.3 or Claude SDK 0.3.283 only</li>
        <li>Exact private profile, native ID and directory; no unsafe, absent or ambiguous scope or sibling Worker identities</li>
        <li>Quiesce untracked external native processes separately; local observations do not prove this</li>
      </ul>
      <p className={hint}>Credentials, keychain, profile, sibling sessions, provider logs/caches/shared blobs, external shares and backups remain. Command acceptance is not completion: absence and sibling/credential preservation must be verified. Unknown or partial results are never rerun.</p>
      {nativeDisclosure ? <section aria-label="Exact native purge IDs" className="flex flex-col gap-1 text-xs"><h4 className="font-medium">Exact native IDs from this plan</h4><p className="break-all font-mono">{nativeDisclosure}</p></section> : null}
    </> : kind === "branch" ? <>
      <BranchConsequences />
      <p className={hint}>This Worker record still references its branch, which blocks collection. The Retained branches section can select the recorded claim after separate Worker removal; nothing here removes a Worker.</p>
      {worker.branch ? <label className="flex items-start gap-1.5 text-xs"><input type="checkbox" checked={allowUnmerged} disabled={locked} onChange={(event) => setAllowUnmerged(event.target.checked)} />
        <span className="min-w-0 break-all">Allow unmerged collection for {worker.branch} · Worker {worker.id}</span></label> : null}
    </> : <>
      <p className={hint}>Clears account-wide derived Stack <code>catalog.json</code>, in-memory model observations and retry cache. Sibling Workers on this account lose the same shared catalog, not their sessions or settings. In-flight discovery blocks clearing.</p>
      <p className={hint}>Regeneration requires a later explicit native catalog observation. Clearing never signs in, launches a Worker, admits a turn or observes models automatically.</p>
    </>}
    <StateFlowView controls={controls} label={`Prepare ${titles[kind].toLowerCase()}`} applyLabel={titles[kind]} unavailable={unavailable} receiptOnlyRecovery />
  </MaintenanceDisclosure>;
}

export function BranchConsequences() {
  return <p className={hint}>Collects only recorded branches with no Worker record reference and no checkout in any worktree. Merge into the recorded base is required unless you deliberately allow unmerged collection for each exact branch. Remotes and retained refs stay. Quiesce external Git writers separately. A collected claim is permanently retired, never adoptable.</p>;
}
