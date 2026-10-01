import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SettingsStore } from "../src/store.js";
import type { StatePlan } from "@stack/api";

const apply = (plan: StatePlan) => ({ planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() });
test("receipt retirement preserves current, young and unknown-age edits, sibling selections and permanent delayed retry dedupe", async () => {
  const root = await mkdtemp(join(tmpdir(), "settings-receipts-")), path = join(root, "settings.sqlite");
  let db = new DatabaseSync(path), store = new SettingsStore(db, "bots");
  try {
    for (const subject of ["bot:one", "bot:sibling"]) store.seed(subject, {}, "fixture");
    const patch = (subject: string, model: string) => ({ expectedRevision: store.get(subject)!.revision, requestId: randomUUID(), set: { model } });
    const old = patch("bot:one", "old"), young = patch("bot:one", "young");
    const original = store.patch("bot:one", "codex-app-server", old);
    young.expectedRevision = 1; store.patch("bot:one", "codex-app-server", young);
    const current = patch("bot:one", "current"); store.patch("bot:one", "codex-app-server", current);
    const sibling = patch("bot:sibling", "sibling"); store.patch("bot:sibling", "codex-app-server", sibling);
    store.patch("bot:sibling", "codex-app-server", patch("bot:sibling", "later"));
    const legacy = randomUUID(); db.prepare("INSERT INTO managed_settings_receipts(request_id,intent,revision) VALUES(?,?,?)").run(legacy, "unknown legacy digest", 0);
    for (const id of [old.requestId, current.requestId, sibling.requestId]) db.prepare("UPDATE managed_settings_receipts SET created_at=? WHERE request_id=?").run(Date.now() - 8 * 86400_000, id);
    const loaded = store.get("bot:one")!; store.markLoaded("bot:one", "native-instance", loaded);
    const plan = store.receiptsPlan(["bot:one"], 7); assert.deepEqual(plan.resources, [old.requestId]);
    const request = apply(plan), receipt = store.receiptsClear(request); assert.equal(receipt.status, "completed");
    assert.deepEqual(store.receiptsClear(request), receipt);
    assert.deepEqual(store.get("bot:one"), loaded); assert.deepEqual(store.loaded("bot:one", "native-instance")!.values, loaded.values);
    for (const id of [young.requestId, current.requestId, sibling.requestId, legacy]) assert.ok(db.prepare("SELECT 1 FROM managed_settings_receipts WHERE request_id=?").get(id));
    assert.equal(db.prepare("SELECT 1 FROM managed_settings_receipts WHERE request_id=?").get(old.requestId), undefined);
    assert.deepEqual(store.patch("bot:one", "codex-app-server", old), { ...original, duplicate: true });
    assert.throws(() => store.patch("bot:one", "codex-app-server", { ...old, set: { model: "changed intent" } }), /reused/);
    const stale = store.receiptsPlan(["bot:sibling"], 7); store.patch("bot:sibling", "codex-app-server", patch("bot:sibling", "new revision"));
    assert.throws(() => store.receiptsClear(apply(stale)), /changed/);
    assert.throws(() => store.receiptsPlan(["bot:one"], 6), /seven days/);
    const interrupted = store.receiptsPlan(["bot:sibling"], 7), interruptedInput = apply(interrupted);
    store.maintenance.begin(interruptedInput, interrupted); db.close(); db = new DatabaseSync(path); store = new SettingsStore(db, "bots");
    assert.equal(store.receiptsClear(interruptedInput).status, "unknown"); assert.ok(db.prepare("SELECT 1 FROM managed_settings_receipts WHERE request_id=?").get(sibling.requestId));
    assert.deepEqual(store.receiptsClear(request), receipt);
    store.remove("bot:one"); store.seed("bot:one", {}, "new incarnation");
    assert.equal(store.patch("bot:one", "codex-app-server", old).duplicate, true);
    assert.deepEqual(store.get("bot:one")!.values, {}, "retired edits never replay into a recreated target");
    assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete", "embedded journal preserves owner's rollback mode");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
