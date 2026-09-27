import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall, socketSubscribe } from "@agentstack/api";
import type { Notification } from "../src/schema.js";

test("notifications persist, filter independently, update by revision, and dismiss all", async () => {
  const root = await mkdtemp(join(tmpdir(), "n-"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: root };
  let served = await serveApi({ name: "notifications", transport: "socket", env });
  const call = <T>(name: string, args: Record<string, unknown> = {}) => socketCall(served.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  let notices = 0;
  const subscription = await socketSubscribe(served.socketPath!, ["notifications_changed"], () => { notices += 1; });
  try {
    const id = "718f6656-b34c-400e-b996-093070880710";
    const first = await call<Notification>("notification_send", { id, title: "Build", message: "Started", source: "worker" });
    assert.equal(first.id, id);
    assert.equal(first.revision, 1);
    assert.equal(first.acknowledgedAt, null);
    assert.equal(first.dismissedAt, null);
    assert.deepEqual(await call("notification_send", { id, title: "Build", message: "Started", source: "worker" }), first);
    await assert.rejects(call("notification_send", { id, title: "Other", message: "Started", source: "worker" }), /notification_id_conflict/);
    const second = await call<Notification>("notification_send", { title: "Build", message: "Another", source: "worker" });
    const third = await call<Notification>("notification_send", { title: "Other", message: "Third" });
    const page = await call<{ entries: Notification[]; nextCursor: number | null }>("notification_list", { limit: 2 });
    assert.deepEqual(page.entries.map((row) => row.id), [third.id, second.id]);
    assert.equal(page.nextCursor, second.sequence);
    assert.deepEqual((await call<{ entries: Notification[] }>("notification_list", { before: page.nextCursor })).entries.map((row) => row.id), [first.id]);

    const updated = await call<Notification>("notification_update", { id, expectedRevision: 1, message: "Finished" });
    assert.equal(updated.revision, 2);
    assert.equal(updated.message, "Finished");
    await assert.rejects(call("notification_update", { id, expectedRevision: 1, title: "Stale" }), /notification_revision_conflict/);
    await assert.rejects(call("notification_update", { id, expectedRevision: 2 }), /notification_update_empty/);
    assert.equal((await call<Notification>("notification_acknowledge", { id })).acknowledgedAt !== null, true);
    const ack = await call<Notification>("notification_acknowledge", { id });
    assert.equal(ack.revision, 3);
    const dismissed = await call<Notification>("notification_dismiss", { id });
    assert.ok(dismissed.dismissedAt);
    assert.equal((await call<Notification>("notification_dismiss", { id })).revision, dismissed.revision);
    const editedDismissed = await call<Notification>("notification_update", { id, expectedRevision: dismissed.revision, title: "Updated" });
    assert.equal(editedDismissed.dismissedAt, dismissed.dismissedAt);
    assert.equal(editedDismissed.acknowledgedAt, ack.acknowledgedAt);
    assert.equal((await call<{ entries: Notification[] }>("notification_list", { dismissed: true, acknowledged: true })).entries.length, 1);
    assert.deepEqual((await call<{ entries: Notification[] }>("notification_list", { dismissed: false, acknowledged: false, source: "worker" })).entries.map((row) => row.id), [second.id]);
    assert.deepEqual(await call("notification_dismiss_all"), { dismissed: 2 });
    assert.deepEqual(await call("notification_dismiss_all"), { dismissed: 0 });
    assert.equal((await call<{ entries: Notification[] }>("notification_list", { dismissed: false })).entries.length, 0);
    assert.equal((await call<{ entries: Notification[] }>("notification_list", { acknowledged: false })).entries.length, 2);
    assert.deepEqual(await call("notification_send", { id, title: "Build", message: "Started", source: "worker" }), await call("notification_get", { id }));
    await assert.rejects(call("notification_get", { id: "212f6656-b34c-400e-b996-093070880710" }), /notification_not_found/);
    for (let i = 0; i < 20 && notices < 7; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notices >= 7, `expected change notices, got ${notices}`);
    await subscription.close();
    await served.close();
    served = await serveApi({ name: "notifications", transport: "socket", env });
    assert.deepEqual(await call("notification_get", { id }), editedDismissed);
    const afterRestart = await call<Notification>("notification_get", { id });
    assert.equal(afterRestart.title, "Updated");
    assert.ok(afterRestart.dismissedAt);
  } finally {
    await subscription.close();
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});
