import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall, socketSubscribe } from "@agentstack/api";

test("the roles Package API serves fragment CRUD and invalidates subscribers", async () => {
  const root = await mkdtemp("/tmp/as-role-");
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, AGENTSTACK_STATE_DIR: root } });
  const path = served.socketPath!;
  const notices: string[] = [];
  const subscription = await socketSubscribe(path, ["role_changed"], (topic) => notices.push(topic));
  try {
    const empty = await socketCall(path, "tools/call", { name: "role_snapshot", arguments: {} }) as { revision: number; categories: unknown[] };
    assert.deepEqual(empty, { revision: 0, categories: [] });
    const created = await socketCall(path, "tools/call", { name: "category_create", arguments: { expectedRevision: 0, title: "General" } }) as {
      revision: number; categories: Array<{ id: string }>;
    };
    assert.equal(created.revision, 1);
    await assert.rejects(socketCall(path, "tools/call", { name: "category_create", arguments: { expectedRevision: 0, title: "Lost update" } }), /stale role revision/);
    const added = await socketCall(path, "tools/call", { name: "fragment_create", arguments: {
      expectedRevision: 1, categoryId: created.categories[0]!.id, title: "Rule", description: "Human-only", body: "Follow this rule.",
    } }) as { revision: number };
    assert.equal(added.revision, 2);
    const preview = await socketCall(path, "tools/call", { name: "role_preview", arguments: {} }) as { revision: number; rendered: string };
    assert.equal(preview.rendered, "Follow this rule.");
    assert.equal(preview.revision, 2);
    assert.deepEqual(notices, ["role_changed", "role_changed"]);
  } finally {
    await subscription.close();
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});
