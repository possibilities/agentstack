import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall } from "@stack/api";
import { RoleStore, type RoleCatalog, type RoleSnapshot } from "../src/store.js";

test("catalog revisions fence creation, default changes and deletion without invalidating unrelated role edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-multi-role-"));
  const store = new RoleStore(root);
  const other = new RoleStore(root);
  try {
    assert.deepEqual(store.catalog(), { revision: 0, defaultRoleId: null, roles: [] });
    assert.throws(() => store.defaultSnapshot(), /no default role/);
    let catalog = store.createRole(0, "First");
    const first = catalog.defaultRoleId!;
    assert.equal(catalog.roles[0]!.id, first);
    assert.throws(() => other.createRole(0, "Racing first"), /stale role catalog revision/);
    assert.throws(() => store.createRole(catalog.revision, " FIRST "), /UNIQUE/);
    assert.equal(store.catalog().revision, catalog.revision);
    catalog = store.createRole(catalog.revision, "Second");
    const second = catalog.roles[1]!.id;
    assert.equal(catalog.defaultRoleId, first);
    const firstContents = store.role(first);
    const before = firstContents.snapshot();
    assert.throws(() => store.setDefault(catalog.revision, randomUUID()), /unknown role/);
    assert.throws(() => store.deleteRole(catalog.revision, first), /cannot delete the default/);
    catalog = other.setDefault(catalog.revision, second);
    assert.equal(store.defaultSnapshot().id, second);
    assert.equal(firstContents.snapshot().revision, before.revision);
    // A default switch does not retarget an editor or consume its role revision.
    const edited = firstContents.update(before.revision, { name: "Renamed", description: "Kept separate" });
    assert.equal(edited.id, first);
    assert.equal(store.defaultSnapshot().name, "Second");
    assert.throws(() => other.deleteRole(catalog.revision, first), /stale role catalog revision/);
    assert.throws(() => firstContents.update(before.revision, { name: "Lost" }), /stale role revision/);
    const deleted = store.deleteRole(store.catalog().revision, first);
    assert.deepEqual(deleted.roles.map(({ id }) => id), [second]);
    assert.throws(() => firstContents.snapshot(), /unknown role/);
    assert.throws(() => store.deleteRole(deleted.revision, second), /cannot delete the default/);
    assert.equal(other.defaultSnapshot().id, second);
  } finally { store.close(); other.close(); await rm(root, { recursive: true, force: true }); }
});

test("all Role resources are isolated, names and order are local, and deleting a Role removes only its content", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-isolation-"));
  const store = new RoleStore(root);
  try {
    let catalog = store.createRole(0, "One");
    catalog = store.createRole(catalog.revision, "Two");
    const [one, two] = catalog.roles.map(({ id }) => store.role(id));
    const populate = (role: NonNullable<typeof one>) => {
      let state = role.createCategory(0, "Same category");
      state = role.createFragment(state.revision, state.categories[0]!.id, "Same fragment", state.name);
      state = role.createSkill(state.revision, "same", "A skill", state.name);
      state = role.createMcpServer(state.revision, "same", "MCP", { type: "stdio", command: state.name, args: [] });
      return role.createTrustedProject(state.revision, root);
    };
    const a = populate(one!);
    const b = populate(two!);
    assert.equal(b.categories[0]!.fragments[0]!.body, "Two");
    const categoryId = a.categories[0]!.id;
    const fragmentId = a.categories[0]!.fragments[0]!.id;
    const attempts = [
      () => two!.updateCategory(b.revision, categoryId, { enabled: false }),
      () => two!.deleteCategory(b.revision, categoryId),
      () => two!.reorderCategories(b.revision, [categoryId]),
      () => two!.createFragment(b.revision, categoryId, "Wrong", "Wrong"),
      () => two!.updateFragment(b.revision, fragmentId, { body: "Wrong" }),
      () => two!.deleteFragment(b.revision, fragmentId),
      () => one!.moveFragment(a.revision, fragmentId, b.categories[0]!.id, 0),
      () => two!.reorderFragments(b.revision, categoryId, [fragmentId]),
      () => two!.updateSkill(b.revision, a.skills[0]!.id, { body: "Wrong" }),
      () => two!.deleteSkill(b.revision, a.skills[0]!.id),
      () => two!.reorderSkills(b.revision, [a.skills[0]!.id]),
      () => two!.updateMcpServer(b.revision, a.mcpServers[0]!.id, { enabled: false }),
      () => two!.deleteMcpServer(b.revision, a.mcpServers[0]!.id),
      () => two!.reorderMcpServers(b.revision, [a.mcpServers[0]!.id]),
      () => two!.updateTrustedProject(b.revision, a.trustedProjects[0]!.id, { enabled: false }),
      () => two!.deleteTrustedProject(b.revision, a.trustedProjects[0]!.id),
      () => two!.reorderTrustedProjects(b.revision, [a.trustedProjects[0]!.id]),
    ];
    for (const attempt of attempts) assert.throws(attempt, /unknown|exactly once/);
    assert.deepEqual(one!.snapshot(), a);
    assert.deepEqual(two!.snapshot(), b);
    store.setDefault(store.catalog().revision, b.id);
    store.deleteRole(store.catalog().revision, a.id);
    assert.deepEqual(store.defaultSnapshot(), b);
    const reopened = new RoleStore(root);
    try { assert.deepEqual(reopened.defaultSnapshot(), b); assert.equal(reopened.catalog().roles.length, 1); }
    finally { reopened.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("socket clients select Roles explicitly and configure internal MCP enablement independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-api-"));
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, STACK_STATE_DIR: root } });
  const call = <T = unknown>(name: string, args: Record<string, unknown> = {}) => socketCall(served.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  try {
    await assert.rejects(call("role_launch_snapshot"), /no default role/);
    let catalog = await call<RoleCatalog>("role_create", { expectedRevision: 0, name: "First" });
    const first = catalog.defaultRoleId!;
    const listing = await call<{ revision: number; servers: Array<{ name: string; enabled: boolean }> }>("role_internal_mcp_list", { roleId: first });
    assert.ok(listing.servers.length > 1);
    assert.ok(listing.servers.every(({ enabled }) => enabled));
    assert.ok(listing.servers.some(({ name }) => name === "roles"));
    await assert.rejects(call("category_create", { expectedRevision: 0, title: "Unscoped" }), /roleId/);
    await assert.rejects(call("role_snapshot"), /roleId/);
    await assert.rejects(call("role_internal_mcp_update", { roleId: first, expectedRevision: 0, name: "not-an-internal-package", enabled: false }), /unknown internal MCP/);
    const disabled = await call<{ roleId: string; revision: number }>("role_internal_mcp_update", { roleId: first, expectedRevision: 0, name: "roles", enabled: false });
    assert.deepEqual(disabled, { roleId: first, revision: 1 });
    await assert.rejects(call("role_internal_mcp_update", { roleId: first, expectedRevision: 0, name: "roles", enabled: true }), /stale role revision/);
    const launch = await call<RoleSnapshot>("role_launch_snapshot");
    assert.deepEqual(launch.disabledInternalMcpServers, ["roles"]);
    catalog = await call<RoleCatalog>("roles_snapshot");
    catalog = await call<RoleCatalog>("role_create", { expectedRevision: catalog.revision, name: "Second" });
    const second = catalog.roles[1]!.id;
    assert.deepEqual((await call<RoleSnapshot>("role_snapshot", { roleId: second })).disabledInternalMcpServers, []);
    catalog = await call<RoleCatalog>("role_set_default", { expectedRevision: catalog.revision, roleId: second });
    assert.equal((await call<RoleSnapshot>("role_launch_snapshot")).id, second);
    const selected = await call<RoleSnapshot>("role_launch_snapshot", { roleId: first });
    assert.equal(selected.id, first);
    assert.deepEqual(selected.disabledInternalMcpServers, ["roles"]);
    await assert.rejects(call("role_launch_snapshot", { roleId: randomUUID() }), /unknown role/);
    assert.equal((await call<RoleSnapshot>("role_launch_snapshot")).id, second);
    const enabled = await call("role_internal_mcp_update", { roleId: first, expectedRevision: disabled.revision, name: "roles", enabled: true });
    assert.deepEqual(enabled, { roleId: first, revision: 2 });
    assert.deepEqual((await call<RoleSnapshot>("role_snapshot", { roleId: first })).disabledInternalMcpServers, []);
    const renamed = await call("role_update", { roleId: second, expectedRevision: 0, name: "Current" });
    assert.deepEqual(renamed, { roleId: second, revision: 1 });
    assert.equal((await call<RoleSnapshot>("role_snapshot", { roleId: second })).name, "Current");
    catalog = await call<RoleCatalog>("roles_snapshot");
    const deleted = await call<RoleCatalog>("role_delete", { roleId: first, expectedRevision: catalog.revision });
    assert.equal(deleted.defaultRoleId, second);
    assert.equal(deleted.roles.length, 1);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});
