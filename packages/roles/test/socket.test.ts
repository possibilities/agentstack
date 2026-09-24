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
    const empty = await socketCall(path, "tools/call", { name: "role_snapshot", arguments: {} }) as { revision: number; categories: unknown[]; skills: unknown[]; mcpServers: unknown[] };
    assert.deepEqual(empty, { revision: 0, categories: [], skills: [], mcpServers: [] });
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

test("role skill and MCP operations support complete create, update, disable, reorder, and delete", async () => {
  const root = await mkdtemp("/tmp/as-role-resources-");
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, AGENTSTACK_STATE_DIR: root } });
  const path = served.socketPath!;
  const call = (name: string, args: Record<string, unknown>) => socketCall(path, "tools/call", { name, arguments: args }) as Promise<{
    revision: number; skills: Array<{ id: string; enabled: boolean; files: unknown[] }>; mcpServers: Array<{ id: string; enabled: boolean }>;
  }>;
  try {
    const skill = await call("skill_create", { expectedRevision: 0, name: "review", description: "Review work", body: "# Review" });
    assert.equal(skill.skills[0]?.enabled, true);
    const id = skill.skills[0]!.id;
    const edited = await call("skill_update", { expectedRevision: skill.revision, id, enabled: false, files: [{ path: "scripts/check.sh", contentBase64: Buffer.from("true\n").toString("base64") }] });
    assert.equal(edited.skills[0]?.enabled, false);
    assert.equal(edited.skills[0]?.files.length, 1);
    await assert.rejects(call("skill_update", { expectedRevision: edited.revision, id, files: [{ path: "../escape", contentBase64: "" }] }), /path|invalid/i);
    const http = await call("mcp_server_create", { expectedRevision: edited.revision, name: "remote", description: "Remote tools", definition: { type: "http", url: "https://mcp.example.test/tools" } });
    await assert.rejects(call("mcp_server_create", { expectedRevision: http.revision, name: "bots", description: "Collision", definition: { type: "http", url: "https://mcp.example.test/tools" } }), /collides with an internal Package API/);
    const mcpId = http.mcpServers[0]!.id;
    const changed = await call("mcp_server_update", { expectedRevision: http.revision, id: mcpId, enabled: false, definition: { type: "stdio", command: "/usr/bin/env", args: ["true"] } });
    assert.equal(changed.mcpServers[0]?.enabled, false);
    const reordered = await call("mcp_server_reorder", { expectedRevision: changed.revision, ids: [mcpId] });
    const withoutMcp = await call("mcp_server_delete", { expectedRevision: reordered.revision, id: mcpId });
    assert.deepEqual(withoutMcp.mcpServers, []);
    const withoutSkill = await call("skill_delete", { expectedRevision: withoutMcp.revision, id });
    assert.deepEqual(withoutSkill.skills, []);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});
