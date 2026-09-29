import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCommits, parseNameStatus, parseNumstat, readWorktreeDiff } from "../src/diff.js";

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", ["-C", cwd, ...args], { timeout: 10_000 }, (error, stdout) =>
    error ? reject(error) : resolve(stdout.trim())));
}

test("git -z listings parse paths with spaces, renames and binary counts", () => {
  assert.deepEqual(parseNameStatus("M\0a b.txt\0R087\0old.ts\0new.ts\0A\0added\0"), [
    { path: "a b.txt", oldPath: null, status: "modified", additions: null, deletions: null, binary: false },
    { path: "new.ts", oldPath: "old.ts", status: "renamed", additions: null, deletions: null, binary: false },
    { path: "added", oldPath: null, status: "added", additions: null, deletions: null, binary: false },
  ]);
  const counts = parseNumstat("3\t1\ta b.txt\0" + "2\t0\t\0old.ts\0new.ts\0" + "-\t-\timage.png\0");
  assert.deepEqual(counts.get("a b.txt"), { additions: 3, deletions: 1, binary: false });
  assert.deepEqual(counts.get("new.ts"), { additions: 2, deletions: 0, binary: false });
  assert.deepEqual(counts.get("image.png"), { additions: null, deletions: null, binary: true });
  assert.deepEqual(parseCommits("abc\x1fFix it\x1f1700000000\0\ndef\x1fSecond\x1f1700000001\0"), [
    { sha: "abc", subject: "Fix it", at: 1_700_000_000_000 }, { sha: "def", subject: "Second", at: 1_700_000_001_000 }]);
});

test("worker diffs read commits, uncommitted and untracked work without writing or running diff programs", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-worker-diff-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    await run(repo, ["init", "-b", "main"]);
    await run(repo, ["config", "user.name", "Fixture"]);
    await run(repo, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repo, "keep.txt"), "one\ntwo\n");
    await writeFile(join(repo, "old name.ts"), "export const value = 1;\n".repeat(20));
    await writeFile(join(repo, "gone.txt"), "bye\n");
    await run(repo, ["add", "."]);
    await run(repo, ["commit", "-m", "base"]);
    const base = await run(repo, ["rev-parse", "HEAD"]);
    const cwd = join(root, "worktree");
    await run(repo, ["worktree", "add", "-b", "stack-worker-fixture", cwd, base]);

    // A committed rename and edit, then uncommitted and untracked work.
    await run(cwd, ["mv", "old name.ts", "new name.ts"]);
    await writeFile(join(cwd, "keep.txt"), "one\ntwo\nthree\n");
    await run(cwd, ["commit", "-am", "Rename and extend"]);
    await run(cwd, ["rm", "-q", "gone.txt"]);
    await writeFile(join(cwd, "keep.txt"), "one\n2\nthree\n");
    await writeFile(join(cwd, "fresh.md"), "# New\n\nhello\n");
    await writeFile(join(cwd, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
    // A configured external diff must never run.
    const marker = join(root, "external-ran");
    const external = join(root, "external.sh");
    await writeFile(external, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(external, 0o700);
    await run(repo, ["config", "diff.external", external]);
    const statusBefore = await run(cwd, ["status", "--porcelain=v1"]);
    const indexPath = join(repo, ".git", "worktrees", "worktree", "index");
    const indexBefore = await readFile(indexPath);

    const summary = await readWorktreeDiff(cwd, base);
    assert.equal(summary.baseCommit, base);
    assert.equal(summary.head, await run(cwd, ["rev-parse", "HEAD"]));
    assert.deepEqual(summary.commits.map((commit) => commit.subject), ["Rename and extend"]);
    assert.equal(summary.uncommitted, true);
    assert.equal(summary.patch, null);
    const byPath = new Map(summary.files.map((file) => [file.path, file]));
    assert.deepEqual(byPath.get("new name.ts"), { path: "new name.ts", oldPath: "old name.ts", status: "renamed", additions: 0, deletions: 0, binary: false });
    assert.deepEqual(byPath.get("keep.txt"), { path: "keep.txt", oldPath: null, status: "modified", additions: 2, deletions: 1, binary: false });
    assert.equal(byPath.get("gone.txt")?.status, "deleted");
    assert.equal(byPath.get("fresh.md")?.status, "untracked");
    assert.equal(byPath.get("image.bin")?.status, "untracked");

    const one = await readWorktreeDiff(cwd, base, { path: "keep.txt" });
    assert.equal(one.path, "keep.txt");
    assert.match(one.patch!, /^-two$/m);
    assert.match(one.patch!, /^\+2$/m);
    assert.doesNotMatch(one.patch!, /fresh\.md/);
    const renamed = await readWorktreeDiff(cwd, base, { path: "new name.ts" });
    assert.match(renamed.patch!, /rename from old name\.ts/);
    const untracked = await readWorktreeDiff(cwd, base, { path: "fresh.md" });
    assert.match(untracked.patch!, /^\+hello$/m);
    await assert.rejects(readWorktreeDiff(cwd, base, { path: "../outside" }), /path is not changed/);
    await assert.rejects(readWorktreeDiff(cwd, base, { path: "--output=/tmp/x" }), /path is not changed/);

    const full = await readWorktreeDiff(cwd, base, { patch: true });
    assert.match(full.patch!, /diff --git a\/keep\.txt/);
    assert.match(full.patch!, /\+# New/);
    assert.equal(full.truncated, false);
    const cut = await readWorktreeDiff(cwd, base, { patch: true, maxChars: 40 });
    assert.equal(cut.patch!.length, 40);
    assert.equal(cut.truncated, true);

    await assert.rejects(stat(marker), /ENOENT/);
    assert.equal(await run(cwd, ["status", "--porcelain=v1"]), statusBefore);
    assert.deepEqual(await readFile(indexPath), indexBefore, "reads never rewrite the worktree index");
    await assert.rejects(readWorktreeDiff(join(root, "missing"), base), /no longer available/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
