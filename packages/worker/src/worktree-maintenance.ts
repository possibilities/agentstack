import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { clearStateFiles, snapshotStateFiles, stateHash, type FileSnapshot } from "@stack/api";
import { readWorktreeDiff } from "./diff.js";
import type { WorkerRecord } from "./ledger.js";

async function git(cwd: string, args: string[], ok = [0]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
  try { return (await promisify(execFile)("git", ["--no-pager", "--literal-pathspecs", "-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { env, timeout: 20_000, maxBuffer: 2_000_000 })).stdout; }
  catch (error) { if (ok.includes(Number((error as { code: unknown }).code))) return (error as { stdout: string }).stdout; throw new Error(`Worker Git maintenance failed: ${args[0]}`); }
}
const rolePath = (path: string) => [".devin", ".opencode"].some(root => path === root || path.startsWith(`${root}/`));
export type ResetObservation = { revision: string; head: string; retainedTip: string; files: FileSnapshot; untracked: string[]; untrackedFiles: FileSnapshot | null; summary: string; blockedBy: string[] };

async function owned(root: string, worker: WorkerRecord) {
  if (!worker.cwd || worker.cwd !== join(root, "workers", "worktrees", worker.id) || worker.branch !== `stack-worker-${worker.id}` || !worker.baseCommit) throw new Error("Worker has no exact owned worktree claim");
  for (const path of [root, join(root, "workers"), join(root, "workers", "worktrees"), worker.cwd]) {
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Worker worktree path is unsafe");
  }
  if (await realpath(worker.cwd) !== worker.cwd || await realpath(worker.repo) !== worker.repo) throw new Error("Worker worktree/source path changed");
  const common = (await git(worker.cwd, ["rev-parse", "--git-common-dir"])).trim();
  const sourceCommon = (await git(worker.repo, ["rev-parse", "--git-common-dir"])).trim();
  if (await realpath(resolve(worker.cwd, common)) !== await realpath(resolve(worker.repo, sourceCommon))) throw new Error("Worker worktree belongs to another repository");
  const listed = await git(worker.repo, ["worktree", "list", "--porcelain", "-z"]);
  const exact = listed.split("\0\0").filter(block => block.split("\0").includes(`worktree ${worker.cwd}`) && block.split("\0").includes(`branch refs/heads/${worker.branch}`));
  if (exact.length !== 1 || (await git(worker.cwd, ["symbolic-ref", "HEAD"])).trim() !== `refs/heads/${worker.branch}`) throw new Error("Worker worktree/branch claim changed");
}
export async function prepareWorkerReset(root: string, worker: WorkerRecord): Promise<ResetObservation> {
  await owned(root, worker);
  const [head, index, untracked, retainedTip, filters, baseTree, files, diff] = await Promise.all([
    git(worker.cwd!, ["rev-parse", "HEAD"]), git(worker.cwd!, ["ls-files", "--stage", "-z"]), git(worker.cwd!, ["ls-files", "--others", "-z"]),
    git(worker.repo, ["rev-parse", "--verify", `refs/stack/retained/${worker.id}`], [0, 128]),
    git(worker.repo, ["config", "--local", "--get-regexp", "^filter\\."], [0, 1]), git(worker.cwd!, ["ls-tree", "-r", "-z", worker.baseCommit!]), snapshotStateFiles(worker.cwd!, { all: true }), readWorktreeDiff(worker.cwd!, worker.baseCommit!),
  ]);
  const paths = untracked.split("\0").filter(path => path && !rolePath(path)).sort();
  const untrackedFiles = paths.length ? await snapshotStateFiles(worker.cwd!, { paths }) : null;
  const blockedBy = [ ...(worker.phase !== "closed" ? ["Worker must be closed; reset never cancels, closes or resumes it implicitly"] : []),
    ...(retainedTip.trim() && retainedTip.trim() !== head.trim() ? ["An earlier retained tip exists; preserve/reconcile it explicitly before another reset"] : []),
    ...(filters.trim() ? ["Repository has checkout filters; reset cannot execute arbitrary filter programs"] : []),
    ...(baseTree.split("\0").some(row => /^(120000|160000) /.test(row)) ? ["Recorded base contains symlinks/submodules; this scoped reset cannot verify safe checkout effects"] : []),
    ...files.entries.filter(entry => entry.type === "symlink" || entry.type === "special").map(entry => `${entry.path}: unsafe worktree content`),
  ];
  return { revision: stateHash([worker, head, index, paths, retainedTip, files, untrackedFiles]), head: head.trim(), retainedTip: retainedTip.trim(), files, untracked: paths, untrackedFiles, blockedBy,
    summary: `${diff.commits.length}${diff.commitsTruncated ? "+" : ""} commits, ${diff.files.length}${diff.filesTruncated ? "+" : ""} changed files; old tip retained at refs/stack/retained/${worker.id}` };
}
export async function resetWorkerWorktree(root: string, worker: WorkerRecord, observed: ResetObservation) {
  const current = await prepareWorkerReset(root, worker);
  if (current.revision !== observed.revision || current.blockedBy.length) throw new Error("Worker Git/files changed or blocked; prepare again");
  if (!current.retainedTip) await git(worker.repo, ["update-ref", `refs/stack/retained/${worker.id}`, observed.head, ""]);
  if (observed.untrackedFiles) {
    const result = await clearStateFiles(worker.cwd!, { paths: observed.untracked }, observed.untrackedFiles);
    if (result.error) throw new Error("Exact untracked removal partially failed; inspect retirement quarantine");
  }
  // This is only the validated, closed, ledger-owned linked worktree. Hooks and
  // configured checkout filters are disabled/refused, never a source checkout.
  await git(worker.cwd!, ["reset", "--hard", "--no-recurse-submodules", worker.baseCommit!]);
  if ((await git(worker.cwd!, ["rev-parse", "HEAD"])).trim() !== worker.baseCommit || (await git(worker.cwd!, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"])).trim()) throw new Error("Worker reset completion could not be verified");
}
export type BranchClaim = { workerId: string; repo: string; branch: string; baseCommit: string; collectedAt: number | null };
export async function prepareWorkerBranch(claim: BranchClaim, referenced: boolean, allowUnmerged: boolean) {
  if (claim.branch !== `stack-worker-${claim.workerId}` || await realpath(claim.repo) !== claim.repo) throw new Error("Unrecognized retained Worker branch claim");
  const [tip, listed, merged] = await Promise.all([git(claim.repo, ["rev-parse", "--verify", `refs/heads/${claim.branch}`]),
    git(claim.repo, ["worktree", "list", "--porcelain", "-z"]), git(claim.repo, ["branch", "--merged", claim.baseCommit, "--format=%(refname)"])]);
  const blockedBy = [...(referenced ? ["A Worker record still references this branch"] : []), ...(claim.collectedAt !== null ? ["Branch identity was already collected; a recreated branch is not adopted"] : []),
    ...(listed.split("\0").includes(`branch refs/heads/${claim.branch}`) ? ["Branch is checked out in a worktree"] : []),
    ...(!merged.split("\n").includes(`refs/heads/${claim.branch}`) && !allowUnmerged ? ["Unmerged into the recorded base commit; per-branch unmerged deletion must be explicitly selected"] : [])];
  return { revision: stateHash([claim, tip, listed, merged.split("\n").includes(`refs/heads/${claim.branch}`), referenced, allowUnmerged]), tip: tip.trim(), blockedBy };
}
export async function collectWorkerBranch(claim: BranchClaim, observed: Awaited<ReturnType<typeof prepareWorkerBranch>>, referenced: boolean, allowUnmerged: boolean) {
  const current = await prepareWorkerBranch(claim, referenced, allowUnmerged);
  if (current.revision !== observed.revision || current.blockedBy.length) throw new Error("Retained branch changed or blocked");
  // Git's branch deletion itself refuses a branch checked out in any worktree.
  // External repository writers must also be quiesced by the operator.
  await git(claim.repo, ["branch", "-D", "--", claim.branch]);
}
