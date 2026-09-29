import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { botMcpUrl } from "@stack/api";
import { DatabaseSync } from "node:sqlite";
import { RoleStore, renderInstructions, renderSegments } from "../src/store.js";
import { materializeRole, removeRole } from "../src/bundle.js";

test("categories and fragments are durable, ordered, and rendered without human metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-roles-"));
  let store = new RoleStore(root);
  try {
    let state = store.createCategory(0, "Planning", "human-only category");
    const planning = state.categories[0]!.id;
    state = store.createCategory(state.revision, "Tools", "human-only description");
    const tools = state.categories[1]!.id;
    state = store.createFragment(state.revision, planning, "A", "Alpha\nline", "do not ship");
    const alpha = state.categories[0]!.fragments[0]!.id;
    state = store.createFragment(state.revision, planning, "B", "Beta", "private note");
    const beta = state.categories[0]!.fragments[1]!.id;
    state = store.createFragment(state.revision, tools, "C", "Gamma");
    const gamma = state.categories[1]!.fragments[0]!.id;
    assert.equal(renderInstructions(state), "Alpha\nline\n\nBeta\n\nGamma");
    await assert.rejects(Promise.resolve().then(() => store.reorderFragments(state.revision, planning, [alpha, alpha])), /exactly once/);
    assert.equal(store.snapshot().revision, state.revision);
    state = store.reorderFragments(state.revision, planning, [beta, alpha]);
    state = store.reorderCategories(state.revision, [tools, planning]);
    assert.equal(renderInstructions(state), "Gamma\n\nBeta\n\nAlpha\nline");
    state = store.updateFragment(state.revision, beta, { categoryId: tools, enabled: false });
    state = store.updateCategory(state.revision, planning, { enabled: false, description: "edited" });
    assert.equal(renderInstructions(state), "Gamma");
    assert.equal(state.categories[0]!.fragments[1]!.id, beta);
    assert.throws(() => store.deleteCategory(state.revision, tools), /still contains fragments/);
    assert.throws(() => store.updateFragment(state.revision - 1, gamma, { body: "stale" }), /stale role revision/);
    assert.equal(store.snapshot().revision, state.revision);
    store.close();
    store = new RoleStore(root);
    assert.deepEqual(store.snapshot(), state);
    state = store.deleteFragment(state.revision, gamma);
    state = store.deleteFragment(state.revision, beta);
    state = store.deleteCategory(state.revision, tools);
    assert.equal(state.categories.length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("fragments move atomically, insert at an index, and keep human timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-move-"));
  const store = new RoleStore(root);
  try {
    const before = Date.now();
    let state = store.createCategory(0, "One");
    state = store.createCategory(state.revision, "Two");
    const [one, two] = state.categories.map((category) => category.id) as [string, string];
    state = store.createFragment(state.revision, one, "A", "Alpha");
    state = store.createFragment(state.revision, one, "C", "Gamma");
    state = store.createFragment(state.revision, one, "B", "Beta", "", true, 1);
    assert.deepEqual(state.categories[0]!.fragments.map((fragment) => fragment.title), ["A", "B", "C"]);
    assert.throws(() => store.createFragment(state.revision, one, "Far", "x", "", true, 4), /index must be between 0 and 3/);
    const [a, b, c] = state.categories[0]!.fragments as [typeof state.categories[0]["fragments"][0], typeof state.categories[0]["fragments"][0], typeof state.categories[0]["fragments"][0]];
    assert.ok(a.createdAt! >= before && a.updatedAt === a.createdAt && state.categories[0]!.createdAt! >= before);
    // Within a category only order changes; the fragment's own fields and timestamp stay.
    state = store.moveFragment(state.revision, c.id, one, 0);
    assert.deepEqual(state.categories[0]!.fragments.map((fragment) => fragment.title), ["C", "A", "B"]);
    assert.equal(state.categories[0]!.fragments[0]!.updatedAt, c.updatedAt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state = store.moveFragment(state.revision, a.id, two, 0);
    assert.deepEqual(state.categories.map((category) => category.fragments.map((fragment) => fragment.title)), [["C", "B"], ["A"]]);
    const moved = state.categories[1]!.fragments[0]!;
    assert.equal(moved.categoryId, two);
    assert.ok(moved.updatedAt! > a.updatedAt!);
    assert.throws(() => store.moveFragment(state.revision, b.id, two, 2), /index must be between 0 and 1/);
    state = store.moveFragment(state.revision, b.id, two, 1);
    assert.equal(renderInstructions(state), "Gamma\n\nAlpha\n\nBeta");
    // The source category keeps a dense order after fragments leave it.
    state = store.createFragment(state.revision, one, "D", "Delta", "", true, 1);
    assert.deepEqual(state.categories[0]!.fragments.map((fragment) => fragment.title), ["C", "D"]);
    const category = state.categories[1]!;
    state = store.updateCategory(state.revision, two, { description: "edited" });
    assert.ok(state.categories[1]!.updatedAt! >= category.updatedAt!);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("rendered segments locate each contributing body and skip disabled or blank fragments", () => {
  const fragment = (id: string, body: string, enabled = true) => ({ id, categoryId: "c", title: id, description: "", body, enabled, createdAt: null, updatedAt: null });
  const { rendered, segments } = renderSegments({ categories: [
    { id: "c1", title: "On", description: "", enabled: true, createdAt: null, updatedAt: null, fragments: [fragment("f1", "First"), fragment("f2", "  "), fragment("f3", "Off", false), fragment("f4", "Sé\ncond")] },
    { id: "c2", title: "Off", description: "", enabled: false, createdAt: null, updatedAt: null, fragments: [fragment("f5", "Hidden")] },
  ] });
  assert.equal(rendered, "First\n\nSé\ncond");
  assert.deepEqual(segments, [{ categoryId: "c1", fragmentId: "f1", start: 0, end: 5 }, { categoryId: "c1", fragmentId: "f4", start: 7, end: 14 }]);
  for (const segment of segments) assert.equal(rendered.slice(segment.start, segment.end), segment.fragmentId === "f1" ? "First" : "Sé\ncond");
});

test("a database from before timestamps keeps its records with unknown times", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-stamps-"));
  try {
    const db = new DatabaseSync(join(root, "roles.sqlite"));
    db.exec(`
      CREATE TABLE revision (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value INTEGER NOT NULL);
      INSERT INTO revision VALUES (1, 4);
      CREATE TABLE categories (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE fragments (id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL);
      INSERT INTO categories VALUES ('00000000-0000-4000-8000-000000000001', 'Old', '', 1, 0);
      INSERT INTO fragments VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Kept', '', 'Keep me.', 1, 0);
    `);
    db.close();
    const store = new RoleStore(root);
    try {
      let state = store.snapshot();
      assert.equal(state.revision, 4);
      assert.deepEqual(state.categories[0]!.fragments[0], { id: "00000000-0000-4000-8000-000000000002", categoryId: "00000000-0000-4000-8000-000000000001",
        title: "Kept", description: "", body: "Keep me.", enabled: true, createdAt: null, updatedAt: null });
      state = store.createFragment(state.revision, state.categories[0]!.id, "New", "Fresh.");
      assert.equal(state.categories[0]!.fragments[0]!.createdAt, null);
      assert.equal(typeof state.categories[0]!.fragments[1]!.createdAt, "number");
      assert.equal(renderInstructions(state), "Keep me.\n\nFresh.");
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a role snapshots instructions and MCP configuration without argv content", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-snapshot-"));
  const store = new RoleStore(root);
  try {
    let state = store.createCategory(0, "Default");
    state = store.createFragment(state.revision, state.categories[0]!.id, "Prompt", "Do useful work.", "not rendered");
    const first = await materializeRole(root, "bot-1", state, { auth: "http://127.0.0.1:8743/mcp/auth" });
    assert.equal(await readFile(join(first, "SYSTEM_APPEND.md"), "utf8"), "Do useful work.");
    assert.match(await readFile(join(first, "config.toml"), "utf8"), /\[mcp_servers.auth\]/);
    state = store.updateFragment(state.revision, state.categories[0]!.fragments[0]!.id, { body: "Changed." });
    const second = await materializeRole(root, "bot-1", state, {});
    assert.equal(await readFile(join(first, "SYSTEM_APPEND.md"), "utf8"), "Do useful work.");
    assert.equal(await readFile(join(second, "SYSTEM_APPEND.md"), "utf8"), "Changed.");
    await assert.rejects(removeRole(root, "bot-2", first), /unrecognized/);
    await removeRole(root, "bot-1", first);
    await removeRole(root, "bot-1", second);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an oversized assembled prompt is rejected before committing an edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-limit-"));
  const store = new RoleStore(root);
  try {
    let state = store.createCategory(0, "Large");
    const categoryId = state.categories[0]!.id;
    state = store.createFragment(state.revision, categoryId, "First", "a".repeat(200_000));
    assert.throws(() => store.createFragment(state.revision, categoryId, "Too much", "b".repeat(70_000)), /exceed 262144 bytes/);
    assert.deepEqual(store.snapshot(), state);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a legacy capabilities database keeps its fragments, revision, and launch cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-migration-"));
  const old = new RoleStore(root);
  try {
    let state = old.createCategory(0, "Existing");
    state = old.createFragment(state.revision, state.categories[0]!.id, "Instruction", "Keep this.");
    old.close();
    await rename(join(root, "roles.sqlite"), join(root, "capabilities.sqlite"));
    const role = new RoleStore(root);
    try { assert.deepEqual(role.snapshot(), state); }
    finally { role.close(); }
    const legacyRoot = join(root, "capabilities", "bot-1", "launch-legacy");
    await mkdir(legacyRoot, { recursive: true });
    await removeRole(root, "bot-1", legacyRoot);
    await assert.rejects(lstat(legacyRoot), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("enabled role resources materialize privately and disabled items stay out of bot launches", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-resources-"));
  let store = new RoleStore(root);
  try {
    let state = store.createSkill(0, "review", "Review changes", "# Review", [{ path: "scripts/check.sh", contentBase64: Buffer.from("exit 0\n").toString("base64") }]);
    const review = state.skills[0]!.id;
    state = store.createSkill(state.revision, "draft", "Draft notes", "# Draft", [], false);
    const draft = state.skills[1]!.id;
    state = store.reorderSkills(state.revision, [draft, review]);
    assert.deepEqual(state.skills.map((skill) => skill.name), ["draft", "review"]);
    state = store.createMcpServer(state.revision, "remote", "Remote tools", { type: "http", url: "https://mcp.example.test/tools", bearerTokenEnvVar: "ROLE_TOKEN", httpHeaders: { "X-Role": "managed" } });
    state = store.createMcpServer(state.revision, "local", "Local tools", { type: "stdio", command: "/usr/bin/env", args: ["true"], env: { MODE: "role" } }, false);
    const local = state.mcpServers[1]!.id;
    store.close();
    store = new RoleStore(root);
    assert.deepEqual(store.snapshot(), state);
    const first = await materializeRole(root, "bot-1", state, { auth: "http://127.0.0.1:8743/mcp/auth" });
    assert.deepEqual(await readdir(join(first, "skills")), ["review"]);
    assert.match(await readFile(join(first, "skills", "review", "SKILL.md"), "utf8"), /name: "review"\ndescription: "Review changes"/);
    assert.equal(await readFile(join(first, "skills", "review", "scripts", "check.sh"), "utf8"), "exit 0\n");
    const config = await readFile(join(first, "config.toml"), "utf8");
    assert.match(config, /\[mcp_servers.auth\]/);
    assert.match(config, /tool_timeout_sec = 305/);
    assert.match(config, /\[mcp_servers.remote\]/);
    assert.match(config, /bearer_token_env_var = "ROLE_TOKEN"/);
    assert.match(config, /http_headers = \{ "X-Role" = "managed" \}/);
    assert.doesNotMatch(config, /mcp_servers.local/);
    await removeRole(root, "bot-1", first);
    state = store.updateMcpServer(state.revision, local, { enabled: true });
    const withLocal = await materializeRole(root, "bot-1", state, {});
    const localConfig = await readFile(join(withLocal, "config.toml"), "utf8");
    assert.match(localConfig, /\[mcp_servers.local\]\ncommand = "\/usr\/bin\/env"\nargs = \["true"\]\nenv = \{ "MODE" = "role" \}/);
    await removeRole(root, "bot-1", withLocal);
    assert.throws(() => store.createSkill(state.revision, "review", "Duplicate", "# Duplicate"), /UNIQUE/);
    assert.equal(store.snapshot().revision, state.revision);
    assert.throws(() => store.updateSkill(state.revision, review, { files: [{ path: "../escape", contentBase64: "" }] }), /path|invalid/i);
    assert.equal(store.snapshot().revision, state.revision);
    state = store.updateSkill(state.revision, review, { enabled: false });
    const second = await materializeRole(root, "bot-1", state, {});
    assert.deepEqual(await readdir(join(second, "skills")), []);
    await removeRole(root, "bot-1", second);
    state = store.createMcpServer(state.revision, "auth", "Collision", { type: "http", url: "https://mcp.example.test/other" }, false);
    // A disabled record never enters config.toml, so it cannot stop a launch.
    await removeRole(root, "bot-1", await materializeRole(root, "bot-1", state, { auth: "http://127.0.0.1:8743/mcp/auth" }));
    state = store.updateMcpServer(state.revision, state.mcpServers.at(-1)!.id, { enabled: true });
    await assert.rejects(materializeRole(root, "bot-1", state, { auth: "http://127.0.0.1:8743/mcp/auth" }), /collides/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("role launch keeps bot-bound internal URLs and rejects an unbound internal alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-bot-mcp-"));
  const store = new RoleStore(root);
  try {
    const base = "http://127.0.0.1:8743/mcp/auth";
    const bound = botMcpUrl(base, "bot-1", "unix:///tmp/bot-one.sock", { STACK_STATE_DIR: root });
    const path = await materializeRole(root, "bot-1", store.snapshot(), { auth: bound });
    assert.match(await readFile(join(path, "config.toml"), "utf8"), /\?bot=bot-1&instance=/);
    await removeRole(root, "bot-1", path);
    await assert.rejects(materializeRole(root, "bot-2", store.snapshot(), { auth: bound }), /another bot/);
    const withAlias = store.createMcpServer(0, "other", "Alias", { type: "http", url: base });
    await assert.rejects(materializeRole(root, "bot-1", withAlias, { auth: bound }), /cannot alias the internal MCP listener/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("only enabled, explicitly trusted project roots matching a Bot cwd enter its private launch config", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-role-project-"));
  const project = join(root, "repo with spaces");
  const nested = join(project, "src");
  const unrelated = join(root, "other");
  await mkdir(nested, { recursive: true });
  await mkdir(join(project, ".git"));
  await mkdir(unrelated);
  const alias = join(root, "linked-repo");
  await symlink(project, alias);
  let store = new RoleStore(root);
  try {
    let state = store.createTrustedProject(0, alias, "Reviewed project");
    const id = state.trustedProjects[0]!.id;
    const canonical = await realpath(project);
    assert.equal(state.trustedProjects[0]!.path, canonical);
    assert.throws(() => store.createTrustedProject(state.revision, project), /UNIQUE/);
    const first = await materializeRole(root, "bot-1", state, {}, nested);
    assert.ok((await readFile(join(first, "config.toml"), "utf8")).includes(`[projects.${JSON.stringify(canonical)}]\ntrust_level = "trusted"`));
    await removeRole(root, "bot-1", first);
    const outside = await materializeRole(root, "bot-2", state, {}, unrelated);
    assert.doesNotMatch(await readFile(join(outside, "config.toml"), "utf8"), /\[projects\./);
    await removeRole(root, "bot-2", outside);
    state = store.updateTrustedProject(state.revision, id, { enabled: false });
    const disabled = await materializeRole(root, "bot-1", state, {}, nested);
    assert.doesNotMatch(await readFile(join(disabled, "config.toml"), "utf8"), /\[projects\./);
    await removeRole(root, "bot-1", disabled);
    store.close();
    store = new RoleStore(root);
    assert.deepEqual(store.snapshot(), state);
    state = store.reorderTrustedProjects(state.revision, [id]);
    assert.equal(state.trustedProjects.length, 1);
    state = store.deleteTrustedProject(state.revision, id);
    assert.deepEqual(state.trustedProjects, []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
