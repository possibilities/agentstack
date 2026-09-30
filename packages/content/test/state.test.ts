import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Collections } from "../src/collections.js";

test("CAS collection preserves shared references and aborted upload keys stay retired", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stack-content-clear-"))), store = new Collections(root);
  try {
    const bytes = Buffer.from("shared content"), digest = createHash("sha256").update(bytes).digest("hex");
    const first = store.put({ name: "first", kind: "file", mediaType: "text/plain", bytes });
    const second = store.put({ name: "second", kind: "file", mediaType: "text/plain", bytes });
    const stage = store.startStage(bytes.length, digest, "same-key"); store.appendStage(stage.id, 0, bytes); store.finishStage(stage.id);
    assert.ok((await store.storagePlan([digest])).blockedBy.length);
    store.removeItem(first.id, first.revision); store.removeItem(second.id, second.revision);
    assert.ok((await store.storagePlan([digest])).blockedBy.length);
    const listed = store.stageList(0, 100).stages[0]!; store.stageAbort(stage.id, listed.revision);
    assert.throws(() => store.startStage(bytes.length, digest, "same-key"), /aborted/);
    const plan = await store.storagePlan([digest]), input = { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() };
    assert.equal(store.storageCollect(input).status, "completed"); assert.equal(store.storageCollect(input).status, "completed");
    assert.throws(() => store.blob(digest), /ENOENT/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
