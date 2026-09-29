import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { serveApi, socketCall } from "@stack/api";
import { RoleStore, type RoleCatalog, type RoleSnapshot } from "../src/store.js";

test("existing default becomes Manager and an independent instruction-free Worker copy exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-pair-migration-"));
  try {
    const before = new RoleStore(root);
    const managerId = before.catalog().defaultRoleId!;
    const priorWorkerId = before.catalog().workerDefaultRoleId!;
    let manager = before.role(managerId).update(0, { name: "Original" });
    const contents = before.role(managerId);
    manager = contents.createCategory(manager.revision, "Guidance");
    manager = contents.createFragment(manager.revision, manager.categories[0]!.id, "Rule", "Keep this for Bots");
    manager = contents.createSkill(manager.revision, "check", "Review", "First skill");
    manager = contents.createMcpServer(manager.revision, "external", "", { type: "stdio", command: "node", args: ["-v"] });
    manager = contents.setInternalMcp(manager.revision, "notify", false);
    before.close();
    // Model the catalog written by the previous release without touching an operator store.
    const db = new DatabaseSync(join(root, "roles.sqlite"));
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE role_catalog SET worker_default_role_id = NULL").run();
    db.exec("ALTER TABLE role_catalog DROP COLUMN worker_default_role_id");
    db.prepare("DELETE FROM roles WHERE id = ?").run(priorWorkerId);
    db.close();

    const migrated = new RoleStore(root);
    const newWorkerId = migrated.catalog().workerDefaultRoleId;
    try {
      const catalog = migrated.catalog();
      assert.equal(catalog.defaultRoleId, managerId);
      assert.equal(migrated.defaultSnapshot().name, "Manager");
      const worker = migrated.launchSnapshot(undefined, "worker");
      assert.equal(worker.id, catalog.workerDefaultRoleId);
      assert.notEqual(worker.id, managerId);
      assert.deepEqual(worker.categories, []);
      assert.deepEqual(worker.skills.map(({ name, body }) => ({ name, body })), [{ name: "check", body: "First skill" }]);
      assert.notEqual(worker.skills[0]!.id, manager.skills[0]!.id);
      assert.deepEqual(worker.mcpServers.map(({ name, definition }) => ({ name, definition })), manager.mcpServers.map(({ name, definition }) => ({ name, definition })));
      assert.deepEqual(worker.disabledInternalMcpServers, ["notify"]);
      migrated.role(managerId).updateSkill(catalog.roles[0]!.revision, manager.skills[0]!.id, { body: "Changed later" });
      assert.equal(migrated.launchSnapshot(undefined, "worker").skills[0]!.body, "First skill");
    } finally { migrated.close(); }
    const reopened = new RoleStore(root);
    try { assert.equal(reopened.catalog().workerDefaultRoleId, newWorkerId); }
    finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration refuses a pre-existing Manager name without a partial rename or clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-name-conflict-"));
  try {
    const initial = new RoleStore(root);
    let catalog = initial.catalog();
    const oldDefault = catalog.defaultRoleId!;
    const oldWorker = catalog.workerDefaultRoleId!;
    initial.role(oldDefault).update(0, { name: "Original" });
    catalog = initial.catalog();
    catalog = initial.createRole(catalog.revision, "Manager");
    const existingManager = catalog.roles.at(-1)!.id;
    initial.close();
    const db = new DatabaseSync(join(root, "roles.sqlite"));
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("UPDATE role_catalog SET worker_default_role_id = NULL; ALTER TABLE role_catalog DROP COLUMN worker_default_role_id");
    db.prepare("DELETE FROM roles WHERE id = ?").run(oldWorker);
    const priorRevision = (db.prepare("SELECT revision FROM role_catalog").get() as { revision: number }).revision;
    db.close();
    assert.throws(() => new RoleStore(root), /existing Manager Role/);
    const checked = new DatabaseSync(join(root, "roles.sqlite"));
    try {
      assert.deepEqual(checked.prepare("SELECT id, name FROM roles ORDER BY rowid").all().map((row) => ({ ...row })), [
        { id: oldDefault, name: "Original" }, { id: existingManager, name: "Manager" },
      ]);
      assert.equal((checked.prepare("SELECT revision FROM role_catalog").get() as { revision: number }).revision, priorRevision);
    } finally { checked.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalog revisions fence creation, default changes and deletion without invalidating unrelated role edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-multi-role-"));
  const store = new RoleStore(root);
  const other = new RoleStore(root);
  try {
    let catalog = store.catalog();
    const first = catalog.defaultRoleId!;
    const workerDefault = catalog.workerDefaultRoleId!;
    assert.equal(store.defaultSnapshot().name, "Manager");
    assert.equal(store.launchSnapshot(undefined, "worker").name, "Worker");
    assert.equal(catalog.roles[0]!.id, first);
    assert.throws(() => other.createRole(0, "Racing first"), /stale role catalog revision/);
    assert.throws(() => store.createRole(catalog.revision, " manager "), /UNIQUE/);
    assert.equal(store.catalog().revision, catalog.revision);
    catalog = store.createRole(catalog.revision, "Second");
    const second = catalog.roles.at(-1)!.id;
    assert.equal(catalog.defaultRoleId, first);
    assert.equal(catalog.workerDefaultRoleId, workerDefault);
    const firstContents = store.role(first);
    const before = firstContents.snapshot();
    assert.throws(() => store.setDefault(catalog.revision, randomUUID()), /unknown role/);
    assert.throws(() => store.deleteRole(catalog.revision, first), /cannot delete the default/);
    catalog = other.setDefault(catalog.revision, second);
    assert.equal(store.launchSnapshot(undefined, "worker").id, workerDefault);
    assert.throws(() => store.deleteRole(catalog.revision, workerDefault), /Worker default/);
    catalog = store.setWorkerDefault(catalog.revision, second);
    assert.equal(store.launchSnapshot(undefined, "worker").id, second);
    assert.equal(store.defaultSnapshot().id, second);
    assert.equal(firstContents.snapshot().revision, before.revision);
    // A default switch does not retarget an editor or consume its role revision.
    const edited = firstContents.update(before.revision, { name: "Renamed", description: "Kept separate" });
    assert.equal(edited.id, first);
    assert.equal(store.defaultSnapshot().name, "Second");
    assert.throws(() => other.deleteRole(catalog.revision, first), /stale role catalog revision/);
    assert.throws(() => firstContents.update(before.revision, { name: "Lost" }), /stale role revision/);
    const deleted = store.deleteRole(store.catalog().revision, first);
    assert.deepEqual(deleted.roles.map(({ id }) => id), [workerDefault, second]);
    assert.throws(() => firstContents.snapshot(), /unknown role/);
    assert.throws(() => store.deleteRole(deleted.revision, second), /cannot delete the default/);
    assert.equal(other.defaultSnapshot().id, second);
  } finally { store.close(); other.close(); await rm(root, { recursive: true, force: true }); }
});

test("all Role resources are isolated, names and order are local, and deleting a Role removes only its content", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-isolation-"));
  const store = new RoleStore(root);
  try {
    let catalog = store.createRole(store.catalog().revision, "One");
    catalog = store.createRole(catalog.revision, "Two");
    const [one, two] = catalog.roles.slice(-2).map(({ id }) => store.role(id));
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
    try { assert.deepEqual(reopened.defaultSnapshot(), b); assert.equal(reopened.catalog().roles.length, 3); }
    finally { reopened.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("socket clients select Roles explicitly and configure internal MCP enablement independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-api-"));
  const served = await serveApi({ name: "roles", transport: "socket", env: { ...process.env, STACK_STATE_DIR: root } });
  const call = <T = unknown>(name: string, args: Record<string, unknown> = {}) => socketCall(served.socketPath!, "tools/call", { name, arguments: args }) as Promise<T>;
  try {
    let catalog = await call<RoleCatalog>("roles_snapshot");
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
    const second = catalog.roles.at(-1)!.id;
    assert.deepEqual((await call<RoleSnapshot>("role_snapshot", { roleId: second })).disabledInternalMcpServers, []);
    catalog = await call<RoleCatalog>("role_set_default", { expectedRevision: catalog.revision, roleId: second });
    assert.equal((await call<RoleSnapshot>("role_launch_snapshot")).id, second);
    assert.equal((await call<RoleSnapshot>("role_launch_snapshot", { audience: "worker" })).id, catalog.workerDefaultRoleId);
    catalog = await call<RoleCatalog>("role_set_worker_default", { expectedRevision: catalog.revision, roleId: second });
    assert.equal((await call<RoleSnapshot>("role_launch_snapshot", { audience: "worker" })).id, second);
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
    assert.equal(deleted.roles.length, 2);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});
