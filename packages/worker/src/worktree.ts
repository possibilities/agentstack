import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { renderInstructions, skillRecord, type RoleSnapshot } from "@agentstack/roles";

export type ClaimedWorktree = { repo: string; cwd: string; branch: string; baseCommit: string; sourceDirty: boolean;
  roleRevision: number; instructions: string };

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 20_000, maxBuffer: 1_000_000 }, (error, stdout) => {
      if (error) reject(new Error(`Git worktree operation failed: ${args[0]}`));
      else resolveResult(stdout.trim());
    });
  });
}

async function absent(path: string): Promise<void> {
  try { await lstat(path); throw new Error(`worker role directory already exists in the source branch: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function writeSkill(directory: string, value: unknown): Promise<void> {
  const skill = skillRecord.parse(value);
  if (!skill.enabled) return;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error(`worker harnesses cannot load role skill ${skill.name}`);
  const root = join(directory, skill.name);
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "SKILL.md"), `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`, { mode: 0o600 });
  for (const file of skill.files) {
    const path = join(root, file.path);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(file.contentBase64, "base64"), { mode: 0o600 });
  }
}

export async function claimWorktree(stateDir: string, id: string, source: string, baseRef: string | undefined, snapshot: RoleSnapshot): Promise<ClaimedWorktree> {
  if (!isAbsolute(source)) throw new Error("repository path must be absolute");
  const repo = await realpath(source);
  const root = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (repo !== await realpath(root)) throw new Error("repository path must name its Git worktree root");
  const baseCommit = await git(repo, ["rev-parse", "--verify", "--end-of-options", `${baseRef ?? "HEAD"}^{commit}`]);
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("Git did not resolve a commit");
  if (await git(repo, ["ls-tree", "--name-only", baseCommit, ".devin", ".opencode"]))
    throw new Error("the source branch already owns .devin or .opencode; refusing to overwrite its agent configuration");
  for (const value of snapshot.skills) {
    const skill = skillRecord.parse(value);
    if (skill.enabled && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name))
      throw new Error(`worker harnesses cannot load role skill ${skill.name}`);
    if (skill.enabled && skill.name === "prime") throw new Error("Role skill name prime is reserved for the worker's manual /prime command");
  }
  const sourceDirty = Boolean(await git(repo, ["status", "--porcelain=v1", "--untracked-files=normal"]));
  const parent = join(stateDir, "workers", "worktrees");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const cwd = join(parent, id);
  const branch = `agentstack-worker-${id}`;
  await absent(cwd);
  await git(repo, ["worktree", "add", "-b", branch, cwd, baseCommit]);
  try {
    await absent(join(cwd, ".devin"));
    await absent(join(cwd, ".opencode"));
    const devin = join(cwd, ".devin");
    const opencode = join(cwd, ".opencode");
    for (const directory of [devin, opencode]) {
      await mkdir(directory, { mode: 0o700 });
      // Self-ignored files belong to this worktree alone; never edit the shared Git exclude or a tracked root .gitignore.
      await writeFile(join(directory, ".gitignore"), "*\n", { mode: 0o600 });
      await writeFile(join(directory, "agentstack-owner.json"), JSON.stringify({ id }), { mode: 0o600 });
      await mkdir(join(directory, "skills"), { mode: 0o700 });
    }
    for (const skill of snapshot.skills) {
      await writeSkill(join(devin, "skills"), skill);
      await writeSkill(join(opencode, "skills"), skill);
    }
    const instructions = renderInstructions(snapshot);
    if (instructions) {
      const prime = join(devin, "skills", "prime");
      await mkdir(prime, { mode: 0o700 });
      await writeFile(join(prime, "SKILL.md"), `---\nname: prime\ndescription: Load this worker's AgentStack Role instructions when explicitly requested\ntriggers: [user]\n---\n\n${instructions}\n`, { mode: 0o600 });
    }
    if (await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("managed worker files are visible to Git; refusing to start");
    return { repo, cwd, branch, baseCommit, sourceDirty, roleRevision: snapshot.revision, instructions };
  } catch (error) {
    // Preserve the claimed worktree for inspection; a failed role materialization must not erase unknown files.
    throw error;
  }
}

export async function removeWorktree(claim: Pick<ClaimedWorktree, "repo" | "cwd" | "branch">, id: string): Promise<void> {
  if (!claim.cwd.endsWith(`/workers/worktrees/${id}`) || claim.branch !== `agentstack-worker-${id}`) throw new Error("unrecognized worker worktree claim");
  const listed = await git(claim.repo, ["worktree", "list", "--porcelain"]);
  const expected = await realpath(claim.cwd).catch(() => claim.cwd);
  let exact = false;
  for (const block of listed.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path && lines.includes(`branch refs/heads/${claim.branch}`) && await realpath(path).catch(() => path) === expected) exact = true;
  }
  if (!exact) {
    try { await lstat(claim.cwd); throw new Error("unregistered worker directory remains; inspect before removal"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  try {
    const marker = JSON.parse(await readFile(join(claim.cwd, ".devin", "agentstack-owner.json"), "utf8")) as { id?: string };
    if (marker.id !== id) throw new Error("worker worktree ownership marker changed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A crash between Git's worktree claim and Role materialization has no marker yet.
  }
  await git(claim.repo, ["worktree", "remove", "--force", claim.cwd]);
  // Keep the branch, including any worker commits, for later review.
}

function rolePath(stateDir: string, id: string): string { return join(stateDir, "workers", "roles", `${id}.json`); }

export async function saveWorkerRole(stateDir: string, id: string, snapshot: RoleSnapshot): Promise<void> {
  await mkdir(join(stateDir, "workers", "roles"), { recursive: true, mode: 0o700 });
  await writeFile(rolePath(stateDir, id), JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
}
/** SDK plugins avoid importing ambient/project Claude settings or pretending Role text is a user turn. */
export async function claudeRole(stateDir: string, id: string, snapshot: RoleSnapshot): Promise<{ instructions: string; pluginPath: string }> {
  const pluginPath = join(stateDir, "workers", "roles", id, "claude-plugin");
  // The snapshot is immutable; recreation on explicit recovery never changes ambient configuration.
  await rm(pluginPath, { recursive: true, force: true });
  await mkdir(join(pluginPath, ".claude-plugin"), { recursive: true, mode: 0o700 });
  await writeFile(join(pluginPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agentstack-role", version: "1.0.0" }), { mode: 0o600 });
  await mkdir(join(pluginPath, "skills"), { mode: 0o700 });
  for (const skill of snapshot.skills) await writeSkill(join(pluginPath, "skills"), skill);
  return { instructions: renderInstructions(snapshot), pluginPath };
}
export async function loadWorkerRole(stateDir: string, id: string): Promise<RoleSnapshot> {
  const snapshot = JSON.parse(await readFile(rolePath(stateDir, id), "utf8")) as RoleSnapshot;
  if (!Number.isInteger(snapshot.revision) || !Array.isArray(snapshot.skills) || !Array.isArray(snapshot.mcpServers))
    throw new Error("worker role snapshot is invalid");
  return snapshot;
}
export async function removeWorkerRole(stateDir: string, id: string): Promise<void> {
  await rm(rolePath(stateDir, id), { force: true });
  await rm(join(stateDir, "workers", "roles", id), { recursive: true, force: true });
}
