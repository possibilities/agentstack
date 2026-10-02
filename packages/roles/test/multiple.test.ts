import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { serveApi, socketCall } from "@stack/api";
import { RoleStore, type RoleCatalog, type RoleSnapshot } from "../src/store.js";

test("concurrent owner and injection initialization share one complete pair of defaults", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-init-race-"));
  const script = `
    import { RoleStore } from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};
    process.once('message', () => {
      try {
        const store = new RoleStore(process.argv[1], JSON.parse(process.argv[2]));
        console.log(JSON.stringify(store.catalog()));
        store.close(); process.exit(0);
      } catch (error) { console.error(error); process.exit(1); }
    });
    process.send('ready');
  `;
  const children = [{}, { readOnly: true, initializeIfMissing: true }, { readOnly: true, initializeIfMissing: true }].map(options => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, JSON.stringify(options)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const done = new Promise<RoleCatalog>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0) reject(new Error(stderr || `Role initializer exited ${code}`));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      void done.catch(reject);
    });
    return { child, ready, done };
  });
  try {
    await Promise.all(children.map(({ ready }) => ready));
    for (const { child } of children) child.send("initialize");
    const catalogs = await Promise.all(children.map(({ done }) => done));
    assert.deepEqual(catalogs[0]!.roles.map(role => role.name), ["Manager", "Worker"]);
    assert.ok(catalogs[0]!.defaultRoleId && catalogs[0]!.workerDefaultRoleId);
    for (const catalog of catalogs.slice(1)) assert.deepEqual(catalog, catalogs[0]);
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map(({ done }) => done));
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh Roles start with independent Manager and instruction-free Worker defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-pair-"));
  const store = new RoleStore(root);
  try {
    const catalog = store.catalog();
    assert.equal(catalog.roles.length, 2);
    assert.equal(store.defaultSnapshot().name, "Manager");
    assert.ok(store.defaultSnapshot().botMarkdown?.trim());
    assert.equal(store.launchSnapshot(undefined, "worker").botMarkdown, "");
    assert.equal(store.launchSnapshot(undefined, "worker").name, "Worker");
    const manager = store.role(catalog.defaultRoleId!);
    let updated = manager.createCategory(0, "Guidance");
    updated = manager.createFragment(updated.revision, updated.categories[0]!.id, "Rule", "Manager only");
    manager.createSkill(updated.revision, "check", "Review", "Manager skill");
    assert.deepEqual(store.launchSnapshot(undefined, "worker").categories, []);
    assert.deepEqual(store.launchSnapshot(undefined, "worker").skills, []);
    const reopened = new RoleStore(root);
    try { assert.equal(reopened.catalog().workerDefaultRoleId, catalog.workerDefaultRoleId); }
    finally { reopened.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("existing Roles gain empty bot.md without changing instructions or revisions, and later edits survive reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-personality-upgrade-"));
  let store = new RoleStore(root);
  try {
    const roleId = store.catalog().defaultRoleId!;
    const role = store.role(roleId);
    const category = role.createCategory(0, "Authored");
    const authored = role.createFragment(category.revision, category.categories[0]!.id, "Guidance", "Existing instructions");
    const catalog = store.catalog();
    store.close();
    const db = new DatabaseSync(join(root, "roles.sqlite"));
    db.exec("DROP TABLE role_bot_markdown"); db.close();
    store = new RoleStore(root);
    assert.deepEqual(store.catalog(), catalog);
    const migrated = store.role(roleId).snapshot();
    assert.equal(migrated.botMarkdown, "");
    assert.deepEqual(migrated.categories, authored.categories);
    assert.equal(migrated.revision, authored.revision);
    const edited = store.role(roleId).update(migrated.revision, { botMarkdown: "Personality I authored" });
    assert.equal(store.role(roleId).update(edited.revision, { description: "Metadata only" }).botMarkdown, "Personality I authored");
    store.close(); store = new RoleStore(root);
    assert.equal(store.role(roleId).snapshot().botMarkdown, "Personality I authored");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an older Role catalog fails closed without changing its schema or records", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-older-catalog-"));
  const store = new RoleStore(root);
  const managerId = store.catalog().defaultRoleId!;
  store.close();
  try {
    const db = new DatabaseSync(join(root, "roles.sqlite"));
    db.exec("ALTER TABLE role_catalog DROP COLUMN worker_default_role_id");
    db.close();
    assert.throws(() => new RoleStore(root), /offline replacement or conversion/);
    const checked = new DatabaseSync(join(root, "roles.sqlite"));
    try {
      assert.equal((checked.prepare("SELECT default_role_id FROM role_catalog").get() as { default_role_id: string }).default_role_id, managerId);
      assert.equal(checked.prepare("PRAGMA table_info(role_catalog)").all().some((column) => column.name === "worker_default_role_id"), false);
    } finally { checked.close(); }

    const singleton = join(root, "singleton");
    await mkdir(singleton);
    const old = new DatabaseSync(join(singleton, "roles.sqlite"));
    old.exec("CREATE TABLE revision (singleton INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO revision VALUES (1, 2)");
    old.close();
    assert.throws(() => new RoleStore(singleton), /offline replacement or conversion/);
    const unchanged = new DatabaseSync(join(singleton, "roles.sqlite"));
    try {
      assert.equal((unchanged.prepare("SELECT value FROM revision").get() as { value: number }).value, 2);
      assert.equal(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'roles'").get(), undefined);
    } finally { unchanged.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pre-filter stores read without mutation and upgrade without re-enabling the renamed computer bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-capability-upgrade-"));
  const path = join(root, "roles.sqlite");
  let store = new RoleStore(root);
  try {
    const roleId = store.catalog().defaultRoleId!;
    let state = store.role(roleId).createSkill(0, "existing", "Existing skill", "Keep my bytes");
    state = store.role(roleId).createMcpServer(state.revision, "existing", "Existing connection", { type: "stdio", command: "node", args: [] });
    const catalog = store.catalog();
    store.close();
    const old = new DatabaseSync(path);
    try {
      old.exec("ALTER TABLE skills DROP COLUMN harnesses_json; ALTER TABLE role_mcp_servers DROP COLUMN harnesses_json; DROP TABLE internal_mcp_harnesses");
      old.prepare("INSERT INTO disabled_internal_mcp VALUES (?, 'computer-use')").run(roleId);
    } finally { old.close(); }
    const bytes = await readFile(path);
    store = new RoleStore(root, { readOnly: true });
    const read = store.role(roleId).snapshot();
    assert.deepEqual(read.disabledInternalMcpServers, ["codex-computer-use"]);
    assert.deepEqual(read.internalMcpHarnesses, {});
    assert.deepEqual(read.skills, state.skills);
    assert.deepEqual(read.mcpServers, state.mcpServers);
    store.close();
    assert.deepEqual(await readFile(path), bytes, "read-only injection must not migrate the store");
    store = new RoleStore(root);
    assert.deepEqual(store.catalog(), catalog, "additive upgrades preserve revisions and defaults");
    assert.deepEqual(store.role(roleId).snapshot(), read);
    const enabled = store.role(roleId).setInternalMcp(read.revision, "codex-computer-use", true);
    assert.deepEqual(enabled.disabledInternalMcpServers, []);
    store.close(); store = new RoleStore(root);
    assert.deepEqual(store.role(roleId).snapshot().disabledInternalMcpServers, []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
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
      state = role.createTrustedProject(state.revision, root);
      return role.update(state.revision, { botMarkdown: `Personality for ${state.name}` });
    };
    const a = populate(one!);
    const b = populate(two!);
    assert.equal(a.botMarkdown, "Personality for One");
    assert.equal(b.botMarkdown, "Personality for Two");
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
    const bridges = ["codex-computer-use", "chrome", "messages", "computer-history", "openai-developer-docs"];
    for (const name of bridges) assert.ok(listing.servers.some(server => server.name === name && server.enabled));
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
    let revision = 1;
    for (const name of bridges) {
      const disabled = await call<{ revision: number }>("role_internal_mcp_update", { roleId: second, expectedRevision: revision, name, enabled: false });
      revision = disabled.revision;
    }
    for (const audience of ["bot", "worker"]) assert.deepEqual((await call<RoleSnapshot>("role_launch_snapshot", { roleId: second, audience })).disabledInternalMcpServers.slice().sort(), bridges.slice().sort());
    catalog = await call<RoleCatalog>("roles_snapshot");
    const deleted = await call<RoleCatalog>("role_delete", { roleId: first, expectedRevision: catalog.revision });
    assert.equal(deleted.defaultRoleId, second);
    assert.equal(deleted.roles.length, 2);
  } finally { await served.close(); await rm(root, { recursive: true, force: true }); }
});
