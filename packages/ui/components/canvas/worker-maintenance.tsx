"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { localOperations, stateOperations } from "@/lib/stack/state";
import type { WorkerBranch, WorkerBranchPage, WorkerSession } from "@/lib/stack/types";
import { workerBranchSelection, workerNativeDisclosure, workerNativePreconditions, type WorkerStateKind } from "@/lib/stack/worker-maintenance";
import { useAuthActions } from "./auth-actions";
import { usePagedRead } from "./owner-reads";
import { Time } from "./primitives";
import { useStack, useStore } from "./provider";
import { MaintenanceDisclosure, StateFlowView, useStateFlow } from "./state-flow";
import { Section } from "./window";

export const workerStateOperations = { plan: "worker_state_plan", apply: "worker_state_clear", receipt: "worker_state_receipt_get" };
const hint = "text-xs text-pretty text-muted-foreground";
const titles: Record<WorkerStateKind, string> = { git_reset: "Reset worktree", transcript: "Clear transcript", native_session: "Purge native session", branch: "Collect branch", catalog: "Clear model catalog" };

export function WorkerSessionMaintenance({ worker }: { worker: WorkerSession }) {
  const state = useStack();
  if (state.remote || !localOperations(state, "worker", Object.values(workerStateOperations)).available) return null;
  return <Section title="Maintenance">
    {(["transcript", "native_session", "branch", "catalog"] as const).filter((kind) => kind === "catalog" || worker.phase === "closed")
      .map((kind) => <WorkerMaintenance key={kind} worker={worker} kind={kind} />)}
  </Section>;
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
  const operations = stateOperations(store.call, "worker", workerStateOperations,
    { ids: [worker.id], kind, allowUnmerged: kind === "branch" && allowUnmerged ? [worker.id] : [] });
  const controls = useStateFlow({ operations: { ...operations, apply: (input) => {
    if (kind === "catalog") store.holdWorkerCatalog(worker.accountId);
    return operations.apply(input);
  } },
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

/** Claims outlive the Worker record and collection. This read is deliberately independent of list filters. */
export function RetainedWorkerBranches() {
  const state = useStack();
  if (state.remote || !localOperations(state, "worker", ["worker_state_branches", ...Object.values(workerStateOperations)]).available) return null;
  return <RetainedBranches />;
}

function RetainedBranches() {
  const state = useStack();
  const store = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [allowUnmerged, setAllowUnmerged] = useState<string[]>([]);
  const pages = usePagedRead<WorkerBranch>(async (offset, revision) => {
    try {
      const page = await store.call<WorkerBranchPage>("worker", "worker_state_branches", { offset, limit: 100, ...(revision ? { revision } : {}) });
      return { items: page.branches, revision: page.revision, nextOffset: page.nextOffset };
    } catch (error) {
      // This owner's revision refusal predates the shared pager's standard wording.
      if (error instanceof Error && error.message.includes("Worker branch inventory changed")) throw new Error("Worker branch inventory changed; restart paging");
      throw error;
    }
  }, "worker:branches", state.workerSessions.at ?? 0);
  const rows = pages.page?.items ?? [];
  const selection = workerBranchSelection(rows, selected, allowUnmerged);
  const controls = useStateFlow({ operations: stateOperations(store.call, "worker", workerStateOperations, selection ?? { ids: [], kind: "branch", allowUnmerged: [] }),
    recoveryKey: "worker:branch:ids", observe: state.workerSessions.at,
    onReceipt: (receipt) => { pages.refresh(); if (receipt.status === "completed") { setSelected([]); setAllowUnmerged([]); } },
  });
  const locked = controls.flow.phase !== "idle";
  const unavailable = state.status.worker !== "open" ? "The worker connection is not open." : pages.error ? "Refresh retained branches before preparing."
    : !selected.length ? "Select up to 100 recorded branches by Worker ID." : !selection ? "The selected claims changed; discard the plan and review the selection." : null;
  const select = (id: string) => {
    setSelected((held) => held.includes(id) ? held.filter((value) => value !== id) : [...held, id]);
    // Consent is revoked on deselection. Re-selecting a branch never brings an override back.
    setAllowUnmerged((held) => held.filter((value) => value !== id));
  };
  return <Section title="Retained branches" aside={<Button size="xs" variant="ghost" disabled={pages.loading || locked || state.status.worker !== "open"} onClick={pages.refresh}>Refresh branches</Button>}>
    <p className={hint}>Recorded claims, including removed Workers, independent of the Worker filters above. Refresh explicitly for external Git changes.</p>
    {pages.error ? <p role="alert" className="text-xs text-destructive">Branch inventory unavailable: {pages.error}</p> : null}
    {pages.page?.restarted ? <p className={hint}>The observation changed while paging; showing the first page again.</p> : null}
    <MaintenanceDisclosure active={locked} aside="branch collection">
      <BranchConsequences />
      <ul aria-label="Recorded Worker branches" className="flex max-h-64 flex-col gap-2 overflow-auto">
        {rows.map((row) => <li key={row.workerId} className="flex min-w-0 flex-col gap-1 text-xs">
          <label className="flex items-start gap-1.5"><input type="checkbox" aria-label={`Select branch Worker ${row.workerId}`} checked={selected.includes(row.workerId)}
            disabled={locked || row.collectedAt !== null || (!selected.includes(row.workerId) && selected.length >= 100)} onChange={() => select(row.workerId)} />
            <span className="min-w-0 break-all font-mono">{row.branch}</span></label>
          <span className="pl-5 break-all text-muted-foreground">Worker <code>{row.workerId}</code><br />{row.repo}<br />Recorded base <code>{row.baseCommit}</code></span>
          {row.collectedAt !== null ? <span className="pl-5 text-muted-foreground">collected — retired claim · <Time at={row.collectedAt} /></span> : <>
            {state.workerSessions.data?.some((worker) => worker.repo === row.repo && worker.branch === row.branch) ? <span className="pl-5 text-muted-foreground">Worker record still references this branch; the plan will block collection.</span> : null}
            <label className="flex items-start gap-1.5 pl-5"><input type="checkbox" aria-label={`Allow unmerged collection for ${row.branch}`} checked={allowUnmerged.includes(row.workerId)} disabled={locked || !selected.includes(row.workerId)}
              onChange={(event) => setAllowUnmerged((held) => event.target.checked ? [...held, row.workerId] : held.filter((id) => id !== row.workerId))} />
              <span className="min-w-0 break-all">Allow unmerged collection for {row.branch}</span></label>
          </>}
        </li>)}
      </ul>
      {!rows.length ? <p className={hint}>{pages.page ? "No recorded Worker branches." : "Reading retained branches…"}</p> : null}
      {pages.page?.nextOffset != null ? <Button size="xs" variant="ghost" disabled={pages.loading || locked || state.status.worker !== "open"} onClick={pages.more}>Load more branches</Button> : null}
      <StateFlowView controls={controls} label={`Prepare collecting ${selected.length} branches`} applyLabel="Collect these branches" unavailable={unavailable} receiptOnlyRecovery />
    </MaintenanceDisclosure>
  </Section>;
}
