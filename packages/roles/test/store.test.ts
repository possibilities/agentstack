import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoleStore, renderInstructions } from "../src/store.js";
import { materializeRole, removeRole } from "../src/bundle.js";

test("categories and fragments are durable, ordered, and rendered without human metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-roles-"));
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

test("a role snapshots instructions and MCP configuration without argv content", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-role-snapshot-"));
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
  const root = await mkdtemp(join(tmpdir(), "agentstack-role-limit-"));
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
  const root = await mkdtemp(join(tmpdir(), "agentstack-role-migration-"));
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
  const root = await mkdtemp(join(tmpdir(), "agentstack-role-resources-"));
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
    await assert.rejects(materializeRole(root, "bot-1", state, { auth: "http://127.0.0.1:8743/mcp/auth" }), /collides/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
