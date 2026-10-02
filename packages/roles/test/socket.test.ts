import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoleSnapshot } from "../src/store.js";
import test from "node:test";
import { serveApi, socketCall, socketSubscribe } from "@stack/api";

async function createRole(socket: string): Promise<string> {
  const result = await socketCall(socket, "tools/call", { name: "roles_snapshot", arguments: {} }) as { defaultRoleId: string };
  return result.defaultRoleId;
}

test("capability harness allowlists persist, preserve omitted updates, and preview selection independently of instruction context", async () => {
  const root = await mkdtemp(join(tmpdir(), "role-cap-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  let served = await serveApi({ name: "roles", transport: "socket", env });
  const roleId = await createRole(served.socketPath!);
  const call = (name: string, args: Record<string, unknown> = {}) => socketCall(served.socketPath!, "tools/call", { name, arguments: { roleId, ...args } }) as Promise<any>;
  let revision = 0;
  const write = async (name: string, fields: Record<string, unknown>) => {
    assert.deepEqual(await call(name, { expectedRevision: revision, ...fields }), { roleId, revision: ++revision });
  };
  try {
    await write("skill_create", { name: "everywhere", description: "Universal", body: "Universal skill" });
    await write("skill_create", { name: "codex-only", description: "Restricted", body: "Restricted skill", harnesses: ["codex"] });
    await write("skill_create", { name: "nowhere", description: "No harness", body: "Not loaded", harnesses: [] });
    await write("mcp_server_create", { name: "claude-only", description: "Restricted", harnesses: ["claude"], definition: { type: "stdio", command: "/missing/unused", args: [] } });
    await write("role_internal_mcp_update", { name: "codex-computer-use", harnesses: ["codex", "opencode"] });
    await write("role_internal_mcp_update", { name: "notify", enabled: false, harnesses: ["claude"] });
    for (const name of ["computer-use", "codex-computer-use"]) await assert.rejects(call("mcp_server_create", {
      expectedRevision: revision, name, description: "Reserved even while excluded", enabled: false, harnesses: [],
      definition: { type: "stdio", command: "/missing/unused", args: [] },
    }), /collides/);
    const original = await call("role_editor_snapshot");
    const skillId = original.skills[1].id, mcpId = original.mcpServers[0].id;
    await write("skill_update", { id: skillId, body: "Edited without changing selection" });
    await write("mcp_server_update", { id: mcpId, description: "Edited without changing selection" });
    await write("role_internal_mcp_update", { name: "codex-computer-use", enabled: true });
    for (const harnesses of [["unknown"], ["Claude"], ["codex", "codex"], "claude"]) {
      await assert.rejects(call("skill_update", { expectedRevision: revision, id: skillId, harnesses }));
      await assert.rejects(call("mcp_server_update", { expectedRevision: revision, id: mcpId, harnesses }));
      await assert.rejects(call("role_internal_mcp_update", { expectedRevision: revision, name: "roles", harnesses }));
    }
    await assert.rejects(call("role_internal_mcp_update", { expectedRevision: revision - 1, name: "roles", harnesses: [] }), /stale/);
    await served.close();
    served = await serveApi({ name: "roles", transport: "socket", env });
    const snapshot = await call("role_editor_snapshot");
    assert.deepEqual(snapshot.skills.map((skill: any) => skill.harnesses), [null, ["codex"], []]);
    assert.deepEqual(snapshot.mcpServers[0].harnesses, ["claude"]);
    assert.deepEqual(snapshot.internalMcpHarnesses, { "codex-computer-use": ["codex", "opencode"], notify: ["claude"] });
    for (const [harness, skills, mcps, computer] of [[undefined, ["everywhere"], [], false], ["codex", ["everywhere", "codex-only"], [], true],
      ["opencode", ["everywhere"], [], true], ["claude", ["everywhere"], ["claude-only"], false], ["devin", ["everywhere"], [], false]] as const) {
      const preview = await call("role_launch_preview", { harness, context: { harness: "codex" } });
      assert.equal(preview.harness, harness ?? null);
      assert.deepEqual(preview.skills.map((skill: any) => skill.name), skills);
      assert.deepEqual(preview.mcpServers.map((mcp: any) => mcp.name), mcps);
      assert.equal(preview.config.includes("claude-only"), mcps.length > 0);
      const row = preview.internalMcpServers.find((server: any) => server.name === "codex-computer-use");
      assert.equal(row.enabled, true);
      assert.equal(row.included, computer);
      assert.equal(row.selectionReason, computer ? "included" : harness === undefined ? "harness_required" : "harness_mismatch");
      assert.equal(preview.internalMcpServers.find((server: any) => server.name === "notify").included, false, "harness matching never enables a disabled connection");
      assert.ok(preview.excludedCapabilities.some((item: any) => item.name === "nowhere" && item.reason === "harness_mismatch"));
    }
    await write("skill_update", { id: skillId, harnesses: null });
    await write("mcp_server_update", { id: mcpId, harnesses: null });
    await write("role_internal_mcp_update", { name: "codex-computer-use", harnesses: null });
    const cleared = await call("role_launch_preview");
    assert.deepEqual(cleared.skills.map((skill: any) => skill.name), ["everywhere", "codex-only"]);
    assert.deepEqual(cleared.mcpServers.map((server: any) => server.name), ["claude-only"]);
    assert.equal(cleared.internalMcpServers.find((server: any) => server.name === "codex-computer-use").included, true);
    assert.deepEqual((await call("role_snapshot")).internalMcpHarnesses, { notify: ["claude"] });
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});

test("fragment conditions persist and select exact context in both previews, with revisioned replacement and clearing", async () => {
  const root = await mkdtemp(join(tmpdir(), "role-cond-"));
  const env = { ...process.env, STACK_STATE_DIR: root };
  let served = await serveApi({ name: "roles", transport: "socket", env });
  const roleId = await createRole(served.socketPath!);
  const call = (name: string, args: Record<string, unknown> = {}) => socketCall(served.socketPath!, "tools/call", { name, arguments: { roleId, ...args } });
  try {
    await call("category_create", { expectedRevision: 0, title: "Rules" });
    let snapshot = await call("role_snapshot") as RoleSnapshot;
    const categoryId = snapshot.categories[0]!.id;
    let revision = 1;
    for (const [body, conditions] of [["Always", {}], ["Model", { model: "foo" }], ["Harness", { harness: "bar" }], ["Both", { model: "foo", harness: "bar" }]] as const) {
      await call("fragment_create", { expectedRevision: revision++, categoryId, title: body, body, conditions });
    }
    await served.close();
    served = await serveApi({ name: "roles", transport: "socket", env });
    snapshot = await call("role_snapshot") as RoleSnapshot;
    assert.deepEqual(snapshot.categories[0]!.fragments.map((f) => f.conditions), [{}, { model: "foo" }, { harness: "bar" }, { model: "foo", harness: "bar" }]);
    for (const [context, expected] of [[undefined, "Always"], [{ model: "foo" }, "Always\n\nModel"], [{ harness: "bar" }, "Always\n\nHarness"],
      [{ model: "foo", harness: "bar" }, "Always\n\nModel\n\nHarness\n\nBoth"], [{ model: "Foo", harness: "BAR" }, "Always"]] as const) {
      const preview = await call("role_preview", { context }) as { rendered: string; bytes: number; segments: Array<{ start: number; end: number }> };
      assert.equal(preview.rendered, expected);
      assert.equal(preview.bytes, Buffer.byteLength(expected));
      assert.deepEqual(preview.segments.map(({ start, end }) => preview.rendered.slice(start, end)), expected.split("\n\n"));
      const launch = await call("role_launch_preview", { context }) as { instructions: { bytes: number; fragments: number } };
      assert.equal(launch.instructions.bytes, preview.bytes);
      assert.equal(launch.instructions.fragments, preview.segments.length);
    }
    const id = snapshot.categories[0]!.fragments[3]!.id;
    for (const conditions of [{ unknown: "foo" }, { model: "" }, { harness: "  " }, { model: ["foo"] }])
      await assert.rejects(call("fragment_update", { expectedRevision: revision, id, conditions }));
    await assert.rejects(call("fragment_update", { expectedRevision: revision - 1, id, conditions: {} }), /stale/);
    await call("fragment_update", { expectedRevision: revision++, id, conditions: { model: "foo" } });
    await call("fragment_update", { expectedRevision: revision++, id, title: "Preserves conditions" });
    snapshot = await call("role_snapshot") as RoleSnapshot;
    assert.deepEqual(snapshot.categories[0]!.fragments[3]!.conditions, { model: "foo" });
    await call("fragment_update", { expectedRevision: revision++, id, conditions: {} });
    assert.equal((await call("role_preview") as { rendered: string }).rendered, "Always\n\nBoth");
    await assert.rejects(call("fragment_create", { expectedRevision: revision, categoryId, title: "Too big even when unmatched", body: "x".repeat(262_144), conditions: { model: "never" } }), /exceed/);
    assert.equal((await call("role_snapshot") as RoleSnapshot).revision, revision);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});

/** Resource writes acknowledge a revision; content assertions read the committed state separately. */
async function roleCall(socket: string, name: string, args: Record<string, unknown>) {
  const result = await socketCall(socket, "tools/call", { name, arguments: args });
  if (/^(category|fragment|skill|mcp_server|project)_/.test(name)) {
    assert.deepEqual(result, { roleId: args.roleId, revision: Number(args.expectedRevision) + 1 });
    return socketCall(socket, "tools/call", { name: "role_snapshot", arguments: { roleId: args.roleId } });
  }
  return result;
}

test("the roles Package API serves fragment CRUD and invalidates subscribers", async () => {
  const root = await mkdtemp("/tmp/as-role-");
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, STACK_STATE_DIR: root } });
  const path = served.socketPath!;
  const roleId = await createRole(path);
  const notices: string[] = [];
  const subscription = await socketSubscribe(path, ["role_changed"], (topic) => notices.push(topic));
  try {
    const empty = await socketCall(path, "tools/call", { name: "role_snapshot", arguments: { roleId } }) as { id: string; revision: number; categories: unknown[] };
    assert.equal(empty.id, roleId);
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.categories, []);
    const created = await roleCall(path, "category_create", { roleId, expectedRevision: 0, title: "General" }) as {
      revision: number; categories: Array<{ id: string }>;
    };
    assert.equal(created.revision, 1);
    await assert.rejects(socketCall(path, "tools/call", { name: "category_create", arguments: { roleId, expectedRevision: 0, title: "Lost update" } }), /stale role revision/);
    const added = await roleCall(path, "fragment_create", {
      roleId, expectedRevision: 1, categoryId: created.categories[0]!.id, title: "Rule", description: "Human-only", body: "Follow this rule.",
    }) as { revision: number };
    assert.equal(added.revision, 2);
    const preview = await socketCall(path, "tools/call", { name: "role_preview", arguments: { roleId } }) as {
      revision: number; rendered: string; bytes: number; limitBytes: number; segments: Array<{ fragmentId: string; start: number; end: number }>;
    };
    assert.equal(preview.rendered, "Follow this rule.");
    assert.equal(preview.revision, 2);
    assert.equal(preview.bytes, 17);
    assert.equal(preview.limitBytes, 262_144);
    assert.deepEqual(preview.segments.map(({ start, end }) => [start, end]), [[0, 17]]);
    const second = await roleCall(path, "category_create", { roleId, expectedRevision: 2, title: "Second" }) as {
      revision: number; categories: Array<{ id: string; fragments: Array<{ id: string }> }>;
    };
    const fragmentId = second.categories[0]!.fragments[0]!.id;
    const moved = await roleCall(path, "fragment_move", { roleId, expectedRevision: 3, id: fragmentId, categoryId: second.categories[1]!.id, index: 0 }) as {
      revision: number; categories: Array<{ fragments: Array<{ id: string; categoryId: string; updatedAt: number | null }> }>;
    };
    assert.equal(moved.revision, 4);
    assert.deepEqual(moved.categories.map((category) => category.fragments.map((fragment) => fragment.id)), [[], [fragmentId]]);
    assert.equal(typeof moved.categories[1]!.fragments[0]!.updatedAt, "number");
    assert.deepEqual(notices, ["role_changed", "role_changed", "role_changed", "role_changed"]);
  } finally {
    await subscription.close();
    await served.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted project operations expose explicit CRUD and enablement with role revisions", async () => {
  const root = await mkdtemp("/tmp/as-role-project-");
  const project = join(root, "project");
  await mkdir(project);
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, STACK_STATE_DIR: root } });
  const socket = served.socketPath!;
  const roleId = await createRole(socket);
  const call = (name: string, args: Record<string, unknown>) => roleCall(socket, name, { roleId, ...args }) as Promise<{
    revision: number; trustedProjects: Array<{ id: string; path: string; enabled: boolean }>;
  }>;
  try {
    await assert.rejects(call("project_create", { expectedRevision: 0, path: "relative" }), /absolute/);
    const created = await call("project_create", { expectedRevision: 0, path: project, description: "Reviewed repository" });
    assert.deepEqual(created.trustedProjects.map(({ path, enabled }) => ({ path, enabled })), [{ path: await realpath(project), enabled: true }]);
    const id = created.trustedProjects[0]!.id;
    const disabled = await call("project_update", { expectedRevision: created.revision, id, enabled: false });
    assert.equal(disabled.trustedProjects[0]?.enabled, false);
    const reordered = await call("project_reorder", { expectedRevision: disabled.revision, ids: [id] });
    const deleted = await call("project_delete", { expectedRevision: reordered.revision, id });
    assert.deepEqual(deleted.trustedProjects, []);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});

test("role skill and MCP operations support complete create, update, disable, reorder, and delete", async () => {
  const root = await mkdtemp("/tmp/as-role-resources-");
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, STACK_STATE_DIR: root } });
  const path = served.socketPath!;
  const roleId = await createRole(path);
  const call = (name: string, args: Record<string, unknown>) => roleCall(path, name, { roleId, ...args }) as Promise<{
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
    const definition = { type: "http", url: "https://mcp.example.test/tools?key=private-url", httpHeaders: { Authorization: "Bearer private-header" } };
    const http = await call("mcp_server_create", { expectedRevision: edited.revision, name: "remote", description: "Remote tools", definition });
    assert.equal(JSON.stringify(http).includes("private-"), false, "write responses omit connection definitions too");
    const summary = await call("role_snapshot", {});
    assert.deepEqual(summary.mcpServers, [{ id: http.mcpServers[0]!.id, name: "remote", description: "Remote tools", enabled: true, harnesses: null, transport: "http" }]);
    const launch = await socketCall(path, "tools/call", { name: "role_launch_snapshot", arguments: {} }) as { mcpServers: Array<{ definition: unknown }> };
    assert.deepEqual(launch.mcpServers[0]?.definition, definition, "launch state retains the real connection definition");
    const editor = await socketCall(path, "tools/call", { name: "role_editor_snapshot", arguments: { roleId } });
    assert.deepEqual(editor, launch, "the operator editor retains complete definitions independently of safe summaries");
    await assert.rejects(call("mcp_server_create", { expectedRevision: http.revision, name: "bots", description: "Collision", definition: { type: "http", url: "https://mcp.example.test/tools" } }), /collides with an internal MCP server/);
    const mcpId = http.mcpServers[0]!.id;
    const changed = await call("mcp_server_update", { expectedRevision: http.revision, id: mcpId, enabled: false, definition: { type: "stdio", command: "/usr/bin/env", args: ["private-argument"], env: { TOKEN: "private-env" } } });
    assert.equal(JSON.stringify(changed).includes("private-"), false);
    assert.equal(changed.mcpServers[0]?.enabled, false);
    const reordered = await call("mcp_server_reorder", { expectedRevision: changed.revision, ids: [mcpId] });
    const withoutMcp = await call("mcp_server_delete", { expectedRevision: reordered.revision, id: mcpId });
    assert.deepEqual(withoutMcp.mcpServers, []);
    const withoutSkill = await call("skill_delete", { expectedRevision: withoutMcp.revision, id });
    assert.deepEqual(withoutSkill.skills, []);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});

test("role_launch_preview reports enabled resources, trust per working directory, and launch-stopping MCP servers", async () => {
  const root = await mkdtemp("/tmp/as-role-launch-");
  const project = join(root, "project");
  const nested = join(project, "src");
  await mkdir(nested, { recursive: true });
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, STACK_STATE_DIR: root, STACK_MCP_PORT: "48743" } });
  const socket = served.socketPath!;
  const roleId = await createRole(socket);
  const call = (name: string, args: Record<string, unknown> = {}) => roleCall(socket, name, { roleId, ...args }) as Promise<any>;
  try {
    let state = await call("skill_create", { expectedRevision: 0, name: "review", description: "Review work", body: "# Review",
      files: [{ path: "check.sh", contentBase64: Buffer.from("true\n").toString("base64") }] });
    state = await call("skill_create", { expectedRevision: state.revision, name: "draft", description: "Off", body: "# Draft", enabled: false });
    state = await call("mcp_server_create", { expectedRevision: state.revision, name: "remote", description: "", definition: { type: "http", url: "https://mcp.example.test/tools", bearerTokenEnvVar: "ROLE_TOKEN" } });
    // The owner's own MCP listener is refused on write, including through a loopback alias.
    await assert.rejects(call("mcp_server_create", { expectedRevision: state.revision, name: "alias", description: "", definition: { type: "http", url: "http://localhost:48743/mcp/auth" } }), /cannot alias the internal MCP listener/);
    await assert.rejects(call("mcp_server_update", { expectedRevision: state.revision, id: state.mcpServers[0].id, definition: { type: "http", url: "http://127.0.0.1:48743/mcp/bots" } }), /cannot alias/);
    state = await call("project_create", { expectedRevision: state.revision, path: project });
    const preview = await call("role_launch_preview", { cwds: [nested, root, join(root, "missing")] });
    assert.equal(preview.revision, state.revision);
    assert.deepEqual(preview.skills.map(({ name, files, bytes }: any) => [name, files, bytes]), [["review", 1, 13]]);
    assert.deepEqual(preview.mcpServers.map(({ name, type }: any) => [name, type]), [["remote", "http"]]);
    assert.ok(preview.internalMcpServers.some((server: { name: string; enabled: boolean }) => server.name === "roles" && server.enabled));
    assert.equal(preview.config, '[mcp_servers.remote]\nurl = "https://mcp.example.test/tools"\nbearer_token_env_var = "ROLE_TOKEN"\nenabled = true\n');
    const canonical = await realpath(project);
    assert.deepEqual(preview.trustedProjects.map(({ path }: any) => path), [canonical]);
    assert.deepEqual(preview.cwds.map(({ path, trustedProjectIds }: any) => [path, trustedProjectIds.length]), [[await realpath(nested), 1], [await realpath(root), 0], [null, 0]]);
    assert.deepEqual(preview.issues, []);
    assert.equal(preview.snapshotChars, JSON.stringify(await call("role_editor_snapshot")).length);
    assert.equal(preview.snapshotLimitChars, 750_000);
    await assert.rejects(call("role_launch_preview", { cwds: ["relative"] }), /absolute/);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});
