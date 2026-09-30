import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { serveApi, socketCall, socketSubscribe } from "@stack/api";
import type { Notification } from "../src/schema.js";
import { NotificationStore } from "../src/store.js";
import { content } from "../src/schema.js";
import { randomUUID } from "node:crypto";

type Page = { entries: Notification[]; nextCursor: number | null };

test("cleared Notification bodies cannot be recreated by send or dismissal retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-notify-clear-")); let store = new NotificationStore(root);
  try {
    const id = randomUUID(), input = content.parse({ title: "private title", message: "private body", reply: "private prompt" });
    store.create({ id, ...input }); store.dismiss(id, { outcome: "replied", response: "private answer" });
    const plan = store.historyPlan([id]), apply = { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() };
    const receipt = store.historyClear(apply); store.close(); store = new NotificationStore(root);
    assert.deepEqual(store.historyClear(apply), receipt);
    const repeated = store.create({ id, ...input }).record;
    assert.ok(repeated.contentClearedAt); assert.equal(repeated.message, ""); assert.equal(repeated.response, null); assert.equal(repeated.outcome, "replied");
    assert.deepEqual(store.dismiss(id, { outcome: "replied", response: "private answer" }).record, repeated);
    assert.throws(() => store.dismiss(id, { outcome: "replied", response: "different answer" }), /already_dismissed/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("notifications persist, page, replace by group, and dismiss once with an outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "n-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  let served = await serveApi({ name: "notify", transport: "socket", env });
  const call = <T>(name: string, args: Record<string, unknown> = {}) => socketCall(served.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  let notices = 0;
  const subscription = await socketSubscribe(served.socketPath!, ["notify_changed"], () => { notices += 1; });
  try {
    const id = "718f6656-b34c-400e-b996-093070880710";
    const first = await call<Notification>("notification_send", { id, title: "Build", message: "Started", source: "worker" });
    assert.equal(first.id, id);
    assert.deepEqual([first.group, first.open, first.actions, first.reply], [null, null, [], null]);
    assert.deepEqual([first.dismissedAt, first.outcome, first.response], [null, null, null]);
    assert.deepEqual(await call("notification_send", { id, title: "Build", message: "Started", source: "worker" }), first);
    await assert.rejects(call("notification_send", { id, title: "Other", message: "Started", source: "worker" }), /notification_id_conflict/);
    await assert.rejects(call("notification_send", { title: "Bad", message: "Link", open: "javascript:alert(1)" }));
    await assert.rejects(call("notification_send", { title: "Bad", message: "Twice", actions: ["Yes", "Yes"] }));
    const second = await call<Notification>("notification_send", { title: "Build", message: "Another", source: "worker" });
    const third = await call<Notification>("notification_send", { title: "Other", message: "Third" });
    const page = await call<Page>("notification_list", { limit: 2 });
    assert.deepEqual(page.entries.map((row) => row.id), [third.id, second.id]);
    assert.equal(page.nextCursor, second.sequence);
    assert.deepEqual((await call<Page>("notification_list", { before: page.nextCursor })).entries.map((row) => row.id), [first.id]);

    // A group keeps one open notification; the earlier one is dismissed as replaced.
    const progress = await call<Notification>("notification_send", { title: "Deploy", message: "25%", group: "deploy:web", open: "https://example.com/deploy" });
    const done = await call<Notification>("notification_send", { title: "Deploy", message: "Done", group: "deploy:web", open: "https://example.com/deploy" });
    const replaced = await call<Notification>("notification_get", { id: progress.id });
    assert.equal(replaced.outcome, "replaced");
    assert.equal(replaced.dismissedAt, done.createdAt);
    assert.deepEqual((await call<Page>("notification_list", { group: "deploy:web", dismissed: false })).entries.map((row) => row.id), [done.id]);
    assert.deepEqual(await call("notification_send", { id: progress.id, title: "Deploy", message: "25%", group: "deploy:web", open: "https://example.com/deploy" }), replaced);
    assert.equal((await call<Notification>("notification_get", { id: done.id })).dismissedAt, null);

    const question = await call<Notification>("notification_send", { title: "Merge?", message: "Tests pass", actions: ["Merge", "Hold"], reply: "Why hold?" });
    assert.deepEqual(question.actions, ["Merge", "Hold"]);
    await assert.rejects(call("notification_dismiss", { id: question.id, outcome: "action", response: "Ship" }), /notification_response_invalid/);
    await assert.rejects(call("notification_dismiss", { id: question.id, outcome: "closed", response: "Merge" }), /notification_response_invalid/);
    await assert.rejects(call("notification_dismiss", { id: first.id, outcome: "replied", response: "Hi" }), /notification_response_invalid/);
    const answered = await call<Notification>("notification_dismiss", { id: question.id, outcome: "action", response: "Merge" });
    assert.deepEqual([answered.outcome, answered.response], ["action", "Merge"]);
    assert.ok(answered.dismissedAt);
    assert.deepEqual(await call("notification_dismiss", { id: question.id, outcome: "action", response: "Merge" }), answered);
    await assert.rejects(call("notification_dismiss", { id: question.id }), /notification_already_dismissed/);

    const opened = await call<Notification>("notification_dismiss", { id: done.id, outcome: "opened" });
    assert.deepEqual([opened.outcome, opened.response], ["opened", null]);
    const closed = await call<Notification>("notification_dismiss", { id });
    assert.deepEqual([closed.outcome, closed.response], ["closed", null]);
    assert.deepEqual(await call("notification_dismiss", { id }), closed);

    const reply = await call<Notification>("notification_send", { title: "Name?", message: "Pick a name", reply: "Name", group: "naming" });
    await call<Notification>("notification_send", { title: "Other group", message: "Open", group: "other" });
    assert.deepEqual((await call<Notification>("notification_dismiss", { id: reply.id, outcome: "replied", response: "Atlas" })).response, "Atlas");

    assert.deepEqual(await call("notification_counts"), { open: 3, total: 8, sources: [{ source: null, open: 2, total: 6 }, { source: "worker", open: 1, total: 2 }] });
    assert.deepEqual(await call("notification_dismiss_all", { group: "missing" }), { dismissed: 0 });
    assert.deepEqual(await call("notification_dismiss_all", { group: "other" }), { dismissed: 1 });
    assert.deepEqual(await call("notification_dismiss_all"), { dismissed: 2 });
    assert.deepEqual(await call("notification_dismiss_all"), { dismissed: 0 });
    assert.equal((await call<Page>("notification_list", { dismissed: false })).entries.length, 0);
    assert.deepEqual((await call<Page>("notification_list", { source: "worker" })).entries.map((row) => row.outcome), ["closed", "closed"]);
    await assert.rejects(call("notification_get", { id: "212f6656-b34c-400e-b996-093070880710" }), /notification_not_found/);
    for (let i = 0; i < 20 && notices < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notices >= 12, `expected change notices, got ${notices}`);
    await subscription.close();
    await served.close();
    served = await serveApi({ name: "notify", transport: "socket", env });
    assert.deepEqual(await call("notification_get", { id: question.id }), answered);
  } finally {
    await subscription.close();
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("notify folds version 1 acknowledgment into dismissal and keeps retries idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "n-v1-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  await mkdir(join(root, "notify"));
  const legacy = new DatabaseSync(join(root, "notify", "notifications.sqlite"));
  legacy.exec(`CREATE TABLE notifications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
    subtitle TEXT, source TEXT, initial_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    acknowledged_at TEXT, dismissed_at TEXT)`);
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"];
  const states: Array<[string | null, string | null]> = [[null, null], ["2026-09-27T01:00:00.000Z", null], [null, "2026-09-27T02:00:00.000Z"], ["2026-09-27T04:00:00.000Z", "2026-09-27T03:00:00.000Z"]];
  const insert = legacy.prepare(`INSERT INTO notifications (id, revision, title, message, subtitle, source, initial_digest, created_at, updated_at, acknowledged_at, dismissed_at)
    VALUES (?, 1, 'Legacy', 'Retained', NULL, 'brain', ?, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z', ?, ?)`);
  const digest = createHash("sha256").update(JSON.stringify(["Legacy", "Retained", null, "brain"])).digest("hex");
  ids.forEach((id, index) => insert.run(id, digest, ...states[index]!));
  legacy.close();
  const served = await serveApi({ name: "notify", transport: "socket", env });
  const call = <T>(name: string, args: Record<string, unknown> = {}) => socketCall(served.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  try {
    const rows = await Promise.all(ids.map((id) => call<Notification>("notification_get", { id })));
    assert.deepEqual(rows.map((row) => [row.dismissedAt, row.outcome]), [
      [null, null],
      ["2026-09-27T01:00:00.000Z", "opened"],
      ["2026-09-27T02:00:00.000Z", "closed"],
      ["2026-09-27T03:00:00.000Z", "opened"],
    ]);
    assert.ok(!("acknowledgedAt" in rows[0]!) && !("revision" in rows[0]!));
    assert.deepEqual(await call("notification_send", { id: ids[0], title: "Legacy", message: "Retained", source: "brain" }), rows[0]);
    const next = await call<Notification>("notification_send", { title: "After", message: "Migration" });
    assert.ok(next.sequence > rows[3]!.sequence);
  } finally {
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("notify adopts the prior notification store without losing history", async () => {
  const root = await mkdtemp(join(tmpdir(), "n-migrate-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  let served = await serveApi({ name: "notify", transport: "socket", env });
  try {
    const id = "718f6656-b34c-400e-b996-093070880711";
    const first = await socketCall(served.socketPath!, "tools/call", { name: "notification_send", arguments: { id, title: "Legacy", message: "Retained" } });
    await served.close();
    await rename(join(root, "notify"), join(root, "notifications"));
    served = await serveApi({ name: "notify", transport: "socket", env });
    assert.deepEqual(await socketCall(served.socketPath!, "tools/call", { name: "notification_get", arguments: { id } }), first);
    assert.ok((await stat(join(root, "notify", "notifications.sqlite"))).isFile());
    await assert.rejects(stat(join(root, "notifications")), { code: "ENOENT" });
    await served.close();
    await rename(join(root, "notify"), join(root, "notifications"));
    await stat(join(root, "notifications", "notifications.sqlite"));
    // A second store must not hide the first by silently choosing one.
    const fresh = await mkdtemp(join(root, "notify-"));
    await rename(fresh, join(root, "notify"));
    await assert.rejects(serveApi({ name: "notify", transport: "socket", env }), /notify_state_conflict/);
  } finally {
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});
