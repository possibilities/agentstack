import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { stateHash, type StateOutcome } from "@stack/api";
import { observeFactoryWorktree, removeFactoryWorktree } from "./worktree-maintenance.js";
import type { WorkerRecord } from "./ledger.js";

export async function observeWorkerFactoryReset(root: string) {
  const db = new DatabaseSync(join(root, "workers.sqlite"), { readOnly: true });
  try {
    const claims = db.prepare("SELECT id,repo,cwd,branch,base_commit AS baseCommit FROM workers WHERE cwd IS NOT NULL ORDER BY id").all() as Pick<WorkerRecord, "id" | "repo" | "cwd" | "branch" | "baseCommit">[];
    const blockedBy: string[] = [], worktrees: Awaited<ReturnType<typeof observeFactoryWorktree>>[] = [];
    if (claims.length > 1000) throw new Error("Worker factory-reset scope exceeds the bounded owner inspection budget");
    const deadline = Date.now() + 30_000;
    for (const claim of claims) {
      if (Date.now() >= deadline) throw new Error("Worker factory-reset ownership inspection deadline exceeded");
      z.uuid().parse(claim.id);
      try { worktrees.push(await observeFactoryWorktree(root, claim)); }
      catch { blockedBy.push(`worker:${claim.id}: exact owned linked worktree/source/branch proof unavailable`); }
    }
    const directory = join(root, "workers", "worktrees");
    if (existsSync(directory)) for (const id of readdirSync(directory)) if (!claims.some(claim => claim.id === id)) blockedBy.push("Unattributed Worker worktree directory remains; inspect/remove through its owner before installation reset");
    return { revision: stateHash([worktrees, blockedBy]), worktrees, blockedBy };
  } finally { db.close(); }
}
export async function clearWorkerFactoryWorktrees(root: string, expected: Awaited<ReturnType<typeof observeWorkerFactoryReset>>, progress: (outcome: StateOutcome) => void) {
  const current = await observeWorkerFactoryReset(root);
  if (current.revision !== expected.revision || current.blockedBy.length) throw new Error("Worker factory-reset worktree scope changed or is unverified");
  for (const worktree of current.worktrees) {
    await removeFactoryWorktree(root, worktree);
    progress({ resource: `worker:${worktree.claim.id}`, outcome: "removed", detail: "Exact owned linked worktree removed/absent; source checkout, branch/commits/retained refs and other worktrees preserved" });
  }
}
