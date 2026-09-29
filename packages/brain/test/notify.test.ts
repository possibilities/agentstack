import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall, socketPath } from "@stack/api";
import { notifyStranded } from "../src/notify.js";
import { withBrainEnvironment } from "../src/paths.js";

test("Brain doctor records increases in the local notify Package API and resets at zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-notify-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const served = await serveApi({ name: "notify", transport: "socket", env });
  const list = async () => (await socketCall(socketPath("notify", env), "tools/call", {
    name: "notification_list", arguments: { source: "stack.brain.doctor" },
  })) as { entries: Array<{ id: string; title: string; message: string; source: string; group: string; outcome: string | null }> };
  try {
    await withBrainEnvironment(env, async () => {
      assert.deepEqual(await notifyStranded(0), { notified: false, reason: "cleared", stranded: 0, previous: null });
      assert.deepEqual(await notifyStranded(1), { notified: true, reason: "increased", stranded: 1, previous: null });
      assert.deepEqual(await notifyStranded(1), { notified: false, reason: "unchanged", stranded: 1, previous: 1 });
      assert.deepEqual(await notifyStranded(2), { notified: true, reason: "increased", stranded: 2, previous: 1 });
      assert.equal((await list()).entries.length, 2);
      assert.deepEqual(await notifyStranded(0), { notified: false, reason: "cleared", stranded: 0, previous: 2 });
      assert.deepEqual(await notifyStranded(1), { notified: true, reason: "increased", stranded: 1, previous: 0 });
    });
    const entries = (await list()).entries;
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(({ message }) => message), [
      "1 submitted link never became searchable.",
      "2 submitted links never became searchable.",
      "1 submitted link never became searchable.",
    ]);
    assert.ok(entries.every(({ title, source }) => title === "Stack Brain ingestion stranded" && source === "stack.brain.doctor"));
    assert.equal(new Set(entries.map(({ id }) => id)).size, 3);
    assert.ok(entries.every(({ group }) => group === "stack.brain.stranded"));
    assert.deepEqual(entries.map(({ outcome }) => outcome), [null, "replaced", "replaced"]);
  } finally {
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable notify socket leaves the baseline unchanged, and an uncertain send retries the same ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "as-notify-retry-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  const statePath = join(root, "brain", "doctor-notify.json");
  try {
    await withBrainEnvironment(env, async () => {
      assert.deepEqual(await notifyStranded(1), { notified: false, reason: "notify_unavailable", stranded: 1, previous: null });
      await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
      const served = await serveApi({ name: "notify", transport: "socket", env });
      try {
        const lostReply = async (signal: { id: string; title: string; message: string; source: string }) => {
          await socketCall(socketPath("notify", env), "tools/call", { name: "notification_send", arguments: signal });
          throw new Error("response lost after commit");
        };
        assert.deepEqual(await notifyStranded(1, { send: lostReply }), { notified: false, reason: "notify_unavailable", stranded: 1, previous: null });
        await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
        assert.deepEqual(await notifyStranded(1), { notified: true, reason: "increased", stranded: 1, previous: null });
        const records = (await socketCall(socketPath("notify", env), "tools/call", {
          name: "notification_list", arguments: { source: "stack.brain.doctor" },
        })) as { entries: Array<{ id: string }> };
        assert.equal(records.entries.length, 1);
        assert.equal(JSON.parse(await readFile(statePath, "utf8")).stranded, 1);
      } finally { await served.close(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
