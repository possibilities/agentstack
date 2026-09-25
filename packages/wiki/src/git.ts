import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_STATE_DIRECTORY } from "./vault.js";

const GITIGNORE = `# The index is derived from the files and rebuilt by any read; -wal and -shm
# are live SQLite runtime state, meaningless outside the running process.
${VAULT_STATE_DIRECTORY}/index.sqlite3*

.DS_Store
`;

const DERIVED_INDEX_FILES = [
  `${VAULT_STATE_DIRECTORY}/index.sqlite3`,
  `${VAULT_STATE_DIRECTORY}/index.sqlite3-shm`,
  `${VAULT_STATE_DIRECTORY}/index.sqlite3-wal`,
];

export interface GitReport {
  repo: boolean;
  branch: string | null;
  remote: string | null;
  last_commit: { sha: string; subject: string; date: string } | null;
  unpushed: number | null;
  clean: boolean;
}

interface StagedChange {
  status: string;
  path: string;
}

/** Every git call here is best-effort. The files are the source of truth and
 * the vault works identically without history, so a missing binary, a
 * read-only checkout, or an unreachable remote must never turn a read into an
 * error. */
function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

/** The vault must be the repository root, not merely inside one: a vault under
 * a repo'd $HOME would otherwise commit documents into that repository. */
export function isRepo(root: string): boolean {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  return top.ok && samePath(top.out, root);
}

/** Idempotent, and run on every write rather than only at creation: a vault
 * made by hand, restored from a backup, or predating this code would otherwise
 * never gain a history at all. */
export function ensureGit(root: string): boolean {
  if (!existsSync(root)) return false;
  if (!isRepo(root) && !git(root, ["init", "--quiet"]).ok) return false;
  const ignorePath = join(root, ".gitignore");
  if (!existsSync(ignorePath)) {
    try {
      writeFileSync(ignorePath, GITIGNORE);
    } catch {
      return false;
    }
  }
  untrackDerivedIndex(root);
  return true;
}

/** A vault committed before the ignore file existed carries the index in its
 * history and goes dirty on every read until the tracked copy is dropped. */
function untrackDerivedIndex(root: string): void {
  const tracked = DERIVED_INDEX_FILES.filter(
    (path) => git(root, ["ls-files", "--error-unmatch", path]).ok,
  );
  if (tracked.length === 0) return;
  git(root, ["rm", "--cached", "--quiet", ...tracked]);
}

/** A machine with no configured identity would fail every commit, and the
 * vault's history matters more than the name attached to it. */
function identity(root: string): string[] {
  if (git(root, ["config", "user.email"]).out !== "") return [];
  return ["-c", "user.name=agentwiki", "-c", "user.email=agentwiki@localhost"];
}

function parseStaged(out: string): StagedChange[] {
  const changes: StagedChange[] = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    const path = parts[parts.length - 1] ?? "";
    if (path === "") continue;
    changes.push({ status, path });
  }
  return changes;
}

/** Mechanical, and deliberately not a summary: git's own status letters and
 * literal paths, with nothing inferred about what the change meant. Prose about
 * a change belongs in the document it changed. A single change needs no body,
 * because the subject already states it exactly. */
function messageFor(changes: StagedChange[]): { subject: string; body: string } {
  const only = changes[0];
  if (changes.length === 1 && only !== undefined) {
    return { subject: `${only.status} ${only.path}`, body: "" };
  }
  return {
    subject: `${changes.length} files changed`,
    body: changes.map((change) => `${change.status}  ${change.path}`).join("\n"),
  };
}

/** Returns whether a commit was actually made, so the caller can skip the push
 * when nothing moved. */
export function commitVault(root: string, message?: string): boolean {
  if (!isRepo(root)) return false;
  if (!git(root, ["add", "--all"]).ok) return false;
  // `diff --cached --quiet` exits 0 when the staging area is empty, which is
  // the common case: most commands change nothing.
  if (git(root, ["diff", "--cached", "--quiet"]).ok) return false;
  const changes = parseStaged(git(root, ["diff", "--cached", "--name-status"]).out);
  if (changes.length === 0) return false;
  const derived = messageFor(changes);
  const args = [...identity(root), "commit", "--quiet", "-m", message ?? derived.subject];
  if (message === undefined && derived.body !== "") args.push("-m", derived.body);
  return git(root, args).ok;
}

/** Detached and unwatched: a read must not wait on the network. A push that
 * fails simply leaves the commits for the next one to carry, and `doctor`
 * reports the backlog. */
export function pushVault(root: string): void {
  if (git(root, ["remote"]).out === "") return;
  try {
    const child = spawn("git", ["push", "--quiet", "origin", "HEAD"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // A push that cannot start is indistinguishable from one that fails.
  }
}

/** The single hook every command runs through. Agents edit vault files with
 * their own tools, so the only moment agentwiki can observe a change is after
 * a command has finished. */
export function syncVault(root: string): void {
  if (!commitVault(root)) return;
  pushVault(root);
}

export function gitReport(root: string): GitReport {
  if (!isRepo(root)) {
    return {
      repo: false,
      branch: null,
      remote: null,
      last_commit: null,
      unpushed: null,
      clean: true,
    };
  }
  const head = git(root, ["log", "-1", "--format=%h%x1f%s%x1f%cI"]).out;
  const parts = head === "" ? [] : head.split("\u001f");
  const ahead = git(root, ["rev-list", "--count", "@{upstream}..HEAD"]);
  return {
    repo: true,
    branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out || null,
    remote: git(root, ["remote", "get-url", "origin"]).out || null,
    last_commit:
      parts.length === 3
        ? { sha: parts[0] ?? "", subject: parts[1] ?? "", date: parts[2] ?? "" }
        : null,
    // No upstream is not a backlog of zero — it is an unanswerable question.
    unpushed: ahead.ok ? Number(ahead.out) : null,
    clean: git(root, ["status", "--porcelain"]).out === "",
  };
}
