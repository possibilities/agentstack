import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { clearStateFiles, listStateFiles, readStateFile, snapshotStateFiles } from "../src/state-files.js";
import { StateJournal } from "../src/state.js";

test("workspace observations fence changes and clear exact selections without following symlinks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stack-state-files-")));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    await mkdir(join(workspace, "output")); await writeFile(join(workspace, "output", "result"), Buffer.from([0, 1, 255, 2]));
    await writeFile(join(root, "external"), "keep outside"); await writeFile(join(workspace, "keep"), "keep sibling");
    await symlink(join(root, "external"), join(workspace, "link"));
    await symlink(root, join(workspace, "escape"));
    const page = await listStateFiles(workspace, { path: ".", offset: 0, limit: 2 });
    assert.equal(page.entries.length, 2); assert.equal(page.nextOffset, 2);
    const read = await readStateFile(workspace, { path: "output/result", offset: 1, length: 2 });
    assert.deepEqual(Buffer.from(read.data, "base64"), Buffer.from([1, 255])); assert.equal(read.nextOffset, 3);
    await assert.rejects(readStateFile(workspace, { path: "escape/external", offset: 0, length: 100 }));
    await assert.rejects(readStateFile(workspace, { path: "../external", offset: 0, length: 100 }));
    const selection = { paths: ["output", "link"] };
    const stale = await snapshotStateFiles(workspace, selection);
    await writeFile(join(workspace, "output", "result"), "new bytes");
    await assert.rejects(clearStateFiles(workspace, selection, stale), /changed/);
    assert.equal(await readFile(join(workspace, "output", "result"), "utf8"), "new bytes");
    const result = await clearStateFiles(workspace, selection, await snapshotStateFiles(workspace, selection));
    assert.equal(result.error, null);
    assert.equal(await readFile(join(root, "external"), "utf8"), "keep outside");
    assert.equal(await readFile(join(workspace, "keep"), "utf8"), "keep sibling");
    await assert.rejects(readFile(join(workspace, "output", "result")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a root reached through a symlinked ancestor works; a root that is itself a symlink is refused", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "stack-state-root-")));
  try {
    // Like macOS /tmp -> /private/tmp: the workspace path runs through a linked ancestor.
    const real = join(base, "real"); await mkdir(join(real, "workspace"), { recursive: true });
    await symlink(real, join(base, "alias"));
    const workspace = join(base, "alias", "workspace");
    await writeFile(join(workspace, "remove"), "selected"); await writeFile(join(workspace, "keep"), "sibling");
    await symlink(join(base, "real"), join(workspace, "escape"));
    assert.deepEqual((await listStateFiles(workspace, { path: ".", offset: 0, limit: 100 })).entries.map(entry => [entry.path, entry.type]),
      [["escape", "symlink"], ["keep", "file"], ["remove", "file"]]);
    assert.equal(Buffer.from((await readStateFile(workspace, { path: "keep", offset: 0, length: 100 })).data, "base64").toString(), "sibling");
    await assert.rejects(readStateFile(workspace, { path: "escape/workspace/keep", offset: 0, length: 100 }), "symlinks below the root are still never followed");
    const selection = { paths: ["remove"] };
    const result = await clearStateFiles(workspace, selection, await snapshotStateFiles(workspace, selection));
    assert.equal(result.error, null);
    await assert.rejects(readFile(join(real, "workspace", "remove")), { code: "ENOENT" });
    assert.equal(await readFile(join(real, "workspace", "keep"), "utf8"), "sibling");

    // A re-pointed ancestor between plan and apply is a changed selection, never a cleanup of the new target.
    await mkdir(join(base, "other", "workspace"), { recursive: true }); await writeFile(join(base, "other", "workspace", "keep"), "other");
    const planned = await snapshotStateFiles(workspace, { paths: ["keep"] });
    await rm(join(base, "alias")); await symlink(join(base, "other"), join(base, "alias"));
    await assert.rejects(clearStateFiles(workspace, { paths: ["keep"] }, planned), /changed/);
    assert.equal(await readFile(join(base, "other", "workspace", "keep"), "utf8"), "other");

    // The root itself must be a directory, and the path cannot be steered with dot components.
    await symlink(join(real, "workspace"), join(base, "linked-root"));
    await assert.rejects(listStateFiles(join(base, "linked-root"), { path: ".", offset: 0, limit: 100 }), /not a symlink/);
    await assert.rejects(listStateFiles(`${base}/real/../real/workspace`, { path: ".", offset: 0, limit: 100 }), /dot or parent/);
    await assert.rejects(listStateFiles("relative/root", { path: ".", offset: 0, limit: 100 }), /absolute/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("maintenance receipts survive restart and never redispatch an interrupted request", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-state-receipts-"));
  let journal = new StateJournal(join(root, "state.sqlite"), "example");
  try {
    const plan = journal.plan({ subject: { kind: "resource", id: "first-incarnation" }, action: "clear", revision: "generation-1",
      resources: ["owned-file"], blockedBy: [], retained: ["admission-receipt"], regeneration: [] }, { selected: "owned-file" });
    const input = { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() };
    journal.begin(input, plan); journal.close(); journal = new StateJournal(join(root, "state.sqlite"), "example");
    assert.equal(journal.existing(input)?.status, "unknown");
    assert.throws(() => journal.existing({ ...input, expectedRevision: "generation-2" }), /already used/);
    assert.throws(() => journal.getPlan(plan.id), /missing or consumed/);
    assert.equal(journal.receipt(input.requestId)?.retained[0], "admission-receipt");
  } finally { journal.close(); await rm(root, { recursive: true, force: true }); }
});
