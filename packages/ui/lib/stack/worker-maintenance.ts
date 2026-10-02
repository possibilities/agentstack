import type { StatePlan, WorkerAccount, WorkerBranch, WorkerRuntime, WorkerSession } from "./types";

export type WorkerStateKind = "git_reset" | "transcript" | "native_session" | "branch" | "catalog";

/** Exact selected claims only. An unmerged override is supplied separately by the human, never derived from Git. */
export function workerBranchSelection(rows: WorkerBranch[], ids: string[], allowUnmerged: string[]) {
  const selected = [...new Set(ids)];
  if (!selected.length || selected.length > 100 || selected.some((id) => !rows.some((row) => row.workerId === id && row.collectedAt === null))) return null;
  if (allowUnmerged.some((id) => !selected.includes(id))) return null;
  return { kind: "branch" as const, ids: selected, allowUnmerged: [...new Set(allowUnmerged)] };
}

/** This is the owner's disclosure, not the Worker record's possibly incomplete native root. Fail closed if absent. */
export function workerNativeDisclosure(plan: StatePlan): string | null {
  const prefix = "Exact native sessions and verified descendants selected: ";
  return plan.retained.find((entry) => entry.startsWith(prefix) && entry.slice(prefix.length).trim().length > 0) ?? null;
}

/** Local observations are necessary, not proof of the owner's catalog/teardown/provider fences. */
export function workerNativePreconditions(worker: WorkerSession, observation: {
  account: WorkerAccount | undefined; accountKnown: boolean; signInKnown: boolean; signingIn: boolean;
  runtimeKnown: boolean; runtimes: WorkerRuntime[] | null;
}): Array<{ label: string; state: "Met" | "Not met" | "Unknown" }> {
  const { account, accountKnown, signInKnown, signingIn, runtimeKnown, runtimes } = observation;
  const live = runtimes?.some((runtime) => runtime.id === worker.accountId && (runtime.state === "running" || runtime.pid !== null || runtime.pids.length > 0));
  return [
    { label: "Worker closed with exact native session and working directory", state: worker.phase === "closed" && !!worker.sessionId && !!worker.cwd ? "Met" : "Not met" },
    { label: "Account disabled, not removing, and provider matches", state: !accountKnown || !account ? "Unknown" : !account.enabled && !account.removing && account.provider === worker.provider ? "Met" : "Not met" },
    { label: "Sign-in idle", state: !signInKnown ? "Unknown" : signingIn ? "Not met" : "Met" },
    { label: "No active account runtime observed", state: !runtimeKnown ? "Unknown" : live ? "Not met" : "Met" },
  ];
}
