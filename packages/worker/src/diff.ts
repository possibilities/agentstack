import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

export type DiffStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "unmerged" | "untracked" | "unknown";
export type DiffFile = { path: string; oldPath: string | null; status: DiffStatus; additions: number | null; deletions: number | null; binary: boolean };
export type DiffCommit = { sha: string; subject: string; at: number };
export type WorktreeDiff = {
  baseCommit: string; head: string; commits: DiffCommit[]; commitsTruncated: boolean; files: DiffFile[]; filesTruncated: boolean;
  uncommitted: boolean; path: string | null; patch: string | null; truncated: boolean;
};
export type DiffOptions = { path?: string; patch?: boolean; maxChars?: number };

const maxCommits = 200;
const maxFiles = 2_000;
// Git runs read-only: no optional index lock, no fsmonitor hook, no external diff or textconv program.
const safety = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "--no-pager"];
const diffFlags = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

/** stdout up to `limit` UTF-16 code units; a longer stream is cut and reported, not buffered. `ok` lists accepted exit codes. */
function git(cwd: string, args: string[], limit = 8_000_000, ok: number[] = [0]): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...safety, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    let truncated = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      text += chunk;
      if (text.length > limit) { text = text.slice(0, limit); truncated = true; child.kill("SIGTERM"); }
    });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (truncated || ok.includes(code ?? -1)) resolve({ text, truncated });
      else reject(new Error(`Git diff read failed: ${args.find((arg) => !arg.startsWith("-")) ?? args[0]}`));
    });
  });
}

const statuses: Record<string, DiffStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange", U: "unmerged" };

/** `git diff --name-status -z`: a status token, then one path, or two for renames and copies. */
export function parseNameStatus(text: string): DiffFile[] {
  const tokens = text.split("\0");
  const files: DiffFile[] = [];
  for (let index = 0; index < tokens.length && tokens[index];) {
    const code = tokens[index++];
    const status = statuses[code[0]] ?? "unknown";
    const two = status === "renamed" || status === "copied";
    const oldPath = two ? tokens[index++] : null;
    const path = tokens[index++];
    if (path === undefined) break;
    files.push({ path, oldPath, status, additions: null, deletions: null, binary: false });
  }
  return files;
}

/** `git diff --numstat -z`: counts, then a path, or an empty path followed by the old and new paths. Binary files count as `-`. */
export function parseNumstat(text: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const tokens = text.split("\0");
  const counts = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  for (let index = 0; index < tokens.length && tokens[index];) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[index++]);
    if (!match) continue;
    let path = match[3];
    if (!path) { index++; path = tokens[index++]; }
    if (path === undefined) break;
    const binary = match[1] === "-" && match[2] === "-";
    counts.set(path, { additions: binary ? null : Number(match[1]), deletions: binary ? null : Number(match[2]), binary });
  }
  return counts;
}

export function parseCommits(text: string): DiffCommit[] {
  return text.split("\0").filter(Boolean).map((line) => {
    const [sha, subject, at] = line.replace(/^\n/, "").split("\x1f");
    return { sha, subject: subject ?? "", at: Number(at) * 1_000 };
  });
}

/**
 * A Worker's changes in its retained worktree against its base commit, without
 * writing to it: branch commits, changed and untracked files, and optionally a
 * bounded patch for all files or one changed path. Uncommitted work is included.
 */
export async function readWorktreeDiff(cwd: string, baseCommit: string, options: DiffOptions = {}): Promise<WorktreeDiff> {
  try { await lstat(cwd); } catch { throw new Error("the Worker's worktree is no longer available"); }
  const maxChars = options.maxChars ?? 100_000;
  const [head, log, names, numstat, untracked, status] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["log", "-z", `--max-count=${maxCommits + 1}`, "--format=%H%x1f%s%x1f%ct", `${baseCommit}..HEAD`]),
    git(cwd, ["diff", ...diffFlags, "--name-status", "-z", baseCommit]),
    git(cwd, ["diff", ...diffFlags, "--numstat", "-z", baseCommit]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]),
  ]);
  const commits = parseCommits(log.text);
  const counts = parseNumstat(numstat.text);
  const changed = parseNameStatus(names.text).map((file) => ({ ...file, ...counts.get(file.path) }));
  const added = untracked.text.split("\0").filter(Boolean).map((path): DiffFile => ({ path, oldPath: null, status: "untracked", additions: null, deletions: null, binary: false }));
  const all = [...changed, ...added];
  let patch: string | null = null;
  let truncated = false;
  if (options.path !== undefined) {
    const file = all.find((item) => item.path === options.path);
    if (!file) throw new Error("path is not changed in this Worker's worktree");
    ({ text: patch, truncated } = await filePatch(cwd, baseCommit, file, maxChars));
  } else if (options.patch) {
    ({ text: patch, truncated } = await git(cwd, ["diff", ...diffFlags, baseCommit], maxChars));
    for (const file of added) {
      if (truncated) break;
      const next = await filePatch(cwd, baseCommit, file, maxChars - patch.length);
      patch += next.text;
      truncated = next.truncated;
    }
  }
  return {
    baseCommit, head: head.text.trim(), commits: commits.slice(0, maxCommits), commitsTruncated: commits.length > maxCommits,
    files: all.slice(0, maxFiles), filesTruncated: all.length > maxFiles || names.truncated || untracked.truncated,
    uncommitted: status.text.trim().length > 0, path: options.path ?? null, patch, truncated,
  };
}

/** One file's patch; an untracked file is shown as added with `--no-index`, which exits 1 when it differs. */
function filePatch(cwd: string, baseCommit: string, file: DiffFile, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (limit <= 0) return Promise.resolve({ text: "", truncated: true });
  if (file.status === "untracked") return git(cwd, ["diff", ...diffFlags, "--no-index", "--", "/dev/null", file.path], limit, [0, 1]);
  return git(cwd, ["diff", ...diffFlags, baseCommit, "--", ...(file.oldPath ? [file.oldPath] : []), file.path], limit);
}
